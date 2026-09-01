import { describe, it, expect, beforeEach } from "vitest";
import { createMockEnv } from "../fixtures/mock-env";
import { createShortcutDrop, getDropDetail } from "../../src/worker/services/drop-service";
import { app } from "../../src/worker/index";
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
});
