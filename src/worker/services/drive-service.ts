import type { Env } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import type { DriveListResult, DriveNodeDto, DriveNodeRecord, DriveUploadCompleteResult } from "../../shared/drive-contracts";
import { buildDriveFinalObjectKey, buildDriveUploadObjectKey, parseDriveFinalObjectKey } from "../lib/drive-object-key";
import { normalizeDriveName } from "../lib/drive-path";
import { buildContentDisposition } from "../lib/filename";
import { isInlinePreviewableDriveContent } from "../lib/mime";
import {
  claimDriveUpload,
  commitDriveUpload,
  createDriveFolder,
  commitDavFile,
  findActiveChild,
  findDriveNodeByPath,
  findDriveNodesByName,
  getDriveInbox,
  getDriveNode,
  getDriveRoot,
  getDriveUpload,
  listDriveChildren,
  listDriveDescendants,
  listDriveNodesByStatus,
  moveDriveNode,
  moveDriveNodeToName,
  moveDriveNodeToNameOverwrite,
  prepareDriveUpload as prepareDriveUploadRecord,
  recordDriveObjectDeletion,
  releaseDriveUpload,
  renameDriveNode,
  restoreDriveNode,
  trashDriveSubtree
} from "../repositories/drive";
import { createPresignedPutUrl } from "./presign-service";
import { createDraft, commitDrop } from "./drop-service";
import { prepareUpload, completeUpload } from "./upload-service";
import { getDropByCode } from "../repositories/drops";
import { getFileById } from "../repositories/files";
import { getParsedSettings } from "../repositories/settings";
import { normalizeCode } from "../lib/code";

function driveBucket(env: Env): R2Bucket {
  if (!driveIsEnabled(env)) {
    throw new AppError(503, ERROR_CODES.DRIVE_DISABLED, "Drive storage is not configured on this server.");
  }
  return env.DRIVE!;
}

