import type { Env } from "../env";
import { DEFAULT_LIMITS } from "../../shared/constants";
import {
  deleteDrop,
  findDeletingDrops,
  findDropsToMarkDeleting,
  incrementDropDeletionAttempt,
  markDropsDeleting,
  type DropRow
} from "../repositories/drops";
import {
  getFilesByDropId,
  getItemsByDropId,
  incrementObjectDeletionAttempt,
  listPendingObjectDeletions,
  removeObjectDeletion
} from "../repositories/files";
import { cleanExpiredAdminSessions } from "../repositories/sessions";
import {
  abortDriveUpload,
  claimDriveObjectDeletion,
  finalizeDriveObjectDeletion,
  incrementDriveObjectDeletionAttempt,
  listDriveObjectDeletions,
  recordDriveObjectDeletion,
  listExpiredDriveUploads,
  removeDriveObjectDeletion
} from "../repositories/drive";
import { cleanExpiredDavLocks } from "../repositories/dav";
import {
  incrementGalleryObjectDeletionAttempt,
  finalizeGalleryObjectDeletion,
  listGalleryObjectDeletions
} from "../repositories/gallery";

// Transitioning candidates is a single D1 batch. Purges stay bounded because
// each drop may require D1 reads plus one R2 and one D1 deletion.
const MARK_DELETING_LIMIT = 50;
const PURGE_DROP_LIMIT = 20;
const ORPHAN_OBJECT_LIMIT = 8;

export interface CleanupResult {
  processedDrops: number;
  succeededDrops: number;
  failedDrops: number;
  processedOrphanObjects: number;
  cleanedSessions: number;
  processedDriveObjects?: number;
  cleanedDriveUploads?: number;
  cleanedDavLocks?: number;
  processedGalleryObjects?: number;
  durationMs: number;
}

