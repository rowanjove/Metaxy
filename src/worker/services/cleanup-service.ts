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

    const durationMs = Date.now() - startTime;
    console.log(JSON.stringify({
      event: "cleanup_completed",
      durationMs,
      processedDrops,
      succeededDrops,
      failedDrops,
      processedOrphanObjects,
      cleanedSessions
    }));

    return {
      processedDrops,
      succeededDrops,
      failedDrops,
      processedOrphanObjects,
      cleanedSessions,
      durationMs
    };
  } catch (err) {
    console.error(JSON.stringify({ event: "cleanup_failed", error: String(err) }));
    return {
      processedDrops,
      succeededDrops,
      failedDrops,
      processedOrphanObjects: 0,
      cleanedSessions: 0,
      durationMs: Date.now() - startTime
    };
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
