export interface GalleryImageDto {
  id: string;
  url: string;
  rawUrl: string;
  thumbUrl?: string | null;
  markdown: string;
  html: string;
  bbcode: string;
  jsonSnippet?: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  originalSizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  hash?: string | null;
  favorite: boolean;
  albumId?: string | null;
  dominantColor?: string | null;
  metadataJson?: string | null;
  createdAt: number;
  viewCount: number;
}

export interface GalleryUploadResponse {
  success: boolean;
  code?: number;
  message?: string;
  data: GalleryImageDto;
}

export interface GalleryListResponse {
  items: GalleryImageDto[];
  total: number;
  nextCursor?: string | null;
}

export interface GalleryPrepareUploadRequest {
  filename: string;
  size: number;
  contentType: string;
  width?: number;
  height?: number;
  hasThumbnail?: boolean;
  thumbSize?: number;
}

export interface GalleryPrepareUploadResponse {
  uploadId: string;
  imageId: string;
  uploadUrl: string;
  thumbUploadUrl?: string | null;
  expiresAt: number;
}

export interface GalleryCompleteUploadRequest {
  filename?: string;
  originalSizeBytes?: number;
  width?: number;
  height?: number;
  albumId?: string | null;
  hasThumbnail?: boolean;
  dominantColor?: string | null;
  metadata?: Record<string, unknown>;
}

export interface GalleryAlbumDto {
  id: string;
  name: string;
  slug: string;
  coverImageId?: string | null;
  coverImageUrl?: string | null;
  imageCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface GalleryBatchRequest {
  ids: string[];
  operation: "delete" | "favorite" | "unfavorite" | "move_album";
  albumId?: string | null;
}

export interface GalleryBatchResponse {
  success: boolean;
  processedCount: number;
  operation: string;
}

export interface GalleryServerSettings {
  compressEnabled: boolean;
  compressQuality: number;
  resizeMaxDimension: number;
  webpMode: "OFF" | "SMART" | "ALWAYS";
  stripMetadata: boolean;
  watermarkEnabled: boolean;
  watermarkText: string;
  watermarkPosition: string;
  copyDefaultFormat: "url" | "markdown" | "html" | "bbcode";
  copyAuto: boolean;
  uploadConcurrency: number;
  publicBaseUrl: string;
}