function hardLimit(env: Env): number {
  const value = Number.parseInt(env.DRIVE_MAX_FILE_BYTES_HARD || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 50 * 1024 * 1024;
}

function davHardLimit(env: Env): number {
  const value = Number.parseInt(env.DAV_MAX_FILE_BYTES_HARD || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : hardLimit(env);
}

function isUniqueConstraint(error: unknown): boolean {
  return String(error).toLowerCase().includes("unique");
}

async function discardDriveObject(env: Env, objectKey: string, notBefore = Date.now()): Promise<void> {
  try {
    await driveBucket(env).delete(objectKey);
  } catch {
    await recordDriveObjectDeletion(env.DB, objectKey, null, Date.now(), notBefore);
  }
}

export function driveNodeDto(node: DriveNodeRecord): DriveNodeDto {
  return {
    id: node.id,
    parentId: node.parent_id,
    kind: node.kind,
    name: node.name,
    status: node.status,
    objectKey: node.object_key,
    contentType: node.content_type,
    size: node.size,
    etag: node.etag,
    version: node.version,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
    trashedAt: node.trashed_at,
    systemRole: node.system_role
  };
}

export function driveIsEnabled(env: Env): boolean {
  return env.DRIVE_ENABLED === "true" && Boolean(env.DRIVE);
}

function requireFolder(node: DriveNodeRecord | null, label: string): DriveNodeRecord {
  if (!node || node.kind !== "folder" || node.status !== "active") {
    throw new AppError(404, ERROR_CODES.DRIVE_PARENT_NOT_FOUND, `${label} folder was not found.`);
  }
  return node;
}

function encodeCursor(nameKey: string, id: string): string {
  return btoa(JSON.stringify({ nameKey, id })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(raw?: string): { nameKey: string; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const encoded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    const value = JSON.parse(json) as { nameKey?: unknown; id?: unknown };
    if (typeof value.nameKey !== "string" || typeof value.id !== "string") throw new Error("invalid cursor");
    return { nameKey: value.nameKey, id: value.id };
  } catch {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid Drive cursor.");
  }
}

export async function listDrive(env: Env, parentId: string | undefined, cursor: string | undefined, limit = 100): Promise<DriveListResult> {
  const root = await getDriveRoot(env.DB);
  const parent = requireFolder(parentId ? await getDriveNode(env.DB, parentId) : root, "Parent");
  const pageSize = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 100, 1), 200);
  const rows = await listDriveChildren(env.DB, parent.id, pageSize + 1, decodeCursor(cursor));
  const hasMore = rows.length > pageSize;
  const visible = hasMore ? rows.slice(0, pageSize) : rows;
  const last = visible.at(-1);
  return {
    parent: driveNodeDto(parent),
    nodes: visible.map(driveNodeDto),
    nextCursor: hasMore && last ? encodeCursor(last.name_key, last.id) : null
  };
}

export async function createFolder(env: Env, parentId: string | undefined, rawName: string): Promise<DriveNodeDto> {
  const parent = requireFolder(parentId ? await getDriveNode(env.DB, parentId) : await getDriveRoot(env.DB), "Parent");
  let name: ReturnType<typeof normalizeDriveName>;
  try { name = normalizeDriveName(rawName); } catch (error) {
    throw new AppError(400, ERROR_CODES.DRIVE_INVALID_NAME, error instanceof Error ? error.message : "Invalid Drive name.");
  }
  const now = Date.now();
  const node: DriveNodeRecord = {
    id: crypto.randomUUID(), parent_id: parent.id, kind: "folder", name: name.name, name_key: name.nameKey,
    system_role: null, status: "active", object_key: null, content_type: null, size: null, etag: null,
    version: 1, created_at: now, updated_at: now, trashed_at: null
  };
  try {
    if (!(await createDriveFolder(env.DB, node))) throw new AppError(404, ERROR_CODES.DRIVE_PARENT_NOT_FOUND, "Parent folder was not found.");
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.");
    throw error;
  }
  const created = await getDriveNode(env.DB, node.id);
  if (!created) throw new AppError(500, ERROR_CODES.INTERNAL_ERROR, "Drive folder was not created.");
  return driveNodeDto(created);
}

export async function prepareDriveUpload(env: Env, params: { parentId?: string; filename: string; size: number; contentType?: string }) {
  driveBucket(env);
  const parent = requireFolder(params.parentId ? await getDriveNode(env.DB, params.parentId) : await getDriveRoot(env.DB), "Parent");
  let name: ReturnType<typeof normalizeDriveName>;
  try { name = normalizeDriveName(params.filename); } catch (error) {
    throw new AppError(400, ERROR_CODES.DRIVE_INVALID_NAME, error instanceof Error ? error.message : "Invalid Drive name.");
  }
  if (!Number.isSafeInteger(params.size) || params.size < 0) throw new AppError(400, ERROR_CODES.DRIVE_UPLOAD_INVALID, "Invalid upload size.");
  if (params.size > hardLimit(env)) throw new AppError(413, ERROR_CODES.DRIVE_QUOTA_EXCEEDED, `Drive file exceeds ${hardLimit(env)} bytes.`);
  const contentType = (params.contentType || "application/octet-stream").trim().toLowerCase();
  if (!contentType || contentType.length > 255 || /[\u0000-\u001f\u007f]/.test(contentType)) throw new AppError(400, ERROR_CODES.DRIVE_UPLOAD_INVALID, "Invalid content type.");
  const uploadId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const uploadObjectKey = buildDriveUploadObjectKey(uploadId);
  const finalObjectKey = buildDriveFinalObjectKey(nodeId);
  const ttl = Math.min(Math.max(Number.parseInt(env.PRESIGNED_URL_TTL_SECONDS || "300", 10) || 300, 1), 604800);
  const signed = await createPresignedPutUrl(env, uploadObjectKey, contentType, ttl, "DRIVE");
  if (!(await prepareDriveUploadRecord(env.DB, {
    id: uploadId, parent_id: parent.id, name: name.name, name_key: name.nameKey,
    upload_object_key: uploadObjectKey, final_object_key: finalObjectKey, expected_size: params.size,
    expected_content_type: contentType, presign_expires_at: signed.expiresAt, created_at: Date.now()
  }))) throw new AppError(404, ERROR_CODES.DRIVE_PARENT_NOT_FOUND, "Parent folder was not found while preparing the upload.");
  return { uploadId, nodeId, uploadObjectKey, finalObjectKey, expectedSize: params.size, contentType, expiresAt: signed.expiresAt, uploadUrl: signed.uploadUrl, method: signed.method, headers: signed.headers };
}

export async function completeDriveUpload(env: Env, uploadId: string): Promise<DriveUploadCompleteResult> {
  const bucket = driveBucket(env);
  const upload = await getDriveUpload(env.DB, uploadId);
  if (!upload) throw new AppError(404, ERROR_CODES.DRIVE_UPLOAD_INVALID, "Drive upload was not found.");
  if (upload.status === "completed" && upload.node_id) {
    const done = await getDriveNode(env.DB, upload.node_id);
    if (done) return { node: driveNodeDto(done), status: "uploaded" };
  }
  if (upload.presign_expires_at < Date.now() && upload.status === "prepared") throw new AppError(410, ERROR_CODES.DRIVE_UPLOAD_EXPIRED, "Drive upload URL has expired.");
  const token = crypto.randomUUID();
  if (!(await claimDriveUpload(env.DB, upload.id, token, Date.now()))) throw new AppError(409, ERROR_CODES.CONFLICT, "Drive upload is already being finalized.");
  const object = await bucket.get(upload.upload_object_key);
  if (!object) { await releaseDriveUpload(env.DB, upload.id, token, true); throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "Drive upload object was not found."); }
  if (object.size !== upload.expected_size) {
    await releaseDriveUpload(env.DB, upload.id, token, true);
    await recordDriveObjectDeletion(env.DB, upload.upload_object_key, null, Date.now(), upload.presign_expires_at + 10 * 60 * 1000);
    try { await bucket.delete(upload.upload_object_key); }
    catch { /* the orphan queue above will retry this delete */ }
    throw new AppError(409, ERROR_CODES.FILE_SIZE_MISMATCH, "Drive upload size does not match.");
  }
  const finalObject = await bucket.put(upload.final_object_key, object.body, { httpMetadata: { contentType: upload.expected_content_type } });
  const actualContentType = finalObject.httpMetadata?.contentType?.toLowerCase().split(";")[0].trim();
  if (actualContentType && actualContentType !== upload.expected_content_type) {
    await releaseDriveUpload(env.DB, upload.id, token, true);
    try { await bucket.delete(upload.final_object_key); }
    catch { await recordDriveObjectDeletion(env.DB, upload.final_object_key, null, Date.now()); }
    throw new AppError(409, ERROR_CODES.DRIVE_UPLOAD_INVALID, "Drive upload content type does not match.");
  }
  const nodeId = parseDriveFinalObjectKey(upload.final_object_key) || crypto.randomUUID();
  const node: DriveNodeRecord = {
    id: nodeId, parent_id: upload.parent_id, kind: "file", name: upload.name, name_key: upload.name_key,
    system_role: null, status: "active", object_key: upload.final_object_key, content_type: upload.expected_content_type,
    size: object.size, etag: finalObject.httpEtag || null, version: 1, created_at: Date.now(), updated_at: Date.now(), trashed_at: null
  };
  try {
    if (!(await commitDriveUpload(env.DB, upload, node, token, object.size, finalObject.httpEtag || null, Date.now()))) throw new AppError(409, ERROR_CODES.CONFLICT, "Drive upload state changed.");
  } catch (error) {
    await releaseDriveUpload(env.DB, upload.id, token, true);
    await discardDriveObject(env, upload.final_object_key);
    if (isUniqueConstraint(error)) {
      throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.", error);
    }
    throw error;
  }
  await recordDriveObjectDeletion(env.DB, upload.upload_object_key, node.id, Date.now(), upload.presign_expires_at + 10 * 60 * 1000);
  try { await bucket.delete(upload.upload_object_key); }
  catch { /* The durable deletion queue recorded above will retry this cleanup. */ }
  const committed = await getDriveNode(env.DB, node.id);
  if (!committed) throw new AppError(500, ERROR_CODES.INTERNAL_ERROR, "Drive file was not created.");
  return { node: driveNodeDto(committed), status: "uploaded" };
}

