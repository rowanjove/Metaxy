import { Hono } from "hono";
import type { WorkerContext } from "../env";
import { jsonSuccess } from "../lib/responses";
import { getParsedSettings } from "../repositories/settings";
import { EXPIRY_OPTIONS } from "../../shared/constants";
import type { MetaData } from "../../shared/contracts";

export const metaRoutes = new Hono<WorkerContext>();

metaRoutes.get("/health", async (c) => {
  try {
    // Keep the probe cheap while still detecting a broken D1 binding.
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "health_check_failed", error: String(error) }));
    return c.json({ ok: false }, 503);
  }
});

metaRoutes.get("/ready", async (c) => {
  const missing: string[] = [];
  try {
    const schema = await c.env.DB.prepare(
      `
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('drops', 'files', 'drop_items', 'settings', 'admin_sessions', 'object_deletions')
      `
    ).first<{ count: number }>();
    if ((schema?.count || 0) !== 6) missing.push("database_schema");
  } catch (error) {
    missing.push("database");
    console.error(JSON.stringify({ event: "readiness_database_failed", error: String(error) }));
  }

  if (!c.env.ADMIN_PASSWORD?.trim()) missing.push("admin_password");
  if (!c.env.SHORTCUT_TOKEN?.trim()) missing.push("shortcut_token");
  if (c.env.UPLOAD_MODE !== "public" && !c.env.UPLOAD_TOKEN?.trim()) {
    missing.push("upload_token");
  }
  if (
    !c.env.R2_ACCESS_KEY_ID?.trim() ||
    !c.env.R2_SECRET_ACCESS_KEY?.trim() ||
    !c.env.R2_ACCOUNT_ID?.trim() ||
    !c.env.R2_BUCKET_NAME?.trim()
  ) {
    missing.push("r2_presign_configuration");
  }
  if (!c.env.LOGIN_RATE_LIMITER || !c.env.UPLOAD_RATE_LIMITER || !c.env.RETRIEVE_RATE_LIMITER) {
    missing.push("rate_limit_bindings");
  }
  if (!c.env.FILES || !c.env.ASSETS) missing.push("storage_bindings");

  if (missing.length > 0) {
    console.error(JSON.stringify({ event: "readiness_failed", missing }));
    return c.json({ ok: false }, 503);
  }
  return c.json({ ok: true });
});

metaRoutes.get("/meta", async (c) => {
  const settings = await getParsedSettings(c.env.DB, c.env);
  const uploadMode = c.env.UPLOAD_MODE === "public" ? "public" : "token";
  const expiryOptions: number[] = EXPIRY_OPTIONS.filter((seconds) => seconds <= settings.max_expiry_seconds);
  if (!expiryOptions.includes(settings.default_expiry_seconds)) {
    expiryOptions.push(settings.default_expiry_seconds);
    expiryOptions.sort((a, b) => a - b);
  }

  const data: MetaData = {
    siteName: settings.site_name,
    uploadMode,
    limits: {
      maxTextBytes: settings.max_text_bytes,
      maxFileBytes: settings.max_file_bytes,
      maxDropFileBytes: settings.max_drop_file_bytes,
      maxFilesPerDrop: settings.max_files_per_drop
    },
    expiryOptions,
    defaultExpirySeconds: settings.default_expiry_seconds,
    codeLength: settings.code_length
  };

  return jsonSuccess(c, data);
});
