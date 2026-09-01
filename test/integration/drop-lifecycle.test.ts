import { describe, it, expect, beforeEach } from "vitest";
import { createMockEnv } from "../fixtures/mock-env";
import { createDraft, updateText, commitDrop, getDropDetail, getR2TextStream } from "../../src/worker/services/drop-service";
import { prepareUpload, completeUpload } from "../../src/worker/services/upload-service";
import type { Env } from "../../src/worker/env";

describe("Drop lifecycle and storage tiering", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("creates draft and commits small text in D1", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 3600 });
    expect(draft.dropId).toBeDefined();
    expect(draft.draftToken).toBeDefined();

    // Update text (small text <= 1 MiB)
    await updateText(env, draft.dropId, draft.draftToken, "Hello, World!");

    // Commit
    const commit = await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost:5173");
    expect(commit.code).toBeDefined();
    expect(commit.url).toBe(`http://localhost:5173/d/${commit.code}`);

    // Retrieve
    const detail = await getDropDetail(env, commit.code);
    expect(detail.code).toBe(commit.code);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].type).toBe("text");
    if (detail.items[0].type === "text") {
      expect(detail.items[0].content).toBe("Hello, World!");
      expect(detail.items[0].contentUrl).toBeNull();
    }
  });

  it("handles large text (> 1 MiB) via R2 storage tiering", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 3600 });
    const largeText = "A".repeat(1.5 * 1024 * 1024); // 1.5 MiB

    await updateText(env, draft.dropId, draft.draftToken, largeText);
    const commit = await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost:5173");

    const detail = await getDropDetail(env, commit.code);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].type).toBe("text");
    if (detail.items[0].type === "text") {
      expect(detail.items[0].content).toBeNull();
      expect(detail.items[0].contentUrl).toContain(`/api/v1/drops/${commit.code}/items/`);

      // Test R2 text stream
      const streamRes = await getR2TextStream(env, commit.code, detail.items[0].id);
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const streamedText = await streamRes.text();
      expect(streamedText).toBe(largeText);
    }
  });

  it("handles file prepare, R2 direct upload, complete and commit", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 3600 });

    const prepared = await prepareUpload(env, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      filename: "photo.png",
      size: 1024,
      contentType: "image/png"
    });

    expect(prepared.fileId).toBeDefined();
    expect(prepared.uploadUrl).toBeDefined();

    // Simulate R2 PUT
    const uploadKey = `uploads/${draft.dropId}/${prepared.fileId}`;
    await env.FILES.put(uploadKey, new Uint8Array(1024), {
      httpMetadata: { contentType: "image/png" }
    });

    // Complete upload
    const completed = await completeUpload(env, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      fileId: prepared.fileId
    });
    expect(completed.status).toBe("uploaded");

    // Commit
    const commit = await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost:5173");
    const detail = await getDropDetail(env, commit.code);

    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].type).toBe("file");
    if (detail.items[0].type === "file") {
      expect(detail.items[0].file.filename).toBe("photo.png");
      expect(detail.items[0].file.previewable).toBe(true);

      // A presigned URL is reusable until it expires. Replaying it only
      // changes the staging key and cannot overwrite the finalized download.
      await env.FILES.put(uploadKey, new Uint8Array(1024).fill(9), {
        httpMetadata: { contentType: "image/png" }
      });
      const response = await (await import("../../src/worker/index")).app.fetch(
        new Request(`http://localhost${detail.items[0].file.contentUrl}`),
        env,
        {} as any
      );
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(1024));
    }
  });

  it("reuses a pending record when an upload is retried", async () => {
    const draft = await createDraft(env);
    const first = await prepareUpload(env, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      filename: "retry.bin",
      size: 8,
      contentType: "application/octet-stream"
    });
    const retry = await prepareUpload(env, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      fileId: first.fileId,
      filename: "retry.bin",
      size: 8,
      contentType: "application/octet-stream"
    });

    expect(retry.fileId).toBe(first.fileId);
    const files = await env.DB.prepare("SELECT * FROM files WHERE drop_id = ?")
      .bind(draft.dropId).all<any>();
    expect(files.results).toHaveLength(1);

    await env.FILES.put(`uploads/${draft.dropId}/${first.fileId}`, new Uint8Array(8));
    await completeUpload(env, { ...draft, fileId: first.fileId });
    await expect(commitDrop(env, draft.dropId, draft.draftToken, "http://localhost"))
      .resolves.toMatchObject({ code: expect.any(String) });
  });

  it("quarantines a size mismatch and allows a safe retry", async () => {
    const draft = await createDraft(env);
    const prepared = await prepareUpload(env, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      filename: "bounded.bin",
      size: 4,
      contentType: "application/octet-stream"
    });
    const uploadKey = `uploads/${draft.dropId}/${prepared.fileId}`;
    await env.FILES.put(uploadKey, new Uint8Array(5));
    await expect(completeUpload(env, { ...draft, fileId: prepared.fileId }))
      .rejects.toMatchObject({ code: "FILE_SIZE_MISMATCH" });
    expect(await env.FILES.head(uploadKey)).toBeNull();

    await prepareUpload(env, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      fileId: prepared.fileId,
      filename: "bounded.bin",
      size: 4,
      contentType: "application/octet-stream"
    });
    await env.FILES.put(uploadKey, new Uint8Array(4));
    await expect(completeUpload(env, { ...draft, fileId: prepared.fileId }))
      .resolves.toMatchObject({ status: "uploaded" });
  });

  it("rejects committing an empty drop", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 3600 });
    await expect(commitDrop(env, draft.dropId, draft.draftToken, "http://localhost:5173")).rejects.toThrow(
      "Cannot commit an empty drop."
    );
  });

  it("returns 410 when drop is expired even without cron running", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 60 });
    await updateText(env, draft.dropId, draft.draftToken, "Expires soon");
    const commit = await commitDrop(env, draft.dropId, draft.draftToken, "http://localhost:5173");

    // Manually advance expiry to the past
    const drop = await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(draft.dropId).first<any>();
    drop.expires_at = Date.now() - 1000;

    await expect(getDropDetail(env, commit.code)).rejects.toThrow("This drop has expired.");
  });

  it("rejects committing a draft after its selected expiry time", async () => {
    const draft = await createDraft(env, { expiresInSeconds: 60 });
    await updateText(env, draft.dropId, draft.draftToken, "Expires before commit");

    const drop = await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(draft.dropId).first<any>();
    drop.expires_at = Date.now() - 1;

    await expect(commitDrop(env, draft.dropId, draft.draftToken, "http://localhost:5173"))
      .rejects.toThrow("This drop has expired.");
  });

  it("enforces cumulative file capacity across concurrent preparations", async () => {
    const limitedEnv = createMockEnv({ MAX_DROP_FILE_BYTES_HARD: "52428800" });
    const draft = await createDraft(limitedEnv);
    const prepare = (suffix: string) => prepareUpload(limitedEnv, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      filename: `file-${suffix}.bin`,
      size: 30 * 1024 * 1024,
      contentType: "application/octet-stream"
    });

    const results = await Promise.allSettled([prepare("a"), prepare("b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
      reason: expect.objectContaining({ code: "TOTAL_FILE_SIZE_EXCEEDED" })
    });
  });
});
