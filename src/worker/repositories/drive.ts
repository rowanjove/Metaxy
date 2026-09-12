import type {
  DriveNodeRecord,
  DriveNodeStatus,
  DriveUploadRecord,
  DriveObjectDeletionRecord
} from "../../shared/drive-contracts";

export interface DriveOverviewStats {
  activeNodeCount: number;
  activeFileCount: number;
  activeBytes: number;
  trashedNodeCount: number;
  pendingUploadCount: number;
  activeDeviceCount: number;
}

export async function getDriveOverviewStats(db: D1Database): Promise<DriveOverviewStats> {
  const result = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM drive_nodes WHERE status = 'active') AS active_node_count,
       (SELECT COUNT(*) FROM drive_nodes WHERE status = 'active' AND kind = 'file') AS active_file_count,
       (SELECT COALESCE(SUM(size), 0) FROM drive_nodes WHERE status = 'active' AND kind = 'file') AS active_bytes,
       (SELECT COUNT(*) FROM drive_nodes WHERE status = 'trashed') AS trashed_node_count,
       (SELECT COUNT(*) FROM drive_uploads WHERE status IN ('prepared', 'completing')) AS pending_upload_count,
       (SELECT COUNT(*) FROM drive_devices WHERE revoked_at IS NULL) AS active_device_count`
  ).first<Record<string, number>>();
  return {
    activeNodeCount: Number(result?.active_node_count || 0),
    activeFileCount: Number(result?.active_file_count || 0),
    activeBytes: Number(result?.active_bytes || 0),
    trashedNodeCount: Number(result?.trashed_node_count || 0),
    pendingUploadCount: Number(result?.pending_upload_count || 0),
    activeDeviceCount: Number(result?.active_device_count || 0)
  };
}

export async function getDriveNode(db: D1Database, id: string): Promise<DriveNodeRecord | null> {
  return (await db.prepare("SELECT * FROM drive_nodes WHERE id = ? LIMIT 1").bind(id).first<DriveNodeRecord>()) || null;
}

export async function getDriveRoot(db: D1Database): Promise<DriveNodeRecord | null> {
  return (await db.prepare("SELECT * FROM drive_nodes WHERE system_role = 'root' LIMIT 1").first<DriveNodeRecord>()) || null;
}

export async function getDriveInbox(db: D1Database): Promise<DriveNodeRecord | null> {
  return (await db.prepare("SELECT * FROM drive_nodes WHERE system_role = 'inbox' LIMIT 1").first<DriveNodeRecord>()) || null;
}

export async function listDriveChildren(
  db: D1Database,
  parentId: string,
  limit: number,
  cursor?: { nameKey: string; id: string }
): Promise<DriveNodeRecord[]> {
  // REST callers request at most 200 rows per cursor page. WebDAV has no
  // cursor mechanism for a single PROPFIND response, so it may request up to
  // 1,000 direct children to satisfy the large-directory compatibility target.
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 1000);
  const where = cursor ? "AND (name_key > ? OR (name_key = ? AND id > ?))" : "";
  const params = cursor ? [parentId, cursor.nameKey, cursor.nameKey, cursor.id, bounded] : [parentId, bounded];
  const result = await db.prepare(
    `SELECT * FROM drive_nodes
     WHERE parent_id = ? AND status = 'active' ${where}
     ORDER BY name_key ASC, id ASC LIMIT ?`
  ).bind(...params).all<DriveNodeRecord>();
  return result.results || [];
}

export async function listDriveDescendants(db: D1Database, id: string, limit?: number): Promise<DriveNodeRecord[]> {
  const sql = `WITH RECURSIVE tree(id) AS (
       SELECT id FROM drive_nodes WHERE id = ?
       UNION ALL
       SELECT n.id FROM drive_nodes n JOIN tree t ON n.parent_id = t.id AND n.id != t.id
     )
     SELECT n.* FROM drive_nodes n JOIN tree t ON n.id = t.id
     ORDER BY CASE WHEN n.kind = 'file' THEN 0 ELSE 1 END, n.id${limit ? " LIMIT ?" : ""}`;
  const result = (limit ? db.prepare(sql).bind(id, limit) : db.prepare(sql).bind(id));
  const rows = await result.all<DriveNodeRecord>();
  return rows.results || [];
}

export async function createDriveFolder(
  db: D1Database,
  node: Pick<DriveNodeRecord, "id" | "parent_id" | "name" | "name_key" | "created_at" | "updated_at">,
  systemRole: "inbox" | null = null
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO drive_nodes
      (id, parent_id, kind, name, name_key, system_role, status, version, created_at, updated_at)
     SELECT ?, ?, 'folder', ?, ?, ?, 'active', 1, ?, ?
     WHERE EXISTS (SELECT 1 FROM drive_nodes WHERE id = ? AND kind = 'folder' AND status = 'active')`
  ).bind(node.id, node.parent_id, node.name, node.name_key, systemRole, node.created_at, node.updated_at, node.parent_id).run();
  return (result.meta?.changes || 0) > 0;
}

