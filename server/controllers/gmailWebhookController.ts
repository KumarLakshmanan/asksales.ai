import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
/**
 * Gmail Pub/Sub Webhook Controller
 * Handles Google Cloud Pub/Sub push notifications for Gmail.
 * Processes new inbound messages via the shared InboundEmailService.
 *
 * NOTE: This endpoint is mounted WITHOUT auth middleware — Google Pub/Sub
 * cannot send JWT tokens. Authentication uses a token query parameter
 * validated against the admin-configured webhookSecret.
 */

import type { Request, Response } from 'express';
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import {
  processInboundEmail,
} from '../services/InboundEmailService';
import type { InboundEmailAttachment } from '../services/InboundEmailService';

import type { gmail_v1 } from 'googleapis';
import { queueGmailNotification, type GmailSyncCredential } from '../services/GmailMailboxSyncService.js';
import { guardGmailClient } from '../services/GmailCooldownService.js';
import { timingSafeEqual } from '../utils/secureCompare.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface GmailPubSubNotification {
  emailAddress: string;
  historyId: string;
}

interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface ParsedGmailMessage {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  labelIds: string[];
  attachmentMetas: GmailAttachmentMeta[];
  rawHeaders: Record<string, string>;
  containsCalendarEvent: boolean;
}

// ─── Gmail Message Parsing ──────────────────────────────────────────────────────

function getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function extractBodyFromParts(part: gmail_v1.Schema$MessagePart): { text: string; html: string; attachments: GmailAttachmentMeta[] } {
  let text = '';
  let html = '';
  const attachments: GmailAttachmentMeta[] = [];

  // Check if this part is an attachment (has filename and attachmentId)
  if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
    attachments.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType || 'application/octet-stream',
      size: part.body.size || 0,
    });
  } else if (part.mimeType === 'text/plain' && part.body?.data) {
    text = Buffer.from(part.body.data, 'base64').toString('utf-8');
  } else if (part.mimeType === 'text/html' && part.body?.data) {
    html = Buffer.from(part.body.data, 'base64').toString('utf-8');
  }

  if (part.parts) {
    for (const child of part.parts) {
      const childResult = extractBodyFromParts(child);
      if (!text && childResult.text) text = childResult.text;
      if (!html && childResult.html) html = childResult.html;
      attachments.push(...childResult.attachments);
    }
  }

  return { text, html, attachments };
}

