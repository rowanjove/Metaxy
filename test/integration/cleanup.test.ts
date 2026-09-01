import { describe, it, expect, beforeEach } from "vitest";
import { createMockEnv } from "../fixtures/mock-env";
import { createDraft, updateText, commitDrop } from "../../src/worker/services/drop-service";
import { runScheduledCleanup } from "../../src/worker/services/cleanup-service";
import { createAdminSession } from "../../src/worker/repositories/sessions";
import { prepareUpload } from "../../src/worker/services/upload-service";
import type { Env } from "../../src/worker/env";

describe("Scheduled Cron cleanup service", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("purges expired drops, R2 objects and expired sessions", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 60 });
    await updateText(env, draft.dropId, draft.draftToken, "Expiring text in R2 " + "B".repeat(1.2 * 1024 * 1024));
    await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost:5173");

    // Advance expiry to past
    const drop = await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(draft.dropId).first<any>();
    drop.expires_at = Date.now() - 5000;

    // Create an expired session
    await createAdminSession(env.DB, "old-session", "old-hash", Date.now() - 100000, Date.now() - 5000);

    // Cleanup is deliberately two-phase. Pretend the drop entered the deleting
    // state on an earlier cron run, beyond the settle window.
    drop.status = "deleting";
    drop.delete_requested_at = Date.now() - 31_000;
    const result = await runScheduledCleanup(env);
    expect(result.processedDrops).toBeGreaterThanOrEqual(1);
    expect(result.succeededDrops).toBeGreaterThanOrEqual(1);
    expect(result.cleanedSessions).toBeGreaterThanOrEqual(1);

    // Verify drop is deleted from D1
    const checkDrop = await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(draft.dropId).first();
    expect(checkDrop).toBeNull();
  });

  it("does not purge a newly marked drop in the same run", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 60 });
    await updateText(env, draft.dropId, draft.draftToken, "two phase");
    await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost");
    const drop = await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(draft.dropId).first<any>();
    drop.expires_at = Date.now() - 1;

    const result = await runScheduledCleanup(env);
    expect(result.processedDrops).toBe(0);
    const retained = await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(draft.dropId).first<any>();
    expect(retained.status).toBe("deleting");
    expect(retained.delete_requested_at).toBeTypeOf("number");
  });

  it("waits for outstanding presigned uploads before purging D1 metadata", async () => {
    const draft = await createDraft(env);
    await prepareUpload(env, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      filename: "late.bin",
      size: 4,
      contentType: "application/octet-stream"
    });
    const drop = await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(draft.dropId).first<any>();
    drop.status = "deleting";
    drop.delete_requested_at = Date.now() - 31_000;

    const result = await runScheduledCleanup(env);
    expect(result.processedDrops).toBe(0);
    expect(await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(draft.dropId).first())
      .not.toBeNull();
  });
});
