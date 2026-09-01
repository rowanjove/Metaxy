import type { Context, MiddlewareHandler } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";

export const extractDraftToken = (c: Context<WorkerContext>): string => {
  const token =
    c.req.header("x-draft-token")?.trim() ||
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw new AppError(
      401,
      ERROR_CODES.INVALID_DRAFT_TOKEN,
      "X-Draft-Token header is required for this operation."
    );
  }

  return token;
};
