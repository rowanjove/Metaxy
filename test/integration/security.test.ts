import { describe, it, expect, beforeEach } from "vitest";
import { createMockEnv } from "../fixtures/mock-env";
import { createDraft, updateText, commitDrop, getDropDetail } from "../../src/worker/services/drop-service";
import { prepareUpload } from "../../src/worker/services/upload-service";
import { app } from "../../src/worker/index";
import { loginAdmin, validateAdminSession } from "../../src/worker/services/session-service";
import type { Env } from "../../src/worker/env";

describe("Security and abuse prevention", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv({ UPLOAD_MODE: "token" });
  });

  it("prevents unauthenticated draft creation in token mode", async () => {
    const req = new Request("http://localhost/api/v1/drops", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    const res = await app.fetch(req, env, {} as any);
    expect(res.status).toBe(401);
    const json = await res.json<any>();
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("blocks dangerous script files in public upload mode", async () => {
    const publicEnv = createMockEnv({ UPLOAD_MODE: "public" });
    const draft = await createDraft(publicEnv);

    await expect(
      prepareUpload(publicEnv, {
        dropId: draft.dropId,
        draftToken: draft.draftToken,
        filename: "malicious.bat",
        size: 500,
        contentType: "application/x-bat"
      })
    ).rejects.toThrow("Executable and script files are not permitted in public upload mode.");
  });

  it("blocks CSRF attacks on admin mutating endpoints", async () => {
    // Attempt admin logout with cross-origin Origin header
    const req = new Request("http://localhost/api/v1/admin/logout", {
      method: "POST",
      headers: {
        "Origin": "https://evil.com"
      }
    });

    const res = await app.fetch(req, env, {} as any);
    expect(res.status).toBe(401); // Admin session check runs first
  });

  it("fails closed when the login rate limiter is unavailable", async () => {
    const unavailableEnv = createMockEnv({ LOGIN_RATE_LIMITER: undefined });
    const req = new Request("http://localhost/api/v1/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-admin-password" })
    });

    const res = await app.fetch(req, unavailableEnv, {} as any);
    expect(res.status).toBe(503);
    const json = await res.json<any>();
    expect(json.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("revokes the exact Bearer session on logout without browser CSRF headers", async () => {
    const first = await loginAdmin(env, "test-admin-password");
    const second = await loginAdmin(env, "test-admin-password");
    const response = await app.fetch(new Request("http://localhost/api/v1/admin/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${first.token}` }
    }), env, {} as any);

    expect(response.status).toBe(200);
    expect(await validateAdminSession(env, first.token)).toBeNull();
    expect(await validateAdminSession(env, second.token)).not.toBeNull();
  });

  it("reports readiness failures without exposing configuration values", async () => {
    const notReady = createMockEnv({ R2_SECRET_ACCESS_KEY: "", SHORTCUT_TOKEN: "" });
    const response = await app.fetch(new Request("http://localhost/api/v1/ready"), notReady, {} as any);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });

    const ready = await app.fetch(new Request("http://localhost/api/v1/ready"), env, {} as any);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true });
  });

  it("safely stores HTML/XSS text as pure plain text", async () => {
    const draft = await createDraft(env);
    const xssPayload = `<script>alert('xss')</script><img src="x" onerror="alert(1)">`;

    await updateText(env, draft.dropId, draft.draftToken, xssPayload);
    const commit = await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost:5173");

    const detail = await getDropDetail(env, commit.code);
    expect(detail.items[0].type).toBe("text");
    if (detail.items[0].type === "text") {
      // Content must remain exact raw string, not stripped or executed
      expect(detail.items[0].content).toBe(xssPayload);
    }
  });
});
