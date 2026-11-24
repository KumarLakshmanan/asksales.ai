import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withSystemScope } from '../tenancy/businessContext.js';
import { normalizeStorageKey } from './ObjectStorageService.js';
import { consumeManagedStorageCleanup } from './managedStorageCleanup.js';
import type { ManagedStorageTransaction } from './managedStorageReferences.js';
import { logger } from '../utils/logger.js';

type ProfileCleanupReceipt = {
  id: string | number;
  user_id: number;
  storage_key: string;
  storage_backend: string;
};

async function recordRetry(receipt: ProfileCleanupReceipt, error?: unknown) {
  try {
    await db.execute(sql`UPDATE business_profile_asset_cleanup SET attempts=attempts+1,updated_at=now()
      WHERE id=${receipt.id} AND user_id=${receipt.user_id} AND storage_key=${receipt.storage_key} AND storage_backend=${receipt.storage_backend}`);
  } catch (counterError) {
    // The committed intent is still authoritative even when retry metadata is
    // unavailable. Do not prevent a later receipt from reaching its consumer.
    logger.warn({ err: counterError, receiptId: receipt.id }, 'Profile asset retry bookkeeping is unavailable');
  }
  logger.warn({ err: error, receiptId: receipt.id }, 'Deleted profile asset cleanup will retry');
}

/** No live business is needed: these receipts survive deletion of the final profile. */
export async function cleanupDeletedProfileAssets(userId?: number, receiptIds?: string[]) {
  if (receiptIds?.length === 0) return;
  return withSystemScope('Process durable deleted-profile setup asset receipts', async () => {
    const receipts = await db.execute(sql`SELECT * FROM business_profile_asset_cleanup
      WHERE true ${userId === undefined ? sql`` : sql`AND user_id=${userId}`}
      ${receiptIds === undefined ? sql`` : sql`AND id IN (${sql.join(receiptIds.map(id => sql`${id}::bigint`), sql`, `)})`}
      ORDER BY updated_at,id LIMIT 100`);
    for (const receipt of receipts.rows) {
      try {
        const key = normalizeStorageKey(receipt.storage_key);
        const backend = (value: string) => value === 'aws' ? 's3' : value;
        if (!key.startsWith(`${receipt.user_id}/brand_asset/`) ||
            backend(receipt.storage_backend) !== backend(process.env.STORAGE_BACKEND || 'local')) {
          throw new Error('Setup asset cleanup namespace or backend mismatch');
        }
        const outcome = await consumeManagedStorageCleanup({
          identity: { ownerUserId: receipt.user_id, storageBackend: receipt.storage_backend, storageKey: key },
          expectedNamespace: `${receipt.user_id}/brand_asset`,
          // The scan above is a work list. Freshly lock and qualify the exact
          // original receipt inside Storage's canonical object transaction.
          loadIntent: async (tx: ManagedStorageTransaction) => {
            const current = await tx.execute(sql`SELECT id FROM business_profile_asset_cleanup
              WHERE id=${receipt.id} AND user_id=${receipt.user_id} AND storage_key=${receipt.storage_key} AND storage_backend=${receipt.storage_backend} FOR UPDATE`);
            return current.rows.length > 0;
          },
          acknowledge: async (tx: ManagedStorageTransaction) => {
            const removed = await tx.execute(sql`DELETE FROM business_profile_asset_cleanup
              WHERE id=${receipt.id} AND user_id=${receipt.user_id} AND storage_key=${receipt.storage_key} AND storage_backend=${receipt.storage_backend} RETURNING id`);
            return removed.rows.length > 0;
          },
        });
        if (outcome.status === 'deferred') await recordRetry(receipt);
        // Referenced objects retain their intent without pretending deletion or
        // releasing quota. Storage alone owns provider effects and eligibility.
      } catch (error) {
        await recordRetry(receipt, error);
      }
    }
  });
}
