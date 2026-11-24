import { currentBusinessScope } from '../../tenancy/businessContext.js';
import type { ContentAssetRecord } from '../../models/contentAssets/schema.js';
import { collectContentManagedReferenceUrls } from '../../utils/contentManagedReferences.js';
import {
  lockManagedStorageReferences, releaseManagedStorageOwners, syncManagedStorageOwners,
  type DurableStorageOwner, type DurableStorageOwnerKind, type ManagedStorageTransaction,
} from '../managedStorageReferences.js';

interface ContentStorageIdentity {
  userId?: number | null;
  businessProfileId?: number | null;
}
export interface ContentManagedStorageEntry { owner: DurableStorageOwner; urls: readonly string[] }

/** Acquire the canonical billing/business prefix BEFORE Content domain locks.
 * Creation may use the validated ambient profile before the DB fills ownership;
 * owner entries always use the actual saved row. Global/admin rows gain none. */
export async function lockContentManagedStorage(tx: ManagedStorageTransaction, identity: ContentStorageIdentity): Promise<void> {
  if (!identity.userId) return;
  const profile = identity.businessProfileId ?? currentBusinessScope()?.businessProfileId;
  if (profile) await lockManagedStorageReferences(tx, { userId: identity.userId, businessProfileId: profile });
}

export function contentStorageOwner(kind: DurableStorageOwnerKind, row: ContentStorageIdentity & { id: number }): DurableStorageOwner | undefined {
  if (!row.userId || !row.businessProfileId) return undefined;
  return { kind, id: String(row.id), userId: row.userId, businessProfileId: row.businessProfileId };
}

/** Organic must call this with its actual saved UPDATE/INSERT result, then batch
 * all asset and attempt entries after EVERY destination/domain write. */
export function contentAssetManagedStorageEntry(asset: ContentAssetRecord): ContentManagedStorageEntry | undefined {
  const owner = contentStorageOwner('content_asset', asset);
  return owner ? { owner, urls: collectContentManagedReferenceUrls(asset) } : undefined;
}

export async function syncContentManagedStorage(tx: ManagedStorageTransaction, entries: readonly (ContentManagedStorageEntry | undefined)[]): Promise<void> {
  await syncManagedStorageOwners(tx, { entries: entries.filter((entry): entry is ContentManagedStorageEntry => Boolean(entry)) });
}

export async function releaseContentManagedStorage(tx: ManagedStorageTransaction, owners: readonly (DurableStorageOwner | undefined)[]): Promise<void> {
  await releaseManagedStorageOwners(tx, { owners: owners.filter((owner): owner is DurableStorageOwner => Boolean(owner)) });
}
