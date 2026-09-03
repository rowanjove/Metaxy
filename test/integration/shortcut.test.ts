import { describe, it, expect, beforeEach } from "vitest";
import { createMockEnv } from "../fixtures/mock-env";
import { createShortcutDrop, getDropDetail } from "../../src/worker/services/drop-service";
import { app } from "../../src/worker/index";
import { findExpiredDrafts } from "../../src/worker/repositories/drops";
import type { Env } from "../../src/worker/env";

describe("iOS Shortcut push service", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("creates and auto-commits text drop from shortcut", async () => {
    const result = await createShortcutDrop(
      env,
      "https://developers.cloudflare.com",
      86400,
      "https://drop.example.com"
    );

    expect(result.code).toBeDefined();
    expect(result.url).toBe(`https://drop.example.com/d/${result.code}`);

    const detail = await getDropDetail(env, result.code);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].type).toBe("text");
    if (detail.items[0].type === "text") {
      expect(detail.items[0].content).toBe("https://developers.cloudflare.com");
    }
  });

  it("rejects empty shortcut content", async () => {
    await expect(
      createShortcutDrop(env, "   ", 86400, "https://drop.example.com")
    ).rejects.toThrow("Content cannot be empty.");
  });

  it("accepts JSON shortcut content above the old 64 KiB parser limit", async () => {
    const response = await app.fetch(new Request("https://example.com/api/shortcut/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ content: "a".repeat(70 * 1024) })
    }), env, {} as any);

    expect(response.status).toBe(201);
    const payload = await response.json<any>();
    expect(payload.code).toBeDefined();
  });

  it("streams an image file into a committed drop", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const response = await app.fetch(new Request("https://example.com/api/shortcut/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
        "content-type": "image/png",
        "x-metaxy-filename": encodeURIComponent("截图.png"),
        "x-metaxy-file-size": String(bytes.byteLength),
        "x-metaxy-expires-in-seconds": "86400"
      },
      body: bytes
    }), env, {} as any);

    expect(response.status).toBe(201);
    const payload = await response.json<any>();
    const detail = await getDropDetail(env, payload.code);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({
      type: "file",
      file: {
        filename: "截图.png",
        contentType: "image/png",
        size: bytes.byteLength,
        previewable: true
      }
    });
  });

  it("requires a trustworthy file size before accepting a shortcut file", async () => {
    const response = await app.fetch(new Request("https://example.com/api/shortcut/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
        "content-type": "application/octet-stream",
        "x-metaxy-filename": "report.bin"
      },
      body: new Uint8Array([1, 2, 3])
    }), env, {} as any);

    expect(response.status).toBe(411);
  });

  it("rejects a shortcut file whose body exceeds the declared size", async () => {
    const response = await app.fetch(new Request("https://example.com/api/shortcut/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
        "content-type": "application/octet-stream",
        "x-metaxy-filename": "report.bin",
        "x-metaxy-file-size": "2"
      },
      body: new Uint8Array([1, 2, 3])
    }), env, {} as any);

    expect(response.status).toBe(409);
  });

  it("rejects a shortcut file whose body is shorter than the declared size", async () => {
    const response = await app.fetch(new Request("https://example.com/api/shortcut/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
        "content-type": "application/octet-stream",
        "x-metaxy-filename": "report.bin",
        "x-metaxy-file-size": "4"
      },
      body: new Uint8Array([1, 2, 3])
    }), env, {} as any);

    expect(response.status).toBe(409);
  });

  it("fails closed when shortcut rate limiting is unavailable", async () => {
    const unavailable = createMockEnv({ UPLOAD_RATE_LIMITER: undefined });
    const response = await app.fetch(new Request("https://example.com/api/shortcut/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${unavailable.SHORTCUT_TOKEN}`,
        "content-type": "text/plain"
      },
      body: "rate limited"
    }), unavailable, {} as any);
    expect(response.status).toBe(503);
  });

  it("rate-limits invalid shortcut tokens before authentication", async () => {
    const keys: string[] = [];
    const limitedEnv = createMockEnv({
      UPLOAD_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        }
      } as RateLimit
    });
    const response = await app.fetch(new Request("https://example.com/api/shortcut/push", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "text/plain"
      },
      body: "attempt"
    }), limitedEnv, {} as ExecutionContext);

    expect(response.status).toBe(429);
    expect(keys).toEqual(["shortcut_auth_local"]);
  });

  it("queues a failed file preparation draft for prompt cleanup", async () => {
    const response = await app.fetch(new Request("https://example.com/api/shortcut/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
        "content-type": "application/octet-stream",
        "x-metaxy-filename": "too-large.bin",
        "x-metaxy-file-size": String(50 * 1024 * 1024 + 1)
      },
      body: new Uint8Array([1])
    }), env, {} as ExecutionContext);

    expect(response.status).toBe(413);
    expect(await findExpiredDrafts(env.DB, Date.now() + 1_000)).toHaveLength(0);
  });
});
