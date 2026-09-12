import { Hono } from "hono";
import type { Context } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { davAuthMiddleware } from "../middleware/dav-auth";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";
import { normalizeDriveName, normalizeDrivePath } from "../lib/drive-path";
import {
  copyNode,
  createFolder,
  driveIsEnabled,
  moveNodeToName,
  putDavFile,
  resolveDrivePath,
  trashNode
} from "../services/drive-service";
import { getDriveNode, listDriveChildren } from "../repositories/drive";
import {
  createDavLock,
  deleteDavLock,
  getDavLock,
  listConflictingDavLocksForCreation,
  listActiveDavLocksForPath,
  listActiveDavLocksForSubtree,
  refreshDavLock
} from "../repositories/dav";
import { buildContentDisposition } from "../lib/filename";
import { readTextBodyLimited } from "../lib/body";
import { isInlinePreviewableDriveContent } from "../lib/mime";
import type { DriveNodeRecord } from "../../shared/drive-contracts";

export const webdavRoutes = new Hono<WorkerContext>();

const DAV_METHODS = "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK, PROPPATCH";

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!));
}

function decodePath(c: { req: { url: string } }): string[] {
  const pathname = new URL(c.req.url).pathname;
  if (!pathname.startsWith("/dav")) throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid WebDAV path.");
  const raw = pathname.slice(4);
  if (raw && !raw.startsWith("/")) throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid WebDAV path.");
  if (!raw || raw === "/") return [];
  if (raw.includes("//")) throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Empty WebDAV path segment.");
  const values = raw.replace(/\/$/, "").split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid URL encoding."); }
  });
  if (values.some((value) => value.includes("/") || value.includes("\\"))) throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid WebDAV path segment.");
  try { values.forEach((value) => normalizeDriveName(value)); } catch (error) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, error instanceof Error ? error.message : "Invalid WebDAV path.");
  }
  try { normalizeDrivePath(`/${values.join("/")}`); } catch (error) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, error instanceof Error ? error.message : "Invalid WebDAV path.");
  }
  return values;
}

function pathKey(names: string[]): string {
  return `/${names.map((name) => normalizeDriveName(name).nameKey).join("/")}`;
}

function href(names: string[]): string {
  return `/dav/${names.map((name) => encodeURIComponent(name)).join("/")}${names.length ? "" : ""}`;
}

function davResponse(body: string, status = 207): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/xml; charset=utf-8", DAV: "1, 2", Allow: DAV_METHODS } });
}

function parseDepth(value: string | undefined): "0" | "1" {
  const depth = value?.trim().toLowerCase();
  if (!depth || depth === "0") return "0";
  if (depth === "1") return "1";
  if (depth === "infinity") throw new AppError(403, ERROR_CODES.DAV_METHOD_NOT_SUPPORTED, "Depth infinity is not supported.");
  throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid WebDAV Depth header.");
}

function parseLockDepth(value: string | undefined): "0" | "1" | "infinity" {
  const depth = value?.trim().toLowerCase();
  if (!depth || depth === "infinity") return "infinity";
  if (depth === "0" || depth === "1") return depth;
  throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Invalid WebDAV Depth header.");
}

function parseTimeout(value: string | undefined): number {
  const match = value?.match(/Second-(\d+)/i);
  const seconds = Math.min(Math.max(Number.parseInt(match?.[1] || "1800", 10) || 1800, 60), 3600);
  return Date.now() + seconds * 1000;
}

function lockTokenFromHeader(value: string | undefined): string | null {
  const match = value?.match(/<?(opaquelocktoken:[^)>\s]+)>?/i);
  return match?.[1] || null;
}

function lockTokensFromHeader(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<?(opaquelocktoken:[^)>\s]+)>?/gi)].map((match) => match[1]);
}