export async function renameNode(env: Env, id: string, rawName: string, version: number): Promise<DriveNodeDto> {
  const current = await getDriveNode(env.DB, id);
  if (!current || current.status !== "active" || current.system_role) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  let name: ReturnType<typeof normalizeDriveName>;
  try { name = normalizeDriveName(rawName); } catch (error) { throw new AppError(400, ERROR_CODES.DRIVE_INVALID_NAME, error instanceof Error ? error.message : "Invalid Drive name."); }
  try {
    if (!(await renameDriveNode(env.DB, id, name.name, name.nameKey, version, Date.now()))) throw new AppError(409, ERROR_CODES.CONFLICT, "Drive node changed while renaming.");
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.");
    throw error;
  }
  const updated = await getDriveNode(env.DB, id);
  if (!updated) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  return driveNodeDto(updated);
}

export async function moveNode(env: Env, id: string, parentId: string, version: number): Promise<DriveNodeDto> {
  const current = await getDriveNode(env.DB, id);
  const parent = await getDriveNode(env.DB, parentId);
  if (!current || current.status !== "active" || current.system_role) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  requireFolder(parent, "Target");
  if (current.id === parentId) throw new AppError(409, ERROR_CODES.DRIVE_MOVE_CYCLE, "A node cannot contain itself.");
  if (current.kind === "folder") {
    const descendants = await listDriveDescendants(env.DB, current.id);
    if (descendants.some((node) => node.id === parentId)) throw new AppError(409, ERROR_CODES.DRIVE_MOVE_CYCLE, "A folder cannot move into its descendant.");
  }
  try {
    if (!(await moveDriveNode(env.DB, id, parentId, version, Date.now()))) throw new AppError(409, ERROR_CODES.CONFLICT, "Drive node changed while moving.");
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.");
    throw error;
  }
  const updated = await getDriveNode(env.DB, id);
  if (!updated) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  return driveNodeDto(updated);
}

