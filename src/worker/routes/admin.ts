import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { COOKIE_NAME, DEFAULT_LIMITS, LEGACY_COOKIE_NAME } from "../../shared/constants";
import { jsonSuccess } from "../lib/responses";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";
import { adminSessionMiddleware } from "../middleware/admin-session";
import { adminCsrfMiddleware } from "../middleware/csrf";
import {
  loginAdmin,
  logoutAdminSession,
  logoutAllAdmin
} from "../services/session-service";
import {
  getAdminOverviewStats,
  getDropById,
  listDropsAdmin,
  extendDropExpiry,
  revokeDrop,
  markDropDeleting,
  type DropRow
} from "../repositories/drops";
import {
  getItemsByDropId,
  getFilesByDropId
} from "../repositories/files";
import {
  getHardLimits,
  getParsedSettings,
  setSettingValue
} from "../repositories/settings";
import type {
  AdminDropRowDto,
  AdminDropsListData,
  AdminOverviewData,
  AdminSettingsData,
  UpdateSettingsRequest
} from "../../shared/contracts";
import { isRecord, parseJsonBody } from "../lib/body";

export const adminRoutes = new Hono<WorkerContext>();

// Admin Login
adminRoutes.post("/admin/login", async (c) => {
  const ip = getClientIp(c);
  await checkRateLimit(c.env.LOGIN_RATE_LIMITER, `admin_login_${ip}`);

  const rawBody = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(rawBody) || (rawBody.password !== undefined && typeof rawBody.password !== "string")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Request body must contain a string password.");
  }
  const password = rawBody.password || "";

  const { token, expiresAt } = await loginAdmin(c.env, password);

  // Set HttpOnly SameSite=Strict cookie
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    // Keep local HTTP development usable while enforcing Secure in production.
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    expires: new Date(expiresAt)
  });

  return jsonSuccess(c, { ok: true });
});

// Admin Logout
adminRoutes.post("/admin/logout", adminSessionMiddleware, adminCsrfMiddleware, async (c) => {
  const session = c.get("adminSession");
  if (!session) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Admin session is required.");
  }
  await logoutAdminSession(c.env, session.id);
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  deleteCookie(c, LEGACY_COOKIE_NAME, { path: "/" });
  return jsonSuccess(c, { ok: true });
});

// Admin Logout All Devices
adminRoutes.post("/admin/logout-all", adminSessionMiddleware, adminCsrfMiddleware, async (c) => {
  await logoutAllAdmin(c.env);
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  deleteCookie(c, LEGACY_COOKIE_NAME, { path: "/" });
  return jsonSuccess(c, { ok: true });
});

// Admin Overview Stats
adminRoutes.get("/admin/overview", adminSessionMiddleware, async (c) => {
  const now = Date.now();
  const stats = await getAdminOverviewStats(c.env.DB, now);
  const data: AdminOverviewData = {
    activeDropsCount: stats.activeDropsCount,
    createdTodayCount: stats.createdTodayCount,
    activeTotalFileBytes: stats.activeTotalFileBytes,
    expiringIn24hCount: stats.expiringIn24hCount
  };
  return jsonSuccess(c, data);
});

// Admin Drops List
adminRoutes.get("/admin/drops", adminSessionMiddleware, async (c) => {
  const cursor = c.req.query("cursor");
  const searchCode = c.req.query("search")?.trim().toUpperCase();
  const statusFilter = c.req.query("status");
  const requestedLimit = Number.parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(50, Math.max(1, requestedLimit))
    : 50;

  let cursorCreatedAt: number | undefined;
  let cursorId: string | undefined;

  if (cursor) {
    const [tsStr, id] = cursor.split("_");
    const ts = Number.parseInt(tsStr, 10);
    if (Number.isFinite(ts) && id) {
      cursorCreatedAt = ts;
      cursorId = id;
    }
  }

  const rows = await listDropsAdmin(c.env.DB, {
    cursorCreatedAt,
    cursorId,
    searchCode,
    status: statusFilter,
    limit
  });

  const now = Date.now();
  const formattedDrops: AdminDropRowDto[] = [];

  for (const row of rows) {
    let derivedStatus: "draft" | "active" | "revoked" | "deleting" | "expired" = row.status;
    if (row.status === "active" && now >= row.expires_at) {
      derivedStatus = "expired";
    }

    formattedDrops.push({
      id: row.id,
      code: row.code,
      status: derivedStatus,
      rawStatus: row.status,
      hasText: (row.has_text || 0) > 0,
      fileCount: row.file_count || 0,
      totalSize: row.total_size,
      viewCount: row.view_count,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastViewedAt: row.last_viewed_at
    });
  }

  let nextCursor: string | null = null;
  if (rows.length === limit) {
    const last = rows[rows.length - 1];
    nextCursor = `${last.created_at}_${last.id}`;
  }

  const result: AdminDropsListData = {
    drops: formattedDrops,
    nextCursor
  };

  return jsonSuccess(c, result);
});

