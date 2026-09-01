import { DEFAULT_LIMITS } from "../../shared/constants";

/**
 * Sanitize filename:
 * - Remove control characters, null bytes, CR, LF
 * - Trim whitespace
 * - Limit Unicode code points to 255
 * - Fallback to "file" if empty
 */
export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== "string") {
    return "file";
  }

  // Remove control characters, null, CR, LF
  // eslint-disable-next-line no-control-regex
  let cleaned = raw.replace(/[\x00-\x1F\x7F\r\n]/g, "").trim();

  // Replace unpaired UTF-16 surrogate code units before RFC 5987 encoding.
  // encodeURIComponent throws URIError for those values.
  cleaned = Array.from(cleaned, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0xD800 && codePoint <= 0xDFFF ? "\uFFFD" : character;
  }).join("");

  // Strip path traversal indicators
  cleaned = cleaned.replace(/^.*[\\/]/, "");

  if (!cleaned) {
    return "file";
  }

  // Limit code points to MAX_FILENAME_LENGTH
  const codePoints = Array.from(cleaned);
  if (codePoints.length > DEFAULT_LIMITS.MAX_FILENAME_LENGTH) {
    cleaned = codePoints.slice(0, DEFAULT_LIMITS.MAX_FILENAME_LENGTH).join("");
  }

  return cleaned || "file";
}

/**
 * Encode Content-Disposition header conforming to RFC 5987 and RFC 6266
 * Prevents HTTP Header Injection (CRLF, quotes)
 */
export function buildContentDisposition(
  filename: string,
  disposition: "inline" | "attachment" = "attachment"
): string {
  const safeFilename = sanitizeFilename(filename);

  // ASCII fallback: replace non-ASCII and double quotes with underscores
  const asciiFallback = safeFilename
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .trim() || "file";

  // RFC 5987 percent-encoding for UTF-8
  const utf8Encoded = encodeURIComponent(safeFilename).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}
