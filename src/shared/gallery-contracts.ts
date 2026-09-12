export interface GalleryImageDto {
  id: string;
  url: string;
  rawUrl: string;
  markdown: string;
  html: string;
  bbcode: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
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
