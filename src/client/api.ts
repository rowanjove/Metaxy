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
  if (uploadToken && !headers.has("X-PocketRelay-Upload-Token")) {
    headers.set("X-PocketRelay-Upload-Token", uploadToken);
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
    onProgress: (percent: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl, true);
      xhr.setRequestHeader("Content-Type", contentType);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onProgress(pct);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => {
        reject(new Error("Network error during file upload"));
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
  }
};
