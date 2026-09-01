import type { Env } from "../env";
import { DEFAULT_LIMITS } from "../../shared/constants";

export interface ParsedSettings {
  site_name: string;
  default_expiry_seconds: number;
  max_expiry_seconds: number;
  max_file_bytes: number;
  max_drop_file_bytes: number;
  max_files_per_drop: number;
  max_text_bytes: number;
  code_length: number;
  allow_public_risky_files: boolean;
}

export interface HardLimits {
  maxFileBytes: number;
  maxDropFileBytes: number;
  maxTextBytes: number;
  maxFilesPerDrop: number;
  presignedUrlTtlSeconds: number;
}

export function getHardLimits(env: Env): HardLimits {
  const parsePositive = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    maxFileBytes: parsePositive(env.MAX_FILE_BYTES_HARD, DEFAULT_LIMITS.MAX_FILE_BYTES),
    maxDropFileBytes: parsePositive(env.MAX_DROP_FILE_BYTES_HARD, DEFAULT_LIMITS.MAX_DROP_FILE_BYTES),
    maxTextBytes: parsePositive(env.MAX_TEXT_BYTES_HARD, DEFAULT_LIMITS.MAX_TEXT_BYTES),
    maxFilesPerDrop: parsePositive(env.MAX_FILES_PER_DROP_HARD, DEFAULT_LIMITS.MAX_FILES_PER_DROP),
    presignedUrlTtlSeconds: parsePositive(env.PRESIGNED_URL_TTL_SECONDS, DEFAULT_LIMITS.PRESIGNED_URL_TTL_SECONDS)
  };
}

export async function getSettingsMap(db: D1Database): Promise<Map<string, string>> {
  try {
    const result = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
    const map = new Map<string, string>();
    for (const row of result.results || []) {
      map.set(row.key, row.value);
    }
    return map;
  } catch (err) {
    console.error(JSON.stringify({ event: "settings_read_failed", error: String(err) }));
    return new Map();
  }
}

export async function getParsedSettings(db: D1Database, env: Env): Promise<ParsedSettings> {
  const map = await getSettingsMap(db);
  const hard = getHardLimits(env);

  const rawSiteName = map.get("site_name") || env.APP_NAME || "PocketRelay";
  const defaultExpiry = Number.parseInt(
    map.get("default_expiry_seconds") || String(DEFAULT_LIMITS.DEFAULT_EXPIRY_SECONDS),
    10
  );
  const maxExpiry = Number.parseInt(
    map.get("max_expiry_seconds") || String(DEFAULT_LIMITS.MAX_EXPIRY_SECONDS),
    10
  );

  const rawMaxFileBytes = Number.parseInt(
    map.get("max_file_bytes") || String(DEFAULT_LIMITS.MAX_FILE_BYTES),
    10
  );
  const rawMaxDropBytes = Number.parseInt(
    map.get("max_drop_file_bytes") || String(DEFAULT_LIMITS.MAX_DROP_FILE_BYTES),
    10
  );
  const rawMaxFiles = Number.parseInt(
    map.get("max_files_per_drop") || String(DEFAULT_LIMITS.MAX_FILES_PER_DROP),
    10
  );
  const rawMaxTextBytes = Number.parseInt(
    map.get("max_text_bytes") || String(DEFAULT_LIMITS.MAX_TEXT_BYTES),
    10
  );
  const rawCodeLength = Number.parseInt(
    map.get("code_length") || String(DEFAULT_LIMITS.DEFAULT_CODE_LENGTH),
    10
  );
  const allowRisky = map.get("allow_public_risky_files") === "true";

  const safeMaxExpiry = Number.isFinite(maxExpiry) && maxExpiry > 0
    ? Math.min(Math.max(maxExpiry, 60), DEFAULT_LIMITS.MAX_EXPIRY_SECONDS)
    : DEFAULT_LIMITS.MAX_EXPIRY_SECONDS;
  const safeDefaultExpiry = Number.isFinite(defaultExpiry) && defaultExpiry > 0
    ? Math.min(Math.max(defaultExpiry, 60), safeMaxExpiry)
    : Math.min(DEFAULT_LIMITS.DEFAULT_EXPIRY_SECONDS, safeMaxExpiry);
  const safeMaxFileBytes = Number.isFinite(rawMaxFileBytes) && rawMaxFileBytes > 0
    ? Math.min(rawMaxFileBytes, hard.maxFileBytes)
    : hard.maxFileBytes;
  const safeMaxDropBytes = Number.isFinite(rawMaxDropBytes) && rawMaxDropBytes > 0
    ? Math.min(rawMaxDropBytes, hard.maxDropFileBytes)
    : hard.maxDropFileBytes;
  const safeMaxFiles = Number.isFinite(rawMaxFiles) && rawMaxFiles > 0
    ? Math.min(Math.floor(rawMaxFiles), hard.maxFilesPerDrop)
    : hard.maxFilesPerDrop;
  const safeMaxTextBytes = Number.isFinite(rawMaxTextBytes) && rawMaxTextBytes > 0
    ? Math.min(rawMaxTextBytes, hard.maxTextBytes)
    : hard.maxTextBytes;

  return {
    site_name: rawSiteName,
    default_expiry_seconds: safeDefaultExpiry,
    max_expiry_seconds: safeMaxExpiry,
    max_file_bytes: safeMaxFileBytes,
    max_drop_file_bytes: safeMaxDropBytes,
    max_files_per_drop: Math.max(1, safeMaxFiles),
    max_text_bytes: safeMaxTextBytes,
    code_length: Math.max(
      DEFAULT_LIMITS.CODE_MIN_LENGTH,
      Math.min(DEFAULT_LIMITS.CODE_MAX_LENGTH, rawCodeLength || DEFAULT_LIMITS.DEFAULT_CODE_LENGTH)
    ),
    allow_public_risky_files: allowRisky
  };
}

export async function setSettingValue(
  db: D1Database,
  key: string,
  value: string,
  now: number = Date.now()
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
      `
    )
    .bind(key, value, now)
    .run();
}
