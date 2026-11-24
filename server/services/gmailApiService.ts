/**
 * Gmail API Service
 * Handles Gmail API operations for sending, receiving, and managing emails
 */

import { google, gmail_v1 } from 'googleapis';
import { logger } from '../utils/logger.js';
import { getGmailClientForUser } from '../controllers/gmailOAuthController';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { LLMProviderFactory } from './agents/LLMProviderFactory';
import { knowledgeGateway } from './knowledge/KnowledgeGateway.js';
import * as OutreachConversationModel from '../models/outreachConversations/functions';
import crypto from 'node:crypto';
import { MAX_OUTREACH_ATTACHMENT_SIZE } from '../utils/outreachAttachmentPolicy.js';
import { emailDisplayText } from '../utils/emailDisplay.js';
import { providerMessageId as normalizeProviderMessageId } from './outreach/deliveryOutcome.js';
import { gmailSendError } from '../utils/gmailSendError.js';
import { guardGmailClient, GmailCooldownError } from './GmailCooldownService.js';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, deliverySetupFailure, withCustomerDeliveryReceipt } from './assistants/CustomerDeliveryGate.js';
import { isInternalEmailDelivery } from './InternalEmailDelivery.js';
import { emailBodyToHtml, stripEmailPlaceholders } from '../../shared/emailFormatting.js';
import { personalizeLeadEmail } from '../utils/personalization.js';
import { unresolvedEmailTemplateVariables } from '../utils/emailTemplateVariables.js';
import { resolveLeadEmailTokens, renderLeadEmailField } from './content/EmailTemplatePersonalizationService.js';

// Interfaces
interface LeadInfo {
  id?: number;
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  company?: string;
  role?: string;
  industry?: string;
  headline?: string;
  location?: string;
  linkedinUrl?: string;
  bio?: string;
}

interface SendEmailOptions {
  idempotencyKey?: string;
  to: string;
  toName?: string;
  subject: string;
  body: string;
  isHtml?: boolean;
  replyTo?: string;
  fromEmail?: string; // Expected Gmail account email. Used to reject stale sender records.
  /** Server-resolved immutable account binding for reviewed sends. */
  accountBinding?: { credentialId: number; accountIdentifier: string };
  threadId?: string;    // Gmail API thread ID for reply threading
  inReplyTo?: string;   // RFC5322 Message-ID for In-Reply-To header
  references?: string;  // Space-separated RFC5322 Message-IDs for References header (full chain)
  leadId?: number;
  campaignId?: number;
  sequenceStep?: number;
  senderId?: number;
  fromName?: string; // Legacy hint. Gmail sends use the connected account profile name.
  isFollowUp?: boolean;
  followUpStep?: number;
  skipConversationLog?: boolean; // Skip creating outreach_messages (caller already created one)
  skipCreditDeduction?: boolean; // Caller already reserved the outreach credit
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string; contentId?: string }>;
}

interface SendEmailResult {
  success: boolean;
  code?: string;
  reason?: string;
  setupUrl?: string;
  assistantId?: string;
  /** Legacy value; RFC Message-ID when available, otherwise Gmail native ID. */
  messageId?: string;
  providerMessageId?: string;
  rfcMessageId?: string;
  threadId?: string;
  error?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
  retryable?: boolean;
  retryAt?: string;
}

interface GmailMessage {
  id: string;
  rfcMessageId?: string;
  threadId: string;
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
  date: Date;
  labelIds: string[];
  snippet: string;
  isRead: boolean;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ providerAttachmentId: string; fileName: string; mimeType: string; buffer?: Buffer; error?: string }>;
}

interface FollowUpStep {
  stepNumber: number;
  delayDays: number;
  subject: string;
  body: string;
  triggerCondition?: 'no_reply' | 'opened' | 'clicked';
}

class GmailApiService {
  private static instance: GmailApiService;

  private constructor() {}

  public static getInstance(): GmailApiService {
    if (!GmailApiService.instance) {
      GmailApiService.instance = new GmailApiService();
    }
    return GmailApiService.instance;
  }

  private async getGmailClient(userId: number): Promise<gmail_v1.Gmail | null> {
    const clientResult = await getGmailClientForUser(userId);
    return clientResult ? guardGmailClient(
      google.gmail({ version: 'v1', auth: clientResult.client, retry: false, timeout: 30_000 }),
      { userId, credentialId: Number(clientResult.credential.id), emailAddress: String(clientResult.credential.accountIdentifier).trim().toLowerCase() },
    ) : null;
  }