export async function prepareDriveUpload(
  db: D1Database,
  upload: Pick<DriveUploadRecord, "id" | "parent_id" | "name" | "name_key" | "upload_object_key" | "final_object_key" | "expected_size" | "expected_content_type" | "presign_expires_at" | "created_at">
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO drive_uploads
      (id, parent_id, name, name_key, upload_object_key, final_object_key,
       expected_size, expected_content_type, presign_expires_at, status, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?
     WHERE EXISTS (SELECT 1 FROM drive_nodes WHERE id = ? AND kind = 'folder' AND status = 'active')`
  ).bind(
    upload.id, upload.parent_id, upload.name, upload.name_key, upload.upload_object_key,
    upload.final_object_key, upload.expected_size, upload.expected_content_type,
    upload.presign_expires_at, upload.created_at, upload.parent_id
  ).run();
  return (result.meta?.changes || 0) > 0;
}

export async function getDriveUpload(db: D1Database, id: string): Promise<DriveUploadRecord | null> {
  return (await db.prepare("SELECT * FROM drive_uploads WHERE id = ? LIMIT 1").bind(id).first<DriveUploadRecord>()) || null;
}

export async function listExpiredDriveUploads(db: D1Database, now: number, limit = 50): Promise<DriveUploadRecord[]> {
  const result = await db.prepare(
     `SELECT * FROM drive_uploads
     WHERE ((status IN ('prepared', 'failed') AND presign_expires_at <= ?)
        OR (status = 'completing' AND finalize_started_at <= ? - 600000))
     ORDER BY presign_expires_at ASC LIMIT ?`
  ).bind(now, now, Math.min(Math.max(limit, 1), 100)).all<DriveUploadRecord>();
  return result.results || [];
}

export async function abortDriveUpload(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("UPDATE drive_uploads SET status = 'aborted', finalize_token = NULL, finalize_started_at = NULL WHERE id = ? AND status IN ('prepared', 'failed', 'completing')").bind(id).run();
  return (result.meta?.changes || 0) > 0;
}

export async function claimDriveUpload(db: D1Database, id: string, token: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE drive_uploads
     SET status = 'completing', finalize_token = ?, finalize_started_at = ?
     WHERE id = ? AND status = 'prepared'`
  ).bind(token, now, id).run();
  return (result.meta?.changes || 0) > 0;
}

export async function releaseDriveUpload(db: D1Database, id: string, token: string, failed = false): Promise<void> {
  await db.prepare(
    `UPDATE drive_uploads
     SET status = ?, finalize_token = NULL, finalize_started_at = NULL,
         failure_reason = CASE WHEN ? = 1 THEN 'completion_failed' ELSE failure_reason END
     WHERE id = ? AND finalize_token = ?`
  ).bind(failed ? "failed" : "prepared", failed ? 1 : 0, id, token).run();
}

export async function commitDriveUpload(
  db: D1Database,
  upload: DriveUploadRecord,
  node: DriveNodeRecord,
  token: string,
  actualSize: number,
  etag: string | null,
  now: number
): Promise<boolean> {
  const result = await db.batch([
    db.prepare(
      `INSERT INTO drive_nodes
        (id, parent_id, kind, name, name_key, status, object_key, content_type, size,
         etag, version, created_at, updated_at)
       SELECT ?, ?, 'file', ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?
       WHERE EXISTS (SELECT 1 FROM drive_nodes WHERE id = ? AND kind = 'folder' AND status = 'active')
         AND EXISTS (SELECT 1 FROM drive_uploads WHERE id = ? AND status = 'completing' AND finalize_token = ?)`
    ).bind(
      node.id, upload.parent_id, upload.name, upload.name_key, upload.final_object_key,
      upload.expected_content_type, actualSize, etag, now, now, upload.parent_id, upload.id, token
    ),
    db.prepare(
      `UPDATE drive_uploads
       SET node_id = ?, status = 'completed', completed_at = ?, finalize_token = NULL, finalize_started_at = NULL
       WHERE id = ? AND status = 'completing' AND finalize_token = ?`
    ).bind(node.id, now, upload.id, token),
    db.prepare(
      `INSERT INTO drive_object_deletions (object_key, node_id, created_at, not_before)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(object_key) DO UPDATE SET node_id = excluded.node_id, not_before = MAX(drive_object_deletions.not_before, excluded.not_before)`
    ).bind(upload.upload_object_key, node.id, now, upload.presign_expires_at + 10 * 60 * 1000)
  ]);
  return (result[0]?.meta?.changes || 0) > 0 && (result[1]?.meta?.changes || 0) > 0;
}