export async function moveNodeToName(
  env: Env,
  id: string,
  parentId: string,
  rawName: string,
  version: number,
  overwriteTargetId?: string | null,
  overwriteTargetVersion?: number
): Promise<DriveNodeDto> {
  const current = await getDriveNode(env.DB, id);
  const parent = await getDriveNode(env.DB, parentId);
  if (!current || current.status !== "active" || current.system_role) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  requireFolder(parent, "Target");
  let name: ReturnType<typeof normalizeDriveName>;
  try { name = normalizeDriveName(rawName); } catch (error) { throw new AppError(400, ERROR_CODES.DRIVE_INVALID_NAME, error instanceof Error ? error.message : "Invalid Drive name."); }
  if (current.kind === "folder") {
    const descendants = await listDriveDescendants(env.DB, current.id);
    if (descendants.some((node) => node.id === parentId)) throw new AppError(409, ERROR_CODES.DRIVE_MOVE_CYCLE, "A folder cannot move into its descendant.");
  }
  try {
    const moved = overwriteTargetId !== undefined
      ? await moveDriveNodeToNameOverwrite(
        env.DB,
        id,
        overwriteTargetId,
        overwriteTargetVersion || 0,
        parentId,
        name.name,
        name.nameKey,
        version,
        Date.now()
      )
      : await moveDriveNodeToName(env.DB, id, parentId, name.name, name.nameKey, version, Date.now());
    if (!moved) throw new AppError(409, ERROR_CODES.CONFLICT, "Drive node changed while moving.");
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.");
    throw error;
  }
  const updated = await getDriveNode(env.DB, id);
  if (!updated) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  return driveNodeDto(updated);
}