  private formatEmailAddress(email: string, displayName?: string | null): string {
    const safeEmail = email.trim();
    const safeName = (displayName || safeEmail)
      .replace(/[\r\n"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const encodedName = [...safeName].every((char) => char.charCodeAt(0) <= 0x7F)
      ? `"${safeName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : `=?UTF-8?B?${Buffer.from(safeName, 'utf8').toString('base64')}?=`;

    return `${encodedName} <${safeEmail}>`;
  }

  private formatSubject(subject: string): string {
    // Gmail expects non-ASCII header text to use RFC 2047 encoded words.
    // Keep each word within the 75-character limit without splitting UTF-8 characters.
    const safeSubject = subject.replace(/[\x00-\x1f\x7f]/g, ' ');
    if (/^[\x20-\x7e]*$/.test(safeSubject)) return safeSubject;
    const chunks: string[] = [];
    let chunk = '';
    let bytes = 0;
    for (const char of safeSubject) {
      const size = Buffer.byteLength(char, 'utf8');
      if (bytes + size > 45) {
        chunks.push(chunk);
        chunk = '';
        bytes = 0;
      }
      chunk += char;
      bytes += size;
    }
    if (chunk) chunks.push(chunk);
    return chunks.map(value => `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`).join('\r\n ');
  }

  private normalizeEmail(email?: string | null): string {
    return (email || '').trim().toLowerCase();
  }

  /**
   * Check if user has Gmail connected
   */
  async isConnected(userId: number): Promise<boolean> {
    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_api');
    return !!credential && !!credential.accessToken;
  }

  /**
   * Get user's Gmail address
   */
  async getUserEmail(userId: number): Promise<string | null> {
    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_api');
    return credential?.accountIdentifier || null;
  }

  /**
   * Send an email via Gmail API
   */
  async sendEmail(userId: number, options: SendEmailOptions): Promise<SendEmailResult> {
    let deliveryAttempted = false;
    let providerAccepted=false;
    try {
      if (!isInternalEmailDelivery()) assertCustomerDeliveryRuntime('email');
      const unresolved = unresolvedEmailTemplateVariables({ subject: options.subject, ...(options.isHtml ? { html: options.body } : { text: options.body }) });
      if (unresolved.length) return { success: false, error: `Missing email personalization values: ${unresolved.join(', ')}`, deliveryAttempted: false, outcomeUncertain: false, retryable: false };
      if (options.isHtml) options = { ...options, body: emailBodyToHtml(options.body) };
      const clientResult = await getGmailClientForUser(userId, options.accountBinding);
      if (!clientResult) {
        return { success: false, error: 'Gmail not connected', deliveryAttempted: false };
      }
      const gmail = guardGmailClient(
        google.gmail({ version: 'v1', auth: clientResult.client, retry: false, timeout: 30_000 }),
        { userId, credentialId: Number(clientResult.credential.id), emailAddress: String(clientResult.credential.accountIdentifier).trim().toLowerCase() },
      );

      // Build email content
      const credential = clientResult.credential;
      const fromEmail = credential?.accountIdentifier || await this.getUserEmail(userId);
      if (!fromEmail) {
        return { success: false, error: 'Gmail account email not found. Please reconnect Gmail.', deliveryAttempted: false };
      }
      const assistantReceipt = !isInternalEmailDelivery() ? await assertCustomerDeliveryReady({ userId, channel: 'email', accountId: fromEmail }) : undefined;

      if (options.fromEmail && this.normalizeEmail(options.fromEmail) !== this.normalizeEmail(fromEmail)) {
        return {
          success: false,
          error: `Selected sender ${options.fromEmail} does not match connected Gmail account ${fromEmail}. Please resync email senders or reconnect Gmail.`,
          deliveryAttempted: false,
        };
      }

      // Gmail sends from the connected account. Use the OAuth profile name so the
      // display name matches Gmail's actual account identity instead of a stale UI label.
      const fromName = credential?.accountName || fromEmail;

      const toHeader = options.toName 
        ? this.formatEmailAddress(options.to, options.toName)
        : options.to;

      let trackingId: string | undefined;
      if (options.isHtml && !isInternalEmailDelivery()) {
        try {
          const { prepareEmailOpenTracking } = await import('./EmailOpenTrackingService.js');
          const tracked = await prepareEmailOpenTracking(userId, options.body, options.idempotencyKey, fromEmail);
          options = { ...options, body: tracked.html };
          trackingId = tracked.trackingId;
        } catch { logger.warn('[GmailApiService] Open tracking unavailable; preserving the email delivery'); }
      }

      // Create email headers
      const headers = [
        `From: ${this.formatEmailAddress(fromEmail, fromName)}`,
        `To: ${toHeader}`,
        `Subject: ${this.formatSubject(options.subject)}`,
        `MIME-Version: 1.0`,
      ];

      // Add In-Reply-To and References headers for proper email threading
      // Use the RFC5322 Message-ID (inReplyTo) if available; do NOT use Gmail threadId as In-Reply-To
      if (options.inReplyTo) {
        headers.push(`In-Reply-To: ${options.inReplyTo}`);
        // If a full references chain is provided use it; otherwise fall back to just inReplyTo
        const refsValue = options.references || options.inReplyTo;
        headers.push(`References: ${refsValue}`);
      }

      const attachments = options.attachments || [];
      let rawEmail: string;
      if (attachments.length > 0) {
        const boundary = `mixed_${crypto.randomUUID().replace(/-/g, '')}`;
        headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
        const parts = [
          `--${boundary}`,
          `Content-Type: ${options.isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(options.body, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim(),
        ];
        for (const attachment of attachments) {
          const safeAttachmentName = attachment.filename.replace(/[\r\n"\\]/g, '_').slice(0, 255) || 'attachment';
          parts.push(
            `--${boundary}`,
            `Content-Type: ${attachment.contentType || 'application/octet-stream'}; name="${safeAttachmentName}"`,
            `Content-Disposition: ${attachment.contentId ? 'inline' : 'attachment'}; filename="${safeAttachmentName}"`,
            ...(attachment.contentId ? [`Content-ID: <${attachment.contentId.replace(/[<>\r\n]/g, '')}>`] : []),
            'Content-Transfer-Encoding: base64',
            '',
            attachment.content.toString('base64').replace(/.{1,76}/g, '$&\r\n').trim(),
          );
        }
        parts.push(`--${boundary}--`);
        rawEmail = [headers.join('\r\n'), '', parts.join('\r\n')].join('\r\n');
      } else {
        headers.push(`Content-Type: ${options.isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`);
        rawEmail = [headers.join('\r\n'), '', options.body].join('\r\n');
      }

      // Encode to base64url
      const encodedEmail = Buffer.from(rawEmail)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      // Send via Gmail API
      const sendParams: gmail_v1.Params$Resource$Users$Messages$Send = {
        userId: 'me',
        requestBody: {
          raw: encodedEmail,
        },
      };

      // Add threadId for replies
      if (options.threadId) {
        sendParams.requestBody!.threadId = options.threadId;
      }

      if (assistantReceipt) await assertCustomerDeliveryReady({ userId, channel: 'email', accountId: fromEmail, expected: assistantReceipt });
      deliveryAttempted = true;
      // Gmail has no send idempotency key. An interrupted POST must not be
      // automatically replayed by the transport after possible acceptance.
      const dispatch = () => gmail.users.messages.send(sendParams, { timeout: 30_000, retry: false });
      const result = await (assistantReceipt ? withCustomerDeliveryReceipt(assistantReceipt, dispatch) : dispatch());
      const providerMessageId = normalizeProviderMessageId(result?.data?.id);
      if (!providerMessageId) {
        return { success: false, error: 'Gmail did not return an acceptance receipt. Review provider history before retrying.',
          deliveryAttempted: true, outcomeUncertain: true, retryable: false };
      }
      providerAccepted = true;
      if (trackingId && providerMessageId) {
        try {
          const { confirmEmailOpenTracking } = await import('./EmailOpenTrackingService.js');
          await confirmEmailOpenTracking(trackingId, providerMessageId);
        } catch { logger.warn('[GmailApiService] Accepted email; open tracking receipt could not be linked'); }
      }
      const threadId = normalizeProviderMessageId(result.data.threadId);

      // Fetch the sent message to get its RFC5322 Message-ID header for future threading
      let rfc5322MessageId: string | undefined;
      try {
        if (providerMessageId) {
          const sentMsg = await gmail.users.messages.get({
            userId: 'me',
            id: providerMessageId,
            format: 'metadata',
            metadataHeaders: ['Message-ID'],
          }, { timeout: 10_000, retry: false });
          const msgIdHeader = sentMsg.data.payload?.headers?.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (h: any) => h.name?.toLowerCase() === 'message-id'
          );
          const header = msgIdHeader?.value;
          rfc5322MessageId = header && /^<[^<>@\s]+@[^<>\s]+>$/.test(header) ? header : undefined;
        }
      } catch (_headerErr) {
        // Log the failure so we can diagnose threading issues
        logger.warn({ messageId: providerMessageId }, '[GmailApiService] Failed to fetch RFC5322 Message-ID header, threading may be affected');
      }

      // Log sent email to database
      if (options.leadId) {
        await this.logSentEmail({
          userId,
          leadId: options.leadId,
          messageId: rfc5322MessageId || providerMessageId,
          gmailMessageId: providerMessageId,
          threadId: threadId || '',
          to: options.to,
          subject: options.subject,
          body: options.body,
          isHtml: Boolean(options.isHtml),
          campaignId: options.campaignId,
          sequenceStep: options.sequenceStep,
          isFollowUp: options.isFollowUp,
          followUpStep: options.followUpStep,
          skipConversationLog: options.skipConversationLog,
          skipCreditDeduction: options.skipCreditDeduction,
          senderId: options.senderId, rfcMessageId: rfc5322MessageId, references: options.references,
        });
      }

      // Update last used timestamp
      try {
        await ChannelCredentialModel.updateLastUsed(userId, 'gmail_api');
      } catch {
        // A local timestamp failure cannot erase the provider's acceptance.
        logger.warn({ userId, messageId: providerMessageId }, '[GmailApiService] Accepted email; credential usage timestamp could not be updated');
      }

      logger.info(`[GmailApiService] Email sent: ${result.data.id}`);

      return {
        success: true,
        // Preserve the two provider namespaces separately. Never use Gmail's
        // native hex ID as an RFC In-Reply-To value.
        messageId: rfc5322MessageId || providerMessageId,
        providerMessageId,
        rfcMessageId: rfc5322MessageId,
        threadId,
        deliveryAttempted: true,
        outcomeUncertain: false,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[GmailApiService] Error sending email:');
      const setup = deliverySetupFailure(error);
      if (setup) return setup;
      if (error instanceof GmailCooldownError && !providerAccepted) {
        return { success: false, error: error.message, retryAt: error.retryAt, retryable: true,
          deliveryAttempted: error.deliveryAttempted, outcomeUncertain: false };
      }
      return gmailSendError(error, deliveryAttempted, providerAccepted);
    }
  }

  /**
   * Send personalized email to a lead
   */
  async sendPersonalizedEmail(
    userId: number,
    leadId: number,
    subject: string,
    htmlTemplate: string,
    campaignId?: number,
    sequenceStep?: number
  ): Promise<SendEmailResult> {
    try {
      // Fetch lead data
      const leadResult = await db.execute(sql`
        SELECT * FROM leads WHERE id = ${leadId}
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = leadResult.rows[0] as any;

      if (!lead) {
        return { success: false, error: 'Lead not found' };
      }

      if (!lead.email) {
        return { success: false, error: 'Lead has no email address' };
      }

      // Check if lead is blacklisted or unsubscribed
      if (lead.blacklisted || lead.do_not_contact || lead.email_unsubscribed) {
        return { success: false, error: 'Lead has opted out of emails' };
      }

      // Replace personalization tokens
      const tokens = await resolveLeadEmailTokens(userId, lead, [htmlTemplate, subject]);
      const personalizedHtml = renderLeadEmailField(htmlTemplate, tokens, true);
      const personalizedSubject = renderLeadEmailField(subject, tokens);

      return this.sendEmail(userId, {
        to: lead.email,
        toName: lead.full_name || lead.name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
        subject: personalizedSubject,
        body: personalizedHtml,
        isHtml: true,
        leadId,
        campaignId,
        sequenceStep,
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[GmailApiService] Error sending personalized email:');
      return { success: false, error: error.message };
    }
  }



  /**
   * Log sent email to database and save to outreach conversations
   */
  private async logSentEmail(data: {
    userId: number;
    leadId: number;
    messageId: string;
    gmailMessageId?: string;
    threadId: string;
    to: string;
    subject: string;
    body: string;
    isHtml: boolean;
    campaignId?: number;
    sequenceStep?: number;
    isFollowUp?: boolean;
    followUpStep?: number;
    skipConversationLog?: boolean;
    skipCreditDeduction?: boolean;
    senderId?: number;
    rfcMessageId?: string;
    references?: string;
  }): Promise<void> {
    try {
      await db.execute(sql`
        INSERT INTO sent_messages (user_id, lead_id, lead_name, channel, subject, message, message_format, status, sent_at, message_id, gmail_thread_id, gmail_message_id, campaign_id, sequence_step, is_reply, follow_up_step, sender_id, recipient_address, rfc_message_id, references_header)
        VALUES (
          ${data.userId},
          ${data.leadId},
          ${data.to},
          'gmail',
          ${data.subject},
          ${data.body},
          ${data.isHtml ? 'html' : 'text'},
          'sent',
          NOW(),
          ${data.messageId},
          ${data.threadId || null},
          ${data.gmailMessageId || null},
          ${data.campaignId || null},
          ${data.sequenceStep || null},
          ${data.isFollowUp || false},
          ${data.followUpStep || null},
          ${data.senderId || null}, ${data.to}, ${data.rfcMessageId || null}, ${data.references || null}
        )
      `);

      // Update lead's last contacted timestamp
      await db.execute(sql`
        UPDATE leads SET
          last_contacted_at = NOW(),
          messages_sent = COALESCE(messages_sent, 0) + 1,
          updated_at = NOW()
        WHERE id = ${data.leadId}
      `);

      // Deduct credits for gmail outreach
      if (!data.skipCreditDeduction) {
        try {
          const { deductCreditsForOutreach } = await import('./CreditDeductionHooks.js');
          await deductCreditsForOutreach(data.userId, 'email', { messageId: data.messageId, service: 'GmailApiService' });
        } catch (_err) { /* credit deduction should not break email flow */ }
      }

      // Save to outreach conversations for tracking (skip if caller already created the record)
      if (!data.skipConversationLog) {
        try {
          await this.saveToOutreachConversation(data);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (convErr: any) {
          logger.error({ err: convErr }, '[GmailApiService] Error saving to outreach conversation');
        }
      }

      // Auto-create / update CRM contact (non-blocking): marks pipeline as 'contacted'
      import('./CRMService.js').then(({ crmService }) =>
        crmService.autoCreateContactOnOutreachSend(data.userId, data.leadId, { source: 'gmail' })
      ).catch(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[GmailApiService] Error logging sent email:');
    }
  }

  /**
   * Save a sent email to the outreach conversation system
   */
  private async saveToOutreachConversation(data: {
    userId: number;
    leadId: number;
    messageId: string;
    gmailMessageId?: string;
    threadId: string;
    to: string;
    subject: string;
    body: string;
    isHtml: boolean;
    campaignId?: number;
    sequenceStep?: number;
    isFollowUp?: boolean;
  }): Promise<void> {
    const leadResult = await db.execute(sql`
      SELECT id, email, name, full_name, company FROM leads WHERE id = ${data.leadId} LIMIT 1
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = leadResult.rows[0] as any;
    if (!lead) return;

    const existing = await OutreachConversationModel.getMessageByExternalId(data.messageId);
    if (existing) return;

    // Provider thread ID is the authoritative Gmail conversation identity.
    const existingConversation = data.threadId
      ? await OutreachConversationModel.getConversationByProviderThread(
          data.userId,
          data.leadId,
          'gmail',
          data.threadId
        )
      : undefined;
    const conversation = existingConversation
      || await OutreachConversationModel.createOutreachConversation({
          userId: data.userId,
          leadId: data.leadId,
          channel: 'email',
          leadName: lead.full_name || lead.name || data.to,
          leadEmail: lead.email || data.to,
          leadCompany: lead.company || undefined,
          status: 'active',
          subject: data.subject,
          integrationProvider: 'gmail',
          externalThreadId: data.threadId || undefined,
        });

    // Determine what to show in the conversation bubble.
    // The body may be a full branded HTML email (<!DOCTYPE …>) — we don't want
    // to render the entire email template inside a narrow chat bubble.
    // Strip the branded wrapper and surface only the core reply text.
    const isFullEmailHtml = data.isHtml && typeof data.body === 'string' && data.body.trim().toLowerCase().startsWith('<!doctype');
    const chatHtmlContent = !data.isHtml || isFullEmailHtml ? null : (data.body || undefined);
    const chatPlainText = emailDisplayText(data.body || data.subject || '', data.body && data.isHtml ? 'html' : 'text')
      .slice(0, 1000) || data.subject;

    await OutreachConversationModel.createOutreachMessage({
      conversationId: conversation.id,
      userId: data.userId,
      direction: 'outbound',
      subject: data.subject,
      content: chatPlainText,
      htmlContent: chatHtmlContent,
      externalMessageId: data.messageId,
      providerMessageId: data.gmailMessageId || undefined,
      rfcMessageId: /^<[^<>@\s]+@[^<>\s]+>$/.test(data.messageId)
        ? data.messageId
        : undefined,
      status: 'sent',
      sentAt: new Date(),
      campaignId: data.campaignId,
      sequenceStep: data.sequenceStep,
      messageKind: data.isFollowUp ? 'reply' : 'outreach',
      metadata: data.threadId ? { gmailThreadId: data.threadId } : undefined,
    });
  }

  /**
   * Fetch messages from Gmail inbox
   */
  async fetchInboxMessages(
    userId: number,
    options: {
      maxResults?: number;
      query?: string;
      labelIds?: string[];
      afterDate?: Date;
    } = {}
  ): Promise<GmailMessage[]> {
    try {
      const gmail = await this.getGmailClient(userId);
      if (!gmail) {
        logger.warn({ data: userId }, '[GmailApiService] Gmail not connected for user:');
        return [];
      }

      // Build query
      let query = options.query || '';
      if (options.afterDate) {
        const dateStr = options.afterDate.toISOString().split('T')[0].replace(/-/g, '/');
        query += ` after:${dateStr}`;
      }

      // List messages
      const listParams: gmail_v1.Params$Resource$Users$Messages$List = {
        userId: 'me',
        maxResults: options.maxResults || 50,
        labelIds: options.labelIds,
      };
      if (query.trim()) {
        listParams.q = query.trim();
      }

      const listResponse = await gmail.users.messages.list(listParams);
      const messageIds = listResponse.data.messages || [];

      // Fetch full message details
      const messages: GmailMessage[] = [];
      for (const msg of messageIds) {
        if (!msg.id) continue;

        try {
          const msgResponse = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
          });

          const parsed = this.parseGmailMessage(msgResponse.data);
          if (parsed) {
            parsed.attachments = await this.fetchMessageAttachments(gmail, msg.id, msgResponse.data.payload);
            messages.push(parsed);
          }
        } catch (msgError) {
          logger.error({ err: msgError }, '[GmailApiService] Error fetching message:');
        }
      }

      return messages;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[GmailApiService] Error fetching inbox:');
      return [];
    }
  }

  private async fetchMessageAttachments(
    gmail: gmail_v1.Gmail,
    messageId: string,
    payload?: gmail_v1.Schema$MessagePart,
  ): Promise<Array<{ providerAttachmentId: string; fileName: string; mimeType: string; buffer?: Buffer; error?: string }>> {
    const output: Array<{ providerAttachmentId: string; fileName: string; mimeType: string; buffer?: Buffer; error?: string }> = [];
    const visit = async (part: gmail_v1.Schema$MessagePart): Promise<void> => {
      const fileName = (part.filename || '').trim();
      if (fileName && output.length < 5) {
        let data = part.body?.data || undefined;
        const attachmentId = part.body?.attachmentId || undefined;
        const providerAttachmentId = `${messageId}:${attachmentId || fileName}`;
        if ((part.body?.size || 0) > MAX_OUTREACH_ATTACHMENT_SIZE) {
          output.push({
            providerAttachmentId,
            fileName,
            mimeType: part.mimeType || 'application/octet-stream',
            error: 'The Gmail attachment exceeds the 10 MB safety limit.',
          });
        } else {
          try {
            if (!data && attachmentId) {
              const response = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
              data = response.data.data || undefined;
            }
            if (!data) throw new Error('Gmail did not return attachment content.');
            if (data.length > Math.ceil(MAX_OUTREACH_ATTACHMENT_SIZE * 4 / 3) + 8) {
              throw new Error('The Gmail attachment exceeds the 10 MB safety limit.');
            }
            const buffer = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
            if (buffer.length > MAX_OUTREACH_ATTACHMENT_SIZE) throw new Error('The Gmail attachment exceeds the 10 MB safety limit.');
            output.push({
              providerAttachmentId,
              fileName,
              mimeType: part.mimeType || 'application/octet-stream',
              buffer,
            });
          } catch (error) {
            output.push({
              providerAttachmentId,
              fileName,
              mimeType: part.mimeType || 'application/octet-stream',
              error: error instanceof Error ? error.message : 'Gmail attachment retrieval failed.',
            });
          }
        }
      }
      for (const child of part.parts || []) await visit(child);
    };
    if (payload) await visit(payload);
    return output;
  }

  /**
   * Parse Gmail API message into our format
   */
  private parseGmailMessage(message: gmail_v1.Schema$Message): GmailMessage | null {
    if (!message.id || !message.threadId) return null;

    const headers = message.payload?.headers || [];
    const getHeader = (name: string) => 
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const fromHeader = getHeader('From');
    const fromMatch = fromHeader.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
    const fromName = fromMatch?.[1] || '';
    const fromEmail = fromMatch?.[2] || fromHeader;

    // Extract body
    let body = '';
    let htmlBody = '';

    const extractBody = (part: gmail_v1.Schema$MessagePart): void => {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        htmlBody = Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) {
        part.parts.forEach(extractBody);
      }
    };

    if (message.payload) {
      extractBody(message.payload);
    }

    // If no plain text, convert HTML
    if (!body && htmlBody) {
      body = emailDisplayText(htmlBody, 'html');
    }

    return {
      id: message.id,
      rfcMessageId: getHeader('Message-ID') || undefined,
      threadId: message.threadId,
      from: fromEmail,
      fromName: fromName,
      to: getHeader('To'),
      subject: getHeader('Subject'),
      body,
      htmlBody: htmlBody || undefined,
      date: new Date(parseInt(message.internalDate || '0')),
      labelIds: message.labelIds || [],
      snippet: message.snippet || '',
      isRead: !(message.labelIds || []).includes('UNREAD'),
      inReplyTo: getHeader('In-Reply-To') || undefined,
      references: getHeader('References')?.split(/\s+/) || undefined,
    };
  }

  /**
   * Generate AI-personalized email using LLM
   */
  async generatePersonalizedEmail(
    lead: LeadInfo,
    purpose: 'cold_outreach' | 'follow_up' | 'nurture' = 'cold_outreach',
    context?: {
      campaignObjective?: string;
      valueProposition?: string;
      previousEmails?: string[];

      tone?: 'professional' | 'casual' | 'friendly' | 'formal';
      followUpNumber?: number;
    },
    userId?: number
  ): Promise<{ subject: string; body: string }> {
    try {
      const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
      
      // Get Knowledge Base context using embedding-based semantic search
      let kbContextBlock = '';
      if (userId) {
        try {
          const semanticQuery = [
            context?.campaignObjective,
            lead.company, lead.industry, lead.role,
          ].filter(Boolean).join(' ') || purpose;
          const kbText = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'outreach_reply', channel: 'email', audience: 'customer', redactedText: semanticQuery, redactedHistory: [], entities: {}, risk: 'low' });
          if (kbText) {
            kbContextBlock = `\nKnowledge Base Context (use this information when relevant):\n${kbText}\n`;
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (kbErr: any) {
          logger.warn({ err: kbErr }, '[GmailApiService] Error fetching KB context');
        }
      }
      
      let prompt: string;
      
      switch (purpose) {
        case 'follow_up':
          prompt = `Generate a follow-up email for someone who hasn't replied to our previous outreach.

Recipient Information:
- Name: ${lead.firstName || lead.fullName?.split(' ')[0] || 'there'}
- Company: ${lead.company || 'their company'}
- Role: ${lead.role || 'their role'}
- Industry: ${lead.industry || ''}

Context:
- This is follow-up #${context?.followUpNumber || 1}
- Campaign Goal: ${context?.campaignObjective || 'Establish connection'}
- Value Proposition: ${context?.valueProposition || ''}
- Tone: ${context?.tone || 'professional'}

Previous emails sent:
${context?.previousEmails?.join('\n---\n') || 'Initial outreach email'}

Rules:
- Keep subject line short (5-8 words)
- Keep body concise (3-5 sentences)
- Reference the previous email briefly
- Provide NEW value or angle
- Include soft call-to-action
- Be ${context?.tone || 'professional'} but not pushy
- Do NOT sound desperate or salesy

Output format (JSON):
{
  "subject": "your subject here",
  "body": "your email body here (can include \\n for line breaks)"
}`;
          break;
          
        case 'nurture':
          prompt = `Generate a nurturing email to provide value and build relationship.

Recipient Information:
- Name: ${lead.firstName || lead.fullName?.split(' ')[0] || 'there'}
- Company: ${lead.company || 'their company'}
- Role: ${lead.role || 'their role'}
- Industry: ${lead.industry || ''}

Context:
- Campaign Goal: ${context?.campaignObjective || 'Build relationship'}
- Value Proposition: ${context?.valueProposition || ''}
- Tone: ${context?.tone || 'friendly'}

Rules:
- Keep subject line intriguing (5-8 words)
- Focus on providing value, NOT selling
- Share relevant insight, tip, or resource
- Keep body medium length (4-6 sentences)
- Soft call-to-action only
- Be genuinely helpful

Output format (JSON):
{
  "subject": "your subject here",
  "body": "your email body here (can include \\n for line breaks)"
}`;
          break;
          
        case 'cold_outreach':
        default:
          prompt = `Generate a cold outreach email for sales/marketing purposes.

Recipient Information:
- Name: ${lead.firstName || lead.fullName?.split(' ')[0] || 'there'}
- Company: ${lead.company || 'their company'}
- Role: ${lead.role || 'their role'}
- Industry: ${lead.industry || ''}
${lead.headline ? `- Headline: ${lead.headline}` : ''}
${lead.linkedinUrl ? `- LinkedIn: ${lead.linkedinUrl}` : ''}

Context:
- Campaign Goal: ${context?.campaignObjective || 'Establish connection and schedule a call'}
- Value Proposition: ${context?.valueProposition || ''}
- Tone: ${context?.tone || 'professional'}

Rules:
- Keep subject line short, personalized, intriguing (5-8 words)
- Keep body concise (3-5 sentences max)
- Personalize based on their company/role/industry
- Lead with value, not features
- Include clear but soft call-to-action
- Be ${context?.tone || 'professional'} but human
- Do NOT be pushy or salesy

Output format (JSON):
{
  "subject": "your subject here",
  "body": "your email body here (can include \\n for line breaks)"
}`;
      }

      // Append KB context to the prompt so the LLM can reference it
      if (kbContextBlock) {
        prompt += kbContextBlock;
      }

      const response = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { 
            role: 'system', 
            content: 'You are an expert email copywriter specializing in B2B sales and marketing emails. You write emails that feel personal, provide value, and get responses. Always respond with valid JSON only. NEVER use placeholder text like [Link to Calendar], [Your Name], [Company Website], [Insert X], [CTA Link], [Your Title], etc. Write the actual content or omit it entirely. Do not include any bracketed placeholders in the output.'
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 500,
        ...(userId ? {
          loggingContext: {
            userId,
            purpose: 'email_generation',
            service: 'GmailApiService',
            action: 'generate_personalized_email',
          },
        } : {}),
      });

      // Parse JSON response
      try {
        const jsonMatch = response.content?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          // Strip any bracketed placeholders the LLM may have produced
          return {
            subject: personalizeLeadEmail(parsed.subject || `Hello ${lead.firstName || 'there'}`, lead),
            body: personalizeLeadEmail(stripEmailPlaceholders(parsed.body || 'I wanted to reach out and connect.'), lead),
          };
        }
      } catch (parseError) {
        logger.error({ err: parseError }, '[GmailApiService] Error parsing LLM response:');
      }

      // Fallback
      return {
        subject: `Quick question for ${lead.firstName || 'you'}`,
        body: `Hi ${lead.firstName || 'there'},\n\nI came across ${lead.company || 'your company'} and thought there might be a great opportunity to connect.\n\nWould you be open to a quick chat this week?\n\nBest regards`,
      };
    } catch (error) {
      logger.error({ err: error }, '[GmailApiService] generatePersonalizedEmail error:');
      return {
        subject: `Quick question for ${lead.firstName || 'you'}`,
        body: `Hi ${lead.firstName || 'there'},\n\nI came across ${lead.company || 'your company'} and thought there might be a great opportunity to connect.\n\nWould you be open to a quick chat this week?\n\nBest regards`,
      };
    }
  }

