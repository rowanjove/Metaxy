import type { Env } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import type {
  GalleryImageDto,
  GalleryListResponse,
  GalleryPrepareUploadRequest,
  GalleryPrepareUploadResponse,
  GalleryCompleteUploadRequest,
  GalleryBatchRequest,
  GalleryBatchResponse,
  GalleryAlbumDto
} from "../../shared/gallery-contracts";
import {
  getGalleryImageByHash,
  getGalleryImageById,
  insertGalleryImage,
  listGalleryImages,
  markGalleryImageDeleting,
  recordGalleryObjectDeletion,
  finalizeGalleryImageDeletion,
  setGalleryImageFavorite,
  setGalleryImageAlbum,
  type GalleryImageRow,
  type ListGalleryImagesOptions
} from "../repositories/gallery";
import {
  insertGalleryUpload,
  getGalleryUploadById,
  claimGalleryUploadFinalization,
  updateGalleryUploadStatus,
  type GalleryUploadRow
} from "../repositories/gallery-uploads";
import {
  insertGalleryAlbum,
  getGalleryAlbumById,
  getGalleryAlbumBySlug,
  listGalleryAlbums,
  updateGalleryAlbum as repoUpdateAlbum,
  deleteGalleryAlbum as repoDeleteAlbum,
  type GalleryAlbumRow
} from "../repositories/gallery-albums";
import { createPresignedPutUrl } from "./presign-service";
import { bufferSha256Hex, generateShortSlug } from "../lib/crypto";
import { extractExtensions } from "../lib/mime";
import { sanitizeFilename } from "../lib/filename";

export const ALLOWED_GALLERY_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon"
]);

export const MAX_DIRECT_GALLERY_BYTES = 50 * 1024 * 1024;
export const MAX_GALLERY_THUMB_BYTES = 4 * 1024 * 1024;
const MAX_GALLERY_METADATA_BYTES = 16 * 1024;
const MAX_GALLERY_DIMENSION = 100_000;
const MAX_GALLERY_ID_LENGTH = 128;
const MAX_GALLERY_NAME_LENGTH = 128;

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico"
};

export function getPreferredExtension(filename: string, contentType: string): string {
  const exts = extractExtensions(filename);
  if (exts.length > 0) {
    const last = exts[exts.length - 1].toLowerCase();
    if (["jpg", "jpeg", "png", "webp", "gif", "avif", "ico", "bmp"].includes(last)) {
      return last === "jpeg" ? "jpg" : last;
    }
  }
  const cleanMime = contentType.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[cleanMime] || "jpg";
}

export function formatGalleryImageDto(image: GalleryImageRow, originUrl: string, publicBaseUrl?: string): GalleryImageDto {
  const ext = getPreferredExtension(image.filename, image.content_type);
  const baseUrl = (publicBaseUrl || "").trim().replace(/\/+$/, "") || originUrl;
  const formattedUrl = `${baseUrl}/i/${image.id}.${ext}`;
  const rawUrl = `${baseUrl}/i/${image.id}`;
  const thumbUrl = image.thumb_object_key ? `${baseUrl}/i/${image.id}.thumb.webp` : formattedUrl;
  const safeFilename = sanitizeFilename(image.filename);
  const markdownAlt = escapeMarkdownAltText(safeFilename);
  const htmlFilename = escapeHtml(safeFilename);
  const htmlUrl = escapeHtml(formattedUrl);

  return {
    id: image.id,
    url: formattedUrl,
    rawUrl,
    thumbUrl,
    markdown: `![${markdownAlt}](${formattedUrl})`,
    html: `<img src="${htmlUrl}" alt="${htmlFilename}" />`,
    bbcode: `[img]${formattedUrl}[/img]`,
    jsonSnippet: JSON.stringify({ id: image.id, url: formattedUrl, width: image.width, height: image.height }),
    filename: image.filename,
    contentType: image.content_type,
    sizeBytes: image.size_bytes,
    originalSizeBytes: image.original_size_bytes ?? null,
    width: image.width,
    height: image.height,
    hash: image.hash ?? null,
    favorite: Boolean(image.favorite),
    albumId: image.album_id ?? null,
    dominantColor: image.dominant_color ?? null,
    metadataJson: image.metadata_json ?? null,
    createdAt: image.created_at,
    viewCount: image.view_count
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] || character);
}

