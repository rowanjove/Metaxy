import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { COOKIE_NAME, LEGACY_COOKIE_NAME } from "../../shared/constants";
import { validateAdminSession } from "../services/session-service";
import { timingSafeEqual } from "../lib/crypto";
import { adminCsrfMiddleware } from "../middleware/csrf";
import {
  uploadGalleryImage,
  deleteGalleryImageById,
  listGalleryImagesList,
  prepareGalleryUpload,
  completeGalleryUpload,
  batchProcessGalleryImages,
  toggleGalleryImageFavorite,
  setGalleryImageAlbumId,
  createGalleryAlbumService,
  listGalleryAlbumsService,
  updateGalleryAlbumService,
  deleteGalleryAlbumService,
  formatGalleryImageDto
} from "../services/gallery-service";
import { getGalleryImageById, isValidGalleryCursor } from "../repositories/gallery";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";
import { isRecord, parseJsonBody } from "../lib/body";
import type {
  GalleryPrepareUploadRequest,
  GalleryCompleteUploadRequest,
  GalleryBatchRequest
} from "../../shared/gallery-contracts";

export const galleryRoutes = new Hono<WorkerContext>();

const MAX_GALLERY_BYTES = 10 * 1024 * 1024;

function hasAdminCookie(c: Context<WorkerContext>): boolean {
  return Boolean(getCookie(c, COOKIE_NAME) || getCookie(c, LEGACY_COOKIE_NAME));
}

export async function isGalleryUploadAuthorized(c: Context<WorkerContext>, allowPublicUpload = true): Promise<boolean> {
  const galleryUploadMode = (c.env.GALLERY_UPLOAD_MODE || "private").trim().toLowerCase();

  // Check Admin cookie session
  const cookieToken =
    getCookie(c, COOKIE_NAME) ||
    getCookie(c, LEGACY_COOKIE_NAME);
  if (cookieToken) {
    const session = await validateAdminSession(c.env, cookieToken);
    if (session) return true;
  }

  // Check Bearer header or custom upload token header
  const authHeader = c.req.header("authorization")?.replace(/^Bearer\s+/i, "")?.trim();
  const customHeader =
    c.req.header("x-gallery-upload-token")?.trim() ||
    c.req.header("x-metaxy-gallery-upload-token")?.trim() ||
    c.req.header("x-metaxy-upload-token")?.trim() ||
    c.req.header("x-pocketrelay-upload-token")?.trim();

  const tokenToTest = authHeader || customHeader;
  if (tokenToTest) {
    const session = await validateAdminSession(c.env, tokenToTest);
    if (session) return true;

    const adminToken = c.env.GALLERY_ADMIN_TOKEN?.trim();
    if (adminToken && await timingSafeEqual(tokenToTest, adminToken)) {
      return true;
    }

    const galleryUploadToken = c.env.GALLERY_UPLOAD_TOKEN?.trim();
    if (galleryUploadToken && await timingSafeEqual(tokenToTest, galleryUploadToken)) {
      return true;
    }

    const configuredToken = c.env.UPLOAD_TOKEN?.trim();
    if (configuredToken && await timingSafeEqual(tokenToTest, configuredToken)) {
      return true;
    }
  }

  if (allowPublicUpload && galleryUploadMode === "public") {
    return true;
  }

  return false;
}

export async function isGalleryAdminAuthorized(c: Context<WorkerContext>): Promise<boolean> {
  const cookieToken = getCookie(c, COOKIE_NAME) || getCookie(c, LEGACY_COOKIE_NAME);
  const authHeader = c.req.header("authorization")?.replace(/^Bearer\s+/i, "")?.trim();
  const tokenToTest = cookieToken || authHeader;
  if (tokenToTest && await validateAdminSession(c.env, tokenToTest)) return true;

  const configuredToken = c.env.GALLERY_ADMIN_TOKEN?.trim();
  const galleryAdminHeader =
    c.req.header("x-gallery-admin-token")?.trim() ||
    c.req.header("x-metaxy-gallery-admin-token")?.trim();
  const candidate = galleryAdminHeader || authHeader;
  if (configuredToken && candidate) {
    return timingSafeEqual(candidate, configuredToken);
  }
  return false;
}

async function readBodyWithLimit(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Gallery request exceeds maximum allowed size.");
        throw new AppError(413, ERROR_CODES.FILE_TOO_LARGE, "Image exceeds maximum allowed size (10 MiB).");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}

async function enforceCookieCsrf(c: Context<WorkerContext>, next: () => Promise<void>): Promise<void> {
  if (hasAdminCookie(c)) {
    await adminCsrfMiddleware(c, next);
    return;
  }
  await next();
}

// ---------------- Presigned Direct Upload Endpoints ----------------

