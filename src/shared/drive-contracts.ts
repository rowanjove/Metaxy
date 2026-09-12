export type DriveNodeKind = "folder" | "file";
export type DriveNodeStatus = "active" | "trashed" | "deleting";
export type DriveSystemRole = "root" | "inbox";
export type DriveUploadStatus = "prepared" | "completing" | "completed" | "failed" | "aborted";

export interface DriveNodeRecord {
  id: string;
  parent_id: string;
  kind: DriveNodeKind;
  name: string;
  name_key: string;
  system_role: DriveSystemRole | null;
  status: DriveNodeStatus;
  object_key: string | null;
  content_type: string | null;
  size: number | null;
  etag: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
}

export interface DriveUploadRecord {
  id: string;
  node_id: string | null;
  parent_id: string;
  name: string;
  name_key: string;
  upload_object_key: string;
  final_object_key: string;
  expected_size: number;
  expected_content_type: string;
  presign_expires_at: number;
  finalize_token: string | null;
  finalize_started_at: number | null;
  status: DriveUploadStatus;
  created_at: number;
  completed_at: number | null;
  failure_reason: string | null;
}

export interface DriveObjectDeletionRecord {
  object_key: string;
  node_id: string | null;
  bucket: "DRIVE";
  created_at: number;
  not_before: number;
  attempts: number;
  last_attempt_at: number | null;
}

export interface DriveNodeDto {
  id: string;
  parentId: string;
  kind: DriveNodeKind;
  name: string;
  status: DriveNodeStatus;
  objectKey: string | null;
  contentType: string | null;
  size: number | null;
  etag: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  systemRole: DriveSystemRole | null;
}

export interface DriveListResult {
  parent: DriveNodeDto;
  nodes: DriveNodeDto[];
  nextCursor: string | null;
}

export interface DriveUploadPrepareResult {
  uploadId: string;
  nodeId: string;
  uploadObjectKey: string;
  finalObjectKey: string;
  expectedSize: number;
  contentType: string;
  expiresAt: number;
}

export interface DriveUploadCompleteResult {
  node: DriveNodeDto;
  status: "uploaded";
}
