import type { Context } from "hono";
import type { WorkerContext } from "../env";
import { AppError } from "../errors";
import { ERROR_CODES } from "../../shared/error-codes";

export function getClientIp(c: Context<WorkerContext>): string {
  return (
    c.req.header("cf-connecting-ip") ||
    "local"
  );
}

export async function checkRateLimit(
  limiter: { limit(options: { key: string }): Promise<{ success: boolean }> } | undefined,
  key: string,
  options: { failOpen?: boolean } = {}
): Promise<void> {
  const failOpen = options.failOpen ?? false;
  if (!limiter) {
    if (!failOpen) {
      throw new AppError(
        503,
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "Rate limiting is not configured on this server."
      );
    }
    return;
  }

  try {
    const result = await limiter.limit({ key });
    if (!result.success) {
      throw new AppError(
        429,
        ERROR_CODES.RATE_LIMITED,
        "Too many requests. Please slow down and try again later."
      );
    }
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    console.error(JSON.stringify({ event: "rate_limit_check_failed", error: String(err) }));
    if (!failOpen) {
      throw new AppError(
        503,
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "Rate limiting is temporarily unavailable. Please try again later.",
        err
      );
    }
  }
}
