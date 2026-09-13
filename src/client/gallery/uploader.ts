import type { GalleryUploadTask } from "./upload-task";
import type {
  GalleryPrepareUploadRequest,
  GalleryPrepareUploadResponse,
  GalleryCompleteUploadRequest,
  GalleryImageDto
} from "../../shared/gallery-contracts";
import { getSavedUploadToken } from "../state";

export interface UploaderOptions {
  albumId?: string | null;
  onProgress?: (progress: number) => void;
}

export async function uploadSingleTask(
  task: GalleryUploadTask,
  options: UploaderOptions = {}
): Promise<GalleryImageDto> {
  const blob = task.processedBlob || task.originalFile;
  const thumbBlob = task.thumbBlob;
  const token = getSavedUploadToken();

  const authHeaders: Record<string, string> = {};
  if (token) {
    authHeaders["Authorization"] = `Bearer ${token}`;
    authHeaders["X-Gallery-Upload-Token"] = token;
  }

  // 1. Prepare upload session (15 - 20%)
  task.state = "preparing";
  task.progress = 18;
  options.onProgress?.(18);

  const preparePayload: GalleryPrepareUploadRequest = {
    filename: task.outputName || task.originalName,
    size: blob.size,
    contentType: task.contentType || blob.type || "image/jpeg",
    width: task.width,
    height: task.height,
    hasThumbnail: Boolean(thumbBlob),
    thumbSize: thumbBlob ? thumbBlob.size : undefined
  };

  const prepRes = await fetch("/api/v1/gallery/uploads/prepare", {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(preparePayload)
  });

  if (!prepRes.ok) {
    const errJson: any = await prepRes.json().catch(() => ({}));
    throw new Error(errJson?.error?.message || `Prepare failed: HTTP ${prepRes.status}`);
  }

  const { data: prepData } = (await prepRes.json()) as { data: GalleryPrepareUploadResponse };
  task.uploadId = prepData.uploadId;
  task.imageId = prepData.imageId;

  // 2. Upload main image to R2 staging with real progress (20% - 85%)
  task.state = "uploading";
  await uploadBlobWithXhr(
    prepData.uploadUrl,
    blob,
    task.contentType || blob.type || "image/jpeg",
    (pct) => {
      // Scale 0-100% of main upload to 20-85% overall
      const overall = 20 + Math.round(pct * 0.65);
      task.progress = overall;
      options.onProgress?.(overall);
    },
    (xhr) => {
      task.xhr = xhr;
    }
  );

  // 3. Upload thumbnail to R2 staging if present (85% - 92%)
  if (prepData.thumbUploadUrl && thumbBlob) {
    await uploadBlobWithXhr(
      prepData.thumbUploadUrl,
      thumbBlob,
      "image/webp",
      (pct) => {
        const overall = 85 + Math.round(pct * 0.07);
        task.progress = overall;
        options.onProgress?.(overall);
      },
      (xhr) => {
        task.thumbXhr = xhr;
      }
    );
  }

  // 4. Finalize & solidify image (92% - 98%)
  task.state = "finalizing";
  task.progress = 95;
  options.onProgress?.(95);

  const completePayload: GalleryCompleteUploadRequest = {
    filename: task.outputName || task.originalName,
    originalSizeBytes: task.originalBytes,
    width: task.width,
    height: task.height,
    albumId: options.albumId ?? null,
    hasThumbnail: Boolean(thumbBlob)
  };

  const compRes = await fetch(`/api/v1/gallery/uploads/${task.uploadId}/complete`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(completePayload)
  });

  if (!compRes.ok) {
    const errJson: any = await compRes.json().catch(() => ({}));
    throw new Error(errJson?.error?.message || `Complete failed: HTTP ${compRes.status}`);
  }

  if (task.cancelRequested) {
    task.state = "cancelled";
    task.errorMessage = "Cancelled by user";
    throw new Error("Upload cancelled by user.");
  }

  const { data: compData } = (await compRes.json()) as { data: GalleryImageDto };
  task.state = "success";
  task.progress = 100;
  task.result = compData;
  options.onProgress?.(100);

  return compData;
}

function uploadBlobWithXhr(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (pct: number) => void,
  registerXhr: (xhr: XMLHttpRequest) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    registerXhr(xhr);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`R2 PUT upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error("Network error during R2 direct upload."));
    };

    xhr.onabort = () => {
      reject(new Error("Upload aborted by user."));
    };

    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(blob);
  });
}
