import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { createDraftDrop } from "../../src/worker/repositories/drops";
import { createPendingFile } from "../../src/worker/repositories/files";
import v2Schema from "../../migrations/0002_v2_schema.sql?raw";
import cleanupHardening from "../../migrations/0003_cleanup_hardening.sql?raw";

beforeAll(async () => {
  for (const migration of [v2Schema, cleanupHardening]) {
    const statements = migration.split(";").map((sql) => sql.trim()).filter(Boolean);
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
  }
});

describe("Worker runtime smoke tests", () => {
  it("serves the health endpoint through workerd", async () => {
    const response = await exports.default.fetch("https://example.com/api/v1/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("falls back to the SPA shell for retrieval navigation", async () => {
    const response = await exports.default.fetch("https://example.com/d/ABC123");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("<html");
  });

  it("executes the hardened upload transaction against real D1", async () => {
    const now = Date.now();
    const dropId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    await createDraftDrop(env.DB, {
      id: dropId,
      code: crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase(),
      draftTokenHash: "runtime-test-hash",
      createdAt: now,
      expiresAt: now + 60_000
    });

    await expect(createPendingFile(env.DB, {
      id: fileId,
      dropId,
      objectKey: `drops/${dropId}/files/${fileId}`,
      uploadObjectKey: `uploads/${dropId}/${fileId}`,
      filename: "runtime.bin",
      contentType: "application/octet-stream",
      expectedSize: 4,
      sortOrder: 1,
      createdAt: now,
      presignExpiresAt: now + 300_000
    }, 1024)).resolves.toBe(true);

    const row = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(fileId).first<any>();
    expect(row.upload_object_key).toBe(`uploads/${dropId}/${fileId}`);
    expect(row.finalize_token).toBeNull();
  });
});
