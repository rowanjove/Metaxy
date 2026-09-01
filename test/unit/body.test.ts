import { describe, expect, it } from "vitest";
import {
  readTextBodyLimited,
  parseJsonBody,
  parseOptionalJsonBody
} from "../../src/worker/lib/body";
import { AppError } from "../../src/worker/errors";

describe("request body limits", () => {
  it("reads a UTF-8 body up to the configured byte limit", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "你好"
    });

    await expect(readTextBodyLimited(request, 6)).resolves.toBe("你好");
  });

  it("rejects an oversized body from its declared content length", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-length": "7" },
      body: "你好"
    });

    await expect(readTextBodyLimited(request, 6)).rejects.toMatchObject({
      status: 413,
      code: "TEXT_TOO_LARGE"
    });
  });

  it("bounds JSON parsing and reports malformed payloads as client errors", async () => {
    const malformed = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    await expect(parseJsonBody(malformed)).rejects.toBeInstanceOf(AppError);

    const oversized = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "12345" })
    });
    await expect(parseJsonBody(oversized, 10)).rejects.toMatchObject({ status: 413 });
  });

  it("allows an empty optional JSON body", async () => {
    const request = new Request("http://localhost", { method: "POST" });
    await expect(parseOptionalJsonBody(request)).resolves.toBeUndefined();
  });
});