export async function putDavFile(env: Env, parentId: string, rawName: string, body: ReadableStream<Uint8Array> | null, contentType: string, expectedSize: number | null): Promise<{ node: DriveNodeDto; replaced: boolean }> {
  const bucket = driveBucket(env);
  const parent = requireFolder(await getDriveNode(env.DB, parentId), "Parent");
  let name: ReturnType<typeof normalizeDriveName>;
  try { name = normalizeDriveName(rawName); } catch (error) { throw new AppError(400, ERROR_CODES.DRIVE_INVALID_NAME, error instanceof Error ? error.message : "Invalid Drive name."); }
  if (expectedSize === null) throw new AppError(411, ERROR_CODES.DRIVE_UPLOAD_INVALID, "WebDAV PUT requires Content-Length.");
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > davHardLimit(env)) throw new AppError(413, ERROR_CODES.DRIVE_QUOTA_EXCEEDED, `WebDAV upload exceeds ${davHardLimit(env)} bytes.`);
  if (!contentType || contentType.length > 255 || /[\u0000-\u001f\u007f]/.test(contentType)) throw new AppError(400, ERROR_CODES.DRIVE_UPLOAD_INVALID, "Invalid content type.");
  const existing = await findActiveChild(env.DB, parent.id, name.nameKey);
  if (existing?.kind === "folder") throw new AppError(405, ERROR_CODES.CONFLICT, "Cannot replace a folder with a file.");
  const nodeId = crypto.randomUUID();
  const objectKey = buildDriveFinalObjectKey(nodeId);
  const object = await bucket.put(objectKey, body || new Uint8Array(), { httpMetadata: { contentType } });
  if (expectedSize !== null && object.size !== expectedSize) {
    try { await bucket.delete(objectKey); }
    catch { await recordDriveObjectDeletion(env.DB, objectKey, null, Date.now()); }
    throw new AppError(409, ERROR_CODES.FILE_SIZE_MISMATCH, "WebDAV upload size does not match Content-Length.");
  }
  const now = Date.now();
  const candidate: DriveNodeRecord = {
    id: nodeId, parent_id: parent.id, kind: "file", name: name.name, name_key: name.nameKey, system_role: null,
    status: "active", object_key: objectKey, content_type: contentType, size: object.size, etag: object.httpEtag || null,
    version: 1, created_at: now, updated_at: now, trashed_at: null
  };
  try {
    if (!(await commitDavFile(env.DB, candidate, existing, now))) throw new AppError(409, ERROR_CODES.CONFLICT, "WebDAV target changed while writing.");
  } catch (error) {
    await discardDriveObject(env, objectKey);
    if (isUniqueConstraint(error)) {
      throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.", error);
    }
    throw error;
  }
  const committed = await getDriveNode(env.DB, existing?.id || candidate.id);
  if (!committed) throw new AppError(500, ERROR_CODES.INTERNAL_ERROR, "WebDAV file was not committed.");
  return { node: driveNodeDto(committed), replaced: Boolean(existing) };
}

export async function copyNode(env: Env, id: string, parentId: string, rawName: string, overwrite = false): Promise<DriveNodeDto> {
  const source = await getDriveNode(env.DB, id);
  const parent = requireFolder(await getDriveNode(env.DB, parentId), "Target");
  if (!source || source.status !== "active" || source.system_role) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  let name: ReturnType<typeof normalizeDriveName>;
  try { name = normalizeDriveName(rawName); } catch (error) { throw new AppError(400, ERROR_CODES.DRIVE_INVALID_NAME, error instanceof Error ? error.message : "Invalid Drive name."); }
  const existing = await findActiveChild(env.DB, parent.id, name.nameKey);
  if (existing && (!overwrite || existing.system_role)) throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.");

  if (source.kind === "folder") {
    // Snapshot direct children before creating the destination. This also
    // makes COPY into a descendant finite instead of recursively copying the
    // newly-created destination back into itself.
    const descendants = await listDriveDescendants(env.DB, source.id, 1001);
    if (descendants.length > 1000) throw new AppError(413, ERROR_CODES.DRIVE_QUOTA_EXCEEDED, "Folder COPY exceeds the 1,000-node limit.");
    if (descendants.some((child) => child.id === parent.id)) throw new AppError(409, ERROR_CODES.DRIVE_MOVE_CYCLE, "A folder cannot be copied into its descendant.");
    const children = descendants
      .filter((child) => child.id !== source.id && child.parent_id === source.id && child.status === "active");
    if (existing) await trashNode(env, existing.id);
    const created = await createFolder(env, parent.id, name.name);
    try {
      for (const child of children) await copyNode(env, child.id, created.id, child.name, false);
    } catch (error) {
      await trashNode(env, created.id);
      throw error;
    }
    return created;
  }

  const bucket = driveBucket(env);
  if (!source.object_key || !source.content_type) throw new AppError(501, ERROR_CODES.DAV_METHOD_NOT_SUPPORTED, "The source file is not ready for COPY.");
  if (existing?.kind === "folder") throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A file cannot replace a folder.");
  const original = await bucket.get(source.object_key);
  if (!original) throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "Source object is missing.");
  const nodeId = crypto.randomUUID();
  const objectKey = buildDriveFinalObjectKey(nodeId);
  const object = await bucket.put(objectKey, original.body, { httpMetadata: { contentType: source.content_type } });
  const now = Date.now();
  const candidate: DriveNodeRecord = {
    id: nodeId, parent_id: parent.id, kind: "file", name: name.name, name_key: name.nameKey, system_role: null,
    status: "active", object_key: objectKey, content_type: source.content_type, size: object.size, etag: object.httpEtag || null,
    version: 1, created_at: now, updated_at: now, trashed_at: null
  };
  try {
    if (!(await commitDavFile(env.DB, candidate, existing, now))) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Copy target changed.");
    }
  } catch (error) {
    await discardDriveObject(env, objectKey);
    if (isUniqueConstraint(error)) {
      throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.", error);
    }
    throw error;
  }
  return driveNodeDto((await getDriveNode(env.DB, existing?.id || nodeId))!);
}