function parseGmailApiMessage(message: gmail_v1.Schema$Message): ParsedGmailMessage | null {
  if (!message.id || !message.threadId) return null;

  const headers = message.payload?.headers || [];
  const fromHeader = getHeader(headers, 'From');
  const fromMatch = fromHeader.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
  const fromName = fromMatch?.[1] || '';
  const fromEmail = fromMatch?.[2] || fromHeader;

  const { text, html, attachments } = message.payload ? extractBodyFromParts(message.payload) : { text: '', html: '', attachments: [] };
  const body = text || (html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');

  const refsHeader = getHeader(headers, 'References');
  const calendarPart = (part: gmail_v1.Schema$MessagePart): boolean => /text\/calendar|application\/ics/i.test(part.mimeType || '')
    || (part.parts || []).some(calendarPart);

  return {
    id: message.id,
    threadId: message.threadId,
    from: fromEmail.trim().toLowerCase(),
    fromName: fromName.trim(),
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    body,
    htmlBody: html || undefined,
    date: new Date(parseInt(message.internalDate || '0')),
    inReplyTo: getHeader(headers, 'In-Reply-To') || undefined,
    references: refsHeader ? refsHeader.split(/\s+/) : undefined,
    labelIds: message.labelIds || [],
    attachmentMetas: attachments,
    rawHeaders: Object.fromEntries(headers.filter(header => header.name && header.value).map(header => [header.name!.toLowerCase(), header.value!])),
    containsCalendarEvent: Boolean(message.payload && calendarPart(message.payload)),
  };
}

// ─── Webhook Authentication ─────────────────────────────────────────────────────

async function verifyPubSubToken(req: Request): Promise<boolean> {
  const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions');
  const adminCred = await getActiveAdminCredential('gmail_oauth');
  const webhookSecret = adminCred?.config?.webhookSecret as string | undefined;

  if (!webhookSecret) {
    logger.error('[GmailWebhook] Webhook secret is not configured; rejecting push notification');
    return false;
  }

  const providedToken = req.query.token as string;
  if (!providedToken || !timingSafeEqual(providedToken, webhookSecret)) {
    logger.warn('[GmailWebhook] Unauthorized: missing or invalid token');
    return false;
  }

  return true;
}

// ─── Fetch New Messages via Gmail API ───────────────────────────────────────────

function gmailResourceMissing(error: unknown): boolean {
  const value = error as { code?: number; response?: { status?: number } } | null;
  return [404, 410].includes(Number(value?.response?.status || value?.code));
}

/**
 * Download attachment data from Gmail API.
 */
async function downloadGmailAttachments(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentMetas: GmailAttachmentMeta[],
): Promise<InboundEmailAttachment[]> {
  const results: InboundEmailAttachment[] = [];

  for (const meta of attachmentMetas) {
    try {
      const attResponse = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: meta.attachmentId,
      });

      const rawData = attResponse.data.data;
      if (!rawData) throw new Error('Gmail attachment response contained no data');

      // Gmail API returns URL-safe base64
      const buffer = Buffer.from(rawData, 'base64url');

      results.push({
        filename: meta.filename,
        contentType: meta.mimeType,
        data: buffer,
        size: buffer.length,
      });
    } catch (err) {
      logger.error({ err, attachmentId: meta.attachmentId, filename: meta.filename }, '[GmailWebhook] Failed to download attachment');
      throw err;
    }
  }

  return results;
}

/**
 * Fetch new messages specifically changed since the last historyId.
 * This is the standard "sync only new" approach for Gmail Pub/Sub.
 */
export async function fetchIncrementalMessages(
  userId: number,
  gmail: gmail_v1.Gmail,
  startHistoryId: string
): Promise<ParsedGmailMessage[]> {
  try {
    const messages: ParsedGmailMessage[] = [];
    const newMessageIds = new Set<string>();
    let pageToken: string | undefined;
    do {
      const historyResponse = await gmail.users.history.list({
        userId: 'me', startHistoryId, historyTypes: ['messageAdded'], pageToken,
      });
      if (!historyResponse.data) throw new Error('Gmail history response was empty');
      for (const record of historyResponse.data.history || []) {
        for (const added of record.messagesAdded || []) {
          if (added.message?.id) newMessageIds.add(added.message.id);
        }
      }
      pageToken = historyResponse.data.nextPageToken || undefined;
    } while (pageToken);

    // Fetch full message content for each new ID
    for (const id of newMessageIds) {
      try {
        const msgResponse = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
        });
        const parsed = parseGmailApiMessage(msgResponse.data);
        if (!parsed) throw new Error('Gmail message response was incomplete');
        messages.push(parsed);
      } catch (err) {
        // A message can be deleted after Gmail records its addition. This is
        // not an expired history cursor; keep processing the remaining IDs.
        if (gmailResourceMissing(err)) {
          logger.info({ messageId: id }, '[GmailWebhook] Message no longer exists; skipping history entry');
          continue;
        }
        logger.error({ err, messageId: id }, '[GmailWebhook] Error fetching message from history');
        throw err;
      }
    }

    return messages;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (gmailResourceMissing(err)) {
      // History ID expired or too old — need fallback sync
      logger.info({ userId, startHistoryId }, '[GmailWebhook] History ID expired, falling back to recent list');
      return fetchRecentMessages(userId, gmail);
    }
    throw err;
  }
}

/**
 * Fallback: Traverse the inbox rather than advance past an arbitrary top-N slice.
 */
