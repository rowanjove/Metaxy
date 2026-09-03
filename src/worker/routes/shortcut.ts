import { Hono } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { timingSafeEqual } from "../lib/crypto";
import { createShortcutDrop } from "../services/drop-service";
import { isRecord, parseJsonBody, readTextBodyLimited } from "../lib/body";
import { DEFAULT_LIMITS } from "../../shared/constants";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";
import { sha256Hex } from "../lib/crypto";
import { createShortcutFileDrop } from "../services/shortcut-service";

export const shortcutRoutes = new Hono<WorkerContext>();

shortcutRoutes.post("/shortcut/push", async (c) => {
  const configuredToken = c.env.SHORTCUT_TOKEN?.trim();
  if (!configuredToken) {
    throw new AppError(
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE,
      "SHORTCUT_TOKEN secret is not configured on this server."
    );
  }

  // Rate-limit unauthenticated attempts before comparing the shared secret.
  // A second token-scoped limit below protects the authenticated quota.
  await checkRateLimit(
    c.env.UPLOAD_RATE_LIMITER,
    `shortcut_auth_${getClientIp(c)}`
  );

  // Authorization must be Bearer token in Header (URL query parameter token is prohibited)
  const authHeader = c.req.header("authorization")?.trim();
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Bearer authorization header required.");
  }

  const providedToken = authHeader.slice("Bearer ".length).trim();
  const isValid = await timingSafeEqual(providedToken, configuredToken);
  if (!isValid) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "Invalid shortcut token.");
  }

  const tokenRateKey = (await sha256Hex(providedToken)).slice(0, 24);
  await checkRateLimit(c.env.UPLOAD_RATE_LIMITER, `shortcut_${tokenRateKey}`);

  const contentType = c.req.header("content-type") || "";
  const encodedFilename =
    c.req.header("x-metaxy-filename") ||
    c.req.header("x-pocketrelay-filename");
  const originUrl = new URL(c.req.url).origin;

  if (encodedFilename) {
    const sizeHeader =
      c.req.header("x-metaxy-file-size") ||
      c.req.header("x-pocketrelay-file-size") ||
      c.req.header("content-length");
    if (!sizeHeader) {
      throw new AppError(
        411,
        ERROR_CODES.BAD_REQUEST,
        "Shortcut file uploads require X-Metaxy-File-Size or Content-Length."
      );
    }

    const size = Number(sizeHeader);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid shortcut file size.");
    }

    const expiresHeader = c.req.header("x-metaxy-expires-in-seconds");
    const expiresInSeconds = expiresHeader === undefined ? undefined : Number(expiresHeader);
    if (expiresHeader !== undefined && !Number.isSafeInteger(expiresInSeconds)) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid shortcut expiry.");
    }
    if (!c.req.raw.body) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Shortcut file body is required.");
    }

    let filename = encodedFilename;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Shortcut filename must be URL encoded.");
    }

    const result = await createShortcutFileDrop(c.env, {
      filename,
      contentType: contentType || "application/octet-stream",
      size,
      expiresInSeconds,
      originUrl,
      body: c.req.raw.body
    });
    return c.json(result, 201);
  }

  let content = "";
  let expiresInSeconds: number | undefined;

  if (contentType.includes("application/json")) {
    // Leave room for JSON framing while preserving the same 5 MiB content
    // limit as the text/plain endpoint.
    const body = await parseJsonBody<unknown>(c.req.raw, DEFAULT_LIMITS.MAX_TEXT_BYTES + 256 * 1024);
    if (!isRecord(body) || typeof body.content !== "string") {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "JSON body must contain a string content field.");
    }
    content = body.content;
    expiresInSeconds = typeof body.expiresInSeconds === "number" ? body.expiresInSeconds : undefined;
  } else {
    content = await readTextBodyLimited(c.req.raw, DEFAULT_LIMITS.MAX_TEXT_BYTES);
  }

  const result = await createShortcutDrop(c.env, content, expiresInSeconds, originUrl);

  return c.json(result, 201);
});
