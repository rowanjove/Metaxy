import type { Env } from "../../src/worker/env";

export interface MockR2StoredObject {
  data: Uint8Array;
  httpMetadata?: Record<string, any>;
  customMetadata?: Record<string, any>;
  etag: string;
}

export function createMockR2(): R2Bucket & { store: Map<string, MockR2StoredObject> } {
  const store = new Map<string, MockR2StoredObject>();

  return {
    store,
    async head(key: string): Promise<R2Object | null> {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        key,
        size: obj.data.byteLength,
        httpEtag: obj.etag,
        etag: obj.etag,
        httpMetadata: obj.httpMetadata as any,
        customMetadata: obj.customMetadata as any,
        writeHttpMetadata: (headers: Headers) => {
          if (obj.httpMetadata?.contentType) {
            headers.set("content-type", obj.httpMetadata.contentType);
          }
        }
      } as any;
    },

    async get(key: string, _options?: any): Promise<R2ObjectBody | null> {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        key,
        size: obj.data.byteLength,
        httpEtag: obj.etag,
        etag: obj.etag,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(obj.data);
            controller.close();
          }
        }),
        httpMetadata: obj.httpMetadata as any,
        customMetadata: obj.customMetadata as any,
        writeHttpMetadata: (headers: Headers) => {
          if (obj.httpMetadata?.contentType) {
            headers.set("content-type", obj.httpMetadata.contentType);
          }
        },
        async arrayBuffer() {
          return obj.data.buffer;
        },
        async text() {
          return new TextDecoder().decode(obj.data);
        }
      } as any;
    },

    async put(key: string, value: any, options?: any): Promise<R2Object> {
      let data: Uint8Array;
      if (typeof value === "string") {
        data = new TextEncoder().encode(value);
      } else if (value instanceof ArrayBuffer) {
        data = new Uint8Array(value);
      } else if (value instanceof Uint8Array) {
        data = value;
      } else if (value instanceof ReadableStream) {
        data = new Uint8Array(await new Response(value).arrayBuffer());
      } else if (value instanceof Blob) {
        data = new Uint8Array(await value.arrayBuffer());
      } else {
        data = new Uint8Array();
      }

      const etag = `"${crypto.randomUUID()}"`;
      const stored: MockR2StoredObject = {
        data,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
        etag
      };
      store.set(key, stored);

      return {
        key,
        size: data.byteLength,
        httpEtag: etag,
        etag
      } as any;
    },

    async delete(keys: string | string[]): Promise<void> {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        store.delete(k);
      }
    }
  } as any;
}

