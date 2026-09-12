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
});
