import { Hono } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { jsonSuccess } from "../lib/responses";
import { isRecord, parseJsonBody } from "../lib/body";
import { checkRateLimit, getClientIp } from "../middleware/rate-limit";
import { adminSessionMiddleware } from "../middleware/admin-session";
import { adminCsrfMiddleware } from "../middleware/csrf";
import {
  completeDriveUpload,
  copyNode,
  createFolder,
  driveIsEnabled,
  getInbox,
  getDriveContent,
  listDrive,
  listTrash,
  createDropFromDrive,
  saveDropFileToDrive,
  moveNode,
  prepareDriveUpload,
  renameNode,
  restoreNode,
  searchDrive,
  trashNode
} from "../services/drive-service";
import { createDevice, getDevices, revokeDevice } from "../services/device-service";

export const driveRoutes = new Hono<WorkerContext>();

driveRoutes.use("/drive/*", adminSessionMiddleware);
driveRoutes.use("/drive/*", async (c, next) => {
  if (!driveIsEnabled(c.env)) throw new AppError(503, ERROR_CODES.DRIVE_DISABLED, "Drive is not enabled.");
  await checkRateLimit(c.env.DRIVE_RATE_LIMITER, `drive_${getClientIp(c)}`);
  await next();
});

driveRoutes.get("/drive/nodes", async (c) => {
  const parentId = c.req.query("parentId") || undefined;
  const cursor = c.req.query("cursor") || undefined;
  const limit = Number.parseInt(c.req.query("limit") || "100", 10);
  return jsonSuccess(c, await listDrive(c.env, parentId, cursor, Number.isFinite(limit) ? limit : 100));
});

driveRoutes.get("/drive/inbox", async (c) => jsonSuccess(c, await getInbox(c.env)));

driveRoutes.get("/drive/files/:id/content", async (c) => {
  return getDriveContent(c.env, c.req.param("id"), c.req.header("range"), c.req.query("download") === "1");
});

driveRoutes.get("/drive/devices", async (c) => jsonSuccess(c, await getDevices(c.env)));

driveRoutes.post("/drive/devices", adminCsrfMiddleware, async (c) => {
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || typeof body.name !== "string") {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Device name is required.");
  }
  return jsonSuccess(c, await createDevice(c.env, body.name), 201);
});

driveRoutes.delete("/drive/devices/:id", adminCsrfMiddleware, async (c) => {
  await revokeDevice(c.env, c.req.param("id"));
  return jsonSuccess(c, { ok: true });
});

driveRoutes.post("/drive/folders", adminCsrfMiddleware, async (c) => {
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || typeof body.name !== "string" || (body.parentId !== undefined && typeof body.parentId !== "string")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Folder payload is invalid.");
  }
  return jsonSuccess(c, await createFolder(c.env, body.parentId as string | undefined, body.name), 201);
});

driveRoutes.post("/drive/uploads/prepare", adminCsrfMiddleware, async (c) => {
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || typeof body.filename !== "string" || typeof body.size !== "number" ||
      (body.parentId !== undefined && typeof body.parentId !== "string") ||
      (body.contentType !== undefined && typeof body.contentType !== "string")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Drive upload payload is invalid.");
  }
  return jsonSuccess(c, await prepareDriveUpload(c.env, {
    parentId: body.parentId as string | undefined,
    filename: body.filename,
    size: body.size,
    contentType: body.contentType as string | undefined
  }), 201);
});

driveRoutes.post("/drive/uploads/:id/complete", adminCsrfMiddleware, async (c) => {
  return jsonSuccess(c, await completeDriveUpload(c.env, c.req.param("id")));
});

driveRoutes.patch("/drive/nodes/:id", adminCsrfMiddleware, async (c) => {
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || typeof body.name !== "string" || typeof body.version !== "number" || !Number.isSafeInteger(body.version)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Rename payload is invalid.");
  }
  return jsonSuccess(c, await renameNode(c.env, c.req.param("id"), body.name, body.version));
});

driveRoutes.post("/drive/nodes/:id/move", adminCsrfMiddleware, async (c) => {
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || typeof body.parentId !== "string" || typeof body.version !== "number" || !Number.isSafeInteger(body.version)) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Move payload is invalid.");
  }
  return jsonSuccess(c, await moveNode(c.env, c.req.param("id"), body.parentId, body.version));
});

driveRoutes.post("/drive/nodes/:id/copy", adminCsrfMiddleware, async (c) => {
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || typeof body.parentId !== "string" || typeof body.name !== "string" ||
      (body.overwrite !== undefined && typeof body.overwrite !== "boolean")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Copy payload is invalid.");
  }
  return jsonSuccess(c, await copyNode(
    c.env,
    c.req.param("id"),
    body.parentId,
    body.name,
    body.overwrite === true
  ), 201);
});

driveRoutes.delete("/drive/nodes/:id", adminCsrfMiddleware, async (c) => {
  await trashNode(c.env, c.req.param("id"));
  return jsonSuccess(c, { ok: true });
});

driveRoutes.post("/drive/nodes/:id/share", adminCsrfMiddleware, async (c) => {
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || (body.expiresInSeconds !== undefined && typeof body.expiresInSeconds !== "number")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Share payload is invalid.");
  }
  return jsonSuccess(c, await createDropFromDrive(c.env, c.req.param("id"), body.expiresInSeconds as number | undefined, new URL(c.req.url).origin), 201);
});

driveRoutes.post("/drive/import-drop", adminCsrfMiddleware, async (c) => {
  const body = await parseJsonBody<unknown>(c.req.raw);
  if (!isRecord(body) || typeof body.code !== "string" || typeof body.fileId !== "string" ||
      (body.parentId !== undefined && typeof body.parentId !== "string")) {
    throw new AppError(400, ERROR_CODES.BAD_REQUEST, "Drop import payload is invalid.");
  }
  return jsonSuccess(c, await saveDropFileToDrive(c.env, body.code, body.fileId, body.parentId as string | undefined), 201);
});

driveRoutes.get("/drive/search", async (c) => jsonSuccess(c, await searchDrive(c.env, c.req.query("q") || "")));
driveRoutes.get("/drive/trash", async (c) => jsonSuccess(c, await listTrash(c.env)));

driveRoutes.post("/drive/trash/:id/restore", adminCsrfMiddleware, async (c) => {
  return jsonSuccess(c, await restoreNode(c.env, c.req.param("id")));
});
