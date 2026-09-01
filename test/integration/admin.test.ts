import { describe, it, expect, beforeEach } from "vitest";
import { createMockEnv } from "../fixtures/mock-env";
import {
  loginAdmin,
  validateAdminSession,
  logoutAdmin,
  logoutAllAdmin
} from "../../src/worker/services/session-service";
import { getParsedSettings, setSettingValue } from "../../src/worker/repositories/settings";
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
    expect(initial.site_name).toBe("PocketRelay");
    expect(initial.max_file_bytes).toBe(52428800);

    // Update settings in D1
    await setSettingValue(env.DB, "site_name", "My Private Relay", Date.now());
    await setSettingValue(env.DB, "allow_public_risky_files", "true", Date.now());

    const updated = await getParsedSettings(env.DB, env);
    expect(updated.site_name).toBe("My Private Relay");
    expect(updated.allow_public_risky_files).toBe(true);
  });
});
