/**
 * Contacts that look like the same person (same phone or email) and the
 * owner's action to merge them. Automatic matching only merges when exactly
 * one contact matches; ties are left for a person to decide here.
 */
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { businessAuditActor, requireBusinessScope } from '../tenancy/businessContext.js';
import { mergeContactRecords } from './CRMContactMergeService.js';

export const MAX_DUPLICATE_GROUPS = 50;

export interface DuplicateContact {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  conversations: number;
}
export interface DuplicateContactGroup { matchedOn: Array<'phone' | 'email'>; contacts: DuplicateContact[] }

export class ContactMergeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Row = Record<string, unknown>;
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

export async function listDuplicateContacts(userId: number): Promise<DuplicateContactGroup[]> {
  const { businessProfileId } = requireBusinessScope();
  const keys = (await db.execute(sql`WITH active AS (
      SELECT id, phone_lookup_digits AS phone, lower(btrim(email)) AS email FROM crm_contacts
      WHERE user_id=${userId} AND business_profile_id=${businessProfileId} AND deleted_at IS NULL)
    SELECT kind, ids FROM (
      SELECT 'phone' AS kind, array_agg(id ORDER BY id) AS ids FROM active WHERE phone IS NOT NULL GROUP BY phone HAVING count(*) > 1
      UNION ALL
      SELECT 'email', array_agg(id ORDER BY id) FROM active WHERE NULLIF(email,'') IS NOT NULL GROUP BY email HAVING count(*) > 1
    ) duplicate_keys`)).rows as Array<{ kind: 'phone' | 'email'; ids: Array<number | string> }>;
  // A contact sharing a phone with one record and an email with another is one group.
  const parent = new Map<number, number>();
  const root = (id: number): number => {
    const next = parent.get(id) ?? id;
    if (next === id) return id;
    const top = root(next);
    parent.set(id, top);
    return top;
  };
  const matchedOn = new Map<number, Set<'phone' | 'email'>>();
  for (const key of keys) {
    const ids = key.ids.map(Number);
    for (const id of ids) if (!parent.has(id)) parent.set(id, id);
    for (const id of ids.slice(1)) parent.set(root(id), root(ids[0]));
    for (const id of ids) matchedOn.set(id, (matchedOn.get(id) ?? new Set()).add(key.kind));
  }
  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) groups.set(root(id), [...(groups.get(root(id)) ?? []), id]);
  const chosen = [...groups.values()].map(ids => ids.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]).slice(0, MAX_DUPLICATE_GROUPS);
  const ids = chosen.flat();
  if (!ids.length) return [];
  const contacts = new Map((await db.execute(sql`SELECT contact.id, contact.first_name, contact.last_name, contact.email, contact.phone,
      contact.company, contact.source, contact.created_at, contact.last_activity_at,
      (SELECT count(*)::int FROM outreach_conversations conversation WHERE conversation.user_id=contact.user_id
        AND conversation.business_profile_id=contact.business_profile_id AND conversation.crm_contact_id=contact.id) AS conversations
    FROM crm_contacts contact WHERE contact.user_id=${userId} AND contact.business_profile_id=${businessProfileId}
      AND contact.deleted_at IS NULL AND contact.id = ANY(${sql.param(ids)}::int[])`)).rows.map((row: Row) => [Number(row.id), {
    id: Number(row.id),
    name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || String(row.email || row.phone || `Contact ${row.id}`),
    email: (row.email as string) || null,
    phone: (row.phone as string) || null,
    company: (row.company as string) || null,
    source: (row.source as string) || null,
    createdAt: iso(row.created_at),
    lastActivityAt: iso(row.last_activity_at),
    conversations: Number(row.conversations) || 0,
  } satisfies DuplicateContact]));
  return chosen.map(group => ({
    matchedOn: [...new Set(group.flatMap(id => [...(matchedOn.get(id) ?? [])]))].sort() as Array<'phone' | 'email'>,
    contacts: group.map(id => contacts.get(id)).filter((contact): contact is DuplicateContact => !!contact),
  })).filter(group => group.contacts.length > 1);
}

/** Merge one contact into the one the owner keeps. Both must be active in this business. */
export async function mergeDuplicateContact(userId: number, sourceId: number, targetId: number): Promise<{ contactId: number }> {
  const { businessProfileId } = requireBusinessScope();
  if (!Number.isSafeInteger(sourceId) || !Number.isSafeInteger(targetId) || sourceId <= 0 || targetId <= 0)
    throw new ContactMergeError('Choose two saved contacts to merge.');
  if (sourceId === targetId) throw new ContactMergeError('Choose two different contacts to merge.');
  const { lockCrmContactResolution } = await import('./CRMService.js');
  return db.transaction(async (tx: typeof db) => {
    await lockCrmContactResolution(tx, userId);
    const rows = (await tx.execute(sql`SELECT id, business_profile_id, lead_id FROM crm_contacts
      WHERE user_id=${userId} AND business_profile_id=${businessProfileId} AND deleted_at IS NULL
        AND id IN (${sourceId}, ${targetId}) ORDER BY id FOR UPDATE`)).rows as Array<{ id: number; business_profile_id: number; lead_id: number | null }>;
    const source = rows.find(row => Number(row.id) === sourceId);
    if (!source || !rows.some(row => Number(row.id) === targetId))
      throw new ContactMergeError('One of these contacts was already merged or removed. Refresh and try again.', 404);
    await mergeContactRecords(tx, userId, source, targetId, false, {
      identifierType: 'manual', subject: 'Contacts merged by a person', mergedBy: businessAuditActor(userId),
    });
    // Review items that only listed these two contacts are settled by this merge.
    await tx.execute(sql`UPDATE crm_contact_identity_conflicts SET status='resolved', updated_at=NOW()
      WHERE user_id=${userId} AND business_profile_id=${businessProfileId} AND status='pending_review'
        AND candidate_contact_ids @> ${JSON.stringify([sourceId])}::jsonb
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(candidate_contact_ids) candidate
          WHERE candidate::int NOT IN (${sourceId}, ${targetId}) AND (candidate::int < 0 OR EXISTS (
            SELECT 1 FROM crm_contacts other WHERE other.id = candidate::int AND other.deleted_at IS NULL)))`);
    return { contactId: targetId };
  });
}
