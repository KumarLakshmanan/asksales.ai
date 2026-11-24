import type { TemplateRenderContext } from '../../shared/templateRenderContext.js';
import { assertRecipientNotSuppressed } from './outreach/RecipientSuppressionService.js';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, deliverySetupFailure, withCustomerDeliveryReceipt } from './assistants/CustomerDeliveryGate.js';
import { isInternalEmailDelivery } from './InternalEmailDelivery.js';
/**
 * Email delivery through verified Resend and Gmail OAuth accounts.
 */
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { LLMProviderFactory } from './agents/LLMProviderFactory';
import { knowledgeGateway } from './knowledge/KnowledgeGateway.js';
import * as OutreachConversationModel from '../models/outreachConversations/functions';
import { logger } from '../utils/logger.js';
import { DEFAULT_LLM_TEMPERATURE, EMAIL_GENERATION_MAX_TOKENS } from '../utils/llmConstants';
import { randomUUID, createHash } from 'node:crypto';
import { currentAssistant } from './assistants/AssistantContext.js';
import { assertAssistantFresh } from './assistants/AssistantFreshness.js';
import { providerMessageId as normalizeProviderMessageId } from './outreach/deliveryOutcome.js';
import { emailBodyToHtml, stripEmailPlaceholders } from '../../shared/emailFormatting.js';
import { personalizeLeadEmail } from '../utils/personalization.js';
import { unresolvedEmailTemplateVariables } from '../utils/emailTemplateVariables.js';
import { resolveLeadEmailTokens, renderLeadEmailField } from './content/EmailTemplatePersonalizationService.js';

// Lead info interface for personalization
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
  customFields?: Record<string, string>;
}

interface EmailOptions {
  /** Campaign-owned replies retain their original presentation and brand context. */
  preservePresentation?: boolean;
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachments?: any[];
  replyTo?: string;
  leadId?: number;
  campaignId?: number;
  sequenceStep?: number;
  userId?: number;
  // Threading headers for email replies
  inReplyTo?: string;  // Message-ID of the email we're replying to
  references?: string; // Chain of Message-IDs for threading
  threadId?: string;   // Gmail thread ID for reply threading
  // Sender info (from email_senders table)
  fromName?: string;   // Display name for the sender
  fromEmail?: string;  // Email address for the sender (e.g., sales@yourdomain.com)
  // Skip saving to outreach conversations (when caller already handles it)
  skipConversationLog?: boolean;
  // Caller already reserved/deducted the outreach credit before provider send.
  skipCreditDeduction?: boolean;
  // Follow-up tracking: mark the sent_messages record as a follow-up to prevent re-processing
  isFollowUp?: boolean;
  followUpStep?: number;
  /** Stable durable send-intent key forwarded only to providers that support it. */
  idempotencyKey?: string;
  templateRenderContext?: TemplateRenderContext;
  senderId?: number;
  /** Reviewed delivery identity; any field requires the complete bound receipt. */
  expectedFromEmail?: string;
  expectedProviderAccountId?: string;
  expectedCredentialId?: number;
  /** Brand saved on the campaign/conversation. Omitted only for items without one (default brand). */
  brandToolkitId?: number | null;
}

export interface SendEmailResult {
  success: boolean;
  code?: string;
  reason?: string;
  setupUrl?: string;
  assistantId?: string;
  /** Legacy provider/native ID retained for existing webhook callers. */
  messageId?: string;
  providerMessageId?: string;
  rfcMessageId?: string;
  threadId?: string;
  error?: string;
  deliveryAttempted?:boolean;
  outcomeUncertain?:boolean;
  retryable?:boolean;
  retryAt?: string;
}

/**
 * Accept only an actual RFC Message-ID. Provider/API IDs must never be converted
 * into guessed Message-ID header values.
 */
function normalizeToRfc5322MessageId(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  return /^<[^<>@\s]+@[^<>\s]+>$/.test(id) ? id : undefined;
}

/**
 * Normalize a References header value which may contain multiple space-separated Message-IDs.
 * Each ID is individually normalized to RFC5322 format. Invalid IDs are dropped.
 */
function normalizeReferenceChain(refs: string | undefined | null): string | undefined {
  if (!refs) return undefined;
  const ids = refs.match(/<[^<>@\s]+@[^<>\s]+>/g) || [];
  return ids.length > 0 ? ids.join(' ') : undefined;
}