export async function commitDavFile(
  db: D1Database,
  node: DriveNodeRecord,
  existing: DriveNodeRecord | null,
  now: number
): Promise<boolean> {
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    if (existing.kind !== "file" || existing.status !== "active") return false;
    // Queue the old object before bumping the node version. D1 batches are
    // atomic, so the marker rolls back if the optimistic update loses a race.
    if (existing.object_key) {
      statements.push(db.prepare(
        `INSERT INTO drive_object_deletions (object_key, node_id, created_at, not_before)
         SELECT ?, id, ?, ? FROM drive_nodes
         WHERE id = ? AND kind = 'file' AND status = 'active'
         AND parent_id = ? AND name_key = ? AND version = ?
         ON CONFLICT(object_key) DO UPDATE SET not_before = MAX(drive_object_deletions.not_before, excluded.not_before)`
      ).bind(existing.object_key, now, now + 30 * 24 * 60 * 60 * 1000, existing.id, existing.parent_id, existing.name_key, existing.version));
    }
    statements.push(db.prepare(
      `UPDATE drive_nodes SET object_key = ?, content_type = ?, size = ?, etag = ?,
       version = version + 1, updated_at = ?
       WHERE id = ? AND kind = 'file' AND status = 'active'
         AND parent_id = ? AND name_key = ? AND version = ?`
    ).bind(node.object_key, node.content_type, node.size, node.etag, now, existing.id, existing.parent_id, existing.name_key, existing.version));
  } else {
    statements.push(db.prepare(
      `INSERT INTO drive_nodes
       (id, parent_id, kind, name, name_key, status, object_key, content_type, size, etag, version, created_at, updated_at)
       SELECT ?, ?, 'file', ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?
       WHERE EXISTS (SELECT 1 FROM drive_nodes WHERE id = ? AND kind = 'folder' AND status = 'active')`
    ).bind(node.id, node.parent_id, node.name, node.name_key, node.object_key, node.content_type, node.size, node.etag, now, now, node.parent_id));
  }
  const result = await db.batch(statements);
  return (result.at(-1)?.meta?.changes || 0) > 0;
}

export async function findActiveChild(db: D1Database, parentId: string, nameKey: string): Promise<DriveNodeRecord | null> {
  return (await db.prepare("SELECT * FROM drive_nodes WHERE parent_id = ? AND name_key = ? AND status = 'active' LIMIT 1").bind(parentId, nameKey).first<DriveNodeRecord>()) || null;
}

export async function moveDriveNodeToName(
  db: D1Database,
  id: string,
  parentId: string,
  name: string,
  nameKey: string,
  version: number,
  now: number
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE drive_nodes SET parent_id = ?, name = ?, name_key = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'active' AND version = ?
       AND EXISTS (SELECT 1 FROM drive_nodes WHERE id = ? AND kind = 'folder' AND status = 'active')`
  ).bind(parentId, name, nameKey, now, id, version, parentId).run();
  return (result.meta?.changes || 0) > 0;
}

export async function moveDriveNodeToNameOverwrite(
  db: D1Database,
  id: string,
  targetId: string | null,
  targetVersion: number,
  parentId: string,
  name: string,
  nameKey: string,
  version: number,
  now: number
): Promise<boolean> {
  const statements: D1PreparedStatement[] = [];
  if (targetId) {
    // Capture the target's old object while its expected path/version still
    // match. The following status update and the source move are in the same
    // atomic D1 batch.
    statements.push(db.prepare(
      `INSERT INTO drive_object_deletions (object_key, node_id, created_at, not_before)
       SELECT object_key, id, ?, ? FROM drive_nodes
       WHERE id = ? AND kind = 'file' AND status = 'active'
         AND parent_id = ? AND name_key = ? AND version = ? AND object_key IS NOT NULL
       ON CONFLICT(object_key) DO UPDATE SET not_before = MAX(drive_object_deletions.not_before, excluded.not_before)`
    ).bind(now, now + 30 * 24 * 60 * 60 * 1000, targetId, parentId, nameKey, targetVersion));
    statements.push(db.prepare(
      `UPDATE drive_nodes SET status = 'trashed', trashed_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND kind = 'file' AND status = 'active'
         AND parent_id = ? AND name_key = ? AND version = ?`
    ).bind(now, now, targetId, parentId, nameKey, targetVersion));
  }
  statements.push(db.prepare(
    `UPDATE drive_nodes SET parent_id = ?, name = ?, name_key = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'active' AND version = ?
       AND EXISTS (SELECT 1 FROM drive_nodes WHERE id = ? AND kind = 'folder' AND status = 'active')`
  ).bind(parentId, name, nameKey, now, id, version, parentId));
  const result = await db.batch(statements);
  return (result.at(-1)?.meta?.changes || 0) > 0;
}

export async function renameDriveNode(
  db: D1Database,
  id: string,
  name: string,
  nameKey: string,
  version: number,
  now: number
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE drive_nodes SET name = ?, name_key = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'active' AND version = ?`
  ).bind(name, nameKey, now, id, version).run();
  return (result.meta?.changes || 0) > 0;
}

