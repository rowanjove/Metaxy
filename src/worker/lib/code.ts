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
 * 2. Remove ASCII spaces and hyphens
 * 3. Preserve case (case-sensitive)
 * 4. Verify length (4 to 32 characters or expectedLength)
 * 5. Verify all characters are in CODE_CHARSET (alphanumeric)
 */
export function normalizeCode(raw: unknown, expectedLength?: number): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const cleaned = raw
    .trim()
    .replace(/[\s-]+/g, "");

  if (!cleaned) {
    return null;
  }

  // Verify length if specified
  if (expectedLength !== undefined && cleaned.length !== expectedLength) {
    return null;
  }

  // Support 4 to 32 characters
  if (cleaned.length < 4 || cleaned.length > 32) {
    return null;
  }

  // Verify all characters are alphanumeric (in CODE_CHARSET)
  for (let i = 0; i < cleaned.length; i++) {
    if (!CODE_CHARSET.includes(cleaned[i])) {
      return null;
    }
  }

  return cleaned;
}