function escapeMarkdownAltText(value: string): string {
  return value.replace(/[\\[\]]/g, (character) => `\\${character}`);
}

function validateOptionalDimension(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_GALLERY_DIMENSION) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, `${field} must be a safe integer between 0 and ${MAX_GALLERY_DIMENSION}.`);
  }
}

function validateOptionalPositiveInteger(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, `${field} must be a positive safe integer.`);
  }
}

function serializeGalleryMetadata(metadata: unknown): string | null {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery metadata must be a JSON object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch (cause) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery metadata must be JSON serializable.", cause);
  }
  if (serialized.length > MAX_GALLERY_METADATA_BYTES) {
    throw new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, "Gallery metadata exceeds the configured limit.");
  }
  return serialized;
}

async function deleteGalleryStaging(env: Env, session: GalleryUploadRow): Promise<void> {
  if (!env.GALLERY) return;
  const keys = [session.staging_object_key, session.thumb_staging_object_key].filter(
    (key): key is string => Boolean(key)
  );
  await Promise.all(keys.map(async (key) => {
    try {
      await env.GALLERY!.delete(key);
    } catch (error) {
      console.error(JSON.stringify({ event: "gallery_staging_delete_deferred", objectKey: key, error: String(error) }));
    }
  }));
}

async function markGalleryUploadFailed(env: Env, session: GalleryUploadRow): Promise<void> {
  await deleteGalleryStaging(env, session);
  try {
    await updateGalleryUploadStatus(env.DB, session.id, "failed");
  } catch (error) {
    console.error(JSON.stringify({ event: "gallery_upload_status_update_failed", uploadId: session.id, error: String(error) }));
  }
}

async function validateGalleryAlbumId(env: Env, albumId: string | null | undefined): Promise<string | null> {
  if (albumId === undefined || albumId === null) return null;
  if (typeof albumId !== "string" || !albumId.trim() || albumId.length > MAX_GALLERY_ID_LENGTH) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album ID is invalid.");
  }
  const cleanId = albumId.trim();
  if (!(await getGalleryAlbumById(env.DB, cleanId))) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Album not found.");
  }
  return cleanId;
}

export function hasImageSignature(data: ArrayBuffer, contentType: string): boolean {
  const bytes = new Uint8Array(data);
  const startsWith = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const asciiAt = (offset: number, value: string) => {
    if (bytes.length < offset + value.length) return false;
    return value.split("").every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  };

  switch (contentType) {
    case "image/jpeg":
      return startsWith(0xff, 0xd8, 0xff);
    case "image/png":
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/gif":
      return asciiAt(0, "GIF87a") || asciiAt(0, "GIF89a");
    case "image/webp":
      return asciiAt(0, "RIFF") && asciiAt(8, "WEBP");
    case "image/avif": {
      if (!asciiAt(4, "ftyp")) return false;
      for (let offset = 8; offset + 4 <= bytes.length && offset < 32; offset += 4) {
        if (asciiAt(offset, "avif") || asciiAt(offset, "avis")) return true;
      }
      return false;
    }
    case "image/bmp":
      return startsWith(0x42, 0x4d);
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return startsWith(0x00, 0x00, 0x01, 0x00) || startsWith(0x00, 0x00, 0x02, 0x00);
    default:
      return false;
  }
}

// ---------------- Presigned Direct Upload Pipeline ----------------