export async function moveDriveNode(
  db: D1Database,
  id: string,
  parentId: string,
  version: number,
  now: number
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE drive_nodes SET parent_id = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'active' AND version = ?
       AND EXISTS (SELECT 1 FROM drive_nodes p WHERE p.id = ? AND p.kind = 'folder' AND p.status = 'active')`
  ).bind(parentId, now, id, version, parentId).run();
  return (result.meta?.changes || 0) > 0;
}

export async function trashDriveSubtree(db: D1Database, nodes: DriveNodeRecord[], now: number): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const node of nodes) {
    if (node.system_role) continue;
    statements.push(db.prepare(
      `UPDATE drive_nodes SET status = 'trashed', trashed_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'active'`
    ).bind(now, now, node.id));
    if (node.kind === "file" && node.object_key) {
      statements.push(db.prepare(
        `INSERT INTO drive_object_deletions (object_key, node_id, created_at, not_before)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(object_key) DO UPDATE SET not_before = MAX(drive_object_deletions.not_before, excluded.not_before)`
      ).bind(node.object_key, node.id, now, now + 30 * 24 * 60 * 60 * 1000));
    }
  }
  // Keep batches well below D1's statement ceiling. A large folder can have
  // two statements per file (state transition plus object queue entry).
  for (let offset = 0; offset < statements.length; offset += 40) {
    await db.batch(statements.slice(offset, offset + 40));
  }
}

export async function restoreDriveNode(db: D1Database, id: string, now: number): Promise<boolean> {
  const result = await db.batch([
    db.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM drive_nodes WHERE id = ?
       UNION ALL SELECT n.id FROM drive_nodes n JOIN tree t ON n.parent_id = t.id AND n.id != t.id
     )
     UPDATE drive_nodes SET status = 'active', trashed_at = NULL, version = version + 1, updated_at = ?
     WHERE id IN (SELECT id FROM tree) AND status = 'trashed'
       AND (drive_nodes.id = ? OR EXISTS (
         SELECT 1 FROM drive_nodes p WHERE p.id = drive_nodes.parent_id AND p.id IN (SELECT id FROM tree)
       ))`
    ).bind(id, now, id),
    db.prepare(
      `DELETE FROM drive_object_deletions AS d
       WHERE d.node_id IN (
         WITH RECURSIVE tree(id) AS (
           SELECT id FROM drive_nodes WHERE id = ?
           UNION ALL SELECT n.id FROM drive_nodes n JOIN tree t ON n.parent_id = t.id AND n.id != t.id
          ) SELECT id FROM tree
       )
       AND EXISTS (
         SELECT 1 FROM drive_nodes n
         WHERE n.id = d.node_id AND n.status = 'active' AND n.object_key = d.object_key
       )`
     ).bind(id)
  ]);
  return (result[0]?.meta?.changes || 0) > 0;
}

/**
 * Atomically claim a queued object deletion before touching R2.
 *
 * A restore and this transition are serialized by D1. If restore wins, the
 * node is active and this function returns `active`, so cleanup must retain
 * the object. If cleanup wins, the node becomes `deleting` and restore can no
 * longer make it visible again. A node already in that state is safe to retry
 * after a crashed R2 delete because R2 deletion is idempotent.
 */
