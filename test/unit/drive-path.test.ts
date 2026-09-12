import { describe, expect, it } from "vitest";
import { normalizeDriveName, normalizeDrivePath, splitDrivePath } from "../../src/worker/lib/drive-path";
import { buildDriveFinalObjectKey, buildDriveUploadObjectKey, parseDriveFinalObjectKey } from "../../src/worker/lib/drive-object-key";

describe("Drive path and object-key safety", () => {
  it("normalizes Unicode names and rejects traversal/reserved names", () => {
    expect(normalizeDriveName("e\u0301.txt").name).toBe("é.txt");
    expect(() => normalizeDriveName("../secret")).toThrow();
    expect(() => normalizeDriveName("CON.txt")).toThrow();
    expect(() => normalizeDriveName("name.")).toThrow();
    expect(() => splitDrivePath("a/../b")).toThrow();
    expect(splitDrivePath("a/b")).toEqual(["a", "b"]);
    expect(() => normalizeDrivePath(`/${Array.from({ length: 2050 }, () => "a").join("/")}`)).toThrow();
  });

  it("uses opaque validated R2 keys rather than user paths", () => {
    const id = crypto.randomUUID();
    const finalKey = buildDriveFinalObjectKey(id);
    const stagingKey = buildDriveUploadObjectKey(id);
    expect(finalKey).toBe(`drive/objects/${id}`);
    expect(stagingKey).toBe(`drive/staging/${id}`);
    expect(parseDriveFinalObjectKey(finalKey)).toBe(id);
    expect(parseDriveFinalObjectKey("drive/objects/../secret")).toBeNull();
  });
});