export async function prepareGalleryUpload(
  env: Env,
  params: GalleryPrepareUploadRequest
): Promise<GalleryPrepareUploadResponse> {
  if (!Number.isSafeInteger(params.size) || params.size <= 0) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Image size must be greater than 0.");
  }
  if (params.size > MAX_DIRECT_GALLERY_BYTES) {
    throw new AppError(413, ERROR_CODES.FILE_TOO_LARGE, "Image exceeds maximum allowed size (50 MiB).");
  }

  if (params.hasThumbnail !== undefined && typeof params.hasThumbnail !== "boolean") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "hasThumbnail must be a boolean.");
  }
  const hasThumbnail = params.hasThumbnail === true;
  if (params.thumbSize !== undefined) {
    if (!hasThumbnail) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "thumbSize requires hasThumbnail=true.");
    }
    validateOptionalPositiveInteger(params.thumbSize, "thumbSize");
    if (params.thumbSize > MAX_GALLERY_THUMB_BYTES) {
      throw new AppError(413, ERROR_CODES.FILE_TOO_LARGE, "Thumbnail exceeds maximum allowed size (4 MiB).");
    }
  }
  validateOptionalDimension(params.width, "width");
  validateOptionalDimension(params.height, "height");

  let contentType = (typeof params.contentType === "string" ? params.contentType : "").split(";")[0].trim().toLowerCase();
  let filename = sanitizeFilename((typeof params.filename === "string" ? params.filename : "").trim());

  if (!contentType || contentType === "application/octet-stream") {
    const ext = getPreferredExtension(filename, "");
    if (ext === "png") contentType = "image/png";
    else if (ext === "jpg") contentType = "image/jpeg";
    else if (ext === "webp") contentType = "image/webp";
    else if (ext === "gif") contentType = "image/gif";
    else if (ext === "avif") contentType = "image/avif";
  }

  if (!ALLOWED_GALLERY_MIME_TYPES.has(contentType)) {
    throw new AppError(400, ERROR_CODES.GALLERY_INVALID_IMAGE, `Unsupported image format: ${contentType || "unknown"}`);
  }

  const uploadId = generateShortSlug(16);
  const imageId = generateShortSlug(8);
  const stagingKey = `gallery-staging/${uploadId}`;
  const thumbStagingKey = hasThumbnail ? `gallery-staging/${uploadId}-thumb` : null;

  const presigned = await createPresignedPutUrl(
    env,
    stagingKey,
    contentType,
    300,
    "GALLERY"
  );

  let thumbUploadUrl: string | null = null;
  if (thumbStagingKey) {
    const thumbPresigned = await createPresignedPutUrl(
      env,
      thumbStagingKey,
      "image/webp",
      300,
      "GALLERY"
    );
    thumbUploadUrl = thumbPresigned.uploadUrl;
  }

  const sessionRow: GalleryUploadRow = {
    id: uploadId,
      image_id: imageId,
      staging_object_key: stagingKey,
      thumb_staging_object_key: thumbStagingKey,
      thumb_expected_size: params.thumbSize ?? null,
    filename: filename || `image_${imageId}`,
    expected_size: params.size,
    expected_content_type: contentType,
    width: params.width ?? null,
    height: params.height ?? null,
    created_at: Date.now(),
    expires_at: Date.now() + 300 * 1000,
    status: "prepared"
  };

  await insertGalleryUpload(env.DB, sessionRow);

  return {
    uploadId,
    imageId,
    uploadUrl: presigned.uploadUrl,
    thumbUploadUrl,
    expiresAt: presigned.expiresAt
  };
}

