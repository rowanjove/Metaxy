import type { Context } from "hono";
import { ERROR_CODES, type ErrorCode } from "../shared/error-codes";
import type { ApiErrorResponse } from "../shared/contracts";
import type { WorkerContext } from "./env";

export class AppError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode | string;
  public readonly publicMessage: string;
  public readonly cause?: unknown;

  constructor(status: number, code: ErrorCode | string, message: string, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    this.cause = cause;
  }
}

export function formatErrorResponse(
  code: ErrorCode | string,
  message: string,
  requestId?: string
): ApiErrorResponse {
  return {
    error: {
      code,
      message,
      ...(requestId ? { requestId } : {})
    }
  };
}

export function handleWorkerError(err: Error, c: Context<WorkerContext>): Response {
  const requestId = c.get("requestId") || crypto.randomUUID();

  if (err instanceof AppError) {
    return c.json(
      formatErrorResponse(err.code, err.publicMessage, requestId),
      err.status as any,
      { "X-Request-Id": requestId }
    );
  }

  // Generic/Unknown error
  console.error(JSON.stringify({
    event: "unhandled_error",
    requestId,
    error: err instanceof Error ? err.message : String(err)
  }));
  return c.json(
    formatErrorResponse(ERROR_CODES.INTERNAL_ERROR, "An unexpected server error occurred.", requestId),
    500,
    { "X-Request-Id": requestId }
  );
}
