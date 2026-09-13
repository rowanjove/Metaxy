import { Hono } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { getGalleryImageById, incrementGalleryImageView } from "../repositories/gallery";
import { isInlinePreviewableImage } from "../lib/mime";
import { buildContentDisposition } from "../lib/filename";

export const publicImageRoutes = new Hono<WorkerContext>();

publicImageRoutes.on(["GET", "HEAD"], "/i/:param{.+}", async (c) => {
  const rawParam = c.req.param("param") || "";
  const isThumb = rawParam.includes(".thumb");
  // Extract id from the last path segment: e.g. "a1b2c3d4.webp", "2026/09/a1b2c3d4.webp" or "a1b2c3d4.thumb.webp" -> "a1b2c3d4"
  const lastSegment = rawParam.split("/").filter(Boolean).pop() || "";
  const id = lastSegment.split(".")[0].trim();

  if (!id) {
    throw new AppError(404, ERROR_CODES.GALLERY_IMAGE_NOT_FOUND, "Image not found.");
  }

  // Check Referer hotlink protection if configured
  const referer = c.req.header("referer");
  const allowedReferers = c.env.GALLERY_ALLOWED_REFERERS?.trim();
  if (allowedReferers && referer) {
    let refererHost: string;
    try {
      const parsedReferer = new URL(referer);
      if (!/^https?:$/.test(parsedReferer.protocol) || !parsedReferer.hostname) {
        throw new Error("Unsupported referer URL");
      }
      refererHost = parsedReferer.hostname.toLowerCase();
      const allowedList = allowedReferers.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (allowedList.length === 0) {
        throw new Error("No valid allowed referers configured");
      }
      const currentHost = new URL(c.req.url).hostname.toLowerCase();
      const isAllowed = refererHost === currentHost || allowedList.some(
        (allowed) => refererHost === allowed || refererHost.endsWith(`.${allowed}`)
      );
      if (!isAllowed) {
        throw new AppError(403, ERROR_CODES.FORBIDDEN, "Hotlinking forbidden from this referer.");
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "Invalid referer header.");
    }
  }

  const image = await getGalleryImageById(c.env.DB, id);
  if (!image || image.status === "deleting") {
    throw new AppError(404, ERROR_CODES.GALLERY_IMAGE_NOT_FOUND, "Image not found.");
  }

  if (!c.env.GALLERY) {
    throw new AppError(503, ERROR_CODES.SERVICE_UNAVAILABLE, "Gallery storage is not configured on this server.");
  }

  const targetObjectKey = (isThumb && image.thumb_object_key) ? image.thumb_object_key : image.object_key;
  const object = await c.env.GALLERY.get(targetObjectKey);
  if (!object) {
    throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "Image object missing in storage.");
  }

  const clientEtag = c.req.header("if-none-match");
  // Check cache match (304 Not Modified)
  if (clientEtag && object.httpEtag && (clientEtag === object.httpEtag || clientEtag === `"${object.httpEtag}"`)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: object.httpEtag,
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    });
  }

  // Async update view count only on full GET requests
  if (c.req.method === "GET" && !isThumb && c.executionCtx) {
    c.executionCtx.waitUntil(incrementGalleryImageView(c.env.DB, image.id, Date.now()));
  }

  const isInline = isInlinePreviewableImage(image.content_type);
  const contentDisposition = buildContentDisposition(image.filename, isInline ? "inline" : "attachment");

  const headers = new Headers();
  object.writeHttpMetadata(headers);

  const contentType = (isThumb && image.thumb_object_key) ? "image/webp" : (image.content_type || "image/jpeg");
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", contentDisposition);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Access-Control-Allow-Origin", "*");

  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
  }

  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, {
    status: 200,
    headers
  });
});
