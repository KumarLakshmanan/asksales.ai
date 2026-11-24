import { sql } from 'drizzle-orm';
import {contactPhoneCandidateIds} from '../utils/contactPhoneCandidates.js';
import { isPrivacyVaultConfigured, restrictedBindingDigest } from './agents/orchestration/PrivacyVaultService.js';

export function normalizedContactPhone(value: string | null | undefined): string | null {
  const raw = String(value || '').normalize('NFKC').trim();
  if (!/^[+0-9\s().-]+$/.test(raw)) return null;
  const phone = raw.replace(/\D/g, '');
  return /^\d{7,15}$/.test(phone) ? phone : null;
}

export function contactPhoneFingerprint(userId: number, value: string): string | null {
  const phone = normalizedContactPhone(value);
  return phone && isPrivacyVaultConfigured() ? restrictedBindingDigest(userId, 'crm-identity:phone', phone) : null;
}

// Called inside the shared CRM resolution transaction/lock. Lead IDs and
// provider conversation IDs remain stable; only the canonical CRM owner moves.
export async function mergeContactByPhone(
  tx: any, userId: number, sourceId: number, phoneValue: string | null | undefined,
  conversationId: number | null = null,
  stagedDuplicate = false,
): Promise<number> {
  const phone = normalizedContactPhone(phoneValue);
  if (!phone) return sourceId;
  const source = (await tx.execute(sql`
    SELECT * FROM crm_contacts
    WHERE id = ${sourceId} AND user_id = ${userId}
      AND (deleted_at IS NULL OR (${stagedDuplicate} AND merged_into_contact_id IS NULL)) FOR UPDATE
  `)).rows[0];
  if (!source) return sourceId;
  const fingerprint = contactPhoneFingerprint(userId, phone) || `unavailable:contact:${sourceId}`;
  const matches = (await tx.execute(sql`
    SELECT candidate.id FROM crm_contacts candidate
    WHERE candidate.user_id = ${userId} AND candidate.deleted_at IS NULL AND candidate.id <> ${sourceId}
      AND candidate.business_profile_id IS NOT DISTINCT FROM ${source.business_profile_id}::integer
      AND candidate.id IN (${contactPhoneCandidateIds(userId,source.business_profile_id,phone,fingerprint)})
      AND (candidate.phone_lookup_digits = ${phone}
        OR EXISTS (SELECT 1 FROM crm_contact_channel_identities identity
          WHERE identity.contact_id = candidate.id AND identity.user_id = ${userId}
            AND identity.business_profile_id IS NOT DISTINCT FROM candidate.business_profile_id
            AND identity.identifier_type = 'phone' AND identity.identifier_fingerprint = ${fingerprint}
            AND identity.verification_level IN ('provider', 'customer_verified', 'owner_verified')))
    ORDER BY candidate.id FOR UPDATE OF candidate
  `)).rows as Array<{ id: number }>;
  // CRM also lists unconverted manual/imported/generated leads as virtual
  // contacts. Include those records so their origin cannot bypass matching.
  const virtual = (await tx.execute(sql`
    SELECT lead.id FROM leads lead WHERE lead.user_id = ${userId} AND lead.deleted_at IS NULL
      AND lead.business_profile_id IS NOT DISTINCT FROM ${source.business_profile_id}::integer
      AND lead.id IS DISTINCT FROM ${source.lead_id}::integer
      AND lead.phone_lookup_digits = ${phone}
      AND NOT EXISTS (SELECT 1 FROM crm_contacts contact WHERE contact.user_id = lead.user_id
        AND contact.business_profile_id IS NOT DISTINCT FROM lead.business_profile_id AND contact.lead_id = lead.id)
      AND NOT EXISTS (SELECT 1 FROM outreach_conversations conversation WHERE conversation.user_id = lead.user_id
        AND conversation.business_profile_id IS NOT DISTINCT FROM lead.business_profile_id
        AND conversation.lead_id = lead.id AND conversation.crm_contact_id IS NOT NULL)
    ORDER BY lead.id FOR UPDATE OF lead
  `)).rows as Array<{ id: number }>;
  if (matches.length === 0 && virtual.length === 1) {
    // Replace one active contact with another without exceeding the contact
    // cap in the middle of the transaction. A failure restores the source.
    await tx.execute(sql`UPDATE crm_contacts SET deleted_at=NOW() WHERE id=${sourceId} AND user_id=${userId}`);
    stagedDuplicate = true;
    const stage = sql`CASE WHEN lower(lead.status)='converted' THEN 'won'
      WHEN lower(lead.status) IN ('new','contacted','interested','negotiations','demo','proposal_sent','ticket_open','ticket_close','won','lost')
        THEN lower(lead.status) ELSE 'new' END`;
    const materialized = (await tx.execute(sql`
      INSERT INTO crm_contacts (business_profile_id,user_id,lead_id,first_name,last_name,email,phone,company,role,
        linkedin_url,website,avatar_url,business_category_id,business_category_name,status,pipeline_status,source,last_activity_at)
      SELECT lead.business_profile_id,lead.user_id,lead.id,lead.first_name,lead.last_name,lead.email,lead.phone,
        COALESCE(lead.company,lead.company_name),lead.role,lead.linkedin_url,lead.website,lead.profile_picture,
        lead.business_category_id,lead.business_category_name,
        ${stage},${stage},lead.source,lead.updated_at
      FROM leads lead WHERE lead.id = ${virtual[0].id} AND lead.user_id = ${userId} RETURNING id
    `)).rows[0];
    if (materialized) {
      matches.push({ id: Number(materialized.id) });
      await tx.execute(sql`UPDATE outreach_conversations SET crm_contact_id=${Number(materialized.id)},updated_at=NOW()
        WHERE user_id=${userId} AND lead_id=${virtual[0].id} AND crm_contact_id IS NULL
          AND business_profile_id IS NOT DISTINCT FROM ${source.business_profile_id}::integer`);
    }
    virtual.length = 0;
  }
  if (matches.length + virtual.length === 0) return sourceId;
  if (matches.length + virtual.length > 1) {
    await tx.execute(sql`
      INSERT INTO crm_contact_identity_conflicts (business_profile_id, user_id, conversation_id,
        identifier_type, identifier_fingerprint, candidate_contact_ids, status, created_at, updated_at)
      VALUES (${source.business_profile_id}, ${userId}, ${conversationId}, 'phone', ${fingerprint},
        ${JSON.stringify([sourceId, ...matches.map(row => row.id), ...virtual.map(row => -row.id)])}::jsonb, 'pending_review', NOW(), NOW())
      ON CONFLICT (business_profile_id, user_id, identifier_type, identifier_fingerprint) WHERE status = 'pending_review'
      DO UPDATE SET candidate_contact_ids = EXCLUDED.candidate_contact_ids,
        conversation_id = EXCLUDED.conversation_id, updated_at = NOW()
    `);
    return sourceId;
  }
  const targetId = matches[0].id;
  const fillable = ['first_name', 'last_name', 'email', 'phone', 'company', 'role', 'linkedin_url', 'website',
    'avatar_url', 'business_category_name', 'icp_tier'] as const;
  await tx.execute(sql`
    UPDATE crm_contacts target SET
      ${sql.join(fillable.map(column => sql`${sql.identifier(column)} =
        COALESCE(NULLIF(btrim(target.${sql.identifier(column)}), ''), source.${sql.identifier(column)})`), sql`, `)},
      tags = (SELECT COALESCE(jsonb_agg(DISTINCT tag), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(target.tags, '[]'::jsonb) || COALESCE(source.tags, '[]'::jsonb)) tag),
      notes = CASE WHEN NULLIF(source.notes, '') IS NULL OR target.notes = source.notes THEN target.notes
        WHEN NULLIF(target.notes, '') IS NULL THEN source.notes ELSE target.notes || E'\n\n' || source.notes END,
      total_replies = COALESCE(target.total_replies, 0) + COALESCE(source.total_replies, 0),
      total_outreach_sent = COALESCE(target.total_outreach_sent, 0) + COALESCE(source.total_outreach_sent, 0),
      total_meetings = COALESCE(target.total_meetings, 0) + COALESCE(source.total_meetings, 0),
      first_contacted_at = LEAST(target.first_contacted_at, source.first_contacted_at),
      last_contacted_at = GREATEST(target.last_contacted_at, source.last_contacted_at),
      last_activity_at = GREATEST(target.last_activity_at, source.last_activity_at),
      next_follow_up_at = LEAST(target.next_follow_up_at, source.next_follow_up_at), updated_at = NOW(),
      assigned_to = COALESCE(target.assigned_to, source.assigned_to),
      business_category_id = COALESCE(target.business_category_id, source.business_category_id),
      source_campaign_id = COALESCE(target.source_campaign_id, source.source_campaign_id),
      fit_score = COALESCE(target.fit_score, source.fit_score),
      currency = CASE WHEN target.deal_value IS NULL AND source.deal_value IS NOT NULL THEN source.currency ELSE target.currency END,
      deal_value = COALESCE(target.deal_value, source.deal_value)
    FROM crm_contacts source WHERE target.id = ${targetId} AND source.id = ${sourceId}
      AND target.user_id = ${userId} AND source.user_id = target.user_id
      AND target.business_profile_id IS NOT DISTINCT FROM source.business_profile_id
  `);
  await tx.execute(sql`
    UPDATE outreach_conversations SET crm_contact_id = ${targetId}, updated_at = NOW()
    WHERE user_id = ${userId} AND business_profile_id IS NOT DISTINCT FROM ${source.business_profile_id}::integer
      AND (crm_contact_id = ${sourceId} OR (crm_contact_id IS NULL AND lead_id = ${source.lead_id}::integer))
  `);
  await tx.execute(sql`INSERT INTO campaign_crm_contacts(user_id,business_profile_id,contact_id,thread_id)
    SELECT user_id,business_profile_id,${targetId},thread_id FROM campaign_crm_contacts
    WHERE user_id=${userId} AND contact_id=${sourceId} AND business_profile_id IS NOT DISTINCT FROM ${source.business_profile_id}::integer
    ON CONFLICT(contact_id,thread_id) DO NOTHING`);
  await tx.execute(sql`DELETE FROM campaign_crm_contacts WHERE user_id=${userId} AND contact_id=${sourceId}
    AND business_profile_id IS NOT DISTINCT FROM ${source.business_profile_id}::integer`);

  // All persisted contact foreign keys, including import receipts, must follow
  // the survivor. Messages, bookings and sequences keep their channel lead IDs.
  for (const [table, column, hasUser] of [
    ['crm_contact_channel_identities', 'contact_id', true], ['crm_activities', 'contact_id', true],
    ['crm_activity_reminders', 'contact_id', true], ['support_tickets', 'contact_id', true],
    ['proposals', 'contact_id', true], ['crm_alert_logs', 'contact_id', true],
    ['crm_automation_logs', 'contact_id', true], ['crm_contact_import_details', 'created_contact_id', false],
  ] as const) {
    await tx.execute(sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${targetId}
      WHERE ${sql.identifier(column)} = ${sourceId}
        AND business_profile_id IS NOT DISTINCT FROM ${source.business_profile_id}::integer
        ${hasUser ? sql`AND user_id = ${userId}` : sql``}`);
  }
  await tx.execute(sql`
    UPDATE crm_contacts SET merged_into_contact_id = ${targetId}
    WHERE user_id = ${userId} AND merged_into_contact_id = ${sourceId}
      AND business_profile_id IS NOT DISTINCT FROM ${source.business_profile_id}::integer
  `);
  await tx.execute(sql`
    UPDATE crm_contacts SET deleted_at = NOW(), merged_into_contact_id = ${targetId}, updated_at = NOW()
    WHERE id = ${sourceId} AND user_id = ${userId}
      AND (deleted_at IS NULL OR (${stagedDuplicate} AND merged_into_contact_id IS NULL))
  `);
  await tx.execute(sql`
    INSERT INTO crm_activities (business_profile_id, user_id, contact_id, type, subject, metadata, idempotency_key)
    VALUES (${source.business_profile_id}, ${userId}, ${targetId}, 'contact_merge', 'Contacts merged by phone number',
      ${JSON.stringify({ sourceContactId: sourceId, targetContactId: targetId, identifierType: 'phone' })}::jsonb,
      ${`crm-contact-merge:${sourceId}`}) ON CONFLICT DO NOTHING
  `);
  return targetId;
}
