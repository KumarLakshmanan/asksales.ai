/**
 * Inbound Email Service
 * Common service for processing inbound emails from any provider (Resend, Gmail, etc.)
 * Handles: thread matching, lead resolution, conversation management,
 * sentiment analysis, auto-reply, follow-up sequence pausing, and event publishing.
 */

import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { eventBus } from '../events/EventBus.js';
import * as OutreachConversationModel from '../models/outreachConversations/functions';
import crypto from 'crypto';
import {
  privacyVaultService,
  redactPiiWithStableTokens,
} from './agents/orchestration/PrivacyVaultService.js';
import type { AgentResult } from './agents/BaseOutreachAgent.js';
import { markAssistantDelivery } from './assistants/AssistantContext.js';
import { withPublishedAssistant } from './assistants/AssistantFreshness.js';
import { matchesHandoffOfferReply, validatedHandoffChoice } from './agents/orchestration/HandoffConsent.js';
import { conversationCampaignReplyContext, generateCampaignEmailReply, type EmailReplyContext } from './outreach/CampaignEmailReplyService.js';
import { autoReplyLoopDetected } from './outreach/AutoReplyLoopGuard.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { isEmailAddress } from '../../shared/emailAddress.js';

/** Publishing an email account assignment authorizes new support enquiries to that inbox. */
export async function hasPublishedReceivingEmailAssistant(
  userId: number, conversationId: number, accountId: string | null, senderId: number | null,
): Promise<boolean> {
  const scope = currentBusinessScope();
  if (!scope || scope.userId !== userId || !accountId || !senderId) return false;
  try {
    const assigned = await db.execute(sql`SELECT binding.id AS receiving_email_binding_id
      FROM outreach_assistant_bindings binding
      JOIN outreach_assistants assistant ON assistant.id=binding.assistant_id
        AND assistant.user_id=binding.user_id AND assistant.business_profile_id=binding.business_profile_id
      JOIN outreach_assistant_revisions revision ON revision.assistant_id=assistant.id
        AND revision.revision=binding.revision
      JOIN email_senders sender ON sender.id=${senderId} AND sender.user_id=binding.user_id
        AND sender.business_profile_id=binding.business_profile_id AND sender.is_verified
        AND lower(sender.email)=${accountId}
      JOIN outreach_conversations conversation ON conversation.id=${conversationId}
        AND conversation.user_id=binding.user_id AND conversation.business_profile_id=binding.business_profile_id
        AND conversation.channel IN ('email','gmail') AND conversation.provider_account_id=${accountId}
      WHERE binding.user_id=${userId} AND binding.business_profile_id=${scope.businessProfileId}
        AND binding.channel='email' AND binding.surface='private' AND binding.account_id=${accountId}
        AND binding.enabled AND assistant.state='live' AND assistant.published_revision=binding.revision
      LIMIT 2`);
    return assigned.rows.length === 1;
  } catch (error) {
    logger.warn({ err: error, userId, conversationId }, '[InboundEmail] Receiving support assignment could not be verified');
    return false;
  }
}

// ─── Email Parsing Utilities ────────────────────────────────────────────────────

export function extractEmailAddress(value: string): string {
  const emailMatch = value.match(/<([^>]+)>/) || [null, value];
  return (emailMatch[1] || value || '').trim().toLowerCase();
}

export function extractEmailFromUnknown(value: unknown): string {
  if (!value) return '';

  if (typeof value === 'string') {
    return extractEmailAddress(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const email = extractEmailFromUnknown(item);
      if (email) return email;
    }
    return '';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const direct = obj.email || obj.address || obj.from;
    if (typeof direct === 'string') {
      return extractEmailAddress(direct);
    }
  }

  return '';
}

export function extractNameFromUnknown(value: unknown): string {
  if (!value) return '';

  if (typeof value === 'string') {
    const cleaned = value.replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
    if (isLikelyEmail(cleaned)) return '';
    return cleaned;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const name = extractNameFromUnknown(item);
      if (name) return name;
    }
    return '';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name.trim();
    if (typeof obj.displayName === 'string') return obj.displayName.trim();
  }

  return '';
}

export function extractEmailsFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => extractEmailFromUnknown(v)).filter(Boolean);
  }
  const single = extractEmailFromUnknown(value);
  return single ? [single] : [];
}

export function isLikelyEmail(value: string): boolean {
  if (!value) return false;
  return isEmailAddress(value);
}

export function normalizeEmailForMatch(value: string): string {
  const email = extractEmailAddress(value);
  const [localPart = '', domainPart = ''] = email.split('@');
  if (!localPart || !domainPart) return email;

  const normalizedDomain = domainPart === 'googlemail.com' ? 'gmail.com' : domainPart;

  if (normalizedDomain === 'gmail.com') {
    const withoutPlus = localPart.split('+')[0];
    const withoutDots = withoutPlus.replace(/\./g, '');
    return `${withoutDots}@${normalizedDomain}`;
  }

  return `${localPart}@${normalizedDomain}`;
}

