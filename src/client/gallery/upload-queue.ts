import type { GalleryUploadTask } from "./upload-task";
import { processImageFile, type ImagePipelineOptions } from "./image-pipeline";
import { uploadSingleTask } from "./uploader";

export interface UploadQueueOptions {
  concurrency?: number; // 1 to 5, default 3
  pipelineOptions?: ImagePipelineOptions;
  albumId?: string | null;
  onTaskUpdate?: (task: GalleryUploadTask) => void;
  onQueueComplete?: () => void;
}

export class GalleryUploadQueue {
  private tasks: GalleryUploadTask[] = [];
  private concurrency = 3;
  private activeCount = 0;
  private pipelineOptions: ImagePipelineOptions = {};
  private albumId: string | null = null;
  private onTaskUpdate?: (task: GalleryUploadTask) => void;
  private onQueueComplete?: () => void;

  constructor(options: UploadQueueOptions = {}) {
    this.concurrency = Math.min(Math.max(options.concurrency ?? 3, 1), 5);
    this.pipelineOptions = options.pipelineOptions || {};
    this.albumId = options.albumId ?? null;
    this.onTaskUpdate = options.onTaskUpdate;
    this.onQueueComplete = options.onQueueComplete;
  }

  public setConcurrency(n: number) {
    this.concurrency = Math.min(Math.max(n, 1), 5);
    this.pump();
  }

  public setPipelineOptions(opts: ImagePipelineOptions) {
    this.pipelineOptions = { ...this.pipelineOptions, ...opts };
  }

  public setAlbumId(albumId: string | null) {
    this.albumId = albumId;
  }

  public getTasks(): GalleryUploadTask[] {
    return this.tasks;
  }

  public addFiles(files: File[] | FileList) {
    const list = Array.from(files);
    for (const file of list) {
      const task: GalleryUploadTask = {
        id: crypto.randomUUID(),
        originalFile: file,
        originalName: file.name,
        outputName: file.name,
        contentType: file.type || "image/jpeg",
        state: "queued",
        progress: 0,
        originalBytes: file.size
      };
      this.tasks.push(task);
      this.notify(task);
    }
    this.pump();
  }

  public retryTask(taskId: string) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || task.state === "uploading" || task.state === "processing" || task.state === "finalizing") {
      return;
    }
    task.state = "queued";
    task.progress = 0;
    task.errorCode = undefined;
    task.errorMessage = undefined;
    task.cancelRequested = false;
    this.notify(task);
    this.pump();
  }

  public cancelTask(taskId: string) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.cancelRequested = true;
    if (task.xhr) {
      try {
        task.xhr.abort();
      } catch {}
    }
    if (task.thumbXhr) {
      try {
        task.thumbXhr.abort();
      } catch {}
    }
    task.state = "cancelled";
    task.errorMessage = "Cancelled by user";
    this.notify(task);
  }

  public clearCompleted() {
    this.tasks = this.tasks.filter((t) => t.state !== "success" && t.state !== "cancelled");
  }

  public clearAll() {
    for (const task of this.tasks) {
      if (task.state !== "success" && task.state !== "error" && task.state !== "cancelled") {
        this.cancelTask(task.id);
      }
    }
    this.tasks = [];
  }

  private pump() {
    while (this.activeCount < this.concurrency) {
      const nextTask = this.tasks.find((t) => t.state === "queued");
      if (!nextTask) break;
      this.activeCount++;
      void this.executeTask(nextTask);
    }

    if (this.activeCount === 0) {
      const hasPending = this.tasks.some((t) => t.state === "queued" || t.state === "processing" || t.state === "uploading");
      if (!hasPending && this.tasks.length > 0) {
        this.onQueueComplete?.();
      }
    }
  }

  private async executeTask(task: GalleryUploadTask) {
    try {
      // Step 1: Local Image Processing (0% - 15%)
      task.state = "processing";
      task.progress = 5;
      this.notify(task);

      const processed = await processImageFile(task.originalFile, this.pipelineOptions);
      if (task.cancelRequested) return;
      task.processedBlob = processed.blob;
      task.thumbBlob = processed.thumbBlob;
      task.outputName = processed.filename;
      task.contentType = processed.contentType;
      task.outputBytes = processed.outputBytes;
      task.width = processed.width;
      task.height = processed.height;
      task.progress = 15;
      this.notify(task);

      // Step 2-4: Prepare, R2 PUT & Complete (15% - 100%)
      await uploadSingleTask(task, {
        albumId: this.albumId,
        onProgress: (p) => {
          this.notify(task);
        }
      });
      if (task.cancelRequested) {
        task.state = "cancelled";
        task.errorMessage = "Cancelled by user";
      }
      this.notify(task);
    } catch (err: any) {
      if (task.state !== "cancelled") {
        task.state = "error";
        task.errorMessage = err.message || "Upload failed";
        this.notify(task);
      }
    } finally {
      this.activeCount--;
      this.pump();
    }
  }

  private notify(task: GalleryUploadTask) {
    this.onTaskUpdate?.(task);
  }
}
