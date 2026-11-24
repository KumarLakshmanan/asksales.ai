import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { crmContactsTable } from '../models/crmContacts/schema.js';
import { crmContactChannelIdentitiesTable } from '../models/crmContactChannelIdentities/schema.js';
import { leadsTable } from '../models/leads/schema.js';
import { outreachConversationsTable } from '../models/outreachConversations/schema.js';
import { logger } from '../utils/logger.js';
import { crmService, lockCrmContactResolution } from './CRMService.js';
import {
  encryptRestrictedPayload,
  isPrivacyVaultConfigured,
  restrictedBindingDigest,
} from './agents/orchestration/PrivacyVaultService.js';

export type ContactTrust = 'provider' | 'customer_verified' | 'owner_verified';

export interface ReconcileInboundContactInput {
  userId: number;
  conversationId: number;
  channel: string;
  externalIdentifier?: string | null;
  displayName?: string | null;
  source?: string;
  trust?: ContactTrust;
  recordReply?: boolean;
  messageId?: number;
  providerMessageId?: string;
}

export interface ReconciledInboundContact {
  leadId: number;
  contactId: number;
  conversationId: number;
}

export function isStrongContactName(value: string | null | undefined): boolean {
  const name = String(value || '').trim();
  if (!name || name.length < 2 || name.length > 255) return false;
  const normalized = name.toLocaleLowerCase('en-US');
  if (['unknown', 'guest', 'customer', 'whatsapp user'].includes(normalized)) return false;
  if (/^(?:ig|fb) user\s+\d+$/i.test(name) || /^@/.test(name)) return false;
  if (/^[+\d\s().-]{7,}$/.test(name) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name)) return false;
  return /\p{L}/u.test(name);
}

function normalizeIdentifier(channel: string, value: string): string {
  const trimmed = value.normalize('NFKC').trim();
  if (channel === 'whatsapp' || channel === 'sms' || channel === 'phone') return trimmed.replace(/\D/g, '');
  if (channel === 'email' || channel === 'gmail') return trimmed.toLocaleLowerCase('en-US');
  return trimmed;
}

function identifierType(channel: string): string {
  if (['whatsapp', 'sms', 'phone'].includes(channel)) return 'phone';
  if (['email', 'gmail'].includes(channel)) return 'email';
  return `provider:${channel}`;
}

export class InboundContactResolver {
  async reconcile(input: ReconcileInboundContactInput): Promise<ReconciledInboundContact | null> {
    return db.transaction(async (tx: any) => {
      await lockCrmContactResolution(tx, input.userId);
      const [conversation] = await tx
        .select({
          id: outreachConversationsTable.id,
          leadId: outreachConversationsTable.leadId,
          crmContactId: outreachConversationsTable.crmContactId,
        })
        .from(outreachConversationsTable)
        .where(
          and(
            eq(outreachConversationsTable.id, input.conversationId),
            eq(outreachConversationsTable.userId, input.userId),
          ),
        )
        .limit(1);
      if (!conversation?.leadId) return null;
      const [conversationLead] = await tx
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, conversation.leadId),
            eq(leadsTable.userId, input.userId),
            isNull(leadsTable.deletedAt),
          ),
        )
        .limit(1);
      if (!conversationLead) return null;

