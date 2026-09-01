import type { Env } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { DEFAULT_LIMITS } from "../../shared/constants";
import { generateRandomToken, sha256Hex, timingSafeEqual } from "../lib/crypto";
import {
  createAdminSession,
  deleteAdminSession,
  deleteAllAdminSessions,
  getAdminSessionByTokenHash,
  touchAdminSession,
  type AdminSessionRow
} from "../repositories/sessions";

export async function loginAdmin(
  env: Env,
  password: string
): Promise<{ token: string; expiresAt: number }> {
  const adminPassword = env.ADMIN_PASSWORD?.trim();
  if (!adminPassword) {
    throw new AppError(
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE,
      "ADMIN_PASSWORD secret is not configured on this server."
    );
  }

  const match = await timingSafeEqual(password || "", adminPassword);
  if (!match) {
    throw new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, "Invalid admin password.");
  }

  const now = Date.now();
  const expiresAt = now + DEFAULT_LIMITS.ADMIN_SESSION_TTL_SECONDS * 1000;
  const token = generateRandomToken(32);
  const tokenHash = await sha256Hex(token);
  const sessionId = crypto.randomUUID();

  await createAdminSession(env.DB, sessionId, tokenHash, now, expiresAt);

  return { token, expiresAt };
}

export async function validateAdminSession(
  env: Env,
  token?: string | null
): Promise<AdminSessionRow | null> {
  if (!token) {
    return null;
  }

  const tokenHash = await sha256Hex(token);
  const session = await getAdminSessionByTokenHash(env.DB, tokenHash);
  if (!session) {
    return null;
  }

  const now = Date.now();
  if (session.expires_at <= now) {
    await deleteAdminSession(env.DB, session.id);
    return null;
  }

  // Update last_seen_at at most once per hour
  if (now - session.last_seen_at > 3600 * 1000) {
    await touchAdminSession(env.DB, session.id, now);
  }

  return session;
}

export async function logoutAdmin(env: Env, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  const session = await getAdminSessionByTokenHash(env.DB, tokenHash);
  if (session) {
    await deleteAdminSession(env.DB, session.id);
  }
}

export async function logoutAdminSession(env: Env, sessionId: string): Promise<void> {
  await deleteAdminSession(env.DB, sessionId);
}

export async function logoutAllAdmin(env: Env): Promise<void> {
  await deleteAllAdminSessions(env.DB);
}