  /**
   * Generate follow-up email sequence
   */
  async generateFollowUpSequence(
    lead: LeadInfo,
    context: {
      campaignObjective?: string;
      valueProposition?: string;
      tone?: 'professional' | 'casual' | 'friendly' | 'formal';
      numberOfFollowUps?: number;
    },
    userId?: number
  ): Promise<FollowUpStep[]> {
    try {
      const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
      const numFollowUps = context.numberOfFollowUps || 3;

      const prompt = `Generate a follow-up email sequence for someone who hasn't responded to our initial outreach.

Recipient Information:
- Name: ${lead.firstName || lead.fullName?.split(' ')[0] || 'there'}
- Company: ${lead.company || 'their company'}
- Role: ${lead.role || 'their role'}
- Industry: ${lead.industry || ''}

Context:
- Campaign Goal: ${context.campaignObjective || 'Establish connection'}
- Value Proposition: ${context.valueProposition || ''}
- Tone: ${context.tone || 'professional'}
- Number of follow-ups needed: ${numFollowUps}

Rules for the sequence:
- Each email should have a different angle/approach
- Progressively provide more value
- Vary the subject lines
- Include social proof or case study mentions where appropriate
- Last email should be a "breakup" email
- Delays should be: 3 days, 5 days, 7 days, etc.
- Keep emails concise but valuable

Output format (JSON array):
[
  {
    "stepNumber": 1,
    "delayDays": 3,
    "subject": "subject line",
    "body": "email body with \\n for line breaks",
    "triggerCondition": "no_reply"
  },
  ...
]`;

      const response = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { 
            role: 'system', 
            content: 'You are an expert email copywriter creating follow-up sequences. Each email should feel fresh, provide value, and not be repetitive. Always respond with valid JSON array only.'
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 1500,
        ...(userId ? {
          loggingContext: {
            userId,
            purpose: 'email_generation',
            service: 'GmailApiService',
            action: 'generate_follow_up_sequence',
          },
        } : {}),
      });

      // Parse JSON response
      try {
        const jsonMatch = response.content?.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const sequence = JSON.parse(jsonMatch[0]) as FollowUpStep[];
          return sequence.map(step => ({ ...step, subject: personalizeLeadEmail(step.subject, lead), body: personalizeLeadEmail(step.body, lead) }));
        }
      } catch (parseError) {
        logger.error({ err: parseError }, '[GmailApiService] Error parsing follow-up sequence:');
      }