export async function trashNode(env: Env, id: string): Promise<void> {
  const current = await getDriveNode(env.DB, id);
  if (!current || current.status !== "active" || current.system_role) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  await trashDriveSubtree(env.DB, await listDriveDescendants(env.DB, id), Date.now());
}

export async function restoreNode(env: Env, id: string): Promise<DriveNodeDto> {
  const current = await getDriveNode(env.DB, id);
  if (!current || current.status !== "trashed") throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found in the trash.");
  const parent = await getDriveNode(env.DB, current.parent_id);
  if (!parent || parent.status !== "active") throw new AppError(409, ERROR_CODES.CONFLICT, "Restore the parent folder first.");
  try {
    if (!(await restoreDriveNode(env.DB, id, Date.now()))) throw new AppError(409, ERROR_CODES.CONFLICT, "Drive node cannot be restored.");
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "An active node already uses this name.");
    throw error;
  }
  const node = await getDriveNode(env.DB, id);
  if (!node) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive node was not found.");
  return driveNodeDto(node);
}

export async function resolveDrivePath(env: Env, names: string[]): Promise<DriveNodeRecord | null> {
  return findDriveNodeByPath(env.DB, names);
}

export async function searchDrive(env: Env, query: string): Promise<DriveNodeDto[]> {
  return (await findDriveNodesByName(env.DB, query, 100)).map(driveNodeDto);
}

export async function listTrash(env: Env): Promise<DriveNodeDto[]> {
  return (await listDriveNodesByStatus(env.DB, "trashed", 200)).map(driveNodeDto);
}

export async function getInbox(env: Env): Promise<DriveNodeDto> {
  const inbox = await getDriveInbox(env.DB);
  if (!inbox) throw new AppError(500, ERROR_CODES.INTERNAL_ERROR, "Drive inbox is not initialized.");
  return driveNodeDto(inbox);
}

