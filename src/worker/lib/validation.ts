import { DEFAULT_LIMITS } from "../../shared/constants";

const textEncoder = new TextEncoder();

/**
 * Calculate the exact UTF-8 byte length of a string
 */
export function getUtf8ByteLength(text: string): number {
  if (!text) return 0;
  return textEncoder.encode(text).length;
}

/**
 * Validate that an expiry time in seconds is within acceptable range
 */
export function isValidExpirySeconds(
  seconds: unknown,
  maxSeconds: number = DEFAULT_LIMITS.MAX_EXPIRY_SECONDS
): seconds is number {
  if (typeof seconds !== "number" || !Number.isInteger(seconds)) {
    return false;
  }
  return seconds > 0 && seconds <= maxSeconds;
}
