import type { Env } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { generateRandomToken, sha256Hex } from "../lib/crypto";
import {
  createDriveDevice,
  findActiveDriveDevice,
  listDriveDevices,
  revokeDriveDevice,
  touchDriveDevice,
  type DriveDeviceRow
} from "../repositories/dav";

export interface AuthenticatedDavDevice extends DriveDeviceRow {}

export async function createDevice(env: Env, name: string): Promise<{ id: string; name: string; username: string; password: string; createdAt: number }> {
  const cleanName = name.trim().slice(0, 100);
  if (!cleanName) throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Device name is required.");
  const password = `mxy_${generateRandomToken(24)}`;
  const now = Date.now();
  const row: DriveDeviceRow = {
    id: crypto.randomUUID(),
    name: cleanName,
    username: env.DAV_USERNAME?.trim() || "admin",
    credential_hash: await sha256Hex(password),
    created_at: now,
    last_used_at: null,
    revoked_at: null
  };
  await createDriveDevice(env.DB, row);
  return { id: row.id, name: row.name, username: row.username, password, createdAt: now };
}

export async function authenticateDavDevice(env: Env, username: string, password: string): Promise<AuthenticatedDavDevice | null> {
  if (!username || !password) return null;
  const row = await findActiveDriveDevice(env.DB, username, await sha256Hex(password));
  if (!row) return null;
  const now = Date.now();
  // Throttle: Update last_used_at at most once every 10 minutes to prevent D1 write storms
  if (!row.last_used_at || now - row.last_used_at > 10 * 60 * 1000) {
    await touchDriveDevice(env.DB, row.id, now);
  }
  return row;
}

export async function getDevices(env: Env) {
  return (await listDriveDevices(env.DB)).map((device) => ({
    id: device.id,
    name: device.name,
    username: device.username,
    createdAt: device.created_at,
    lastUsedAt: device.last_used_at
  }));
}

export async function revokeDevice(env: Env, id: string): Promise<void> {
  if (!(await revokeDriveDevice(env.DB, id, Date.now()))) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Device was not found.");
  }
}
