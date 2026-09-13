import { describe, it, expect, beforeEach } from "vitest";
import { createMockEnv } from "../fixtures/mock-env";
import { app } from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { uploadGalleryImage, getPreferredExtension } from "../../src/worker/services/gallery-service";
import { recordGalleryObjectDeletion } from "../../src/worker/repositories/gallery";
import { runScheduledCleanup } from "../../src/worker/services/cleanup-service";

describe("Gallery / Image Bed Integration", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("extracts correct extension for filenames and MIME types", () => {
    expect(getPreferredExtension("photo.PNG", "image/png")).toBe("png");
    expect(getPreferredExtension("screenshot.jpeg", "image/jpeg")).toBe("jpg");
    expect(getPreferredExtension("avatar", "image/webp")).toBe("webp");
    expect(getPreferredExtension("animation.gif", "image/gif")).toBe("gif");
  });

  it("uploads an image via service and stores in R2 & D1", async () => {
    const pngData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    const result = await uploadGalleryImage(env, {
      data: pngData,
      filename: "test.png",
      contentType: "image/png",
      originUrl: "https://drop.example.com"
    });

    expect(result.id).toBeDefined();
    expect(result.url).toBe(`https://drop.example.com/i/${result.id}.png`);
    expect(result.rawUrl).toBe(`https://drop.example.com/i/${result.id}`);
    expect(result.markdown).toBe(`![test.png](https://drop.example.com/i/${result.id}.png)`);
    expect(result.html).toBe(`<img src="https://drop.example.com/i/${result.id}.png" alt="test.png" />`);
    expect(result.sizeBytes).toBe(pngData.byteLength);
  });

  it("deduplicates identical images by SHA-256 hash", async () => {
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]).buffer;
    const first = await uploadGalleryImage(env, {
      data,
      filename: "first.jpg",
      contentType: "image/jpeg",
      originUrl: "https://drop.example.com"
    });

    const second = await uploadGalleryImage(env, {
      data,
      filename: "second.jpg",
      contentType: "image/jpeg",
      originUrl: "https://drop.example.com"
    });

    expect(second.id).toBe(first.id);
    expect(second.url).toBe(first.url);
  });

  it("rejects non-image MIME types", async () => {
    const exeData = new Uint8Array([77, 90, 0, 0]).buffer;
    await expect(
      uploadGalleryImage(env, {
        data: exeData,
        filename: "evil.exe",
        contentType: "application/x-msdownload",
        originUrl: "https://drop.example.com"
      })
    ).rejects.toThrow("Unsupported image format");
  });

  it("rejects SVG files to prevent XSS", async () => {
    const svgData = new TextEncoder().encode("<svg><script>alert(1)</script></svg>").buffer;
    await expect(
      uploadGalleryImage(env, {
        data: svgData,
        filename: "evil.svg",
        contentType: "image/svg+xml",
        originUrl: "https://drop.example.com"
      })
    ).rejects.toThrow("Unsupported image format");
  });

  it("rejects images exceeding 10MB limit", async () => {
    const hugeData = new Uint8Array(10 * 1024 * 1024 + 1).buffer;
    await expect(
      uploadGalleryImage(env, {
        data: hugeData,
        filename: "huge.png",
        contentType: "image/png",
        originUrl: "https://drop.example.com"
      })
    ).rejects.toThrow("exceeds maximum allowed size");
  });

  it("handles multipart upload via POST /api/v1/gallery/upload", async () => {
    const formData = new FormData();
    const fakeBlob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
    formData.append("file", fakeBlob, "uploaded.png");
    const formRequest = new Request("https://drop.example.com/api/v1/gallery/upload", { method: "POST", body: formData });
    const formBody = await formRequest.arrayBuffer();

    const req = new Request("https://drop.example.com/api/v1/gallery/upload", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.UPLOAD_TOKEN}`,
        "content-type": formRequest.headers.get("content-type")!,
        "content-length": String(formBody.byteLength)
      },
      body: formBody
    });

    const res = await app.fetch(req, env, {} as any);
    expect(res.status).toBe(201);

    const json = await res.json<any>();
    expect(json.success).toBe(true);
    expect(json.data.id).toBeDefined();
    expect(json.data.url).toContain(`/i/${json.data.id}.png`);
  });

  it("rejects upload without authorization when token mode is active", async () => {
    const formData = new FormData();
    const fakeBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    formData.append("file", fakeBlob, "test.jpg");

    const req = new Request("https://drop.example.com/api/v1/gallery/upload", {
      method: "POST",
      body: formData
    });

    const res = await app.fetch(req, env, {} as any);
    expect(res.status).toBe(401);
  });

  it("serves uploaded image publicly via GET /i/:id with strong caching", async () => {
    const pngData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    const uploaded = await uploadGalleryImage(env, {
      data: pngData,
      filename: "banner.png",
      contentType: "image/png",
      originUrl: "https://drop.example.com"
    });

    // 1. Direct GET
    const req = new Request(`https://drop.example.com/i/${uploaded.id}.png`);
    const res = await app.fetch(req, env, { waitUntil: () => {} } as any);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBeDefined();

    const etag = res.headers.get("etag")!;

    // 2. Conditional GET with If-None-Match -> 304 Not Modified
    const req304 = new Request(`https://drop.example.com/i/${uploaded.id}.png`, {
      headers: {
        "if-none-match": etag
      }
    });
    const res304 = await app.fetch(req304, env, { waitUntil: () => {} } as any);
    expect(res304.status).toBe(304);

    // 3. GET with subpath / nested path
    const reqNested = new Request(`https://drop.example.com/i/2026/09/${uploaded.id}.png`);
    const resNested = await app.fetch(reqNested, env, { waitUntil: () => {} } as any);
    expect(resNested.status).toBe(200);
  });

  it("supports listing and deleting gallery images", async () => {
    const data = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]).buffer;
    const uploaded = await uploadGalleryImage(env, {
      data,
      filename: "sample.webp",
      contentType: "image/webp",
      originUrl: "https://drop.example.com"
    });

    // The Drop upload bearer must not grant Gallery management access.
    const uploadTokenList = await app.fetch(new Request("https://drop.example.com/api/v1/gallery/images", {
      headers: { authorization: `Bearer ${env.UPLOAD_TOKEN}` }
    }), env, {} as any);
    expect(uploadTokenList.status).toBe(401);

    // List images
    const listReq = new Request("https://drop.example.com/api/v1/gallery/images", {
      headers: {
        "x-gallery-admin-token": env.GALLERY_ADMIN_TOKEN!
      }
    });
    const listRes = await app.fetch(listReq, env, {} as any);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json<any>();
    expect(listJson.data.items.length).toBeGreaterThanOrEqual(1);

    // Verify Authorization: Bearer <GALLERY_ADMIN_TOKEN> also grants access
    const bearerListReq = new Request("https://drop.example.com/api/v1/gallery/images", {
      headers: {
        authorization: `Bearer ${env.GALLERY_ADMIN_TOKEN}`
      }
    });
    const bearerListRes = await app.fetch(bearerListReq, env, {} as any);
    expect(bearerListRes.status).toBe(200);

    // Delete image
    const deleteReq = new Request(`https://drop.example.com/api/v1/gallery/images/${uploaded.id}`, {
      method: "DELETE",
      headers: {
        "x-gallery-admin-token": env.GALLERY_ADMIN_TOKEN!
      }
    });
    const delRes = await app.fetch(deleteReq, env, {} as any);
    expect(delRes.status).toBe(200);

    // Verify GET /i/:id now returns 404
    const getDeleted = new Request(`https://drop.example.com/i/${uploaded.id}`);
    const getRes = await app.fetch(getDeleted, env, { waitUntil: () => {} } as any);
    expect(getRes.status).toBe(404);
  });

  it("fails with GALLERY_DELETE_FAILED when R2 deletion fails during image delete", async () => {
    const data = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]).buffer;
    const uploaded = await uploadGalleryImage(env, {
      data,
      filename: "delete-fail.webp",
      contentType: "image/webp",
      originUrl: "https://drop.example.com"
    });

    // Mock R2 delete failure
    env.GALLERY!.delete = async () => {
      throw new Error("R2 connection reset");
    };

    const deleteReq = new Request(`https://drop.example.com/api/v1/gallery/images/${uploaded.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${env.GALLERY_ADMIN_TOKEN}`
      }
    });
    const delRes = await app.fetch(deleteReq, env, {} as any);
    expect(delRes.status).toBe(503);
    const body = await delRes.json<any>();
    expect(body.error.code).toBe("GALLERY_DELETE_FAILED");
  });

  it("reconciles an orphan object through the durable Gallery queue", async () => {
    const objectKey = "gallery/2026/09/orphan.png";
    await env.GALLERY!.put(objectKey, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer);
    await recordGalleryObjectDeletion(env.DB, objectKey, null, Date.now(), 0);

    const result = await runScheduledCleanup(env);
    expect(result.processedGalleryObjects).toBe(1);
    await expect(env.GALLERY!.get(objectKey)).resolves.toBeNull();
  });

  describe("Permission Isolation and Boundaries", () => {
    it("rejects upload when GALLERY_UPLOAD_MODE is private and UPLOAD_MODE is public without token", async () => {
      const privateEnv = {
        ...env,
        UPLOAD_MODE: "public",
        GALLERY_UPLOAD_MODE: "private"
      };

      const formData = new FormData();
      const fakeBlob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
      formData.append("file", fakeBlob, "test.png");
      const formReq = new Request("https://drop.example.com/api/v1/gallery/upload", { method: "POST", body: formData });
      const body = await formReq.arrayBuffer();

      const req = new Request("https://drop.example.com/api/v1/gallery/upload", {
        method: "POST",
        headers: {
          "content-type": formReq.headers.get("content-type")!,
          "content-length": String(body.byteLength)
        },
        body
      });

      const res = await app.fetch(req, privateEnv, {} as any);
      expect(res.status).toBe(401);
    });

    it("allows upload with GALLERY_UPLOAD_TOKEN but forbids listing or deletion", async () => {
      const uploadEnv = {
        ...env,
        GALLERY_UPLOAD_MODE: "token",
        GALLERY_UPLOAD_TOKEN: "dedicated-upload-token",
        GALLERY_ADMIN_TOKEN: "dedicated-admin-token"
      };

      // 1. Upload should succeed with GALLERY_UPLOAD_TOKEN
      const formData = new FormData();
      const fakeBlob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
      formData.append("file", fakeBlob, "ok.png");
      const formReq = new Request("https://drop.example.com/api/v1/gallery/upload", { method: "POST", body: formData });
      const body = await formReq.arrayBuffer();

      const uploadReq = new Request("https://drop.example.com/api/v1/gallery/upload", {
        method: "POST",
        headers: {
          authorization: "Bearer dedicated-upload-token",
          "content-type": formReq.headers.get("content-type")!,
          "content-length": String(body.byteLength)
        },
        body
      });
      const uploadRes = await app.fetch(uploadReq, uploadEnv, {} as any);
      expect(uploadRes.status).toBe(201);
      const { data } = await uploadRes.json<any>();

      // 2. Listing should fail (401) with GALLERY_UPLOAD_TOKEN
      const listReq = new Request("https://drop.example.com/api/v1/gallery/images", {
        headers: { authorization: "Bearer dedicated-upload-token" }
      });
      const listRes = await app.fetch(listReq, uploadEnv, {} as any);
      expect(listRes.status).toBe(401);

      // 3. Deleting should fail (401) with GALLERY_UPLOAD_TOKEN
      const deleteReq = new Request(`https://drop.example.com/api/v1/gallery/images/${data.id}`, {
        method: "DELETE",
        headers: { authorization: "Bearer dedicated-upload-token" }
      });
      const deleteRes = await app.fetch(deleteReq, uploadEnv, {} as any);
      expect(deleteRes.status).toBe(401);

      // 4. Deleting should succeed with GALLERY_ADMIN_TOKEN
      const adminDeleteReq = new Request(`https://drop.example.com/api/v1/gallery/images/${data.id}`, {
        method: "DELETE",
        headers: { authorization: "Bearer dedicated-admin-token" }
      });
      const adminDeleteRes = await app.fetch(adminDeleteReq, uploadEnv, {} as any);
      expect(adminDeleteRes.status).toBe(200);
    });
  });

  describe("Gallery 2.0 Presigned Upload & Asset Management", () => {
    it("completes full direct upload flow: prepare -> PUT staging -> complete", async () => {
      // 1. Prepare upload session
      const prepReq = new Request("https://drop.example.com/api/v1/gallery/uploads/prepare", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_UPLOAD_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          filename: "nature.png",
          size: 8,
          contentType: "image/png",
          hasThumbnail: true
        })
      });
      const prepRes = await app.fetch(prepReq, env, {} as any);
      expect(prepRes.status).toBe(201);
      const { data: prepData } = await prepRes.json<any>();
      expect(prepData.uploadId).toBeDefined();
      expect(prepData.uploadUrl).toBeDefined();
      expect(prepData.thumbUploadUrl).toBeDefined();

      // 2. Simulate R2 direct PUT into staging
      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      await env.GALLERY!.put(`gallery-staging/${prepData.uploadId}`, pngBytes.buffer, {
        httpMetadata: { contentType: "image/png" }
      });
      const thumbBytes = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
      await env.GALLERY!.put(`gallery-staging/${prepData.uploadId}-thumb`, thumbBytes.buffer, {
        httpMetadata: { contentType: "image/webp" }
      });

      // 3. Complete upload
      const compReq = new Request(`https://drop.example.com/api/v1/gallery/uploads/${prepData.uploadId}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_UPLOAD_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          filename: "nature.png",
          width: 1920,
          height: 1080
        })
      });
      const compRes = await app.fetch(compReq, env, {} as any);
      expect(compRes.status).toBe(201);
      const { data: compData } = await compRes.json<any>();
      expect(compData.id).toBe(prepData.imageId);
      expect(compData.thumbUrl).toContain(".thumb.webp");
      expect(compData.width).toBe(1920);
      expect(compData.height).toBe(1080);

      // Verify staging object was cleaned up
      const stagingCheck = await env.GALLERY!.get(`gallery-staging/${prepData.uploadId}`);
      expect(stagingCheck).toBeNull();
    });

    it("rejects complete when staging file has invalid magic bytes", async () => {
      const prepReq = new Request("https://drop.example.com/api/v1/gallery/uploads/prepare", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_UPLOAD_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          filename: "fake.png",
          size: 4,
          contentType: "image/png"
        })
      });
      const prepRes = await app.fetch(prepReq, env, {} as any);
      const { data: prepData } = await prepRes.json<any>();

      // Put invalid bytes (not PNG)
      await env.GALLERY!.put(`gallery-staging/${prepData.uploadId}`, new Uint8Array([0, 1, 2, 3]).buffer);

      const compReq = new Request(`https://drop.example.com/api/v1/gallery/uploads/${prepData.uploadId}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_UPLOAD_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      const compRes = await app.fetch(compReq, env, {} as any);
      expect(compRes.status).toBe(400);
      const json = await compRes.json<any>();
      expect(json.error.code).toBe("GALLERY_INVALID_IMAGE");
    });

    it("rejects a staging object whose R2 size differs from the prepared size", async () => {
      const prepRes = await app.fetch(new Request("https://drop.example.com/api/v1/gallery/uploads/prepare", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_UPLOAD_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ filename: "wrong-size.png", size: 9, contentType: "image/png" })
      }), env, {} as any);
      const { data: prepData } = await prepRes.json<any>();
      await env.GALLERY!.put(`gallery-staging/${prepData.uploadId}`, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer);

      const compRes = await app.fetch(new Request(`https://drop.example.com/api/v1/gallery/uploads/${prepData.uploadId}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_UPLOAD_TOKEN}`,
          "content-type": "application/json"
        },
        body: "{}"
      }), env, {} as any);

      expect(compRes.status).toBe(400);
      await expect(compRes.json<any>()).resolves.toMatchObject({ error: { code: "FILE_SIZE_MISMATCH" } });
    });

    it("allows only one concurrent direct-upload finalizer to claim the session", async () => {
      const prepRes = await app.fetch(new Request("https://drop.example.com/api/v1/gallery/uploads/prepare", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_UPLOAD_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ filename: "concurrent.png", size: 8, contentType: "image/png" })
      }), env, {} as any);
      const { data: prepData } = await prepRes.json<any>();
      await env.GALLERY!.put(`gallery-staging/${prepData.uploadId}`, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer);

      const makeComplete = () => app.fetch(new Request(`https://drop.example.com/api/v1/gallery/uploads/${prepData.uploadId}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_UPLOAD_TOKEN}`,
          "content-type": "application/json"
        },
        body: "{}"
      }), env, {} as any);
      const responses = await Promise.all([makeComplete(), makeComplete()]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    });

    it("supports album management: create, list, and assign image", async () => {
      // 1. Create album
      const createReq = new Request("https://drop.example.com/api/v1/gallery/albums", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_ADMIN_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ name: "Wallpapers", slug: "wallpapers" })
      });
      const createRes = await app.fetch(createReq, env, {} as any);
      expect(createRes.status).toBe(201);
      const { data: album } = await createRes.json<any>();
      expect(album.name).toBe("Wallpapers");
      expect(album.slug).toBe("wallpapers");

      // 2. List albums
      const listReq = new Request("https://drop.example.com/api/v1/gallery/albums", {
        headers: { authorization: `Bearer ${env.GALLERY_ADMIN_TOKEN}` }
      });
      const listRes = await app.fetch(listReq, env, {} as any);
      const { data: albums } = await listRes.json<any>();
      expect(albums.some((a: any) => a.id === album.id)).toBe(true);

      // 3. Upload an image and assign to album
      const pngData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
      const uploaded = await uploadGalleryImage(env, {
        data: pngData,
        filename: "wp1.png",
        contentType: "image/png",
        originUrl: "https://drop.example.com"
      });

      const assignReq = new Request(`https://drop.example.com/api/v1/gallery/images/${uploaded.id}/album`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${env.GALLERY_ADMIN_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ albumId: album.id })
      });
      const assignRes = await app.fetch(assignReq, env, {} as any);
      expect(assignRes.status).toBe(200);

      // 4. Toggle favorite
      const favReq = new Request(`https://drop.example.com/api/v1/gallery/images/${uploaded.id}/favorite`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${env.GALLERY_ADMIN_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ favorite: true })
      });
      const favRes = await app.fetch(favReq, env, {} as any);
      expect(favRes.status).toBe(200);

      // 5. Batch operation (delete)
      const batchReq = new Request("https://drop.example.com/api/v1/gallery/images/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GALLERY_ADMIN_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ids: [uploaded.id],
          operation: "delete"
        })
      });
      const batchRes = await app.fetch(batchReq, env, {} as any);
      expect(batchRes.status).toBe(200);
      const batchJson = await batchRes.json<any>();
      expect(batchJson.data.processedCount).toBe(1);
    });
  });
});
