import { Hono } from "hono";
import type { WorkerContext } from "../env";
import { jsonSuccess } from "../lib/responses";
import { extractDraftToken } from "../middleware/draft-auth";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";
import { prepareUpload, completeUpload } from "../services/upload-service";
import { isRecord, parseJsonBody } from "../lib/body";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";

export const uploadsRoutes = new Hono<WorkerContext>();

// Prepare upload and issue presigned PUT URL
uploadsRoutes.post("/uploads/prepare", async (c) => {
  const ip = getClientIp(c);
  await checkRateLimit(c.env.UPLOAD_RATE_LIMITER, `prepare_${ip}`);

  const draftToken = extractDraftToken(c);
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (
    !isRecord(body) ||
    typeof body.dropId !== "string" ||
    (body.fileId !== undefined && typeof body.fileId !== "string") ||
    typeof body.filename !== "string" ||
    typeof body.size !== "number" ||
    typeof body.contentType !== "string"
  ) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid upload preparation payload.");
  }
  if (body.sortOrder !== undefined && typeof body.sortOrder !== "number") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid upload sort order.");
  }

  const result = await prepareUpload(c.env, {
    dropId: body.dropId,
    draftToken,
    fileId: typeof body.fileId === "string" ? body.fileId : undefined,
    filename: body.filename,
    size: body.size,
    contentType: body.contentType,
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined
  });

  return jsonSuccess(c, result);
});

// Complete and verify uploaded file in R2
uploadsRoutes.post("/uploads/complete", async (c) => {
  const draftToken = extractDraftToken(c);
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || typeof body.dropId !== "string" || typeof body.fileId !== "string") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid upload completion payload.");
  }

  const result = await completeUpload(c.env, {
    dropId: body.dropId,
    draftToken,
    fileId: body.fileId
  });

  return jsonSuccess(c, result);
});
