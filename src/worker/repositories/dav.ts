export interface DriveDeviceRow {
  id: string;
  name: string;
  username: string;
  credential_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface DavLockRow {
  token: string;
  node_id: string | null;
  path_key: string;
  owner: string | null;
  depth: "0" | "1" | "infinity";
  scope: "exclusive" | "shared";
  device_id: string;
  created_at: number;
  expires_at: number;
}

export async function createDriveDevice(db: D1Database, row: DriveDeviceRow): Promise<void> {
  await db.prepare(
    `INSERT INTO drive_devices (id, name, username, credential_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(row.id, row.name, row.username, row.credential_hash, row.created_at).run();
}

export async function listDriveDevices(db: D1Database): Promise<DriveDeviceRow[]> {
  const result = await db.prepare(
    "SELECT * FROM drive_devices WHERE revoked_at IS NULL ORDER BY created_at DESC"
  ).all<DriveDeviceRow>();
  return result.results || [];
}

export async function findActiveDriveDevice(db: D1Database, username: string, hash: string): Promise<DriveDeviceRow | null> {
  return (await db.prepare(
    "SELECT * FROM drive_devices WHERE username = ? AND credential_hash = ? AND revoked_at IS NULL LIMIT 1"
  ).bind(username, hash).first<DriveDeviceRow>()) || null;
}

export async function touchDriveDevice(db: D1Database, id: string, now: number): Promise<void> {
  // WebDAV clients issue several requests per directory operation. Keep the
  // audit timestamp useful without turning every authenticated request into a
  // D1 write.
  await db.prepare(
    "UPDATE drive_devices SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at <= ?)"
  ).bind(now, id, now - 60 * 60 * 1000).run();
}

export async function revokeDriveDevice(db: D1Database, id: string, now: number): Promise<boolean> {
  const result = await db.batch([
    db.prepare("UPDATE drive_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id),
    db.prepare("DELETE FROM dav_locks WHERE device_id = ?").bind(id)
  ]);
  return (result[0]?.meta?.changes || 0) > 0;
}

export async function createDavLock(db: D1Database, row: DavLockRow): Promise<void> {
  await db.prepare(
    `INSERT INTO dav_locks (token, node_id, path_key, owner, depth, scope, device_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.token, row.node_id, row.path_key, row.owner, row.depth, row.scope, row.device_id, row.created_at, row.expires_at).run();
}

export async function getDavLock(db: D1Database, token: string): Promise<DavLockRow | null> {
  return (await db.prepare("SELECT * FROM dav_locks WHERE token = ? LIMIT 1").bind(token).first<DavLockRow>()) || null;
}

export async function listActiveDavLocks(db: D1Database, pathKey: string, now: number): Promise<DavLockRow[]> {
  const result = await db.prepare(
    "SELECT * FROM dav_locks WHERE path_key = ? AND expires_at > ? ORDER BY created_at ASC"
  ).bind(pathKey, now).all<DavLockRow>();
  return result.results || [];
}

export async function listActiveDavLocksForPath(db: D1Database, pathKey: string, now: number): Promise<DavLockRow[]> {
  const result = await db.prepare(
    `SELECT * FROM dav_locks
     WHERE expires_at > ?
       AND (path_key = ? OR path_key = '/' OR ? = '/' OR substr(?, 1, length(path_key) + 1) = path_key || '/')
     ORDER BY created_at ASC`
  ).bind(now, pathKey, pathKey, pathKey).all<DavLockRow>();
  const targetSegments = pathKey.split("/").filter(Boolean).length;
  return (result.results || []).filter((lock) => {
    if (lock.path_key === pathKey) return true;
    const lockSegments = lock.path_key.split("/").filter(Boolean).length;
    const distance = targetSegments - lockSegments;
    return distance > 0 && (lock.depth === "infinity" || (lock.depth === "1" && distance === 1));
  });
}

/**
 * Return locks that overlap a newly-created lock at the requested depth.
 * Unlike operation checks, a parent lock with Depth: 0 does not conflict with
 * an existing child lock; Depth: 1 conflicts with direct children and
 * Depth: infinity conflicts with every descendant.
 */
export async function listConflictingDavLocksForCreation(
  db: D1Database,
  pathKey: string,
  depth: "0" | "1" | "infinity",
  now: number
): Promise<DavLockRow[]> {
  const result = await db.prepare(
    "SELECT * FROM dav_locks WHERE expires_at > ? ORDER BY created_at ASC"
  ).bind(now).all<DavLockRow>();
  const rows = result.results || [];
  const target = pathKey === "/" ? "" : pathKey.replace(/\/$/, "");
  const targetSegments = target.split("/").filter(Boolean).length;
  return rows.filter((lock) => {
    const lockPath = lock.path_key === "/" ? "" : lock.path_key.replace(/\/$/, "");
    if (lockPath === target) return true;

    // An existing ancestor lock may already cover the requested target.
    if (target.startsWith(`${lockPath}/`)) {
      const distance = targetSegments - lockPath.split("/").filter(Boolean).length;
      if (lock.depth === "infinity" || (lock.depth === "1" && distance === 1)) return true;
    }

    // The requested collection lock may cover an existing descendant lock.
    if (lockPath.startsWith(`${target}/`)) {
      const distance = lockPath.split("/").filter(Boolean).length - targetSegments;
      return depth === "infinity" || (depth === "1" && distance === 1);
    }
    return false;
  });
}

/**
 * Return every active lock that would be affected by a tree mutation.
 * DELETE/MOVE/COPY of a collection changes all descendants, so a child lock
 * must block the operation as well as locks on the target or its ancestors.
 */
export async function listActiveDavLocksForSubtree(db: D1Database, pathKey: string, now: number): Promise<DavLockRow[]> {
  const result = await db.prepare(
    "SELECT * FROM dav_locks WHERE expires_at > ? ORDER BY created_at ASC"
  ).bind(now).all<DavLockRow>();
  const rows = result.results || [];
  const target = pathKey === "/" ? "" : pathKey.replace(/\/$/, "");
  return rows.filter((lock) => {
    const lockPath = lock.path_key === "/" ? "" : lock.path_key.replace(/\/$/, "");
    if (lockPath === target) return true;
    if (target.startsWith(`${lockPath}/`)) {
      const distance = target.slice(lockPath.length + 1).split("/").filter(Boolean).length;
      return lock.depth === "infinity" || (lock.depth === "1" && distance === 1);
    }
    return lockPath.startsWith(`${target}/`);
  });
}

export async function refreshDavLock(db: D1Database, token: string, deviceId: string, expiresAt: number, now = Date.now()): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE dav_locks SET expires_at = ? WHERE token = ? AND device_id = ? AND expires_at > ?"
  ).bind(expiresAt, token, deviceId, now).run();
  return (result.meta?.changes || 0) > 0;
}

export async function deleteDavLock(db: D1Database, token: string, deviceId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM dav_locks WHERE token = ? AND device_id = ?").bind(token, deviceId).run();
  return (result.meta?.changes || 0) > 0;
}

export async function cleanExpiredDavLocks(db: D1Database, now: number, limit = 100): Promise<number> {
  const result = await db.prepare("DELETE FROM dav_locks WHERE expires_at <= ? AND rowid IN (SELECT rowid FROM dav_locks WHERE expires_at <= ? LIMIT ?)").bind(now, now, limit).run();
  return result.meta?.changes || 0;
}
