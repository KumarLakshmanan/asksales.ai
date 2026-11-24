import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';

export class CampaignWorkspaceError extends Error {
  readonly status = 404;
}

/** A campaign workspace is a chat thread, not an outreach/provider campaign ID. */
export async function assertOwnedCampaignThread(userId: number, threadId: number, database = db) {
  const scope = requireBusinessScope();
  if (!Number.isSafeInteger(threadId) || threadId <= 0) throw new CampaignWorkspaceError('Campaign workspace not found.');
  const result = await database.execute(sql`SELECT id FROM chat_threads
    WHERE id=${threadId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}
      AND deleted_at IS NULL FOR KEY SHARE`);
  if (!result.rows.length) throw new CampaignWorkspaceError('Campaign workspace not found.');
}

export async function associateCampaignContact(database: typeof db, userId: number, contactId: number, threadId: number) {
  await assertOwnedCampaignThread(userId, threadId, database);
  const scope = requireBusinessScope();
  const result = await database.execute(sql`INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id)
    SELECT ${userId},${scope.businessProfileId},id,${threadId} FROM crm_contacts
    WHERE id=${contactId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND deleted_at IS NULL
    ON CONFLICT (contact_id,thread_id) DO UPDATE SET contact_id=EXCLUDED.contact_id RETURNING contact_id`);
  if (!result.rows.length) throw new CampaignWorkspaceError('CRM contact not found.');
}