// POST /api/v1/gallery/uploads/prepare
galleryRoutes.post("/gallery/uploads/prepare", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const ip = getClientIp(c);
  await checkRateLimit(c.env.UPLOAD_RATE_LIMITER, `gallery_upload_${ip}`);

  const authorized = await isGalleryUploadAuthorized(c, true);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Upload token or authentication required.");
  }

  const json = await parseJsonBody<unknown>(c.req.raw, 16 * 1024);
  if (!isRecord(json) || typeof json.filename !== "string" || !json.filename.trim() ||
      typeof json.contentType !== "string" || !json.contentType.trim() || typeof json.size !== "number") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid upload prepare payload.");
  }

  const result = await prepareGalleryUpload(c.env, json as unknown as GalleryPrepareUploadRequest);
  return c.json({
    success: true,
    data: result
  }, 201);
});

// POST /api/v1/gallery/uploads/:uploadId/complete
galleryRoutes.post("/gallery/uploads/:uploadId/complete", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const ip = getClientIp(c);
  await checkRateLimit(c.env.UPLOAD_RATE_LIMITER, `gallery_upload_${ip}`);

  const authorized = await isGalleryUploadAuthorized(c, true);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Upload token or authentication required.");
  }

  const uploadId = c.req.param("uploadId");
  const json = await parseJsonBody<unknown>(c.req.raw, 32 * 1024);
  if (!isRecord(json)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid upload complete payload.");
  }
  const originUrl = new URL(c.req.url).origin;

  const result = await completeGalleryUpload(c.env, uploadId, json as unknown as GalleryCompleteUploadRequest, originUrl);
  return c.json({
    success: true,
    code: 200,
    data: result
  }, 201);
});

// ---------------- Legacy Upload (PicGo / Typora Compatibility) ----------------

galleryRoutes.post("/gallery/upload", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const ip = getClientIp(c);
  await checkRateLimit(c.env.UPLOAD_RATE_LIMITER, `gallery_upload_${ip}`);

  const authorized = await isGalleryUploadAuthorized(c, true);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Upload token or admin authentication required.");
  }

  const originUrl = new URL(c.req.url).origin;
  const contentType = c.req.header("content-type") || "";
  const contentLengthHeader = c.req.header("content-length");
  if (!contentLengthHeader || !/^\d+$/.test(contentLengthHeader)) {
    throw new AppError(411, ERROR_CODES.BAD_REQUEST, "Content-Length is required for Gallery uploads.");
  }
  const declaredLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_GALLERY_BYTES) {
    throw new AppError(413, ERROR_CODES.FILE_TOO_LARGE, "Image exceeds maximum allowed size (10 MiB).");
  }

  let fileData: ArrayBuffer;
  let filename = "";
  let fileContentType = "";

  if (contentType.includes("multipart/form-data")) {
    const body = await readBodyWithLimit(c.req.raw, MAX_GALLERY_BYTES);
    if (body.byteLength !== declaredLength) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Content-Length does not match the request body.");
    }
    const parserRequest = new Request(c.req.raw.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body
    });
    const formData = await parserRequest.formData();
    let fileObj: File | null = null;
    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        if (!fileObj || key === "file" || key === "image") {
          fileObj = value;
        }
        if (key === "file" || key === "image") break;
      }
    }

    if (!fileObj) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "No image file provided in multipart form.");
    }

    fileData = await fileObj.arrayBuffer();
    filename = fileObj.name;
    fileContentType = fileObj.type;
  } else {
    fileData = await readBodyWithLimit(c.req.raw, MAX_GALLERY_BYTES);
    if (fileData.byteLength !== declaredLength) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Content-Length does not match the request body.");
    }
    const encodedFilename =
      c.req.header("x-filename") ||
      c.req.header("x-metaxy-filename") ||
      c.req.header("x-pocketrelay-filename");

    if (encodedFilename) {
      try {
        filename = decodeURIComponent(encodedFilename);
      } catch {
        filename = encodedFilename;
      }
    }
    fileContentType = contentType;
  }

  const result = await uploadGalleryImage(c.env, {
    data: fileData,
    filename,
    contentType: fileContentType,
    originUrl
  });

  return c.json(
    {
      success: true,
      code: 200,
      data: result
    },
    201
  );
});

// ---------------- Image Query & Management Endpoints ----------------

// List gallery images
galleryRoutes.get("/gallery/images", async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required to view gallery images.");
  }

  const limitParam = c.req.query("limit");
  const cursorParam = c.req.query("cursor");
  const albumParam = c.req.query("album");
  const favoriteParam = c.req.query("favorite");
  const searchParam = c.req.query("search");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 30;
  if ((limitParam && !/^\d+$/.test(limitParam)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery page limit must be an integer between 1 and 100.");
  }
  if (cursorParam && cursorParam.length > 512) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery cursor is invalid.");
  }
  if (cursorParam && !isValidGalleryCursor(cursorParam)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery cursor is invalid.");
  }
  if (albumParam !== undefined && albumParam.length > 128) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery album filter is invalid.");
  }
  if (favoriteParam !== undefined && !["true", "false", "1", "0"].includes(favoriteParam)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery favorite filter is invalid.");
  }
  if (searchParam !== undefined && searchParam.length > 100) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery search query is too long.");
  }

  const originUrl = new URL(c.req.url).origin;
  const result = await listGalleryImagesList(c.env, originUrl, {
    limit,
    cursor: cursorParam || undefined,
    albumId: albumParam !== undefined ? albumParam : undefined,
    favorite: favoriteParam !== undefined ? favoriteParam === "true" || favoriteParam === "1" : undefined,
    search: searchParam || undefined
  });

  return c.json({
    success: true,
    data: result
  });
});

