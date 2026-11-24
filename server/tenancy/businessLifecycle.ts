import { sql, type SQL } from 'drizzle-orm';
import { db } from '../models/db.js';

export class BusinessLifecycleError extends Error {
  readonly status = 403;
  readonly code = 'BUSINESS_APPROVAL_REQUIRED';
  constructor() { super('This business is awaiting account approval. Contact its owner or support.'); }
}

/** Call only after business ownership/membership has been resolved. Staff's
 * personal onboarding does not determine the selected owner's approval. */
export async function isBusinessApproved(ownerUserId: number, executor: { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> } = db): Promise<boolean> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) return false;
  const result = await executor.execute(sql`SELECT is_approved FROM users WHERE id=${ownerUserId} AND deleted_at IS NULL`);
  return result.rows[0]?.is_approved === true;
}

export async function requireApprovedBusiness(ownerUserId: number) {
  if (!await isBusinessApproved(ownerUserId)) throw new BusinessLifecycleError();
}
