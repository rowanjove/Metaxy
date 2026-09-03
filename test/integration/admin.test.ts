import { describe, it, expect, beforeEach } from "vitest";
import { createMockEnv } from "../fixtures/mock-env";
import {
  loginAdmin,
  validateAdminSession,
  logoutAdmin,
  logoutAllAdmin
} from "../../src/worker/services/session-service";
import { getParsedSettings, setSettingValue } from "../../src/worker/repositories/settings";
import { createDraft, updateText, commitDrop } from "../../src/worker/services/drop-service";
import { app } from "../../src/worker/index";
import type { Env } from "../../src/worker/env";

describe("Admin authentication and settings management", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("authenticates admin with valid password and creates session", async () => {
    const { token, expiresAt } = await loginAdmin(env, "test-admin-password");
    expect(token).toBeDefined();
    expect(expiresAt).toBeGreaterThan(Date.now());

    // Validate session
    const session = await validateAdminSession(env, token);
    expect(session).not.toBeNull();
    expect(session?.token_hash).toBeDefined();
  });

  it("rejects invalid admin password", async () => {
    await expect(loginAdmin(env, "wrong-password")).rejects.toThrow("Invalid admin password.");
  });

  it("supports single device logout and logout-all", async () => {
    const session1 = await loginAdmin(env, "test-admin-password");
    const session2 = await loginAdmin(env, "test-admin-password");

    await logoutAdmin(env, session1.token);
    expect(await validateAdminSession(env, session1.token)).toBeNull();
    expect(await validateAdminSession(env, session2.token)).not.toBeNull();

    await logoutAllAdmin(env);
    expect(await validateAdminSession(env, session2.token)).toBeNull();
  });

  it("reads and updates settings with hard limit clamping", async () => {
    const initial = await getParsedSettings(env.DB, env);
    expect(initial.site_name).toBe("之间门");
    expect(initial.max_file_bytes).toBe(52428800);

    // Update settings in D1
    await setSettingValue(env.DB, "site_name", "My Private Relay", Date.now());
    await setSettingValue(env.DB, "allow_public_risky_files", "true", Date.now());

    const updated = await getParsedSettings(env.DB, env);
    expect(updated.site_name).toBe("My Private Relay");
    expect(updated.allow_public_risky_files).toBe(true);
  });

  it("never shortens an existing expiry when the configured maximum is reduced", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 7 * 24 * 60 * 60 });
    await updateText(env, draft.dropId, draft.draftToken, "keep the original expiry");
    await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost");
    const before = await env.DB.prepare("SELECT * FROM drops WHERE id = ?")
      .bind(draft.dropId).first<any>();
    await setSettingValue(env.DB, "max_expiry_seconds", String(24 * 60 * 60));
    const admin = await loginAdmin(env, "test-admin-password");

    const response = await app.fetch(new Request(
      `http://localhost/api/v1/admin/drops/${draft.dropId}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${admin.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ action: "extend", additionalSeconds: 86400 })
      }
    ), env, {} as ExecutionContext);

    expect(response.status).toBe(409);
    const after = await env.DB.prepare("SELECT * FROM drops WHERE id = ?")
      .bind(draft.dropId).first<any>();
    expect(after.expires_at).toBe(before.expires_at);
  });

  it("extends an active drop without losing concurrent state checks", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 3600 });
    await updateText(env, draft.dropId, draft.draftToken, "extend safely");
    await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost");
    const original = await env.DB.prepare("SELECT * FROM drops WHERE id = ?")
      .bind(draft.dropId).first<any>();
    const originalExpiry = original.expires_at;
    const admin = await loginAdmin(env, "test-admin-password");

    const response = await app.fetch(new Request(
      `http://localhost/api/v1/admin/drops/${draft.dropId}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${admin.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ action: "extend", additionalSeconds: 3600 })
      }
    ), env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    const updated = await env.DB.prepare("SELECT * FROM drops WHERE id = ?")
      .bind(draft.dropId).first<any>();
    expect(updated.expires_at).toBe(originalExpiry + 3600 * 1000);
  });
});
