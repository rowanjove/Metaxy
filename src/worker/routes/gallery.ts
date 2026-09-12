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
  listGalleryImagesList
} from "../services/gallery-service";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";

export const galleryRoutes = new Hono<WorkerContext>();

const MAX_GALLERY_BYTES = 10 * 1024 * 1024;

function hasAdminCookie(c: Context<WorkerContext>): boolean {
  return Boolean(getCookie(c, COOKIE_NAME) || getCookie(c, LEGACY_COOKIE_NAME));
}

async function isGalleryUploadAuthorized(c: Context<WorkerContext>, allowPublicUpload = false): Promise<boolean> {
  const uploadMode = c.env.UPLOAD_MODE === "public" ? "public" : "token";

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
    c.req.header("x-metaxy-upload-token")?.trim() ||
    c.req.header("x-pocketrelay-upload-token")?.trim();

  const tokenToTest = authHeader || customHeader;
  if (tokenToTest) {
    const session = await validateAdminSession(c.env, tokenToTest);
    if (session) return true;

    const configuredToken = c.env.UPLOAD_TOKEN?.trim();
    if (configuredToken) {
      const isValid = await timingSafeEqual(tokenToTest, configuredToken);
      if (isValid) return true;
    }
  }

  if (allowPublicUpload && uploadMode === "public") {
    return true;
  }

  return false;
}

async function isGalleryAdminAuthorized(c: Context<WorkerContext>): Promise<boolean> {
  const cookieToken = getCookie(c, COOKIE_NAME) || getCookie(c, LEGACY_COOKIE_NAME);
  const authHeader = c.req.header("authorization")?.replace(/^Bearer\s+/i, "")?.trim();
  const tokenToTest = cookieToken || authHeader;
  if (tokenToTest && await validateAdminSession(c.env, tokenToTest)) return true;

  const configuredToken = c.env.GALLERY_ADMIN_TOKEN?.trim();
  const galleryAdminHeader = c.req.header("x-gallery-admin-token")?.trim();
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

// Upload endpoint: Supports multipart/form-data and direct binary body
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
    // Support file under 'file', 'image', or the first file found
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
    // Direct binary body
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

// List gallery images
galleryRoutes.get("/gallery/images", async (c) => {
  const authorized = await isGalleryAdminAuthorized(c);
  if (!authorized) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required to view gallery images.");
  }

  const limitParam = c.req.query("limit");
  const cursorParam = c.req.query("cursor");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 30;
  if ((limitParam && !/^\d+$/.test(limitParam)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery page limit must be an integer between 1 and 100.");
  }
  if (cursorParam && cursorParam.length > 512) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Gallery cursor is invalid.");
  }
  const cursor = cursorParam || undefined;

  const originUrl = new URL(c.req.url).origin;
  const result = await listGalleryImagesList(c.env, originUrl, { limit, cursor });

  return c.json({
    success: true,
    data: result
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
