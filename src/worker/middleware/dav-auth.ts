import type { MiddlewareHandler } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { authenticateDavDevice } from "../services/device-service";
import { checkRateLimit, getClientIp } from "./rate-limit";

function decodeBasic(value: string): { username: string; password: string } | null {
  if (!/^Basic\s+/i.test(value)) return null;
  try {
    const decoded = atob(value.replace(/^Basic\s+/i, "").trim());
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

export const davAuthMiddleware: MiddlewareHandler<WorkerContext> = async (c, next) => {
  await checkRateLimit(c.env.DAV_RATE_LIMITER, `dav_${getClientIp(c)}`);
  const url = new URL(c.req.url);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    c.header("WWW-Authenticate", 'Basic realm="Metaxy WebDAV", charset="UTF-8"');
    throw new AppError(401, ERROR_CODES.DAV_UNAUTHORIZED, "WebDAV requires HTTPS.");
  }
  const credentials = decodeBasic(c.req.header("authorization") || "");
  const device = credentials ? await authenticateDavDevice(c.env, credentials.username, credentials.password) : null;
  if (!device) {
    c.header("WWW-Authenticate", 'Basic realm="Metaxy WebDAV", charset="UTF-8"');
    throw new AppError(401, ERROR_CODES.DAV_UNAUTHORIZED, "Valid WebDAV credentials are required.");
  }
  c.set("davDevice", { id: device.id, username: device.username });
  await next();
};
