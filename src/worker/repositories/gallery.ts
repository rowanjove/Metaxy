export interface GalleryImageRow {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  original_size_bytes?: number | null;
  thumb_object_key?: string | null;
  width: number | null;
  height: number | null;
  hash: string | null;
  favorite?: number;
  album_id?: string | null;
  dominant_color?: string | null;
  metadata_json?: string | null;
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
        original_size_bytes, thumb_object_key, width, height, hash,
        favorite, album_id, dominant_color, metadata_json,
        created_at, view_count, last_viewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      image.id,
      image.object_key,
      image.filename,
      image.content_type,
      image.size_bytes,
      image.original_size_bytes ?? null,
      image.thumb_object_key ?? null,
      image.width ?? null,
      image.height ?? null,
      image.hash ?? null,
      image.favorite ?? 0,
      image.album_id ?? null,
      image.dominant_color ?? null,
      image.metadata_json ?? null,
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

export interface ListGalleryImagesOptions {
  limit?: number;
  cursor?: string;
  albumId?: string;
  favorite?: boolean;
  search?: string;
}

export async function listGalleryImages(
  db: D1Database,
  options: ListGalleryImagesOptions
): Promise<{ items: GalleryImageRow[]; nextCursor: string | null; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);

  const conditions: string[] = ["status = 'active'"];
  const params: any[] = [];

  if (options.albumId !== undefined) {
    if (options.albumId === "") {
      conditions.push("album_id IS NULL");
    } else {
      conditions.push("album_id = ?");
      params.push(options.albumId);
    }
  }

  if (options.favorite !== undefined) {
    conditions.push("favorite = ?");
    params.push(options.favorite ? 1 : 0);
  }

  if (options.search && options.search.trim()) {
    conditions.push("(filename LIKE ? OR id LIKE ?)");
    const pattern = `%${options.search.trim()}%`;
    params.push(pattern, pattern);
  }

  const whereClause = conditions.join(" AND ");

  const totalRow = await db
    .prepare(`SELECT COUNT(*) as count FROM gallery_images WHERE ${whereClause}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  const parsedCursor = options.cursor ? decodeGalleryCursor(options.cursor) : null;
  if (options.cursor && !parsedCursor) {
    return { items: [], nextCursor: null, total };
  }

  let items: GalleryImageRow[];
  if (parsedCursor) {
    const cursorConditions = [...conditions, "(created_at < ? OR (created_at = ? AND id < ?))"];
    const cursorParams = [...params, parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id, limit + 1];
    items = (
      await db
        .prepare(
          `SELECT * FROM gallery_images
           WHERE ${cursorConditions.join(" AND ")}
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .bind(...cursorParams)
        .all<GalleryImageRow>()
    ).results;
  } else {
    items = (
      await db
        .prepare(
          `SELECT * FROM gallery_images
           WHERE ${whereClause}
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .bind(...params, limit + 1)
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

export async function setGalleryImageFavorite(
  db: D1Database,
  id: string,
  favorite: boolean
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE gallery_images SET favorite = ? WHERE id = ? AND status = 'active'")
    .bind(favorite ? 1 : 0, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function setGalleryImageAlbum(
  db: D1Database,
  id: string,
  albumId: string | null
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE gallery_images SET album_id = ? WHERE id = ? AND status = 'active'")
    .bind(albumId, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
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

export function isValidGalleryCursor(cursor: string): boolean {
  return Boolean(decodeGalleryCursor(cursor));
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

  const stmts = [
    db.prepare("UPDATE gallery_images SET status = 'deleting' WHERE id = ? AND status = 'active'").bind(id),
    db.prepare(
      `INSERT INTO gallery_object_deletions (object_key, image_id, created_at, not_before)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(object_key) DO UPDATE SET image_id = excluded.image_id`
    ).bind(image.object_key, image.id, now, now)
  ];

  if (image.thumb_object_key) {
    stmts.push(
      db.prepare(
        `INSERT INTO gallery_object_deletions (object_key, image_id, created_at, not_before)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(object_key) DO UPDATE SET image_id = excluded.image_id`
      ).bind(image.thumb_object_key, image.id, now, now)
    );
  }

  await db.batch(stmts);
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
  objectKey: string,
  thumbKey?: string | null
): Promise<void> {
  const stmts = [
    db.prepare("DELETE FROM gallery_images WHERE id = ? AND object_key = ?").bind(id, objectKey),
    db.prepare("DELETE FROM gallery_object_deletions WHERE object_key = ?").bind(objectKey)
  ];
  if (thumbKey) {
    stmts.push(db.prepare("DELETE FROM gallery_object_deletions WHERE object_key = ?").bind(thumbKey));
  }
  await db.batch(stmts);
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
    ? db.prepare("DELETE FROM gallery_images WHERE id = ? AND (object_key = ? OR thumb_object_key = ?)").bind(item.image_id, item.object_key, item.object_key)
    : db.prepare("DELETE FROM gallery_images WHERE object_key = ? OR thumb_object_key = ?").bind(item.object_key, item.object_key);
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
