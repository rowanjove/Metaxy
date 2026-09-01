import { Hono } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { timingSafeEqual } from "../lib/crypto";
import { createShortcutDrop } from "../services/drop-service";
import { isRecord, parseJsonBody, readTextBodyLimited } from "../lib/body";
import { DEFAULT_LIMITS } from "../../shared/constants";
import { checkRateLimit } from "../middleware/rate-limit";
import { sha256Hex } from "../lib/crypto";

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

  const originUrl = new URL(c.req.url).origin;
  const result = await createShortcutDrop(c.env, content, expiresInSeconds, originUrl);

  return c.json(result, 201);
});