      // Fallback sequence
      return [
        {
          stepNumber: 1,
          delayDays: 3,
          subject: `Following up - ${lead.company || 'opportunity'}`,
          body: `Hi ${lead.firstName || 'there'},\n\nI wanted to follow up on my previous email. I know you're busy, so I'll keep this brief.\n\nWould a quick 15-minute call work for you this week?\n\nBest,`,
          triggerCondition: 'no_reply',
        },
        {
          stepNumber: 2,
          delayDays: 5,
          subject: 'Quick thought for you',
          body: `Hi ${lead.firstName || 'there'},\n\nI had another thought that might be relevant for ${lead.company || 'your team'}.\n\nMany companies in ${lead.industry || 'your industry'} are seeing great results with our approach.\n\nWorth a quick conversation?\n\nBest,`,
          triggerCondition: 'no_reply',
        },
        {
          stepNumber: 3,
          delayDays: 7,
          subject: 'Should I close your file?',
          body: `Hi ${lead.firstName || 'there'},\n\nI haven't heard back, so I'll assume the timing isn't right.\n\nI'll close out your file for now, but feel free to reach out whenever makes sense.\n\nWishing you the best,`,
          triggerCondition: 'no_reply',
        },
      ];
    } catch (error) {
      logger.error({ err: error }, '[GmailApiService] generateFollowUpSequence error:');
      return [];
    }
  }

  /**
   * Send bulk emails
   */
  async sendBulkEmails(
    userId: number,
    leads: LeadInfo[],
    options: {
      subject: string;
      body: string;
      isHtml?: boolean;
      campaignId?: number;
      delayBetweenEmails?: number;
    },
    onProgress?: (result: SendEmailResult, index: number, total: number) => void
  ): Promise<SendEmailResult[]> {
    const results: SendEmailResult[] = [];
    const delay = options.delayBetweenEmails || 2000;

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];

      try {
        // Replace tokens in template
        const tokens = await resolveLeadEmailTokens(userId, lead, [options.subject, options.body]);
        const personalizedSubject = renderLeadEmailField(options.subject, tokens);
        const personalizedBody = renderLeadEmailField(options.body, tokens, options.isHtml === true);

        const result = await this.sendEmail(userId, {
          to: lead.email,
          toName: lead.fullName || `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
          subject: personalizedSubject,
          body: personalizedBody,
          isHtml: options.isHtml,
          leadId: lead.id,
          campaignId: options.campaignId,
          sequenceStep: 1,
        });

        results.push(result);
        if (result.code === 'ASSISTANT_SETUP_REQUIRED') break;

        if (onProgress) {
          onProgress(result, i, leads.length);
        }

        // Delay between emails
        if (i < leads.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        const errorResult: SendEmailResult = {
          success: false,
          error: error.message || 'Failed to send email',
        };
        results.push(errorResult);

        if (onProgress) {
          onProgress(errorResult, i, leads.length);
        }
      }
    }

    return results;
  }

  /**
   * Mark messages as read
   */
  async markAsRead(userId: number, messageIds: string[]): Promise<void> {
    try {
      const gmail = await this.getGmailClient(userId);
      if (!gmail) return;

      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: messageIds,
          removeLabelIds: ['UNREAD'],
        },
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[GmailApiService] Error marking as read:');
    }
  }

  /**
   * Get thread messages
   */
  async getThreadMessages(userId: number, threadId: string): Promise<GmailMessage[]> {
    try {
      const gmail = await this.getGmailClient(userId);
      if (!gmail) return [];

      const response = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      });

      const messages: GmailMessage[] = [];
      for (const msg of response.data.messages || []) {
        const parsed = this.parseGmailMessage(msg);
        if (parsed) {
          messages.push(parsed);
        }
      }

      return messages;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[GmailApiService] Error getting thread:');
      return [];
    }
  }
}

// Export class for named import compatibility
export { GmailApiService };

export const gmailApiService = GmailApiService.getInstance();
