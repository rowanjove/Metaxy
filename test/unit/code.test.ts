import { describe, it, expect } from "vitest";
import { generateCode, normalizeCode } from "../../src/worker/lib/code";
import { CODE_CHARSET } from "../../src/shared/constants";

describe("Code generation and normalization", () => {
  it("generates code of default length 6", () => {
    const code = generateCode();
    expect(code).toHaveLength(6);
    for (const char of code) {
      expect(CODE_CHARSET).toContain(char);
    }
  });

  it("generates code with specified length between 5 and 8", () => {
    const code5 = generateCode(5);
    const code8 = generateCode(8);
    const codeClampedLow = generateCode(2);
    const codeClampedHigh = generateCode(20);

    expect(code5).toHaveLength(5);
    expect(code8).toHaveLength(8);
    expect(codeClampedLow).toHaveLength(5);
    expect(codeClampedHigh).toHaveLength(8);
  });

  it("normalizes code by trimming, uppercasing, and removing hyphens/spaces", () => {
    expect(normalizeCode("  ab7-k2q  ")).toBe("AB7K2Q");
    expect(normalizeCode("ab7 k2q")).toBe("AB7K2Q");
    expect(normalizeCode("AB7-K2-Q")).toBe("AB7K2Q");
  });

  it("rejects invalid characters not in CODE_CHARSET", () => {
    expect(normalizeCode("AB7-K2-0")).toBeNull(); // '0' is not in charset
    expect(normalizeCode("AB7-K2-1")).toBeNull(); // '1' is not in charset
    expect(normalizeCode("AB7-K2-I")).toBeNull(); // 'I' is not in charset
    expect(normalizeCode("AB7-K2-O")).toBeNull(); // 'O' is not in charset
  });

  it("validates expected length when specified", () => {
    expect(normalizeCode("AB7K2Q", 6)).toBe("AB7K2Q");
    expect(normalizeCode("AB7K2Q", 7)).toBeNull();
    expect(normalizeCode("ABC", 6)).toBeNull();
  });
});
