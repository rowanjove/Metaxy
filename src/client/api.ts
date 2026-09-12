import type {
  ApiResponse,
  ApiErrorResponse,
  MetaData,
  CreateDraftData,
  PrepareUploadData,
  CommitDropData,
  DropDetailData,
  AdminOverviewData,
  AdminDropsListData,
  AdminSettingsData,
  UpdateSettingsRequest
} from "../shared/contracts";
import type { DriveListResult, DriveUploadPrepareResult, DriveUploadCompleteResult, DriveNodeDto } from "../shared/drive-contracts";
import type { GalleryImageDto, GalleryListResponse } from "../shared/gallery-contracts";
import { getSavedUploadToken } from "./state";
import { t } from "./i18n";

export class ApiClientError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(
  endpoint: string,
  options: RequestInit & { draftToken?: string } = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});

  // Add upload token if available
  const uploadToken = getSavedUploadToken();
  if (uploadToken && !headers.has("X-Metaxy-Upload-Token")) {
    headers.set("X-Metaxy-Upload-Token", uploadToken);
  }

  // Add draft token if specified
  if (options.draftToken && !headers.has("X-Draft-Token")) {
    headers.set("X-Draft-Token", options.draftToken);
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      ...options,
      headers
    });
  } catch (err: any) {
    throw new ApiClientError(0, "NETWORK_ERROR", t("errors.NETWORK_ERROR"));
  }

  if (response.status === 204) {
    return {} as T;
  }

  let json: any;
  try {
    json = await response.json();
  } catch {
    throw new ApiClientError(response.status, "INVALID_RESPONSE", "Invalid server response");
  }

  if (!response.ok) {
    const errData = (json as ApiErrorResponse)?.error;
    const errorCode = errData?.code || "UNKNOWN_ERROR";
    const localizedMessage = t(`errors.${errorCode}`);
    const message = localizedMessage !== `errors.${errorCode}` ? localizedMessage : errData?.message || "Error";

    throw new ApiClientError(response.status, errorCode, message);
  }

  return (json as ApiResponse<T>).data;
}

