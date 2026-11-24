import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { leadsTable } from '../../models/leads/schema.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import type { OutreachImportSources } from '../../../shared/outreachImportSources.js';

export type ImportSourceFilter = {
  source: 'crm' | 'campaign' | 'campaign_legacy';
  importId?: number;
  campaignId?: number | 'unassigned';
};

/** The predicate is applied to the lead query before ordering and pagination. */
export function creationImportPredicate(userId: number, filter: ImportSourceFilter): SQL {
  const { businessProfileId: business } = requireBusinessScope();
  if (filter.source === 'crm') return sql`EXISTS (
    SELECT 1 FROM crm_contact_import_details detail
    JOIN crm_contact_imports batch ON batch.id=detail.import_id AND batch.business_profile_id=detail.business_profile_id
    JOIN crm_contacts original ON original.id=detail.created_contact_id AND original.business_profile_id=batch.business_profile_id AND original.user_id=${userId}
    JOIN crm_contacts contact ON contact.id=COALESCE(original.merged_into_contact_id,original.id) AND contact.business_profile_id=batch.business_profile_id
    WHERE batch.user_id=${userId} AND batch.business_profile_id=${business}
      AND contact.user_id=${userId} AND contact.deleted_at IS NULL AND contact.lead_id=${leadsTable.id}
      AND detail.status IN ('success','warning')
      ${filter.importId ? sql`AND batch.id=${filter.importId}` : sql``}
  )`;

  const batchThread = filter.campaignId === 'unassigned' ? sql`AND batch.thread_id IS NULL`
    : filter.campaignId ? sql`AND batch.thread_id=${filter.campaignId}` : sql``;
  const members = sql`EXISTS (
    SELECT 1 FROM campaign_lead_import_members member
    JOIN campaign_lead_imports batch ON batch.id=member.import_id AND batch.business_profile_id=member.business_profile_id
    LEFT JOIN crm_contacts original ON original.id=member.contact_id AND original.user_id=${userId} AND original.business_profile_id=${business}
    LEFT JOIN crm_contacts canonical ON canonical.id=COALESCE(original.merged_into_contact_id,original.id)
      AND canonical.user_id=${userId} AND canonical.business_profile_id=${business} AND canonical.deleted_at IS NULL
    WHERE member.user_id=${userId} AND member.business_profile_id=${business} AND batch.user_id=${userId}
      AND COALESCE(canonical.lead_id,member.recipient_lead_id,member.lead_id)=${leadsTable.id}
      ${batchThread} ${filter.importId ? sql`AND batch.id=${filter.importId}` : sql``}
  )`;
  // legacy_campaign_thread_key (migration 587) is the stored, indexed copy of
  // campaignData.threadId; every positive integer thread ID fits its bound.
  const ownedLegacyThread = sql`EXISTS (SELECT 1 FROM chat_threads thread WHERE thread.id::text=${leadsTable}.legacy_campaign_thread_key
    AND thread.user_id=${userId} AND thread.business_profile_id=${business})`;
  const legacyThread = filter.campaignId === 'unassigned' ? sql`FALSE`
    : filter.campaignId ? sql`(${leadsTable}.legacy_campaign_thread_key=${String(filter.campaignId)} AND ${ownedLegacyThread})`
      : ownedLegacyThread;
  const legacy = sql`(${leadsTable.source}='import' AND ${leadsTable.campaignData}->>'source'='csv_import' AND ${legacyThread}
    AND NOT EXISTS (SELECT 1 FROM campaign_lead_import_members recorded WHERE recorded.lead_id=${leadsTable.id}
      AND recorded.user_id=${userId} AND recorded.business_profile_id=${business}))`;
  if (filter.source === 'campaign_legacy') return legacy;
  return filter.importId ? members : sql`(${members} OR ${legacy})`;
}