export async function runScheduledCleanup(env: Env): Promise<CleanupResult> {
  const startTime = Date.now();
  const now = startTime;

  let processedDrops = 0;
  let succeededDrops = 0;
  let failedDrops = 0;

  try {
    // 1. Mark due rows as deleting. A separate later pass waits until every
    // presigned PUT for the drop has expired before deleting objects or D1 data.
    const draftCutoff = now - DEFAULT_LIMITS.DRAFT_TTL_SECONDS * 1000;
    const dueDrops = await findDropsToMarkDeleting(env.DB, draftCutoff, now, MARK_DELETING_LIMIT);
    await markDropsDeleting(env.DB, dueDrops.map((drop) => drop.id), now);
    const deletingDrops = await findDeletingDrops(env.DB, now, PURGE_DROP_LIMIT);

    // 2. Process drops
    for (const drop of deletingDrops) {
      processedDrops++;
      try {
        await purgeDrop(env, drop);
        succeededDrops++;
      } catch (err) {
        failedDrops++;
        await incrementDropDeletionAttempt(env.DB, drop.id, now);
        console.error(JSON.stringify({ event: "cleanup_drop_failed", dropId: drop.id, error: String(err) }));
      }
    }

    // 3. Process orphan object deletions queue
    let processedOrphanObjects = 0;
    const orphanDeletions = await listPendingObjectDeletions(env.DB, ORPHAN_OBJECT_LIMIT, now);
    for (const item of orphanDeletions) {
      processedOrphanObjects++;
      try {
        await env.FILES.delete(item.object_key);
        await removeObjectDeletion(env.DB, item.object_key);
      } catch (err) {
        console.error(JSON.stringify({ event: "cleanup_object_failed", objectKey: item.object_key, error: String(err) }));
        await incrementObjectDeletionAttempt(env.DB, item.object_key, now);
      }
    }

    // 4. Clean expired admin sessions
    const cleanedSessions = await cleanExpiredAdminSessions(env.DB, now);

    let processedDriveObjects = 0;
    let cleanedDriveUploads = 0;
    let cleanedDavLocks = 0;
    let processedGalleryObjects = 0;
    if (env.DRIVE && env.DRIVE_ENABLED === "true") {
      cleanedDavLocks = await cleanExpiredDavLocks(env.DB, now, 100);
      const expiredUploads = await listExpiredDriveUploads(env.DB, now, 20);
      for (const upload of expiredUploads) {
        let aborted = false;
        try {
          // Claim the D1 row first. If a finalizer wins the race, its
          // completed row is left untouched and its formal object is retained.
          aborted = await abortDriveUpload(env.DB, upload.id);
          if (!aborted) continue;
          // A crashed finalizer may have copied the staging object before the
          // D1 commit. Both keys are unreferenced while the upload is not
          // completed, so clean them together. Keep a delayed queue marker as
          // a second pass in case the stalled isolate writes after this delete.
          const retryAfter = now + 10 * 60 * 1000;
          await Promise.all([
            recordDriveObjectDeletion(env.DB, upload.upload_object_key, null, now, retryAfter),
            recordDriveObjectDeletion(env.DB, upload.final_object_key, null, now, retryAfter)
          ]);
          await env.DRIVE.delete([upload.upload_object_key, upload.final_object_key]);
          cleanedDriveUploads++;
        } catch (error) {
          console.error(JSON.stringify({ event: "cleanup_drive_upload_failed", uploadId: upload.id, error: String(error) }));
        }
      }
      const driveDeletions = await listDriveObjectDeletions(env.DB, now, 20);
      for (const item of driveDeletions) {
        processedDriveObjects++;
        try {
          const claim = await claimDriveObjectDeletion(env.DB, item, now);
          if (claim === "active") {
            // A user restored the file before the retention window ended.
            // Drop only the stale marker; the active node still owns the R2
            // object and must never be deleted by this queue.
            await removeDriveObjectDeletion(env.DB, item.object_key);
            continue;
          }
          await env.DRIVE.delete(item.object_key);
          if (claim === "stale") {
            // The node no longer owns this object (object_key is unique), so
            // the marker can be removed after the orphan delete succeeds.
            await removeDriveObjectDeletion(env.DB, item.object_key);
          } else if (item.node_id) {
            const finalized = await finalizeDriveObjectDeletion(env.DB, item.object_key, item.node_id);
            if (!finalized) throw new Error("Drive deletion metadata finalization was contended.");
          } else {
            await removeDriveObjectDeletion(env.DB, item.object_key);
          }
        } catch (error) {
          console.error(JSON.stringify({ event: "cleanup_drive_object_failed", objectKey: item.object_key, error: String(error) }));
          await incrementDriveObjectDeletionAttempt(env.DB, item.object_key, now);
        }
      }
    }

    // Gallery uses a dedicated permanent R2 bucket. Delete its objects first,
    // then finalize the D1 metadata so a transient R2/D1 failure remains
    // retryable without exposing a broken public link.
    if (env.GALLERY) {
      try {
        const galleryDeletions = await listGalleryObjectDeletions(env.DB, now, 20);
        for (const item of galleryDeletions) {
          processedGalleryObjects++;
          try {
            await env.GALLERY.delete(item.object_key);
            await finalizeGalleryObjectDeletion(env.DB, item);
          } catch (error) {
            console.error(JSON.stringify({ event: "cleanup_gallery_object_failed", objectKey: item.object_key, error: String(error) }));
            await incrementGalleryObjectDeletionAttempt(env.DB, item.object_key, now);
          }
        }
      } catch (error) {
        // Keep legacy deployments observable while they are being migrated;
        // /ready remains non-ready until migration 0007 is applied.
        console.error(JSON.stringify({ event: "cleanup_gallery_queue_failed", error: String(error) }));
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(JSON.stringify({
      event: "cleanup_completed",
      durationMs,
      processedDrops,
      succeededDrops,
      failedDrops,
      processedOrphanObjects,
      cleanedSessions,
      processedDriveObjects,
      cleanedDriveUploads,
      cleanedDavLocks,
      processedGalleryObjects
    }));

    return {
      processedDrops,
      succeededDrops,
      failedDrops,
      processedOrphanObjects,
      cleanedSessions,
      processedDriveObjects,
      cleanedDriveUploads,
      cleanedDavLocks,
      processedGalleryObjects,
      durationMs
    };
  } catch (err) {
    console.error(JSON.stringify({ event: "cleanup_failed", error: String(err) }));
    // Let the scheduled event fail so Workers observability and external
    // monitoring can distinguish a global cleanup outage from an empty run.
    throw err;
  }
}

async function purgeDrop(env: Env, drop: DropRow): Promise<void> {
  // Find all R2 keys for this drop
  const [items, files] = await Promise.all([
    getItemsByDropId(env.DB, drop.id),
    getFilesByDropId(env.DB, drop.id)
  ]);

  const keysToDelete: string[] = [];

  for (const file of files) {
    if (file.object_key) {
      keysToDelete.push(file.object_key);
    }
    if (file.upload_object_key && file.upload_object_key !== file.object_key) {
      keysToDelete.push(file.upload_object_key);
    }
  }

  for (const item of items) {
    if (item.type === "text" && item.text_storage === "r2" && item.text_object_key) {
      keysToDelete.push(item.text_object_key);
    }
  }

  // Delete all R2 objects first
  if (keysToDelete.length > 0) {
    await env.FILES.delete(keysToDelete);
  }

  // Only delete D1 row after R2 deletion succeeds (cascade deletes files & items)
  await deleteDrop(env.DB, drop.id);
}