export async function completeGalleryUpload(
  env: Env,
  uploadId: string,
  params: GalleryCompleteUploadRequest,
  originUrl: string
): Promise<GalleryImageDto> {
  if (!env.GALLERY) {
    throw new AppError(503, ERROR_CODES.SERVICE_UNAVAILABLE, "Gallery storage is not configured on this server.");
  }

  if (!uploadId || uploadId.length > MAX_GALLERY_ID_LENGTH) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Upload session not found.");
  }
  if (params.filename !== undefined && (typeof params.filename !== "string" || params.filename.length > 255)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Filename is invalid.");
  }
  validateOptionalPositiveInteger(params.originalSizeBytes, "originalSizeBytes");
  validateOptionalDimension(params.width, "width");
  validateOptionalDimension(params.height, "height");
  if (params.albumId !== undefined && params.albumId !== null && typeof params.albumId !== "string") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album ID is invalid.");
  }
  const albumId = await validateGalleryAlbumId(env, params.albumId);
  if (params.dominantColor !== undefined && params.dominantColor !== null &&
      (typeof params.dominantColor !== "string" || !/^#[0-9a-f]{6}$/i.test(params.dominantColor))) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "dominantColor must be a hexadecimal color.");
  }
  const metadataJson = serializeGalleryMetadata(params.metadata);

  const session = await getGalleryUploadById(env.DB, uploadId);
  if (!session) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Upload session not found.");
  }
  if (session.status === "completed") {
    const existingImage = await getGalleryImageById(env.DB, session.image_id);
    if (existingImage) {
      return formatGalleryImageDto(existingImage, originUrl, env.PUBLIC_IMAGE_BASE_URL);
    }
  }
  const nowMs = Date.now();
  if (session.status === "expired" || nowMs > session.expires_at) {
    throw new AppError(410, ERROR_CODES.BAD_REQUEST, "Upload session has expired.");
  }

  const claimed = await claimGalleryUploadFinalization(env.DB, uploadId, nowMs);
  if (!claimed) {
    const latest = await getGalleryUploadById(env.DB, uploadId);
    const existingImage = latest ? await getGalleryImageById(env.DB, latest.image_id) : null;
    if (existingImage) {
      return formatGalleryImageDto(existingImage, originUrl, env.PUBLIC_IMAGE_BASE_URL);
    }
    if (!latest || latest.status === "expired" || Date.now() > latest.expires_at) {
      throw new AppError(410, ERROR_CODES.BAD_REQUEST, "Upload session has expired.");
    }
    throw new AppError(409, ERROR_CODES.CONFLICT, "Upload is already being finalized. Retry shortly.");
  }

  // Read the uploaded staging object from R2
  const stagingObj = await env.GALLERY.get(session.staging_object_key);
  if (!stagingObj) {
    await markGalleryUploadFailed(env, session);
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Staging image object not found in R2.");
  }

  if (!Number.isSafeInteger(stagingObj.size) || stagingObj.size !== session.expected_size || stagingObj.size > MAX_DIRECT_GALLERY_BYTES) {
    await markGalleryUploadFailed(env, session);
    throw new AppError(400, ERROR_CODES.FILE_SIZE_MISMATCH, "Uploaded image size does not match the prepared upload.");
  }

  const stagingData = await stagingObj.arrayBuffer();
  if (stagingData.byteLength === 0 || stagingData.byteLength !== session.expected_size) {
    await markGalleryUploadFailed(env, session);
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Uploaded image is empty.");
  }

  // Validate magic bytes
  if (!hasImageSignature(stagingData, session.expected_content_type)) {
    await markGalleryUploadFailed(env, session);
    throw new AppError(400, ERROR_CODES.GALLERY_INVALID_IMAGE, "Image content does not match declared format.");
  }

  // Deduplication check by SHA-256
  const hash = await bufferSha256Hex(stagingData);
  const existing = await getGalleryImageByHash(env.DB, hash);
  if (existing) {
    await deleteGalleryStaging(env, session);
    await updateGalleryUploadStatus(env.DB, uploadId, "completed");
    return formatGalleryImageDto(existing, originUrl, env.PUBLIC_IMAGE_BASE_URL);
  }

  const ext = getPreferredExtension(session.filename, session.expected_content_type);
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const formalKey = `gallery/${year}/${month}/${session.image_id}.${ext}`;

  let thumbObjectKey: string | null = null;
  try {
    // Put into formal key
    await env.GALLERY.put(formalKey, stagingData, {
      httpMetadata: {
        contentType: session.expected_content_type
      }
    });

    // Handle thumbnail if present
    if (session.thumb_staging_object_key) {
      const thumbObj = await env.GALLERY.get(session.thumb_staging_object_key);
      if (!thumbObj) {
        throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Thumbnail object not found in R2.");
      }
      if (!Number.isSafeInteger(thumbObj.size) || thumbObj.size <= 0 || thumbObj.size > MAX_GALLERY_THUMB_BYTES ||
          (session.thumb_expected_size != null && thumbObj.size !== session.thumb_expected_size)) {
        throw new AppError(400, ERROR_CODES.FILE_SIZE_MISMATCH, "Uploaded thumbnail size is invalid.");
      }
      const thumbData = await thumbObj.arrayBuffer();
      if (thumbData.byteLength !== thumbObj.size || !hasImageSignature(thumbData, "image/webp")) {
        throw new AppError(400, ERROR_CODES.GALLERY_INVALID_IMAGE, "Thumbnail content does not match WebP format.");
      }
      thumbObjectKey = `gallery-thumbs/${year}/${month}/${session.image_id}.webp`;
      await env.GALLERY.put(thumbObjectKey, thumbData, {
        httpMetadata: { contentType: "image/webp" }
      });
    }
  } catch (error) {
    try {
      await recordGalleryObjectDeletion(env.DB, formalKey, null, Date.now());
      if (thumbObjectKey) await recordGalleryObjectDeletion(env.DB, thumbObjectKey, null, Date.now());
    } catch {
      await env.GALLERY.delete(formalKey).catch(() => {});
      if (thumbObjectKey) await env.GALLERY.delete(thumbObjectKey).catch(() => {});
    }
    await markGalleryUploadFailed(env, session);
    throw error;
  }

  const row: GalleryImageRow = {
    id: session.image_id,
    object_key: formalKey,
    filename: sanitizeFilename(params.filename || session.filename),
    content_type: session.expected_content_type,
    size_bytes: stagingData.byteLength,
    original_size_bytes: params.originalSizeBytes ?? session.expected_size,
    thumb_object_key: thumbObjectKey,
    width: params.width ?? session.width ?? null,
    height: params.height ?? session.height ?? null,
    hash,
    favorite: 0,
    album_id: albumId,
    dominant_color: params.dominantColor ?? null,
    metadata_json: metadataJson,
    created_at: Date.now(),
    view_count: 0,
    last_viewed_at: null
  };

  try {
    await insertGalleryImage(env.DB, row);
  } catch (error) {
    try {
      await recordGalleryObjectDeletion(env.DB, formalKey, null, Date.now());
      if (thumbObjectKey) {
        await recordGalleryObjectDeletion(env.DB, thumbObjectKey, null, Date.now());
      }
    } catch {
      await env.GALLERY.delete(formalKey).catch(() => {});
      if (thumbObjectKey) await env.GALLERY.delete(thumbObjectKey).catch(() => {});
    }
    throw error;
  }

  // Cleanup staging object & update status
  await deleteGalleryStaging(env, session);
  await updateGalleryUploadStatus(env.DB, uploadId, "completed");

  return formatGalleryImageDto(row, originUrl, env.PUBLIC_IMAGE_BASE_URL);
}

