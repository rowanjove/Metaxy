import {
  DANGEROUS_EXTENSIONS,
  DANGEROUS_MIME_TYPES,
  INLINE_IMAGE_MIME_TYPES
} from "../../shared/constants";

/**
 * Extract lowercased file extensions.
 * Returns array of extensions (e.g. "photo.jpg.exe" -> ["jpg", "exe"])
 */
export function extractExtensions(filename: string): string[] {
  // Windows treats trailing dots/spaces as insignificant, so normalize them
  // before checking the final extension (e.g. `payload.bat.`).
  const normalized = filename.toLowerCase().trim().replace(/[.\s]+$/g, "");
  const parts = normalized.split(".");
  if (parts.length <= 1) {
    return [];
  }
  return parts.slice(1).map((p) => p.trim());
}

/**
 * Check whether a file is classified as dangerous (executables, scripts, etc.)
 * in Public Upload mode.
 */
export function isDangerousFile(filename: string, contentType?: string): boolean {
  const extensions = extractExtensions(filename);

  // Check last extension
  if (extensions.length > 0) {
    const lastExt = extensions[extensions.length - 1];
    if (DANGEROUS_EXTENSIONS.has(lastExt)) {
      return true;
    }
  }

  // Check MIME type
  if (contentType) {
    const cleanMime = contentType.toLowerCase().split(";")[0].trim();
    if (DANGEROUS_MIME_TYPES.has(cleanMime)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the Content-Type is safe for inline image preview in the browser.
 * Only JPEG, PNG, GIF, WebP, AVIF are allowed.
 * SVG, HTML, PDF, etc., must be downloaded as attachment to prevent XSS.
 */
export function isInlinePreviewableImage(contentType: string): boolean {
  const cleanMime = (contentType || "").toLowerCase().split(";")[0].trim();
  return INLINE_IMAGE_MIME_TYPES.has(cleanMime);
}