// Admin Drop Detail
adminRoutes.get("/admin/drops/:id", adminSessionMiddleware, async (c) => {
  const id = c.req.param("id");
  const drop = await getDropById(c.env.DB, id);
  if (!drop) {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "Drop not found.");
  }

  const [items, files] = await Promise.all([
    getItemsByDropId(c.env.DB, id),
    getFilesByDropId(c.env.DB, id)
  ]);

  return jsonSuccess(c, {
    drop,
    items,
    files
  });
});

// Admin Patch Drop (Extend expiry or revoke)
adminRoutes.patch("/admin/drops/:id", adminSessionMiddleware, adminCsrfMiddleware, async (c) => {
  const id = c.req.param("id");
  const drop = await getDropById(c.env.DB, id);
  if (!drop) {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "Drop not found.");
  }

  const rawBody = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(rawBody)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Request body must be a JSON object.");
  }
  if (
    (rawBody.action !== undefined && rawBody.action !== "revoke" && rawBody.action !== "extend") ||
    (rawBody.additionalSeconds !== undefined &&
      (typeof rawBody.additionalSeconds !== "number" || !Number.isFinite(rawBody.additionalSeconds)))
  ) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid admin action payload.");
  }
  const body = rawBody as {
    action?: "revoke" | "extend";
    additionalSeconds?: number;
  };

  if (body.action === "revoke") {
    await revokeDrop(c.env.DB, id);
    return jsonSuccess(c, { ok: true, status: "revoked" });
  }

  if (body.action === "extend") {
    const settings = await getParsedSettings(c.env.DB, c.env);
    const additional = body.additionalSeconds ?? 86400;
    if (!Number.isSafeInteger(additional) || additional <= 0) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Extension must be a positive whole number of seconds.");
    }
    const now = Date.now();
    if (drop.status !== "active" || drop.expires_at <= now) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Only an active, unexpired drop can be extended.");
    }
    const maxExpiryTimestamp = drop.created_at + settings.max_expiry_seconds * 1000;
    const newExpiresAt = Math.min(drop.expires_at + additional * 1000, maxExpiryTimestamp);
    if (newExpiresAt <= drop.expires_at) {
      throw new AppError(
        409,
        ERROR_CODES.CONFLICT,
        "This drop is already at or beyond the current maximum expiry."
      );
    }

    const extended = await extendDropExpiry(
      c.env.DB,
      id,
      newExpiresAt,
      drop.expires_at,
      now
    );
    if (!extended) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Drop state changed while extending its expiry.");
    }
    return jsonSuccess(c, { ok: true, expiresAt: newExpiresAt });
  }

  throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid admin action.");
});

// Admin Delete Drop (Mark deleting for Cron cleanup)
adminRoutes.delete("/admin/drops/:id", adminSessionMiddleware, adminCsrfMiddleware, async (c) => {
  const id = c.req.param("id");
  const drop = await getDropById(c.env.DB, id);
  if (!drop) {
    throw new AppError(404, ERROR_CODES.DROP_NOT_FOUND, "Drop not found.");
  }

  await markDropDeleting(c.env.DB, id, Date.now());
  return jsonSuccess(c, { ok: true });
});

