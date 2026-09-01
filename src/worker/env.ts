/**
 * Bindings are generated from wrangler.jsonc into worker-configuration.d.ts.
 * Keep only secrets and intentionally optional local-development values here so
 * the application type cannot drift from the deployment configuration.
 */
type GeneratedBindings = Omit<
  Cloudflare.Env,
  | "APP_NAME"
  | "UPLOAD_MODE"
  | "MAX_FILE_BYTES_HARD"
  | "MAX_DROP_FILE_BYTES_HARD"
  | "MAX_TEXT_BYTES_HARD"
  | "MAX_FILES_PER_DROP_HARD"
  | "PRESIGNED_URL_TTL_SECONDS"
  | "SHORTCUT_TOKEN"
  | "LOGIN_RATE_LIMITER"
  | "UPLOAD_RATE_LIMITER"
  | "RETRIEVE_RATE_LIMITER"
>;

export type Env = GeneratedBindings & {
  APP_NAME?: string;
  UPLOAD_MODE?: "public" | "token" | string;
  MAX_FILE_BYTES_HARD?: string;
  MAX_DROP_FILE_BYTES_HARD?: string;
  MAX_TEXT_BYTES_HARD?: string;
  MAX_FILES_PER_DROP_HARD?: string;
  PRESIGNED_URL_TTL_SECONDS?: string;
  R2_BUCKET_NAME?: string;

  LOGIN_RATE_LIMITER?: RateLimit;
  UPLOAD_RATE_LIMITER?: RateLimit;
  RETRIEVE_RATE_LIMITER?: RateLimit;

  ADMIN_PASSWORD?: string;
  UPLOAD_TOKEN?: string;
  SHORTCUT_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
};

export interface WorkerContext {
  Bindings: Env;
  Variables: {
    requestId: string;
    adminSession?: {
      id: string;
      tokenHash: string;
    };
  };
}
