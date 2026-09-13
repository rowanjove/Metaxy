import type { GalleryImageDto } from "../../shared/gallery-contracts";

export type GalleryUploadState =
  | "queued"
  | "processing"
  | "preparing"
  | "uploading"
  | "finalizing"
  | "success"
  | "error"
  | "cancelled";

export interface GalleryUploadTask {
  id: string;
  originalFile: File;
  processedBlob?: Blob;
  thumbBlob?: Blob;
  originalName: string;
  outputName: string;
  contentType: string;
  state: GalleryUploadState;
  progress: number; // 0 - 100
  originalBytes: number;
  outputBytes?: number;
  width?: number;
  height?: number;
  uploadId?: string;
  imageId?: string;
  result?: GalleryImageDto;
  errorCode?: string;
  errorMessage?: string;
  cancelRequested?: boolean;
  xhr?: XMLHttpRequest;
  thumbXhr?: XMLHttpRequest;
}
