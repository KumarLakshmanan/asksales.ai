import { resolveResendBusiness } from '../tenancy/emailWebhookScope.js';
import { withBusinessScope,requireBusinessScope } from '../tenancy/businessContext.js';
import {recordAutomationReceipt} from '../services/automations/AutomationReceipts.js';
/**
 * Resend Webhook Controller
 * Handles inbound Resend webhook events (email delivered, bounced, domain verified, etc.)
 * Delegates inbound email processing to the shared InboundEmailService.
 */

import type { Request, Response } from 'express';
import { db } from '../models/db';
import { resendDomainsTable } from '../models/resendDomains/schema';
import { eq, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import {
  processInboundEmail,
  updateEmailDeliveryStatus,
  recordEmailClick,
  publishEmailStatusEvent,
  extractEmailFromUnknown,
  extractNameFromUnknown,
  extractEmailsFromUnknown,
  isLikelyEmail,
} from '../services/InboundEmailService';
import type { InboundEmailAttachment } from '../services/InboundEmailService';

// ─── Resend-Specific Webhook Verification ───────────────────────────────────────

/**
 * Verify Resend webhook signature (svix-based)
 */
export function verifyResendSvixSignature(
  payload: string,
  headers: Record<string, string>,
  secret: string,
  nowMs = Date.now(),
): boolean {
  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const timestampSeconds = Number(svixTimestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowMs / 1000 - timestampSeconds) > 5 * 60) {
    logger.warn('[ResendWebhook] Rejected stale or invalid webhook timestamp');
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (secretBytes.length === 0) return false;
  const computedSignature = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  const expectedBuffer = Buffer.from(computedSignature);
  return svixSignature.split(' ').some((value) => {
    const candidateBuffer = Buffer.from(value.replace(/^v1,/, ''));
    return candidateBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
  });
}

async function verifyWebhookSignature(payload: string, headers: Record<string, string>): Promise<boolean> {
  const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions.js');
  const adminCred = await getActiveAdminCredential('resend');
  const dbSecret = adminCred?.config?.webhookSecret as string | undefined;

  const secret = dbSecret || process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('[ResendWebhook] Webhook secret is not configured; rejecting external events');
    return false;
  }

  return verifyResendSvixSignature(payload, headers, secret);
}

/**
 * Map Resend event type to outreach message status
 */
function mapEventToStatus(eventType: string): string | null {
  switch (eventType) {
    case 'email.sent': return 'sent';
    case 'email.delivered': return 'delivered';
    case 'email.bounced': return 'bounced';
    case 'email.complained': return 'bounced';
    case 'email.opened': return 'read';
    default: return null;
  }
}
async function reconcileAutomationEmailReceipt(event:Record<string,any>,status:string) {
  const scope=requireBusinessScope();
  const accountId=extractEmailFromUnknown(event.data?.from).split('@')[1]?.toLowerCase();
  if (accountId && event.data?.email_id) await recordAutomationReceipt(scope.userId,{channel:'email',accountId,messageId:event.data.email_id,status});
}

// ─── Resend-Specific: Fetch Full Email via Receiving API ────────────────────

interface ResendEmailContent {
  senderEmail: string;
  senderDisplayName: string;
  body: string;
  htmlBody?: string;
  parentMessageId: string;
  references: string;
  attachments: InboundEmailAttachment[];
  /** Lowercase header name → value map for spam/promo detection */
  rawHeaders: Record<string, string>;
}