async function fetchRecentMessages(
  userId: number,
  gmail: gmail_v1.Gmail,
  limit: number = 100
): Promise<ParsedGmailMessage[]> {
  const messageIds: gmail_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  do {
    const listResponse = await gmail.users.messages.list({
      userId: 'me', maxResults: limit, labelIds: ['INBOX'], pageToken,
    });
    if (!listResponse.data) throw new Error('Gmail inbox response was empty');
    messageIds.push(...(listResponse.data.messages || []));
    pageToken = listResponse.data.nextPageToken || undefined;
  } while (pageToken);
  const messages: ParsedGmailMessage[] = [];

  for (const msg of messageIds) {
    if (!msg.id) throw new Error('Gmail inbox message lacked an id');
    try {
      const msgResponse = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });
      const parsed = parseGmailApiMessage(msgResponse.data);
      if (!parsed) throw new Error('Gmail message response was incomplete');
      messages.push(parsed);
    } catch (msgErr) {
      if (gmailResourceMissing(msgErr)) {
        logger.info({ messageId: msg.id }, '[GmailWebhook] Message removed during inbox scan; skipping');
        continue;
      }
      logger.error({ err: msgErr, messageId: msg.id }, '[GmailWebhook] Error fetching recent message');
      throw msgErr;
    }
  }

  return messages;
}

// ─── Main Webhook Handler ───────────────────────────────────────────────────────

/**
 * POST /api/gmail/oauth/webhook
 * Receives Google Cloud Pub/Sub push notifications for Gmail mailbox changes.
 *
 * Flow:
 *  1. Validate token-based auth
 *  2. Decode base64 Pub/Sub message → { emailAddress, historyId }
 *  3. Look up user by emailAddress in channel_credentials
 *  4. Save a coalesced notification durably before acknowledging Pub/Sub
 *  5. Workers process inbox history after the shared mailbox cooldown
 *  6. Advance the cursor only after every inbound message is durably handled
 */
