import { Hono } from "hono";
import type { WorkerContext } from "../env";
import { jsonSuccess } from "../lib/responses";
import { uploadAuthMiddleware } from "../middleware/upload-auth";
import { extractDraftToken } from "../middleware/draft-auth";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";
import {
  createDraft,
  updateText,
  commitDrop,
  getDropDetail,
  getR2TextStream
} from "../services/drop-service";
import type { CreateDraftRequest } from "../../shared/contracts";
import { DEFAULT_LIMITS } from "../../shared/constants";
import { isRecord, parseOptionalJsonBody, readTextBodyLimited } from "../lib/body";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";

export const dropsRoutes = new Hono<WorkerContext>();

// Create Draft
dropsRoutes.post("/drops", async (c, next) => {
  const ip = getClientIp(c);
  await checkRateLimit(c.env.UPLOAD_RATE_LIMITER, `upload_auth_${ip}`);
  await next();
}, uploadAuthMiddleware, async (c) => {

  const rawBody = await parseOptionalJsonBody<unknown>(c.req.raw);
  if (rawBody !== undefined && !isRecord(rawBody)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Request body must be a JSON object.");
  }
  const body: CreateDraftRequest = {
    expiresInSeconds:
      isRecord(rawBody) && typeof rawBody.expiresInSeconds === "number"
        ? rawBody.expiresInSeconds
        : undefined
  };

  const result = await createDraft(c.env, {
    expiresInSeconds: body.expiresInSeconds
  });

  return jsonSuccess(c, result, 201);
});

// Update / Replace Text
dropsRoutes.put("/drops/:dropId/text", async (c) => {
  const dropId = c.req.param("dropId");
  const draftToken = extractDraftToken(c);
  const ip = getClientIp(c);
  await checkRateLimit(c.env.UPLOAD_RATE_LIMITER, `text_${ip}`);
  const text = await readTextBodyLimited(c.req.raw, DEFAULT_LIMITS.MAX_TEXT_BYTES);

  await updateText(c.env, dropId, draftToken, text);
  return jsonSuccess(c, { ok: true });
});

// Commit Drop
dropsRoutes.post("/drops/:dropId/commit", async (c) => {
  const dropId = c.req.param("dropId");
  const draftToken = extractDraftToken(c);
  const originUrl = new URL(c.req.url).origin;
  const ip = getClientIp(c);
  await checkRateLimit(c.env.UPLOAD_RATE_LIMITER, `commit_${ip}`);

  const result = await commitDrop(c.env, dropId, draftToken, originUrl);
  return jsonSuccess(c, result);
});

// Retrieve Drop by Code
dropsRoutes.get("/drops/:code", async (c) => {
  const code = c.req.param("code");
  const ip = getClientIp(c);
  await checkRateLimit(c.env.RETRIEVE_RATE_LIMITER, `retrieve_${ip}`);

  const result = await getDropDetail(c.env, code);
  return jsonSuccess(c, result);
});

// Get R2 Text stream
dropsRoutes.get("/drops/:code/items/:itemId/text", async (c) => {
  const code = c.req.param("code");
  const itemId = c.req.param("itemId");
  await checkRateLimit(c.env.RETRIEVE_RATE_LIMITER, `retrieve_text_${getClientIp(c)}`);

  return getR2TextStream(c.env, code, itemId);
});
