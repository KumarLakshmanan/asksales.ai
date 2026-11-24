import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { leadsTable, type InsertLead } from '../models/leads/schema.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { assertOwnedCampaignThread } from './CampaignWorkspaceService.js';

const importEmailKey = (value: unknown) => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email || null;
};
/** Mirrors leads.phone_lookup_digits (migration 581). */
const importPhoneKey = (value: unknown) => {
  const digits = typeof value === 'string' ? value.normalize('NFKC').replace(/[^0-9]/g, '') : '';
  return /^[0-9]{7,17}$/.test(digits) ? digits : null;
};
type ImportIdentity = { email: string | null; phone: string | null };
/** Same person: an identifier matches and neither one present on both sides disagrees. */
const sameImportPerson = (a: ImportIdentity, b: ImportIdentity) =>
  (!!a.email && a.email === b.email && (!a.phone || !b.phone || a.phone === b.phone))
  || (!!a.phone && a.phone === b.phone && (!a.email || !b.email || a.email === b.email));

/** Create the upload, leads, CRM links, and memberships in one transaction.
 * A row for someone already in this business (same email or phone, with no
 * other identifier disagreeing) reuses that lead instead of creating a
 * duplicate, and repeated rows in one file become one member. Reused leads
 * only gain fields they were missing. A replay with the same request ID
 * returns the original result. */
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
    const identities = input.records.map(record => ({ email: importEmailKey(record.email), phone: importPhoneKey(record.phone) }));
    const emails = [...new Set(identities.map(identity => identity.email).filter(Boolean))] as string[];
    const phones = [...new Set(identities.map(identity => identity.phone).filter(Boolean))] as string[];
    const existing: Array<ImportIdentity & { id: number }> = emails.length || phones.length ? (await tx.execute(sql`SELECT id,lower(trim(email)) AS email,phone_lookup_digits AS phone
      FROM leads WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND deleted_at IS NULL
        AND (lower(trim(email)) = ANY(${sql.param(emails)}::text[]) OR phone_lookup_digits = ANY(${sql.param(phones)}::text[]))
      ORDER BY id`)).rows.map((row: Record<string, unknown>) => ({ id: Number(row.id), email: importEmailKey(row.email), phone: importPhoneKey(row.phone) })) : [];
    // An email match is preferred over a phone match: one phone can be shared by several people's emails.
    const knownLead = (identity: ImportIdentity) =>
      existing.find(lead => !!identity.email && identity.email === lead.email && sameImportPerson(identity, lead))
      || existing.find(lead => sameImportPerson(identity, lead));
    // Each distinct person is either an existing lead or one new row; repeats in the file collapse.
    const people: Array<{ identity: ImportIdentity; existingId?: number; record: InsertLead }> = [];
    const reused = new Set<number>();
    for (const [index, record] of input.records.entries()) {
      const identity = identities[index];
      if (people.some(person => sameImportPerson(identity, person.identity))) continue;
      const known = knownLead(identity);
      if (known && reused.has(known.id)) continue;
      if (known) reused.add(known.id);
      people.push({ identity, existingId: known?.id, record });
    }
    const fresh = people.filter(person => !person.existingId);
    const inserted: Array<{ id: number }> = fresh.length
      ? await tx.insert(leadsTable).values(fresh.map(person => person.record)).returning({ id: leadsTable.id }) : [];
    fresh.forEach((person, index) => { person.existingId = inserted[index].id; });
    for (const { existingId: id, record } of people.filter(candidate => !fresh.includes(candidate))) {
      await tx.execute(sql`UPDATE leads SET
          email=COALESCE(NULLIF(btrim(email),''),${record.email ?? null}),phone=COALESCE(NULLIF(btrim(phone),''),${record.phone ?? null}),
          company=COALESCE(NULLIF(btrim(company),''),${record.company ?? null}),role=COALESCE(NULLIF(btrim(role),''),${record.role ?? null}),
          website=COALESCE(NULLIF(btrim(website),''),${record.website ?? null}),linkedin=COALESCE(NULLIF(btrim(linkedin),''),${record.linkedin ?? null}),
          updated_at=NOW()
          WHERE id=${id} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}`);
    }
    const matchedExisting = people.length - fresh.length;
    const memberLeadIds = people.map(person => person.existingId!);
    // A replay reports total_records, so it counts people, not file rows, like this first response.
    if (people.length !== input.records.length)
      await tx.execute(sql`UPDATE campaign_lead_imports SET total_records=${people.length} WHERE id=${importId}`);
    const members: Array<{ id: number; email: string | null }> = memberLeadIds.length ? (await tx.execute(sql`SELECT id,email FROM leads
      WHERE id = ANY(${sql.param(memberLeadIds)}::int[]) AND user_id=${userId}`)).rows.map((row: Record<string, unknown>) => ({ id: Number(row.id), email: (row.email as string | null) ?? null }))
      .sort((a: { id: number }, b: { id: number }) => memberLeadIds.indexOf(a.id) - memberLeadIds.indexOf(b.id)) : [];
    for (const lead of members) {
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
    return { importId, count: members.length, matchedExisting, replayed: false };
  });
}
