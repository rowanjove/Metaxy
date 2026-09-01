import type { Context } from "hono";
import type { ApiResponse } from "../../shared/contracts";
import { formatErrorResponse } from "../errors";
import type { ErrorCode } from "../../shared/error-codes";
import type { WorkerContext } from "../env";

export function jsonSuccess<T>(
  c: Context<WorkerContext>,
  data: T,
  status: 200 | 201 | 204 = 200
): Response {
  const requestId = c.get("requestId");
  return c.json<ApiResponse<T>>(
    { data },
    status as any,
    requestId ? { "X-Request-Id": requestId } : {}
  );
}

export function jsonError(
  c: Context<WorkerContext>,
  code: ErrorCode | string,
  message: string,
  status: number = 400
): Response {
  const requestId = c.get("requestId");
  return c.json(
    formatErrorResponse(code, message, requestId),
    status as any,
    requestId ? { "X-Request-Id": requestId } : {}
  );
}
