import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { leadsTable, type InsertLead } from '../models/leads/schema.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { assertOwnedCampaignThread } from './CampaignWorkspaceService.js';

/** Create the upload, leads, CRM links, and memberships in one transaction.
 * A replay with the same request ID returns the original result. */
export async function saveCampaignLeadImport(userId: number, input: {
  threadId?: number;
  fileName: string;
  requestId?: string;
  fingerprint: string;
  records: InsertLead[];
}) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new Error('Import owner does not match business scope');
  const { crmService, lockCrmContactResolution } = await import('./CRMService.js');
  return db.transaction(async (tx: typeof db) => {
    if (input.threadId) await assertOwnedCampaignThread(userId, input.threadId, tx);
    if (input.requestId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`campaign-import:${scope.businessProfileId}:${userId}:${input.requestId}`}))`);
      const prior = await tx.execute(sql`SELECT id,total_records,request_fingerprint FROM campaign_lead_imports
        WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND request_id=${input.requestId}`);
      if (prior.rows.length) {
        if (prior.rows[0].request_fingerprint !== input.fingerprint) return { conflict: true };
        return { importId: Number(prior.rows[0].id), count: Number(prior.rows[0].total_records), replayed: true };
      }
    }
    await lockCrmContactResolution(tx, userId);
    const batch = await tx.execute(sql`INSERT INTO campaign_lead_imports(user_id,business_profile_id,thread_id,file_name,total_records,request_id,request_fingerprint)
      VALUES(${userId},${scope.businessProfileId},${input.threadId || null},${input.fileName},${input.records.length},${input.requestId || null},${input.fingerprint}) RETURNING id`);
    const importId = Number(batch.rows[0].id);
    const created: Array<{ id: number; email: string | null }> = await tx.insert(leadsTable).values(input.records).returning({ id: leadsTable.id, email: leadsTable.email });
    for (const lead of created) {
      const contact = await crmService.syncLeadContact(userId, lead.id, undefined, tx);
      let contactId = contact?.id || null;
      let recipientLeadId = contact?.leadId || null;
      if (!contactId && lead.email?.trim()) {
        const matches = await tx.execute(sql`SELECT id,lead_id FROM crm_contacts WHERE user_id=${userId}
          AND business_profile_id=${scope.businessProfileId} AND deleted_at IS NULL AND lower(trim(email))=lower(${lead.email.trim()}) LIMIT 2`);
        if (matches.rows.length === 1) {
          contactId = Number(matches.rows[0].id);
          recipientLeadId = matches.rows[0].lead_id ? Number(matches.rows[0].lead_id) : null;
        }
      }
      if (!recipientLeadId && lead.email?.trim()) {
        const matches = await tx.execute(sql`SELECT id FROM leads WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}
          AND deleted_at IS NULL AND lower(trim(email))=lower(${lead.email.trim()}) ORDER BY id LIMIT 1`);
        recipientLeadId = matches.rows[0] ? Number(matches.rows[0].id) : null;
      }
      await tx.execute(sql`INSERT INTO campaign_lead_import_members(user_id,business_profile_id,import_id,lead_id,recipient_lead_id,contact_id)
        VALUES(${userId},${scope.businessProfileId},${importId},${lead.id},${recipientLeadId},${contactId})`);
    }
    return { importId, count: created.length, replayed: false };
  });
}
