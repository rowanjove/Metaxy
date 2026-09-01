import { Hono } from "hono";
import type { Env, WorkerContext } from "./env";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { handleWorkerError, formatErrorResponse } from "./errors";
import { ERROR_CODES } from "../shared/error-codes";
import { metaRoutes } from "./routes/meta";
import { dropsRoutes } from "./routes/drops";
import { uploadsRoutes } from "./routes/uploads";
import { filesRoutes } from "./routes/files";
import { shortcutRoutes } from "./routes/shortcut";
import { adminRoutes } from "./routes/admin";
import { runScheduledCleanup } from "./services/cleanup-service";

export const app = new Hono<WorkerContext>();

// Apply security headers to all responses
app.use("*", securityHeadersMiddleware);

// Mount API routes
app.route("/api/v1", metaRoutes);
app.route("/api/v1", dropsRoutes);
app.route("/api/v1", uploadsRoutes);
app.route("/api/v1", filesRoutes);
app.route("/api/v1", adminRoutes);
app.route("/api", shortcutRoutes);

// Fallback for unmatched API routes
app.all("/api/*", (c) => {
  const requestId = c.get("requestId");
  return c.json(
    formatErrorResponse(ERROR_CODES.NOT_FOUND, "API endpoint not found.", requestId),
    404,
    { "X-Request-Id": requestId }
  );
});

// Static Assets fallback. This is required for /d/:code navigation because
// those paths are intentionally configured with run_worker_first.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Global error handler
app.onError(handleWorkerError);

// Export worker handler
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledCleanup(env));
  }
} satisfies ExportedHandler<Env>;

export default worker;
