import { CODE_CHARSET, DEFAULT_LIMITS } from "../../shared/constants";

/**
 * Generate a random retrieval code using crypto.getRandomValues
 */
export function generateCode(length: number = DEFAULT_LIMITS.DEFAULT_CODE_LENGTH): string {
  const targetLength = Math.max(
    DEFAULT_LIMITS.CODE_MIN_LENGTH,
    Math.min(DEFAULT_LIMITS.CODE_MAX_LENGTH, length)
  );

  const charsetLength = CODE_CHARSET.length;
  const randomBytes = new Uint8Array(targetLength);
  crypto.getRandomValues(randomBytes);

  let result = "";
  for (let i = 0; i < targetLength; i++) {
    result += CODE_CHARSET[randomBytes[i] % charsetLength];
  }
  return result;
}

/**
 * Normalize user input code:
 * 1. Unicode trim
 * 2. Convert to uppercase
 * 3. Remove ASCII spaces and hyphens
 * 4. Verify all characters belong to the charset
 * 5. Verify length if expectedLength is provided
 */
export function normalizeCode(raw: unknown, expectedLength?: number): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");

  if (!cleaned) {
    return null;
  }

  // Verify length if specified
  if (expectedLength !== undefined && cleaned.length !== expectedLength) {
    return null;
  }

  if (
    cleaned.length < DEFAULT_LIMITS.CODE_MIN_LENGTH ||
    cleaned.length > DEFAULT_LIMITS.CODE_MAX_LENGTH
  ) {
    return null;
  }

  // Verify all characters are in CODE_CHARSET
  for (let i = 0; i < cleaned.length; i++) {
    if (!CODE_CHARSET.includes(cleaned[i])) {
      return null;
    }
  }

  return cleaned;
}
