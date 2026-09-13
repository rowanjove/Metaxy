import type { MiddlewareHandler } from "hono";
import type { WorkerContext } from "../env";

export const adminDomainMiddleware: MiddlewareHandler<WorkerContext> = async (c, next) => {
  const adminDomain = c.env.ADMIN_DOMAIN?.trim();
  if (adminDomain) {
    const requestHost = (c.req.header("host") || new URL(c.req.url).host).toLowerCase().split(":")[0];
    const targetDomain = adminDomain.toLowerCase().split(":")[0];
    if (requestHost !== targetDomain) {
      return c.text("404 Not Found", 404);
    }
  }
  await next();
};
