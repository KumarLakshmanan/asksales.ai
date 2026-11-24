import { sql, type SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withAccountScope, withBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';
import { getBillingOrganization, resolveBillingOrganization, type BillingExecutor } from './billing/organizations.js';
import { BusinessProfileAccessError } from './businessProfileStaff.js';
import { stageBrandToolkitDeletionForBusinessInTransaction } from '../models/brandToolkits/functions.js';
import {
  lockManagedStorageReferences, lockManagedStorageObjects, releaseManagedStorageOwners,
  type ManagedStorageTransaction,
} from './managedStorageReferences.js';
import { storageService } from './StorageService.js';

type Profile = { id: number; payer: number; isDefault: boolean; archived: string | null; updated: string; version: number; recoveryRank: number };
const conflict = () => new BusinessProfileAccessError('Business setup changed. Refresh and try again.', 409);
const ownedProfiles = (userId: number, tx: BillingExecutor = db) => tx.execute(sql`SELECT id,billing_organization_id,is_default,archived_at,updated_at,version,
  row_number() OVER(ORDER BY updated_at DESC,id) AS recovery_rank
  FROM company_settings WHERE user_id=${userId} ORDER BY id`);
const profilesFrom = (rows: Record<string, unknown>[]): Profile[] => rows.map(row => ({
  id: Number(row.id), payer: Number(row.billing_organization_id), isDefault: Boolean(row.is_default),
  archived: row.archived_at == null ? null : String(row.archived_at), updated: String(row.updated_at), version: Number(row.version), recoveryRank: Number(row.recovery_rank),
}));
function destinations(profiles: Profile[], target: Profile) {
  const active = profiles.filter(profile => profile.id !== target.id && profile.archived === null);
  // Preserve PostgreSQL DESC NULLS FIRST semantics for nullable legacy dates.
  const replacement = target.isDefault ? [...active].sort((a, b) => a.recoveryRank - b.recoveryRank)[0] : undefined;
  const preference = [...active].sort((a, b) => Number(b.isDefault || b.id === replacement?.id) - Number(a.isDefault || a.id === replacement?.id) || a.id - b.id)[0];
  return { replacement, preference };
}
function inProfile<T>(userId: number, profile: Profile, work: () => T): T {
  return withBusinessScope({ userId, businessProfileId: profile.id, actorUserId: userId, role: 'owner' }, () => withBillingScope({
    organizationId: profile.payer, actorUserId: userId, businessProfileId: profile.id, businessOwnerUserId: userId,
  }, work));
}
const capacityPredicate = (profileId: number) => sql`(business_profile_id=${profileId}
  OR (source_table='company_settings' AND source_id=${String(profileId)})
  OR workspace_id IN(SELECT id FROM ai_visibility_workspaces WHERE business_profile_id=${profileId}))`;
async function profileDeletionPayers(profileId: number, tx: BillingExecutor = db): Promise<number[]> {
  const result = await tx.execute(sql`SELECT organization_id FROM billing_capacity_items WHERE ${capacityPredicate(profileId)}
    UNION SELECT billing_organization_id AS organization_id FROM ai_visibility_workspaces WHERE business_profile_id=${profileId}
    ORDER BY organization_id`);
  return result.rows.map((row: Record<string, unknown>) => Number(row.organization_id));
}

type CascadeEdge = { parent: string; child: string; parentSchema: string; childSchema: string; parentColumns: string[]; childColumns: string[]; action: string };
/** Lock the existing FK-driven DELETE/SET NULL closure, without deleting it or
 * changing cascade/retention authority. The target profile is already FOR UPDATE,
 * so new FK children cannot enter this closure while it is being locked. */
async function lockProfileCascadeRows(tx: ManagedStorageTransaction, userId: number, profileId: number) {
  const result = await tx.execute(sql`SELECT p.relname AS parent,c.relname AS child,pn.nspname AS parent_schema,cn.nspname AS child_schema,f.confdeltype AS action,
    ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=k.n ORDER BY ord) AS parent_columns,
    ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.n ORDER BY ord) AS child_columns
    FROM pg_constraint f JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
    JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace
    WHERE f.contype='f' AND f.confdeltype IN('c','n') ORDER BY p.oid,c.oid,f.oid`);
  const edges: CascadeEdge[] = result.rows.map(row => ({ parent: String(row.parent), child: String(row.child), parentSchema: String(row.parent_schema), childSchema: String(row.child_schema), parentColumns: row.parent_columns as string[], childColumns: row.child_columns as string[], action: String(row.action) }));
  type Path = { table: string; alias: string; predicate: SQL; ancestors: string[] };
  const paths: Path[] = [{ table: 'company_settings', alias: 'profile_delete_0', predicate: sql`profile_delete_0.id=${profileId} AND profile_delete_0.user_id=${userId}`, ancestors: ['company_settings'] }];
  let sequence = 0;
  for (let index = 0; index < paths.length; index++) {
    const parent = paths[index];
    for (const edge of edges.filter(edge => edge.parentSchema === 'public' && edge.parent === parent.table)) {
      // Unknown cross-schema or cyclic cascades need explicit review, rather
      // than acquiring unplanned rows after the object phase.
      if (edge.childSchema !== 'public' || parent.ancestors.includes(edge.child) || ++sequence > 128) throw conflict();
      const alias = `profile_delete_${sequence}`;
      const joins = edge.childColumns.map((column, position) => sql`${sql.identifier(alias)}.${sql.identifier(column)}=${sql.identifier(parent.alias)}.${sql.identifier(edge.parentColumns[position])}`);
      const predicate = sql`EXISTS(SELECT 1 FROM public.${sql.identifier(parent.table)} AS ${sql.identifier(parent.alias)}
        WHERE ${parent.predicate} AND ${sql.join(joins, sql` AND `)})`;
      await tx.execute(sql`SELECT ${sql.identifier(alias)}.ctid FROM public.${sql.identifier(edge.child)} AS ${sql.identifier(alias)}
        WHERE ${predicate} ORDER BY ${sql.identifier(alias)}.ctid FOR UPDATE OF ${sql.identifier(alias)}`);
      // SET NULL updates this row only; it does not delete its own children.
      if (edge.action === 'c') paths.push({ table: edge.child, alias, predicate, ancestors: [...parent.ancestors, edge.child] });
    }
  }
}

/** Owner-authorized profile deletion. Every payer is taken from persisted
 * profiles/capacity provenance and authorized separately, never an ambient or
 * request-supplied organization. Returns committed post-delete cleanup receipts. */
export async function stageBusinessProfileDeletion(userId: number, profileId: number, expectedPayer: number): Promise<string[]> {
  const snapshot = profilesFrom((await withAccountScope(() => ownedProfiles(userId))).rows);
  const target = snapshot.find(profile => profile.id === profileId);
  if (!target) throw new BusinessProfileAccessError('Profile not found', 404);
  if (target.payer !== expectedPayer) throw conflict();
  const planned = destinations(snapshot, target);
  const affectedProfiles = [...new Map([target, planned.replacement, planned.preference].filter((profile): profile is Profile => Boolean(profile)).map(profile => [profile.id, profile])).values()].sort((a, b) => a.id - b.id);
  const sourcePayers = await withAccountScope(() => profileDeletionPayers(profileId));
  const payers = [...new Set([...affectedProfiles.map(profile => profile.payer), ...sourcePayers])].sort((a, b) => a - b);
  const authorize = async (executor: BillingExecutor = db) => {
    for (const profile of affectedProfiles) {
      const payer = await inProfile(userId, profile, () => resolveBillingOrganization(userId, executor));
      if (payer !== profile.payer) throw conflict();
    }
    for (const payer of payers.filter(id => !affectedProfiles.some(profile => profile.payer === id))) {
      // Historical capacity provenance is not authorized by a different current
      // business. Use existing explicit account-owner membership authorization.
      await withAccountScope(() => withBillingScope({ organizationId: payer, actorUserId: userId }, () => getBillingOrganization(userId, payer, executor)));
    }
  };
  await authorize();
  return inProfile(userId, target, () => db.transaction(async (tx: ManagedStorageTransaction) => {
    await tx.execute(sql`SELECT id FROM billing_organizations WHERE id IN(${sql.join(payers.map(id => sql`${id}`), sql`,`)}) ORDER BY id FOR UPDATE`);
    await authorize(tx);
    if ((await profileDeletionPayers(profileId, tx)).some(id => !payers.includes(id))) throw conflict();
    for (const profile of affectedProfiles) await inProfile(userId, profile, () => lockManagedStorageReferences(tx, { userId, businessProfileId: profile.id }));
    // Older create/update/archive writers hold this account lock before billing.
    // Never wait here while holding payer locks: fail safely and let them finish.
    const account = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${userId}) AS acquired`);
    if (!account.rows[0]?.acquired) throw conflict();
    // Analysis commits take this lock before their quota-triggered writes. As
    // with the legacy account lock, do not wait in the inverse payer order.
    const profileLock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(740322,${profileId}) AS acquired`);
    if (!profileLock.rows[0]?.acquired) throw conflict();
    await tx.execute(sql`SELECT id FROM company_settings WHERE user_id=${userId}
      AND id IN(${sql.join(affectedProfiles.map(profile => sql`${profile.id}`), sql`,`)}) ORDER BY id FOR UPDATE`);
    const fresh = profilesFrom((await ownedProfiles(userId, tx)).rows);
    if (JSON.stringify(fresh) !== JSON.stringify(snapshot)) throw conflict();
    if ((await profileDeletionPayers(profileId, tx)).some(id => !payers.includes(id))) throw conflict();

    const preferences = await tx.execute(sql`SELECT user_id,default_business_profile_id FROM business_profile_preferences
      WHERE user_id=${userId} OR default_business_profile_id=${profileId} ORDER BY user_id FOR UPDATE`);
    await tx.execute(sql`DELETE FROM workspace_website_analysis_jobs WHERE business_profile_id=${profileId} AND user_id=${userId}`);
    await tx.execute(sql`UPDATE workspace_setup_drafts SET data=NULL,revision=revision+1,updated_at=now()
      WHERE user_id=${userId} AND data IS NOT NULL AND (draft_key=${`brand:${profileId}`} OR data->>'profileId'=${String(profileId)})`);
    const brand = await stageBrandToolkitDeletionForBusinessInTransaction(tx, profileId);
    if (planned.replacement) {
      await tx.execute(sql`UPDATE company_settings SET is_default=false WHERE id=${profileId} AND user_id=${userId}`);
      await tx.execute(sql`UPDATE company_settings SET is_default=true,updated_at=now() WHERE id=${planned.replacement.id} AND user_id=${userId}`);
    }
    if (Number(preferences.rows.find(row => Number(row.user_id) === userId)?.default_business_profile_id) === profileId) {
      await tx.execute(sql`UPDATE business_profile_preferences SET default_business_profile_id=${planned.preference?.id ?? null} WHERE user_id=${userId}`);
    }
    // Stage the existing SET NULL cascade effects, retaining audit history.
    await tx.execute(sql`UPDATE business_profile_preferences SET default_business_profile_id=NULL WHERE default_business_profile_id=${profileId}`);
    await tx.execute(sql`UPDATE business_profile_membership_audit SET business_profile_id=NULL WHERE business_profile_id=${profileId}`);
    await lockProfileCascadeRows(tx, userId, profileId);

    const setup = await tx.execute(sql`SELECT id,user_id,storage_backend,storage_key FROM storage_files
      WHERE business_profile_id=${profileId} AND user_id=${userId} AND category='brand_asset'
      AND reference_type IN('website_screenshot','brand_toolkit_logo','brand_toolkit_image') ORDER BY id`);
    const held = brand.owners.length ? await tx.execute(sql`SELECT DISTINCT f.id,f.user_id,f.storage_backend,f.storage_key FROM storage_files f
      JOIN storage_managed_references r ON r.storage_file_id=f.id AND r.user_id=f.user_id AND r.business_profile_id=f.business_profile_id
      WHERE r.user_id=${userId} AND r.business_profile_id=${profileId} AND r.reference_type='brand_toolkit'
        AND r.reference_id IN(${sql.join(brand.owners.map(owner => sql`${owner.id}`), sql`,`)}) ORDER BY f.id`) : { rows: [] };
    const objects = [...new Map([...setup.rows, ...held.rows].map(row => [Number(row.id), row])).values()].sort((a, b) => Number(a.id) - Number(b.id));
    await lockManagedStorageObjects(tx, objects.map(row => ({ userId, storageBackend: String(row.storage_backend), storageKey: String(row.storage_key) })));
    if (objects.length) await tx.execute(sql`SELECT id FROM storage_files WHERE user_id=${userId} AND business_profile_id=${profileId}
      AND id IN(${sql.join(objects.map(row => sql`${Number(row.id)}`), sql`,`)}) ORDER BY id FOR UPDATE`);
    // This is the single reference-release batch. All caller domain work and
    // the complete object/storage-row lock set are already enlisted above.
    await releaseManagedStorageOwners(tx, { owners: brand.owners, cleanupReleased: false });
    const receiptIds = await storageService.deleteBusinessSetupAssets(tx, userId, profileId);
    // Immediate migration299 file FK requires this order. Cascade/domain and
    // rows are already locked; no caller domain writes follow it. Existing
    // triggers retain quota authority in the canonical references/quota/intent
    // phase, using only the payer organizations locked at the start.
    await tx.execute(sql`DELETE FROM company_settings WHERE id=${profileId} AND user_id=${userId}`);
    return receiptIds;
  }));
}
