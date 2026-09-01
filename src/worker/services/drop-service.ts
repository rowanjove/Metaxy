import type { Env } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { DEFAULT_LIMITS } from "../../shared/constants";
import { generateCode, normalizeCode } from "../lib/code";
import { generateRandomToken, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { getUtf8ByteLength, isValidExpirySeconds } from "../lib/validation";
import { isInlinePreviewableImage } from "../lib/mime";
import { getParsedSettings } from "../repositories/settings";
import {
  createDraftDrop,
  getDropByCode,
  getDropById,
  commitDrop as repoCommitDrop,
  incrementDropViewCount,
  type DropRow
} from "../repositories/drops";
import {
  deleteTextItem,
  getFilesByDropId,
  getItemsByDropId,
  getTextItemByDropId,
  upsertTextItem,
  recordObjectDeletion,
  type DropItemRow,
  type FileRow
} from "../repositories/files";
import type {
  CommitDropData,
  CreateDraftData,
  DropDetailData,
  DropItemDto
} from "../../shared/contracts";

export async function createDraft(
  env: Env,
  options: { expiresInSeconds?: number } = {}
): Promise<CreateDraftData> {
  const settings = await getParsedSettings(env.DB, env);
  const now = Date.now();

  let expirySeconds = options.expiresInSeconds;
  if (expirySeconds !== undefined && !isValidExpirySeconds(expirySeconds, settings.max_expiry_seconds)) {
    throw new AppError(400, ERROR_CODES.INVALID_EXPIRY, "Expiry must be a positive whole number within the configured limit.");
  }
  expirySeconds = Math.min(
    expirySeconds ?? settings.default_expiry_seconds,
    settings.max_expiry_seconds
  );

  const expiresAt = now + expirySeconds * 1000;
  const dropId = crypto.randomUUID();
  const draftToken = generateRandomToken(32);
  const draftTokenHash = await sha256Hex(draftToken);

  // Try generating unique code with up to 10 retries
  let allocatedCode = "";
  let success = false;

  for (let attempt = 0; attempt < 10; attempt++) {
    allocatedCode = generateCode(settings.code_length);
    try {
      await createDraftDrop(env.DB, {
        id: dropId,
        code: allocatedCode,
        draftTokenHash,
        createdAt: now,
        expiresAt
      });
      success = true;
      break;
    } catch (err: any) {
      // D1 UNIQUE constraint violation on code
      if (err?.message?.includes("UNIQUE") || err?.toString()?.includes("UNIQUE")) {
        continue;
      }
      throw err;
    }
  }

  if (!success) {
    throw new AppError(
      503,
      ERROR_CODES.CODE_GENERATION_FAILED,
      "Failed to allocate a unique retrieval code. Please try again."
    );
  }

  const draftExpiresAt = now + DEFAULT_LIMITS.DRAFT_TTL_SECONDS * 1000;

  return {
    dropId,
    draftToken,
    draftExpiresAt
  };
}

export async function updateText(
  env: Env,
  dropId: string,
  draftToken: string,
  text: string
): Promise<void> {
  const drop = await getDropById(env.DB, dropId);
  if (!drop || drop.status !== "draft") {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Draft not found or already closed.");
  }

  // Validate draft token
  const receivedHash = await sha256Hex(draftToken);
  if (!(await timingSafeEqual(receivedHash, drop.draft_token_hash))) {
    throw new AppError(403, ERROR_CODES.INVALID_DRAFT_TOKEN, "Invalid draft token.");
  }

  // Validate draft TTL (1 hour)
  const now = Date.now();
  if (now - drop.created_at > DEFAULT_LIMITS.DRAFT_TTL_SECONDS * 1000) {
    throw new AppError(410, ERROR_CODES.DRAFT_EXPIRED, "Draft has expired.");
  }
  if (now >= drop.expires_at) {
    throw new AppError(410, ERROR_CODES.DROP_EXPIRED, "This drop has expired.");
  }

  // Empty text means delete text item
  if (!text || text.length === 0) {
    const result = await deleteTextItem(env.DB, dropId, now);
    if (!result.deleted) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Draft was closed while updating text.");
    }
    return;
  }

  const settings = await getParsedSettings(env.DB, env);
  const byteLength = getUtf8ByteLength(text);

  if (byteLength > settings.max_text_bytes) {
    throw new AppError(
      413,
      ERROR_CODES.TEXT_TOO_LARGE,
      `Text size (${byteLength} bytes) exceeds limit of ${settings.max_text_bytes} bytes.`
    );
  }

  if (byteLength <= DEFAULT_LIMITS.TEXT_D1_MAX_BYTES) {
    // Small text <= 1 MiB: store in D1
    const result = await upsertTextItem(env.DB, dropId, "d1", text, null, byteLength, now);
    if (!result.updated) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Draft was closed while updating text.");
    }
  } else {
    // Large text > 1 MiB: store in Private R2
    const r2Key = `drops/${dropId}/text_${crypto.randomUUID()}.txt`;

    await env.FILES.put(r2Key, text, {
      httpMetadata: {
        contentType: "text/plain; charset=utf-8"
      }
    });

    try {
      const result = await upsertTextItem(env.DB, dropId, "r2", null, r2Key, byteLength, now);
      if (!result.updated) {
        await recordObjectDeletion(env.DB, r2Key, now, now);
        throw new AppError(409, ERROR_CODES.CONFLICT, "Draft was closed while updating text.");
      }
    } catch (err) {
      // The new key is not referenced by D1 when the metadata write fails.
      await recordObjectDeletion(env.DB, r2Key, now);
      throw err;
    }
  }
}

