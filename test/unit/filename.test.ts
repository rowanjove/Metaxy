import { describe, it, expect } from "vitest";
import { sanitizeFilename, buildContentDisposition } from "../../src/worker/lib/filename";

describe("Filename sanitation and Content-Disposition header builder", () => {
  it("sanitizes filename by stripping null bytes, CR, LF, and control chars", () => {
    const dangerous = "document\r\n\x00\x1F.pdf";
    expect(sanitizeFilename(dangerous)).toBe("document.pdf");
  });

  it("strips path traversal patterns", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\Windows\\System32\\cmd.exe")).toBe("cmd.exe");
  });

  it("limits length to 255 code points", () => {
    const longName = "a".repeat(300) + ".txt";
    const cleaned = sanitizeFilename(longName);
    expect(cleaned.length).toBe(255);
  });

  it("builds RFC 5987 / RFC 6266 Content-Disposition header with ASCII fallback and UTF-8 encoding", () => {
    const header = buildContentDisposition("中文 报告 (2026).pdf", "attachment");
    expect(header).toContain('attachment; filename="__ __ (2026).pdf";');
    expect(header).toContain("filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%8A%A5%E5%91%8A%20%282026%29.pdf");
  });

  it("prevents CRLF injection in Content-Disposition header", () => {
    const injection = "test\r\nSet-Cookie: evil=1\r\n.pdf";
    const header = buildContentDisposition(injection, "attachment");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
  });

  it("replaces unpaired UTF-16 surrogates instead of throwing during encoding", () => {
    const header = buildContentDisposition("bad-\uD800.txt", "attachment");
    expect(header).toContain("bad-%EF%BF%BD.txt");
  });
});