// Admin Get Settings
adminRoutes.get("/admin/settings", adminSessionMiddleware, async (c) => {
  const settings = await getParsedSettings(c.env.DB, c.env);
  const hard = getHardLimits(c.env);

  const data: AdminSettingsData = {
    settings,
    readonly: {
      uploadMode: c.env.UPLOAD_MODE === "public" ? "public" : "token",
      hasAdminPasswordSecret: Boolean(c.env.ADMIN_PASSWORD?.trim()),
      hasUploadTokenSecret: Boolean(c.env.UPLOAD_TOKEN?.trim()),
      hasShortcutTokenSecret: Boolean(c.env.SHORTCUT_TOKEN?.trim()),
      hasR2AccessKeys: Boolean(
        c.env.R2_ACCESS_KEY_ID?.trim() &&
        c.env.R2_SECRET_ACCESS_KEY?.trim() &&
        c.env.R2_ACCOUNT_ID?.trim()
      ),
      hardLimits: hard
    }
  };

  return jsonSuccess(c, data);
});

// Admin Update Settings
adminRoutes.patch("/admin/settings", adminSessionMiddleware, adminCsrfMiddleware, async (c) => {
  const rawBody = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(rawBody)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Request body must be a JSON object.");
  }
  const numericKeys = [
    "default_expiry_seconds",
    "max_expiry_seconds",
    "max_file_bytes",
    "max_drop_file_bytes",
    "max_files_per_drop",
    "max_text_bytes",
    "code_length"
  ] as const;
  for (const key of numericKeys) {
    const value = rawBody[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, `Setting ${key} must be a finite number.`);
    }
  }
  if (rawBody.site_name !== undefined && typeof rawBody.site_name !== "string") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Setting site_name must be a string.");
  }
  if (
    rawBody.allow_public_risky_files !== undefined &&
    typeof rawBody.allow_public_risky_files !== "boolean"
  ) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Setting allow_public_risky_files must be boolean.");
  }
  const body = rawBody as UpdateSettingsRequest;
  const hard = getHardLimits(c.env);
  const now = Date.now();
  const current = await getParsedSettings(c.env.DB, c.env);
  const bounded = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
  };

  const nextMaxExpiry = bounded(
    body.max_expiry_seconds,
    current.max_expiry_seconds,
    60,
    DEFAULT_LIMITS.MAX_EXPIRY_SECONDS
  );
  const nextDefaultExpiry = bounded(
    body.default_expiry_seconds,
    current.default_expiry_seconds,
    60,
    nextMaxExpiry
  );

  if (body.site_name !== undefined) {
    const clean = body.site_name.trim().slice(0, 100) || "之间门";
    await setSettingValue(c.env.DB, "site_name", clean, now);
  }

  if (body.default_expiry_seconds !== undefined) {
    await setSettingValue(c.env.DB, "default_expiry_seconds", String(nextDefaultExpiry), now);
  }

  if (body.max_expiry_seconds !== undefined) {
    await setSettingValue(c.env.DB, "max_expiry_seconds", String(nextMaxExpiry), now);
    if (body.default_expiry_seconds === undefined && current.default_expiry_seconds > nextMaxExpiry) {
      await setSettingValue(c.env.DB, "default_expiry_seconds", String(nextMaxExpiry), now);
    }
  }

  if (body.max_file_bytes !== undefined) {
    const val = bounded(body.max_file_bytes, current.max_file_bytes, 1024, hard.maxFileBytes);
    await setSettingValue(c.env.DB, "max_file_bytes", String(val), now);
  }

  if (body.max_drop_file_bytes !== undefined) {
    const val = bounded(body.max_drop_file_bytes, current.max_drop_file_bytes, 1024, hard.maxDropFileBytes);
    await setSettingValue(c.env.DB, "max_drop_file_bytes", String(val), now);
  }

  if (body.max_files_per_drop !== undefined) {
    const val = bounded(body.max_files_per_drop, current.max_files_per_drop, 1, hard.maxFilesPerDrop);
    await setSettingValue(c.env.DB, "max_files_per_drop", String(val), now);
  }

  if (body.max_text_bytes !== undefined) {
    const val = bounded(body.max_text_bytes, current.max_text_bytes, 1024, hard.maxTextBytes);
    await setSettingValue(c.env.DB, "max_text_bytes", String(val), now);
  }

  if (body.code_length !== undefined) {
    const val = bounded(body.code_length, current.code_length, 5, 8);
    await setSettingValue(c.env.DB, "code_length", String(val), now);
  }

  if (body.allow_public_risky_files !== undefined) {
    await setSettingValue(c.env.DB, "allow_public_risky_files", body.allow_public_risky_files ? "true" : "false", now);
  }

  const updated = await getParsedSettings(c.env.DB, c.env);
  return jsonSuccess(c, updated);
});