export async function commitDrop(
  env: Env,
  dropId: string,
  draftToken: string,
  originUrl: string
): Promise<CommitDropData> {
  const drop = await getDropById(env.DB, dropId);
  if (!drop) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Drop not found.");
  }

  // Validate draft token
  const receivedHash = await sha256Hex(draftToken);
  if (!(await timingSafeEqual(receivedHash, drop.draft_token_hash))) {
    throw new AppError(403, ERROR_CODES.INVALID_DRAFT_TOKEN, "Invalid draft token.");
  }

  // Idempotent commit: if already active, return existing URL & code
  if (drop.status === "active") {
    const url = `${originUrl}/d/${drop.code}`;
    return {
      code: drop.code,
      url,
      expiresAt: drop.expires_at
    };
  }

  if (drop.status !== "draft") {
    throw new AppError(410, ERROR_CODES.DROP_REVOKED, "Drop is no longer accessible.");
  }

  // Validate draft TTL (1 hour)
  const now = Date.now();
  if (now - drop.created_at > DEFAULT_LIMITS.DRAFT_TTL_SECONDS * 1000) {
    throw new AppError(410, ERROR_CODES.DRAFT_EXPIRED, "Draft has expired.");
  }
  if (now >= drop.expires_at) {
    throw new AppError(410, ERROR_CODES.DROP_EXPIRED, "This drop has expired.");
  }

  const [items, files] = await Promise.all([
    getItemsByDropId(env.DB, dropId),
    getFilesByDropId(env.DB, dropId)
  ]);

  if (items.length === 0 && files.length === 0) {
    throw new AppError(400, ERROR_CODES.EMPTY_DROP, "Cannot commit an empty drop.");
  }

  // Verify all files are in uploaded status
  const pendingFiles = files.filter((f) => f.status !== "uploaded");
  if (pendingFiles.length > 0) {
    throw new AppError(
      409,
      ERROR_CODES.FILE_NOT_VERIFIED,
      "Some files are still pending upload or verification."
    );
  }

  // Verify R2 object existence for each file
  for (const file of files) {
    const head = await env.FILES.head(file.object_key);
    if (
      !head ||
      head.size !== (file.actual_size ?? file.expected_size) ||
      (file.etag && head.httpEtag && file.etag !== head.httpEtag)
    ) {
      throw new AppError(
        409,
        ERROR_CODES.FILE_NOT_VERIFIED,
        `File ${file.filename} was not found in storage or size mismatch.`
      );
    }
  }

  // Calculate totals
  const totalFileSize = files.reduce((acc, f) => acc + (f.actual_size ?? f.expected_size), 0);
  const settings = await getParsedSettings(env.DB, env);
  if (files.length > settings.max_files_per_drop) {
    throw new AppError(
      409,
      ERROR_CODES.MAX_FILES_EXCEEDED,
      `Drop contains more than ${settings.max_files_per_drop} files.`
    );
  }
  if (totalFileSize > settings.max_drop_file_bytes) {
    throw new AppError(
      413,
      ERROR_CODES.TOTAL_FILE_SIZE_EXCEEDED,
      `Cumulative drop file size exceeds limit of ${settings.max_drop_file_bytes} bytes.`
    );
  }
  const textItem = items.find((i) => i.type === "text");
  const totalTextSize = textItem ? textItem.size : 0;
  const totalSize = totalFileSize + totalTextSize;
  const itemCount = items.length;

  const committed = await repoCommitDrop(env.DB, dropId, totalSize, itemCount, now);
  if (!committed) {
    const latestDrop = await getDropById(env.DB, dropId);
    if (latestDrop?.status === "active") {
      return {
        code: latestDrop.code,
        url: `${originUrl}/d/${latestDrop.code}`,
        expiresAt: latestDrop.expires_at
      };
    }
    if (latestDrop && now >= latestDrop.expires_at) {
      throw new AppError(410, ERROR_CODES.DROP_EXPIRED, "This drop has expired.");
    }
    throw new AppError(409, ERROR_CODES.CONFLICT, "Drop was changed while it was being committed.");
  }

  const url = `${originUrl}/d/${drop.code}`;
  return {
    code: drop.code,
    url,
    expiresAt: drop.expires_at
  };
}

