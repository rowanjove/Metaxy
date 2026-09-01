import type { Env } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { DEFAULT_LIMITS } from "../../shared/constants";
import { sha256Hex, timingSafeEqual } from "../lib/crypto";
import { sanitizeFilename } from "../lib/filename";
import { isDangerousFile } from "../lib/mime";
import { getParsedSettings } from "../repositories/settings";
import { getDropById } from "../repositories/drops";
import {
  createPendingFile,
  claimPendingFileFinalization,
  extendObjectDeletionNotBefore,
  getFileById,
  getFilesByDropId,
  markFileUploaded,
  recordObjectDeletion,
  releasePendingFileFinalization,
  refreshPendingFilePresign,
  type FileRow
} from "../repositories/files";
import { createPresignedPutUrl, type PresignedUrlResult } from "./presign-service";

export interface PrepareUploadParams {
  dropId: string;
  draftToken: string;
  fileId?: string;
  filename: string;
  size: number;
  contentType: string;
  sortOrder?: number;
}

export async function prepareUpload(
  env: Env,
  params: PrepareUploadParams
): Promise<PresignedUrlResult & { fileId: string }> {
  const drop = await getDropById(env.DB, params.dropId);
  if (!drop || drop.status !== "draft") {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Draft not found or already closed.");
  }

  // Validate draft token
  const receivedHash = await sha256Hex(params.draftToken);
  if (!(await timingSafeEqual(receivedHash, drop.draft_token_hash))) {
    throw new AppError(403, ERROR_CODES.INVALID_DRAFT_TOKEN, "Invalid draft token.");
  }

  // Validate draft TTL (1 hour)
  const now = Date.now();
  if (now - drop.created_at > DEFAULT_LIMITS.DRAFT_TTL_SECONDS * 1000) {
    throw new AppError(410, ERROR_CODES.DRAFT_EXPIRED, "Draft has expired.");
  }

  const settings = await getParsedSettings(env.DB, env);
  const uploadMode = env.UPLOAD_MODE === "public" ? "public" : "token";
  const cleanFilename = sanitizeFilename(params.filename);
  const cleanContentType = (params.contentType || "application/octet-stream").trim();
  if (
    cleanContentType.length > 255 ||
    /[\u0000-\u001F\u007F]/.test(cleanContentType)
  ) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid file content type.");
  }

  // Validate file size
  if (!Number.isSafeInteger(params.size) || params.size <= 0) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid file size.");
  }
  if (params.size > settings.max_file_bytes) {
    throw new AppError(
      413,
      ERROR_CODES.FILE_TOO_LARGE,
      `File size exceeds limit of ${settings.max_file_bytes} bytes.`
    );
  }

  // Check dangerous files in Public mode
  if (
    uploadMode === "public" &&
    !settings.allow_public_risky_files &&
    isDangerousFile(cleanFilename, cleanContentType)
  ) {
    throw new AppError(
      403,
      ERROR_CODES.DANGEROUS_FILE_REJECTED,
      "Executable and script files are not permitted in public upload mode."
    );
  }

  const configuredTtl = Number.parseInt(env.PRESIGNED_URL_TTL_SECONDS || "", 10);
  const ttlSeconds = Number.isFinite(configuredTtl) && configuredTtl > 0
    ? Math.min(configuredTtl, DEFAULT_LIMITS.MAX_PRESIGNED_URL_TTL_SECONDS)
    : DEFAULT_LIMITS.PRESIGNED_URL_TTL_SECONDS;

  // A retry refreshes the URL for the existing pending record. Creating a new
  // record would leave the old one pending forever and make commit impossible.
  if (params.fileId) {
    const existing = await getFileById(env.DB, params.fileId);
    if (
      !existing ||
      existing.drop_id !== params.dropId ||
      existing.status !== "pending"
    ) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Pending upload cannot be retried.");
    }
    if (
      existing.filename !== cleanFilename ||
      existing.expected_size !== params.size ||
      existing.content_type.toLowerCase() !== cleanContentType.toLowerCase()
    ) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Retry metadata does not match the pending upload.");
    }

    const refreshed = await createPresignedPutUrl(
      env,
      existing.upload_object_key || existing.object_key,
      existing.content_type,
      ttlSeconds
    );
    const updated = await refreshPendingFilePresign(
      env.DB,
      existing.id,
      params.dropId,
      refreshed.expiresAt
    );
    if (!updated) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Draft was closed while refreshing the upload.");
    }
    await extendObjectDeletionNotBefore(
      env.DB,
      existing.upload_object_key || existing.object_key,
      refreshed.expiresAt + DEFAULT_LIMITS.DELETION_SETTLE_SECONDS * 1000
    );
    return { fileId: existing.id, ...refreshed };
  }

  // Check file count and cumulative drop size for a new upload.
  const existingFiles = await getFilesByDropId(env.DB, params.dropId);
  if (existingFiles.length >= settings.max_files_per_drop) {
    throw new AppError(
      413,
      ERROR_CODES.MAX_FILES_EXCEEDED,
      `Cannot add more than ${settings.max_files_per_drop} files to a drop.`
    );
  }

  const currentTotalBytes = existingFiles.reduce((acc, f) => acc + (f.actual_size ?? f.expected_size), 0);
  if (currentTotalBytes + params.size > settings.max_drop_file_bytes) {
    throw new AppError(
      413,
      ERROR_CODES.TOTAL_FILE_SIZE_EXCEEDED,
      `Cumulative drop file size exceeds limit of ${settings.max_drop_file_bytes} bytes.`
    );
  }

  if (
    params.sortOrder !== undefined &&
    (!Number.isSafeInteger(params.sortOrder) ||
      params.sortOrder < 1 ||
      params.sortOrder > settings.max_files_per_drop)
  ) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid file sort order.");
  }

  const fileId = crypto.randomUUID();
  const objectKey = `drops/${params.dropId}/files/${fileId}`;
  const uploadObjectKey = `uploads/${params.dropId}/${fileId}`;
  let sortOrder = params.sortOrder ?? existingFiles.length + 1;
  const presigned = await createPresignedPutUrl(
    env,
    uploadObjectKey,
    cleanContentType,
    ttlSeconds
  );

  let created = false;
  for (let attempt = 0; attempt <= settings.max_files_per_drop; attempt++) {
    if (sortOrder > settings.max_files_per_drop) break;
    try {
      const inserted = await createPendingFile(env.DB, {
        id: fileId,
        dropId: params.dropId,
        objectKey,
        uploadObjectKey,
        filename: cleanFilename,
        contentType: cleanContentType,
        expectedSize: params.size,
        sortOrder,
        createdAt: now,
        presignExpiresAt: presigned.expiresAt
      }, settings.max_drop_file_bytes);
      if (!inserted) {
        const latestDrop = await getDropById(env.DB, params.dropId);
        if (!latestDrop || latestDrop.status !== "draft") {
          throw new AppError(409, ERROR_CODES.CONFLICT, "Draft was closed while preparing the upload.");
        }
        throw new AppError(
          413,
          ERROR_CODES.TOTAL_FILE_SIZE_EXCEEDED,
          `Cumulative drop file size exceeds limit of ${settings.max_drop_file_bytes} bytes.`
        );
      }
      created = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Concurrent prepare requests can choose the same next order. Retry the
      // transaction with the next slot; unrelated database errors must surface.
      if (!message.includes("UNIQUE constraint failed: drop_items.drop_id")) {
        throw error;
      }
      sortOrder += 1;
    }
  }

  if (!created) {
    throw new AppError(409, ERROR_CODES.CONFLICT, "Could not allocate a unique file order.");
  }

  return {
    fileId,
    ...presigned
  };
}

