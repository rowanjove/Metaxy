import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { COOKIE_NAME, LEGACY_COOKIE_NAME } from "../../shared/constants";
import { validateAdminSession } from "../services/session-service";

export const adminSessionMiddleware: MiddlewareHandler<WorkerContext> = async (c, next) => {
  const token =
    getCookie(c, COOKIE_NAME) ||
    getCookie(c, LEGACY_COOKIE_NAME) ||
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "")?.trim();

  const session = await validateAdminSession(c.env, token);
  if (!session) {
    throw new AppError(401, ERROR_CODES.INVALID_SESSION, "Admin authentication required.");
  }

  c.set("adminSession", {
    id: session.id,
    tokenHash: session.token_hash
  });

  await next();
};
