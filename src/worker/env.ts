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
  | "DRIVE_RATE_LIMITER"
  | "DAV_RATE_LIMITER"
  | "DRIVE"
  | "GALLERY"
  | "DRIVE_ENABLED"
  | "DRIVE_BUCKET_NAME"
  | "GALLERY_BUCKET_NAME"
  | "DAV_USERNAME"
  | "DRIVE_MAX_FILE_BYTES_HARD"
  | "DAV_MAX_FILE_BYTES_HARD"
  | "ADMIN_DOMAIN"
  | "GALLERY_UPLOAD_MODE"
  | "PUBLIC_IMAGE_BASE_URL"
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
  DRIVE_ENABLED?: string;
  DRIVE_MAX_FILE_BYTES_HARD?: string;
  DAV_MAX_FILE_BYTES_HARD?: string;
  DRIVE_BUCKET_NAME?: string;
  GALLERY_BUCKET_NAME?: string;
  DAV_USERNAME?: string;
  DRIVE?: R2Bucket;
  GALLERY?: R2Bucket;

  LOGIN_RATE_LIMITER?: RateLimit;
  UPLOAD_RATE_LIMITER?: RateLimit;
  RETRIEVE_RATE_LIMITER?: RateLimit;
  DRIVE_RATE_LIMITER?: RateLimit;
  DAV_RATE_LIMITER?: RateLimit;

  ADMIN_PASSWORD?: string;
  ADMIN_KEY?: string;
  ADMIN_DOMAIN?: string;
  UPLOAD_TOKEN?: string;
  SHORTCUT_TOKEN?: string;
  GALLERY_UPLOAD_MODE?: "private" | "token" | "public" | string;
  GALLERY_UPLOAD_TOKEN?: string;
  GALLERY_ADMIN_TOKEN?: string;
  GALLERY_ALLOWED_REFERERS?: string;
  PUBLIC_IMAGE_BASE_URL?: string;
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
    davDevice?: {
      id: string;
      username: string;
    };
  };
}