// ---------------- Legacy Direct Worker Upload (PicGo / Typora Compatibility) ----------------

export async function uploadGalleryImage(
  env: Env,
  params: {
    data: ArrayBuffer;
    filename?: string;
    contentType?: string;
    originUrl: string;
    width?: number;
    height?: number;
    albumId?: string;
  }
): Promise<GalleryImageDto> {
  const maxBytes = 10 * 1024 * 1024; // 10 MiB
  if (params.data.byteLength <= 0) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Image data cannot be empty.");
  }
  if (params.data.byteLength > maxBytes) {
    throw new AppError(413, ERROR_CODES.FILE_TOO_LARGE, "Image exceeds maximum allowed size (10 MiB).");
  }

  let contentType = (params.contentType || "").split(";")[0].trim().toLowerCase();
  let filename = (params.filename || "").trim();

  if (!contentType || contentType === "application/octet-stream") {
    const exts = extractExtensions(filename);
    const ext = exts.length > 0 ? exts[exts.length - 1].toLowerCase() : "";
    if (ext === "png") contentType = "image/png";
    else if (ext === "jpg" || ext === "jpeg") contentType = "image/jpeg";
    else if (ext === "webp") contentType = "image/webp";
    else if (ext === "gif") contentType = "image/gif";
    else if (ext === "avif") contentType = "image/avif";
  }

  if (!ALLOWED_GALLERY_MIME_TYPES.has(contentType)) {
    throw new AppError(400, ERROR_CODES.GALLERY_INVALID_IMAGE, `Unsupported image format: ${contentType || "unknown"}`);
  }

  if (!hasImageSignature(params.data, contentType)) {
    throw new AppError(400, ERROR_CODES.GALLERY_INVALID_IMAGE, "Image content does not match the declared format.");
  }

  const albumId = await validateGalleryAlbumId(env, params.albumId);

  const hash = await bufferSha256Hex(params.data);
  const existing = await getGalleryImageByHash(env.DB, hash);
  if (existing) {
    return formatGalleryImageDto(existing, params.originUrl, env.PUBLIC_IMAGE_BASE_URL);
  }

  const ext = getPreferredExtension(filename, contentType);
  let id = generateShortSlug(8);

  const collision = await getGalleryImageById(env.DB, id);
  if (collision) {
    id = generateShortSlug(10);
  }

  if (!filename) {
    filename = `image_${id}.${ext}`;
  } else {
    filename = sanitizeFilename(filename);
  }

  const date = new Date();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const objectKey = `gallery/${year}/${month}/${id}.${ext}`;

  if (!env.GALLERY) {
    throw new AppError(503, ERROR_CODES.SERVICE_UNAVAILABLE, "Gallery storage is not configured on this server.");
  }

  await env.GALLERY.put(objectKey, params.data, {
    httpMetadata: {
      contentType
    }
  });

  const row: GalleryImageRow = {
    id,
    object_key: objectKey,
    filename,
    content_type: contentType,
    size_bytes: params.data.byteLength,
    original_size_bytes: params.data.byteLength,
    thumb_object_key: null,
    width: params.width ?? null,
    height: params.height ?? null,
    hash,
    favorite: 0,
    album_id: albumId,
    dominant_color: null,
    metadata_json: null,
    created_at: Date.now(),
    view_count: 0,
    last_viewed_at: null
  };

  try {
    await insertGalleryImage(env.DB, row);
  } catch (error) {
    try {
      await recordGalleryObjectDeletion(env.DB, objectKey, null, Date.now());
    } catch {
      await env.GALLERY.delete(objectKey).catch(() => {});
    }
    throw error;
  }
  return formatGalleryImageDto(row, params.originUrl, env.PUBLIC_IMAGE_BASE_URL);
}

