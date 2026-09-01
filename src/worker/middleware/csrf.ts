import type { MiddlewareHandler } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { getCookie } from "hono/cookie";
import { COOKIE_NAME } from "../../shared/constants";

export const adminCsrfMiddleware: MiddlewareHandler<WorkerContext> = async (c, next) => {
  const method = c.req.method.toUpperCase();

  // CSRF validation only applies to mutating requests
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    // Bearer-authenticated API clients are not vulnerable to ambient-cookie
    // CSRF. Keep Origin/Referer enforcement for browser cookie sessions.
    const hasBearer = /^Bearer\s+\S+/i.test(c.req.header("authorization") || "");
    if (hasBearer && !getCookie(c, COOKIE_NAME)) {
      await next();
      return;
    }
    const origin = c.req.header("origin");
    const referer = c.req.header("referer");
    const requestOrigin = new URL(c.req.url).origin;

    if (origin) {
      if (origin !== requestOrigin) {
        throw new AppError(403, ERROR_CODES.CSRF_DETECTED, "Cross-origin request blocked.");
      }
    } else if (referer) {
      try {
        const refererOrigin = new URL(referer).origin;
        if (refererOrigin !== requestOrigin) {
          throw new AppError(403, ERROR_CODES.CSRF_DETECTED, "Cross-origin request blocked.");
        }
      } catch {
        throw new AppError(403, ERROR_CODES.CSRF_DETECTED, "Invalid referer header.");
      }
    } else {
      // Both Origin and Referer are missing on mutation request
      throw new AppError(403, ERROR_CODES.CSRF_DETECTED, "Missing Origin or Referer header.");
    }
  }

  await next();
};
