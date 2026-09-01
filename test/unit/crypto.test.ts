import { describe, it, expect } from "vitest";
import { generateRandomToken, sha256Hex, timingSafeEqual } from "../../src/worker/lib/crypto";

describe("Crypto utilities", () => {
  it("computes accurate SHA-256 hex hash", async () => {
    // Standard test vector: sha256("hello world")
    const hash = await sha256Hex("hello world");
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("performs constant-time string comparison", async () => {
    expect(await timingSafeEqual("secret123", "secret123")).toBe(true);
    expect(await timingSafeEqual("secret123", "secret124")).toBe(false);
    expect(await timingSafeEqual("short", "muchlongerstring")).toBe(false);
    expect(await timingSafeEqual("", "")).toBe(true);
  });

  it("generates random base64url tokens without standard base64 padding or slashes", () => {
    const token1 = generateRandomToken(32);
    const token2 = generateRandomToken(32);

    expect(token1).not.toBe(token2);
    expect(token1).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(token1).not.toContain("+");
    expect(token1).not.toContain("/");
    expect(token1).not.toContain("=");
  });
});