export function createMockD1(): D1Database {
  // Simple in-memory tables
  const drops = new Map<string, any>();
  const files = new Map<string, any>();
  const dropItems = new Map<string, any>();
  const settings = new Map<string, any>();
  const adminSessions = new Map<string, any>();
  const objectDeletions = new Map<string, any>();

  // Default seed settings
  settings.set("site_name", { key: "site_name", value: "PocketRelay", updated_at: Date.now() });
  settings.set("default_expiry_seconds", { key: "default_expiry_seconds", value: "86400", updated_at: Date.now() });
  settings.set("max_expiry_seconds", { key: "max_expiry_seconds", value: "604800", updated_at: Date.now() });
  settings.set("max_file_bytes", { key: "max_file_bytes", value: "52428800", updated_at: Date.now() });
  settings.set("max_drop_file_bytes", { key: "max_drop_file_bytes", value: "524288000", updated_at: Date.now() });
  settings.set("max_files_per_drop", { key: "max_files_per_drop", value: "10", updated_at: Date.now() });
  settings.set("max_text_bytes", { key: "max_text_bytes", value: "5242880", updated_at: Date.now() });
  settings.set("code_length", { key: "code_length", value: "6", updated_at: Date.now() });
  settings.set("allow_public_risky_files", { key: "allow_public_risky_files", value: "false", updated_at: Date.now() });

  function executeQuery(sql: string, params: any[]): any {
    const s = sql.replace(/\s+/g, " ").trim();

    // 1. drops queries
    if (s.startsWith("INSERT INTO drops")) {
      const [id, code, draft_token_hash, created_at, expires_at] = params;
      drops.set(id, {
        id,
        code,
        status: "draft",
        draft_token_hash,
        created_at,
        expires_at,
        committed_at: null,
        delete_requested_at: null,
        view_count: 0,
        last_viewed_at: null,
        total_size: 0,
        item_count: 0,
        delete_attempts: 0,
        last_delete_attempt_at: null
      });
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("SELECT * FROM drops WHERE id = ?")) {
      const drop = drops.get(params[0]) || null;
      return drop;
    }

    if (s.startsWith("SELECT * FROM drops WHERE code = ?")) {
      const drop = Array.from(drops.values()).find((d) => d.code === params[0]) || null;
      return drop;
    }

    if (s.startsWith("SELECT * FROM drops WHERE status = 'draft' AND created_at <=")) {
      const cutoff = params[0];
      const limit = params[1] || 100;
      const list = Array.from(drops.values())
        .filter((d) => d.status === "draft" && d.created_at <= cutoff)
        .slice(0, limit);
      return { results: list };
    }

    if (s.startsWith("SELECT * FROM drops WHERE status = 'active' AND expires_at <=")) {
      const cutoff = params[0];
      const limit = params[1] || 100;
      const list = Array.from(drops.values())
        .filter((d) => d.status === "active" && d.expires_at <= cutoff)
        .slice(0, limit);
      return { results: list };
    }

    if (s.startsWith("SELECT * FROM drops WHERE status = 'revoked'")) {
      const limit = params[0] || 100;
      const list = Array.from(drops.values())
        .filter((d) => d.status === "revoked")
        .slice(0, limit);
      return { results: list };
    }

    if (s.startsWith("SELECT * FROM drops WHERE status = 'deleting'")) {
      const [now, settleMs, presignNow, retryNow, requestedLimit] = params;
      const limit = requestedLimit || 100;
      const list = Array.from(drops.values())
        .filter((d) => {
          if (d.status !== "deleting" || d.delete_requested_at === null) return false;
          if (d.delete_requested_at > now - settleMs) return false;
          if (Array.from(files.values()).some((f) => f.drop_id === d.id && (f.presign_expires_at || 0) > presignNow)) {
            return false;
          }
          const retryDelay = Math.min(3_600_000, 60_000 * ((d.delete_attempts || 0) + 1));
          return d.last_delete_attempt_at === null || d.last_delete_attempt_at <= retryNow - retryDelay;
        })
        .sort((a, b) => (a.delete_attempts - b.delete_attempts)
          || ((a.last_delete_attempt_at || 0) - (b.last_delete_attempt_at || 0))
          || (a.delete_requested_at - b.delete_requested_at))
        .slice(0, limit);
      return { results: list };
    }

    if (s.startsWith("SELECT * FROM drops WHERE (status = 'draft'")) {
      const [draftCutoff, now, requestedLimit] = params;
      const limit = requestedLimit || 50;
      const list = Array.from(drops.values())
        .filter((d) => (d.status === "draft" && d.created_at <= draftCutoff)
          || (d.status === "active" && d.expires_at <= now)
          || d.status === "revoked")
        .sort((a, b) => {
          const aDue = a.status === "active" ? a.expires_at : a.created_at;
          const bDue = b.status === "active" ? b.expires_at : b.created_at;
          return aDue - bDue || a.id.localeCompare(b.id);
        })
        .slice(0, limit);
      return { results: list };
    }

    if (s.startsWith("UPDATE drops SET status = 'active'")) {
      const [committed_at, total_size, item_count, id, now] = params;
      const drop = drops.get(id);
      if (!drop || drop.status !== "draft" || (typeof now === "number" && drop.expires_at <= now)) {
        return { meta: { changes: 0 } };
      }
      drop.status = "active";
      drop.committed_at = committed_at;
      drop.total_size = total_size;
      drop.item_count = item_count;
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE drops SET view_count = view_count + 1")) {
      const [now, id] = params;
      const drop = drops.get(id);
      if (drop) {
        drop.view_count++;
        drop.last_viewed_at = now;
      }
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE drops SET expires_at = ? WHERE id = ?")) {
      const [expires_at, id] = params;
      const drop = drops.get(id);
      if (drop) drop.expires_at = expires_at;
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE drops SET status = 'revoked'")) {
      const drop = drops.get(params[0]);
      if (drop) drop.status = "revoked";
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE drops SET status = 'deleting'")) {
      const [now, id] = params;
      const drop = drops.get(id);
      if (drop) {
        drop.status = "deleting";
        drop.delete_requested_at ??= now;
      }
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE drops SET delete_attempts = delete_attempts + 1")) {
      const [now, id] = params;
      const drop = drops.get(id);
      if (!drop || drop.status !== "deleting") return { meta: { changes: 0 } };
      drop.delete_attempts++;
      drop.last_delete_attempt_at = now;
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("DELETE FROM drops WHERE id = ?")) {
      drops.delete(params[0]);
      // Cascade delete files & items
      for (const [k, v] of Array.from(files.entries())) {
        if (v.drop_id === params[0]) files.delete(k);
      }
      for (const [k, v] of Array.from(dropItems.entries())) {
        if (v.drop_id === params[0]) dropItems.delete(k);
      }
      return { meta: { changes: 1 } };
    }

    // 2. files queries
    if (s.startsWith("INSERT INTO files")) {
      if (s.includes("FROM drops d")) {
        const [id, drop_id, object_key, filename, content_type, expected_size, created_at, presign_expires_at, upload_object_key, dropCheckId, sizeForCheck, limit] = params;
        const drop = drops.get(dropCheckId);
        const currentTotal = Array.from(files.values())
          .filter((file) => file.drop_id === dropCheckId)
          .reduce((sum, file) => sum + (file.actual_size ?? file.expected_size), 0);
        if (!drop || drop.status !== "draft" || currentTotal + sizeForCheck > limit) {
          return { meta: { changes: 0 } };
        }
        files.set(id, {
          id,
          drop_id,
          object_key,
          filename,
          content_type,
          expected_size,
          actual_size: null,
          etag: null,
          status: "pending",
          created_at,
          completed_at: null,
          presign_expires_at,
          upload_object_key,
          finalize_token: null,
          finalize_started_at: null
        });
        return { meta: { changes: 1 } };
      }
      const [id, drop_id, object_key, filename, content_type, expected_size, created_at, presign_expires_at, upload_object_key] = params;
      files.set(id, {
        id,
        drop_id,
        object_key,
        filename,
        content_type,
        expected_size,
        actual_size: null,
        etag: null,
        status: "pending",
        created_at,
        completed_at: null,
        presign_expires_at,
        upload_object_key,
        finalize_token: null,
        finalize_started_at: null
      });
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE files SET status = 'uploaded'")) {
      const [object_key, actual_size, etag, completed_at, id, finalize_token] = params;
      const f = files.get(id);
      const changed = f?.status === "pending" && f.finalize_token === finalize_token;
      if (changed) {
        f.status = "uploaded";
        f.object_key = object_key;
        f.actual_size = actual_size;
        f.etag = etag;
        f.completed_at = completed_at;
        f.finalize_token = null;
        f.finalize_started_at = null;
      }
      return { meta: { changes: changed ? 1 : 0 } };
    }

    if (s.startsWith("UPDATE files SET finalize_token = ?, finalize_started_at = ?")) {
      const [token, now, id, staleBefore] = params;
      const f = files.get(id);
      if (!f || f.status !== "pending" || (f.finalize_token && f.finalize_started_at > staleBefore)) {
        return { meta: { changes: 0 } };
      }
      f.finalize_token = token;
      f.finalize_started_at = now;
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE files SET finalize_token = NULL")) {
      const [id, token] = params;
      const f = files.get(id);
      if (!f || f.status !== "pending" || f.finalize_token !== token) {
        return { meta: { changes: 0 } };
      }
      f.finalize_token = null;
      f.finalize_started_at = null;
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE files SET presign_expires_at = ?")) {
      const [presign_expires_at, id, drop_id] = params;
      const f = files.get(id);
      const drop = drops.get(drop_id);
      if (!f || f.drop_id !== drop_id || f.status !== "pending" || drop?.status !== "draft") {
        return { meta: { changes: 0 } };
      }
      f.presign_expires_at = presign_expires_at;
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("SELECT * FROM files WHERE id = ?")) {
      return files.get(params[0]) || null;
    }

    if (s.startsWith("SELECT * FROM files WHERE drop_id = ?")) {
      const list = Array.from(files.values()).filter((f) => f.drop_id === params[0]);
      return { results: list };
    }

    // 3. drop_items queries
    if (s.startsWith("INSERT INTO drop_items")) {
      if (s.includes("'text'")) {
        const [id, drop_id, text_storage, text_content, text_object_key, size, created_at, dropCheckId] = params;
        if (s.includes("WHERE EXISTS") && drops.get(dropCheckId)?.status !== "draft") {
          return { meta: { changes: 0 } };
        }
        dropItems.set(id, {
          id,
          drop_id,
          type: "text",
          sort_order: 0,
          text_storage,
          text_content,
          text_object_key,
          file_id: null,
          size,
          created_at
        });
      } else {
        const [id, drop_id, sort_order, file_id, size, created_at] = params;
        if (s.includes("WHERE EXISTS") && !files.has(file_id)) {
          return { meta: { changes: 0 } };
        }
        if (Array.from(dropItems.values()).some((item) => item.drop_id === drop_id && item.sort_order === sort_order)) {
          throw new Error("UNIQUE constraint failed: drop_items.drop_id, drop_items.sort_order");
        }
        dropItems.set(id, {
          id,
          drop_id,
          type: "file",
          sort_order,
          text_storage: null,
          text_content: null,
          text_object_key: null,
          file_id,
          size,
          created_at
        });
      }
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("SELECT * FROM drop_items WHERE drop_id = ? AND type = 'text'")) {
      const item = Array.from(dropItems.values()).find((i) => i.drop_id === params[0] && i.type === "text");
      return item || null;
    }

    if (s.startsWith("SELECT * FROM drop_items WHERE drop_id = ? ORDER BY sort_order")) {
      const list = Array.from(dropItems.values())
        .filter((i) => i.drop_id === params[0])
        .sort((a, b) => a.sort_order - b.sort_order);
      return { results: list };
    }

    if (s.startsWith("UPDATE drop_items SET size = ? WHERE file_id = ?")) {
      const [size, file_id] = params;
      const item = Array.from(dropItems.values()).find((i) => i.file_id === file_id);
      const file = files.get(file_id);
      if (item && file?.status === "uploaded") item.size = size;
      return { meta: { changes: item && file?.status === "uploaded" ? 1 : 0 } };
    }

    if (s.startsWith("UPDATE drop_items SET text_storage = ?")) {
      const [text_storage, text_content, text_object_key, size, id] = params;
      const item = dropItems.get(id);
      const drop = item ? drops.get(item.drop_id) : null;
      if (item && drop?.status === "draft") {
        item.text_storage = text_storage;
        item.text_content = text_content;
        item.text_object_key = text_object_key;
        item.size = size;
      }
      return { meta: { changes: item && drop?.status === "draft" ? 1 : 0 } };
    }

    if (s.startsWith("DELETE FROM drop_items WHERE id = ?")) {
      const item = dropItems.get(params[0]);
      const drop = item ? drops.get(item.drop_id) : null;
      if (item && (!s.includes("drops.status = 'draft'") || drop?.status === "draft")) {
        dropItems.delete(params[0]);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    // 4. settings queries
    if (s.startsWith("SELECT key, value FROM settings")) {
      return { results: Array.from(settings.values()) };
    }

    if (s.includes("INSERT INTO settings")) {
      const [key, value, updated_at] = params;
      settings.set(key, { key, value, updated_at });
      return { meta: { changes: 1 } };
    }

    // 5. sessions queries
    if (s.startsWith("INSERT INTO admin_sessions")) {
      const [id, token_hash, created_at, expires_at, last_seen_at] = params;
      adminSessions.set(id, { id, token_hash, created_at, expires_at, last_seen_at });
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("SELECT * FROM admin_sessions WHERE token_hash = ?")) {
      const sess = Array.from(adminSessions.values()).find((s) => s.token_hash === params[0]);
      return sess || null;
    }

    if (s.startsWith("UPDATE admin_sessions SET last_seen_at = ?")) {
      const [now, id] = params;
      const sess = adminSessions.get(id);
      if (sess) sess.last_seen_at = now;
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("DELETE FROM admin_sessions WHERE id = ?")) {
      adminSessions.delete(params[0]);
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("DELETE FROM admin_sessions WHERE expires_at <= ?")) {
      let count = 0;
      for (const [k, v] of Array.from(adminSessions.entries())) {
        if (v.expires_at <= params[0]) {
          adminSessions.delete(k);
          count++;
        }
      }
      return { meta: { changes: count } };
    }

    if (s.startsWith("DELETE FROM admin_sessions")) {
      adminSessions.clear();
      return { meta: { changes: 1 } };
    }

    // 6. object_deletions queries
    if (s.includes("INSERT INTO object_deletions")) {
      const [object_key, created_at, not_before] = params;
      const existing = objectDeletions.get(object_key);
      if (existing) {
        existing.not_before = Math.max(existing.not_before, not_before);
      } else {
        objectDeletions.set(object_key, { object_key, created_at, attempts: 0, last_attempt_at: null, not_before });
      }
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("SELECT * FROM object_deletions")) {
      const [now, retryNow, requestedLimit] = params;
      const limit = requestedLimit || 10;
      return { results: Array.from(objectDeletions.values())
        .filter((row) => row.not_before <= now
          && (row.last_attempt_at === null
            || row.last_attempt_at <= retryNow - Math.min(3_600_000, 60_000 * (row.attempts + 1))))
        .sort((a, b) => a.attempts - b.attempts
          || ((a.last_attempt_at || 0) - (b.last_attempt_at || 0))
          || a.created_at - b.created_at)
        .slice(0, limit) };
    }

    if (s.startsWith("DELETE FROM object_deletions WHERE object_key = ?")) {
      objectDeletions.delete(params[0]);
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE object_deletions SET attempts = attempts + 1")) {
      const [now, object_key] = params;
      const obj = objectDeletions.get(object_key);
      if (obj) {
        obj.attempts++;
        obj.last_attempt_at = now;
      }
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE object_deletions SET not_before = MAX")) {
      const [notBefore, objectKey] = params;
      const obj = objectDeletions.get(objectKey);
      if (!obj) return { meta: { changes: 0 } };
      obj.not_before = Math.max(obj.not_before, notBefore);
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("SELECT COUNT(*) AS count FROM sqlite_master")) {
      return { count: 6 };
    }

    // Fallback
    return { results: [], meta: { changes: 0 } };
  }

  function createStatement(sql: string, params: any[] = []): any {
    return {
      bind: (...newParams: any[]) => createStatement(sql, newParams),
      first: async <T>() => executeQuery(sql, params) as T,
      all: async <T>() => {
        const res = executeQuery(sql, params);
        return res?.results ? res : { results: res ? [res] : [] };
      },
      run: async () => executeQuery(sql, params)
    };
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async (statements: any[]) => {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    }
  } as any;
}

export function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createMockD1(),
    FILES: createMockR2(),
    ASSETS: { fetch: async () => new Response("<html>mock asset</html>") } as unknown as Fetcher,
    LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    RETRIEVE_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    APP_NAME: "PocketRelay",
    UPLOAD_MODE: "token",
    ADMIN_PASSWORD: "test-admin-password",
    UPLOAD_TOKEN: "test-upload-token",
    SHORTCUT_TOKEN: "test-shortcut-token",
    R2_ACCESS_KEY_ID: "mock-access-key",
    R2_SECRET_ACCESS_KEY: "mock-secret-key",
    R2_ACCOUNT_ID: "mock-account-id",
    R2_BUCKET_NAME: "pocket-relay-files",
    ...overrides
  };
}