export async function handleGmailPubSubWebhook(req: Request, res: Response) {
  try {
    // 1. Authenticate
    if (!(await verifyPubSubToken(req))) {
      return res.status(401).send('Unauthorized');
    }

    // 2. Decode Pub/Sub message
    const message = req.body?.message;
    if (!message) {
      return res.status(200).send('OK');
    }

    const data = message.data ? Buffer.from(message.data, 'base64').toString() : null;
    if (!data) {
      return res.status(200).send('OK');
    }

    let notification: GmailPubSubNotification;
    try {
      notification = JSON.parse(data);
    } catch {
      logger.info({ data }, '[GmailWebhook] Failed to parse notification data');
      return res.status(200).send('OK');
    }

    const emailAddress = typeof notification.emailAddress === 'string' ? notification.emailAddress.trim().toLowerCase() : '';
    const historyId = String(notification.historyId || '');
    if (!emailAddress || !/^\d{1,40}$/.test(historyId)) {
      logger.info('[GmailWebhook] Missing emailAddress or historyId');
      return res.status(200).send('OK');
    }

    logger.info({ historyId }, '[GmailWebhook] Received notification');

    // 3. Find user
    const credResult = await withSystemScope('Resolve verified Gmail mailbox', () => db.execute(
      sql`SELECT * FROM channel_credentials WHERE platform = 'gmail_api' AND is_active IS TRUE
        AND LOWER(TRIM(account_identifier)) = ${emailAddress} ORDER BY id LIMIT 2`,
    ));

    if (!credResult.rows || credResult.rows.length === 0) {
      logger.info({ historyId }, '[GmailWebhook] No active mailbox owner found');
      return res.status(200).send('OK');
    }
    if (credResult.rows.length !== 1) {
      logger.error('[GmailWebhook] Ambiguous active Gmail account ownership');
      return res.status(409).send('Ambiguous Gmail account');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credential = credResult.rows[0] as Record<string, any>;
    const userId = credential.user_id as number;
    if (!credential.business_profile_id) return res.status(409).send('Mailbox business unavailable');
    return await withBusinessScope({ userId, businessProfileId:Number(credential.business_profile_id) }, async () => {
    const sessionData = (typeof credential.session_data === 'string' 
      ? JSON.parse(credential.session_data) 
      : credential.session_data) || {};
    const previousHistoryId = sessionData.lastHistoryId as string | undefined;

    if (previousHistoryId && /^\d+$/.test(String(previousHistoryId)) && BigInt(previousHistoryId) >= BigInt(historyId)) {
      return res.status(200).send('OK');
    }

    await queueGmailNotification({ userId, credentialId: Number(credential.id), emailAddress }, historyId);
    return res.status(200).send('OK');
    });
  } catch (error: unknown) {
    logger.error({ err: error }, '[GmailWebhook] Error processing webhook');
    return res.status(500).send('Internal Server Error');
  }
}

/** Worker-only processing. The transport acknowledges after durable queueing. */
export async function syncGmailMailboxHistory(credential: GmailSyncCredential, heartbeat: () => Promise<void>): Promise<void> {
  const userId = Number(credential.user_id);
  const emailAddress = credential.account_identifier.trim().toLowerCase();
  const sessionData = typeof credential.session_data === 'string' ? JSON.parse(credential.session_data) : credential.session_data;
  const previousHistoryId = sessionData?.lastHistoryId;
  await heartbeat();
  // 5. Fetch recent inbound messages via Gmail API
  let gmail: gmail_v1.Gmail;
  try {
    const { getGmailClientForUser } = await import('./gmailOAuthController');
    const { google: googleAPIs } = await import('googleapis');
    const clientResult = await getGmailClientForUser(userId, { credentialId: Number(credential.id), accountIdentifier: emailAddress });
    if (!clientResult) {
      logger.warn({ userId }, '[GmailWebhook] Gmail client not available');
      throw new Error('Gmail client unavailable');
    }
    // clientResult.client is an OAuth2Client — wrap it to get the Gmail API client
    gmail = guardGmailClient(googleAPIs.gmail({ version: 'v1', auth: clientResult.client, retry: false, timeout: 30_000 }), { userId, credentialId: Number(credential.id), emailAddress }, heartbeat);
  } catch (err) {
    logger.error({ err }, '[GmailWebhook] Failed to get Gmail client');
    throw err;
  }

  let messages: ParsedGmailMessage[];

  if (previousHistoryId) {
    // Fetch only since last historyId (efficient, "no need to sync current inbox")
    messages = await fetchIncrementalMessages(userId, gmail, previousHistoryId);
  } else {
    // Fallback for first time or missing history ID
    messages = await fetchRecentMessages(userId, gmail);
  }

  // 6. Process each inbound message through InboundEmailService
  let processed = 0;
  for (const msg of messages) {
    await heartbeat();
    // Skip messages we sent ourselves
    if (msg.from === emailAddress.toLowerCase()) continue;

    try {
      // Download attachments if present
      let attachments: InboundEmailAttachment[] | undefined;
      if (msg.attachmentMetas.length > 0) {
        attachments = await downloadGmailAttachments(gmail, msg.id, msg.attachmentMetas);
      }

      const result = await processInboundEmail({
        provider: 'gmail',
        receivingUserId: userId,
        externalMessageId: msg.id,
        senderEmail: msg.from,
        senderDisplayName: msg.fromName || undefined,
        subject: msg.subject,
        body: msg.body,
        htmlBody: msg.htmlBody,
        inReplyTo: msg.inReplyTo,
        references: msg.references?.join(' '),
        recipientEmails: [emailAddress],
        gmailThreadId: msg.threadId,
        attachments,
        gmailLabelIds: msg.labelIds,
        rawHeaders: msg.rawHeaders,
        containsCalendarEvent: msg.containsCalendarEvent,
      });

      if (result.success) {
        if (!result.skipped) processed++;
      } else if (result.duplicate) {
        // Already processed — skip silently
      } else {
        logger.warn(
          { error: result.error, messageId: msg.id },
          '[GmailWebhook] Inbound email processing failed',
        );
        throw new Error('Inbound message processing failed');
      }
    } catch (processErr) {
      logger.error({ err: processErr, messageId: msg.id }, '[GmailWebhook] Error processing message');
      throw processErr;
    }
  }


  await heartbeat();
  logger.info({ credentialId: credential.id, historyId: credential.gmail_sync_history_id, processed }, '[GmailSync] Inbox changes processed');
}
