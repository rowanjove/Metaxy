// Capacity and limit constants (in bytes)
export const BYTE_UNITS = {
  KiB: 1024,
  MiB: 1048576,
  GiB: 1073741824
} as const;

export const DEFAULT_LIMITS = {
  MAX_FILE_BYTES: 50 * BYTE_UNITS.MiB, // 52,428,800 bytes (50 MiB)
  MAX_DROP_FILE_BYTES: 500 * BYTE_UNITS.MiB, // 524,288,000 bytes (500 MiB)
  MAX_TEXT_BYTES: 5 * BYTE_UNITS.MiB, // 5,242,880 bytes (5 MiB)
  TEXT_D1_MAX_BYTES: 1 * BYTE_UNITS.MiB, // 1,048,576 bytes (1 MiB)
  MAX_FILES_PER_DROP: 10,
  CODE_MIN_LENGTH: 5,
  CODE_MAX_LENGTH: 8,
  DEFAULT_CODE_LENGTH: 6,
  DEFAULT_EXPIRY_SECONDS: 86400, // 24 hours
  MAX_EXPIRY_SECONDS: 604800, // 7 days (604,800 seconds)
  DRAFT_TTL_SECONDS: 3600, // 1 hour (3,600 seconds)
  PRESIGNED_URL_TTL_SECONDS: 300, // 5 minutes
  MAX_PRESIGNED_URL_TTL_SECONDS: 300,
  DELETION_SETTLE_SECONDS: 30,
  ADMIN_SESSION_TTL_SECONDS: 30 * 86400, // 30 days
  MAX_FILENAME_LENGTH: 255
} as const;

export const CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const EXPIRY_OPTIONS = [
  600, // 10 minutes
  3600, // 1 hour
  21600, // 6 hours
  86400, // 24 hours
  259200, // 3 days
  604800 // 7 days
] as const;

export const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif"
]);

export const DANGEROUS_EXTENSIONS = new Set([
  "exe", "msi", "msp", "com", "scr", "pif", "bat", "cmd", "ps1", "psm1", "vbs",
  "vbe", "js", "jse", "ws", "wsf", "wsh", "sh", "bash", "zsh", "fish", "app",
  "dmg", "pkg", "deb", "rpm", "apk", "jar", "reg", "lnk", "url", "scf", "hta", "cpl"
]);

export const DANGEROUS_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-sh",
  "application/x-csh",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/x-bat",
  "application/x-powershell",
  "application/vnd.android.package-archive"
]);

export const COOKIE_NAME = "metaxy_session";
export const LEGACY_COOKIE_NAME = "pocketrelay_session";
export const STORAGE_KEYS = {
  LOCALE: "metaxy.locale.v2",
  THEME: "metaxy.theme.v2",
  UPLOAD_TOKEN: "metaxy.uploadToken.v2"
} as const;
export const LEGACY_STORAGE_KEYS = {
  LOCALE: "pocketrelay.locale.v2",
  THEME: "pocketrelay.theme.v2",
  UPLOAD_TOKEN: "pocketrelay.uploadToken.v2"
} as const;