async function fetchResendEmailContent(
  receivedEmailId: string,
  fallbackSenderEmail: string,
  fallbackSenderName: string,
): Promise<ResendEmailContent> {
  let senderEmail = fallbackSenderEmail;
  let senderDisplayName = fallbackSenderName;
  let body = `Reply from ${fallbackSenderEmail}`;
  let htmlBody: string | undefined;
  let parentMessageId = '';
  let references = '';
  const attachments: InboundEmailAttachment[] = [];
  const rawHeaders: Record<string, string> = {};

  try {
    const { Resend } = await import('resend');
    const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions');
    const adminCred = await getActiveAdminCredential('resend');
    const apiKey = adminCred?.apiKey;

    if (apiKey && receivedEmailId) {
      const resend = new Resend(apiKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: receivedEmail } = await (resend.emails as any).receiving.get(receivedEmailId);

      if (receivedEmail?.from) {
        if (!isLikelyEmail(senderEmail)) {
          senderEmail = extractEmailFromUnknown(receivedEmail.from);
        }
        if (!senderDisplayName || isLikelyEmail(senderDisplayName)) {
          const enrichedName = extractNameFromUnknown(receivedEmail.from);
          if (enrichedName) senderDisplayName = enrichedName;
        }
      }

      if (receivedEmail?.text) {
        body = receivedEmail.text;
        if (receivedEmail?.html) {
          htmlBody = receivedEmail.html;
        }
      } else if (receivedEmail?.html) {
        htmlBody = receivedEmail.html;
        body = receivedEmail.html.replace(/<[^>]*>/g, '').trim();
      }

      const headers = receivedEmail?.headers;
      if (Array.isArray(headers)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parentMessageId = headers.find((h: any) => h.name?.toLowerCase() === 'in-reply-to')?.value || '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        references = headers.find((h: any) => h.name?.toLowerCase() === 'references')?.value || '';
        // Collect all headers into rawHeaders map (lowercase key)
        for (const h of headers) {
          if (h.name && h.value) rawHeaders[h.name.toLowerCase()] = h.value;
        }
      } else if (headers && typeof headers === 'object') {
        parentMessageId = headers['In-Reply-To'] || headers['in-reply-to'] || '';
        references = headers['References'] || headers['references'] || '';
        for (const [k, v] of Object.entries(headers)) {
          rawHeaders[k.toLowerCase()] = String(v);
        }
      }

      // Extract attachments from Resend Receiving API response
      if (Array.isArray(receivedEmail?.attachments)) {
        for (const att of receivedEmail.attachments) {
          try {
            const filename = att.filename || att.name || 'attachment';
            const contentType = att.content_type || att.contentType || 'application/octet-stream';
            let buffer: Buffer;

            if (att.content && typeof att.content === 'string') {
              // Base64-encoded content
              buffer = Buffer.from(att.content, 'base64');
            } else if (att.url && typeof att.url === 'string') {
              // Download from URL
              const resp = await fetch(att.url);
              if (!resp.ok) continue;
              buffer = Buffer.from(await resp.arrayBuffer());
            } else {
              continue;
            }

            attachments.push({
              filename,
              contentType,
              data: buffer,
              size: buffer.length,
            });
          } catch (attErr) {
            logger.warn({ err: attErr, filename: att.filename }, '[ResendWebhook] Failed to download attachment');
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, '[ResendWebhook] Could not fetch email body/headers from Resend Receiving API');
  }

  return { senderEmail, senderDisplayName, body, htmlBody, parentMessageId, references, attachments, rawHeaders };
}

// ─── Main Webhook Handler ───────────────────────────────────────────────────────

/**
 * POST /api/resend/webhook
 * Main webhook handler for all Resend events.
 */
export async function handleResendWebhook(req: Request, res: Response) {
  try {
    const rawBodyBuffer = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBodyBuffer?.length) {
      logger.warn('[ResendWebhook] Raw request body unavailable; signature cannot be verified');
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }
    const rawBody = rawBodyBuffer.toString('utf8');
    const headers = req.headers as Record<string, string>;

    if (!(await verifyWebhookSignature(rawBody, headers))) {
      logger.warn('[ResendWebhook] Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;
    const eventType = event?.type;
    const scope = await resolveResendBusiness(event, extractEmailsFromUnknown(event?.data?.to));
    if (!scope) return res.status(202).json({ received:true, routed:false });
    return await withBusinessScope(scope, async () => {

    logger.info({ eventType }, '[ResendWebhook] Received event');

    switch (eventType) {
      // ── Domain events ─────────────────────────────────────────────────────
      case 'domain.updated': {
        const domainData = event.data;
        if (domainData?.id) {
          await db
            .update(resendDomainsTable)
            .set({ status: domainData.status || 'pending', updatedAt: new Date() })
            .where(eq(resendDomainsTable.resendDomainId, domainData.id));

          logger.info({ domainId: domainData.id, status: domainData.status }, '[ResendWebhook] Domain status updated');
        }
        break;
      }

      // ── Delivery status events ────────────────────────────────────────────
      case 'email.sent':
      case 'email.delivered':
      case 'email.delivery_delayed':
      case 'email.bounced':
      case 'email.complained': {
        const emailData = event.data;
        const resendEmailId = emailData?.email_id;
        logger.info({ emailId: resendEmailId, type: eventType }, '[ResendWebhook] Email event');

        const status = mapEventToStatus(eventType);
        if (status && resendEmailId) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const additionalData: any = {};
            if (eventType === 'email.bounced' || eventType === 'email.complained') {
              additionalData.errorMessage = emailData?.bounce_type || emailData?.complaint_type || eventType;
            }
            await updateEmailDeliveryStatus(resendEmailId, status, additionalData);
            await reconcileAutomationEmailReceipt(event,status);
            const supportStatus = eventType === 'email.sent' ? 'accepted'
              : eventType === 'email.delivered' ? 'delivered'
                : eventType === 'email.delivery_delayed' ? 'uncertain' : 'failed';
            await db.execute(sql`SELECT reconcile_support_notification_provider_delivery(
              ${resendEmailId}, ${supportStatus}, NOW(), ${additionalData.errorMessage || null})`);
          } catch (err) {
            logger.error({ err }, '[ResendWebhook] Failed to update outreach message status');
            // Do not acknowledge a delivery receipt we failed to persist.
            // Provider retry is safe because milestone reconciliation is idempotent.
            return res.status(503).json({ error: 'Delivery status could not be recorded. Retry this event.' });
          }
        }

        await publishEmailStatusEvent(eventType, { emailId: resendEmailId, ...emailData });
        break;
      }

      // ── Email opened ──────────────────────────────────────────────────────
      case 'email.opened': {
        const trackingData = event.data;
        const resendEmailId = trackingData?.email_id;
        logger.info({ emailId: resendEmailId, type: eventType }, '[ResendWebhook] Email opened');

        if (resendEmailId) {
          try {
            await updateEmailDeliveryStatus(resendEmailId, 'read', { readAt: new Date() });
            await reconcileAutomationEmailReceipt(event,'read');
            await db.execute(sql`SELECT reconcile_support_notification_provider_delivery(
              ${resendEmailId}, 'read', NOW(), NULL)`);
          } catch (err) {
            logger.error({ err }, '[ResendWebhook] Failed to update message read status');
            return res.status(503).json({ error: 'Read status could not be recorded. Retry this event.' });
          }
        }
        break;
      }

      // ── Email clicked ─────────────────────────────────────────────────────
      case 'email.clicked': {
        const trackingData = event.data;
        const resendEmailId = trackingData?.email_id;
        logger.info({ emailId: resendEmailId, type: eventType, link: trackingData?.click?.link }, '[ResendWebhook] Email clicked');

        if (resendEmailId) {
          try {
            await recordEmailClick(resendEmailId, trackingData?.click?.link || '');
          } catch (err) {
            logger.error({ err }, '[ResendWebhook] Failed to update message click data');
          }
        }
        break;
      }

      // ── Inbound email (reply detection) ───────────────────────────────────
      case 'email.received': {
        const receivedData = event.data;
        const receivedEmailId = receivedData?.email_id;
        const senderRaw = receivedData?.from || '';
        const subject = receivedData?.subject || '';
        const messageId = receivedData?.message_id || '';
        const toRaw = receivedData?.to;

        const rawSenderEmail = extractEmailFromUnknown(senderRaw);
        const rawSenderName = extractNameFromUnknown(senderRaw);
        const recipientEmails = extractEmailsFromUnknown(toRaw);

        // Fetch full email content from Resend Receiving API
        const emailContent = await fetchResendEmailContent(receivedEmailId, rawSenderEmail, rawSenderName);

        // Delegate to common inbound email service
        const result = await processInboundEmail({
          provider: 'resend',
          externalMessageId: messageId || receivedEmailId || '',
          senderEmail: emailContent.senderEmail || rawSenderEmail,
          senderDisplayName: emailContent.senderDisplayName || rawSenderName,
          subject,
          body: emailContent.body,
          htmlBody: emailContent.htmlBody,
          inReplyTo: emailContent.parentMessageId,
          references: emailContent.references,
          recipientEmails,
          attachments: emailContent.attachments.length > 0 ? emailContent.attachments : undefined,
          rawHeaders: emailContent.rawHeaders,
        });

        if (!result.success && !result.duplicate && !result.skipped) {
          logger.warn({ error: result.error, senderEmail: rawSenderEmail }, '[ResendWebhook] Inbound email processing failed');
        }
        break;
      }

      default:
        logger.info({ eventType }, '[ResendWebhook] Unhandled event type');
    }

    return res.json({ received: true });
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendWebhook] Error processing webhook');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