export async function claimDriveObjectDeletion(
  db: D1Database,
  item: Pick<DriveObjectDeletionRecord, "object_key" | "node_id">,
  now: number
): Promise<"claimed" | "active" | "stale"> {
  if (!item.node_id) return "claimed";
  const transition = await db.prepare(
    `UPDATE drive_nodes
     SET status = 'deleting', version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'trashed' AND object_key = ?`
  ).bind(now, item.node_id, item.object_key).run();
  if ((transition.meta?.changes || 0) > 0) return "claimed";

  const node = await getDriveNode(db, item.node_id);
  if (!node || (node.status === "deleting" && node.object_key === item.object_key)) return "claimed";
  if (node.status === "active" && node.object_key === item.object_key) return "active";
  return "stale";
}

/**
 * Remove the queue marker and its terminal node after the R2 delete succeeds.
 * The second statement deliberately checks that the node is gone, because a
 * failed/contended metadata delete must leave the queue available for retry.
 */
export async function finalizeDriveObjectDeletion(
  db: D1Database,
  objectKey: string,
  nodeId: string
): Promise<boolean> {
  const result = await db.batch([
    db.prepare(
      "DELETE FROM drive_nodes WHERE id = ? AND status = 'deleting' AND object_key = ?"
    ).bind(nodeId, objectKey),
    db.prepare(
      `DELETE FROM drive_object_deletions
       WHERE object_key = ? AND (node_id = ? OR node_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM drive_nodes WHERE id = ?)`
    ).bind(objectKey, nodeId, nodeId)
  ]);
  return (result[0]?.meta?.changes || 0) > 0 || (result[1]?.meta?.changes || 0) > 0;
}

export async function listDriveObjectDeletions(db: D1Database, now: number, limit: number): Promise<DriveObjectDeletionRecord[]> {
  const result = await db.prepare(
    `SELECT * FROM drive_object_deletions
     WHERE not_before <= ? AND (last_attempt_at IS NULL OR last_attempt_at <= ? - MIN(3600000, 60000 * (attempts + 1)))
     ORDER BY attempts ASC, COALESCE(last_attempt_at, 0) ASC, created_at ASC LIMIT ?`
  ).bind(now, now, Math.min(Math.max(limit, 1), 100)).all<DriveObjectDeletionRecord>();
  return result.results || [];
}

export async function recordDriveObjectDeletion(db: D1Database, objectKey: string, nodeId: string | null, now: number, notBefore = now): Promise<void> {
  await db.prepare(
    `INSERT INTO drive_object_deletions (object_key, node_id, created_at, not_before)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET not_before = MAX(drive_object_deletions.not_before, excluded.not_before)`
  ).bind(objectKey, nodeId, now, notBefore).run();
}

export async function removeDriveObjectDeletion(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM drive_object_deletions WHERE object_key = ?").bind(key).run();
}

export async function incrementDriveObjectDeletionAttempt(db: D1Database, key: string, now: number): Promise<void> {
  await db.prepare("UPDATE drive_object_deletions SET attempts = attempts + 1, last_attempt_at = ? WHERE object_key = ?").bind(now, key).run();
}

export async function findDriveNodeByPath(db: D1Database, names: string[]): Promise<DriveNodeRecord | null> {
  let parent = await getDriveRoot(db);
  if (!parent) return null;
  for (const name of names) {
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    parent = (await db.prepare(
      "SELECT * FROM drive_nodes WHERE parent_id = ? AND name_key = ? AND status = 'active' LIMIT 1"
    ).bind(parent.id, key).first<DriveNodeRecord>()) || null;
    if (!parent) return null;
  }
  return parent;
}

export async function findDriveNodesByName(db: D1Database, query: string, limit: number): Promise<DriveNodeRecord[]> {
  const result = await db.prepare(
    `SELECT * FROM drive_nodes WHERE status = 'active' AND name LIKE ? ESCAPE '\\'
     ORDER BY name_key ASC, id ASC LIMIT ?`
  ).bind(`%${query.replace(/[\\%_]/g, "\\$&").slice(0, 50)}%`, Math.min(Math.max(limit, 1), 100)).all<DriveNodeRecord>();
  return result.results || [];
}

export async function listDriveNodesByStatus(db: D1Database, status: DriveNodeStatus, limit: number): Promise<DriveNodeRecord[]> {
  const result = await db.prepare("SELECT * FROM drive_nodes WHERE status = ? ORDER BY trashed_at DESC, updated_at DESC LIMIT ?").bind(status, Math.min(Math.max(limit, 1), 200)).all<DriveNodeRecord>();
  return result.results || [];
}