/** Counts describe distinct available leads, before channel-specific eligibility. */
export async function getCreationImportSources(userId: number): Promise<OutreachImportSources> {
  const { businessProfileId: business } = requireBusinessScope();
  // One connection for the three reads: run in parallel they each take a pooled
  // connection and repeat the tenant-scope setup.
  const [crm, uploads, historical] = await db.transaction(async (tx: typeof db) => [
    await tx.execute(sql`SELECT batch.id,batch.file_name,(EXTRACT(EPOCH FROM batch.created_at)*1000)::double precision AS created_at_ms,batch.import_status,
      COUNT(DISTINCT lead.id)::int AS count
      FROM crm_contact_imports batch
      LEFT JOIN crm_contact_import_details detail ON detail.import_id=batch.id AND detail.business_profile_id=batch.business_profile_id AND detail.status IN ('success','warning')
      LEFT JOIN crm_contacts original ON original.id=detail.created_contact_id AND original.business_profile_id=batch.business_profile_id AND original.user_id=${userId}
      LEFT JOIN crm_contacts contact ON contact.id=COALESCE(original.merged_into_contact_id,original.id) AND contact.business_profile_id=batch.business_profile_id AND contact.user_id=${userId} AND contact.deleted_at IS NULL
      LEFT JOIN leads lead ON lead.id=contact.lead_id AND lead.user_id=${userId} AND lead.business_profile_id=${business} AND lead.deleted_at IS NULL
      WHERE batch.user_id=${userId} AND batch.business_profile_id=${business}
      GROUP BY batch.id ORDER BY batch.created_at DESC,batch.id DESC`),
    await tx.execute(sql`SELECT batch.id,batch.file_name,(EXTRACT(EPOCH FROM batch.created_at)*1000)::double precision AS created_at_ms,batch.thread_id,thread.title,
      COUNT(DISTINCT lead.id)::int AS count
      FROM campaign_lead_imports batch
      LEFT JOIN chat_threads thread ON thread.id=batch.thread_id AND thread.user_id=${userId} AND thread.business_profile_id=${business}
      LEFT JOIN campaign_lead_import_members member ON member.import_id=batch.id AND member.business_profile_id=batch.business_profile_id AND member.user_id=${userId}
      LEFT JOIN crm_contacts original ON original.id=member.contact_id AND original.user_id=${userId} AND original.business_profile_id=${business}
      LEFT JOIN crm_contacts canonical ON canonical.id=COALESCE(original.merged_into_contact_id,original.id) AND canonical.user_id=${userId} AND canonical.business_profile_id=${business} AND canonical.deleted_at IS NULL
      LEFT JOIN leads lead ON lead.id=COALESCE(canonical.lead_id,member.recipient_lead_id,member.lead_id) AND lead.user_id=${userId} AND lead.business_profile_id=${business} AND lead.deleted_at IS NULL
      WHERE batch.user_id=${userId} AND batch.business_profile_id=${business}
      GROUP BY batch.id,thread.title ORDER BY batch.created_at DESC,batch.id DESC`),
    await tx.execute(sql`SELECT thread.id,thread.title,COUNT(DISTINCT lead.id)::int AS count
      FROM chat_threads thread JOIN leads lead ON lead.legacy_campaign_thread_key=thread.id::text
        AND lead.user_id=thread.user_id AND lead.business_profile_id=thread.business_profile_id AND lead.deleted_at IS NULL
      WHERE thread.user_id=${userId} AND thread.business_profile_id=${business}
        AND lead.source='import' AND lead.campaign_data->>'source'='csv_import'
        AND NOT EXISTS (SELECT 1 FROM campaign_lead_import_members member WHERE member.lead_id=lead.id AND member.user_id=${userId} AND member.business_profile_id=${business})
      GROUP BY thread.id ORDER BY thread.id DESC`),
  ]);
  const campaigns = new Map<string, OutreachImportSources['campaigns'][number]>();
  const group = (id: number | null, title: unknown) => {
    const key = id === null ? 'unassigned' : String(id);
    if (!campaigns.has(key)) campaigns.set(key, { id, name: id === null ? 'Other lead uploads' : String(title || `Campaign ${id}`), uploads: [], historicalCount: 0 });
    return campaigns.get(key)!;
  };
  for (const row of uploads.rows) {
    const id = row.thread_id == null ? null : Number(row.thread_id);
    group(id, row.title).uploads.push({ id: Number(row.id), fileName: String(row.file_name), createdAt: new Date(Number(row.created_at_ms)).toISOString(), count: Number(row.count) });
  }
  for (const row of historical.rows) group(Number(row.id), row.title).historicalCount = Number(row.count);
  return {
    campaigns: [...campaigns.values()],
    crmImports: crm.rows.map((row: any) => ({ id: Number(row.id), fileName: String(row.file_name), createdAt: new Date(Number(row.created_at_ms)).toISOString(), count: Number(row.count), status: String(row.import_status) })),
  };
}