export const api = {
  // Meta & Health
  async getMeta(): Promise<MetaData> {
    return requestJson<MetaData>("/api/v1/meta");
  },

  // Drops
  async createDraft(expiresInSeconds?: number): Promise<CreateDraftData> {
    return requestJson<CreateDraftData>("/api/v1/drops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresInSeconds })
    });
  },

  async updateText(dropId: string, draftToken: string, text: string): Promise<void> {
    await requestJson<void>(`/api/v1/drops/${dropId}/text`, {
      method: "PUT",
      draftToken,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text
    });
  },

  async prepareUpload(
    dropId: string,
    draftToken: string,
    file: { fileId?: string; filename: string; size: number; contentType: string; sortOrder?: number }
  ): Promise<PrepareUploadData> {
    return requestJson<PrepareUploadData>("/api/v1/uploads/prepare", {
      method: "POST",
      draftToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dropId, ...file })
    });
  },

  async completeUpload(
    dropId: string,
    draftToken: string,
    fileId: string
  ): Promise<{ fileId: string; status: "uploaded" }> {
    return requestJson<{ fileId: string; status: "uploaded" }>("/api/v1/uploads/complete", {
      method: "POST",
      draftToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dropId, fileId })
    });
  },

  async commitDrop(dropId: string, draftToken: string): Promise<CommitDropData> {
    return requestJson<CommitDropData>(`/api/v1/drops/${dropId}/commit`, {
      method: "POST",
      draftToken
    });
  },

  async getDropDetail(code: string): Promise<DropDetailData> {
    return requestJson<DropDetailData>(`/api/v1/drops/${encodeURIComponent(code)}`);
  },

  async fetchR2Text(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load text: status ${res.status}`);
    }
    return res.text();
  },

  // Direct R2 Presigned Upload via XHR
  uploadFileToR2(
    uploadUrl: string,
    file: Blob,
    contentType: string,
    onProgress: (percent: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      xhr.open("PUT", uploadUrl, true);
      xhr.setRequestHeader("Content-Type", contentType);
      if (signal) {
        if (signal.aborted) { reject(new DOMException("Upload cancelled", "AbortError")); return; }
        signal.addEventListener("abort", abort, { once: true });
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onProgress(pct);
        }
      };

      xhr.onload = () => {
        signal?.removeEventListener("abort", abort);
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => {
        signal?.removeEventListener("abort", abort);
        reject(new Error("Network error during file upload"));
      };

      xhr.onabort = () => {
        signal?.removeEventListener("abort", abort);
        reject(new DOMException("Upload cancelled", "AbortError"));
      };

      xhr.send(file);
    });
  },

  // Admin APIs
  async adminLogin(password: string): Promise<void> {
    await requestJson<void>("/api/v1/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
  },

  async adminLogout(): Promise<void> {
    await requestJson<void>("/api/v1/admin/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  },

  async adminLogoutAll(): Promise<void> {
    await requestJson<void>("/api/v1/admin/logout-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  },

  async getAdminOverview(): Promise<AdminOverviewData> {
    return requestJson<AdminOverviewData>("/api/v1/admin/overview");
  },

  async getAdminDrops(options: { cursor?: string; search?: string; status?: string } = {}): Promise<AdminDropsListData> {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.search) params.set("search", options.search);
    if (options.status) params.set("status", options.status);
    return requestJson<AdminDropsListData>(`/api/v1/admin/drops?${params.toString()}`);
  },

  async getAdminDropDetail(id: string): Promise<any> {
    return requestJson<any>(`/api/v1/admin/drops/${encodeURIComponent(id)}`);
  },

  async patchAdminDrop(id: string, action: "revoke" | "extend", additionalSeconds?: number): Promise<void> {
    await requestJson<void>(`/api/v1/admin/drops/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, additionalSeconds })
    });
  },

  async deleteAdminDrop(id: string): Promise<void> {
    await requestJson<void>(`/api/v1/admin/drops/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" }
    });
  },

  async getAdminSettings(): Promise<AdminSettingsData> {
    return requestJson<AdminSettingsData>("/api/v1/admin/settings");
  },

  async updateAdminSettings(settings: UpdateSettingsRequest): Promise<any> {
    return requestJson<any>("/api/v1/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    });
  },

  // Drive APIs
  async listDrive(parentId?: string, cursor?: string, limit = 100): Promise<DriveListResult> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (parentId) params.set("parentId", parentId);
    if (cursor) params.set("cursor", cursor);
    return requestJson<DriveListResult>(`/api/v1/drive/nodes?${params.toString()}`);
  },

  async createDriveFolder(name: string, parentId?: string): Promise<DriveNodeDto> {
    return requestJson<DriveNodeDto>("/api/v1/drive/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId })
    });
  },

  async prepareDriveUpload(file: { filename: string; size: number; contentType: string; parentId?: string }): Promise<DriveUploadPrepareResult & { uploadUrl: string; method: "PUT"; headers: { "Content-Type": string } }> {
    return requestJson<DriveUploadPrepareResult & { uploadUrl: string; method: "PUT"; headers: { "Content-Type": string } }>("/api/v1/drive/uploads/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file)
    });
  },

  async completeDriveUpload(uploadId: string): Promise<DriveUploadCompleteResult> {
    return requestJson<DriveUploadCompleteResult>(`/api/v1/drive/uploads/${encodeURIComponent(uploadId)}/complete`, { method: "POST" });
  },

  async renameDriveNode(id: string, name: string, version: number): Promise<DriveNodeDto> {
    return requestJson<DriveNodeDto>(`/api/v1/drive/nodes/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, version })
    });
  },

  async moveDriveNode(id: string, parentId: string, version: number): Promise<DriveNodeDto> {
    return requestJson<DriveNodeDto>(`/api/v1/drive/nodes/${encodeURIComponent(id)}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentId, version })
    });
  },

  async copyDriveNode(id: string, parentId: string, name: string, overwrite = false): Promise<DriveNodeDto> {
    return requestJson<DriveNodeDto>(`/api/v1/drive/nodes/${encodeURIComponent(id)}/copy`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentId, name, overwrite })
    });
  },

  async deleteDriveNode(id: string): Promise<void> {
    await requestJson<void>(`/api/v1/drive/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async shareDriveNode(id: string, expiresInSeconds = 86400): Promise<{ code: string; url: string; expiresAt: number }> {
    return requestJson<{ code: string; url: string; expiresAt: number }>(`/api/v1/drive/nodes/${encodeURIComponent(id)}/share`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresInSeconds })
    });
  },

  async saveDropFileToDrive(code: string, fileId: string, parentId?: string): Promise<DriveNodeDto> {
    return requestJson<DriveNodeDto>("/api/v1/drive/import-drop", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, fileId, parentId })
    });
  },

  async createDriveDevice(name: string): Promise<{ id: string; name: string; username: string; password: string; createdAt: number }> {
    return requestJson<{ id: string; name: string; username: string; password: string; createdAt: number }>("/api/v1/drive/devices", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name })
    });
  },

  async listDriveDevices(): Promise<Array<{ id: string; name: string; username: string; createdAt: number; lastUsedAt: number | null }>> {
    return requestJson<Array<{ id: string; name: string; username: string; createdAt: number; lastUsedAt: number | null }>>("/api/v1/drive/devices");
  },

  async revokeDriveDevice(id: string): Promise<void> {
    await requestJson<void>(`/api/v1/drive/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async searchDrive(query: string): Promise<DriveNodeDto[]> {
    return requestJson<DriveNodeDto[]>(`/api/v1/drive/search?q=${encodeURIComponent(query)}`);
  },

  async listDriveTrash(): Promise<DriveNodeDto[]> {
    return requestJson<DriveNodeDto[]>("/api/v1/drive/trash");
  },

  async restoreDriveNode(id: string): Promise<DriveNodeDto> {
    return requestJson<DriveNodeDto>(`/api/v1/drive/trash/${encodeURIComponent(id)}/restore`, { method: "POST" });
  },

  async uploadDriveFile(file: File, parentId: string, options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {}): Promise<DriveNodeDto> {
    const prepared = await this.prepareDriveUpload({ filename: file.name, size: file.size, contentType: file.type || "application/octet-stream", parentId });
    await this.uploadFileToR2(prepared.uploadUrl, file, prepared.headers["Content-Type"], options.onProgress || (() => undefined), options.signal);
    const completed = await this.completeDriveUpload(prepared.uploadId);
    return completed.node;
  },

  // Gallery APIs
  async uploadGalleryImage(file: Blob, filename?: string): Promise<GalleryImageDto> {
    const formData = new FormData();
    formData.append("file", file, filename || (file instanceof File ? file.name : "image.webp"));
    return requestJson<GalleryImageDto>("/api/v1/gallery/upload", {
      method: "POST",
      body: formData
    });
  },

  async listGalleryImages(limit = 30, cursor?: string): Promise<GalleryListResponse> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const query = params.toString() ? `?${params.toString()}` : "";
    return requestJson<GalleryListResponse>(`/api/v1/gallery/images${query}`);
  },

  async deleteGalleryImage(id: string): Promise<void> {
    await requestJson<void>(`/api/v1/gallery/images/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  }
};
