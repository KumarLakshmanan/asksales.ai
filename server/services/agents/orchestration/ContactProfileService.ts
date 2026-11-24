import crypto from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { crmContactsTable } from '../../../models/crmContacts/schema.js';
import { outreachConversationsTable } from '../../../models/outreachConversations/schema.js';
import { leadsTable } from '../../../models/leads/schema.js';
import type {
  PlaybookFieldDefinition,
  PlaybookFieldState,
  PlaybookProfileBinding,
} from '../../../models/supportOrchestration/schema.js';
import { isStrongContactName } from '../../InboundContactResolver.js';
import { lockCrmContactResolution } from '../../CRMService.js';
import { mergeContactByPhone } from '../../CRMContactMergeService.js';
import { privacyVaultService, restrictedBindingDigest } from './PrivacyVaultService.js';

export interface ContactProfileValue {
  value: string;
  vaultRef: number;
  trust: 'provider' | 'customer_verified' | 'owner_verified';
}

export interface ContactProfileSnapshot {
  contactId: number;
  leadId: number;
  fields: Partial<Record<'fullName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'company', ContactProfileValue>>;
}

const PROFILE_ATTRIBUTES = ['fullName', 'firstName', 'lastName', 'email', 'phone', 'company'] as const;
type ProfileAttribute = (typeof PROFILE_ATTRIBUTES)[number];
function isProfileAttribute(value: unknown): value is ProfileAttribute {
  return typeof value === 'string' && PROFILE_ATTRIBUTES.includes(value as ProfileAttribute);
}
function pendingCorrection(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ['pending_customer_confirmation', 'pending_owner_or_customer_confirmation'].includes(
      String((value as Record<string, unknown>).status),
    ),
  );
}
function attributeLabel(attribute: ProfileAttribute): string {
  return {
    fullName: 'name',
    firstName: 'first name',
    lastName: 'last name',
    email: 'email address',
    phone: 'phone number',
    company: 'company',
  }[attribute];
}

function tokenFromProtected(redactedText: string): string | null {
  return redactedText.match(/\[(?:NAME|EMAIL|PHONE|COMPANY)_\d+\]/)?.[0] || null;
}

