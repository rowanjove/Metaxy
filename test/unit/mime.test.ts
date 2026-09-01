import { describe, it, expect } from "vitest";
import { isDangerousFile, isInlinePreviewableImage } from "../../src/worker/lib/mime";

describe("MIME and file security policies", () => {
  it("identifies dangerous executables and script extensions", () => {
    expect(isDangerousFile("payload.exe")).toBe(true);
    expect(isDangerousFile("script.sh")).toBe(true);
    expect(isDangerousFile("script.bat")).toBe(true);
    expect(isDangerousFile("script.bat.")).toBe(true);
    expect(isDangerousFile("script.ps1")).toBe(true);
    expect(isDangerousFile("installer.msi")).toBe(true);
    expect(isDangerousFile("app.apk")).toBe(true);
  });

  it("identifies dangerous double extensions", () => {
    expect(isDangerousFile("photo.jpg.exe")).toBe(true);
    expect(isDangerousFile("document.pdf.bat")).toBe(true);
  });

  it("identifies dangerous MIME types regardless of extension", () => {
    expect(isDangerousFile("harmless.txt", "application/x-msdownload")).toBe(true);
    expect(isDangerousFile("harmless.txt", "application/x-sh")).toBe(true);
  });

  it("permits safe document and media extensions", () => {
    expect(isDangerousFile("document.pdf")).toBe(false);
    expect(isDangerousFile("photo.png", "image/png")).toBe(false);
    expect(isDangerousFile("archive.zip", "application/zip")).toBe(false);
    expect(isDangerousFile("notes.txt", "text/plain")).toBe(false);
  });

  it("checks inline previewable images (only JPEG, PNG, GIF, WebP, AVIF)", () => {
    expect(isInlinePreviewableImage("image/jpeg")).toBe(true);
    expect(isInlinePreviewableImage("image/png")).toBe(true);
    expect(isInlinePreviewableImage("image/gif")).toBe(true);
    expect(isInlinePreviewableImage("image/webp")).toBe(true);
    expect(isInlinePreviewableImage("image/avif")).toBe(true);

    // SVG, HTML, PDF are NEVER inline
    expect(isInlinePreviewableImage("image/svg+xml")).toBe(false);
    expect(isInlinePreviewableImage("text/html")).toBe(false);
    expect(isInlinePreviewableImage("application/pdf")).toBe(false);
  });
});
