import { isBusinessApproved } from './businessLifecycle.js';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { currentBusinessScope, withBusinessScope, withSystemScope, type BusinessScope } from './businessContext.js';

export async function resolveBusinessScope(userId: number, businessProfileId?: number): Promise<BusinessScope | null> {
  const result = await db.execute(sql`SELECT p.id,p.user_id,
    CASE WHEN p.user_id=${userId} THEN 'owner' ELSE m.role END AS role
    FROM company_settings p JOIN users owner ON owner.id=p.user_id AND owner.deleted_at IS NULL
    JOIN users actor ON actor.id=${userId} AND actor.deleted_at IS NULL
    LEFT JOIN business_profile_memberships m ON m.business_profile_id=p.id AND m.user_id=${userId} AND m.status='active'
    LEFT JOIN business_profile_preferences pref ON pref.user_id=${userId}
    WHERE p.archived_at IS NULL AND (p.user_id=${userId} OR m.id IS NOT NULL)
    ${businessProfileId === undefined ? sql`` : sql`AND p.id=${businessProfileId}`}
    ORDER BY (p.id=pref.default_business_profile_id) DESC NULLS LAST,
      (p.user_id=${userId} AND p.is_default) DESC,p.id LIMIT 1`);
  const id = Number(result.rows[0]?.id);
  return id ? { kind: 'business', userId: Number(result.rows[0].user_id), actorUserId: userId,
    role: result.rows[0].role as BusinessScope['role'], businessProfileId: id } : null;
}

/** Resolve an entity during an authenticated callback/inventory lookup. The
 * identifier and owner still need verification by the entry point. */
export async function scopeForRecord(table: string, id: number | string): Promise<BusinessScope | null> {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error('Invalid ownership table');
  return withSystemScope(`Resolve ${table} ownership`, async () => {
    const result = await db.execute(sql`SELECT p.id,p.user_id FROM ${sql.identifier(table)} r
      JOIN company_settings p ON p.id=r.business_profile_id WHERE r.id=${id} AND p.archived_at IS NULL LIMIT 1`);
    const row = result.rows[0];
    return row ? { kind: 'business', userId: Number(row.user_id), businessProfileId: Number(row.id) } : null;
  });
}

export async function forEachBusiness<T>(work: (scope: BusinessScope) => Promise<T>, approvedOnly = false): Promise<T[]> {
  const current = currentBusinessScope();
  if (current) return approvedOnly && !await isBusinessApproved(current.userId) ? [] : [await work(current)];
  const rows = await db.execute(sql`SELECT p.id,p.user_id FROM company_settings p JOIN users u ON u.id=p.user_id WHERE u.deleted_at IS NULL AND p.archived_at IS NULL ${approvedOnly ? sql`AND u.is_approved=true` : sql``} ORDER BY p.id`);
  const results: T[] = [];
  const failedProfiles: number[] = [];
  for (const row of rows.rows) {
    const scope: BusinessScope = { kind: 'business', userId: Number(row.user_id), businessProfileId: Number(row.id) };
    try { results.push(await withBusinessScope(scope, () => work(scope))); }
    catch { failedProfiles.push(scope.businessProfileId); }
  }
  if (failedProfiles.length) throw new Error(`Business maintenance failed for ${failedProfiles.length} profile(s): ${failedProfiles.join(',')}. Other profiles were processed; retry is safe only for idempotent maintenance.`);
  return results;
}