export async function getDriveContent(env: Env, id: string, rangeHeader?: string, download = false): Promise<Response> {
  const bucket = driveBucket(env);
  const node = await getDriveNode(env.DB, id);
  if (!node || node.kind !== "file" || node.status !== "active" || !node.object_key) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive file was not found.");
  const object = await bucket.get(node.object_key, rangeHeader ? { range: new Headers({ range: rangeHeader }) } : undefined);
  if (!object) throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "Drive object is missing.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", node.content_type || "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Disposition", buildContentDisposition(node.name, !download && isInlinePreviewableDriveContent(node.content_type || "") ? "inline" : "attachment"));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Accept-Ranges", "bytes");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  if (rangeHeader && object.range) {
    const total = node.size || object.size;
    const range = object.range as { offset?: number; length?: number; suffix?: number };
    let start: number;
    let length: number;
    if (typeof range.suffix === "number") {
      length = Math.min(Number(range.suffix), total);
      start = Math.max(0, total - length);
    } else {
      start = Number(range.offset || 0);
      length = Math.min(Number(range.length ?? total - start), total - start);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || start >= total) {
      headers.set("Content-Range", `bytes */${total}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${total}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

export async function resolveDrivePathFromString(env: Env, path: string): Promise<DriveNodeRecord | null> {
  return resolveDrivePath(env, path.split("/").filter(Boolean));
}

export async function createDropFromDrive(env: Env, nodeId: string, expiresInSeconds: number | undefined, originUrl: string) {
  const source = await getDriveNode(env.DB, nodeId);
  if (!source || source.kind !== "file" || source.status !== "active" || !source.object_key || !source.content_type || source.size === null) {
    throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "Drive file was not found.");
  }
  const settings = await getParsedSettings(env.DB, env);
  if (source.size > settings.max_file_bytes) {
    throw new AppError(413, ERROR_CODES.FILE_TOO_LARGE, `This file exceeds the current Transfer limit of ${settings.max_file_bytes} bytes.`);
  }
  const object = await driveBucket(env).get(source.object_key);
  if (!object) throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "Drive object is missing.");
  const draft = await createDraft(env, { expiresInSeconds });
  try {
    const prepared = await prepareUpload(env, {
      dropId: draft.dropId, draftToken: draft.draftToken, filename: source.name,
      size: source.size, contentType: source.content_type
    }, { transport: "binding" });
    await env.FILES.put(prepared.uploadObjectKey, object.body, { httpMetadata: { contentType: source.content_type } });
    await completeUpload(env, { dropId: draft.dropId, draftToken: draft.draftToken, fileId: prepared.fileId });
    return await commitDrop(env, draft.dropId, draft.draftToken, originUrl);
  } catch (error) {
    throw error;
  }
}

export async function saveDropFileToDrive(env: Env, rawCode: string, fileId: string, parentId?: string): Promise<DriveNodeDto> {
  const code = normalizeCode(rawCode);
  if (!code) throw new AppError(400, ERROR_CODES.INVALID_CODE_FORMAT, "Invalid retrieval code format.");
  const drop = await getDropByCode(env.DB, code);
  if (!drop || drop.status !== "active" || Date.now() >= drop.expires_at) throw new AppError(410, ERROR_CODES.DROP_EXPIRED, "This drop is no longer available.");
  const file = await getFileById(env.DB, fileId);
  if (!file || file.drop_id !== drop.id || file.status !== "uploaded") throw new AppError(404, ERROR_CODES.FILE_NOT_FOUND, "Drop file was not found.");
  if ((file.actual_size ?? file.expected_size) > hardLimit(env)) throw new AppError(413, ERROR_CODES.DRIVE_QUOTA_EXCEEDED, `Drive file exceeds ${hardLimit(env)} bytes.`);
  const parent = requireFolder(parentId ? await getDriveNode(env.DB, parentId) : await getDriveInbox(env.DB), "Target");
  let name: ReturnType<typeof normalizeDriveName>;
  try { name = normalizeDriveName(file.filename); }
  catch (error) { throw new AppError(400, ERROR_CODES.DRIVE_INVALID_NAME, error instanceof Error ? error.message : "Invalid Drive name."); }
  if (await findActiveChild(env.DB, parent.id, name.nameKey)) throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.");
  const source = await env.FILES.get(file.object_key);
  if (!source) throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "Drop object is missing.");
  const nodeId = crypto.randomUUID();
  const objectKey = buildDriveFinalObjectKey(nodeId);
  const copied = await driveBucket(env).put(objectKey, source.body, { httpMetadata: { contentType: file.content_type } });
  const now = Date.now();
  const node: DriveNodeRecord = {
    id: nodeId, parent_id: parent.id, kind: "file", name: name.name, name_key: name.nameKey, system_role: null,
    status: "active", object_key: objectKey, content_type: file.content_type, size: copied.size, etag: copied.httpEtag || null,
    version: 1, created_at: now, updated_at: now, trashed_at: null
  };
  try {
    if (!(await commitDavFile(env.DB, node, null, now))) {
      throw new AppError(409, ERROR_CODES.CONFLICT, "Drive target changed.");
    }
  } catch (error) {
    await discardDriveObject(env, objectKey);
    if (isUniqueConstraint(error)) {
      throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "A node with this name already exists.", error);
    }
    throw error;
  }
  return driveNodeDto((await getDriveNode(env.DB, nodeId))!);
}
