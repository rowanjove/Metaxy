const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function assertOpaqueId(value: string, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new Error(`${label} must be an opaque identifier.`);
  }
  return value;
}

export function buildDriveObjectKey(nodeId: string): string {
  return `drive/objects/${assertOpaqueId(nodeId, "Drive node id")}`;
}

export function buildDriveUploadObjectKey(uploadId: string): string {
  return `drive/staging/${assertOpaqueId(uploadId, "Drive upload id")}`;
}

export function isDriveObjectKey(key: string): boolean {
  return typeof key === "string" && /^drive\/(?:objects|staging)\/[A-Za-z0-9_-]{1,128}$/u.test(key);
}

export function parseDriveFinalObjectKey(key: string): string | null {
  const match = typeof key === "string" ? key.match(/^drive\/objects\/([A-Za-z0-9_-]{1,128})$/u) : null;
  return match?.[1] || null;
}

export const buildDriveFinalObjectKey = buildDriveObjectKey;
export const buildDriveStagingObjectKey = buildDriveUploadObjectKey;