export async function deleteGalleryImageById(env: Env, id: string): Promise<boolean> {
  if (!env.GALLERY) {
    throw new AppError(503, ERROR_CODES.SERVICE_UNAVAILABLE, "Gallery storage is not configured on this server.");
  }
  const image = await markGalleryImageDeleting(env.DB, id, Date.now());
  if (!image) return false;

  try {
    await env.GALLERY.delete(image.object_key);
    if (image.thumb_object_key) {
      await env.GALLERY.delete(image.thumb_object_key);
    }
    await finalizeGalleryImageDeletion(env.DB, image.id, image.object_key, image.thumb_object_key);
  } catch (err) {
    console.error(JSON.stringify({ event: "gallery_delete_deferred", imageId: image.id, objectKey: image.object_key, error: String(err) }));
    throw new AppError(503, ERROR_CODES.GALLERY_DELETE_FAILED, "Image deletion was queued for retry.", err);
  }
  return true;
}

export async function listGalleryImagesList(
  env: Env,
  originUrl: string,
  options: ListGalleryImagesOptions
): Promise<GalleryListResponse> {
  const result = await listGalleryImages(env.DB, options);
  return {
    items: result.items.map((item) => formatGalleryImageDto(item, originUrl, env.PUBLIC_IMAGE_BASE_URL)),
    total: result.total,
    nextCursor: result.nextCursor ? String(result.nextCursor) : null
  };
}

export async function toggleGalleryImageFavorite(
  env: Env,
  id: string,
  favorite: boolean
): Promise<boolean> {
  return setGalleryImageFavorite(env.DB, id, favorite);
}

export async function setGalleryImageAlbumId(
  env: Env,
  id: string,
  albumId: string | null
): Promise<boolean> {
  const cleanAlbumId = await validateGalleryAlbumId(env, albumId);
  return setGalleryImageAlbum(env.DB, id, cleanAlbumId);
}

export async function batchProcessGalleryImages(
  env: Env,
  req: GalleryBatchRequest
): Promise<GalleryBatchResponse> {
  let count = 0;
  if (req.operation === "delete") {
    for (const id of req.ids) {
      const deleted = await deleteGalleryImageById(env, id).catch(() => false);
      if (deleted) count++;
    }
  } else if (req.operation === "favorite" || req.operation === "unfavorite") {
    const fav = req.operation === "favorite";
    for (const id of req.ids) {
      const ok = await setGalleryImageFavorite(env.DB, id, fav);
      if (ok) count++;
    }
  } else if (req.operation === "move_album") {
    const albumId = await validateGalleryAlbumId(env, req.albumId);
    for (const id of req.ids) {
      const ok = await setGalleryImageAlbum(env.DB, id, albumId);
      if (ok) count++;
    }
  }
  return {
    success: true,
    processedCount: count,
    operation: req.operation
  };
}

