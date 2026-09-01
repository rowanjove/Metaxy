import { Hono } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { getFileById } from "../repositories/files";
import { getDropById } from "../repositories/drops";
import { isInlinePreviewableImage } from "../lib/mime";
import { buildContentDisposition } from "../lib/filename";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";

export const filesRoutes = new Hono<WorkerContext>();

filesRoutes.get("/files/:fileId/content", async (c) => {
  await checkRateLimit(c.env.RETRIEVE_RATE_LIMITER, `retrieve_file_${getClientIp(c)}`);
  const fileId = c.req.param("fileId");
  const isDownload = c.req.query("download") === "1";

  const file = await getFileById(c.env.DB, fileId);
  if (!file || file.status !== "uploaded") {
    throw new AppError(404, ERROR_CODES.FILE_NOT_FOUND, "File not found or not ready.");
  }

  const drop = await getDropById(c.env.DB, file.drop_id);
  if (!drop) {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "Drop not found.");
  }

  if (drop.status === "revoked" || drop.status === "deleting") {
    throw new AppError(410, ERROR_CODES.DROP_REVOKED, "This drop is no longer available.");
  }

  if (drop.status !== "active") {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "Drop is not active.");
  }

  const now = Date.now();
  if (now >= drop.expires_at) {
    throw new AppError(410, ERROR_CODES.DROP_EXPIRED, "This drop has expired.");
  }

  // Parse HTTP Range header if present
  const rangeHeader = c.req.header("range");
  let r2GetOptions: R2GetOptions | undefined;

  if (rangeHeader) {
    r2GetOptions = { range: c.req.raw.headers };
  }

  const r2Object = await c.env.FILES.get(file.object_key, r2GetOptions);
  if (!r2Object) {
    throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "File object missing in storage.");
  }

  // Validate the exact object returned by GET. A separate HEAD followed by GET
  // has a race where a reusable presigned PUT can replace the object between
  // the two operations.
  if (r2Object.size !== (file.actual_size ?? file.expected_size)) {
    throw new AppError(409, ERROR_CODES.FILE_NOT_VERIFIED, "File changed after verification.");
  }
  if (file.etag && (!r2Object.httpEtag || file.etag !== r2Object.httpEtag)) {
    throw new AppError(409, ERROR_CODES.FILE_NOT_VERIFIED, "File changed after verification.");
  }

  const isInline = !isDownload && isInlinePreviewableImage(file.content_type);
  const disposition = isInline ? "inline" : "attachment";
  const contentDisposition = buildContentDisposition(file.filename, disposition);

  const headers = new Headers();
  r2Object.writeHttpMetadata(headers);

  headers.set("Content-Type", file.content_type || "application/octet-stream");
  headers.set("Content-Disposition", contentDisposition);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Accept-Ranges", "bytes");

  if (r2Object.httpEtag) {
    headers.set("ETag", r2Object.httpEtag);
  }

  const ranged = Boolean(rangeHeader && r2Object.range);
  if (ranged && r2Object.range) {
    const total = r2Object.size;
    let start: number;
    let length: number;
    if ("suffix" in r2Object.range) {
      length = Math.min(r2Object.range.suffix, total);
      start = Math.max(0, total - length);
    } else {
      start = r2Object.range.offset ?? 0;
      length = Math.min(r2Object.range.length ?? total - start, total - start);
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length <= 0 ||
      start >= total
    ) {
      headers.set("Content-Range", `bytes */${total}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${total}`);
    headers.set("Content-Length", String(length));
  } else {
    headers.set("Content-Length", String(r2Object.size));
  }

  const status = ranged ? 206 : 200;

  return new Response(r2Object.body, {
    status,
    headers
  });
});