// Get single image detail
galleryRoutes.get("/gallery/images/:id", async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required to view image details.");
  }

  const id = c.req.param("id");
  const img = await getGalleryImageById(c.env.DB, id);
  if (!img || img.status === "deleting") {
    throw new AppError(404, ERROR_CODES.GALLERY_IMAGE_NOT_FOUND, "Image not found.");
  }

  const originUrl = new URL(c.req.url).origin;
  return c.json({
    success: true,
    data: formatGalleryImageDto(img, originUrl, c.env.PUBLIC_IMAGE_BASE_URL)
  });
});

// Delete image
galleryRoutes.delete("/gallery/images/:id", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required to delete gallery image.");
  }

  const id = c.req.param("id");
  const deleted = await deleteGalleryImageById(c.env, id);
  if (!deleted) {
    throw new AppError(404, ERROR_CODES.GALLERY_IMAGE_NOT_FOUND, "Image not found.");
  }

  return c.json({
    success: true,
    data: { id }
  });
});

// Batch operations
galleryRoutes.post("/gallery/images/batch", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required for batch operations.");
  }

  const json = await parseJsonBody<unknown>(c.req.raw, 32 * 1024);
  const operations = new Set<GalleryBatchRequest["operation"]>(["delete", "favorite", "unfavorite", "move_album"]);
  if (!isRecord(json) || !Array.isArray(json.ids) || json.ids.length === 0 || json.ids.length > 100 ||
      !json.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) ||
      typeof json.operation !== "string" || !operations.has(json.operation as GalleryBatchRequest["operation"]) ||
      (json.albumId !== undefined && json.albumId !== null && typeof json.albumId !== "string")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid batch request body.");
  }

  const result = await batchProcessGalleryImages(c.env, json as unknown as GalleryBatchRequest);
  return c.json({
    success: true,
    data: result
  });
});

// Toggle Favorite
galleryRoutes.patch("/gallery/images/:id/favorite", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required.");
  }

  const id = c.req.param("id");
  const body = await parseJsonBody<unknown>(c.req.raw, 8 * 1024);
  if (!isRecord(body) || typeof body.favorite !== "boolean") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Favorite state must be a boolean.");
  }

  const ok = await toggleGalleryImageFavorite(c.env, id, body.favorite);
  if (!ok) {
    throw new AppError(404, ERROR_CODES.GALLERY_IMAGE_NOT_FOUND, "Image not found.");
  }

  return c.json({ success: true, data: { id, favorite: body.favorite } });
});

// Update Album
galleryRoutes.patch("/gallery/images/:id/album", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required.");
  }

  const id = c.req.param("id");
  const body = await parseJsonBody<unknown>(c.req.raw, 8 * 1024);
  if (!isRecord(body) || !((body.albumId === null) || (typeof body.albumId === "string" && body.albumId.length <= 128))) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album ID must be a string or null.");
  }

  const ok = await setGalleryImageAlbumId(c.env, id, body.albumId);
  if (!ok) {
    throw new AppError(404, ERROR_CODES.GALLERY_IMAGE_NOT_FOUND, "Image not found.");
  }

  return c.json({ success: true, data: { id, albumId: body.albumId } });
});

// ---------------- Album Management Endpoints ----------------

// List albums
galleryRoutes.get("/gallery/albums", async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required to view albums.");
  }

  const originUrl = new URL(c.req.url).origin;
  const albums = await listGalleryAlbumsService(c.env, originUrl);
  return c.json({ success: true, data: albums });
});

// Create album
galleryRoutes.post("/gallery/albums", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required to create albums.");
  }

  const body = await parseJsonBody<unknown>(c.req.raw, 8 * 1024);
  if (!isRecord(body) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 128 ||
      (body.slug !== undefined && typeof body.slug !== "string")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Album name is required.");
  }

  const album = await createGalleryAlbumService(c.env, body.name, typeof body.slug === "string" ? body.slug : undefined);
  return c.json({ success: true, data: album }, 201);
});

// Update album
galleryRoutes.patch("/gallery/albums/:id", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required to update albums.");
  }

  const id = c.req.param("id");
  const body = await parseJsonBody<unknown>(c.req.raw, 8 * 1024);
  if (!isRecord(body) ||
      (body.name !== undefined && typeof body.name !== "string") ||
      (body.slug !== undefined && typeof body.slug !== "string") ||
      (body.coverImageId !== undefined && body.coverImageId !== null && typeof body.coverImageId !== "string")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid album update body.");
  }

  await updateGalleryAlbumService(c.env, id, body as { name?: string; slug?: string; coverImageId?: string | null });
  return c.json({ success: true, data: { id } });
});

// Delete album
galleryRoutes.delete("/gallery/albums/:id", async (c, next) => {
  await enforceCookieCsrf(c, next);
}, async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required to delete albums.");
  }

  const id = c.req.param("id");
  await deleteGalleryAlbumService(c.env, id);
  return c.json({ success: true, data: { id } });
});
