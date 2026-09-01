import { describe, it, expect } from "vitest";
import { getUtf8ByteLength, isValidExpirySeconds } from "../../src/worker/lib/validation";

describe("Validation helpers", () => {
  it("calculates exact UTF-8 byte length for ASCII, Chinese and Emojis", () => {
    expect(getUtf8ByteLength("hello")).toBe(5);
    expect(getUtf8ByteLength("你好")).toBe(6); // 3 bytes per CJK char
    expect(getUtf8ByteLength("🚀")).toBe(4); // 4 bytes for emoji
    expect(getUtf8ByteLength("")).toBe(0);
  });

  it("validates expiry ranges", () => {
    expect(isValidExpirySeconds(86400, 604800)).toBe(true);
    expect(isValidExpirySeconds(600, 604800)).toBe(true);
    expect(isValidExpirySeconds(0, 604800)).toBe(false);
    expect(isValidExpirySeconds(-100, 604800)).toBe(false);
    expect(isValidExpirySeconds(700000, 604800)).toBe(false);
    expect(isValidExpirySeconds("86400" as any, 604800)).toBe(false);
  });
});
