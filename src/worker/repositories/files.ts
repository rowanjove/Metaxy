export interface FileRow {
  id: string;
  drop_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  expected_size: number;
  actual_size: number | null;
  etag: string | null;
  status: "pending" | "uploaded";
  created_at: number;
  completed_at: number | null;
  presign_expires_at: number | null;
  upload_object_key: string | null;
  finalize_token: string | null;
  finalize_started_at: number | null;
}

export interface DropItemRow {
  id: string;
  drop_id: string;
  type: "text" | "file";
  sort_order: number;
  text_storage: "d1" | "r2" | null;
  text_content: string | null;
  text_object_key: string | null;
  file_id: string | null;
  size: number;
  created_at: number;
}

export interface ObjectDeletionRow {
  object_key: string;
  created_at: number;
  attempts: number;
  last_attempt_at: number | null;
  not_before: number;
}

export async function createPendingFile(
  db: D1Database,
  file: {
    id: string;
    dropId: string;
    objectKey: string;
    uploadObjectKey: string;
    filename: string;
    contentType: string;
    expectedSize: number;
    sortOrder: number;
    createdAt: number;
    presignExpiresAt: number;
  },
  maxDropFileBytes: number
): Promise<boolean> {
  const itemId = crypto.randomUUID();

  // Keep the capacity check in the same D1 transaction as the insert. A
  // separate SELECT followed by INSERT allows concurrent requests to exceed
  // the per-drop cumulative file limit.
  const capacityClause = `
        AND (
          SELECT COALESCE(SUM(COALESCE(actual_size, expected_size)), 0)
          FROM files
          WHERE drop_id = d.id
        ) + ? <= ?`;
  const fileParams: unknown[] = [
    file.id,
    file.dropId,
    file.objectKey,
    file.filename,
    file.contentType,
    file.expectedSize,
    file.createdAt,
    file.presignExpiresAt,
    file.dropId
  ];
  fileParams.push(file.expectedSize, maxDropFileBytes);

  const itemParams = [
    itemId,
    file.dropId,
    file.sortOrder,
    file.id,
    file.expectedSize,
    file.createdAt,
    file.id,
    file.dropId
  ];

  const results = await db.batch([
    db
      .prepare(
        `
        INSERT INTO files (
          id, drop_id, object_key, filename, content_type,
          expected_size, actual_size, etag, status, created_at,
          presign_expires_at, upload_object_key
        )
        SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, ?, ?
        FROM drops d
        WHERE d.id = ? AND d.status = 'draft'
        ${capacityClause}
        `
      )
      .bind(...fileParams.slice(0, 8), file.uploadObjectKey, ...fileParams.slice(8)),
    db
      .prepare(
        `
        INSERT INTO drop_items (
          id, drop_id, type, sort_order, text_storage, text_content,
          text_object_key, file_id, size, created_at
        )
        SELECT ?, ?, 'file', ?, NULL, NULL, NULL, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM files WHERE id = ? AND drop_id = ?
        )
        `
      )
      .bind(...itemParams)
  ]);

  return (results[0]?.meta?.changes || 0) > 0;
}

export async function markFileUploaded(
  db: D1Database,
  fileId: string,
  finalizeToken: string,
  finalObjectKey: string,
  actualSize: number,
  etag: string | null,
  completedAt: number
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `
        UPDATE files
        SET status = 'uploaded', object_key = ?, actual_size = ?, etag = ?, completed_at = ?,
            finalize_token = NULL, finalize_started_at = NULL
        WHERE id = ? AND status = 'pending' AND finalize_token = ?
        `
      )
      .bind(finalObjectKey, actualSize, etag, completedAt, fileId, finalizeToken),
    db
      .prepare(
        `
        UPDATE drop_items
        SET size = ?
        WHERE file_id = ? AND EXISTS (
          SELECT 1 FROM files WHERE id = ? AND status = 'uploaded'
        )
        `
      )
      .bind(actualSize, fileId, fileId)
  ]);
  return (results[0]?.meta?.changes || 0) > 0;
}

export async function claimPendingFileFinalization(
  db: D1Database,
  fileId: string,
  token: string,
  now: number
): Promise<boolean> {
  const result = await db.prepare(
    `
    UPDATE files
    SET finalize_token = ?, finalize_started_at = ?
    WHERE id = ? AND status = 'pending'
      AND (finalize_token IS NULL OR finalize_started_at <= ?)
    `
  ).bind(token, now, fileId, now - 10 * 60 * 1000).run();
  return (result.meta?.changes || 0) > 0;
}

export async function releasePendingFileFinalization(
  db: D1Database,
  fileId: string,
  token: string
): Promise<void> {
  await db.prepare(
    `
    UPDATE files
    SET finalize_token = NULL, finalize_started_at = NULL
    WHERE id = ? AND status = 'pending' AND finalize_token = ?
    `
  ).bind(fileId, token).run();
}

export async function refreshPendingFilePresign(
  db: D1Database,
  fileId: string,
  dropId: string,
  presignExpiresAt: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `
      UPDATE files
      SET presign_expires_at = ?
      WHERE id = ? AND drop_id = ? AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM drops
          WHERE drops.id = files.drop_id AND drops.status = 'draft'
        )
      `
    )
    .bind(presignExpiresAt, fileId, dropId)
    .run();
  return (result.meta?.changes || 0) > 0;
}

export async function getFileById(db: D1Database, id: string): Promise<FileRow | null> {
  const row = await db
    .prepare("SELECT * FROM files WHERE id = ? LIMIT 1")
    .bind(id)
    .first<FileRow>();
  return row || null;
}

