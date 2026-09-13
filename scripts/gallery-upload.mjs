#!/usr/bin/env node
/**
 * Metaxy Gallery 2.0 CLI Upload Utility
 *
 * Usage:
 *   node scripts/gallery-upload.mjs <image-path> [--url <base-url>] [--token <upload-token>] [--album <album-id>]
 *
 * Environment variables:
 *   METAXY_URL / GALLERY_URL: Base URL of the Metaxy instance (e.g. https://relay.example.com)
 *   METAXY_UPLOAD_TOKEN / GALLERY_UPLOAD_TOKEN: Upload token
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = "";
  let baseUrl = process.env.METAXY_URL || process.env.GALLERY_URL || "http://127.0.0.1:8787";
  let token = process.env.METAXY_UPLOAD_TOKEN || process.env.GALLERY_UPLOAD_TOKEN || "";
  let albumId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      baseUrl = args[++i];
    } else if (args[i] === "--token" && args[i + 1]) {
      token = args[++i];
    } else if (args[i] === "--album" && args[i + 1]) {
      albumId = args[++i];
    } else if (!args[i].startsWith("--") && !filePath) {
      filePath = args[i];
    }
  }

  return { filePath, baseUrl: baseUrl.replace(/\/+$/, ""), token, albumId };
}

function getMimeType(filename) {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".webp": return "image/webp";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".avif": return "image/avif";
    default: return "application/octet-stream";
  }
}

async function uploadImage() {
  const { filePath, baseUrl, token, albumId } = parseArgs();

  if (!filePath) {
    console.error("Error: Image file path is required.");
    console.error("Usage: node scripts/gallery-upload.mjs <image-path> [--url <base-url>] [--token <upload-token>] [--album <album-id>]");
    process.exit(1);
  }

  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const fileStat = statSync(filePath);
  const fileBytes = readFileSync(filePath);
  const fileName = basename(filePath);
  const mimeType = getMimeType(fileName);

  console.log(`[Gallery 2.0] Preparing upload for ${fileName} (${(fileBytes.length / 1024).toFixed(1)} KB)...`);

  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Try Presigned direct upload flow first
  try {
    const prepareRes = await fetch(`${baseUrl}/api/v1/gallery/uploads/prepare`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filename: fileName,
        size: fileBytes.length,
        contentType: mimeType,
        hasThumbnail: false
      })
    });

    if (prepareRes.ok) {
      const prep = await prepareRes.json();
      console.log(`[Gallery 2.0] Presigned upload initiated: ${prep.uploadId}`);

      // PUT to R2 staging
      const putRes = await fetch(prep.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": mimeType
        },
        body: fileBytes
      });

      if (!putRes.ok) {
        throw new Error(`R2 direct PUT failed with status ${putRes.status}`);
      }

      // Complete upload
      const completeRes = await fetch(`${baseUrl}/api/v1/gallery/uploads/${prep.uploadId}/complete`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filename: fileName,
          albumId: albumId || undefined
        })
      });

      if (!completeRes.ok) {
        const errText = await completeRes.text();
        throw new Error(`Complete upload failed (${completeRes.status}): ${errText}`);
      }

      const completed = await completeRes.json();
      const img = completed.data || completed;
      console.log(`\n[Upload Success]`);
      console.log(`URL:      ${img.url}`);
      console.log(`Markdown: ${img.markdown}`);
      console.log(`HTML:     ${img.html}`);
      return;
    }
  } catch (err) {
    console.warn(`[Gallery 2.0] Direct upload attempt failed, falling back to multipart API: ${err.message}`);
  }

  // Fallback to legacy POST /api/v1/gallery/upload
  const formData = new FormData();
  formData.append("file", new Blob([fileBytes], { type: mimeType }), fileName);

  const res = await fetch(`${baseUrl}/api/v1/gallery/upload`, {
    method: "POST",
    headers,
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Upload failed (${res.status}): ${errText}`);
    process.exit(1);
  }

  const result = await res.json();
  const img = result.data || result;
  console.log(`\n[Upload Success]`);
  console.log(`URL:      ${img.url}`);
  console.log(`Markdown: ${img.markdown}`);
  console.log(`HTML:     ${img.html}`);
}

uploadImage().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
