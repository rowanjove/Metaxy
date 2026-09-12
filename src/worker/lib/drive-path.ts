const INVALID_NAME_CHARACTERS = /[\u0000-\u001f\u007f<>:"/\\|?*]/u;
const INVALID_PATH_CHARACTERS = /[\u0000-\u001f\u007f\\]/u;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_NAME_BYTES = 255;
const MAX_PATH_BYTES = 4096;
const encoder = new TextEncoder();

export interface NormalizedDriveName {
  name: string;
  nameKey: string;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function normalizeDriveName(rawName: string): NormalizedDriveName {
  if (typeof rawName !== "string") throw new Error("Drive name must be a string.");
  const name = rawName.normalize("NFC");
  if (!name || name === "." || name === "..") throw new Error("Drive name is invalid.");
  if (name !== name.trim() || name.endsWith(".")) {
    throw new Error("Drive name cannot start or end with whitespace or a dot.");
  }
  if (INVALID_NAME_CHARACTERS.test(name) || WINDOWS_RESERVED_NAME.test(name)) {
    throw new Error("Drive name contains an unsupported or reserved character.");
  }
  if (byteLength(name) > MAX_NAME_BYTES) throw new Error("Drive name is too long.");
  const nameKey = name.toLocaleLowerCase("en-US");
  return { name, nameKey };
}

export function splitDrivePath(rawPath: string): string[] {
  if (typeof rawPath !== "string" || !rawPath) throw new Error("Drive path is invalid.");
  const path = rawPath.normalize("NFC");
  if (INVALID_PATH_CHARACTERS.test(path) || path.includes("//")) {
    throw new Error("Drive path contains unsupported characters.");
  }
  const withoutLeadingSlash = path.startsWith("/") ? path.slice(1) : path;
  if (!withoutLeadingSlash && path === "/") return [];
  if (!withoutLeadingSlash || withoutLeadingSlash.endsWith("/")) {
    throw new Error("Drive path has an empty segment.");
  }
  const segments = withoutLeadingSlash.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || !segment)) {
    throw new Error("Drive path traversal or empty segment is not allowed.");
  }
  for (const segment of segments) normalizeDriveName(segment);
  return segments;
}

export function normalizeDrivePath(rawPath: string): string {
  const result = `/${splitDrivePath(rawPath).join("/")}`;
  if (byteLength(result) > MAX_PATH_BYTES) throw new Error("Drive path is too long.");
  return result;
}

export function joinDrivePath(...segments: string[]): string {
  if (segments.length === 0) return "/";
  return normalizeDrivePath(`/${segments.map((segment) => normalizeDriveName(segment).name).join("/")}`);
}
