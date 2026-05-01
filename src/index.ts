type CardType = "text" | "link" | "code" | "image";

interface Env {
  APP_NAME?: string;
  ARCHIVE_RETENTION_HOURS?: string;
  COOLING_AFTER_HOURS?: string;
  MAX_IMAGE_BYTES?: string;
  APP_ACCESS_TOKEN?: string;
  SHORTCUT_TOKEN?: string;
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  DB: D1Database;
  IMAGES: R2Bucket;
}

interface CardRow {
  id: string;
  type: CardType;
  content: string | null;
  image_key: string | null;
  title: string | null;
  lang: string | null;
  created_at: number;
  updated_at: number;
  is_archived: number;
  archived_at: number | null;
  archive_date: string | null;
  archive_salt: string | null;
  archive_iv: string | null;
  archive_ciphertext: string | null;
  archive_blob_iv: string | null;
  archive_blob_key: string | null;
}

interface RuntimeConfig {
  appName: string;
  archiveRetentionHours: number;
  coolingAfterHours: number;
  maxImageBytes: number;
  accessEnabled: boolean;
  shortcutEnabled: boolean;
}

const HOUR_IN_MS = 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (getConfig(env).accessEnabled && !isShortcutPushRequest(request)) {
      const authorized = await isAppAuthorized(request, env);
      if (!authorized) {
        return withCors(unauthorized());
      }
    }

    if (!url.pathname.startsWith("/api/")) {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Static assets binding not configured.", { status: 500 });
    }

    try {
      const response = await routeApi(request, env, ctx);
      return withCors(response);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : "Unexpected server error";
      const status = error instanceof HttpError ? error.status : 500;
      return withCors(json({ error: message }, status));
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(archiveDueCards(env));
  }
} satisfies ExportedHandler<Env>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function routeApi(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const config = getConfig(env);

  if (request.method === "GET" && pathname === "/api/meta") {
    return json({
      appName: config.appName,
      archiveRetentionHours: config.archiveRetentionHours,
      coolingAfterHours: config.coolingAfterHours,
      maxImageBytes: config.maxImageBytes,
      accessEnabled: config.accessEnabled,
      shortcutEnabled: config.shortcutEnabled,
      shortcutEndpoint: buildAbsoluteUrl(request.url, "/api/shortcut/push")
    });
  }

  if (request.method === "GET" && pathname === "/api/cards") {
    const cards = await listActiveCards(env, request.url);
    return json({ items: cards });
  }

  if (request.method === "POST" && pathname === "/api/push") {
    const body = await parseJson<{
      content?: unknown;
      archivePayload?: unknown;
    }>(request);

    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      throw new HttpError(400, "Content is required.");
    }

    const archivePayload = sanitizeArchivePayload(body.archivePayload);
    const card = await createTextCard(env, content, archivePayload);

    return json({ item: serializeActiveCard(card, request.url, config) }, 201);
  }

  if (request.method === "POST" && pathname === "/api/shortcut/push") {
    await assertShortcutAuthorized(request, env);
    const body = await parseShortcutBody(request);
    const content = body.content.trim();
    if (!content) {
      throw new HttpError(400, "Content is required.");
    }

    const card = await createTextCard(env, content, null);
    return json({
      ok: true,
      item: serializeActiveCard(card, request.url, config)
    }, 201);
  }

  if (request.method === "POST" && pathname === "/api/image") {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!isBlobLike(file)) {
      throw new HttpError(400, "A file field is required.");
    }

    if (file.size > config.maxImageBytes) {
      throw new HttpError(400, `Image exceeds ${Math.round(config.maxImageBytes / 1024 / 1024)}MB limit.`);
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const extension = getFileExtension(file.name, file.type);
    const activeKey = `active/${id}${extension}`;
    const archiveBlob = formData.get("archiveBlob");
    const archivePayload = sanitizeArchivePayload({
      salt: formData.get("archiveSalt"),
      iv: formData.get("archiveIv"),
      ciphertext: formData.get("archiveCiphertext"),
      blobIv: formData.get("archiveBlobIv"),
      blobKey: null
    });
    const archiveBlobKey = isBlobLike(archiveBlob) ? `archive/${id}.bin` : null;

    try {
      await env.IMAGES.put(activeKey, await file.arrayBuffer(), {
        httpMetadata: {
          contentType: file.type || "application/octet-stream"
        },
        customMetadata: {
          originalName: file.name
        }
      });

      if (archiveBlobKey && isBlobLike(archiveBlob)) {
        await env.IMAGES.put(archiveBlobKey, await archiveBlob.arrayBuffer(), {
          httpMetadata: {
            contentType: "application/octet-stream"
          }
        });
      }

      await env.DB.prepare(
        `
          INSERT INTO cards (
            id, type, image_key, title, created_at, updated_at,
            archive_salt, archive_iv, archive_ciphertext, archive_blob_iv, archive_blob_key
          )
          VALUES (?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
        .bind(
          id,
          activeKey,
          file.name || "image",
          now,
          now,
          archivePayload?.salt ?? null,
          archivePayload?.iv ?? null,
          archivePayload?.ciphertext ?? null,
          archivePayload?.blobIv ?? null,
          archiveBlobKey
        )
        .run();
    } catch (error) {
      await env.IMAGES.delete(activeKey);
      if (archiveBlobKey) {
        await env.IMAGES.delete(archiveBlobKey);
      }
      throw error;
    }

    const card = await getCardById(env, id);
    if (!card) {
      throw new HttpError(500, "Failed to load uploaded image card.");
    }

    return json({ item: serializeActiveCard(card, request.url, config) }, 201);
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/cards/")) {
    // CSRF protection: only allow same-origin requests
    const origin = request.headers.get("origin");
    if (origin) {
      const requestOrigin = new URL(request.url).origin;
      if (origin !== requestOrigin) {
        throw new HttpError(403, "Cross-origin requests not allowed.");
      }
    }
    // Also check Referer as fallback
    const referer = request.headers.get("referer");
    if (referer) {
      const requestOrigin = new URL(request.url).origin;
      if (!referer.startsWith(requestOrigin)) {
        throw new HttpError(403, "Cross-origin requests not allowed.");
      }
    }

    const id = decodeURIComponent(pathname.slice("/api/cards/".length));
    if (!id) {
      throw new HttpError(400, "Card id is required.");
    }

    await deleteCard(env, id);
    return json({ ok: true });
  }

  if (request.method === "PUT" && pathname.startsWith("/api/cards/") && pathname.endsWith("/archive-material")) {
    const id = decodeURIComponent(pathname.slice("/api/cards/".length, -"/archive-material".length));
    if (!id) {
      throw new HttpError(400, "Card id is required.");
    }

    const card = await getCardById(env, id);
    if (!card || card.is_archived !== 0) {
      throw new HttpError(404, "Active card not found.");
    }

    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      await updateImageArchiveMaterial(env, card, request);
    } else {
      const body = await parseJson<{ archivePayload?: unknown }>(request);
      const archivePayload = sanitizeArchivePayload(body.archivePayload);
      if (!archivePayload) {
        throw new HttpError(400, "Archive payload is required.");
      }
      await updateTextArchiveMaterial(env, card, archivePayload);
    }

    const updated = await getCardById(env, id);
    if (!updated) {
      throw new HttpError(500, "Failed to load updated card.");
    }

    return json({ item: serializeActiveCard(updated, request.url, config) });
  }

  if (request.method === "GET" && pathname === "/api/archive") {
    const items = await listArchivedCards(env, request.url);
    return json({ items });
  }

  if (request.method === "GET" && pathname.startsWith("/api/archive/") && pathname.endsWith("/blob")) {
    const id = decodeURIComponent(pathname.slice("/api/archive/".length, -"/blob".length));
    if (!id) {
      throw new HttpError(400, "Card id is required.");
    }
    return serveArchiveBlob(env, id);
  }

  if (request.method === "GET" && pathname.startsWith("/api/archive/")) {
    const id = decodeURIComponent(pathname.slice("/api/archive/".length));
    if (!id) {
      throw new HttpError(400, "Card id is required.");
    }

    const item = await getArchivedCard(env, id, request.url);
    if (!item) {
      throw new HttpError(404, "Archived card not found.");
    }

    return json({ item });
  }

  if (request.method === "GET" && pathname.startsWith("/api/image/")) {
    const key = decodeURIComponent(pathname.slice("/api/image/".length));
    if (!key || !key.startsWith("active/")) {
      throw new HttpError(400, "Invalid image key.");
    }

    return serveR2Object(env, key);
  }

  if (request.method === "GET" && pathname === "/api/link-preview") {
    const target = url.searchParams.get("url")?.trim();
    if (!target) {
      throw new HttpError(400, "url query parameter is required.");
    }
    return json({ title: await fetchLinkTitle(target) });
  }

  throw new HttpError(404, "Route not found.");
}

function getConfig(env: Env): RuntimeConfig {
  return {
    appName: env.APP_NAME || "PocketRelay",
    archiveRetentionHours: Number.parseInt(env.ARCHIVE_RETENTION_HOURS || "72", 10),
    coolingAfterHours: Number.parseInt(env.COOLING_AFTER_HOURS || "24", 10),
    maxImageBytes: Number.parseInt(env.MAX_IMAGE_BYTES || "10485760", 10),
    accessEnabled: Boolean(env.APP_ACCESS_TOKEN?.trim()),
    shortcutEnabled: Boolean(env.SHORTCUT_TOKEN?.trim())
  };
}

async function createTextCard(
  env: Env,
  content: string,
  archivePayload: {
    salt: string;
    iv: string;
    ciphertext: string;
    blobIv: string | null;
    blobKey: string | null;
  } | null
): Promise<CardRow> {
  const type = detectTextCardType(content);
  const lang = type === "code" ? detectCodeLanguage(content) : null;
  const title = type === "link" ? await fetchLinkTitle(content) : null;
  const now = Date.now();
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `
      INSERT INTO cards (
        id, type, content, title, lang, created_at, updated_at,
        archive_salt, archive_iv, archive_ciphertext, archive_blob_iv, archive_blob_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      type,
      content,
      title,
      lang,
      now,
      now,
      archivePayload?.salt ?? null,
      archivePayload?.iv ?? null,
      archivePayload?.ciphertext ?? null,
      archivePayload?.blobIv ?? null,
      archivePayload?.blobKey ?? null
    )
    .run();

  const card = await getCardById(env, id);
  if (!card) {
    throw new HttpError(500, "Failed to load created card.");
  }

  return card;
}

async function listActiveCards(env: Env, requestUrl: string): Promise<ReturnType<typeof serializeActiveCard>[]> {
  const rows = await env.DB.prepare(
    `
      SELECT *
      FROM cards
      WHERE is_archived = 0
      ORDER BY created_at DESC
      LIMIT 200
    `
  ).all<CardRow>();

  const config = getConfig(env);
  return (rows.results || []).map((row) => serializeActiveCard(row, requestUrl, config));
}

async function listArchivedCards(
  env: Env,
  requestUrl: string
): Promise<ReturnType<typeof serializeArchivedCard>[]> {
  const rows = await env.DB.prepare(
    `
      SELECT *
      FROM cards
      WHERE is_archived = 1
      ORDER BY created_at DESC
      LIMIT 500
    `
  ).all<CardRow>();

  return (rows.results || []).map((row) => serializeArchivedCard(row, requestUrl));
}

async function getArchivedCard(
  env: Env,
  id: string,
  requestUrl: string
): Promise<ReturnType<typeof serializeArchivedCard> | null> {
  const row = await getCardById(env, id);
  if (!row || row.is_archived !== 1) {
    return null;
  }
  return serializeArchivedCard(row, requestUrl);
}

async function getCardById(env: Env, id: string): Promise<CardRow | null> {
  const row = await env.DB.prepare("SELECT * FROM cards WHERE id = ? LIMIT 1").bind(id).first<CardRow>();
  return row || null;
}

async function deleteCard(env: Env, id: string): Promise<void> {
  const row = await getCardById(env, id);
  if (!row) {
    throw new HttpError(404, "Card not found.");
  }

  // Delete DB row first — if R2 cleanup fails, we won't have dangling references
  await env.DB.prepare("DELETE FROM cards WHERE id = ?").bind(id).run();

  if (row.image_key) {
    await env.IMAGES.delete(row.image_key);
  }

  if (row.archive_blob_key) {
    await env.IMAGES.delete(row.archive_blob_key);
  }
}

async function updateTextArchiveMaterial(
  env: Env,
  row: CardRow,
  archivePayload: {
    salt: string;
    iv: string;
    ciphertext: string;
    blobIv: string | null;
    blobKey: string | null;
  }
): Promise<void> {
  if (row.type === "image") {
    throw new HttpError(400, "Image archive material must include an encrypted blob.");
  }

  await replaceArchiveBlob(env, row, null, null);

  await env.DB.prepare(
    `
      UPDATE cards
      SET
        archive_salt = ?,
        archive_iv = ?,
        archive_ciphertext = ?,
        archive_blob_iv = NULL,
        archive_blob_key = NULL,
        updated_at = ?
      WHERE id = ?
    `
  )
    .bind(archivePayload.salt, archivePayload.iv, archivePayload.ciphertext, Date.now(), row.id)
    .run();
}

async function updateImageArchiveMaterial(env: Env, row: CardRow, request: Request): Promise<void> {
  if (row.type !== "image") {
    throw new HttpError(400, "Text archive material must be sent as JSON.");
  }

  const formData = await request.formData();
  const archiveBlob = formData.get("archiveBlob");
  if (!isBlobLike(archiveBlob)) {
    throw new HttpError(400, "An archiveBlob field is required.");
  }

  const archivePayload = sanitizeArchivePayload({
    salt: formData.get("archiveSalt"),
    iv: formData.get("archiveIv"),
    ciphertext: formData.get("archiveCiphertext"),
    blobIv: formData.get("archiveBlobIv"),
    blobKey: null
  });

  if (!archivePayload?.blobIv) {
    throw new HttpError(400, "Archive blob metadata is required.");
  }

  const archiveBlobKey = `archive/${row.id}.bin`;
  await env.IMAGES.put(archiveBlobKey, await archiveBlob.arrayBuffer(), {
    httpMetadata: {
      contentType: "application/octet-stream"
    }
  });

  await replaceArchiveBlob(env, row, archiveBlobKey, archivePayload.blobIv);

  await env.DB.prepare(
    `
      UPDATE cards
      SET
        archive_salt = ?,
        archive_iv = ?,
        archive_ciphertext = ?,
        archive_blob_iv = ?,
        archive_blob_key = ?,
        updated_at = ?
      WHERE id = ?
    `
  )
    .bind(
      archivePayload.salt,
      archivePayload.iv,
      archivePayload.ciphertext,
      archivePayload.blobIv,
      archiveBlobKey,
      Date.now(),
      row.id
    )
    .run();
}

async function replaceArchiveBlob(
  env: Env,
  row: CardRow,
  nextBlobKey: string | null,
  _nextBlobIv: string | null
): Promise<void> {
  if (row.archive_blob_key && row.archive_blob_key !== nextBlobKey) {
    await env.IMAGES.delete(row.archive_blob_key);
  }
}

function isShortcutPushRequest(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "POST" && url.pathname === "/api/shortcut/push";
}

async function isAppAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.APP_ACCESS_TOKEN?.trim();
  if (!expected) {
    return true;
  }

  const received = getAppAccessToken(request);
  return received ? timingSafeEqual(received, expected) : false;
}

function getAppAccessToken(request: Request): string | null {
  const headerToken = request.headers.get("x-pocketrelay-access-token")?.trim();
  if (headerToken) {
    return headerToken;
  }

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) {
    return null;
  }

  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  if (!authorization.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = atob(authorization.slice("Basic ".length));
    const separatorIndex = decoded.indexOf(":");
    return separatorIndex >= 0 ? decoded.slice(separatorIndex + 1).trim() : decoded.trim();
  } catch {
    return null;
  }
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);

  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }

  return diff === 0;
}

