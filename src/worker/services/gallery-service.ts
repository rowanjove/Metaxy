import type { Env } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import type { GalleryImageDto, GalleryListResponse } from "../../shared/gallery-contracts";
import {
  getGalleryImageByHash,
  getGalleryImageById,
  insertGalleryImage,
  listGalleryImages,
  markGalleryImageDeleting,
  recordGalleryObjectDeletion,
  finalizeGalleryImageDeletion,
  type GalleryImageRow
} from "../repositories/gallery";
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

export function formatGalleryImageDto(image: GalleryImageRow, originUrl: string): GalleryImageDto {
  const ext = getPreferredExtension(image.filename, image.content_type);
  const formattedUrl = `${originUrl}/i/${image.id}.${ext}`;
  const rawUrl = `${originUrl}/i/${image.id}`;
  const safeFilename = sanitizeFilename(image.filename);
  const markdownAlt = escapeMarkdownAltText(safeFilename);
  const htmlFilename = escapeHtml(safeFilename);
  const htmlUrl = escapeHtml(formattedUrl);

  return {
    id: image.id,
    url: formattedUrl,
    rawUrl,
    markdown: `![${markdownAlt}](${formattedUrl})`,
    html: `<img src="${htmlUrl}" alt="${htmlFilename}" />`,
    bbcode: `[img]${formattedUrl}[/img]`,
    filename: image.filename,
    contentType: image.content_type,
    sizeBytes: image.size_bytes,
    width: image.width,
    height: image.height,
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

function hasImageSignature(data: ArrayBuffer, contentType: string): boolean {
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

export async function uploadGalleryImage(
  env: Env,
  params: {
    data: ArrayBuffer;
    filename?: string;
    contentType?: string;
    originUrl: string;
    width?: number;
    height?: number;
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

  // Try to infer content-type from filename if missing or generic octet-stream
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

  // Calculate SHA-256 hash for deduplication
  const hash = await bufferSha256Hex(params.data);
  const existing = await getGalleryImageByHash(env.DB, hash);
  if (existing) {
    return formatGalleryImageDto(existing, params.originUrl);
  }

  const ext = getPreferredExtension(filename, contentType);
  let id = generateShortSlug(8);

  // Check collision for id
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

  // Store Gallery objects in the dedicated permanent bucket. Drop's FILES
  // bucket may have an eight-day lifecycle rule and must never hold Gallery data.
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
    width: params.width ?? null,
    height: params.height ?? null,
    hash,
    created_at: Date.now(),
    view_count: 0,
    last_viewed_at: null
  };

  try {
    await insertGalleryImage(env.DB, row);
  } catch (error) {
    // D1 can fail after R2 succeeds. Persist a durable deletion intent so the
    // scheduled Gallery cleanup can remove this otherwise orphaned object.
    try {
      await recordGalleryObjectDeletion(env.DB, objectKey, null, Date.now());
    } catch (queueError) {
      console.error(JSON.stringify({ event: "gallery_upload_cleanup_queue_failed", objectKey, error: String(queueError) }));
      // If D1 is unavailable, make a best-effort immediate R2 deletion. The
      // request still fails, but this closes the common orphan window rather
      // than leaving an object that no durable queue can reference.
      try {
        await env.GALLERY.delete(objectKey);
      } catch (deleteError) {
        console.error(JSON.stringify({ event: "gallery_upload_orphan_delete_failed", objectKey, error: String(deleteError) }));
      }
    }
    throw error;
  }
  return formatGalleryImageDto(row, params.originUrl);
}

export async function deleteGalleryImageById(env: Env, id: string): Promise<boolean> {
  if (!env.GALLERY) {
    throw new AppError(503, ERROR_CODES.SERVICE_UNAVAILABLE, "Gallery storage is not configured on this server.");
  }
  const image = await markGalleryImageDeleting(env.DB, id, Date.now());
  if (!image) return false;

  try {
    await env.GALLERY.delete(image.object_key);
    await finalizeGalleryImageDeletion(env.DB, image.id, image.object_key);
  } catch (err) {
    console.error(JSON.stringify({ event: "gallery_delete_deferred", imageId: image.id, objectKey: image.object_key, error: String(err) }));
    throw new AppError(503, ERROR_CODES.GALLERY_DELETE_FAILED, "Image deletion was queued for retry.", err);
  }
  return true;
}

export async function listGalleryImagesList(
  env: Env,
  originUrl: string,
  options: { limit?: number; cursor?: string }
): Promise<GalleryListResponse> {
  const result = await listGalleryImages(env.DB, options);
  return {
    items: result.items.map((item) => formatGalleryImageDto(item, originUrl)),
    total: result.total,
    nextCursor: result.nextCursor ? String(result.nextCursor) : null
  };
}
