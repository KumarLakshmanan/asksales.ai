import { sql } from "drizzle-orm";
import { normalizeStorageKey } from "./storageObjectKey.js";
import { storageService } from "./StorageService.js";
import {
  lockManagedStorageReferences,
  lockManagedStorageObjects,
  ManagedStorageReferenceError,
  type ManagedStorageTransaction,
  type StorageReferenceScope,
} from "./storageReferenceLocks.js";
export {
  lockManagedStorageReferences,
  lockManagedStorageObjects,
  ManagedStorageReferenceError,
} from "./storageReferenceLocks.js";
export type {
  ManagedStorageTransaction,
  StorageReferenceScope,
} from "./storageReferenceLocks.js";
export interface ManagedStorageObject extends StorageReferenceScope {
  fileId: number;
  storageBackend: string;
  storageKey: string;
}
export interface ManagedStorageHolder {
  type: string;
  id: string;
}
export interface ManagedStorageChange {
  registered: number;
  released: number;
  cleanupFileIds: number[];
}

function identity(row: Record<string, unknown>): ManagedStorageObject {
  return {
    fileId: Number(row.id),
    userId: Number(row.user_id),
    businessProfileId: Number(row.business_profile_id),
    storageBackend: String(row.storage_backend),
    storageKey: String(row.storage_key),
  };
}
function holderCheck(holder: ManagedStorageHolder) {
  if (
    !/^[a-z][a-z0-9_.:-]{0,99}$/.test(holder.type) ||
    typeof holder.id !== "string" ||
    !holder.id.trim() ||
    holder.id.length > 255
  )
    throw new ManagedStorageReferenceError("Invalid durable storage holder");
}
export async function resolveManagedStorageUrls(
  tx: ManagedStorageTransaction,
  scope: StorageReferenceScope,
  urls: string[],
): Promise<{ objects: ManagedStorageObject[]; unresolvedUrls: string[] }> {
  await lockManagedStorageReferences(tx, scope);
  if (
    urls.length > 1000 ||
    urls.some((url) => typeof url !== "string" || url.length > 8192)
  )
    throw new ManagedStorageReferenceError(
      "Too many or invalid managed storage URLs",
    );
  const objects = new Map<number, ManagedStorageObject>(),
    unresolvedUrls: string[] = [];
  for (const original of new Set(urls)) {
    const clean = original.trim().replace(/[?#].*$/, "");
    const privateId = clean.match(
      /^\/api\/settings\/storage\/files\/([1-9]\d*)\/download$/,
    );
    const result =
      await tx.execute(sql`SELECT id,user_id,business_profile_id,storage_backend,storage_key,is_deleted,metadata FROM storage_files
      WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
        AND ${privateId ? sql`id=${Number(privateId[1])}` : sql`regexp_replace(url,'[?#].*$','')=${clean}`}
      ORDER BY id DESC LIMIT 1`);
    if (result.rows[0]) {
      const row = result.rows[0];
      if (
        row.is_deleted ||
        (row.metadata as { storageWorkspace?: { trashedAt?: string } } | null)
          ?.storageWorkspace?.trashedAt
      )
        throw new ManagedStorageReferenceError(
          "Managed storage revision is unavailable",
        );
      const object = identity(row);
      objects.set(object.fileId, object);
    } else if (privateId)
      throw new ManagedStorageReferenceError(
        "Managed storage revision is unavailable",
      );
    else unresolvedUrls.push(original);
  }
  return {
    objects: [...objects.values()].sort((a, b) => a.fileId - b.fileId),
    unresolvedUrls,
  };
}
async function insertManagedReference(
  tx: ManagedStorageTransaction,
  scope: StorageReferenceScope,
  holder: ManagedStorageHolder,
  object: ManagedStorageObject,
): Promise<number> {
  const result =
    await tx.execute(sql`INSERT INTO storage_managed_references(user_id,business_profile_id,reference_type,reference_id,
      storage_file_id,storage_backend,storage_key) VALUES(${scope.userId},${scope.businessProfileId},${holder.type},${holder.id},${object.fileId},${object.storageBackend},${object.storageKey})
      ON CONFLICT DO NOTHING RETURNING storage_file_id`);
  return result.rows.length;
}

/** Replace one durable holder's whole object set in its own domain transaction. */
export async function setManagedStorageReferences(
  tx: ManagedStorageTransaction,
  scope: StorageReferenceScope,
  holder: ManagedStorageHolder,
  objects: ManagedStorageObject[],
  options: { cleanupReleased?: boolean } = {},
): Promise<ManagedStorageChange> {
  await lockManagedStorageReferences(tx, scope);
  holderCheck(holder);
  if (objects.length > 1000)
    throw new ManagedStorageReferenceError(
      "Too many managed storage references",
    );
  const wanted = new Map<number, ManagedStorageObject>();
  for (const object of objects) {
    if (
      object.userId !== scope.userId ||
      object.businessProfileId !== scope.businessProfileId ||
      !Number.isSafeInteger(object.fileId) ||
      object.fileId <= 0 ||
      !["local", "s3", "aws"].includes(object.storageBackend) ||
      normalizeStorageKey(object.storageKey) !== object.storageKey
    )
      throw new ManagedStorageReferenceError(
        "Managed object does not belong to this business",
      );
    const previous = wanted.get(object.fileId);
    if (
      previous &&
      (previous.storageKey !== object.storageKey ||
        previous.storageBackend !== object.storageBackend)
    )
      throw new ManagedStorageReferenceError("Conflicting object revisions");
    wanted.set(object.fileId, object);
  }
  const old =
    await tx.execute(sql`SELECT storage_file_id FROM storage_managed_references WHERE user_id=${scope.userId}
    AND business_profile_id=${scope.businessProfileId} AND reference_type=${holder.type} AND reference_id=${holder.id}`);
  const oldIds = old.rows.map((row) => Number(row.storage_file_id));
  const ids = [...new Set([...oldIds, ...wanted.keys()])].sort((a, b) => a - b);
  const existingObjects = ids.length
    ? await tx.execute(sql`SELECT user_id,storage_backend,storage_key FROM storage_files WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
    AND id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`,`,
    )})`)
    : { rows: [] };
  await lockManagedStorageObjects(
    tx,
    existingObjects.rows.map((row) => ({
      userId: Number(row.user_id),
      storageBackend: String(row.storage_backend),
      storageKey: String(row.storage_key),
    })),
  );
  const files = ids.length
    ? await tx.execute(sql`SELECT * FROM storage_files WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
    AND id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`,`,
    )}) ORDER BY id FOR UPDATE`)
    : { rows: [] };
  for (const object of wanted.values()) {
    const row = files.rows.find((row) => Number(row.id) === object.fileId);
    if (
      !row ||
      row.is_deleted ||
      row.storage_key !== object.storageKey ||
      row.storage_backend !== object.storageBackend ||
      (row.metadata as { storageWorkspace?: { trashedAt?: string } } | null)
        ?.storageWorkspace?.trashedAt
    )
      throw new ManagedStorageReferenceError(
        "Managed storage revision is unavailable",
      );
  }
  let registered = 0,
    released = 0;
  for (const object of wanted.values())
    registered += await insertManagedReference(tx, scope, holder, object);
  const removed = oldIds.filter((id) => !wanted.has(id));
  if (removed.length) {
    const result =
      await tx.execute(sql`DELETE FROM storage_managed_references WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
      AND reference_type=${holder.type} AND reference_id=${holder.id} AND storage_file_id IN (${sql.join(
        removed.map((id) => sql`${id}`),
        sql`,`,
      )}) RETURNING storage_file_id`);
    released = result.rows.length;
  }
  const cleanupFileIds: number[] = [];
  if (options.cleanupReleased)
    for (const id of removed) {
      const claimed = await storageService.claimFileDeletion(
        tx,
        id,
        scope.userId,
      );
      if (claimed) cleanupFileIds.push(id);
    }
  return { registered, released, cleanupFileIds };
}
export async function releaseManagedStorageReferences(
  tx: ManagedStorageTransaction,
  scope: StorageReferenceScope,
  holder: ManagedStorageHolder,
  options: { cleanupReleased?: boolean } = {},
): Promise<ManagedStorageChange> {
  return setManagedStorageReferences(tx, scope, holder, [], options);
}

/** Stable names also used by migration 480's existing-record enrollment. */
export type DurableStorageOwnerKind =
  | "brand_toolkit"
  | "content_asset"
  | "content_template"
  | "content_template_version"
  | "social_publish_attempt";
export interface DurableStorageOwner extends StorageReferenceScope {
  kind: DurableStorageOwnerKind;
  id: string;
}
export async function syncManagedStorageReferences(
  tx: ManagedStorageTransaction,
  input: {
    owner: DurableStorageOwner;
    urls: readonly string[];
    cleanupReleased?: boolean;
  },
): Promise<ManagedStorageChange> {
  const { owner } = input;
  const { objects } = await resolveManagedStorageUrls(tx, owner, [
    ...input.urls,
  ]);
  return setManagedStorageReferences(
    tx,
    owner,
    { type: owner.kind, id: owner.id },
    objects,
    { cleanupReleased: input.cleanupReleased },
  );
}
/** Batch owners must share the already authorized business. Prelocks the whole
 * object set before any release; global/admin predefined owners are excluded. */
export async function releaseManagedStorageOwners(
  tx: ManagedStorageTransaction,
  input: { owners: readonly DurableStorageOwner[]; cleanupReleased?: boolean },
): Promise<ManagedStorageChange> {
  if (!input.owners.length)
    return { registered: 0, released: 0, cleanupFileIds: [] };
  const scope = input.owners[0];
  await lockManagedStorageReferences(tx, scope);
  if (
    input.owners.some(
      (owner) =>
        owner.userId !== scope.userId ||
        owner.businessProfileId !== scope.businessProfileId,
    )
  )
    throw new ManagedStorageReferenceError(
      "Release owners must share the validated business",
    );
  const unique = [
    ...new Map(
      input.owners.map((owner) => [`${owner.kind}:${owner.id}`, owner]),
    ).values(),
  ];
  const old =
    await tx.execute(sql`SELECT DISTINCT storage_file_id,storage_backend,storage_key FROM storage_managed_references
    WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND (${sql.join(
      unique.map(
        (owner) =>
          sql`(reference_type=${owner.kind} AND reference_id=${owner.id})`,
      ),
      sql` OR `,
    )})`);
  await lockManagedStorageObjects(
    tx,
    old.rows.map((row) => ({
      userId: scope.userId,
      storageBackend: String(row.storage_backend),
      storageKey: String(row.storage_key),
    })),
  );
  const ids = old.rows.map((row) => Number(row.storage_file_id));
  if (ids.length)
    await tx.execute(sql`SELECT id FROM storage_files WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
    AND id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`,`,
    )}) ORDER BY id FOR UPDATE`);
  const total: ManagedStorageChange = {
    registered: 0,
    released: 0,
    cleanupFileIds: [],
  };
  for (const owner of unique) {
    const result = await releaseManagedStorageReferences(
      tx,
      scope,
      { type: owner.kind, id: owner.id },
      { cleanupReleased: input.cleanupReleased },
    );
    total.released += result.released;
    total.cleanupFileIds.push(...result.cleanupFileIds);
  }
  total.cleanupFileIds = [...new Set(total.cleanupFileIds)];
  return total;
}

/** Atomic related-owner sync: prelock complete old/new keys, register every new
 * edge before making removed edges cleanup-eligible. Uses only the caller tx. */
export async function syncManagedStorageOwners(
  tx: ManagedStorageTransaction,
  input: {
    entries: readonly { owner: DurableStorageOwner; urls: readonly string[] }[];
    cleanupReleased?: boolean;
  },
): Promise<ManagedStorageChange> {
  if (!input.entries.length)
    return { registered: 0, released: 0, cleanupFileIds: [] };
  const scope = input.entries[0].owner;
  await lockManagedStorageReferences(tx, scope);
  const owners = new Set<string>();
  for (const { owner } of input.entries) {
    holderCheck({ type: owner.kind, id: owner.id });
    if (
      owner.userId !== scope.userId ||
      owner.businessProfileId !== scope.businessProfileId
    )
      throw new ManagedStorageReferenceError(
        "Sync owners must share the validated business",
      );
    const key = `${owner.kind}:${owner.id}`;
    if (owners.has(key))
      throw new ManagedStorageReferenceError("Duplicate durable owner");
    owners.add(key);
  }
  const entries = [];
  for (const entry of input.entries)
    entries.push({
      ...entry,
      objects: (await resolveManagedStorageUrls(tx, scope, [...entry.urls]))
        .objects,
    });
  const old =
    await tx.execute(sql`SELECT reference_type,reference_id,storage_file_id,storage_backend,storage_key FROM storage_managed_references
    WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND (${sql.join(
      entries.map(
        ({ owner }) =>
          sql`(reference_type=${owner.kind} AND reference_id=${owner.id})`,
      ),
      sql` OR `,
    )})`);
  const objects = [
    ...entries.flatMap((entry) => entry.objects),
    ...old.rows.map((row) => ({
      userId: scope.userId,
      businessProfileId: scope.businessProfileId,
      fileId: Number(row.storage_file_id),
      storageBackend: String(row.storage_backend),
      storageKey: String(row.storage_key),
    })),
  ];
  await lockManagedStorageObjects(tx, objects);
  const ids = [...new Set(objects.map((object) => object.fileId))].sort(
    (a, b) => a - b,
  );
  if (ids.length)
    await tx.execute(sql`SELECT id FROM storage_files WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}
    AND id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`,`,
    )}) ORDER BY id FOR UPDATE`);
  const total: ManagedStorageChange = {
    registered: 0,
    released: 0,
    cleanupFileIds: [],
  };
  for (const entry of entries)
    for (const object of entry.objects)
      total.registered += await insertManagedReference(
        tx,
        scope,
        { type: entry.owner.kind, id: entry.owner.id },
        object,
      );
  const removed = new Set<number>();
  for (const entry of entries) {
    const wanted = new Set(entry.objects.map((object) => object.fileId));
    for (const row of old.rows)
      if (
        row.reference_type === entry.owner.kind &&
        row.reference_id === entry.owner.id &&
        !wanted.has(Number(row.storage_file_id))
      )
        removed.add(Number(row.storage_file_id));
    const result = await setManagedStorageReferences(
      tx,
      scope,
      { type: entry.owner.kind, id: entry.owner.id },
      entry.objects,
    );
    total.released += result.released;
  }
  if (input.cleanupReleased)
    for (const id of [...removed].sort((a, b) => a - b))
      if (await storageService.claimFileDeletion(tx, id, scope.userId))
        total.cleanupFileIds.push(id);
  return total;
}
