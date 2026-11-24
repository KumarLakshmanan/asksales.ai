import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { withSystemScope } from '../../tenancy/businessContext.js';
import { verifySupportMediaDeliveryToken } from './SupportMediaDeliveryUrl.js';

export interface SupportMediaSignedCapability {
  assetId: number;
  checksum: string;
  expiresAt: number;
  userId: number;
  businessProfileId: number;
}

/** Resolve only one signed resource. No business processing or Storage may run
 * in this inventory lookup. The returned value grants no actor/billing authority. */
export async function resolveSupportMediaSignedCapability(input: {
  assetId: number; expiresAt: number; token: string;
}): Promise<Readonly<SupportMediaSignedCapability> | null> {
  if (!Number.isSafeInteger(input.assetId) || input.assetId <= 0
    || !Number.isSafeInteger(input.expiresAt) || !/^[a-f0-9]{64}$/i.test(input.token)) return null;
  return withSystemScope('Verify one signed support media capability', async () => {
    const result = await db.execute(sql`SELECT a.id,a.checksum,a.user_id,a.business_profile_id
      FROM support_media_assets a
      JOIN company_settings p ON p.id=a.business_profile_id AND p.user_id=a.user_id AND p.archived_at IS NULL
      JOIN users owner_account ON owner_account.id=a.user_id AND owner_account.deleted_at IS NULL
      WHERE a.id=${input.assetId} LIMIT 1`);
    const row = result.rows[0];
    if (!row) return null;
    const userId = Number(row.user_id), businessProfileId = Number(row.business_profile_id);
    const checksum = String(row.checksum || '');
    if (![userId, businessProfileId].every((id) => Number.isSafeInteger(id) && id > 0)
      || !verifySupportMediaDeliveryToken({ ...input, checksum })) return null;
    // Awaited SQL and plain scalar fields prevent lazy database work or a
    // transaction handle escaping system scope.
    return Object.freeze({ assetId: input.assetId, checksum, expiresAt: input.expiresAt, userId, businessProfileId });
  });
}