export async function getFilesByDropId(db: D1Database, dropId: string): Promise<FileRow[]> {
  const result = await db
    .prepare("SELECT * FROM files WHERE drop_id = ? ORDER BY created_at ASC")
    .bind(dropId)
    .all<FileRow>();
  return result.results || [];
}

export async function getItemsByDropId(
  db: D1Database,
  dropId: string
): Promise<DropItemRow[]> {
  const result = await db
    .prepare("SELECT * FROM drop_items WHERE drop_id = ? ORDER BY sort_order ASC")
    .bind(dropId)
    .all<DropItemRow>();
  return result.results || [];
}

export async function getTextItemByDropId(
  db: D1Database,
  dropId: string
): Promise<DropItemRow | null> {
  const row = await db
    .prepare("SELECT * FROM drop_items WHERE drop_id = ? AND type = 'text' LIMIT 1")
    .bind(dropId)
    .first<DropItemRow>();
  return row || null;
}

export async function upsertTextItem(
  db: D1Database,
  dropId: string,
  textStorage: "d1" | "r2",
  textContent: string | null,
  textObjectKey: string | null,
  size: number,
  now: number
): Promise<{ updated: boolean; oldObjectKeyToDelete?: string }> {
  const existing = await getTextItemByDropId(db, dropId);
  const oldKey = existing?.text_object_key || undefined;

  if (existing) {
    const result = await db
      .prepare(
        `
        UPDATE drop_items
        SET text_storage = ?, text_content = ?, text_object_key = ?, size = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM drops
          WHERE drops.id = drop_items.drop_id AND drops.status = 'draft'
        )
        `
      )
      .bind(textStorage, textContent, textObjectKey, size, existing.id)
      .run();
    if ((result.meta?.changes || 0) === 0) {
      return { updated: false };
    }
  } else {
    const id = crypto.randomUUID();
    try {
      const result = await db
        .prepare(
          `
          INSERT INTO drop_items (
            id, drop_id, type, sort_order, text_storage,
            text_content, text_object_key, file_id, size, created_at
          )
          SELECT ?, ?, 'text', 0, ?, ?, ?, NULL, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM drops WHERE id = ? AND status = 'draft'
          )
          `
        )
        .bind(id, dropId, textStorage, textContent, textObjectKey, size, now, dropId)
        .run();
      if ((result.meta?.changes || 0) === 0) {
        return { updated: false };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("UNIQUE constraint failed: drop_items.drop_id")) {
        throw error;
      }
      return upsertTextItem(db, dropId, textStorage, textContent, textObjectKey, size, now);
    }
  }

  // If old R2 text is being replaced with D1 or different key, queue old key for deletion
  let needDeleteKey: string | undefined;
  if (oldKey && oldKey !== textObjectKey) {
    await recordObjectDeletion(db, oldKey, now, now);
    needDeleteKey = oldKey;
  }
  return { updated: true, oldObjectKeyToDelete: needDeleteKey };
}

export async function deleteTextItem(
  db: D1Database,
  dropId: string,
  now: number
): Promise<{ deleted: boolean; oldObjectKeyToDelete?: string }> {
  const existing = await getTextItemByDropId(db, dropId);
  if (!existing) {
    return { deleted: true };
  }

  const result = await db
    .prepare(
      `
      DELETE FROM drop_items
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM drops
        WHERE drops.id = drop_items.drop_id AND drops.status = 'draft'
      )
      `
    )
    .bind(existing.id)
    .run();
  if ((result.meta?.changes || 0) === 0) {
    return { deleted: false };
  }

  let needDeleteKey: string | undefined;
  if (existing.text_object_key) {
    await recordObjectDeletion(db, existing.text_object_key, now, now);
    needDeleteKey = existing.text_object_key;
  }
  return { deleted: true, oldObjectKeyToDelete: needDeleteKey };
}

export async function recordObjectDeletion(
  db: D1Database,
  objectKey: string,
  now: number = Date.now(),
  notBefore: number = now
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO object_deletions (object_key, created_at, attempts, not_before)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(object_key) DO UPDATE SET
        not_before = MAX(object_deletions.not_before, excluded.not_before)
      `
    )
    .bind(objectKey, now, notBefore)
    .run();
}

export async function extendObjectDeletionNotBefore(
  db: D1Database,
  objectKey: string,
  notBefore: number
): Promise<void> {
  await db.prepare(
    `
    UPDATE object_deletions
    SET not_before = MAX(not_before, ?)
    WHERE object_key = ?
    `
  ).bind(notBefore, objectKey).run();
}

export async function listPendingObjectDeletions(
  db: D1Database,
  limit: number = 10,
  now: number = Date.now()
): Promise<ObjectDeletionRow[]> {
  const result = await db
    .prepare(
      `
      SELECT * FROM object_deletions
       WHERE not_before <= ?
         AND (
           last_attempt_at IS NULL
           OR last_attempt_at <= ? - MIN(3600000, 60000 * (attempts + 1))
         )
       ORDER BY attempts ASC, COALESCE(last_attempt_at, 0) ASC, created_at ASC
       LIMIT ?
      `
    )
    .bind(now, now, limit)
    .all<ObjectDeletionRow>();
  return result.results || [];
}

export async function removeObjectDeletion(
  db: D1Database,
  objectKey: string
): Promise<void> {
  await db
    .prepare("DELETE FROM object_deletions WHERE object_key = ?")
    .bind(objectKey)
    .run();
}

export async function incrementObjectDeletionAttempt(
  db: D1Database,
  objectKey: string,
  now: number
): Promise<void> {
  await db
    .prepare(
      `
      UPDATE object_deletions
      SET attempts = attempts + 1, last_attempt_at = ?
      WHERE object_key = ?
      `
    )
    .bind(now, objectKey)
    .run();
}