export async function getDropDetail(
  env: Env,
  rawCode: string
): Promise<DropDetailData> {
  const code = normalizeCode(rawCode);
  if (!code) {
    throw new AppError(400, ERROR_CODES.INVALID_CODE_FORMAT, "Invalid retrieval code format.");
  }

  const drop = await getDropByCode(env.DB, code);
  if (!drop) {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "The requested drop was not found.");
  }

  if (drop.status === "revoked" || drop.status === "deleting") {
    throw new AppError(410, ERROR_CODES.DROP_REVOKED, "This drop is no longer available.");
  }

  if (drop.status !== "active") {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "The requested drop is not active.");
  }

  const now = Date.now();
  if (now >= drop.expires_at) {
    throw new AppError(410, ERROR_CODES.DROP_EXPIRED, "This drop has expired.");
  }

  // Increment view count
  await incrementDropViewCount(env.DB, drop.id, now);

  const [items, files] = await Promise.all([
    getItemsByDropId(env.DB, drop.id),
    getFilesByDropId(env.DB, drop.id)
  ]);

  const fileMap = new Map<string, FileRow>();
  for (const file of files) {
    fileMap.set(file.id, file);
  }

  const formattedItems: DropItemDto[] = [];
  for (const item of items) {
    if (item.type === "text") {
      formattedItems.push({
        id: item.id,
        type: "text",
        size: item.size,
        content: item.text_storage === "d1" ? item.text_content : null,
        contentUrl:
          item.text_storage === "r2"
            ? `/api/v1/drops/${code}/items/${item.id}/text`
            : null
      });
    } else if (item.type === "file" && item.file_id) {
      const file = fileMap.get(item.file_id);
      if (file && file.status === "uploaded") {
        formattedItems.push({
          id: item.id,
          type: "file",
          file: {
            id: file.id,
            filename: file.filename,
            contentType: file.content_type,
            size: file.actual_size ?? file.expected_size,
            previewable: isInlinePreviewableImage(file.content_type),
            contentUrl: `/api/v1/files/${file.id}/content`,
            downloadUrl: `/api/v1/files/${file.id}/content?download=1`
          }
        });
      }
    }
  }

  const remainingSeconds = Math.max(0, Math.floor((drop.expires_at - now) / 1000));

  return {
    code: drop.code,
    expiresAt: drop.expires_at,
    remainingSeconds,
    items: formattedItems
  };
}

export async function getR2TextStream(
  env: Env,
  rawCode: string,
  itemId: string
): Promise<Response> {
  const code = normalizeCode(rawCode);
  if (!code) {
    throw new AppError(400, ERROR_CODES.INVALID_CODE_FORMAT, "Invalid retrieval code format.");
  }

  const drop = await getDropByCode(env.DB, code);
  if (!drop) {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "The requested drop was not found.");
  }
  if (drop.status === "revoked" || drop.status === "deleting") {
    throw new AppError(410, ERROR_CODES.DROP_REVOKED, "This drop is no longer available.");
  }
  if (drop.status !== "active") {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "The requested drop was not found.");
  }
  if (Date.now() >= drop.expires_at) {
    throw new AppError(410, ERROR_CODES.DROP_EXPIRED, "This drop has expired.");
  }

  const item = await getTextItemByDropId(env.DB, drop.id);
  if (!item || item.id !== itemId || item.text_storage !== "r2" || !item.text_object_key) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Text item not found.");
  }

  const r2Object = await env.FILES.get(item.text_object_key);
  if (!r2Object) {
    throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "Text object not found in storage.");
  }

  const headers = new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(r2Object.body, { headers });
}

export async function createShortcutDrop(
  env: Env,
  content: string,
  expiresInSeconds?: number,
  originUrl: string = ""
): Promise<CommitDropData> {
  if (!(content || "").trim()) {
    throw new AppError(400, ERROR_CODES.EMPTY_DROP, "Content cannot be empty.");
  }

  const draft = await createDraft(env, { expiresInSeconds });
  await updateText(env, draft.dropId, draft.draftToken, content);
  return commitDrop(env, draft.dropId, draft.draftToken, originUrl);
}
