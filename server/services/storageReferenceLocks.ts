import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { currentBillingScope } from "../tenancy/billingContext.js";
import {
  currentBusinessScope,
  currentDatabaseScope,
} from "../tenancy/businessContext.js";
import { normalizeStorageKey } from "./storageObjectKey.js";
export interface StorageReferenceScope {
  userId: number;
  businessProfileId: number;
}
/** Actual transaction type passed to Drizzle's node-postgres callback. */
export type ManagedStorageTransaction = Parameters<
  Parameters<NodePgDatabase["transaction"]>[0]
>[0];

export interface StorageObjectIdentity {
  ownerUserId: number;
  storageBackend: string;
  storageKey: string;
}
export class ManagedStorageReferenceError extends Error {
  readonly code = "STORAGE_REFERENCE_CONFLICT";
  readonly status = 409;
}
export const canonicalStorageBackend = (value: string) =>
  value === "aws" ? "s3" : value;
const transactionLocks = new WeakMap<
  object,
  { scopes: Set<string>; keys: Set<string>; lastKey: string }
>();
function state(tx: ManagedStorageTransaction) {
  if (typeof tx.rollback !== "function")
    throw new ManagedStorageReferenceError(
      "Managed storage requires the caller transaction",
    );
  let value = transactionLocks.get(tx);
  if (!value) {
    value = { scopes: new Set(), keys: new Set(), lastKey: "" };
    transactionLocks.set(tx, value);
  }
  return value;
}
export function assertStorageReferenceScope(
  scope: StorageReferenceScope,
): void {
  if (
    ![scope.userId, scope.businessProfileId].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    )
  )
    throw new ManagedStorageReferenceError("Invalid managed storage scope");
  const business = currentBusinessScope(),
    billing = currentBillingScope();
  if (currentDatabaseScope()?.kind === "system") return;
  if (
    !business ||
    business.userId !== scope.userId ||
    business.businessProfileId !== scope.businessProfileId ||
    (billing &&
      (billing.actorUserId !== (business.actorUserId ?? business.userId) ||
        (billing.businessProfileId !== undefined &&
          billing.businessProfileId !== scope.businessProfileId) ||
        (billing.businessOwnerUserId !== undefined &&
          billing.businessOwnerUserId !== scope.userId)))
  )
    throw new ManagedStorageReferenceError(
      "Managed storage identity does not match the validated business",
    );
}
/** Billing-org prefix -> business serialization -> ordered object keys -> rows.
 * Must be called before a caller takes toolkit/content/profile row locks. */
export async function lockManagedStorageReferences(
  tx: ManagedStorageTransaction,
  scope: StorageReferenceScope,
): Promise<void> {
  assertStorageReferenceScope(scope);
  const locks = state(tx),
    key = `${scope.userId}:${scope.businessProfileId}`;
  if (locks.scopes.has(key)) return;
  if (locks.keys.size)
    throw new ManagedStorageReferenceError(
      "Acquire all billing/business scopes before object locks",
    );
  const org =
    await tx.execute(sql`SELECT o.id FROM billing_organizations o JOIN company_settings p ON p.billing_organization_id=o.id
    WHERE p.id=${scope.businessProfileId} AND p.user_id=${scope.userId} ORDER BY o.id FOR UPDATE OF o`);
  if (org.rows.length !== 1)
    throw new ManagedStorageReferenceError(
      "Business billing organization is unavailable",
    );
  const billing = currentBillingScope();
  if (billing && billing.organizationId !== Number(org.rows[0].id))
    throw new ManagedStorageReferenceError(
      "Business billing organization changed",
    );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"storage-managed:" + key},0))`,
  );
  locks.scopes.add(key);
}
export async function lockManagedStorageObjects(
  tx: ManagedStorageTransaction,
  objects: Array<
    | StorageObjectIdentity
    | {
        userId: number;
        storageBackend: string;
        storageKey: string;
        businessProfileId?: number;
        fileId?: number;
      }
  >,
): Promise<void> {
  const business = currentBusinessScope();
  if (business)
    await lockManagedStorageReferences(tx, {
      userId: business.userId,
      businessProfileId: business.businessProfileId,
    });
  else if (currentDatabaseScope()?.kind !== "system")
    throw new ManagedStorageReferenceError(
      "Object locks require validated business or cleanup system scope",
    );
  const locks = state(tx);
  const order = (a: string, b: string) =>
    Number(a.split(":", 1)[0]) - Number(b.split(":", 1)[0]) ||
    (a < b ? -1 : a > b ? 1 : 0);
  const keys = [
    ...new Set(
      objects.map((object) => {
        const owner =
          "ownerUserId" in object ? object.ownerUserId : object.userId;
        const backend = canonicalStorageBackend(object.storageBackend),
          key = normalizeStorageKey(object.storageKey);
        if (
          !Number.isSafeInteger(owner) ||
          owner <= 0 ||
          !["local", "s3"].includes(backend) ||
          !key.startsWith(`${owner}/`)
        )
          throw new ManagedStorageReferenceError(
            "Invalid managed object identity",
          );
        return `${owner}:${backend}:${key}`;
      }),
    ),
  ].sort(order);
  for (const key of keys) {
    if (locks.keys.has(key)) continue;
    if (locks.lastKey && order(key, locks.lastKey) < 0)
      throw new ManagedStorageReferenceError(
        "Prelock the complete object set in deterministic order",
      );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"storage-object:" + key},0))`,
    );
    locks.keys.add(key);
    locks.lastKey = key;
  }
}