async function assertUnlocked(c: Context<WorkerContext>, names: string[], includeDescendants = false): Promise<void> {
  const key = pathKey(names);
  const locks = includeDescendants
    ? await listActiveDavLocksForSubtree(c.env.DB, key, Date.now())
    : await listActiveDavLocksForPath(c.env.DB, key, Date.now());
  if (!locks.length) return;
  const provided = lockTokensFromHeader(c.req.header("if"));
  if (!provided.length || locks.some((lock) => !provided.includes(lock.token))) {
    throw new AppError(423, ERROR_CODES.DAV_LOCKED, "The WebDAV resource is locked.");
  }
}

function resourceXml(node: DriveNodeRecord, names: string[]): string {
  const isCollection = node.kind === "folder";
  const modified = new Date(node.updated_at).toUTCString();
  return `<d:response><d:href>${escapeXml(href(names) + (isCollection && names.length ? "/" : ""))}</d:href><d:propstat><d:prop><d:displayname>${escapeXml(node.name)}</d:displayname><d:resourcetype>${isCollection ? "<d:collection/>" : ""}</d:resourcetype>${isCollection ? "" : `<d:getcontentlength>${node.size ?? 0}</d:getcontentlength><d:getcontenttype>${escapeXml(node.content_type || "application/octet-stream")}</d:getcontenttype><d:getetag>${escapeXml(node.etag || `\"${node.version}\"`)}</d:getetag>`}<d:getlastmodified>${modified}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

webdavRoutes.use("*", davAuthMiddleware);
webdavRoutes.use("*", async (c, next) => {
  if (!driveIsEnabled(c.env)) throw new AppError(503, ERROR_CODES.DRIVE_DISABLED, "Drive is not enabled.");
  await checkRateLimit(c.env.DAV_RATE_LIMITER, `dav_method_${getClientIp(c)}`, { failOpen: true });
  await next();
});

webdavRoutes.all("/*", async (c) => {
  const method = c.req.method.toUpperCase();
  const names = decodePath(c);
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { DAV: "1, 2", Allow: DAV_METHODS, "MS-Author-Via": "DAV" } });

  if (method === "PROPFIND") {
    const node = await resolveDrivePath(c.env, names);
    if (!node) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "WebDAV resource was not found.");
    const depth = parseDepth(c.req.header("depth"));
    // A WebDAV PROPFIND response has no REST-style cursor. Keep the response
    // bounded while covering the documented 1,000-node directory target.
    const children = depth === "1" && node.kind === "folder" ? await listDriveChildren(c.env.DB, node.id, 1000) : [];
    const entries = [resourceXml(node, names), ...children.map((child) => resourceXml(child, [...names, child.name]))];
    return davResponse(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${entries.join("")}</d:multistatus>`);
  }

  if (method === "GET" || method === "HEAD") {
    const node = await resolveDrivePath(c.env, names);
    if (!node) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "WebDAV resource was not found.");
    if (node.kind === "folder" || !node.object_key) throw new AppError(405, ERROR_CODES.DAV_METHOD_NOT_SUPPORTED, "Cannot download a collection.");
    const rangeHeader = c.req.header("range");
    const object = await c.env.DRIVE!.get(node.object_key, rangeHeader ? { range: c.req.raw.headers } : undefined);
    if (!object) throw new AppError(404, ERROR_CODES.FILE_OBJECT_MISSING, "Drive object is missing.");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", node.content_type || "application/octet-stream");
    headers.set("Content-Disposition", buildContentDisposition(node.name, isInlinePreviewableDriveContent(node.content_type || "") ? "inline" : "attachment"));
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", "private, no-store");
    headers.set("ETag", object.httpEtag || node.etag || `\"${node.version}\"`);
    headers.set("Last-Modified", new Date(node.updated_at).toUTCString());
    headers.set("Accept-Ranges", "bytes");
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
      headers.set("Content-Length", String(length));
      headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${total}`);
      return new Response(method === "HEAD" ? null : object.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(node.size ?? object.size));
    return new Response(method === "HEAD" ? null : object.body, { status: 200, headers });
  }

  if (method === "PUT") {
    const parentNames = names.slice(0, -1);
    const leaf = names.at(-1);
    if (!leaf) throw new AppError(405, ERROR_CODES.DAV_METHOD_NOT_SUPPORTED, "Cannot PUT the WebDAV root.");
    const parent = await resolveDrivePath(c.env, parentNames);
    if (!parent || parent.kind !== "folder") throw new AppError(409, ERROR_CODES.DRIVE_PARENT_NOT_FOUND, "Parent collection was not found.");
    await assertUnlocked(c, names);
    const contentLength = c.req.header("content-length");
    if (!contentLength || !/^\d+$/.test(contentLength)) throw new AppError(411, ERROR_CODES.DRIVE_UPLOAD_INVALID, "WebDAV PUT requires a valid Content-Length.");
    const result = await putDavFile(c.env, parent.id, leaf, c.req.raw.body as ReadableStream<Uint8Array> | null, c.req.header("content-type") || "application/octet-stream", Number.parseInt(contentLength, 10));
    return new Response(null, { status: result.replaced ? 204 : 201, headers: { DAV: "1, 2", ETag: result.node.etag || `\"${result.node.version}\"` } });
  }

  if (method === "MKCOL") {
    const parentNames = names.slice(0, -1);
    const leaf = names.at(-1);
    if (!leaf) throw new AppError(405, ERROR_CODES.DAV_METHOD_NOT_SUPPORTED, "Cannot create the WebDAV root.");
    const parent = await resolveDrivePath(c.env, parentNames);
    if (!parent || parent.kind !== "folder") throw new AppError(409, ERROR_CODES.DRIVE_PARENT_NOT_FOUND, "Parent collection was not found.");
    const body = await readTextBodyLimited(c.req.raw, 8 * 1024);
    if (body.trim()) throw new AppError(415, ERROR_CODES.DAV_METHOD_NOT_SUPPORTED, "MKCOL request bodies are not supported.");
    await assertUnlocked(c, names);
    const existing = await resolveDrivePath(c.env, names);
    if (existing) throw new AppError(405, ERROR_CODES.DAV_METHOD_NOT_SUPPORTED, "MKCOL cannot be executed on an existing resource.");
    const result = await createFolder(c.env, parent.id, leaf);
    return new Response(null, { status: 201, headers: { DAV: "1, 2", Location: href([...parentNames, result.name]) + "/" } });
  }

  if (method === "DELETE") {
    const node = await resolveDrivePath(c.env, names);
    if (!node) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "WebDAV resource was not found.");
    await assertUnlocked(c, names, node.kind === "folder");
    await trashNode(c.env, node.id);
    return new Response(null, { status: 204, headers: { DAV: "1, 2" } });
  }

  if (method === "COPY" || method === "MOVE") {
    const source = await resolveDrivePath(c.env, names);
    if (!source) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "WebDAV resource was not found.");
    await assertUnlocked(c, names, source.kind === "folder");
    const destination = c.req.header("destination");
    if (!destination) throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Destination header is required.");
    let targetUrl: URL;
    try {
      targetUrl = new URL(destination, c.req.url);
    } catch {
      throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Destination must be a valid WebDAV URL.");
    }
    const targetPath = targetUrl.pathname;
    if (targetUrl.host !== new URL(c.req.url).host || !targetPath.startsWith("/dav")) throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Destination must be on the same WebDAV endpoint.");
    const targetNames = decodePath({ req: { url: `${new URL(c.req.url).origin}${targetPath}` } });
    const targetLeaf = targetNames.at(-1);
    const targetParent = await resolveDrivePath(c.env, targetNames.slice(0, -1));
    if (!targetLeaf || !targetParent || targetParent.kind !== "folder") throw new AppError(409, ERROR_CODES.DRIVE_PARENT_NOT_FOUND, "Destination collection was not found.");
    const existing = await resolveDrivePath(c.env, targetNames);
    await assertUnlocked(c, targetNames, existing?.kind === "folder");
    if (existing?.id === source.id) return new Response(null, { status: 204, headers: { DAV: "1, 2" } });
    const overwrite = (c.req.header("overwrite") || "T").toUpperCase() === "T";
    if (existing && !overwrite) throw new AppError(412, ERROR_CODES.DAV_PRECONDITION_FAILED, "Destination exists.");
    if (method === "COPY") {
      const copied = await copyNode(c.env, source.id, targetParent.id, targetLeaf, overwrite);
      return new Response(null, { status: existing ? 204 : 201, headers: { DAV: "1, 2", ETag: copied.etag || `\"${copied.version}\"` } });
    }
    if (existing?.kind === "folder") throw new AppError(409, ERROR_CODES.DRIVE_NAME_CONFLICT, "MOVE cannot replace a collection.");
    const moved = await moveNodeToName(
      c.env,
      source.id,
      targetParent.id,
      targetLeaf,
      source.version,
      existing?.id || null,
      existing?.version
    );
    return new Response(null, { status: existing ? 204 : 201, headers: { DAV: "1, 2", ETag: moved.etag || `\"${moved.version}\"` } });
  }

  if (method === "LOCK") {
    const key = pathKey(names);
    const device = c.get("davDevice");
    if (!device) throw new AppError(401, ERROR_CODES.DAV_UNAUTHORIZED, "WebDAV credentials are required.");
    const existingToken = lockTokenFromHeader(c.req.header("if"));
    const expiresAt = parseTimeout(c.req.header("timeout"));
    if (existingToken) {
      const existingLock = await getDavLock(c.env.DB, existingToken);
      const refreshed = await refreshDavLock(c.env.DB, existingToken, device.id, expiresAt);
      if (!refreshed) throw new AppError(423, ERROR_CODES.DAV_LOCKED, "The WebDAV lock cannot be refreshed.");
      return davResponse(lockXml(existingToken, expiresAt, existingLock?.depth || "infinity"), 200);
    }
    const depth = parseLockDepth(c.req.header("depth"));
    if ((await listConflictingDavLocksForCreation(c.env.DB, key, depth, Date.now())).length > 0) {
      throw new AppError(423, ERROR_CODES.DAV_LOCKED, "The WebDAV resource is already locked.");
    }
    const current = await resolveDrivePath(c.env, names);
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    const owner = await readTextBodyLimited(c.req.raw, 8 * 1024);
    await createDavLock(c.env.DB, { token, node_id: current?.id || null, path_key: key, owner, depth, scope: "exclusive", device_id: device.id, created_at: Date.now(), expires_at: expiresAt });
    return new Response(lockXml(token, expiresAt, depth), { status: current ? 200 : 201, headers: { "Content-Type": "application/xml; charset=utf-8", "Lock-Token": `<${token}>`, DAV: "1, 2" } });
  }

  if (method === "UNLOCK") {
    const token = lockTokenFromHeader(c.req.header("lock-token"));
    const device = c.get("davDevice");
    if (!token || !device || !(await deleteDavLock(c.env.DB, token, device.id))) throw new AppError(409, ERROR_CODES.DAV_PRECONDITION_FAILED, "Lock token is invalid.");
    return new Response(null, { status: 204, headers: { DAV: "1, 2" } });
  }

  if (method === "PROPPATCH") {
    const node = await resolveDrivePath(c.env, names);
    if (!node) throw new AppError(404, ERROR_CODES.DRIVE_NOT_FOUND, "WebDAV resource was not found.");
    return davResponse(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${escapeXml(href(names))}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>`);
  }

  throw new AppError(405, ERROR_CODES.DAV_METHOD_NOT_SUPPORTED, "WebDAV method is not supported.");
});

function lockXml(token: string, expiresAt: number, depth: "0" | "1" | "infinity" = "infinity"): string {
  const depthLabel = depth === "infinity" ? "Infinity" : depth;
  return `<?xml version="1.0" encoding="utf-8"?><d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>${depthLabel}</d:depth><d:timeout>Second-${Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))}</d:timeout><d:locktoken><d:href>${escapeXml(token)}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`;
}
