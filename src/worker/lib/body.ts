import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";

/** Read a request body without buffering more than the configured byte limit. */
export async function readTextBodyLimited(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid Content-Length header.");
    }
    if (parsed > maxBytes) {
      throw new AppError(413, ERROR_CODES.TEXT_TOO_LARGE, "Text body exceeds the configured limit.");
    }
  }

  if (!request.body) {
    return "";
  }

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
        throw new AppError(413, ERROR_CODES.TEXT_TOO_LARGE, "Text body exceeds the configured limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original read/limit error if cancellation also fails.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function parseJsonBody<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const text = await readTextBodyLimited(request, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Request body must be valid JSON.", cause);
  }
}

/** Parse an optional JSON body while retaining the same bounded read. */
export async function parseOptionalJsonBody<T>(
  request: Request,
  maxBytes = 64 * 1024
): Promise<T | undefined> {
  const text = await readTextBodyLimited(request, maxBytes);
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Request body must be valid JSON.", cause);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
