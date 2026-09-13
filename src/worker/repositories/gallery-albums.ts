export interface GalleryAlbumRow {
  id: string;
  name: string;
  slug: string;
  cover_image_id: string | null;
  created_at: number;
  updated_at: number;
}

export async function insertGalleryAlbum(
  db: D1Database,
  album: GalleryAlbumRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gallery_albums (id, name, slug, cover_image_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      album.id,
      album.name,
      album.slug,
      album.cover_image_id,
      album.created_at,
      album.updated_at
    )
    .run();
}

export async function getGalleryAlbumById(
  db: D1Database,
  id: string
): Promise<GalleryAlbumRow | null> {
  return await db
    .prepare("SELECT * FROM gallery_albums WHERE id = ?")
    .bind(id)
    .first<GalleryAlbumRow>();
}

export async function getGalleryAlbumBySlug(
  db: D1Database,
  slug: string
): Promise<GalleryAlbumRow | null> {
  return await db
    .prepare("SELECT * FROM gallery_albums WHERE slug = ?")
    .bind(slug)
    .first<GalleryAlbumRow>();
}

export async function listGalleryAlbums(
  db: D1Database
): Promise<GalleryAlbumRow[]> {
  return (
    await db
      .prepare("SELECT * FROM gallery_albums ORDER BY updated_at DESC")
      .all<GalleryAlbumRow>()
  ).results;
}

export async function updateGalleryAlbum(
  db: D1Database,
  id: string,
  data: { name?: string; slug?: string; cover_image_id?: string | null; updated_at: number }
): Promise<void> {
  const fields: string[] = [];
  const params: any[] = [];

  if (data.name !== undefined) {
    fields.push("name = ?");
    params.push(data.name);
  }
  if (data.slug !== undefined) {
    fields.push("slug = ?");
    params.push(data.slug);
  }
  if (data.cover_image_id !== undefined) {
    fields.push("cover_image_id = ?");
    params.push(data.cover_image_id);
  }
  fields.push("updated_at = ?");
  params.push(data.updated_at);

  params.push(id);
  await db
    .prepare(`UPDATE gallery_albums SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();
}

export async function deleteGalleryAlbum(
  db: D1Database,
  id: string
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE gallery_images SET album_id = NULL WHERE album_id = ?").bind(id),
    db.prepare("DELETE FROM gallery_albums WHERE id = ?").bind(id)
  ]);
}