function extractProfileValue(attribute: PlaybookProfileBinding['attribute'], rawText: string): string | null {
  const raw = rawText.normalize('NFKC').trim();
  if (attribute === 'email') return raw.match(/[^@\s]+@[^@\s]+\.[^@\s]+/)?.[0]?.replace(/[.,;:!?]+$/, '') || null;
  if (attribute === 'phone') {
    const candidate = raw.match(/(?:\+?\d[\d\s().-]{5,}\d)/)?.[0]?.trim() || '';
    return /^\d{7,15}$/.test(candidate.replace(/\D/g, '')) ? candidate : null;
  }
  if (attribute === 'company') {
    const candidate = raw
      .match(/\b(?:company is|work(?:ing)? at|from)\s+([\p{L}\p{N}][\p{L}\p{N}&.' -]{1,120})/iu)?.[1]
      ?.split(/\b(?:and|but)\s+(?:my\s+)?(?:email|phone|number|name)\b/i)[0]
      ?.replace(/[.,;:!?]+$/, '')
      .trim();
    return candidate || (/^[\p{L}\p{N}][\p{L}\p{N}&.' -]{1,120}$/u.test(raw) ? raw : null);
  }
  const fullNamePrefix = /\b(?:my name is|i am|i'm|this is|call me|please use the name)\s+/i.test(raw);
  let name = raw
    .replace(/^.*?\b(?:my (?:first |last )?name is|i am|i'm|this is|call me|please use the name)\s+/i, '')
    .trim();
  name = name
    .split(/\b(?:and|but)\s+(?:my\s+)?(?:email|phone|number|company)\b/i)[0]
    .replace(/[^\p{L}\p{M}' -].*$/u, '')
    .replace(/[.!?,-]+$/g, '')
    .trim();
  if (!isStrongContactName(name)) return null;
  if (attribute === 'firstName') return name.split(/\s+/)[0] || null;
  if (attribute === 'lastName') return fullNamePrefix ? name.split(/\s+/).slice(1).join(' ') || null : name;
  return name;
}

export class ContactProfileService {
  async handleExplicitNameCorrection(input: {
    userId: number;
    conversationId: number;
    inboundText: string;
    inboundVaultId?: number | null;
    profile: ContactProfileSnapshot | null;
  }): Promise<{ handled: boolean; replyText?: string; outcome?: 'pending' | 'updated' | 'cancelled' }> {
    return db.transaction(async (tx: any) => {
      await lockCrmContactResolution(tx, input.userId);
      const profile = await this.loadRawContact(input.userId, input.conversationId, tx, true);
      if (!profile) return { handled: false };
      const pending = profile.correction;
      if (pendingCorrection(pending)) {
        const answer = input.inboundText.trim().toLocaleLowerCase('en-US');
        if (answer === 'no') {
          await this.clearCorrection(tx, input.userId, input.conversationId);
          return {
            handled: true,
            outcome: 'cancelled',
            replyText: 'Understood — I’ll keep the existing contact profile.',
          };
        }
        if (!isProfileAttribute(pending.attribute)) {
          return {
            handled: true,
            outcome: 'pending',
            replyText: 'I could not validate that profile change safely. Reply No to cancel it.',
          };
        }
        const attribute = pending.attribute;
        const label = attributeLabel(attribute);
        if (answer !== 'yes') {
          return {
            handled: true,
            outcome: 'pending',
            replyText: `Should I replace the existing ${label} on your contact profile? Reply Yes or No on its own.`,
          };
        }
        if (pending.contactId && Number(pending.contactId) !== profile.contactId) {
          return {
            handled: true,
            outcome: 'pending',
            replyText:
              'The contact linked to this conversation has changed. Reply No to cancel this profile change and provide it again.',
          };
        }
        const currentDigest = this.valueDigest(input.userId, profile, attribute);
        if (pending.currentValueDigest && pending.currentValueDigest !== currentDigest) {
          await this.saveCorrection(tx, input.userId, input.conversationId, {
            ...pending,
            currentValueDigest: currentDigest,
          });
          return {
            handled: true,
            outcome: 'pending',
            replyText: `The saved ${label} has changed since I asked. Should I still replace it with the value you provided? Reply Yes or No on its own.`,
          };
        }
        const vaultRef = Number(pending.vaultRef || 0);
        const revealed =
          Number.isSafeInteger(vaultRef) && vaultRef > 0
            ? await privacyVaultService.reveal(input.userId, vaultRef, { conversationId: input.conversationId, actor: 'system:contact-profile', purpose: 'confirmed_identity_correction' })
            : null;
        const value = revealed ? extractProfileValue(attribute, revealed.rawText) : null;
        if (!value) {
          return {
            handled: true,
            outcome: 'pending',
            replyText: `I could not validate that ${label}. Reply No to cancel this change, then provide the value again.`,
          };
        }
        await this.applyValue(tx, input.userId, input.conversationId, profile, attribute, value, true);
        return {
          handled: true,
          outcome: 'updated',
          replyText: `Thanks — I’ve updated the ${label} on your contact profile.`,
        };
      }

      const hasKnownName = isStrongContactName(this.currentValue(profile, 'fullName'));
      const proposesName =
        /\b(?:my name is|call me|please use the name)\b/i.test(input.inboundText) &&
        /\[NAME_\d+\]/.test(input.inboundText);
      if (!hasKnownName || !proposesName || !input.inboundVaultId) return { handled: false };
      await this.saveCorrection(tx, input.userId, input.conversationId, {
        attribute: 'fullName',
        contactId: profile.contactId,
        currentValueDigest: this.valueDigest(input.userId, profile, 'fullName'),
        vaultRef: input.inboundVaultId,
        status: 'pending_customer_confirmation',
        detectedAt: new Date().toISOString(),
      });
      return {
        handled: true,
        outcome: 'pending',
        replyText:
          'I already have a name on your contact profile. Should I replace it with the new name you just provided? Reply Yes or No on its own.',
      };
    });
  }

  async loadForConversation(userId: number, conversationId: number): Promise<ContactProfileSnapshot | null> {
    const row = await this.loadRawContact(userId, conversationId);
    return this.snapshotFromRow(userId, conversationId, row || undefined);
  }

  async loadForLead(userId: number, leadId: number, conversationId: number): Promise<ContactProfileSnapshot | null> {
    if (!Number.isSafeInteger(leadId) || leadId <= 0 || !Number.isSafeInteger(conversationId) || conversationId < 0)
      return null;
    if (conversationId > 0) {
      const row = await this.loadRawContact(userId, conversationId, db, false, leadId);
      return this.snapshotFromRow(userId, conversationId, row || undefined);
    }
    const result = await db.execute(sql`
      SELECT l.id AS lead_id, cc.id AS contact_id,
             cc.first_name, cc.last_name, cc.email, cc.phone, cc.company,
             l.name AS lead_name, l.full_name AS lead_full_name
      FROM leads l
      JOIN crm_contacts cc ON cc.user_id = l.user_id
        AND cc.lead_id = l.id AND cc.deleted_at IS NULL
      WHERE l.id = ${leadId} AND l.user_id = ${userId} AND l.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM crm_contacts other
          WHERE other.user_id = l.user_id AND other.lead_id = l.id
            AND other.deleted_at IS NULL AND other.id <> cc.id
        )
      LIMIT 1
    `);
    return this.snapshotFromRow(userId, conversationId, result.rows[0] as Record<string, unknown> | undefined);
  }

  private async snapshotFromRow(
    userId: number,
    conversationId: number,
    row: Record<string, unknown> | undefined,
  ): Promise<ContactProfileSnapshot | null> {
    const contactId = Number(row?.contact_id || 0);
    const leadId = Number(row?.lead_id || 0);
    if (!contactId || !leadId) return null;

    const firstName = String(row?.first_name || '').trim();
    const lastName = String(row?.last_name || '').trim();
    const fullNameCandidate =
      [firstName, lastName].filter(Boolean).join(' ') || String(row?.lead_full_name || row?.lead_name || '').trim();
    const raw: Array<[keyof ContactProfileSnapshot['fields'], string, string]> = [];
    if (isStrongContactName(fullNameCandidate))
      raw.push(['fullName', fullNameCandidate, `My name is ${fullNameCandidate}`]);
    if (isStrongContactName(firstName)) raw.push(['firstName', firstName, `My name is ${firstName}`]);
    if (lastName && /\p{L}/u.test(lastName)) raw.push(['lastName', lastName, `My name is ${lastName}`]);
    const email = String(row?.email || '').trim();
    const phone = String(row?.phone || '').trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) raw.push(['email', email, email]);
    if (phone.replace(/\D/g, '').length >= 7) raw.push(['phone', phone, phone]);

    const fields: ContactProfileSnapshot['fields'] = {};
    for (const [attribute, original, protectText] of raw) {
      const digest = restrictedBindingDigest(userId, `crm-profile:${contactId}:${String(attribute)}`, original);
      const protectedValue = await privacyVaultService.protectInbound({
        userId,
        conversationId,
        channel: 'internal_crm',
        rawText: protectText,
        providerMessageId: `crm:${contactId}:${String(attribute)}:${crypto.createHash('sha256').update(digest).digest('hex').slice(0, 32)}`,
        entityType: 'widget_profile',
        entityId: contactId,
        retentionDays: 90,
      });
      const token = tokenFromProtected(protectedValue.redactedText);
      if (protectedValue.vaultId && token)
        fields[attribute] = { value: token, vaultRef: protectedValue.vaultId, trust: 'provider' };
    }
    return { contactId, leadId, fields };
  }

  async writeBackCollectedField(input: {
    userId: number;
    conversationId: number;
    runId: number;
    field: PlaybookFieldDefinition;
    state: PlaybookFieldState;
  }): Promise<'updated' | 'unchanged' | 'conflict' | 'ignored'> {
    const binding = input.field.profileBinding;
    if (
      !binding ||
      !isProfileAttribute(binding.attribute) ||
      binding.writeBack !== 'fill_missing_or_verify_correction' ||
      input.state.source !== 'customer' ||
      !input.state.vaultRef ||
      !['collected', 'verified'].includes(input.state.status)
    )
      return 'ignored';
    const revealed = await privacyVaultService.reveal(input.userId, input.state.vaultRef, { conversationId: input.conversationId, actor: 'system:contact-profile', purpose: 'collected_identity_writeback' });
    if (!revealed) return 'ignored';
    const value = extractProfileValue(binding.attribute, revealed.rawText);
    if (!value) return 'ignored';
    return db.transaction(async (tx: any) => {
      await lockCrmContactResolution(tx, input.userId);
      const profile = await this.loadRawContact(input.userId, input.conversationId, tx, true);
      if (!profile) return 'ignored';
      const current = this.currentValue(profile, binding.attribute);
      if (
        current &&
        this.normalizedValue(binding.attribute, current) !== this.normalizedValue(binding.attribute, value)
      ) {
        // Do not silently replace an unresolved correction with another field
        // from the same compound playbook answer (or a concurrent worker).
        if (!pendingCorrection(profile.correction))
          await this.saveCorrection(tx, input.userId, input.conversationId, {
            fieldKey: input.field.key,
            attribute: binding.attribute,
            runId: input.runId,
            contactId: profile.contactId,
            currentValueDigest: this.valueDigest(input.userId, profile, binding.attribute),
            vaultRef: input.state.vaultRef,
            status: 'pending_owner_or_customer_confirmation',
            detectedAt: new Date().toISOString(),
          });
        return 'conflict';
      }
      if (current) {
        if (binding.attribute === 'phone') {
          const canonicalId = await mergeContactByPhone(tx, input.userId, profile.contactId, value, input.conversationId);
          if (canonicalId !== profile.contactId) return 'updated';
        }
        return 'unchanged';
      }
      if (pendingCorrection(profile.correction) && profile.correction.attribute === binding.attribute)
        return 'conflict';
      await this.applyValue(tx, input.userId, input.conversationId, profile, binding.attribute, value, false);
      return 'updated';
    });
  }

  private async loadRawContact(
    userId: number,
    conversationId: number,
    executor: any = db,
    lock = false,
    expectedLeadId?: number,
  ): Promise<(Record<string, unknown> & { leadId: number; contactId: number }) | null> {
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return null;
    const result = await executor.execute(sql`
      SELECT oc.lead_id, cc.id AS contact_id, cc.first_name, cc.last_name, cc.email, cc.phone, cc.company,
        l.name AS lead_name, l.full_name AS lead_full_name,
        oc.metadata->'contactProfileCorrection' AS correction
      FROM outreach_conversations oc
      JOIN leads l ON l.id = oc.lead_id AND l.user_id = oc.user_id AND l.deleted_at IS NULL
      JOIN crm_contacts cc ON cc.user_id = oc.user_id
        AND (cc.id = oc.crm_contact_id OR (oc.crm_contact_id IS NULL AND cc.lead_id = oc.lead_id
          AND NOT EXISTS (
            SELECT 1 FROM crm_contacts other
            WHERE other.user_id = oc.user_id AND other.lead_id = oc.lead_id
              AND other.deleted_at IS NULL AND other.id <> cc.id
          )))
        AND cc.deleted_at IS NULL
      WHERE oc.id = ${conversationId} AND oc.user_id = ${userId}
        ${expectedLeadId === undefined ? sql`` : sql`AND oc.lead_id = ${expectedLeadId}`}
      LIMIT 1
      ${lock ? sql`FOR UPDATE OF oc, l, cc` : sql``}
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { ...row, leadId: Number(row.lead_id), contactId: Number(row.contact_id) } : null;
  }

  private currentValue(profile: Record<string, unknown>, attribute: string): string {
    if (attribute === 'fullName') return [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
    const column = attribute.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    return String(profile[column] || '').trim();
  }

  private normalizedValue(attribute: ProfileAttribute, value: string): string {
    return attribute === 'phone' ? value.replace(/\D/g, '') : value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  }

  private valueDigest(userId: number, profile: Record<string, unknown>, attribute: ProfileAttribute) {
    return restrictedBindingDigest(
      userId,
      `crm-profile-correction:${profile.contactId}:${attribute}`,
      this.normalizedValue(attribute, this.currentValue(profile, attribute)),
    );
  }

  private async saveCorrection(tx: any, userId: number, conversationId: number, correction: Record<string, unknown>) {
    await tx
      .update(outreachConversationsTable)
      .set({
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ contactProfileCorrection: correction })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(outreachConversationsTable.id, conversationId), eq(outreachConversationsTable.userId, userId)));
  }

  private async clearCorrection(tx: any, userId: number, conversationId: number) {
    await tx
      .update(outreachConversationsTable)
      .set({
        metadata: sql`COALESCE(metadata, '{}'::jsonb) - 'contactProfileCorrection'`,
        updatedAt: new Date(),
      })
      .where(and(eq(outreachConversationsTable.id, conversationId), eq(outreachConversationsTable.userId, userId)));
  }

  private async applyValue(
    tx: any,
    userId: number,
    conversationId: number,
    profile: Record<string, unknown>,
    attribute: ProfileAttribute,
    value: string,
    clearCorrection: boolean,
  ) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const leadUpdates: Record<string, unknown> = { updatedAt: new Date() };
    const conversationUpdates: Record<string, unknown> = { updatedAt: new Date() };
    if (attribute === 'fullName') {
      const words = value.split(/\s+/);
      updates.firstName = words[0];
      updates.lastName = words.slice(1).join(' ') || null;
      Object.assign(leadUpdates, {
        name: value,
        fullName: value,
        firstName: updates.firstName,
        lastName: updates.lastName,
      });
      conversationUpdates.leadName = value;
    } else {
      updates[attribute] = value;
      leadUpdates[attribute] = value;
      if (attribute === 'firstName' || attribute === 'lastName') {
        const fullName = [
          attribute === 'firstName' ? value : profile.first_name,
          attribute === 'lastName' ? value : profile.last_name,
        ]
          .filter(Boolean)
          .join(' ');
        Object.assign(leadUpdates, { name: fullName, fullName });
        conversationUpdates.leadName = fullName;
      } else if (attribute === 'email') conversationUpdates.leadEmail = value;
      else if (attribute === 'company') conversationUpdates.leadCompany = value;
    }
    const changedContacts = await tx
      .update(crmContactsTable)
      .set(updates)
      .where(
        and(
          eq(crmContactsTable.id, Number(profile.contactId)),
          eq(crmContactsTable.userId, userId),
          isNull(crmContactsTable.deletedAt),
        ),
      )
      .returning({ id: crmContactsTable.id });
    const changedLeads = await tx
      .update(leadsTable)
      .set(leadUpdates)
      .where(
        and(eq(leadsTable.id, Number(profile.leadId)), eq(leadsTable.userId, userId), isNull(leadsTable.deletedAt)),
      )
      .returning({ id: leadsTable.id });
    if (!changedContacts.length || !changedLeads.length) throw new Error('Contact profile changed during update');
    if (clearCorrection)
      conversationUpdates.metadata = sql`COALESCE(metadata, '{}'::jsonb) - 'contactProfileCorrection'`;
    await tx
      .update(outreachConversationsTable)
      .set(conversationUpdates)
      .where(and(eq(outreachConversationsTable.id, conversationId), eq(outreachConversationsTable.userId, userId)));
    if (attribute === 'phone')
      await mergeContactByPhone(tx, userId, Number(profile.contactId), value, conversationId);
  }
}

export const contactProfileService = new ContactProfileService();
