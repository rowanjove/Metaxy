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

  it("normalizes code by trimming, removing hyphens/spaces, and preserving case", () => {
    expect(normalizeCode("  ab7-k2q  ")).toBe("ab7k2q");
    expect(normalizeCode("ab7 k2q")).toBe("ab7k2q");
    expect(normalizeCode("AB7-K2-Q")).toBe("AB7K2Q");
    expect(normalizeCode("Ab7-k2-Q")).toBe("Ab7k2Q");
  });

  it("accepts digits and all English letters case-sensitively", () => {
    expect(normalizeCode("AB7-K2-0")).toBe("AB7K20");
    expect(normalizeCode("ab7-k2-1")).toBe("ab7k21");
    expect(normalizeCode("AB7-K2-I")).toBe("AB7K2I");
    expect(normalizeCode("ab7-k2-o")).toBe("ab7k2o");
  });

  it("rejects non-alphanumeric characters not in CODE_CHARSET", () => {
    expect(normalizeCode("AB7-K2-@")).toBeNull();
    expect(normalizeCode("AB7#K2")).toBeNull();
    expect(normalizeCode("AB7$K2")).toBeNull();
    expect(normalizeCode("AB7.K2")).toBeNull();
  });

  it("validates expected length when specified", () => {
    expect(normalizeCode("AB7K2Q", 6)).toBe("AB7K2Q");
    expect(normalizeCode("ab7k2q", 6)).toBe("ab7k2q");
    expect(normalizeCode("AB7K2Q", 7)).toBeNull();
    expect(normalizeCode("ABC", 6)).toBeNull();
  });

  it("supports custom code length between 4 and 32", () => {
    expect(normalizeCode("abcd")).toBe("abcd");
    expect(normalizeCode("a".repeat(32))).toBe("a".repeat(32));
    expect(normalizeCode("abc")).toBeNull(); // too short (< 4)
    expect(normalizeCode("a".repeat(33))).toBeNull(); // too long (> 32)
  });
});
