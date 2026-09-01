import type { ErrorCode } from "./error-codes";

// Standard API Response Wrappers
export interface ApiResponse<T> {
  data: T;
}

export interface ApiErrorResponse {
  error: {
    code: ErrorCode | string;
    message: string;
    requestId?: string;
  };
}

// Meta
export interface MetaLimits {
  maxTextBytes: number;
  maxFileBytes: number;
  maxDropFileBytes: number;
  maxFilesPerDrop: number;
}

export interface MetaData {
  siteName: string;
  uploadMode: "public" | "token";
  limits: MetaLimits;
  expiryOptions: number[];
  defaultExpirySeconds: number;
  codeLength: number;
}

// Drops
export interface CreateDraftRequest {
  expiresInSeconds?: number;
}

export interface CreateDraftData {
  dropId: string;
  draftToken: string;
  draftExpiresAt: number;
}

export interface CommitDropData {
  code: string;
  url: string;
  expiresAt: number;
}

export type DropItemType = "text" | "file";

export interface FileItemDetail {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  previewable: boolean;
  contentUrl: string;
  downloadUrl: string;
}

export interface TextDropItemDto {
  id: string;
  type: "text";
  size: number;
  content: string | null;
  contentUrl: string | null;
}

export interface FileDropItemDto {
  id: string;
  type: "file";
  file: FileItemDetail;
}

export type DropItemDto = TextDropItemDto | FileDropItemDto;

export interface DropDetailData {
  code: string;
  expiresAt: number;
  remainingSeconds: number;
  items: DropItemDto[];
}

// Uploads
export interface PrepareUploadRequest {
  dropId: string;
  fileId?: string;
  filename: string;
  size: number;
  contentType: string;
  sortOrder?: number;
}

export interface PrepareUploadData {
  fileId: string;
  uploadUrl: string;
  method: "PUT";
  headers: {
    "Content-Type": string;
  };
  expiresAt: number;
}

export interface CompleteUploadRequest {
  dropId: string;
  fileId: string;
}

export interface CompleteUploadData {
  fileId: string;
  status: "uploaded";
}

// iOS Shortcut
export interface ShortcutPushRequest {
  content: string;
  expiresInSeconds?: number;
}

export interface ShortcutPushData {
  code: string;
  url: string;
  expiresAt: number;
}

// Admin
export interface AdminLoginRequest {
  password: string;
}

export interface AdminLoginData {
  ok: true;
}

export interface AdminOverviewData {
  activeDropsCount: number;
  createdTodayCount: number;
  activeTotalFileBytes: number;
  expiringIn24hCount: number;
}

export interface AdminDropRowDto {
  id: string;
  code: string;
  status: "draft" | "active" | "revoked" | "deleting" | "expired";
  rawStatus: "draft" | "active" | "revoked" | "deleting";
  hasText: boolean;
  fileCount: number;
  totalSize: number;
  viewCount: number;
  createdAt: number;
  expiresAt: number;
  lastViewedAt: number | null;
}

export interface AdminDropsListData {
  drops: AdminDropRowDto[];
  total?: number;
  nextCursor?: string | null;
}

export interface AdminSettingsData {
  settings: {
    site_name: string;
    default_expiry_seconds: number;
    max_expiry_seconds: number;
    max_file_bytes: number;
    max_drop_file_bytes: number;
    max_files_per_drop: number;
    max_text_bytes: number;
    code_length: number;
    allow_public_risky_files: boolean;
  };
  readonly: {
    uploadMode: "public" | "token";
    hasAdminPasswordSecret: boolean;
    hasUploadTokenSecret: boolean;
    hasShortcutTokenSecret: boolean;
    hasR2AccessKeys: boolean;
    hardLimits: {
      maxFileBytes: number;
      maxDropFileBytes: number;
      maxTextBytes: number;
      maxFilesPerDrop: number;
      presignedUrlTtlSeconds: number;
    };
  };
}

export interface UpdateSettingsRequest {
  site_name?: string;
  default_expiry_seconds?: number;
  max_expiry_seconds?: number;
  max_file_bytes?: number;
  max_drop_file_bytes?: number;
  max_files_per_drop?: number;
  max_text_bytes?: number;
  code_length?: number;
  allow_public_risky_files?: boolean;
}
