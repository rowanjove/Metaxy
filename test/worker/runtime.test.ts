import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { createDraftDrop } from "../../src/worker/repositories/drops";
import { createPendingFile } from "../../src/worker/repositories/files";
import v2Schema from "../../migrations/0002_v2_schema.sql?raw";
import cleanupHardening from "../../migrations/0003_cleanup_hardening.sql?raw";
import metaxyBrand from "../../migrations/0004_metaxy_brand.sql?raw";
import driveCore from "../../migrations/0005_drive_core.sql?raw";
import driveDav from "../../migrations/0006_drive_dav.sql?raw";
import galleryCore from "../../migrations/0007_gallery_core.sql?raw";
import galleryV2 from "../../migrations/0008_gallery_v2.sql?raw";
import { createDevice } from "../../src/worker/services/device-service";
import { runScheduledCleanup } from "../../src/worker/services/cleanup-service";
import { getDriveRoot, findDriveNodeByPath } from "../../src/worker/repositories/drive";
import { restoreNode } from "../../src/worker/services/drive-service";

beforeAll(async () => {
  // Reset only the Drive test tables so schema iterations cannot retain a stale local constraint.
  await env.DB.batch([
    env.DB.prepare("DROP TABLE IF EXISTS dav_locks"),
    env.DB.prepare("DROP TABLE IF EXISTS drive_object_deletions"),
    env.DB.prepare("DROP TABLE IF EXISTS drive_uploads"),
    env.DB.prepare("DROP TABLE IF EXISTS drive_nodes"),
    env.DB.prepare("DROP TABLE IF EXISTS gallery_uploads"),
    env.DB.prepare("DROP TABLE IF EXISTS gallery_albums"),
    env.DB.prepare("DROP TABLE IF EXISTS gallery_object_deletions"),
    env.DB.prepare("DROP TABLE IF EXISTS gallery_images")
  ]);
  for (const migration of [v2Schema, cleanupHardening, metaxyBrand, driveCore, driveDav, galleryCore, galleryV2]) {
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

  it("streams a shortcut file through the real Worker R2 binding", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const response = await exports.default.fetch(new Request(
      "https://example.com/api/shortcut/push",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.SHORTCUT_TOKEN}`,
          "content-type": "image/png",
          "x-metaxy-filename": "runtime.png",
          "x-metaxy-file-size": String(bytes.byteLength)
        },
        body: bytes
      }
    ));

    const responseBody = await response.clone().text();
    expect(response.status, responseBody).toBe(201);
    const result = await response.json<{ code: string }>();
    const detail = await exports.default.fetch(`https://example.com/api/v1/drops/${result.code}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      data: {
        items: [{
          type: "file",
          file: {
            filename: "runtime.png",
            contentType: "image/png",
            size: bytes.byteLength
          }
        }]
      }
    });
  });

  it("serves an authenticated WebDAV directory and file through the real Worker", async () => {
    const unauthorized = await exports.default.fetch(new Request("https://example.com/dav/", { method: "OPTIONS" }));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Basic realm=\"Metaxy WebDAV\"");

    const device = await createDevice(env, "runtime-test-device");
    const auth = btoa(`${device.username}:${device.password}`);
    const headers = { authorization: `Basic ${auth}` };
    const folder = `runtime-${crypto.randomUUID().slice(0, 8)}`;
    expect(await getDriveRoot(env.DB)).toMatchObject({ kind: "folder", status: "active" });

    const options = await exports.default.fetch(new Request("https://example.com/dav/", { method: "OPTIONS", headers }));
    expect(options.status).toBe(204);
    expect(options.headers.get("dav")).toContain("1");

    const canonical = await exports.default.fetch(new Request("https://example.com/dav", { method: "OPTIONS", headers, redirect: "manual" }));
    expect(canonical.status).toBe(308);
    expect(canonical.headers.get("location")).toBe("https://example.com/dav/");

    const mkcol = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, { method: "MKCOL", headers }));
    expect(mkcol.status, await mkcol.clone().text()).toBe(201);

    const put = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/plain", "content-length": "5" },
      body: "hello"
    }));
    expect(put.status).toBe(201);

    const rootLock = await exports.default.fetch(new Request("https://example.com/dav/", {
      method: "LOCK", headers: { ...headers, depth: "infinity", timeout: "Second-300" }
    }));
    expect(rootLock.status).toBe(200);
    const rootLockToken = rootLock.headers.get("lock-token");
    const rootBlocked = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, {
      method: "PUT", headers: { ...headers, "content-type": "text/plain", "content-length": "5" }, body: "again"
    }));
    expect(rootBlocked.status).toBe(423);
    const rootUnlock = await exports.default.fetch(new Request("https://example.com/dav/", {
      method: "UNLOCK", headers: { ...headers, "lock-token": rootLockToken! }
    }));
    expect(rootUnlock.status).toBe(204);

    const firstOverwrite = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/overwrite.txt`, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/plain", "content-length": "3" },
      body: "old"
    }));
    expect(firstOverwrite.status).toBe(201);
    const secondOverwrite = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/overwrite.txt`, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/plain", "content-length": "3" },
      body: "new"
    }));
    expect(secondOverwrite.status).toBe(204);
    const overwrittenNode = await findDriveNodeByPath(env.DB, [folder, "overwrite.txt"]);
    expect(overwrittenNode?.kind).toBe("file");
    const overwrittenObjectQueue = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM drive_object_deletions WHERE node_id = ?"
    ).bind(overwrittenNode!.id).first<{ count: number }>();
    expect(overwrittenObjectQueue?.count).toBe(1);

    const malformedDestination = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, {
      method: "COPY",
      headers: { ...headers, destination: "%%%" }
    }));
    expect(malformedDestination.status).toBe(400);

    const traversal = await exports.default.fetch(new Request("https://example.com/dav/%2e%2e/", {
      method: "PROPFIND",
      headers: { ...headers, depth: "0" }
    }));
    expect(traversal.status).toBeGreaterThanOrEqual(400);

    const propfind = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "PROPFIND",
      headers: { ...headers, depth: "1" }
    }));
    expect(propfind.status).toBe(207);
    await expect(propfind.text()).resolves.toContain("hello.txt");

    // WebDAV has no cursor parameter for a single PROPFIND response. The
    // bounded implementation must still expose more than the old 200-row
    // ceiling so a 1,000-node directory remains usable by desktop clients.
    const largeFolder = `runtime-large-${crypto.randomUUID().slice(0, 8)}`;
    const largeMkcol = await exports.default.fetch(new Request(`https://example.com/dav/${largeFolder}/`, { method: "MKCOL", headers }));
    expect(largeMkcol.status).toBe(201);
    const largeParent = await findDriveNodeByPath(env.DB, [largeFolder]);
    expect(largeParent?.kind).toBe("folder");
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 205 }, (_, index) => {
      const id = crypto.randomUUID();
      const name = `child-${String(index).padStart(3, "0")}`;
      return env.DB.prepare(
        `INSERT INTO drive_nodes
          (id, parent_id, kind, name, name_key, status, version, created_at, updated_at)
         VALUES (?, ?, 'folder', ?, ?, 'active', 1, ?, ?)`
      ).bind(id, largeParent!.id, name, name, now, now);
    }));
    const largePropfind = await exports.default.fetch(new Request(`https://example.com/dav/${largeFolder}/`, {
      method: "PROPFIND",
      headers: { ...headers, depth: "1" }
    }));
    expect(largePropfind.status).toBe(207);
    const largeXml = await largePropfind.text();
    expect((largeXml.match(/<d:response>/g) || []).length).toBe(206);

    const get = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, { headers }));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-disposition")).toContain("inline");
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    await expect(get.text()).resolves.toBe("hello");

    const range = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, {
      headers: { ...headers, range: "bytes=0-0" }
    }));
    expect(range.status).toBe(206);
    expect(range.headers.get("content-length")).toBe("1");
    expect(range.headers.get("content-range")).toBe("bytes 0-0/5");
    await expect(range.text()).resolves.toBe("h");

    const missingLength = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/length.txt`, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/plain" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("too-big-to-measure"));
          controller.close();
        }
      })
    }));
    expect(missingLength.status).toBe(411);

    const copy = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, {
      method: "COPY",
      headers: { ...headers, destination: `https://example.com/dav/${folder}/copy.txt` }
    }));
    expect(copy.status).toBe(201);

    const folderCopy = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "COPY",
      headers: { ...headers, destination: `https://example.com/dav/${folder}-copy/` }
    }));
    expect(folderCopy.status).toBe(201);

    const move = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/copy.txt`, {
      method: "MOVE",
      headers: { ...headers, destination: `https://example.com/dav/${folder}/moved.txt` }
    }));
    expect(move.status).toBe(201);

    const lock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/moved.txt`, {
      method: "LOCK", headers: { ...headers, timeout: "Second-300" }
    }));
    expect(lock.status).toBe(200);
    const lockToken = lock.headers.get("lock-token");
    expect(lockToken).toBeTruthy();
    const blocked = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/moved.txt`, {
      method: "PUT", headers: { ...headers, "content-type": "text/plain", "content-length": "3" }, body: "new"
    }));
    expect(blocked.status).toBe(423);

    const secondDevice = await createDevice(env, "runtime-test-device-2");
    const conflictLock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/moved.txt`, {
      method: "LOCK",
      headers: { authorization: `Basic ${btoa(`${secondDevice.username}:${secondDevice.password}`)}`, timeout: "Second-300" }
    }));
    expect(conflictLock.status).toBe(423);
    const unlock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/moved.txt`, {
      method: "UNLOCK", headers: { ...headers, "lock-token": lockToken! }
    }));
    expect(unlock.status).toBe(204);

    const folderLock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "LOCK", headers: { ...headers, depth: "infinity", timeout: "Second-300" }
    }));
    expect(folderLock.status).toBe(200);
    const folderLockToken = folderLock.headers.get("lock-token");
    const inheritedBlocked = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/moved.txt`, {
      method: "PUT", headers: { ...headers, "content-type": "text/plain", "content-length": "3" }, body: "new"
    }));
    expect(inheritedBlocked.status).toBe(423);
    const folderUnlock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "UNLOCK", headers: { ...headers, "lock-token": folderLockToken! }
    }));
    expect(folderUnlock.status).toBe(204);

    const depthOneLock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "LOCK", headers: { ...headers, depth: "1", timeout: "Second-300" }, body: "<owner>runtime</owner>"
    }));
    expect(depthOneLock.status).toBe(200);
    await expect(depthOneLock.clone().text()).resolves.toContain("<d:depth>1</d:depth>");
    const depthOneToken = depthOneLock.headers.get("lock-token");
    const depthOneBlocked = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/moved.txt`, {
      method: "PUT", headers: { ...headers, "content-type": "text/plain", "content-length": "3" }, body: "new"
    }));
    expect(depthOneBlocked.status).toBe(423);
    const depthOneUnlock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "UNLOCK", headers: { ...headers, "lock-token": depthOneToken! }
    }));
    expect(depthOneUnlock.status).toBe(204);

    // An existing child lock must prevent a new parent Depth: infinity lock;
    // otherwise two exclusive locks can overlap and neither client can make
    // a consistent collection change.
    const descendantLock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, {
      method: "LOCK", headers: { ...headers, depth: "0", timeout: "Second-300" }
    }));
    expect(descendantLock.status).toBe(200);
    const descendantToken = descendantLock.headers.get("lock-token");
    const overlappingParentLock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "LOCK", headers: { ...headers, depth: "infinity", timeout: "Second-300" }
    }));
    expect(overlappingParentLock.status).toBe(423);
    const descendantUnlock = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, {
      method: "UNLOCK", headers: { ...headers, "lock-token": descendantToken! }
    }));
    expect(descendantUnlock.status).toBe(204);

    // A collection mutation must honor locks held by descendants. If more
    // than one descendant is locked, every token has to be supplied.
    const childLockOne = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/moved.txt`, {
      method: "LOCK", headers: { ...headers, depth: "0", timeout: "Second-300" }
    }));
    expect(childLockOne.status).toBe(200);
    const childTokenOne = childLockOne.headers.get("lock-token");
    const childLockTwo = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/hello.txt`, {
      method: "LOCK", headers: { ...headers, depth: "0", timeout: "Second-300" }
    }));
    expect(childLockTwo.status).toBe(200);
    const childTokenTwo = childLockTwo.headers.get("lock-token");
    const deleteWithOneChildToken = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "DELETE", headers: { ...headers, if: childTokenOne! }
    }));
    expect(deleteWithOneChildToken.status).toBe(423);
    const deleteWithAllChildTokens = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, {
      method: "DELETE", headers: { ...headers, if: `${childTokenOne} ${childTokenTwo}` }
    }));
    expect(deleteWithAllChildTokens.status).toBe(204);

    const copiedFolder = await findDriveNodeByPath(env.DB, [`${folder}-copy`]);
    expect(copiedFolder?.status).toBe("active");
    const deleteFolder = await exports.default.fetch(new Request(`https://example.com/dav/${folder}-copy/`, { method: "DELETE", headers }));
    expect(deleteFolder.status).toBe(204);
    const restored = await restoreNode(env, copiedFolder!.id);
    expect(restored.status).toBe("active");
    // Windows WebDAV Mini-Redirector quirk: connects over HTTPS port 443 but sends Destination: http://...
    const windowsWebClientMove = await exports.default.fetch(new Request(`https://example.com/dav/${folder}-copy/hello.txt`, {
      method: "MOVE",
      headers: { ...headers, destination: `http://example.com/dav/${folder}-copy/windows-moved.txt` }
    }));
    expect(windowsWebClientMove.status).toBe(201);

    const pendingDeletion = await env.DB.prepare("SELECT COUNT(*) AS count FROM drive_object_deletions WHERE node_id IN (SELECT id FROM drive_nodes WHERE parent_id = ? OR id = ?)").bind(copiedFolder!.id, copiedFolder!.id).first<{ count: number }>();
    expect(pendingDeletion?.count).toBe(0);
  });

  it("finalizes an expired Drive deletion without allowing restore after R2 purge", async () => {
    const device = await createDevice(env, `runtime-cleanup-${crypto.randomUUID().slice(0, 8)}`);
    const headers = { authorization: `Basic ${btoa(`${device.username}:${device.password}`)}` };
    const folder = `runtime-cleanup-${crypto.randomUUID().slice(0, 8)}`;
    const mkcol = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, { method: "MKCOL", headers }));
    expect(mkcol.status).toBe(201);
    const put = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/expired.txt`, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/plain", "content-length": "7" },
      body: "expired"
    }));
    expect(put.status).toBe(201);
    const file = await findDriveNodeByPath(env.DB, [folder, "expired.txt"]);
    expect(file?.status).toBe("active");
    const remove = await exports.default.fetch(new Request(`https://example.com/dav/${folder}/`, { method: "DELETE", headers }));
    expect(remove.status).toBe(204);
    const trashed = await env.DB.prepare("SELECT status, object_key FROM drive_nodes WHERE id = ?").bind(file!.id).first<{ status: string; object_key: string }>();
    expect(trashed?.status).toBe("trashed");
    await env.DB.prepare("UPDATE drive_object_deletions SET not_before = 0 WHERE node_id = ?").bind(file!.id).run();

    const cleanup = await runScheduledCleanup(env);
    expect(cleanup.processedDriveObjects).toBeGreaterThan(0);
    await expect(env.DB.prepare("SELECT id FROM drive_nodes WHERE id = ?").bind(file!.id).first()).resolves.toBeNull();
    await expect(env.DRIVE!.get(trashed!.object_key)).resolves.toBeNull();
    await expect(restoreNode(env, file!.id)).rejects.toThrow();

    const retainedFolder = `runtime-retain-${crypto.randomUUID().slice(0, 8)}`;
    const retainedMkcol = await exports.default.fetch(new Request(`https://example.com/dav/${retainedFolder}/`, { method: "MKCOL", headers }));
    expect(retainedMkcol.status).toBe(201);
    const retainedPut = await exports.default.fetch(new Request(`https://example.com/dav/${retainedFolder}/retained.txt`, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/plain", "content-length": "8" },
      body: "retained"
    }));
    expect(retainedPut.status).toBe(201);
    const retained = await findDriveNodeByPath(env.DB, [retainedFolder, "retained.txt"]);
    const retainedDelete = await exports.default.fetch(new Request(`https://example.com/dav/${retainedFolder}/retained.txt`, { method: "DELETE", headers }));
    expect(retainedDelete.status).toBe(204);
    expect((await restoreNode(env, retained!.id)).status).toBe("active");
    await env.DB.prepare("UPDATE drive_object_deletions SET not_before = 0 WHERE node_id = ?").bind(retained!.id).run();
    await runScheduledCleanup(env);
    await expect(env.DRIVE!.get(retained!.object_key!)).resolves.toBeTruthy();
    const retainedQueue = await env.DB.prepare("SELECT COUNT(*) AS count FROM drive_object_deletions WHERE node_id = ?").bind(retained!.id).first<{ count: number }>();
    expect(retainedQueue?.count).toBe(0);
  });
});
