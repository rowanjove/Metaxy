import type { MiddlewareHandler } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";
import { timingSafeEqual } from "../lib/crypto";

export const uploadAuthMiddleware: MiddlewareHandler<WorkerContext> = async (c, next) => {
  const uploadMode = c.env.UPLOAD_MODE === "public" ? "public" : "token";

  if (uploadMode === "token") {
    const configuredToken = c.env.UPLOAD_TOKEN?.trim();
    if (!configuredToken) {
      throw new AppError(
        503,
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "Server is in token upload mode, but UPLOAD_TOKEN secret is not configured."
      );
    }

    const providedToken =
      c.req.header("x-pocketrelay-upload-token")?.trim() ||
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();

    if (!providedToken) {
      throw new AppError(
        401,
        ERROR_CODES.UNAUTHORIZED,
        "Upload token is required in token mode."
      );
    }

    const isValid = await timingSafeEqual(providedToken, configuredToken);
    if (!isValid) {
      throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Invalid upload token.");
    }
  }

  await next();
};