      const normalizedIdentifier = input.externalIdentifier
        ? normalizeIdentifier(input.channel, input.externalIdentifier)
        : '';
      const identityType = identifierType(input.channel);
      const privacyConfigured = isPrivacyVaultConfigured();
      const fingerprint =
        normalizedIdentifier && privacyConfigured
          ? restrictedBindingDigest(input.userId, `crm-identity:${identityType}`, normalizedIdentifier)
          : '';
      if (normalizedIdentifier && !privacyConfigured) {
        logger.error(
          { userId: input.userId, identityType },
          '[InboundContactResolver] Identity persistence skipped because privacy keys are unavailable',
        );
      }
      const knownIdentities: Array<{ contactId: number; leadId: number | null }> = fingerprint
        ? await tx
            .select({
              contactId: crmContactChannelIdentitiesTable.contactId,
              leadId: crmContactsTable.leadId,
            })
            .from(crmContactChannelIdentitiesTable)
            .innerJoin(
              crmContactsTable,
              and(
                eq(crmContactChannelIdentitiesTable.contactId, crmContactsTable.id),
                eq(crmContactsTable.userId, input.userId),
                isNull(crmContactsTable.deletedAt),
              ),
            )
            .where(
              and(
                eq(crmContactChannelIdentitiesTable.userId, input.userId),
                eq(crmContactChannelIdentitiesTable.identifierType, identityType),
                eq(crmContactChannelIdentitiesTable.identifierFingerprint, fingerprint),
                inArray(crmContactChannelIdentitiesTable.verificationLevel, [
                  'provider',
                  'customer_verified',
                  'owner_verified',
                ]),
              ),
            )
        : [];
      // Exact provider-backed email/phone matches also find manual/imported CRM
      // records that predate channel identities. Never infer identity from a name.
      const matchableIdentifier =
        identityType === 'email'
          ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedIdentifier)
          : identityType === 'phone' && /^\d{7,15}$/.test(normalizedIdentifier);
      const exactContacts: Array<{ contactId: number; leadId: number | null }> = matchableIdentifier
        ? await tx
            .select({ contactId: crmContactsTable.id, leadId: crmContactsTable.leadId })
            .from(crmContactsTable)
            .where(
              and(
                eq(crmContactsTable.userId, input.userId),
                isNull(crmContactsTable.deletedAt),
                identityType === 'email'
                  ? sql`lower(btrim(normalize(${crmContactsTable.email}, NFKC))) = ${normalizedIdentifier}`
                  : sql`regexp_replace(normalize(${crmContactsTable.phone}, NFKC), '[^0-9]', '', 'g') = ${normalizedIdentifier}`,
              ),
            )
        : [];
      const candidates = [...knownIdentities, ...exactContacts];
      const distinctContacts = [...new Set(candidates.map((identity) => identity.contactId))];
      if (distinctContacts.length > 1) {
        // Without privacy keys, persist a conversation-scoped review reference
        // rather than hashing plaintext identifiers with an unkeyed digest.
        const conflictFingerprint = fingerprint || `unavailable:conversation:${input.conversationId}`;
        await tx.execute(sql`
        INSERT INTO crm_contact_identity_conflicts (
          user_id, conversation_id, identifier_type, identifier_fingerprint,
          candidate_contact_ids, status, created_at, updated_at
        ) VALUES (
          ${input.userId}, ${input.conversationId}, ${identityType}, ${conflictFingerprint},
          ${JSON.stringify(distinctContacts)}::jsonb, 'pending_review', NOW(), NOW()
        )
        ON CONFLICT (business_profile_id, user_id, identifier_type, identifier_fingerprint)
          WHERE status = 'pending_review'
        DO UPDATE SET candidate_contact_ids = EXCLUDED.candidate_contact_ids,
                      conversation_id = EXCLUDED.conversation_id,
                      updated_at = NOW()
      `);
        logger.warn(
          { userId: input.userId, identityType },
          '[InboundContactResolver] Ambiguous verified identity queued for owner review',
        );
      }
      const knownIdentity = distinctContacts.length === 1 ? candidates[0] : undefined;
      const conversationLeadId = Number(conversation.leadId);
      // Canonical CRM identity and the provider conversation's temporary lead are
      // independent. A CRM-only contact must stay CRM-only, not gain a fake lead.
      const contactId = await crmService.ensureContactForInbound(
        input.userId,
        conversationLeadId,
        {
          source: input.source || input.channel,
          channel: input.channel,
          recordReply: input.recordReply !== false,
          contactId: knownIdentity?.contactId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          providerMessageId: input.providerMessageId,
        },
        tx,
      );
      if (!contactId) return null;

      await tx
        .update(outreachConversationsTable)
        .set({
          crmContactId: contactId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(outreachConversationsTable.id, input.conversationId),
            eq(outreachConversationsTable.userId, input.userId),
          ),
        );

      if (isStrongContactName(input.displayName)) {
        const words = input.displayName!.trim().split(/\s+/);
        const firstName = words[0];
        const lastName = words.slice(1).join(' ') || null;
        await tx
          .update(leadsTable)
          .set({
            name: sql`CASE WHEN name IS NULL OR LOWER(name) IN ('unknown','guest','customer') OR name ~ '^[+0-9 ().-]{7,}$' THEN ${input.displayName!.trim()} ELSE name END`,
            firstName: sql`CASE WHEN first_name IS NULL OR LOWER(first_name) IN ('unknown','guest','customer') OR first_name ~ '^[+0-9 ().-]{7,}$' THEN ${firstName} ELSE first_name END`,
            lastName: sql`CASE WHEN last_name IS NULL THEN ${lastName} ELSE last_name END`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(leadsTable.id, conversationLeadId),
              eq(leadsTable.userId, input.userId),
              isNull(leadsTable.deletedAt),
            ),
          );
        await tx
          .update(crmContactsTable)
          .set({
            firstName: sql`CASE WHEN first_name IS NULL OR LOWER(first_name) IN ('unknown','guest','customer') OR first_name ~ '^[+0-9 ().-]{7,}$' THEN ${firstName} ELSE first_name END`,
            lastName: sql`CASE WHEN last_name IS NULL THEN ${lastName} ELSE last_name END`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(crmContactsTable.id, contactId),
              eq(crmContactsTable.userId, input.userId),
              isNull(crmContactsTable.deletedAt),
            ),
          );
      }

      if (fingerprint && distinctContacts.length <= 1) {
        const encryptedIdentifier = encryptRestrictedPayload(
          input.userId,
          `crm-identity:${identityType}`,
          normalizedIdentifier,
        );
        const existing = await tx
          .select({ contactId: crmContactChannelIdentitiesTable.contactId })
          .from(crmContactChannelIdentitiesTable)
          .where(
            and(
              eq(crmContactChannelIdentitiesTable.userId, input.userId),
              eq(crmContactChannelIdentitiesTable.channel, input.channel),
              eq(crmContactChannelIdentitiesTable.identifierFingerprint, fingerprint),
            ),
          )
          .limit(1);
        let mayBindIdentity = true;
        if (existing[0] && existing[0].contactId !== contactId) {
          // The active lookup above excluded this stale soft-deleted target.
          // Its unique provider identity slot can now point to the active one.
          const [activeTarget] = await tx
            .select({ id: crmContactsTable.id })
            .from(crmContactsTable)
            .where(
              and(
                eq(crmContactsTable.id, existing[0].contactId),
                eq(crmContactsTable.userId, input.userId),
                isNull(crmContactsTable.deletedAt),
              ),
            )
            .limit(1);
          if (activeTarget) {
            // An unverified legacy identity is not trusted for merging, but its
            // active ownership claim still needs review before reassignment.
            mayBindIdentity = false;
            await tx.execute(sql`
              INSERT INTO crm_contact_identity_conflicts (
                user_id, conversation_id, identifier_type, identifier_fingerprint,
                candidate_contact_ids, status, created_at, updated_at
              ) VALUES (${input.userId}, ${input.conversationId}, ${identityType}, ${fingerprint},
                ${JSON.stringify([existing[0].contactId, contactId])}::jsonb, 'pending_review', NOW(), NOW())
              ON CONFLICT (business_profile_id, user_id, identifier_type, identifier_fingerprint) WHERE status = 'pending_review'
              DO UPDATE SET candidate_contact_ids = EXCLUDED.candidate_contact_ids,
                conversation_id = EXCLUDED.conversation_id, updated_at = NOW()
            `);
          }
        }
        if (existing[0] && mayBindIdentity) {
          await tx
            .update(crmContactChannelIdentitiesTable)
            .set({
              contactId,
              leadId: conversationLeadId,
              identifierType: identityType,
              encryptedIdentifier,
              verificationLevel: input.trust || 'provider',
              source: input.source || input.channel,
              lastSeenAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(crmContactChannelIdentitiesTable.userId, input.userId),
                eq(crmContactChannelIdentitiesTable.channel, input.channel),
                eq(crmContactChannelIdentitiesTable.identifierFingerprint, fingerprint),
              ),
            );
        } else if (mayBindIdentity) {
          await tx.insert(crmContactChannelIdentitiesTable).values({
            userId: input.userId,
            contactId,
            leadId: conversationLeadId,
            channel: input.channel,
            identifierType: identityType,
            identifierFingerprint: fingerprint,
            encryptedIdentifier,
            verificationLevel: input.trust || 'provider',
            source: input.source || input.channel,
            lastSeenAt: new Date(),
          });
        }
      }
      return { leadId: conversationLeadId, contactId, conversationId: input.conversationId };
    });
  }
}

export const inboundContactResolver = new InboundContactResolver();
