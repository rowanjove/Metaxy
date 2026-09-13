export interface GalleryUploadRow {
  id: string;
  image_id: string;
  staging_object_key: string;
  thumb_staging_object_key: string | null;
  thumb_expected_size: number | null;
  filename: string;
  expected_size: number;
  expected_content_type: string;
  width: number | null;
  height: number | null;
  created_at: number;
  expires_at: number;
  status: "prepared" | "uploading" | "finalizing" | "completed" | "failed" | "expired";
}

export async function insertGalleryUpload(
  db: D1Database,
  upload: GalleryUploadRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gallery_uploads (
        id, image_id, staging_object_key, thumb_staging_object_key,
        thumb_expected_size, filename, expected_size, expected_content_type,
        width, height, created_at, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      upload.id,
      upload.image_id,
      upload.staging_object_key,
      upload.thumb_staging_object_key,
      upload.thumb_expected_size,
      upload.filename,
      upload.expected_size,
      upload.expected_content_type,
      upload.width,
      upload.height,
      upload.created_at,
      upload.expires_at,
      upload.status
    )
    .run();
}

export async function getGalleryUploadById(
  db: D1Database,
  id: string
): Promise<GalleryUploadRow | null> {
  return await db
    .prepare("SELECT * FROM gallery_uploads WHERE id = ?")
    .bind(id)
    .first<GalleryUploadRow>();
}

export async function updateGalleryUploadStatus(
  db: D1Database,
  id: string,
  status: GalleryUploadRow["status"]
): Promise<void> {
  await db
    .prepare("UPDATE gallery_uploads SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
}

/** Claim the single finalization attempt for an upload session. */
export async function claimGalleryUploadFinalization(
  db: D1Database,
  id: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE gallery_uploads
       SET status = 'finalizing'
       WHERE id = ?
         AND status IN ('prepared', 'uploading')
         AND expires_at > ?`
    )
    .bind(id, now)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteGalleryUpload(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare("DELETE FROM gallery_uploads WHERE id = ?")
    .bind(id)
    .run();
}

export async function listExpiredGalleryUploads(
  db: D1Database,
  now: number,
  limit = 50
): Promise<GalleryUploadRow[]> {
  return (
    await db
      .prepare(
        "SELECT * FROM gallery_uploads WHERE expires_at <= ? LIMIT ?"
      )
      .bind(now, limit)
      .all<GalleryUploadRow>()
  ).results;
}