// ---------------- Album Services ----------------

export async function createGalleryAlbumService(
  env: Env,
  name: string,
  slug?: string
): Promise<GalleryAlbumDto> {
  if (typeof name !== "string") throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album name is required.");
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > MAX_GALLERY_NAME_LENGTH) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album name must be between 1 and 128 characters.");
  }
  const id = generateShortSlug(8);
  if (slug !== undefined && typeof slug !== "string") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album slug is invalid.");
  }
  const cleanSlug = (slug || cleanName).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || id;
  if (cleanSlug.length > MAX_GALLERY_NAME_LENGTH) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album slug is too long.");
  }

  const existing = await getGalleryAlbumBySlug(env.DB, cleanSlug);
  if (existing) {
    throw new AppError(409, ERROR_CODES.BAD_REQUEST, "Album slug already exists.");
  }

  const now = Date.now();
  const row: GalleryAlbumRow = {
    id,
    name: cleanName,
    slug: cleanSlug,
    cover_image_id: null,
    created_at: now,
    updated_at: now
  };

  try {
    await insertGalleryAlbum(env.DB, row);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Album slug already exists.", error);
    }
    throw error;
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    coverImageId: row.cover_image_id,
    coverImageUrl: null,
    imageCount: 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listGalleryAlbumsService(
  env: Env,
  originUrl: string
): Promise<GalleryAlbumDto[]> {
  const albums = await listGalleryAlbums(env.DB);
  const dtos: GalleryAlbumDto[] = [];
  for (const a of albums) {
    let coverImageUrl: string | null = null;
    if (a.cover_image_id) {
      const img = await getGalleryImageById(env.DB, a.cover_image_id);
      if (img) {
        coverImageUrl = formatGalleryImageDto(img, originUrl, env.PUBLIC_IMAGE_BASE_URL).thumbUrl || null;
      }
    }
    dtos.push({
      id: a.id,
      name: a.name,
      slug: a.slug,
      coverImageId: a.cover_image_id,
      coverImageUrl,
      createdAt: a.created_at,
      updatedAt: a.updated_at
    });
  }
  return dtos;
}

export async function updateGalleryAlbumService(
  env: Env,
  id: string,
  data: { name?: string; slug?: string; coverImageId?: string | null }
): Promise<void> {
  const album = await getGalleryAlbumById(env.DB, id);
  if (!album) throw new AppError(404, ERROR_CODES.NOT_FOUND, "Album not found.");
  const update: { name?: string; slug?: string; cover_image_id?: string | null; updated_at: number } = {
    updated_at: Date.now()
  };
  if (data.name !== undefined) {
    if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > MAX_GALLERY_NAME_LENGTH) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album name is invalid.");
    }
    update.name = data.name.trim();
  }
  if (data.slug !== undefined) {
    if (typeof data.slug !== "string") throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album slug is invalid.");
    const cleanSlug = data.slug.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!cleanSlug || cleanSlug.length > MAX_GALLERY_NAME_LENGTH) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album slug is invalid.");
    }
    const slugOwner = await getGalleryAlbumBySlug(env.DB, cleanSlug);
    if (slugOwner && slugOwner.id !== id) throw new AppError(409, ERROR_CODES.CONFLICT, "Album slug already exists.");
    update.slug = cleanSlug;
  }
  if (data.coverImageId !== undefined) {
    if (data.coverImageId !== null && (typeof data.coverImageId !== "string" || !data.coverImageId.trim() || data.coverImageId.length > MAX_GALLERY_ID_LENGTH)) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Cover image ID is invalid.");
    }
    update.cover_image_id = data.coverImageId === null ? null : data.coverImageId.trim();
  }
  await repoUpdateAlbum(env.DB, id, update);
}

export async function deleteGalleryAlbumService(
  env: Env,
  id: string
): Promise<void> {
  const album = await getGalleryAlbumById(env.DB, id);
  if (!album) throw new AppError(404, ERROR_CODES.NOT_FOUND, "Album not found.");
  await repoDeleteAlbum(env.DB, id);
}
