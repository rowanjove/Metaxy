import type { CommitDropData } from "../../shared/contracts";
import { ERROR_CODES } from "../../shared/error-codes";
import { AppError } from "../errors";
import type { Env } from "../env";
import { recordObjectDeletion } from "../repositories/files";
import { markDropDeleting } from "../repositories/drops";
import { commitDrop, createDraft } from "./drop-service";
import { completeUpload, prepareUpload } from "./upload-service";

export interface ShortcutFileParams {
  filename: string;
  contentType: string;
  size: number;
  expiresInSeconds?: number;
  originUrl: string;
  body: ReadableStream<Uint8Array>;
}

export async function createShortcutFileDrop(
  env: Env,
  params: ShortcutFileParams
): Promise<CommitDropData> {
  const draft = await createDraft(env, { expiresInSeconds: params.expiresInSeconds });
  let uploadObjectKey: string | undefined;
  let preparedFileId: string | undefined;

  try {
    const prepared = await prepareUpload(
      env,
      {
        dropId: draft.dropId,
        draftToken: draft.draftToken,
        filename: params.filename,
        size: params.size,
        contentType: params.contentType,
        sortOrder: 1
      },
      { transport: "binding" }
    );
    uploadObjectKey = prepared.uploadObjectKey;
    preparedFileId = prepared.fileId;

    const uploadStream = createDeclaredSizeStream(params.body, params.size);
    const [putResult, pipeResult] = await Promise.allSettled([
      env.FILES.put(uploadObjectKey, uploadStream.readable, {
        httpMetadata: { contentType: params.contentType }
      }),
      uploadStream.completion
    ]);
    if (pipeResult.status === "rejected") {
      throw new AppError(
        409,
        ERROR_CODES.FILE_SIZE_MISMATCH,
        "Shortcut file body does not match the declared size.",
        pipeResult.reason
      );
    }
    if (putResult.status === "rejected") {
      throw putResult.reason;
    }
    const staged = putResult.value;
    if (!staged) {
      throw new AppError(
        503,
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "File storage did not accept the shortcut upload."
      );
    }

    await completeUpload(env, {
      dropId: draft.dropId,
      draftToken: draft.draftToken,
      fileId: preparedFileId
    });
    return await commitDrop(env, draft.dropId, draft.draftToken, params.originUrl);
  } catch (error) {
    const now = Date.now();
    await queueFailedShortcutDraftCleanup(env, draft.dropId, now);
    if (uploadObjectKey) {
      try {
        await recordObjectDeletion(env.DB, uploadObjectKey, now, now);
      } catch (recordError) {
        console.error(JSON.stringify({
          event: "shortcut_staging_cleanup_record_failed",
          fileId: preparedFileId,
          error: String(recordError)
        }));
      }
      try {
        await env.FILES.delete(uploadObjectKey);
      } catch (deleteError) {
        console.error(JSON.stringify({
          event: "shortcut_staging_upload_delete_failed",
          fileId: preparedFileId,
          error: String(deleteError)
        }));
      }
    }
    throw error;
  }
}

async function queueFailedShortcutDraftCleanup(
  env: Env,
  dropId: string,
  now: number
): Promise<void> {
  try {
    await markDropDeleting(env.DB, dropId, now);
  } catch (cleanupError) {
    console.error(JSON.stringify({
      event: "shortcut_draft_cleanup_queue_failed",
      dropId,
      error: String(cleanupError)
    }));
  }
}

function createDeclaredSizeStream(
  body: ReadableStream<Uint8Array>,
  declaredSize: number
): { readable: ReadableStream<Uint8Array>; completion: Promise<void> } {
  if (typeof FixedLengthStream !== "undefined") {
    const stream = new FixedLengthStream(declaredSize);
    return {
      readable: stream.readable,
      completion: body.pipeTo(stream.writable)
    };
  }

  let receivedBytes = 0;
  const readable = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > declaredSize) {
        throw new AppError(
          409,
          ERROR_CODES.FILE_SIZE_MISMATCH,
          "Shortcut file body exceeds the declared size."
        );
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (receivedBytes !== declaredSize) {
        throw new AppError(
          409,
          ERROR_CODES.FILE_SIZE_MISMATCH,
          `Shortcut file body size (${receivedBytes}) does not match the declared size (${declaredSize}).`
        );
      }
    }
  }));
  return { readable, completion: Promise.resolve() };
}