function unauthorized(): Response {
  return json({ error: "Authentication required." }, 401, {
    "www-authenticate": 'Basic realm="PocketRelay", charset="UTF-8"'
  });
}

async function assertShortcutAuthorized(request: Request, env: Env): Promise<void> {
  const expected = env.SHORTCUT_TOKEN?.trim();
  if (!expected) {
    throw new HttpError(503, "Shortcut endpoint is not configured.");
  }

  const received = getShortcutToken(request);
  if (!received || !(await timingSafeEqual(received, expected))) {
    throw new HttpError(403, "Invalid shortcut token.");
  }
}

function getShortcutToken(request: Request): string | null {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token")?.trim();
  if (queryToken) {
    return queryToken;
  }

  const headerToken = request.headers.get("x-pocketrelay-token")?.trim();
  if (headerToken) {
    return headerToken;
  }

  const authorization = request.headers.get("authorization")?.trim();
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return null;
}

async function parseShortcutBody(request: Request): Promise<{ content: string }> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await parseJson<{ content?: unknown }>(request);
    return {
      content: typeof body.content === "string" ? body.content : ""
    };
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const content = form.get("content");
    return {
      content: typeof content === "string" ? content : ""
    };
  }

  const content = await request.text();
  return { content };
}

function serializeActiveCard(row: CardRow, requestUrl: string, config: RuntimeConfig) {
  const ageMs = Date.now() - row.created_at;
  const phase = ageMs >= config.coolingAfterHours * HOUR_IN_MS ? "cooling" : "active";
  const imageUrl = row.image_key
    ? buildAbsoluteUrl(requestUrl, `/api/image/${encodeURIComponent(row.image_key)}`)
    : null;
  const previewSource = row.type === "image" ? row.title || "Image" : row.title || row.content || "";

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    lang: row.lang,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preview: summarize(previewSource),
    phase,
    imageUrl,
    hasArchiveMaterial: Boolean(row.archive_ciphertext || row.archive_blob_key)
  };
}

