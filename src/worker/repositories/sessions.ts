export interface AdminSessionRow {
  id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

export async function createAdminSession(
  db: D1Database,
  id: string,
  tokenHash: string,
  createdAt: number,
  expiresAt: number
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      `
    )
    .bind(id, tokenHash, createdAt, expiresAt, createdAt)
    .run();
}

export async function getAdminSessionByTokenHash(
  db: D1Database,
  tokenHash: string
): Promise<AdminSessionRow | null> {
  const row = await db
    .prepare("SELECT * FROM admin_sessions WHERE token_hash = ? LIMIT 1")
    .bind(tokenHash)
    .first<AdminSessionRow>();
  return row || null;
}

export async function touchAdminSession(
  db: D1Database,
  id: string,
  now: number
): Promise<void> {
  await db
    .prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
}

export async function deleteAdminSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM admin_sessions WHERE id = ?").bind(id).run();
}

export async function deleteAllAdminSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM admin_sessions").run();
}

export async function cleanExpiredAdminSessions(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare("DELETE FROM admin_sessions WHERE expires_at <= ?")
    .bind(now)
    .run();
  return result.meta?.changes || 0;
}
