export interface GalleryImageRow {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  hash: string | null;
  created_at: number;
  view_count: number;
  last_viewed_at: number | null;
  status?: "active" | "deleting";
}

export interface GalleryObjectDeletionRow {
  object_key: string;
  image_id: string | null;
  created_at: number;
  not_before: number;
  attempts: number;
  last_attempt_at: number | null;
}

export async function insertGalleryImage(
  db: D1Database,
  image: GalleryImageRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gallery_images (
        id, object_key, filename, content_type, size_bytes,
        width, height, hash, created_at, view_count, last_viewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      image.id,
      image.object_key,
      image.filename,
      image.content_type,
      image.size_bytes,
      image.width,
      image.height,
      image.hash,
      image.created_at,
      image.view_count,
      image.last_viewed_at
    )
    .run();
}

export async function getGalleryImageById(
  db: D1Database,
  id: string
): Promise<GalleryImageRow | null> {
  return await db
    .prepare("SELECT * FROM gallery_images WHERE id = ?")
    .bind(id)
    .first<GalleryImageRow>();
}

export async function getGalleryImageByHash(
  db: D1Database,
  hash: string
): Promise<GalleryImageRow | null> {
  return await db
    .prepare("SELECT * FROM gallery_images WHERE hash = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1")
    .bind(hash)
    .first<GalleryImageRow>();
}

export async function incrementGalleryImageView(
  db: D1Database,
  id: string,
  viewedAt: number
): Promise<void> {
  await db
    .prepare(
      "UPDATE gallery_images SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?"
    )
    .bind(viewedAt, id)
    .run();
}

export async function listGalleryImages(
  db: D1Database,
  options: { limit?: number; cursor?: string }
): Promise<{ items: GalleryImageRow[]; nextCursor: string | null; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);

  const totalRow = await db
    .prepare("SELECT COUNT(*) as count FROM gallery_images WHERE status = 'active'")
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  let query: string;
  let items: GalleryImageRow[];

  const parsedCursor = options.cursor ? decodeGalleryCursor(options.cursor) : null;
  if (options.cursor && !parsedCursor) {
    return { items: [], nextCursor: null, total };
  }

  if (parsedCursor) {
    items = (
      await db
        .prepare(
          `SELECT * FROM gallery_images
           WHERE status = 'active'
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .bind(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id, limit + 1)
        .all<GalleryImageRow>()
    ).results;
  } else {
    items = (
      await db
        .prepare("SELECT * FROM gallery_images WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT ?")
        .bind(limit + 1)
        .all<GalleryImageRow>()
    ).results;
  }

  let nextCursor: string | null = null;
  if (items.length > limit) {
    items.pop();
    const lastItem = items[items.length - 1];
    nextCursor = lastItem ? encodeGalleryCursor(lastItem.created_at, lastItem.id) : null;
  }

  return { items, nextCursor, total };
}

export async function deleteGalleryImage(
  db: D1Database,
  id: string
): Promise<GalleryImageRow | null> {
  const image = await getGalleryImageById(db, id);
  if (!image) return null;

  await db.prepare("DELETE FROM gallery_images WHERE id = ?").bind(id).run();
  return image;
}

export function encodeGalleryCursor(createdAt: number, id: string): string {
  const raw = JSON.stringify({ createdAt, id });
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeGalleryCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "number" || !Number.isSafeInteger(parsed.createdAt) || typeof parsed.id !== "string" || !parsed.id) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function markGalleryImageDeleting(
  db: D1Database,
  id: string,
  now: number
): Promise<GalleryImageRow | null> {
  const image = await getGalleryImageById(db, id);
  if (!image || (image.status !== undefined && image.status !== "active" && image.status !== "deleting")) {
    return null;
  }
  if (image.status === "deleting") return image;

  await db.batch([
    db.prepare("UPDATE gallery_images SET status = 'deleting' WHERE id = ? AND status = 'active'").bind(id),
    db.prepare(
      `INSERT INTO gallery_object_deletions (object_key, image_id, created_at, not_before)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(object_key) DO UPDATE SET image_id = excluded.image_id`
    ).bind(image.object_key, image.id, now, now)
  ]);
  return { ...image, status: "deleting" };
}

export async function recordGalleryObjectDeletion(
  db: D1Database,
  objectKey: string,
  imageId: string | null,
  now: number = Date.now(),
  notBefore: number = now
): Promise<void> {
  await db.prepare(
    `INSERT INTO gallery_object_deletions (object_key, image_id, created_at, not_before)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET
       image_id = COALESCE(gallery_object_deletions.image_id, excluded.image_id),
       not_before = MAX(gallery_object_deletions.not_before, excluded.not_before)`
  ).bind(objectKey, imageId, now, notBefore).run();
}

export async function removeGalleryObjectDeletion(db: D1Database, objectKey: string): Promise<void> {
  await db.prepare("DELETE FROM gallery_object_deletions WHERE object_key = ?").bind(objectKey).run();
}

export async function finalizeGalleryImageDeletion(
  db: D1Database,
  id: string,
  objectKey: string
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM gallery_images WHERE id = ? AND object_key = ?").bind(id, objectKey),
    db.prepare("DELETE FROM gallery_object_deletions WHERE object_key = ?").bind(objectKey)
  ]);
}

export async function listGalleryObjectDeletions(
  db: D1Database,
  now: number,
  limit: number
): Promise<GalleryObjectDeletionRow[]> {
  const result = await db.prepare(
    `SELECT * FROM gallery_object_deletions
     WHERE not_before <= ?
       AND (last_attempt_at IS NULL OR last_attempt_at <= ? - MIN(3600000, 60000 * (attempts + 1)))
     ORDER BY attempts ASC, COALESCE(last_attempt_at, 0) ASC, created_at ASC LIMIT ?`
  ).bind(now, now, Math.min(Math.max(limit, 1), 100)).all<GalleryObjectDeletionRow>();
  return result.results || [];
}

export async function finalizeGalleryObjectDeletion(
  db: D1Database,
  item: GalleryObjectDeletionRow
): Promise<void> {
  const imageDelete = item.image_id
    ? db.prepare("DELETE FROM gallery_images WHERE id = ? AND object_key = ?").bind(item.image_id, item.object_key)
    : db.prepare("DELETE FROM gallery_images WHERE object_key = ?").bind(item.object_key);
  await db.batch([
    imageDelete,
    db.prepare("DELETE FROM gallery_object_deletions WHERE object_key = ?").bind(item.object_key)
  ]);
}

export async function incrementGalleryObjectDeletionAttempt(
  db: D1Database,
  objectKey: string,
  now: number
): Promise<void> {
  await db.prepare(
    "UPDATE gallery_object_deletions SET attempts = attempts + 1, last_attempt_at = ? WHERE object_key = ?"
  ).bind(now, objectKey).run();
}
