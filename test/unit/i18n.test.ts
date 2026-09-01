import { describe, it, expect } from "vitest";
import { zhCN } from "../../src/client/i18n/zh-CN";
import { en } from "../../src/client/i18n/en";
import { t, setLocale, getLocale, formatBytes, formatRemainingTime } from "../../src/client/i18n/index";

describe("i18n bilingual completeness and formatting", () => {
  it("ensures all zh-CN keys exist in en dictionary", () => {
    function verifyKeys(zhObj: any, enObj: any, path = "") {
      for (const key of Object.keys(zhObj)) {
        const currentPath = path ? `${path}.${key}` : key;
        expect(enObj, `Missing key in en.ts: ${currentPath}`).toHaveProperty(key);
        if (typeof zhObj[key] === "object" && zhObj[key] !== null) {
          verifyKeys(zhObj[key], enObj[key], currentPath);
        }
      }
    }
    verifyKeys(zhCN, en);
  });

  it("translates text with parameters", () => {
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh-CN");
    expect(t("home.filesCount", { count: 3, size: "1.2 MiB" })).toBe("3 个文件 (共 1.2 MiB)");

    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("home.filesCount", { count: 3, size: "1.2 MiB" })).toBe("3 files (1.2 MiB total)");
  });

  it("formats binary bytes properly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1048576)).toBe("1.00 MiB");
    expect(formatBytes(52428800)).toBe("50.00 MiB");
  });

  it("formats remaining countdown seconds", () => {
    expect(formatRemainingTime(45)).toBe("45s");
    expect(formatRemainingTime(125)).toBe("2m 5s");
    expect(formatRemainingTime(3600)).toBe("1h");
    expect(formatRemainingTime(3665)).toBe("1h 1m");
    expect(formatRemainingTime(86400)).toBe("1d");
    expect(formatRemainingTime(90000)).toBe("1d 1h");
  });
});