export function extractLatestReplyContent(rawBody: string): string {
  const raw = (rawBody || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return raw;

  // Remove common markdown/code-fence artifacts that sometimes leak from provider parsers.
  let cleaned = raw
    .replace(/^```\s*$/gm, '')
    .replace(/^`\s*$/gm, '')
    .trim();

  // Gmail folds the "On ... <address> wrote:" attribution across lines.
  // Bound the header, require an address, and keep only text before it.
  const lines = cleaned.split('\n');
  for (let start = 1; start < lines.length; start++) {
    if (!/^On\s/i.test(lines[start])) continue;
    let header = lines[start];
    let quoted = false;
    for (let end = start + 1; end <= start + 3 && end < lines.length; end++) {
      if (!lines[end].trim() || header.length + lines[end].length > 1200) break;
      header += ` ${lines[end].trim()}`;
      if (/wrote:\s*$/i.test(header) && /<\s*[^<>\s@]+@[^<>\s@]+\s*>/.test(header)) {
        cleaned = lines.slice(0, start).join('\n').trim();
        quoted = true;
        break;
      }
    }
    if (quoted) break;
  }

  // Split off quoted thread blocks (common in email replies).
  const splitPatterns = [
    /^On\s.+wrote:\s*$/im,
    /^From:\s.+$/im,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
    /^_{5,}\s*$/im,
  ];

  for (const pattern of splitPatterns) {
    const idx = cleaned.search(pattern);
    if (idx > 0) {
      cleaned = cleaned.slice(0, idx).trim();
      break;
    }
  }

  // Drop classic quote-prefix lines.
  cleaned = cleaned
    .split('\n')
    .filter((line) => !line.trim().startsWith('>'))
    .join('\n')
    .trim();

  return cleaned || raw;
}

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Provider identifier for outreach conversations */
export type InboundEmailProvider = 'resend' | 'gmail' | 'smtp';

/** Input data for processing an inbound email */
export interface InboundEmailData {
  /** The provider that received this email */
  provider: InboundEmailProvider;
  /** Internal Gmail credential owner, supplied only after webhook verification
   * and mailbox authentication. Never populate from an inbound email header. */
  receivingUserId?: number;
  /** External message ID from the provider */
  externalMessageId: string;
  /** Sender email address */
  senderEmail: string;
  /** Sender display name (if available) */
  senderDisplayName?: string;
  /** Email subject */
  subject: string;
  /** Email body (plain text preferred) */
  body: string;
  /** HTML body (optional) */
  htmlBody?: string;
  /** In-Reply-To header (RFC5322 Message-ID of the parent message) */
  inReplyTo?: string;
  /** References header */
  references?: string;
  /** Recipient email addresses (the "To" addresses on the inbound email) */
  recipientEmails?: string[];
  /** Gmail thread ID (if available) */
  gmailThreadId?: string;
  /** Email attachments (already downloaded as buffers) */
  attachments?: InboundEmailAttachment[];
  /** Raw email headers (key → value, lowercase header names) — used for spam/promo detection */
  rawHeaders?: Record<string, string>;
  /** Provider-parsed MIME evidence, including inline calendar parts. */
  containsCalendarEvent?: boolean;
  /** Gmail label IDs for spam/promotional category detection */
  gmailLabelIds?: string[];
}

/** An attachment from an inbound email */
export interface InboundEmailAttachment {
  /** Original filename */
  filename: string;
  /** MIME type */
  contentType: string;
  /** Raw file data */
  data: Buffer;
  /** Size in bytes */
  size: number;
}

/** Result of processing an inbound email */
export interface InboundEmailResult {
  success: boolean;
  /** Whether the email was a duplicate and was skipped */
  duplicate?: boolean;
  /** Whether the email was skipped as spam / promotional (not a real customer message) */
  skipped?: boolean;
  /** Reason for skipping (e.g. 'spam_or_promotional') */
  skipReason?: string;
  /** Resolved user ID */
  userId?: number;
  /** Resolved lead ID */
  leadId?: number;
  /** Outreach conversation ID */
  conversationId?: number;
  /** Error message if processing failed */
  error?: string;
}

// ─── Thread Matching ────────────────────────────────────────────────────────────

/**
 * Find the original outbound message that this email is replying to.
 * Searches sent_messages and outreach_messages tables.
 */
export async function findOriginalMessage(
  receivingUserId: number,
  inReplyTo: string,
  senderEmail: string,
  normalizedSenderEmail: string,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const cleanParentMessageId = inReplyTo.replace(/^<|>$/g, '').trim();

  // 1. Precise match via In-Reply-To Message-ID
  if (cleanParentMessageId) {
    const sentExact = await db.execute(sql`
      SELECT sm.id, sm.user_id, sm.lead_id, sm.campaign_id, sm.is_reply, sm.reply_context, sm.subject, sm.message_id as original_message_id,
             l.name as lead_name, l.email as lead_email, u.email as user_email, sm.sent_at,
             (SELECT m.conversation_id FROM outreach_messages m WHERE m.id=sm.outreach_message_id
               AND m.user_id=sm.user_id) as conversation_id, 'sent_messages'::text as match_source
      FROM sent_messages sm
      JOIN leads l ON l.id = sm.lead_id
      LEFT JOIN users u ON u.id = sm.user_id
      WHERE sm.user_id = ${receivingUserId} AND l.user_id = ${receivingUserId} AND l.deleted_at IS NULL
        AND LOWER(TRIM(l.email)) IN (${normalizedSenderEmail}, ${senderEmail})
        AND (sm.message_id = ${cleanParentMessageId} OR sm.message_id = ${inReplyTo})
      LIMIT 2
    `);
    if (sentExact.rows.length > 1) return null;
    if (sentExact.rows.length > 0) return sentExact.rows[0];

    const outreachExact = await db.execute(sql`
      SELECT om.id, oc.user_id, oc.lead_id, om.campaign_id, (om.message_kind='reply') AS is_reply,
             om.metadata->'emailReplyContext' AS reply_context, om.subject,
             COALESCE(om.rfc_message_id, om.external_message_id) as original_message_id,
             l.name as lead_name, l.email as lead_email, u.email as user_email, om.sent_at,
             oc.id as conversation_id, 'outreach_messages'::text as match_source
      FROM outreach_messages om
      JOIN outreach_conversations oc ON oc.id = om.conversation_id
      JOIN leads l ON l.id = oc.lead_id
      LEFT JOIN users u ON u.id = oc.user_id
      WHERE oc.user_id = ${receivingUserId} AND om.user_id = ${receivingUserId}
        AND l.user_id = ${receivingUserId} AND l.deleted_at IS NULL
        AND LOWER(TRIM(l.email)) IN (${normalizedSenderEmail}, ${senderEmail})
        AND (om.rfc_message_id = ${cleanParentMessageId} OR om.rfc_message_id = ${inReplyTo})
      LIMIT 2
    `);
    if (outreachExact.rows.length > 1) return null;
    if (outreachExact.rows.length > 0) return outreachExact.rows[0];
  }

  return null;
}

// ─── User / Lead Resolution ─────────────────────────────────────────────────────

/**
 * Resolve the user ID from recipient inbox emails.
 * Tries: user email → configured email senders → Resend domain ownership.
 */
export async function resolveUserId(recipientEmails: string[]): Promise<number | undefined> {
  if (!recipientEmails.length) return undefined;

  const emails = [...new Set(recipientEmails.map(extractEmailAddress).filter(isLikelyEmail))];
  if (!emails.length) return undefined;
  const domains = emails.map((e) => e.split('@')[1]).filter(Boolean);

  // Gather every authorized inbox owner before choosing. Neither a To/Cc
  // ordering choice nor a shared configured address may select a tenant.
  const emailConditions = emails.map((e) => sql`LOWER(email) = ${e}`);
  const senderConditions = emails.map((e) => sql`LOWER(TRIM(email)) = ${e}`);
  const domainConditions = domains.map((d) => sql`LOWER(name) = ${d}`);
  const gmailConditions = emails.map((e) => sql`LOWER(account_identifier) = ${e}`);
  const candidates = await db.execute(sql`
    SELECT DISTINCT id FROM (
      SELECT id FROM users WHERE (${sql.join(emailConditions, sql` OR `)})
      UNION ALL SELECT user_id AS id FROM email_senders
        WHERE (${sql.join(senderConditions, sql` OR `)}) AND is_verified IS TRUE
      UNION ALL SELECT user_id AS id FROM resend_domains
        WHERE (${sql.join(domainConditions, sql` OR `)}) AND status = 'verified'
      UNION ALL SELECT user_id AS id FROM channel_credentials
        WHERE platform = 'gmail_api' AND is_active IS TRUE AND (${sql.join(gmailConditions, sql` OR `)})
    ) receiving_tenants
    LIMIT 2
  `);
  if (candidates.rows.length !== 1) return undefined;
  return Number((candidates.rows[0] as { id: number }).id) || undefined;
}

/**
 * Find or create a lead for the given sender email under the specified user.
 */
async function resolveLeadId(
  userId: number,
  senderEmail: string,
  normalizedSenderEmail: string,
  senderDisplayName?: string,
): Promise<{ leadId: number; leadName: string; isNew: boolean }> {
  const leadMatches = await db.execute(sql`
    SELECT id, name, full_name, first_name, last_name FROM leads
    WHERE user_id = ${userId}
      AND (LOWER(TRIM(email)) = ${normalizedSenderEmail} OR LOWER(TRIM(email)) = ${senderEmail})
    LIMIT 1
  `);

  if (leadMatches.rows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = leadMatches.rows[0] as any;
    const leadName = lead.full_name || lead.name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || '';
    return { leadId: lead.id, leadName, isNew: false };
  }

  // Create new lead
  const emailLocalPart = senderEmail.includes('@') ? senderEmail.split('@')[0] : senderEmail;
  let safeLeadName = senderDisplayName || emailLocalPart || 'Unknown';
  if (safeLeadName.toLowerCase() === 'unknown' && emailLocalPart) {
    safeLeadName = emailLocalPart;
  }

  const leadUuid = crypto.randomUUID();
  const insertedLead = await db.execute(sql`
    INSERT INTO leads (uuid, user_id, email, name, status, source, platform_type, lead_type, created_at, updated_at)
    VALUES (${leadUuid}, ${userId}, ${senderEmail}, ${safeLeadName}, 'new', 'inbound_email', 'email', 'profile', NOW(), NOW())
    RETURNING id, name
  `);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newLead = insertedLead.rows[0] as any;
  return { leadId: newLead.id, leadName: newLead.name, isNew: true };
}

// ─── Duplicate Guard ────────────────────────────────────────────────────────────

/** Resume only the local ticket projection for a previously persisted email.
 * Never replay AI work, confirmations, or provider sends from a duplicate event.
 * Pre-receipt legacy messages are intentionally not copied: their earlier
 * support side effects cannot be distinguished safely from a partial run. */
export async function recoverPersistedEmailTicketRouting(
  userId: number,
  externalId: string,
  provider: InboundEmailProvider,
  logPrefix: string,
): Promise<'ignored' | 'routed' | 'unmatched' | 'blocked'> {
  try {
    const result = await db.execute(sql`
      SELECT message.id, message.conversation_id, conversation.lead_id,
        COALESCE(message.redacted_content, message.content) AS content, message.metadata
      FROM outreach_messages message
      JOIN outreach_conversations conversation ON conversation.id = message.conversation_id
      WHERE message.user_id = ${userId} AND conversation.user_id = ${userId}
        AND message.direction = 'inbound' AND conversation.channel IN ('email', 'gmail')
        AND conversation.integration_provider = ${provider}
        AND (message.external_message_id = ${externalId} OR message.provider_message_id = ${externalId})
      LIMIT 2
    `);
    if (result.rows.length !== 1) return result.rows.length > 1 ? 'blocked' : 'ignored';
    const message = result.rows[0] as {
      id: number; conversation_id: number; lead_id: number; content: string;
      metadata?: Record<string, unknown>;
    };
    if (message.metadata?.supportTicketRoutingVersion !== 1 || message.metadata.supportTicketRouting
      || message.metadata.supportTicketRoutingCheck) return 'ignored';
    return await routeReplyToActiveTicket(userId, message.lead_id, message.conversation_id, message.id,
      // A crash could precede vault binding; do not assume stored content is safe.
      redactPiiWithStableTokens(message.content).redactedText, logPrefix, true);
  } catch (err) {
    logger.warn({ err, userId }, `${logPrefix} Deferred local ticket routing recovery`);
    throw err;
  }
}

// ─── Post-Processing (sequences, auto-reply, events) ────────────────────────────

/**
 * Pause follow-up sequences for a lead after a reply is received.
 */
async function pauseFollowUpSequences(userId: number, leadId: number, logPrefix: string): Promise<void> {
  // System 1: followup_sequences table
  try {
    await db.execute(sql`
      UPDATE followup_sequences
      SET completed = true, replied_at = NOW(), updated_at = NOW()
      WHERE lead_id = ${leadId}
        AND user_id = ${userId}
        AND completed = false
    `);
    logger.info({ leadId, userId }, `${logPrefix} Stopped follow-up sequences for lead (reply received)`);
  } catch (err) {
    logger.error({ err }, `${logPrefix} Failed to stop follow-up sequences`);
  }

  try {
    await db.execute(sql`
      UPDATE sequence_executions
      SET status = 'paused', updated_at = NOW()
      WHERE lead_id = ${leadId}
        AND status = 'active'
    `);
  } catch (err) {
    logger.warn({ err }, `${logPrefix} Failed to pause sequence executions`);
  }

  // System 2: cron-based follow-ups via sent_messages.follow_up_step
  // Mark all seed messages for this lead as fully followed-up so the cron
  // query (which checks `nextStepIndex < enabledSteps.length`) will skip them.
  // Setting follow_up_step to 9999 ensures it always exceeds the configured max steps.
  try {
    const result = await db.execute(sql`
      UPDATE sent_messages
      SET follow_up_step = 9999, updated_at = NOW()
      WHERE lead_id = ${leadId}
        AND user_id = ${userId}
        AND is_reply = false
        AND channel IN ('email', 'gmail', 'resend')
        AND (follow_up_step IS NULL OR follow_up_step < 9999)
    `);
    logger.info({ leadId, userId, rowsUpdated: result.rowCount }, `${logPrefix} Marked seed messages as fully followed-up (cron system)`);
  } catch (err) {
    logger.warn({ err }, `${logPrefix} Failed to mark seed messages for cron follow-up stop`);
  }
}

/**
 * Run auto-reply with sentiment analysis on an inbound email.
 */
async function processAutoReply(
  userId: number,
  leadId: number,
  conversationId: number,
  subject: string,
  emailBody: string,
  bestLeadName: string,
  company: string,
  senderEmail: string,
  logPrefix: string,
  threadingContext?: { inReplyTo?: string; references?: string },
  recipientEmail?: string,
  runtimeIdentity?: {
    sentMessageId: number;
    outreachMessageId: number;
    providerMessageId: string;
    privacyVaultId: number | null;
    piiTypes: string[];
    piiTokenCount: number;
  },
): Promise<void> {
  try {
    // Skip auto-reply if there's an active support chat session for this lead's open ticket
    try {
      const activeSessionResult = await db.execute(sql`
        SELECT scs.id FROM support_chat_sessions scs
        JOIN support_tickets st ON scs.ticket_id = st.id
        WHERE st.user_id = ${userId}
          AND st.lead_id = ${leadId}
          AND st.status IN ('open', 'in_progress')
          AND scs.ticket_id IS NOT NULL
        LIMIT 1
      `);
      if (activeSessionResult.rows.length > 0) {
        logger.info({ userId, leadId }, `${logPrefix} Skipping auto-reply — active support chat session exists for this lead`);
        return;
      }
    } catch (sessionCheckErr) {
      logger.error({ err: sessionCheckErr }, `${logPrefix} Failed to verify support-chat ownership — suppressing auto-reply`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { emailReplyService } = await import('./EmailReplyService');

    const newMsgId = runtimeIdentity?.sentMessageId;
    if (!newMsgId || !runtimeIdentity?.outreachMessageId) {
      logger.error({ userId, leadId }, `${logPrefix} Exact inbound message identity is missing — suppressing auto-reply`);
      return;
    }

    // The canonical gateway supplies sentiment from the same context-aware NLU
    // decision as routing. Do not classify a second time before the pipeline.
    let sentimentResult = { sentiment: 'neutral', score: 0, keywords: [] as string[] };

    // Generate AI reply via the Agent Router
    let replyText: string | null = null;
    let agentDecision: AgentResult | null = null;
    let decisionOutcome: 'auto_sent' | 'drafted' | 'ready_for_channel_delivery' | 'pending_approval' | 'human_handoff' | 'blocked' | 'no_op' | 'error' = 'error';
    try {
      const { agentRouter } = await import('./agents/AgentRouter.js');
      const result = await agentRouter.handle({
        userId,
        conversationId,
        channel: 'email',
        phoneNumberId: null,
        inboundText: emailBody,
        leadId: leadId ?? null,
        leadName: bestLeadName
          ? redactPiiWithStableTokens(`My name is ${bestLeadName}`).redactedText.replace(/^My name is\s+/i, '')
          : null,
        leadCompany: company ? redactPiiWithStableTokens(company).redactedText : null,
        recipientPhone: senderEmail ? redactPiiWithStableTokens(senderEmail).redactedText : null,
        sentiment: sentimentResult,
        rawMessageId: runtimeIdentity.providerMessageId || threadingContext?.inReplyTo || null,
        messageId: runtimeIdentity.outreachMessageId,
        metadata: {
          verifiedReceivingAccountId: recipientEmail ? extractEmailAddress(recipientEmail) : undefined,
          privacyPreprotected: {
            vaultId: runtimeIdentity.privacyVaultId,
            piiTypes: runtimeIdentity.piiTypes,
            tokenCount: runtimeIdentity.piiTokenCount,
          },
        },
      });
      if (result) {
        agentDecision = result;
        if (result.classifiedSentiment) sentimentResult = result.classifiedSentiment;
        replyText = result.replyText;
        decisionOutcome = result.deliveryOutcome || 'error';
      }
    } catch (agentErr) {
      logger.error({ err: agentErr }, `${logPrefix} Agent routing failed`);
    }

    if (agentDecision?.classifiedSentiment) {
      await db.execute(sql`
        UPDATE sent_messages
        SET sentiment = ${sentimentResult.sentiment},
            sentiment_confidence = ${sentimentResult.score},
            sentiment_analysis = ${JSON.stringify(sentimentResult)}::jsonb,
            updated_at = NOW()
        WHERE id = ${newMsgId} AND user_id = ${userId}
      `);
      await db.execute(sql`
        UPDATE outreach_messages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          sentiment: sentimentResult.sentiment, sentimentScore: sentimentResult.score,
          sentimentKeywords: sentimentResult.keywords,
        })}::jsonb, updated_at = NOW()
        WHERE id = ${runtimeIdentity.outreachMessageId} AND user_id = ${userId}
      `);
    }

    // The canonical runtime owns the send/no-send decision. A classifier or
    // generation failure must never become an automatic fallback response.
    if (!replyText) return;

    const isNegativeSentiment = sentimentResult.sentiment === 'negative' && sentimentResult.score < -0.5;
    // An autoresponder answering every reply would keep both sides talking
    // forever. Once it has answered our automatic replies within seconds twice,
    // a person reviews the next one.
    const replyLoop = await autoReplyLoopDetected(userId, conversationId).catch((loopErr) => {
      logger.error({ err: loopErr, conversationId }, `${logPrefix} Reply-loop check failed — holding reply for review`);
      return true;
    });
    if (replyLoop) logger.warn({ userId, conversationId }, `${logPrefix} Automatic reply loop detected — saving reply as a draft`);
    const autoReplyAllowed = !replyLoop && decisionOutcome === 'ready_for_channel_delivery'
      && (agentDecision?.provenance?.assistantAway === true || agentDecision?.optOutApplied === true
        || agentDecision?.handoffDeclineAcknowledged === true || (Boolean(agentDecision?.classifiedSentiment) && !isNegativeSentiment));

    if (autoReplyAllowed) {
      const offeredChoice = validatedHandoffChoice(agentDecision?.choiceManifest);
      const handoffChoice = offeredChoice && matchesHandoffOfferReply(replyText, offeredChoice) ? offeredChoice : null;
      // Save it to sent_messages smart_reply
      await db.execute(sql`
        UPDATE sent_messages
        SET smart_reply = ${replyText},
            smart_reply_approved = false,
            smart_reply_assistant = ${JSON.stringify(agentDecision?.deferredEffectContext?.assistantProvenance
              ? {...agentDecision.deferredEffectContext.assistantProvenance,conversationId} : null)}::jsonb,
            reply_context = COALESCE(reply_context, '{}'::jsonb) || ${JSON.stringify({handoffChoice})}::jsonb,
            smart_reply_generated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${newMsgId}
          AND user_id = ${userId}
      `);

      const { emailReplyService } = await import('./EmailReplyService.js');
      const sendResult = await withPublishedAssistant(agentDecision?.deferredEffectContext?.assistantProvenance,async()=>{
        if (agentDecision?.provenance?.assistantAway) markAssistantDelivery({assistantAway:true,assistantAwayReceipt:agentDecision.provenance.assistantAwayReceipt});
        return emailReplyService.sendSmartReply(newMsgId, undefined, userId, agentDecision?.verifiedMedia || []);
      });
      if (sendResult.success) {
        if (agentDecision) {
          agentDecision.mediaDeliverySucceeded = !agentDecision.mediaDeliveryAssertionRequired || Number(sendResult.mediaSent || 0) > 0;
          const { agentRouter } = await import('./agents/AgentRouter.js');
          await agentRouter.commitDeferredDelivery(agentDecision);
        }
        logger.info({ leadId, userId }, `${logPrefix} Auto-sent smart reply (sentiment safe)`);
      } else {
        logger.warn({ leadId, error: sendResult.error }, `${logPrefix} Auto-send failed, reply saved as draft`);
      }
    } else {
      // Negative sentiment: Save AI reply as draft in outreach_messages and notify user
      try {
        // Delete existing automatic drafts to avoid clutter
        const existingDrafts = await db.execute(sql`
          SELECT id FROM outreach_messages
          WHERE conversation_id = ${conversationId}
            AND user_id = ${userId}
            AND direction = 'outbound'
            AND status = 'draft'
            AND is_automatic = true
          ORDER BY created_at DESC
        `);

        if (existingDrafts.rows.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const existingDraftIds = existingDrafts.rows.map((r: any) => r.id);
          await db.execute(sql`
            DELETE FROM outreach_messages
            WHERE id = ANY(${existingDraftIds})
              AND user_id = ${userId}
          `);
        }

        const smartReplyText = replyText.trim();
        const looksLikeHtml = /<[^>]+>/.test(smartReplyText);
        const draftPlainText = smartReplyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        await OutreachConversationModel.createOutreachMessage({
          conversationId,
          userId,
          direction: 'outbound',
          subject: subject ? `Re: ${subject}` : 'Re: Follow-up',
          content: draftPlainText || 'Please review this reply before sending.',
          htmlContent: looksLikeHtml ? smartReplyText : undefined,
          status: 'draft',
          isAutomatic: true,
          isAiGenerated: true,
          isRead: true,
        });

        // Update sent_messages with draft content for visibility
        await db.execute(sql`
          UPDATE sent_messages
          SET smart_reply = ${smartReplyText},
              smart_reply_approved = false,
              smart_reply_generated_at = NOW(),
              updated_at = NOW()
          WHERE id = ${newMsgId}
            AND user_id = ${userId}
        `);

        logger.info(
          { leadId, userId, conversationId },
          `${logPrefix} Negative sentiment detected - smart reply saved as draft (manual review required)`,
        );

        // Send draft review notification to admin
        try {
          const { sendAdminEmail } = await import('./adminEmailService.js');
          const userRow = await db.execute(sql`SELECT email, COALESCE(name, 'there') AS name FROM users WHERE id = ${userId} LIMIT 1`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const userEmail = (userRow.rows as any)?.[0]?.email;
          if (userEmail) {
            const escSubject = (subject || 'Inbound Reply').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#x27;' }[c] as string));
            const escFrom = String(senderEmail || 'a contact').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#x27;' }[c] as string));
            await sendAdminEmail({
              to: userEmail,
              subject: `⚠️ Reply needs your review: ${escSubject}`,
              html: `<p>A draft reply is waiting for your review in the Conversations Inbox because the inbound email from <strong>${escFrom}</strong> was flagged as negative sentiment.</p>
                     <p>Go to your Inbox to approve, edit, or send the draft.</p>
                     <p style="color:#64748b;font-size:12px;">Sentiment: ${sentimentResult.sentiment} (Score: ${sentimentResult.score})</p>`,
            });
          }
        } catch (notifyErr) {
          logger.warn({ err: notifyErr, leadId, userId }, `${logPrefix} Failed to send draft-review notification (non-blocking)`);
        }
      } catch (draftErr) {
        logger.warn({ err: draftErr, leadId, conversationId }, `${logPrefix} Failed to create outreach draft message (non-blocking)`);
      }
    }

    // Publish sentiment analysis event
    eventBus.publish({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: 'events:email:sentiment' as any,
      userId,
      timestamp: new Date().toISOString(),
      data: {
        type: 'email.sentiment_analyzed',
        leadId,
        messageId: newMsgId,
        sentiment: sentimentResult.sentiment,
        criticalityLevel: sentimentResult.sentiment === 'negative' ? 'high' : 'normal',
        autoReplyAllowed,
        smartReplyGenerated: !!replyText,
        autoReplySent: autoReplyAllowed,
      },
    }).catch(() => {});
  } catch (err) {
    logger.error({ err, leadId }, `${logPrefix} Auto-reply generation failed (non-blocking)`);
  }
}

// ─── Route Replies to Active Support Tickets ────────────────────────────────────

/**
 * If this lead has an active support ticket, save the inbound reply as a message
 * on the ticket so it appears in the support panel as well.
 */
export async function routeReplyToActiveTicket(
  userId: number,
  leadId: number,
  conversationId: number,
  inboundMessageId: number,
  emailBody: string,
  logPrefix: string,
  recoveryOnly = false,
  database?: typeof db,
): Promise<'routed' | 'unmatched' | 'blocked'> {
  try {
    const run = async (tx: typeof db): Promise<'routed' | 'unmatched' | 'blocked'> => {
      // The durable inbound row is the receipt and lock: provider replays and
      // the confirmation path must not copy this message or bump counters twice.
      const messageResult = await tx.execute(sql`
        SELECT message.id, message.metadata
        FROM outreach_messages message
        JOIN outreach_conversations conversation ON conversation.id = message.conversation_id
        WHERE message.id = ${inboundMessageId} AND message.user_id = ${userId}
          AND message.conversation_id = ${conversationId} AND message.direction = 'inbound'
          AND conversation.user_id = ${userId} AND conversation.lead_id = ${leadId}
        FOR UPDATE OF message
      `);
      const message = messageResult.rows[0] as { metadata?: Record<string, unknown> } | undefined;
      if (!message) return 'blocked';
      // Even if the original ticket has since closed or been deleted, an
      // already-routed message cannot be reassigned to a different ticket.
      if (message.metadata?.supportTicketRouting) return 'routed';
      if (recoveryOnly && message.metadata?.supportTicketRoutingCheck) return 'unmatched';
      if (recoveryOnly && message.metadata?.supportTicketRoutingVersion !== 1) return 'blocked';

      const exact = await tx.execute(sql`
        SELECT id, ticket_number FROM support_tickets
        WHERE user_id = ${userId} AND outreach_conversation_id = ${conversationId}
          AND deleted_at IS NULL AND status IN ('open', 'in_progress', 'waiting_on_customer')
        ORDER BY id LIMIT 2 FOR UPDATE
      `);
      // Multiple tickets on one thread need an explicit binding, not newest-wins.
      if (exact.rows.length > 1) {
        logger.warn({ userId, conversationId }, `${logPrefix} Ambiguous conversation ticket binding requires support review`);
        return 'blocked';
      }
      const ticket = exact.rows[0] as { id: number; ticket_number: string } | undefined;
      if (!ticket) {
          // Record that routing was evaluated before AI/provider work begins.
          // A later duplicate must not attach this historical email to a ticket
          // that did not exist when the email was originally processed.
          await tx.execute(sql`
            UPDATE outreach_messages
            SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"supportTicketRoutingCheck":{"status":"unmatched"}}'::jsonb,
                updated_at = NOW()
            WHERE id = ${inboundMessageId} AND user_id = ${userId} AND conversation_id = ${conversationId}
          `);
          return 'unmatched';
      }
      const inserted = await tx.execute(sql`
        INSERT INTO support_ticket_messages (ticket_id, user_id, direction, content, is_internal, created_at)
        VALUES (${ticket.id}, ${userId}, 'inbound', ${emailBody}, false, NOW())
        RETURNING id
      `);
      const ticketMessageId = Number((inserted.rows[0] as { id?: number } | undefined)?.id);
      if (!ticketMessageId) throw new Error('Support ticket message was not persisted.');
      await tx.execute(sql`
        UPDATE support_tickets
        SET total_messages = COALESCE(total_messages, 0) + 1,
            unread_count = COALESCE(unread_count, 0) + 1,
            status = CASE WHEN status = 'waiting_on_customer' THEN 'in_progress' ELSE status END,
            updated_at = NOW()
        WHERE id = ${ticket.id} AND user_id = ${userId}
      `);
      await tx.execute(sql`
        UPDATE outreach_messages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          supportTicketRouting: { ticketId: ticket.id, ticketMessageId, conversationId, inboundMessageId },
        })}::jsonb, updated_at = NOW()
        WHERE id = ${inboundMessageId} AND user_id = ${userId} AND conversation_id = ${conversationId}
      `);
      logger.info({ leadId, conversationId, ticketId: ticket.id }, `${logPrefix} Routed inbound email reply to support ticket`);
      return 'routed';
    };
    return database ? await run(database) : await db.transaction(run);
  } catch (err) {
    logger.warn({ err, leadId }, `${logPrefix} Failed to route reply to active ticket; provider retry required`);
    throw err;
  }
}

const GMAIL_PROMO_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'SPAM',
  'TRASH',
]);

/** Sender address prefixes that indicate automated / no-reply senders */
const NO_REPLY_PREFIXES = [
  'no-reply', 'noreply', 'do-not-reply', 'donotreply',
  'mailer-daemon', 'postmaster', 'bounce', 'bounces',
  'newsletter', 'newsletters', 'notifications', 'notify',
  'auto', 'automated', 'system', 'daemon', 'newsmail',
  'unsubscribe', 'security-noreply', 'accounts-noreply',
];

/** No-reply markers that also appear inside longer local parts, such as
 * `billing_no_reply@` or `reg-noreply@`. */
const NO_REPLY_FRAGMENT = /(?:^|[._+-])(?:no[._-]?reply|do[._-]?not[._-]?reply)(?:$|[._+-])/;

/** True when the address' local part marks an automated, unmonitored sender. */
export function isNoReplyAddress(address: string): boolean {
  const localPart = (extractEmailAddress(address).split('@')[0] || '').toLowerCase();
  if (!localPart) return false;
  return NO_REPLY_PREFIXES.some((prefix) => localPart === prefix || localPart.startsWith(`${prefix}+`))
    || NO_REPLY_FRAGMENT.test(localPart);
}

/**
 * Returns true if the email appears to be spam, promotional, or automated — and should
 * NOT create a new outreach conversation. Only called for first emails (no In-Reply-To).
 */
function isSpamOrPromotional(data: InboundEmailData): boolean {
  // 1. Gmail category labels (most reliable)
  if (data.gmailLabelIds && data.gmailLabelIds.some((l) => GMAIL_PROMO_LABELS.has(l))) {
    return true;
  }

  // 2. Standard RFC headers
  const h = data.rawHeaders || {};
  // Auto-Submitted: auto-replied | auto-generated | auto-notified → automated response
  const autoSubmitted = (h['auto-submitted'] || '').toLowerCase().trim();
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  // Precedence: bulk | list | junk → mass mailing
  const precedence = (h['precedence'] || '').toLowerCase().trim();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;

  // List-Unsubscribe header → newsletter / marketing email
  if (h['list-unsubscribe'] || h['list-id']) return true;

  // X-Auto-Response-Suppress → Office auto-replies that say "don't reply to this"
  if (h['x-auto-response-suppress']) return true;

  // 3. Sender email pattern check
  return isNoReplyAddress(data.senderEmail);
}

/** Transport/calendar evidence takes precedence over lead membership and threading. */
export function automatedEmailSuppressionReason(data: InboundEmailData): string | null {
  const headers = Object.fromEntries(Object.entries(data.rawHeaders || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const submitted = (headers['auto-submitted'] || '').split(';')[0].trim().toLowerCase();
  if (submitted && submitted !== 'no') return 'automated_email';
  if (headers['x-auto-response-suppress'] || headers['x-autoreply'] || headers['x-autorespond']) return 'automated_email';
  if (data.containsCalendarEvent || /text\/calendar|application\/ics/i.test(headers['content-type'] || '')
    || /calendarmessage/i.test(headers['content-class'] || '')
    || data.attachments?.some((attachment) => /text\/calendar|application\/ics/i.test(attachment.contentType)
      || /\.ics$/i.test(attachment.filename))
    || /BEGIN:VCALENDAR/i.test(data.body || '')
    || /^(?:calendar-notification|calendar-server|calendar)@/i.test(extractEmailAddress(data.senderEmail))
    || /^(?:cancell?ed|declined|invitation cancell?ed):/i.test(data.subject.trim())) return 'calendar_notification';
  if (data.gmailLabelIds?.some((label) => ['SPAM','TRASH'].includes(label))) return 'spam_or_trash';
  if (isNoReplyAddress(data.senderEmail)) return 'automated_email';
  return null;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────────

/** Commit both inbox representations and their counters together. Legacy
 * sent-only receipts can be completed from the verified provider retry without
 * guessing whether their engagement counter already ran. */
export async function persistInboundEmailRecords(input: {
  userId: number; leadId: number; conversationId: number; provider: InboundEmailProvider;
  externalId: string; body: string; subject: string; leadName: string;
  campaignId?: number | null; senderId?: number | null; gmailThreadId?: string;
  replyContext?: EmailReplyContext;
  rfcMessageId?: string;
}) {
  if (!input.externalId.trim()) throw new Error('Inbound email requires a stable provider message ID.');
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inbound-email:${input.userId}:${input.provider}:${input.externalId}`}, 0))`);
    const authorized = await tx.execute(sql`
      SELECT conversation.id FROM outreach_conversations conversation
      JOIN leads lead ON lead.id = conversation.lead_id AND lead.user_id = conversation.user_id
      WHERE conversation.id = ${input.conversationId} AND conversation.user_id = ${input.userId}
        AND conversation.lead_id = ${input.leadId} AND conversation.channel IN ('email', 'gmail')
        AND lead.deleted_at IS NULL
      FOR UPDATE OF conversation
    `);
    if (!authorized.rows[0]) throw new Error('Inbound email conversation does not match the authorized lead.');
    const native = await tx.execute(sql`
      SELECT message.id, message.conversation_id, message.metadata
      FROM outreach_messages message
      JOIN outreach_conversations conversation ON conversation.id = message.conversation_id
      WHERE message.user_id = ${input.userId} AND conversation.user_id = ${input.userId}
        AND conversation.integration_provider = ${input.provider} AND message.direction = 'inbound'
        AND (message.external_message_id = ${input.externalId} OR message.provider_message_id = ${input.externalId})
      LIMIT 2
    `);
    if (native.rows.length > 1) throw new Error('Inbound provider identity has multiple saved messages.');
    const savedNative = native.rows[0] as { id: number; conversation_id: number; metadata?: Record<string, unknown> } | undefined;
    if (savedNative && Number(savedNative.conversation_id) !== input.conversationId) {
      throw new Error('Inbound provider identity is already bound to another conversation.');
    }
    const prior = await tx.execute(sql`
      SELECT id, lead_id FROM sent_messages
      WHERE user_id = ${input.userId} AND channel IN ('email', 'gmail') AND is_reply IS TRUE
        AND (message_id = ${input.externalId} OR reply_message_id = ${input.externalId})
      ORDER BY id LIMIT 2 FOR UPDATE
    `);
    if (prior.rows.length > 1) throw new Error('Inbound email has ambiguous legacy receipts.');
    const savedSent = prior.rows[0] as { id: number; lead_id: number } | undefined;
    if (savedSent && Number(savedSent.lead_id) !== input.leadId) throw new Error('Inbound legacy receipt belongs to another lead.');
    let exactSentMessageId = Number(savedSent?.id || 0);
    if (!exactSentMessageId) {
      const inserted = await tx.execute(sql`
        INSERT INTO sent_messages (user_id, lead_id, lead_name, campaign_id, channel, subject, message,
          status, is_reply, message_id, reply_message_id, reply_content, reply_received_at, sender_id,
          gmail_thread_id, reply_context, sent_at, created_at, updated_at)
        VALUES (${input.userId}, ${input.leadId}, ${input.leadName}, ${input.campaignId || null},
          ${input.provider === 'gmail' ? 'gmail' : 'email'}, ${input.subject}, ${input.body},
          'received', true, ${input.externalId}, ${input.externalId}, ${input.body}, NOW(),
          ${input.senderId || null}, ${input.gmailThreadId || null},
          ${input.replyContext ? JSON.stringify(input.replyContext) : null}::jsonb, NOW(), NOW(), NOW()) RETURNING id
      `);
      exactSentMessageId = Number((inserted.rows[0] as { id?: number } | undefined)?.id || 0);
      if (!exactSentMessageId) throw new Error('Inbound email legacy receipt was not persisted.');
    }
    if (savedNative) return {
      inboundMsg: { id: savedNative.id }, exactSentMessageId, duplicate: true, recovered: false,
      recordCrmReply: Boolean(savedNative.metadata?.inboundEmailReceipt),
    };
    const metadata = { supportTicketRoutingVersion: 1, inboundEmailReceipt: { version: 1, sentMessageId: exactSentMessageId },
      ...(input.replyContext ? { emailReplyContext: input.replyContext } : {}) };
    const inserted = await tx.execute(sql`
      INSERT INTO outreach_messages (conversation_id, user_id, direction, content, subject, status,
        external_message_id, provider_message_id, rfc_message_id, sent_at, is_read, message_kind, metadata, campaign_id, created_at, updated_at)
      VALUES (${input.conversationId}, ${input.userId}, 'inbound', ${input.body}, ${input.subject}, 'delivered',
        ${input.externalId}, ${input.externalId},
        ${[input.rfcMessageId, input.externalId].find(id => id && /^<[^<>@\s]+@[^<>\s]+>$/.test(id)) || null},
        NOW(), false, 'reply', ${JSON.stringify(metadata)}::jsonb, ${input.campaignId || null}, NOW(), NOW()) RETURNING id
    `);
    const messageId = Number((inserted.rows[0] as { id?: number } | undefined)?.id || 0);
    if (!messageId) throw new Error('Inbound native message was not persisted.');
    await tx.execute(sql`
      UPDATE outreach_conversations SET total_messages = COALESCE(total_messages, 0) + 1,
        unread_count = COALESCE(unread_count, 0) + 1, status = 'replied', last_message_at = NOW(),
        last_message_by = 'lead', last_message_preview = ${input.body.slice(0, 200)}, updated_at = NOW()
      WHERE id = ${input.conversationId} AND user_id = ${input.userId}
    `);
    // A legacy receipt may have committed its counter before the old process
    // crashed. Preserve it instead of risking a double increment on repair.
    if (!savedSent) await tx.execute(sql`
      UPDATE leads SET replied_emails = COALESCE(replied_emails, 0) + 1,
        status = CASE WHEN status IN ('new', 'contacted') THEN 'replied' ELSE status END,
        lead_status = CASE WHEN COALESCE(lead_status, 'new') IN ('new', 'contacted') THEN 'replied' ELSE lead_status END,
        last_activity_at = NOW(), updated_at = NOW()
      WHERE id = ${input.leadId} AND user_id = ${input.userId}
    `);
    return {
      inboundMsg: { id: messageId }, exactSentMessageId, duplicate: Boolean(savedSent),
      recovered: Boolean(savedSent), recordCrmReply: true,
    };
  });
}

/**
 * Process an inbound email from any provider.
 * This is the single entry point for all inbound email processing:
 * - Thread matching (find original outbound message)
 * - User / lead resolution
 * - Recording the reply in sent_messages
 * - Creating/updating outreach conversations
 * - Pausing follow-up sequences
 * - Auto-reply with sentiment analysis
 * - Publishing real-time events
 */
export async function processInboundEmail(data: InboundEmailData): Promise<InboundEmailResult> {
  const logPrefix = `[InboundEmail:${data.provider}]`;

  const senderEmail = data.senderEmail.toLowerCase().trim();
  const senderDisplayName = data.senderDisplayName || '';
  const normalizedSenderEmail = normalizeEmailForMatch(senderEmail);
  const recipientEmails = data.recipientEmails || [];

  if (!isLikelyEmail(senderEmail)) {
    logger.warn(`${logPrefix} Invalid sender email`);
    return { success: false, error: 'Invalid sender email' };
  }
  if (data.receivingUserId !== undefined && (data.provider !== 'gmail'
    || !Number.isSafeInteger(data.receivingUserId) || data.receivingUserId <= 0)) {
    return { success: false, error: 'Invalid authenticated receiving mailbox.' };
  }
  const receivingUserId = data.receivingUserId ?? await resolveUserId(recipientEmails);
  if (!receivingUserId) return { success: false, error: 'Could not resolve an unambiguous receiving inbox.' };

  const suppressionReason = automatedEmailSuppressionReason(data);
  if (suppressionReason) {
    logger.info({ userId: receivingUserId, reason: suppressionReason }, `${logPrefix} Automated/calendar email excluded from reply automation`);
    return { success: true, skipped: true, skipReason: suppressionReason };
  }

  // 1. Provider event identity is checked after the tenant is resolved below.
  const externalId = data.externalMessageId.trim();

  // 2. Thread matching
  const inReplyTo = data.inReplyTo || '';
  const originalMessage = await findOriginalMessage(
    receivingUserId,
    inReplyTo,
    senderEmail,
    normalizedSenderEmail,
  );

  // 2b. Spam / promotional filter — applies ONLY to fresh emails (no In-Reply-To header).
  // If this email is a threaded reply to an existing outreach, always process it.
  const isThreadedReply = !!(inReplyTo.trim() || originalMessage);
  if (!isThreadedReply && isSpamOrPromotional(data)) {
    logger.info(
      { gmailLabels: data.gmailLabelIds },
      `${logPrefix} Skipping non-customer email (spam/promotional/automated)`,
    );
    return { success: true, skipped: true, skipReason: 'spam_or_promotional' };
  }

  // 3. Resolve user & lead
  let resolvedUserId: number | undefined;
  let resolvedLeadId: number | undefined;
  let leadName = '';
  let campaignId: number | null = null;
  let company = '';
  let conversationIdFromMatch: number | null = null;

  if (originalMessage) {
    resolvedUserId = receivingUserId;
    resolvedLeadId = originalMessage.lead_id;
    leadName = originalMessage.lead_name || '';
    campaignId = originalMessage.campaign_id || null;
    company = originalMessage.company || '';
    conversationIdFromMatch = originalMessage.conversation_id || null;
  } else {
    logger.info(`${logPrefix} Email not threaded. Resolving user/lead.`);

    resolvedUserId = receivingUserId;

    if (!resolvedUserId) {
      logger.warn({ recipientEmails }, `${logPrefix} Unknown inbox address. Dropping orphan email.`);
      return { success: false, error: 'Could not resolve user from recipient addresses' };
    }

    const leadResult = await resolveLeadId(resolvedUserId, senderEmail, normalizedSenderEmail, senderDisplayName);
    resolvedLeadId = leadResult.leadId;
    leadName = leadResult.leadName;
  }

  const userId = resolvedUserId!;
  const leadId = resolvedLeadId!;
  const inboundChannel: string = data.provider === 'gmail' ? 'gmail' : 'email';
  if (!externalId) return { success: false, error: 'Inbound email requires a provider message ID.' };

  // 4. Compute best lead name
  const dbLeadName = leadName || '';
  const dbLeadNameIsWeak = !dbLeadName || dbLeadName.toLowerCase() === 'unknown' || isLikelyEmail(dbLeadName);
  const bestLeadName =
    senderDisplayName && !isLikelyEmail(senderDisplayName)
      ? senderDisplayName
      : !dbLeadNameIsWeak
        ? dbLeadName
        : senderEmail;

  // Update weak lead names
  if (dbLeadNameIsWeak && senderDisplayName && !isLikelyEmail(senderDisplayName)) {
    await db.execute(sql`
      UPDATE leads SET name = ${senderDisplayName}, updated_at = NOW()
      WHERE id = ${leadId}
        AND user_id = ${userId}
        AND (name IS NULL OR LOWER(name) = 'unknown' OR name ~ '^[^@]+@[^@]+\.[^@]+$')
    `);
    logger.info({ userId, leadId }, `${logPrefix} Updated weak lead name from inbound email`);
  }

  logger.info(
    { userId, leadId, provider: data.provider },
    `${logPrefix} Inbound email classified.`,
  );

  // 5. Record reply in sent_messages
  const rawEmailBody = data.body || `Reply from ${senderEmail}: ${data.subject}`;
  const rawLatestReply = extractLatestReplyContent(rawEmailBody);
  const inboundPrivacyPreview = redactPiiWithStableTokens(rawLatestReply);
  const emailBody = inboundPrivacyPreview.redactedText;
  const protectedSubject = redactPiiWithStableTokens(data.subject || 'Inbound Msg').redactedText;

  // inboundChannel was resolved before CRM contact creation so every
  // downstream write uses one provider classification.

  // Resolve the email_senders row that received this inbound email (for smart reply routing)
  let resolvedSenderId: number | null = null;
  let verifiedReceivingAccountId: string | null = null;
  if (data.recipientEmails && data.recipientEmails.length > 0) {
    try {
      const recipients=[...new Set(data.recipientEmails.map(extractEmailAddress))];
      const matches=await db.execute(sql`SELECT id,email FROM email_senders WHERE user_id=${userId} AND is_verified
        AND lower(email) IN (${sql.join(recipients.map(recipient => sql`${recipient}`), sql`, `)})
        AND type=${data.provider === 'gmail' ? 'gmail' : 'resend'} LIMIT 2`);
      if (matches.rows.length === 1) {
        resolvedSenderId=Number(matches.rows[0].id);
        verifiedReceivingAccountId=String(matches.rows[0].email).toLowerCase();
      }
    } catch (senderLookupErr) {
      logger.warn({ err: senderLookupErr, userId }, `${logPrefix} Could not verify the original receiving email account; automatic reply will remain blocked.`);
    }
  }

  // 7. Get or create outreach conversation
  const cleanParentMessageId = (data.inReplyTo || '').replace(/^<|>$/g, '').trim();
  const shouldStartNewConversation = !cleanParentMessageId;

  const providerThreadConversation = data.gmailThreadId
    ? await OutreachConversationModel.getConversationByProviderThread(
        userId,
        leadId,
        data.provider,
        data.gmailThreadId
      )
    : undefined;

  // A provider message is an exact retry key even without In-Reply-To. A
  // deterministic UUID avoids spawning empty duplicate threads before the
  // atomic message transaction gets its provider-identity lock.
  const threadDigest = crypto.createHash('sha256').update(`${userId}:${data.provider}:${externalId}`).digest('hex');
  const retryThreadKey = `${threadDigest.slice(0, 8)}-${threadDigest.slice(8, 12)}-4${threadDigest.slice(13, 16)}-8${threadDigest.slice(17, 20)}-${threadDigest.slice(20, 32)}`;
  const priorNative = await db.execute(sql`
    SELECT message.conversation_id
    FROM outreach_messages message
    JOIN outreach_conversations conversation ON conversation.id = message.conversation_id
    WHERE message.user_id = ${userId} AND conversation.user_id = ${userId}
      AND conversation.integration_provider = ${data.provider} AND message.direction = 'inbound'
      AND (message.external_message_id = ${externalId} OR message.provider_message_id = ${externalId})
    LIMIT 2
  `);
  if (priorNative.rows.length > 1) throw new Error('Inbound provider identity has multiple conversations.');
  const savedConversationId = Number((priorNative.rows[0] as { conversation_id?: number } | undefined)?.conversation_id || 0);
  const savedConversation = savedConversationId
    ? await OutreachConversationModel.getOutreachConversationById(savedConversationId)
    : undefined;
  const conversation = savedConversation || providerThreadConversation || (shouldStartNewConversation
    ? await OutreachConversationModel.getOrCreateConversation({
        userId,
        leadId,
        threadKey: retryThreadKey,
        channel: inboundChannel,
        status: 'replied',
        integrationProvider: data.provider,
        leadName: bestLeadName,
        leadEmail: senderEmail,
        leadCompany: company || null,
        externalThreadId: data.gmailThreadId || undefined,
      })
    : conversationIdFromMatch
      ? (await OutreachConversationModel.getOutreachConversationById(conversationIdFromMatch)) ||
        (await OutreachConversationModel.getOrCreateConversation({
          userId,
          leadId,
          threadKey: retryThreadKey,
          channel: inboundChannel,
          status: 'replied',
          integrationProvider: data.provider,
          leadName: bestLeadName,
          leadEmail: senderEmail,
          leadCompany: company || null,
          externalThreadId: data.gmailThreadId || undefined,
        }))
      : await OutreachConversationModel.getOrCreateConversation({
          userId,
          leadId,
          threadKey: retryThreadKey,
          channel: inboundChannel,
          status: 'replied',
          integrationProvider: data.provider,
          leadName: bestLeadName,
          leadEmail: senderEmail,
          leadCompany: company || null,
          externalThreadId: data.gmailThreadId || undefined,
        }));

  if (conversation.userId !== userId || conversation.leadId !== leadId) {
    throw new Error('Resolved email conversation is not owned by this contact.');
  }
  if (verifiedReceivingAccountId && (!conversation.providerAccountId || conversation.providerAccountId === verifiedReceivingAccountId
    || (data.provider === 'resend' && conversation.providerAccountId === verifiedReceivingAccountId.split('@')[1]))) {
    await OutreachConversationModel.updateOutreachConversation(conversation.id,{providerAccountId:verifiedReceivingAccountId});
  }
  // Backfill conversation denormalized fields if stale
  const convNameIsWeak =
    !conversation.leadName || conversation.leadName.toLowerCase() === 'unknown' || isLikelyEmail(conversation.leadName);
  if (convNameIsWeak || !conversation.leadEmail || !conversation.integrationProvider) {
    await OutreachConversationModel.updateOutreachConversation(conversation.id, {
      leadName: convNameIsWeak ? bestLeadName : conversation.leadName,
      leadEmail: conversation.leadEmail || senderEmail,
      leadCompany: conversation.leadCompany || company || null,
      integrationProvider: conversation.integrationProvider || data.provider,
      externalThreadId: conversation.externalThreadId || data.gmailThreadId || undefined,
    });
  }

  let threadCampaignContext: EmailReplyContext | null = null;
  let campaignContextUnresolved = false;
  try { threadCampaignContext = await conversationCampaignReplyContext(userId, conversation.id); }
  catch (error) {
    campaignContextUnresolved = true;
    logger.warn({ err: error, conversationId: conversation.id }, `${logPrefix} Campaign context unresolved; automatic reply suppressed`);
  }
  const parentContext = originalMessage?.reply_context as EmailReplyContext | undefined;
  if ((threadCampaignContext && (campaignId || parentContext?.campaignId)
      && threadCampaignContext.campaignId !== Number(parentContext?.campaignId || campaignId))
    || (originalMessage?.conversation_id && providerThreadConversation
      && Number(originalMessage.conversation_id) !== providerThreadConversation.id)) campaignContextUnresolved = true;
  // A contact or ordinary thread alone is not support authorization. A reviewed,
  // published assignment to this exact verified inbox is; campaign ownership wins.
  const supportProvenance = await db.execute(sql`SELECT m.id FROM outreach_messages m
    WHERE m.user_id=${userId} AND m.conversation_id=${conversation.id} AND m.direction='outbound'
      AND m.status IN ('sent','delivered','read') AND m.metadata->'assistant'->>'channel'='email' LIMIT 1`);
  const receivingSupportAssignment = !campaignContextUnresolved && !campaignId && !threadCampaignContext
    && parentContext?.kind !== 'campaign' && parentContext?.kind !== 'support' && supportProvenance.rows.length === 0
    && await hasPublishedReceivingEmailAssistant(userId, conversation.id, verifiedReceivingAccountId, resolvedSenderId);
  const replyContext: EmailReplyContext = {
    kind: campaignContextUnresolved ? 'unresolved' : campaignId || parentContext?.kind === 'campaign' || threadCampaignContext ? 'campaign'
      : parentContext?.kind === 'support' || supportProvenance.rows.length === 1 || receivingSupportAssignment ? 'support' : 'unresolved',
    conversationId: conversation.id,
    ...(threadCampaignContext || {}),
    ...(parentContext?.kind === 'campaign' ? { campaignId: parentContext.campaignId, source: parentContext.source } :
      campaignId && !originalMessage.is_reply ? { campaignId, source: { table: originalMessage.match_source, id: Number(originalMessage.id) } } : {}),
    senderId: resolvedSenderId || undefined, accountId: verifiedReceivingAccountId || undefined,
    recipientEmail: senderEmail,
  };
  if (campaignContextUnresolved) replyContext.kind = 'unresolved';
  if (replyContext.campaignId) campaignId = replyContext.campaignId;
  // Native message, delivery receipt, conversation counters, and fresh lead
  // engagement either all commit or all roll back.
  const persisted = await persistInboundEmailRecords({
    userId, leadId, conversationId: conversation.id, provider: data.provider,
    externalId, body: emailBody, subject: protectedSubject || 'Inbound message',
    leadName: bestLeadName, campaignId, senderId: resolvedSenderId, gmailThreadId: data.gmailThreadId, replyContext,
    rfcMessageId: data.rawHeaders?.['message-id'],
  });
  const { inboundMsg, exactSentMessageId } = persisted;

  const protectedInbound = await privacyVaultService.protectInbound({
    userId,
    conversationId: conversation.id,
    channel: 'email',
    rawText: rawLatestReply,
    providerMessageId: data.externalMessageId,
    messageId: inboundMsg.id,
    sentMessageId: exactSentMessageId,
    entityType: 'outreach_message',
    entityId: inboundMsg.id,
  });
  const { inboundContactResolver } = await import('./InboundContactResolver.js');
  await inboundContactResolver.reconcile({
    userId,
    conversationId: conversation.id,
    channel: inboundChannel,
    externalIdentifier: senderEmail,
    displayName: senderDisplayName || undefined,
    source: data.provider,
    trust: 'provider',
    recordReply: persisted.recordCrmReply,
    messageId: inboundMsg.id,
    providerMessageId: data.externalMessageId,
  });

  // 8b. Persist inbound attachments through the normalized, tenant-scoped
  // lifecycle. AI context is appended only for successfully extracted content.
  let groundedEmailBody = emailBody;
  if (data.attachments && data.attachments.length > 0) {
    try {
      const { outreachAttachmentService } = await import('./OutreachAttachmentService.js');
      for (const [index, attachment] of data.attachments.slice(0, 5).entries()) {
        await outreachAttachmentService.persistInboundBuffer({
          userId,
          messageId: inboundMsg.id,
          buffer: attachment.data,
          mimeType: attachment.contentType || 'application/octet-stream',
          fileName: attachment.filename || 'attachment',
          providerAttachmentId: `${data.externalMessageId}:${index}`,
          source: `${data.provider}_inbound`,
        }).catch(async (error) => {
          logger.warn({ err: error, filename: attachment.filename }, `${logPrefix} Inbound attachment persistence failed`);
          await outreachAttachmentService.recordInboundFailure({
            userId,
            messageId: inboundMsg.id,
            fileName: attachment.filename || 'attachment',
            mimeType: attachment.contentType,
            providerAttachmentId: `${data.externalMessageId}:${index}`,
            source: `${data.provider}_inbound`,
            error,
          }).catch(() => {});
        });
      }
      const attachmentContext = await outreachAttachmentService.getGroundedContext([inboundMsg.id], userId);
      if (attachmentContext) {
        const protectedAttachmentContext = redactPiiWithStableTokens(attachmentContext).redactedText;
        groundedEmailBody = `${emailBody}\n\nSuccessfully extracted attachment content:\n${protectedAttachmentContext}`;
      }
    } catch (attachErr) {
      logger.error({ err: attachErr }, `${logPrefix} Failed to store inbound attachments (non-blocking)`);
    }
  }

  // 9. Pause follow-up sequences
  await pauseFollowUpSequences(userId, leadId, logPrefix);
  const { cancelConversationEmailFollowUps } = await import('./emailFollowUpService.js');
  const { cancelSocialFollowUpsForConversation } = await import('./socialFollowUpService.js');
  await cancelConversationEmailFollowUps(conversation.id, new Date());
  await cancelSocialFollowUpsForConversation(conversation.id, 'reply_received');

  // A verified campaign reply stops only this recipient's pending email jobs.
  // The worker independently checks for replies before sending claimed jobs.
  if (replyContext.kind === 'campaign' && replyContext.campaignId) {
    const cancelled = await db.execute(sql`UPDATE outreach_jobs job
      SET status='cancelled', error='Customer replied; sequence stopped.', updated_at=NOW()
      WHERE job.user_id=${userId} AND job.campaign_id=${replyContext.campaignId}
        AND job.lead_id=${leadId} AND job.channel='email' AND job.status='pending'
        AND EXISTS (SELECT 1 FROM outreach_campaigns campaign
          WHERE campaign.id=job.campaign_id AND campaign.user_id=job.user_id
            AND campaign.business_profile_id=job.business_profile_id)
      RETURNING job.id`);
    if (cancelled.rows.length) {
      const { reconcileOutreachJobCampaign } = await import('./outreach/OutreachJobCampaignService.js');
      await reconcileOutreachJobCampaign(replyContext.campaignId, userId);
    }
  }

  if (persisted.duplicate) {
    if (replyContext.kind !== 'support') {
      return { success: true, duplicate: true, userId, leadId, conversationId: conversation.id };
    }
    const routingRecovery = await recoverPersistedEmailTicketRouting(userId, externalId, data.provider, logPrefix);
    logger.info({ userId, conversationId: conversation.id, routingRecovery, recovered: persisted.recovered },
      `${logPrefix} Duplicate inbound persistence reconciled without provider or AI replay`);
    return { success: true, duplicate: true, userId, leadId, conversationId: conversation.id };
  }

  // Withdrawal remains effective even when campaign/support generation is disabled.
  const { isNormalizedOptOutRequest, applyOptOut } = await import('./agents/pipeline/stages/OptOutStage.js');
  const optedOut = isNormalizedOptOutRequest(rawLatestReply);
  if (optedOut) await applyOptOut({ message: { userId, conversationId: conversation.id, channel: 'email',
    senderIdentifier: senderEmail, inboundText: emailBody }, confidence: 1, policyViolations: [] });

  // Campaign responses never enter support ticket, playbook, knowledge or agent routing.
  if (!optedOut && replyContext.kind === 'campaign') {
    try {
      const generated = await generateCampaignEmailReply({ userId, context: replyContext, inboundText: groundedEmailBody });
      await db.execute(sql`UPDATE sent_messages SET smart_reply=${generated.body},
        smart_reply_generated_at=NOW(), smart_reply_approved=false, smart_reply_assistant=NULL,
        reply_context=${JSON.stringify(generated.context)}::jsonb, updated_at=NOW()
        WHERE id=${exactSentMessageId} AND user_id=${userId}`);
      let delivered = false;
      let deliveryError: string | undefined;
      if (generated.autoSend) {
        const { emailReplyService } = await import('./EmailReplyService.js');
        const sent = await emailReplyService.sendSmartReply(exactSentMessageId, undefined, userId);
        delivered = sent.success;
        deliveryError = sent.error;
      }
      if (!delivered) {
        await OutreachConversationModel.createOutreachMessage({ userId, conversationId: conversation.id,
          direction: 'outbound', subject: generated.subject, content: generated.body,
          status: /uncertain/i.test(deliveryError || '') ? 'manual_review' : 'draft',
          isAutomatic: true, isAiGenerated: true, isRead: true, campaignId: campaignId!,
          metadata: { emailReplyContext: generated.context, sourceInboundMessageId: inboundMsg.id,
            ...(deliveryError ? { deliveryReviewRequired: true, deliveryError } : {}) } });
      }
    } catch (error) {
      logger.error({ err: error, userId, conversationId: conversation.id }, `${logPrefix} Campaign reply requires review; support fallback suppressed`);
      await db.execute(sql`UPDATE outreach_messages SET metadata=COALESCE(metadata,'{}'::jsonb)
        || '{"emailReplyAutomation":{"status":"review_required","reason":"campaign_context_or_generation_unavailable"}}'::jsonb
        WHERE id=${inboundMsg.id} AND user_id=${userId} AND conversation_id=${conversation.id}`);
    }
  }
  // 9a. Support ownership is limited to the exact non-campaign conversation.
  const routedToActiveTicket = !optedOut && replyContext.kind === 'support'
    ? await routeReplyToActiveTicket(userId, leadId, conversation.id, inboundMsg.id, emailBody, logPrefix) : 'blocked';

  // 10. Support replies require an exact, non-campaign conversation.
  if (routedToActiveTicket === 'unmatched') {
    await processAutoReply(userId, leadId, conversation.id, protectedSubject, groundedEmailBody, bestLeadName, company, senderEmail, logPrefix, {
      inReplyTo: data.externalMessageId,
      references: data.references ? `${data.references} ${data.externalMessageId}` : data.externalMessageId,
    }, verifiedReceivingAccountId || undefined, {
      sentMessageId: exactSentMessageId,
      outreachMessageId: inboundMsg.id,
      providerMessageId: data.externalMessageId,
      privacyVaultId: protectedInbound.vaultId,
      piiTypes: protectedInbound.piiTypes,
      piiTokenCount: protectedInbound.tokenCount,
    });
  }

  // 11. Publish real-time event
  eventBus.publish({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel: 'events:email:received' as any,
    userId,
    timestamp: new Date().toISOString(),
    data: {
      type: 'email.received',
      leadId,
      senderEmail,
      subject: data.subject,
      emailId: data.externalMessageId,
      conversationId: conversation.id,
      provider: data.provider,
    },
  }).catch(() => {});

  logger.info(
    { leadId, userId, conversationId: conversation.id, provider: data.provider },
    `${logPrefix} Inbound email reply processed successfully`,
  );

  return {
    success: true,
    userId,
    leadId,
    conversationId: conversation.id,
  };
}

// ─── Email Status Update Utilities ──────────────────────────────────────────────

/**
 * Update the delivery status of an outbound email (sent, delivered, bounced, etc.).
 * Shared across Resend/Gmail/SMTP status webhooks.
 */
export async function updateEmailDeliveryStatus(
  externalMessageId: string,
  status: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  additionalData?: Record<string, any>,
): Promise<void> {
  // Update outreach messages
  await OutreachConversationModel.updateMessageStatusByExternalId(externalMessageId, status, additionalData);

  // Persist monotonic provider milestones and reconcile exact campaign jobs.
  // Replayed/late "sent" callbacks must not erase delivery or bounce receipts.
  const { recordOutreachEmailDelivery } = await import('./outreach/OutreachJobCampaignService.js');
  await recordOutreachEmailDelivery(externalMessageId, status, additionalData?.errorMessage);
}

/**
 * Record a click event on an outbound email.
 */
export async function recordEmailClick(externalMessageId: string, link: string): Promise<void> {
  const existing = await OutreachConversationModel.getMessageByExternalId(externalMessageId);
  if (existing) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = (existing.metadata as any) || {};
    const clicks = metadata.clicks || [];
    clicks.push({ link, timestamp: new Date().toISOString() });
    await OutreachConversationModel.updateMessageStatusByExternalId(externalMessageId, existing.status, {
      metadata: { ...metadata, clicks },
    });
  }
}

/**
 * Publish an email status event to the EventBus.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishEmailStatusEvent(eventType: string, data: Record<string, any>): Promise<void> {
  eventBus.publish({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel: 'events:email:status' as any,
    userId: 0,
    timestamp: new Date().toISOString(),
    data: { type: eventType, ...data },
  }).catch(() => {});
}
