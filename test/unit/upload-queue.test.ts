import { describe, expect, it } from "vitest";
import {
  uploadFilesInQueue,
  type PendingFile
} from "../../src/client/components/composer";
import { ApiClientError } from "../../src/client/api";

function pendingFile(name: string, index: number): PendingFile {
  return {
    id: `local-${index}`,
    file: new File([new Uint8Array([index])], name, {
      type: "application/octet-stream"
    }),
    sortOrder: index,
    status: "queued",
    progress: 0
  };
}

describe("composer upload queue", () => {
  it("continues draining queued files after concurrent item failures", async () => {
    const files = [
      pendingFile("bad-1.bin", 1),
      pendingFile("bad-2.bin", 2),
      pendingFile("bad-3.bin", 3),
      pendingFile("good-4.bin", 4),
      pendingFile("good-5.bin", 5)
    ];
    const client = {
      async prepareUpload(
        _dropId: string,
        _draftToken: string,
        file: { filename: string }
      ) {
        if (file.filename.startsWith("bad")) {
          throw new ApiClientError(503, "TEST_UPLOAD_FAILURE", "upload unavailable");
        }
        return {
          fileId: `prepared-${file.filename}`,
          uploadUrl: `https://upload.example/${file.filename}`,
          method: "PUT" as const,
          headers: { "Content-Type": "application/octet-stream" },
          expiresAt: Date.now() + 60_000
        };
      },
      async uploadFileToR2() {},
      async completeUpload(_dropId: string, _draftToken: string, fileId: string) {
        return { fileId, status: "uploaded" as const };
      }
    };

    await expect(uploadFilesInQueue("drop", "token", files, () => {}, client))
      .rejects.toThrow("upload unavailable");
    expect(files.filter((file) => file.status === "error")).toHaveLength(3);
    expect(files.filter((file) => file.status === "complete")).toHaveLength(2);
    expect(files.some((file) => file.status === "queued")).toBe(false);
  });

  it("verifies a previously prepared file before attempting another upload", async () => {
    const file = pendingFile("resume.bin", 1);
    file.preparedFileId = "prepared-resume";
    file.status = "error";
    let prepareCalls = 0;
    let uploadCalls = 0;
    const client = {
      async prepareUpload() {
        prepareCalls++;
        throw new Error("should not prepare");
      },
      async uploadFileToR2() {
        uploadCalls++;
      },
      async completeUpload(_dropId: string, _draftToken: string, fileId: string) {
        return { fileId, status: "uploaded" as const };
      }
    };

    await uploadFilesInQueue("drop", "token", [file], () => {}, client);
    expect(file.status).toBe("complete");
    expect(prepareCalls).toBe(0);
    expect(uploadCalls).toBe(0);
  });
});
