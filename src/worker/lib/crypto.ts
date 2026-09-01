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