class EmailService {
  /**
   * Send personalized email to a lead with template replacement
   * Uses verified Resend or Gmail OAuth credentials
   */
  async sendPersonalizedEmail(
    leadId: number,
    subject: string,
    htmlTemplate: string,
    campaignId?: number,
    sequenceStep?: number,
    userId?: number,
    extraOptions?: {
      text?: string;
      idempotencyKey?: string;
      inReplyTo?: string;
      references?: string;
      threadId?: string;
      senderId?: number;
      skipCreditDeduction?: boolean;
      skipConversationLog?: boolean;
      attachments?: Array<{ content: Buffer; contentType: string; filename: string; contentId?: string }>;
    }
  ): Promise<SendEmailResult> {
    try {
      // Fetch lead data
      const leadResult = userId
        ? await db.execute(sql`
            SELECT * FROM leads WHERE id = ${leadId} AND user_id = ${userId}
          `)
        : await db.execute(sql`
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
      // Assistant output is already privacy-controlled. Never expand model text
      // with raw lead fields; approved template substitution has its own boundary.
      const tokens = currentAssistant() ? null : await resolveLeadEmailTokens(userId || lead.user_id, lead, [htmlTemplate, subject, extraOptions?.text]);
      const personalizedHtml = tokens ? renderLeadEmailField(htmlTemplate, tokens, true) : htmlTemplate;
      const personalizedSubject = tokens ? renderLeadEmailField(subject, tokens) : subject;

      // Get the user ID from lead's owner if not provided
      const effectiveUserId = userId || lead.user_id;

      // If this is a reply (inReplyTo is set), mark is_reply=true so the cron does not pick it
      // up as a fresh original message to follow up on.
      const isReplyEmail = !!extraOptions?.inReplyTo;

      // Try to use user-specific credentials if available
      if (effectiveUserId) {
        const userCredsResult = await this.sendEmailWithUserCredentials(
          effectiveUserId,
          {
            to: lead.email,
            toName: lead.full_name || lead.name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
            subject: personalizedSubject,
            idempotencyKey: extraOptions?.idempotencyKey,
            html: personalizedHtml,
            text: extraOptions?.text ? tokens ? renderLeadEmailField(extraOptions.text, tokens) : extraOptions.text : undefined,
            leadId,
            campaignId,
            sequenceStep,
            inReplyTo: extraOptions?.inReplyTo,
            references: extraOptions?.references,
            threadId: extraOptions?.threadId,
            skipCreditDeduction: extraOptions?.skipCreditDeduction,
            skipConversationLog: extraOptions?.skipConversationLog,
            attachments: extraOptions?.attachments,
            // Mark as reply so is_reply=true is set in sent_messages — prevents cron from
            // treating this manual/smart reply as a new original message to follow up on.
            isFollowUp: isReplyEmail,
          },
          extraOptions?.senderId
        );

        return userCredsResult;
      }

      // No Resend or Gmail OAuth credentials configured for this user — reject.
      // Outreach emails must use Resend or Gmail OAuth, not raw SMTP.
      return { success: false, error: 'No email credentials configured for user. Please connect Resend or Gmail in Settings → Integrations.' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EmailService] Error sending personalized email');
      return { success: false, error: error.message };
    }
  }

  /**
   * Send email using user's configured email provider.
   * If senderId is provided, uses that specific sender account.
   * Otherwise uses the user's configured default sender.
   */
  async sendEmailWithUserCredentials(
    userId: number,
    options: EmailOptions,
    senderId?: number
  ): Promise<SendEmailResult> {
    try {
      if (!isInternalEmailDelivery()) assertCustomerDeliveryRuntime('email');
      await assertRecipientNotSuppressed(userId,'email',options.to);
      const unresolved = unresolvedEmailTemplateVariables(options);
      if (unresolved.length) return { success: false, error: `Missing email personalization values: ${unresolved.join(', ')}`, deliveryAttempted: false, outcomeUncertain: false, retryable: false };
      const hasReviewedBinding=options.expectedFromEmail!==undefined || options.expectedProviderAccountId!==undefined || options.expectedCredentialId!==undefined;
      if (hasReviewedBinding && (!senderId || !options.expectedFromEmail || !options.expectedProviderAccountId
        || !Number.isSafeInteger(options.expectedCredentialId) || options.expectedCredentialId!<=0))
        return {success:false,error:'A complete reviewed email sending account is required.',deliveryAttempted:false,outcomeUncertain:false};
      const assistant=currentAssistant();
      if (assistant) {
        await assertAssistantFresh();
        if (assistant.preview || assistant.provenance.channel !== 'email' || !senderId) {
          return {success:false,error:'An exact verified assistant email account is required.'};
        }
      }
      // Accept only real RFC Message-ID header values before routing to a
      // provider. Provider-native/API IDs are intentionally discarded here.
      const normalizedOptions: EmailOptions = {
        ...options,
        html: emailBodyToHtml(options.html),
        inReplyTo: normalizeToRfc5322MessageId(options.inReplyTo),
        references: normalizeReferenceChain(options.references)
          ?? normalizeToRfc5322MessageId(options.inReplyTo),
      };

      if (!isInternalEmailDelivery() && !options.preservePresentation && !/<!doctype\s+html/i.test(normalizedOptions.html)) {
        const { prepareDesignedEmail } = await import('./EmailDesignService.js');
        // Campaign sends without an explicit brand still use the brand saved on their campaign.
        let brandToolkitId = options.brandToolkitId;
        if (brandToolkitId == null && options.campaignId) {
          const { campaignBrandToolkitId } = await import('./outreach/WorkflowBrand.js');
          brandToolkitId = await campaignBrandToolkitId(userId, options.campaignId);
        }
        normalizedOptions.html = await prepareDesignedEmail(userId, normalizedOptions.html, assistant ? 'assistant' : 'outreach', undefined, brandToolkitId);
      }

      // If a specific sender is requested, use it
      if (senderId) {
        const { getById } = await import('../models/emailSenders/functions');
        const sender = await getById(userId, senderId);
        if (assistant && (!sender || !sender.isVerified || sender.email.toLowerCase() !== assistant.provenance.accountId)) {
          return {success:false,error:'The original assistant email account changed or is unavailable.'};
        }
        if (assistant && sender && sender.type !== 'resend' && !sender.credentialId) {
          return {success:false,error:'The original Gmail credential binding is unresolved. Reconnect that same account.'};
        }
        if (hasReviewedBinding) {
          try {
            if (!sender?.isVerified || sender.email.toLowerCase()!==options.expectedFromEmail!.toLowerCase()
              || !['gmail','resend'].includes(sender.type) || (sender.type==='gmail'&&!sender.credentialId))
              return {success:false,error:'The reviewed email sender changed or is unavailable.',deliveryAttempted:false,outcomeUncertain:false};
            const {resolveOfficialProviderBinding}=await import('./outreach/ProviderBindingService.js');
            const binding=await resolveOfficialProviderBinding(userId,'email',{
              providerVariant:sender.type as 'gmail'|'resend',
              ...(sender.type==='gmail'?{credentialId:sender.credentialId!}:{providerAccountId:sender.email.split('@')[1]?.toLowerCase()}),
            });
            if (!binding || binding.providerAccountId!==options.expectedProviderAccountId || binding.credentialId!==options.expectedCredentialId)
              return {success:false,error:'The reviewed email provider binding changed or disconnected.',deliveryAttempted:false,outcomeUncertain:false};
          } catch(error) {
            logger.warn({err:error},'[EmailService] Reviewed email account could not be revalidated');
            return {success:false,error:'The reviewed email sending account could not be verified. Review it before sending.',deliveryAttempted:false,outcomeUncertain:false};
          }
        }
        if (sender) {
          if (!sender.isVerified) return {success:false,error:'The requested email sender is no longer verified.',deliveryAttempted:false,outcomeUncertain:false};
          // Inject sender info into normalizedOptions
          const optionsWithSender = {
            ...normalizedOptions, senderId: sender.id,
            fromName: sender.displayName || sender.label,
            fromEmail: sender.email,
          };
          const receipt = !isInternalEmailDelivery() ? await assertCustomerDeliveryReady({ userId, channel: 'email', accountId: sender.email }) : undefined;
          if (sender.type === 'resend') {
            return receipt ? withCustomerDeliveryReceipt(receipt, () => this.sendEmailViaResend(userId, optionsWithSender)) : this.sendEmailViaResend(userId, optionsWithSender);
          }
          return receipt ? withCustomerDeliveryReceipt(receipt, () => this.sendEmailViaGmailOAuth(userId, optionsWithSender, sender.credentialId ?? undefined)) : this.sendEmailViaGmailOAuth(userId, optionsWithSender, sender.credentialId ?? undefined);
        }
        return {success:false,error:'The requested email sender is unavailable. Reconnect that account before sending.'};
      }

      // Try default sender from email_senders table
      const { getDefault } = await import('../models/emailSenders/functions');
      const defaultSender = await getDefault(userId);
      if (defaultSender) {
        if (!defaultSender.isVerified) return { success: false, error: 'The default sender is not verified.', deliveryAttempted: false, outcomeUncertain: false };
        // Inject default sender info into normalizedOptions
        const optionsWithSender = {
          ...normalizedOptions, senderId: defaultSender.id,
          fromName: defaultSender.displayName || defaultSender.label,
          fromEmail: defaultSender.email,
        };
        const receipt = !isInternalEmailDelivery() ? await assertCustomerDeliveryReady({ userId, channel: 'email', accountId: defaultSender.email }) : undefined;
        if (defaultSender.type === 'resend') {
          return receipt ? withCustomerDeliveryReceipt(receipt, () => this.sendEmailViaResend(userId, optionsWithSender)) : this.sendEmailViaResend(userId, optionsWithSender);
        }
        return receipt ? withCustomerDeliveryReceipt(receipt, () => this.sendEmailViaGmailOAuth(userId, optionsWithSender, defaultSender.credentialId ?? undefined)) : this.sendEmailViaGmailOAuth(userId, optionsWithSender, defaultSender.credentialId ?? undefined);
      }

      // Legacy fallback: outreach_settings.emailProvider
      const { getOutreachSettingsByUserId } = await import('../models/outreachSettings/functions');
      const settings = await getOutreachSettingsByUserId(userId);
      const provider = settings?.emailProvider || 'gmail';

      if (provider === 'resend') {
        const resendResult = await this.sendEmailViaResend(userId, normalizedOptions);
        if (resendResult.success || resendResult.error !== 'No verified Resend domain for user') {
          return resendResult;
        }
        return { success: false, error: 'Resend is enabled but no verified domain found. Please verify your domain in Email Integration settings.' };
      }

      // provider === 'gmail' → use Gmail OAuth API
      const gmailResult = await this.sendEmailViaGmailOAuth(userId, normalizedOptions);
      if (gmailResult.success || gmailResult.error !== 'Gmail OAuth not connected') {
        return gmailResult;
      }
      return { success: false, error: 'Gmail is enabled but not connected. Please connect your Gmail account in Email Integration settings.' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EmailService] Error sending email with user credentials');
      const setup = deliverySetupFailure(error);
      if (setup) return setup;
      return {
        success: false,
        error: error.message || 'Failed to send email with user credentials',
        deliveryAttempted:false,outcomeUncertain:false,retryable:false,
      };
    }
  }

  /**
   * Send email via Gmail OAuth (using Gmail API, not SMTP password)
   * @param credentialId Optional credential ID for multi-account support
   */
  private async sendEmailViaGmailOAuth(userId: number, options: EmailOptions, credentialId?: number): Promise<SendEmailResult> {
    try {
      const { GmailApiService } = await import('./gmailApiService');
      const gmailService = GmailApiService.getInstance();

      const connected = credentialId ? true : await gmailService.isConnected(userId);
      if (!connected) {
        return { success: false, error: 'Gmail OAuth not connected', deliveryAttempted: false, outcomeUncertain: false };
      }

      const result = await gmailService.sendEmail(userId, {
        to: options.to,
        toName: options.toName,
        subject: options.subject,
        idempotencyKey: options.idempotencyKey,
        body: options.html,
        isHtml: true,
        leadId: options.leadId,
        campaignId: options.campaignId,
        sequenceStep: options.sequenceStep,
        fromEmail: options.fromEmail,
        senderId: options.senderId,
        fromName: options.fromName,
        ...(credentialId && options.fromEmail ? { accountBinding: { credentialId, accountIdentifier: options.fromEmail } } : {}),
        // Forward threading info for proper Gmail reply threading
        // threadId = Gmail API thread ID (for requestBody.threadId)
        // inReplyTo = RFC5322 Message-ID (for In-Reply-To header, cross-client threading)
        // references = full chain of Message-IDs for RFC5322 References header
        threadId: options.threadId || undefined,
        inReplyTo: options.inReplyTo || undefined,
        references: options.references || undefined,
        // Follow-up flags so Gmail logSentEmail marks the record correctly
        isFollowUp: options.isFollowUp,
        followUpStep: options.followUpStep,
        // Forward skipConversationLog so gmailApiService skips creating outreach_messages
        // when the caller (e.g. outreach controller) already created the record
        skipConversationLog: options.skipConversationLog,
        skipCreditDeduction: options.skipCreditDeduction,
        attachments: options.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType || attachment.content_type,
          contentId: attachment.contentId,
        })),
      });

      if (result.success) {
        logger.info({ messageId: result.messageId }, '[EmailService] Email sent via Gmail OAuth');
        // Note: gmailApiService.sendEmail already logs to sent_messages AND
        // saves to outreach_conversations, so we do NOT create a duplicate here.
      }

      return {
        ...(result.code ? { code: result.code, reason: result.reason, setupUrl: result.setupUrl, assistantId: result.assistantId } : {}),
        success: result.success,
        messageId: result.messageId,
        providerMessageId: result.providerMessageId,
        rfcMessageId: result.rfcMessageId,
        threadId: result.threadId,
        error: result.error,
        deliveryAttempted:result.deliveryAttempted,
        outcomeUncertain:result.outcomeUncertain,
        retryable:result.retryable,
        retryAt: result.retryAt,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EmailService] Error sending email via Gmail OAuth');
      const setup = deliverySetupFailure(error);
      if (setup) return setup;
      return { success: false, error: error.message || 'Failed to send email via Gmail OAuth' };
    }
  }

  /**
   * Send email via Resend using a verified custom domain
   */
  private async sendEmailViaResend(userId: number, options: EmailOptions): Promise<SendEmailResult> {
    let deliveryAttempted=false;
    try {
      const { getVerifiedDomain, isVerifiedDomainForUser, sendEmail: resendSend } = await import('./resendService');
      const domain = await getVerifiedDomain(userId);

      if (!domain) {
        return { success: false, error: 'No verified Resend domain for user',deliveryAttempted:false,outcomeUncertain:false };
      }

      // Use sender info from options, fallback to defaults
      const fromName = options.fromName || 'Sales & Marketing';
      const fromEmail = options.fromEmail || `noreply@${domain.name}`;
      
      // Ensure the email uses a verified domain.
      // If the sender's domain matches any verified domain for this user, use it as-is.
      // Otherwise fall back to the first verified domain.
      let finalFromEmail = fromEmail;
      const emailDomain = fromEmail.split('@')[1];
      if (emailDomain !== domain.name) {
        const isVerified = await isVerifiedDomainForUser(userId, emailDomain);
        if (!isVerified) {
          if (options.fromEmail) return {success:false,error:'The selected sending domain is no longer verified.',deliveryAttempted:false,outcomeUncertain:false};
          finalFromEmail = `noreply@${domain.name}`;
        }
      }
      
      // Build threading headers for proper email replies
      const headers: Record<string, string> = {};
      // Resend's API response ID is not an RFC Message-ID. Assign the outgoing
      // message a real sender-controlled Message-ID and persist that exact value.
      const rfcMessageId = `<${options.idempotencyKey ? createHash('sha256').update(`${finalFromEmail}:${options.idempotencyKey}`).digest('hex') : randomUUID()}@${finalFromEmail.split('@')[1]}>`;
      headers['Message-ID'] = rfcMessageId;
      if (options.inReplyTo) {
        headers['In-Reply-To'] = options.inReplyTo;
        headers['References'] = options.references || options.inReplyTo;
      }
      
      deliveryAttempted=true;
      const result = await resendSend({
        from: `${fromName} <${finalFromEmail}>`,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        replyTo: options.replyTo,
        tags: [
          ...(options.leadId ? [{ name: 'lead_id', value: String(options.leadId) }] : []),
          ...(options.campaignId ? [{ name: 'campaign_id', value: String(options.campaignId) }] : []),
          ...(options.sequenceStep ? [{ name: 'sequence_step', value: String(options.sequenceStep) }] : []),
        ],
        // Pass attachments (PDF, images, etc.)
        attachments: options.attachments,
        // Pass threading headers if replying to an email
        ...(Object.keys(headers).length > 0 && { headers }),
        idempotencyKey: options.idempotencyKey,
      });

      const providerMessageId = normalizeProviderMessageId(result?.id);
      if (!providerMessageId) return { success: false,
        error: 'Resend did not return an acceptance receipt. Review provider history before retrying.',
        deliveryAttempted: true, outcomeUncertain: true, retryable: false };
      logger.info({ providerMessageId, rfcMessageId }, '[EmailService] Email sent via Resend');

      if (options.leadId) {
        await this.logSentEmail({
          leadId: options.leadId,
          messageId: providerMessageId,
          to: options.to,
          subject: options.subject,
          html: options.html,
          campaignId: options.campaignId,
          sequenceStep: options.sequenceStep,
          userId,
          channel: 'email',
          skipConversationLog: options.skipConversationLog,
          skipCreditDeduction: options.skipCreditDeduction,
          isFollowUp: options.isFollowUp,
          followUpStep: options.followUpStep,
          rfcMessageId, senderId: options.senderId, references: options.references,
          inReplyTo: options.inReplyTo,
        });
      }

      return {
        success: true,
        messageId: providerMessageId,
        providerMessageId,
        rfcMessageId,
        deliveryAttempted: true,
        outcomeUncertain: false,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      // If it's a "no domain" signal, bubble it up so caller can fallback
      if (error.message === 'No verified Resend domain for user') {
        return { success: false, error: error.message };
      }
      logger.error({ err: error }, '[EmailService] Error sending email via Resend');
      const setup = deliverySetupFailure(error);
      if (setup) return setup;
      const attempted = typeof error.deliveryAttempted === 'boolean' ? error.deliveryAttempted : deliveryAttempted;
      return { success: false, error: error.message || 'Failed to send email via Resend',deliveryAttempted: attempted,
        outcomeUncertain:error.outcomeUncertain ?? attempted,retryable:error.retryable===true };
    }
  }


  /**
   * Log sent email to database for tracking and save to outreach conversations
   */
  private async logSentEmail(data: {
    leadId: number;
    messageId: string;
    to: string;
    subject: string;
    html?: string;
    campaignId?: number;
    sequenceStep?: number;
    userId?: number;
    channel?: string;
    skipConversationLog?: boolean;
    skipCreditDeduction?: boolean;
    isFollowUp?: boolean;
    followUpStep?: number;
    rfcMessageId?: string;
    senderId?: number;
    references?: string;
    inReplyTo?: string;
  }): Promise<void> {
    try {
      const channel = data.channel || 'email';
      await db.execute(sql`
        INSERT INTO sent_messages (user_id, lead_id, lead_name, channel, subject, message, status, sent_at, message_id, campaign_id, sequence_step, is_reply, follow_up_step, sender_id, recipient_address, rfc_message_id, references_header)
        VALUES (
          ${data.userId || null},
          ${data.leadId},
          ${data.to},
          ${channel},
          ${data.subject},
          ${data.html || ''},
          'sent',
          NOW(),
          ${data.messageId},
          ${data.campaignId || null},
          ${data.sequenceStep || null},
          ${data.isFollowUp || false},
          ${data.followUpStep || null},
          ${data.senderId || null}, ${data.to}, ${data.rfcMessageId || null}, ${data.references || null}
        )
      `);

      // Deduct credits for outreach email
      if (data.userId && !data.skipCreditDeduction) {
        try {
          const { deductCreditsForOutreach } = await import('./CreditDeductionHooks.js');
          await deductCreditsForOutreach(data.userId, 'email', { messageId: data.messageId, service: 'EmailService' });
        } catch (_err) { /* credit deduction should not break email flow */ }
      }

      // Update lead's last contacted timestamp
      await db.execute(sql`
        UPDATE leads SET
          last_contacted_at = NOW(),
          messages_sent = COALESCE(messages_sent, 0) + 1,
          updated_at = NOW()
        WHERE id = ${data.leadId}
      `);

      // Save to outreach conversations for tracking (skip when caller already handles it)
      if (!data.skipConversationLog && data.userId && data.leadId) {
        try {
          await this.saveToOutreachConversation({ ...data, channel: 'email' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (convErr: any) {
          logger.error({ err: convErr }, '[EmailService] Error saving to outreach conversation');
        }
      }

      // Auto-create / update CRM contact (non-blocking): marks pipeline as 'contacted'
      if (data.userId && data.leadId) {
        import('./CRMService').then(({ crmService }) =>
          crmService.autoCreateContactOnOutreachSend(data.userId!, data.leadId, {
            source: data.channel || 'email',
          })
        ).catch(() => {});
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[EmailService] Error logging sent email');
    }
  }

  /**
   * Save a sent email to the outreach conversation system
   */
  private async saveToOutreachConversation(data: {
    leadId: number;
    messageId: string;
    to: string;
    subject: string;
    html?: string;
    campaignId?: number;
    sequenceStep?: number;
    userId?: number;
    channel?: string;
    rfcMessageId?: string;
    senderId?: number;
    references?: string;
    inReplyTo?: string;
    isFollowUp?: boolean;
  }): Promise<void> {
    // Get lead info for the conversation record
    const leadResult = await db.execute(sql`
      SELECT id, email, name, full_name, company FROM leads WHERE id = ${data.leadId} LIMIT 1
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = leadResult.rows[0] as any;
    if (!lead) return;

    const conversationChannel = data.channel || 'email';
    const existing = await OutreachConversationModel.getMessageByExternalId(data.messageId);
    if (existing) return;

    const parentMessage = data.inReplyTo
      ? await OutreachConversationModel.getMessageByExternalId(data.inReplyTo)
      : undefined;
    const parentConversation = parentMessage
      ? await OutreachConversationModel.getOutreachConversationById(parentMessage.conversationId)
      : undefined;
    const conversation = parentConversation
      || await OutreachConversationModel.createOutreachConversation({
        userId: data.userId!,
        leadId: data.leadId,
        channel: conversationChannel === 'gmail' ? 'email' : conversationChannel,
        leadName: lead.full_name || lead.name || data.to,
        leadEmail: lead.email || data.to,
        leadCompany: lead.company || undefined,
        status: 'active',
        subject: data.subject || undefined,
        integrationProvider: 'resend',
      });

    // Determine what to show in the conversation bubble.
    // The html may be a full branded email (<!DOCTYPE …>) — rendering the entire
    // email template inside a narrow chat bubble looks broken.
    // Store only the core reply content for display purposes.
    const isFullEmailHtml = typeof data.html === 'string' && data.html.trim().toLowerCase().startsWith('<!doctype');
    const chatHtmlContent = isFullEmailHtml ? undefined : (data.html || undefined);
    const chatPlainText = (data.html || data.subject || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000) || data.subject;

    await OutreachConversationModel.createOutreachMessage({
      conversationId: conversation.id,
      userId: data.userId,
      direction: 'outbound',
      subject: data.subject,
      content: chatPlainText,
      htmlContent: chatHtmlContent,
      externalMessageId: data.messageId,
      providerMessageId: data.messageId,
      rfcMessageId: data.rfcMessageId,
      status: 'sent',
      sentAt: new Date(),
      campaignId: data.campaignId,
      sequenceStep: data.sequenceStep,
      messageKind: data.isFollowUp || data.inReplyTo ? 'reply' : 'outreach',
    });
  }

  /**
   * Generate AI-personalized email using LLM
   * Similar to Personalised_EMail_langGraph's email generation approach
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
          logger.warn({ err: kbErr }, '[EmailService] Error fetching KB context');
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
        temperature: DEFAULT_LLM_TEMPERATURE,
        max_tokens: EMAIL_GENERATION_MAX_TOKENS,
        loggingContext: {
          userId: userId!,
          purpose: 'personalized_email_generation',
          service: 'EmailService',
          action: 'generate_personalized_email',
        },
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
        logger.error({ err: parseError }, '[EmailService] Error parsing LLM response');
      }

      // Fallback
      return {
        subject: `Quick question for ${lead.firstName || 'you'}`,
        body: `Hi ${lead.firstName || 'there'},\n\nI came across ${lead.company || 'your company'} and thought there might be a great opportunity to connect.\n\nWould you be open to a quick chat this week?\n\nBest regards`,
      };
    } catch (error) {
      logger.error({ err: error }, '[EmailService] generatePersonalizedEmail error');
      return {
        subject: `Quick question for ${lead.firstName || 'you'}`,
        body: `Hi ${lead.firstName || 'there'},\n\nI came across ${lead.company || 'your company'} and thought there might be a great opportunity to connect.\n\nWould you be open to a quick chat this week?\n\nBest regards`,
      };
    }
  }

}

export const emailService = new EmailService();