export interface CompleteUploadParams {
  dropId: string;
  draftToken: string;
  fileId: string;
}

export async function completeUpload(
  env: Env,
  params: CompleteUploadParams
): Promise<{ fileId: string; status: "uploaded" }> {
  const drop = await getDropById(env.DB, params.dropId);
  if (!drop || drop.status !== "draft") {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Draft not found or already closed.");
  }

  // Validate draft token
  const receivedHash = await sha256Hex(params.draftToken);
  if (!(await timingSafeEqual(receivedHash, drop.draft_token_hash))) {
    throw new AppError(403, ERROR_CODES.INVALID_DRAFT_TOKEN, "Invalid draft token.");
  }

  // Validate draft TTL (1 hour)
  const now = Date.now();
  if (now - drop.created_at > DEFAULT_LIMITS.DRAFT_TTL_SECONDS * 1000) {
    throw new AppError(410, ERROR_CODES.DRAFT_EXPIRED, "Draft has expired.");
  }

  const file = await getFileById(env.DB, params.fileId);
  if (!file || file.drop_id !== params.dropId) {
    throw new AppError(404, ERROR_CODES.FILE_NOT_FOUND, "File record not found.");
  }

  if (file.status === "uploaded") {
    const finalized = await env.FILES.head(file.object_key);
    if (!finalized) {
      throw new AppError(409, ERROR_CODES.FILE_NOT_VERIFIED, "Finalized file is missing from storage.");
    }
    if (
      finalized.size !== (file.actual_size ?? file.expected_size) ||
      (file.etag && finalized.httpEtag !== file.etag)
    ) {
      throw new AppError(409, ERROR_CODES.FILE_NOT_VERIFIED, "Finalized file changed after verification.");
    }
    return { fileId: file.id, status: "uploaded" };
  }

  const finalizeToken = crypto.randomUUID();
  const claimed = await claimPendingFileFinalization(env.DB, file.id, finalizeToken, now);
  if (!claimed) {
    throw new AppError(409, ERROR_CODES.CONFLICT, "Upload is already being finalized. Retry shortly.");
  }

  const uploadObjectKey = file.upload_object_key || file.object_key;
  const finalObjectKey = file.upload_object_key
    ? file.object_key
    : `${file.object_key}/final`;
  const uploadedObject = await env.FILES.get(uploadObjectKey);
  if (!uploadedObject) {
    await releasePendingFileFinalization(env.DB, file.id, finalizeToken);
    throw new AppError(
      404,
      ERROR_CODES.FILE_OBJECT_MISSING,
      "Uploaded file was not found in storage."
    );
  }

  if (uploadedObject.size !== file.expected_size) {
    await releasePendingFileFinalization(env.DB, file.id, finalizeToken);
    await quarantineInvalidUpload(env, file, now);
    throw new AppError(
      409,
      ERROR_CODES.FILE_SIZE_MISMATCH,
      `Uploaded file size (${uploadedObject.size}) does not match expected size (${file.expected_size}).`
    );
  }

  const actualContentType = uploadedObject.httpMetadata?.contentType?.trim().toLowerCase();
  if (actualContentType && actualContentType !== file.content_type.toLowerCase()) {
    await releasePendingFileFinalization(env.DB, file.id, finalizeToken);
    await quarantineInvalidUpload(env, file, now);
    throw new AppError(
      409,
      ERROR_CODES.FILE_TYPE_MISMATCH,
      "Uploaded file content type does not match the prepared file."
    );
  }

  let finalizedObject: R2Object | null = null;
  try {
    finalizedObject = await env.FILES.put(finalObjectKey, uploadedObject.body, {
      httpMetadata: { contentType: file.content_type }
    });
    const marked = await markFileUploaded(
      env.DB,
      file.id,
      finalizeToken,
      finalObjectKey,
      uploadedObject.size,
      finalizedObject.httpEtag || null,
      now
    );
    if (!marked) {
      await recordObjectDeletion(env.DB, finalObjectKey, now, now);
      throw new AppError(409, ERROR_CODES.CONFLICT, "Upload state changed while it was being finalized.");
    }
  } catch (error) {
    if (finalizedObject) {
      await recordObjectDeletion(env.DB, finalObjectKey, now, now);
    }
    await releasePendingFileFinalization(env.DB, file.id, finalizeToken);
    throw error;
  }

  // Keep the staging-key tombstone until every reusable presigned URL is
  // invalid, even if the immediate delete succeeds. A delayed PUT is therefore
  // swept later without being able to affect the finalized object.
  const notBefore = Math.max(now, file.presign_expires_at || now) +
    DEFAULT_LIMITS.DELETION_SETTLE_SECONDS * 1000;
  await recordObjectDeletion(env.DB, uploadObjectKey, now, notBefore);
  try {
    await env.FILES.delete(uploadObjectKey);
  } catch (error) {
    console.error(JSON.stringify({ event: "staging_upload_delete_failed", fileId: file.id, error: String(error) }));
  }

  return { fileId: file.id, status: "uploaded" };
}

async function quarantineInvalidUpload(env: Env, file: FileRow, now: number): Promise<void> {
  const notBefore = Math.max(now, file.presign_expires_at || now) +
    DEFAULT_LIMITS.DELETION_SETTLE_SECONDS * 1000;
  const uploadObjectKey = file.upload_object_key || file.object_key;
  await recordObjectDeletion(env.DB, uploadObjectKey, now, notBefore);
  try {
    await env.FILES.delete(uploadObjectKey);
  } catch (error) {
    console.error(JSON.stringify({
      event: "invalid_upload_delete_failed",
      fileId: file.id,
      error: String(error)
    }));
  }
}
