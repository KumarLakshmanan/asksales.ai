import { sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { objectStorage } from "./ObjectStorageService.js";
import { normalizeStorageKey } from "./storageObjectKey.js";
import {
  canonicalStorageBackend,
  lockManagedStorageObjects,
  type ManagedStorageTransaction,
  type StorageObjectIdentity,
} from "./storageReferenceLocks.js";
export interface ManagedCleanupRequest {
  identity: StorageObjectIdentity;
  expectedNamespace: string;
  /** Lock and attest the exact receipt ID + owner + original backend/key. */
  loadIntent(tx: ManagedStorageTransaction): Promise<boolean>;
  /** Acknowledge only that exact attested intent; false causes rollback. */
  acknowledge(tx: ManagedStorageTransaction): Promise<boolean | void>;
}
export type ManagedCleanupResult = {
  status: "deleted" | "already_consumed" | "referenced" | "deferred";
  reason?: string;
};
/** Canonical guarded consumer for Storage pending keys AND Data's surviving
 * profile receipts. Object IO happens only in this cleanup transaction, never
 * a caller's Brand/Content write transaction. Quota is never released here. */
export async function consumeManagedStorageCleanup(
  request: ManagedCleanupRequest,
): Promise<ManagedCleanupResult> {
  try {
    const { identity } = request,
      backend = canonicalStorageBackend(identity.storageBackend),
      key = normalizeStorageKey(identity.storageKey);
    const namespace =
      normalizeStorageKey(request.expectedNamespace.replace(/\/$/, "")) + "/";
    if (
      !namespace.startsWith(`${identity.ownerUserId}/`) ||
      namespace.split("/").length < 3 ||
      !key.startsWith(namespace)
    )
      return { status: "deferred", reason: "namespace_mismatch" };
    if (
      backend !==
      canonicalStorageBackend(process.env.STORAGE_BACKEND || "local")
    )
      return { status: "deferred", reason: "backend_mismatch" };
    return await db.transaction(async (tx: ManagedStorageTransaction) => {
      // Read billing/profile provenance BEFORE object locks, including active
      // replacement records whose old key is a committed pending cleanup key.
      const profiles =
        await tx.execute(sql`SELECT DISTINCT p.id,p.user_id,p.billing_organization_id FROM storage_files f
        JOIN company_settings p ON p.id=f.business_profile_id WHERE f.user_id=${identity.ownerUserId}
        AND CASE WHEN f.storage_backend='aws' THEN 's3' ELSE f.storage_backend END=${backend}
        AND (f.storage_key=${key} OR COALESCE(f.metadata->'pendingCleanupKeys','[]'::jsonb) ? ${key}) ORDER BY p.id`);
      const orgs = [
        ...new Set(
          profiles.rows.map((row) => Number(row.billing_organization_id)),
        ),
      ].sort((a, b) => a - b);
      if (orgs.length)
        await tx.execute(
          sql`SELECT id FROM billing_organizations WHERE id IN (${sql.join(
            orgs.map((id) => sql`${id}`),
            sql`,`,
          )}) ORDER BY id FOR UPDATE`,
        );
      for (const row of profiles.rows)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"storage-managed:" + row.user_id + ":" + row.id},0))`,
        );
      await lockManagedStorageObjects(tx, [identity]);
      if (!(await request.loadIntent(tx)))
        return { status: "already_consumed" };
      const refs =
        await tx.execute(sql`SELECT 1 FROM storage_managed_references WHERE user_id=${identity.ownerUserId}
        AND CASE WHEN storage_backend='aws' THEN 's3' ELSE storage_backend END=${backend} AND storage_key=${key} LIMIT 1`);
      if (refs.rows.length) return { status: "referenced" };
      const active =
        await tx.execute(sql`SELECT 1 FROM storage_files WHERE user_id=${identity.ownerUserId}
        AND CASE WHEN storage_backend='aws' THEN 's3' ELSE storage_backend END=${backend}
        AND storage_key=${key} AND NOT is_deleted LIMIT 1`);
      if (active.rows.length)
        return { status: "deferred", reason: "active_object" };
      await objectStorage.delete(key);
      if ((await request.acknowledge(tx)) === false)
        throw new Error("Cleanup intent changed before acknowledgment");
      return { status: "deleted" };
    });
  } catch {
    return { status: "deferred", reason: "delete_or_acknowledgment_failed" };
  }
}