function serializeArchivedCard(row: CardRow, requestUrl: string) {
  return {
    id: row.id,
    type: row.type,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    archiveDate: row.archive_date,
    archiveSalt: row.archive_salt,
    archiveIv: row.archive_iv,
    archiveCiphertext: row.archive_ciphertext,
    archiveBlobIv: row.archive_blob_iv,
    archiveBlobUrl: row.archive_blob_key
      ? buildAbsoluteUrl(requestUrl, `/api/archive/${encodeURIComponent(row.id)}/blob`)
      : null
  };
}

async function serveArchiveBlob(env: Env, id: string): Promise<Response> {
  const row = await getCardById(env, id);
  if (!row || row.is_archived !== 1 || !row.archive_blob_key) {
    throw new HttpError(404, "Archive blob not found.");
  }
  return serveR2Object(env, row.archive_blob_key, "application/octet-stream");
}

async function serveR2Object(env: Env, key: string, fallbackType?: string): Promise<Response> {
  const object = await env.IMAGES.get(key);
  if (!object) {
    throw new HttpError(404, "Object not found.");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (fallbackType && !headers.get("content-type")) {
    headers.set("content-type", fallbackType);
  }
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=60");
  return new Response(object.body, { headers });
}

async function archiveDueCards(env: Env): Promise<void> {
  const config = getConfig(env);
  const cutoff = Date.now() - config.archiveRetentionHours * HOUR_IN_MS;

  while (true) {
    const result = await env.DB.prepare(
      `
        SELECT *
        FROM cards
        WHERE is_archived = 0
          AND created_at <= ?
        ORDER BY created_at ASC
        LIMIT 100
      `
    )
      .bind(cutoff)
      .all<CardRow>();

    const rows = result.results || [];
    if (!rows.length) {
      return;
    }

    for (const row of rows) {
      const hasArchiveMaterial = Boolean(row.archive_ciphertext || row.archive_blob_key);

      if (!hasArchiveMaterial) {
        // No archive material — delete everything
        if (row.image_key) await env.IMAGES.delete(row.image_key);
        if (row.archive_blob_key) await env.IMAGES.delete(row.archive_blob_key);
        await env.DB.prepare("DELETE FROM cards WHERE id = ?").bind(row.id).run();
        continue;
      }

      if (row.type === "image" && !row.archive_blob_key) {
        // Image without encrypted blob — incomplete, delete
        if (row.image_key) await env.IMAGES.delete(row.image_key);
        await env.DB.prepare("DELETE FROM cards WHERE id = ?").bind(row.id).run();
        continue;
      }

      // Has archive material — archive: clear plaintext, keep encrypted data
      if (row.image_key) {
        await env.IMAGES.delete(row.image_key);
      }

      const now = Date.now();
      await env.DB.prepare(
        `
          UPDATE cards
          SET
            content = NULL,
            image_key = NULL,
            title = NULL,
            lang = NULL,
            is_archived = 1,
            archived_at = ?,
            archive_date = ?,
            updated_at = ?
          WHERE id = ?
        `
      )
        .bind(now, toArchiveDate(row.created_at), now, row.id)
        .run();
    }
  }
}

function detectTextCardType(content: string): Exclude<CardType, "image"> {
  if (/^https?:\/\/\S+$/i.test(content)) {
    return "link";
  }

  if (looksLikeCode(content)) {
    return "code";
  }

  return "text";
}

function looksLikeCode(content: string): boolean {
  const text = content.trim();
  if (!text.includes("\n")) {
    return false;
  }

  const signals = [
    /\b(function|const|let|var|class|return|import|export|interface|type)\b/,
    /\b(def|import|from|return|class|if __name__ == ["']__main__["'])\b/,
    /<\/?[A-Za-z][^>]*>/,
    /(^|\n)\s{2,}\S+/,
    /[{};]{2,}/
  ];

  return signals.filter((pattern) => pattern.test(text)).length >= 2;
}

function detectCodeLanguage(content: string): string | null {
  const probes: Array<[string, RegExp]> = [
    ["typescript", /\b(interface|type|implements|readonly|as const)\b/],
    ["javascript", /\b(function|const|let|=>|module\.exports|require\()\b/],
    ["python", /\b(def |import |from |print\(|self\b|elif\b)/],
    ["html", /<\/?[a-z][\s\S]*>/i],
    ["css", /[.#]?[a-z0-9_-]+\s*\{[\s\S]*:[\s\S]*\}/i],
    ["json", /^\s*[\[{][\s\S]*[\]}]\s*$/]
  ];

  const match = probes.find(([, pattern]) => pattern.test(content));
  return match?.[0] ?? null;
}

async function fetchLinkTitle(url: string): Promise<string | null> {
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return null;
  }

  // Block private/internal IPs (SSRF protection)
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
      headers: {
        "user-agent": "PocketRelay/1.0 (+https://workers.dev)",
        accept: "text/html,application/xhtml+xml"
      }
    });
    clearTimeout(timeout);

    // Don't follow redirects — prevents SSRF bypass via redirect chain
    if (response.status >= 300 && response.status < 400) {
      return null;
    }

    // Only read up to 64KB to prevent abuse
    const reader = response.body?.getReader();
    if (!reader) return null;

    let received = 0;
    const chunks: Uint8Array[] = [];
    const maxBytes = 64 * 1024;

    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    reader.cancel();

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const html = new TextDecoder().decode(merged);

    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
    if (ogTitle) {
      return decodeHtml(ogTitle).slice(0, 200);
    }

    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    return title ? decodeHtml(title).slice(0, 200) : null;
  } catch {
    return null;
  }
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function summarize(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 100 ? `${compact.slice(0, 97)}...` : compact;
}

function sanitizeArchivePayload(input: unknown): {
  salt: string;
  iv: string;
  ciphertext: string;
  blobIv: string | null;
  blobKey: string | null;
} | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = input as Record<string, unknown>;
  const salt = asString(value.salt);
  const iv = asString(value.iv);
  const ciphertext = asString(value.ciphertext);
  const blobIv = asOptionalString(value.blobIv);
  const blobKey = asOptionalString(value.blobKey);

  if (!salt || !iv || !ciphertext) {
    return null;
  }

  return {
    salt,
    iv,
    ciphertext,
    blobIv,
    blobKey
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isBlobLike(value: FormDataEntryValue | null): value is File {
  return typeof value === "object" && value !== null && "arrayBuffer" in value;
}

function toArchiveDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function getFileExtension(fileName: string, mimeType: string): string {
  const existing = fileName.match(/\.[A-Za-z0-9]+$/)?.[0];
  if (existing) {
    return existing.toLowerCase();
  }

  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif"
  };

  return map[mimeType] || ".bin";
}

function buildAbsoluteUrl(requestUrl: string, pathname: string): string {
  return new URL(pathname, requestUrl).toString();
}

async function parseJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");

  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  // No wildcard CORS — frontend is same-origin, external callers use token auth
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization,x-pocketrelay-token,x-pocketrelay-access-token");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
