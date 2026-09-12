/**
 * Compute SHA-256 hash formatted as hex string
 */
export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two strings in constant time using SHA-256 digests
 */
export async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);

  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);

  let diff = leftBytes.length ^ rightBytes.length;
  for (let i = 0; i < leftBytes.length; i++) {
    diff |= leftBytes[i] ^ rightBytes[i];
  }

  return diff === 0;
}

/**
 * Generate a cryptographically secure random token (URL-safe base64url string)
 */
export function generateRandomToken(bytesCount: number = 32): string {
  const randomBytes = new Uint8Array(bytesCount);
  crypto.getRandomValues(randomBytes);
  return bytesToBase64Url(randomBytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Compute SHA-256 hash for binary ArrayBuffer
 */
export async function bufferSha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a short, URL-safe alphanumeric slug
 */
export function generateShortSlug(length: number = 8): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const maxValidByte = 256 - (256 % chars.length); // 252: largest multiple of 36 < 256
  let result = "";
  while (result.length < length) {
    const buffer = new Uint8Array((length - result.length) * 2);
    crypto.getRandomValues(buffer);
    for (let i = 0; i < buffer.length && result.length < length; i++) {
      if (buffer[i] < maxValidByte) {
        result += chars[buffer[i] % chars.length];
      }
    }
  }
  return result;
}
