import type { MiddlewareHandler } from "hono";
import type { WorkerContext } from "../env";

export const securityHeadersMiddleware: MiddlewareHandler<WorkerContext> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);

  await next();

  // Static Assets responses have immutable headers. Always clone before adding
  // security headers so both API and asset responses follow the same path.
  const headers = new Headers(c.res.headers);
  headers.set("X-Request-Id", requestId);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  const r2Origin = c.env.R2_ACCOUNT_ID?.trim()
    ? `https://${c.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`
    : "'self'";
  headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ${r2Origin};`
  );
  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers
  });
};
