export interface DropRow {
  id: string;
  code: string;
  status: "draft" | "active" | "revoked" | "deleting";
  draft_token_hash: string;
  created_at: number;
  expires_at: number;
  committed_at: number | null;
  delete_requested_at: number | null;
  view_count: number;
  last_viewed_at: number | null;
  total_size: number;
  item_count: number;
  delete_attempts: number;
  last_delete_attempt_at: number | null;
}

export interface AdminDropRowWithCounts extends DropRow {
  has_text: number;
  file_count: number;
}

export async function createDraftDrop(
  db: D1Database,
  drop: {
    id: string;
    code: string;
    draftTokenHash: string;
    createdAt: number;
    expiresAt: number;
  }
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO drops (
        id, code, status, draft_token_hash, created_at,
        expires_at, committed_at, delete_requested_at, view_count,
        last_viewed_at, total_size, item_count
      )
      VALUES (?, ?, 'draft', ?, ?, ?, NULL, NULL, 0, NULL, 0, 0)
      `
    )
    .bind(
      drop.id,
      drop.code,
      drop.draftTokenHash,
      drop.createdAt,
      drop.expiresAt
    )
    .run();
}

export async function getDropById(
  db: D1Database,
  id: string
): Promise<DropRow | null> {
  return db
    .prepare("SELECT * FROM drops WHERE id = ?")
    .bind(id)
    .first<DropRow>();
}

export async function getDropByCode(
  db: D1Database,
  code: string
): Promise<DropRow | null> {
  return db
    .prepare("SELECT * FROM drops WHERE code = ?")
    .bind(code)
    .first<DropRow>();
}

export async function commitDrop(
  db: D1Database,
  id: string,
  totalSize: number,
  itemCount: number,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `
      UPDATE drops
      SET status = 'active',
          committed_at = ?,
          total_size = ?,
          item_count = ?
      WHERE id = ? AND status = 'draft' AND expires_at > ?
      `
    )
    .bind(now, totalSize, itemCount, id, now)
    .run();
  return (result.meta?.changes || 0) > 0;
}

export async function incrementDropViewCount(
  db: D1Database,
  id: string,
  now: number
): Promise<void> {
  await db
    .prepare(
      `
      UPDATE drops
      SET view_count = view_count + 1,
          last_viewed_at = ?
      WHERE id = ?
      `
    )
    .bind(now, id)
    .run();
}

export async function extendDropExpiry(
  db: D1Database,
  id: string,
  newExpiresAt: number,
  expectedExpiresAt: number,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `
      UPDATE drops
      SET expires_at = ?
      WHERE id = ?
        AND status = 'active'
        AND expires_at = ?
        AND expires_at > ?
      `
    )
    .bind(newExpiresAt, id, expectedExpiresAt, now)
    .run();
  return (result.meta?.changes || 0) > 0;
}

export async function revokeDrop(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare(
      `
      UPDATE drops
      SET status = 'revoked'
      WHERE id = ?
      `
    )
    .bind(id)
    .run();
}

export async function markDropDeleting(
  db: D1Database,
  id: string,
  now: number
): Promise<void> {
  await db
    .prepare(
      `
      UPDATE drops
      SET status = 'deleting',
          delete_requested_at = COALESCE(delete_requested_at, ?)
      WHERE id = ?
      `
    )
    .bind(now, id)
    .run();
}

export async function deleteDrop(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare("DELETE FROM drops WHERE id = ?")
    .bind(id)
    .run();
}

export async function findExpiredDrafts(
  db: D1Database,
  cutoffTimestamp: number,
  limit: number = 100
): Promise<DropRow[]> {
  const result = await db
    .prepare(
      `
      SELECT * FROM drops
      WHERE status = 'draft' AND created_at <= ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
      `
    )
    .bind(cutoffTimestamp, limit)
    .all<DropRow>();
  return result.results || [];
}

export async function findExpiredActiveDrops(
  db: D1Database,
  now: number,
  limit: number = 100
): Promise<DropRow[]> {
  const result = await db
    .prepare(
      `
      SELECT * FROM drops
      WHERE status = 'active' AND expires_at <= ?
      ORDER BY expires_at ASC, id ASC
      LIMIT ?
      `
    )
    .bind(now, limit)
    .all<DropRow>();
  return result.results || [];
}

export const findDueDrafts = findExpiredDrafts;
export const findDueExpiredDrops = findExpiredActiveDrops;

export async function findRevokedDrops(
  db: D1Database,
  limit: number = 100
): Promise<DropRow[]> {
  const result = await db
    .prepare(
      `
      SELECT * FROM drops
      WHERE status = 'revoked'
      ORDER BY created_at ASC, id ASC
      LIMIT ?
      `
    )
    .bind(limit)
    .all<DropRow>();
  return result.results || [];
}

export async function findDeletingDrops(
  db: D1Database,
  now: number,
  limit: number = 100
): Promise<DropRow[]> {
  const result = await db
    .prepare(
      `
      SELECT * FROM drops
      WHERE status = 'deleting'
        AND delete_requested_at IS NOT NULL
        AND delete_requested_at <= ? - ?
        AND NOT EXISTS (
          SELECT 1 FROM files
          WHERE files.drop_id = drops.id
            AND COALESCE(files.presign_expires_at, 0) > ?
        )
        AND (
          last_delete_attempt_at IS NULL
          OR last_delete_attempt_at <= ? - MIN(3600000, 60000 * (delete_attempts + 1))
        )
      ORDER BY delete_attempts ASC,
               COALESCE(last_delete_attempt_at, 0) ASC,
               delete_requested_at ASC,
               id ASC
      LIMIT ?
      `
    )
    .bind(now, 30_000, now, now, limit)
    .all<DropRow>();
  return result.results || [];
}

export async function findDropsToMarkDeleting(
  db: D1Database,
  draftCutoff: number,
  now: number,
  limit: number = 50
): Promise<DropRow[]> {
  const result = await db
    .prepare(
      `
      SELECT * FROM drops
      WHERE (status = 'draft' AND created_at <= ?)
         OR (status = 'active' AND expires_at <= ?)
         OR status = 'revoked'
      ORDER BY CASE
        WHEN status = 'draft' THEN created_at
        WHEN status = 'active' THEN expires_at
        ELSE created_at
      END ASC, id ASC
      LIMIT ?
      `
    )
    .bind(draftCutoff, now, limit)
    .all<DropRow>();
  return result.results || [];
}

export async function markDropsDeleting(
  db: D1Database,
  ids: string[],
  now: number
): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(ids.map((id) => db.prepare(
    `
    UPDATE drops
    SET status = 'deleting',
        delete_requested_at = COALESCE(delete_requested_at, ?)
    WHERE id = ? AND status IN ('draft', 'active', 'revoked')
    `
  ).bind(now, id)));
}

export async function incrementDropDeletionAttempt(
  db: D1Database,
  id: string,
  now: number
): Promise<void> {
  await db.prepare(
    `
    UPDATE drops
    SET delete_attempts = delete_attempts + 1,
        last_delete_attempt_at = ?
    WHERE id = ? AND status = 'deleting'
    `
  ).bind(now, id).run();
}

export async function getAdminOverviewStats(
  db: D1Database,
  now: number
): Promise<{
  activeDropsCount: number;
  createdTodayCount: number;
  activeTotalFileBytes: number;
  expiringIn24hCount: number;
}> {
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startOfDayMs = startOfDay.getTime();
  const next24hMs = now + 24 * 3600 * 1000;

  const [activeRow, todayRow, expiringRow, sizeRow] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) as count FROM drops WHERE status = 'active' AND expires_at > ?"
      )
      .bind(now)
      .first<{ count: number }>(),
    db
      .prepare("SELECT COUNT(*) as count FROM drops WHERE created_at >= ?")
      .bind(startOfDayMs)
      .first<{ count: number }>(),
    db
      .prepare(
        `
        SELECT COUNT(*) as count FROM drops
        WHERE status = 'active' AND expires_at > ? AND expires_at <= ?
        `
      )
      .bind(now, next24hMs)
      .first<{ count: number }>(),
    db
      .prepare(
        "SELECT SUM(total_size) as total FROM drops WHERE status = 'active' AND expires_at > ?"
      )
      .bind(now)
      .first<{ total: number }>()
  ]);

  return {
    activeDropsCount: activeRow?.count || 0,
    createdTodayCount: todayRow?.count || 0,
    expiringIn24hCount: expiringRow?.count || 0,
    activeTotalFileBytes: sizeRow?.total || 0
  };
}

export interface AdminDropFilterOptions {
  cursorCreatedAt?: number;
  cursorId?: string;
  status?: string;
  searchCode?: string;
  limit?: number;
  now?: number;
}

export async function listDropsAdmin(
  db: D1Database,
  options: AdminDropFilterOptions
): Promise<AdminDropRowWithCounts[]> {
  const limit = Math.max(1, Math.min(50, options.limit || 50));
  const conditions: string[] = [];
  const params: any[] = [];
  const now = options.now || Date.now();

  if (options.searchCode) {
    conditions.push("d.code = ?");
    params.push(options.searchCode);
  }

  if (options.status) {
    if (options.status === "active") {
      conditions.push("d.status = 'active' AND d.expires_at > ?");
      params.push(now);
    } else if (options.status === "expired") {
      conditions.push("d.status = 'active' AND d.expires_at <= ?");
      params.push(now);
    } else if (["draft", "revoked", "deleting"].includes(options.status)) {
      conditions.push("d.status = ?");
      params.push(options.status);
    }
  }

  if (options.cursorCreatedAt !== undefined && options.cursorId) {
    conditions.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
    params.push(options.cursorCreatedAt, options.cursorCreatedAt, options.cursorId);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT d.*,
      (SELECT COUNT(*) FROM drop_items di WHERE di.drop_id = d.id AND di.type = 'text') as has_text,
      (SELECT COUNT(*) FROM drop_items di WHERE di.drop_id = d.id AND di.type = 'file') as file_count
    FROM drops d
    ${whereClause}
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT ?
  `;
  params.push(limit);

  const result = await db.prepare(sql).bind(...params).all<AdminDropRowWithCounts>();
  return result.results || [];
}
