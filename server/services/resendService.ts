/**
 * Resend Service
 * Wraps the Resend SDK for domain management, email sending, and webhooks.
 */

import { Resend } from 'resend';
import { db } from '../models/db';
import { resendDomainsTable } from '../models/resendDomains/schema';
import { and, desc, eq } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { decryptAdminCredential, getActiveAdminCredential } from '../models/adminApiCredentials/functions';
import { adminApiCredentialsTable } from '../models/adminApiCredentials/schema.js';
import { assertResolvedEmailTemplate } from '../utils/emailTemplateVariables.js';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, CustomerDeliverySetupError } from './assistants/CustomerDeliveryGate.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { isInternalEmailDelivery } from './InternalEmailDelivery.js';

async function getResendClient(credentialId?: number): Promise<Resend> {
  const [bound] = credentialId ? await db.select().from(adminApiCredentialsTable).where(and(eq(adminApiCredentialsTable.id, credentialId), eq(adminApiCredentialsTable.platform, 'resend'), eq(adminApiCredentialsTable.isActive, true))).limit(1) : [];
  const adminCred = credentialId ? (bound ? decryptAdminCredential(bound) : null) : await getActiveAdminCredential('resend');
  const apiKey = adminCred?.apiKey;
  if (!apiKey) {
    throw Object.assign(new Error('Resend API key not configured. Set it in Admin Panel → Integrations → Resend.'), { deliveryAttempted: false });
  }
  return new Resend(apiKey);
}

// ─── Domain Management ─────────────────────────────────────────────

export async function createDomain(userId: number, domainName: string) {
  const resend = await getResendClient();

  // Check if this user already has this domain
  const [existingUserDomain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.userId, userId), eq(resendDomainsTable.name, domainName)));
  if (existingUserDomain) {
    return existingUserDomain;
  }

  // A Resend account is shared by workspaces in this deployment. Never let a
  // second workspace claim an already-registered domain simply because the
  // provider returns it from its account-wide listing.
  const [claimedByAnotherUser] = await db
    .select({ userId: resendDomainsTable.userId })
    .from(resendDomainsTable)
    .where(eq(resendDomainsTable.name, domainName))
    .limit(1);
  if (claimedByAnotherUser && claimedByAnotherUser.userId !== userId) {
    throw new Error('This domain is already connected to another workspace. Contact support if ownership has changed.');
  }

  // Check if domain already exists in Resend account
  let resendDomainId: string | null = null;
  let domainStatus = 'not_started';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dnsRecords: any[] = [];
  let region = 'us-east-1';

  try {
    const listResult = await resend.domains.list();
    const domainList = listResult.data;
    // SDK may return { data: Domain[] } or Domain[] directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const domains = Array.isArray(domainList) ? domainList : (domainList as any)?.data;
    logger.info({ domainCount: domains?.length, domainName }, '[ResendService] Checking existing domains');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = domains?.find((d: any) => d.name === domainName);
    if (existing) {
      resendDomainId = existing.id;
      domainStatus = existing.status;
      // Fetch full details for DNS records
      try {
        const { data: details } = await resend.domains.get(existing.id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dnsRecords = (details as any)?.records || [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        region = (details as any)?.region || 'us-east-1';
      } catch {
        // Use what we have from the list
      }
    }
  } catch (err) {
    logger.warn({ err }, '[ResendService] Could not list domains from Resend, will try to create');
  }

  // If not found in Resend, create it with both sending and receiving enabled
  if (!resendDomainId) {
    const { data, error } = await resend.domains.create({
      name: domainName,
      capabilities: { sending: 'enabled', receiving: 'enabled' },
    });
    if (error) {
      logger.error({ err: error }, '[ResendService] Error creating domain');
      throw new Error(error.message || 'Failed to create domain on Resend');
    }
    resendDomainId = data!.id;
    domainStatus = data!.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dnsRecords = (data as any).records || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    region = (data as any).region || 'us-east-1';
  } else {
    // Domain already exists in Resend — ensure receiving is enabled
    try {
      await resend.domains.update({
        id: resendDomainId,
        capabilities: { receiving: 'enabled' },
      });
      // Refresh DNS records to include the receiving MX record
      const { data: refreshed } = await resend.domains.get(resendDomainId);
      if (refreshed) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dnsRecords = (refreshed as any).records || dnsRecords;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        region = (refreshed as any).region || region;
      }
      logger.info({ resendDomainId }, '[ResendService] Enabled receiving on existing domain');
    } catch (err) {
      logger.warn({ err, resendDomainId }, '[ResendService] Could not enable receiving on existing domain');
    }
  }

  // Persist to DB for this user
  const [inserted] = await db.insert(resendDomainsTable).values({
    userId,
    resendDomainId: resendDomainId!,
    name: domainName,
    status: domainStatus,
    region,
    dnsRecords,
  }).returning();

  logger.info({ domainId: resendDomainId, name: domainName, userId }, '[ResendService] Domain added for user');
  return inserted;
}

export async function verifyDomain(userId: number, domainId: number) {
  const resend = await getResendClient();

  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.id, domainId), eq(resendDomainsTable.userId, userId)));

  if (!domain) throw new Error('Domain not found');

  const { data, error } = await resend.domains.verify(domain.resendDomainId);
  if (error) {
    logger.error({ err: error }, '[ResendService] Error requesting domain verification');
    throw new Error(error.message || 'Failed to request verification');
  }

  // Mark as pending while Resend processes
  await db
    .update(resendDomainsTable)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(resendDomainsTable.id, domainId));

  logger.info({ domainId: domain.resendDomainId }, '[ResendService] Domain verification requested');
  return data;
}

export async function getDomainStatus(userId: number, domainId: number) {
  const resend = await getResendClient();

  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.id, domainId), eq(resendDomainsTable.userId, userId)));

  if (!domain) throw new Error('Domain not found');

  // Fetch fresh status from Resend
  const { data, error } = await resend.domains.get(domain.resendDomainId);
  if (error) {
    logger.error({ err: error }, '[ResendService] Error getting domain status');
    throw new Error(error.message || 'Failed to get domain status');
  }

  // Update local record
  await db
    .update(resendDomainsTable)
    .set({
      status: data!.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dnsRecords: (data as any).records || domain.dnsRecords,
      updatedAt: new Date(),
    })
    .where(eq(resendDomainsTable.id, domainId));

  return {
    ...domain,
    status: data!.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dnsRecords: (data as any).records || domain.dnsRecords,
  };
}

export async function listDomains(userId: number) {
  return db
    .select()
    .from(resendDomainsTable)
    .where(eq(resendDomainsTable.userId, userId))
    .orderBy(resendDomainsTable.createdAt);
}

export async function getDomainById(userId: number, domainId: number) {
  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.id, domainId), eq(resendDomainsTable.userId, userId)));
  return domain;
}

export async function deleteDomain(userId: number, domainId: number) {
  const resend = await getResendClient();

  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.id, domainId), eq(resendDomainsTable.userId, userId)));

  if (!domain) throw new Error('Domain not found');

  const { error } = await resend.domains.remove(domain.resendDomainId);
  if (error) {
    logger.error({ err: error }, '[ResendService] Error deleting domain from Resend');
    // Continue to delete locally even if Resend fails
  }

  await db
    .delete(resendDomainsTable)
    .where(eq(resendDomainsTable.id, domainId));

  logger.info({ domainId: domain.resendDomainId }, '[ResendService] Domain deleted');
}

// ─── Lookup by Resend domain ID (string) ─────────────────────────

export async function verifyDomainByResendId(userId: number, resendDomainId: string) {
  const resend = await getResendClient();

  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.resendDomainId, resendDomainId), eq(resendDomainsTable.userId, userId)));

  if (!domain) throw new Error('Domain not found');

  const { data, error } = await resend.domains.verify(domain.resendDomainId);
  if (error) {
    logger.error({ err: error }, '[ResendService] Error requesting domain verification');
    throw new Error(error.message || 'Failed to request verification');
  }

  await db
    .update(resendDomainsTable)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(resendDomainsTable.id, domain.id));

  logger.info({ domainId: domain.resendDomainId }, '[ResendService] Domain verification requested');
  return data;
}

export async function getDomainStatusByResendId(userId: number, resendDomainId: string) {
  const resend = await getResendClient();

  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.resendDomainId, resendDomainId), eq(resendDomainsTable.userId, userId)));

  if (!domain) throw new Error('Domain not found');

  const { data, error } = await resend.domains.get(domain.resendDomainId);
  if (error) {
    logger.error({ err: error }, '[ResendService] Error getting domain status');
    throw new Error(error.message || 'Failed to get domain status');
  }

  await db
    .update(resendDomainsTable)
    .set({
      status: data!.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dnsRecords: (data as any).records || domain.dnsRecords,
      updatedAt: new Date(),
    })
    .where(eq(resendDomainsTable.id, domain.id));

  return {
    ...domain,
    status: data!.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dnsRecords: (data as any).records || domain.dnsRecords,
  };
}

export async function deleteDomainByResendId(userId: number, resendDomainId: string) {
  const resend = await getResendClient();

  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.resendDomainId, resendDomainId), eq(resendDomainsTable.userId, userId)));

  if (!domain) throw new Error('Domain not found');

  const { error } = await resend.domains.remove(domain.resendDomainId);
  if (error) {
    logger.error({ err: error }, '[ResendService] Error deleting domain from Resend');
  }

  await db
    .delete(resendDomainsTable)
    .where(eq(resendDomainsTable.id, domain.id));

  logger.info({ domainId: domain.resendDomainId }, '[ResendService] Domain deleted');
}

// ─── Get first verified domain for a user ────────────────────────

export async function getVerifiedDomain(userId: number) {
  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.userId, userId), eq(resendDomainsTable.status, 'verified')))
    .orderBy(desc(resendDomainsTable.updatedAt), desc(resendDomainsTable.id))
    .limit(1);
  return domain || null;
}

// ─── Enable Receiving on an existing domain ──────────────────────

export async function enableReceivingByResendId(userId: number, resendDomainId: string) {
  const resend = await getResendClient();

  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.resendDomainId, resendDomainId), eq(resendDomainsTable.userId, userId)));

  if (!domain) throw new Error('Domain not found');

  // Enable receiving via Resend API
  const { error } = await resend.domains.update({
    id: domain.resendDomainId,
    capabilities: { receiving: 'enabled' },
  });
  if (error) {
    logger.error({ err: error }, '[ResendService] Error enabling receiving');
    throw new Error(error.message || 'Failed to enable receiving');
  }

  // Refresh DNS records to include the receiving MX record
  const { data: details } = await resend.domains.get(domain.resendDomainId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const freshRecords = (details as any)?.records || domain.dnsRecords;

  await db
    .update(resendDomainsTable)
    .set({ dnsRecords: freshRecords, updatedAt: new Date() })
    .where(eq(resendDomainsTable.id, domain.id));

  logger.info({ resendDomainId }, '[ResendService] Receiving enabled, DNS records refreshed');
  return {
    ...domain,
    dnsRecords: freshRecords,
  };
}

export async function isVerifiedDomainForUser(userId: number, domainName: string): Promise<boolean> {
  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.userId, userId), eq(resendDomainsTable.name, domainName), eq(resendDomainsTable.status, 'verified')))
    .limit(1);
  return !!domain;
}

// ─── Email Sending ──────────────────────────────────────────────

interface ResendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
  attachments?: Array<{ filename: string; content: Buffer | string; content_type?: string }>;
  // Threading headers for email replies
  headers?: {
    'In-Reply-To'?: string;
    References?: string;
    [key: string]: string | undefined;
  };
  /** Stable send-intent key; Resend retains idempotency keys for 24 hours. */
  idempotencyKey?: string;
  /** Bind an already reviewed send to the exact active operator credential. */
  credentialId?: number;
}

export async function sendEmail(options: ResendEmailOptions) {
  if (!isInternalEmailDelivery()) assertCustomerDeliveryRuntime('email');
  assertResolvedEmailTemplate(options);
  const accountId = (options.from.match(/<([^<>]+)>\s*$/)?.[1] || options.from).trim().toLowerCase();
  const userId = currentBusinessScope()?.userId || 0;
  const assistantReceipt = !isInternalEmailDelivery() ? await assertCustomerDeliveryReady({ userId, channel: 'email', accountId }) : undefined;
  const resend = await getResendClient(options.credentialId);

  if (!options.html && !options.text) {
    logger.error('[ResendService] Cannot send email: missing both html and text content');
    throw Object.assign(new Error('Missing `html` or `text` field.'), { deliveryAttempted: false });
  }

  if (assistantReceipt) await assertCustomerDeliveryReady({ userId, channel: 'email', accountId, expected: assistantReceipt });
  const { data, error } = await resend.emails.send(
    {
      from: options.from,
      to: Array.isArray(options.to) ? options.to : [options.to],
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
      tags: options.tags,
      headers: options.headers as Record<string, string> | undefined,
      attachments: options.attachments?.map(a => ({
        filename: a.filename,
        content: a.content instanceof Buffer ? a.content : Buffer.from(a.content as string, 'base64'),
      })),
    },
    options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
  );

  if (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isRateLimit = (error as any).name === 'rate_limit_exceeded' || (error as any).statusCode === 429;
    if (isRateLimit) {
      logger.warn('[ResendService] Rate limit exceeded; automatic provider retry suppressed');
    }
    
    logger.error({ err: error, isRateLimit }, '[ResendService] Error sending email');
    const status=Number((error as {statusCode?:number}).statusCode);
    throw Object.assign(new Error(error.message || 'Failed to send email via Resend'), { deliveryAttempted: true,
      outcomeUncertain:status>=500 || !(status>=400 && status<500 || isRateLimit),retryable:isRateLimit,status });
  }

  logger.info({ emailId: data!.id, hasThreadingHeaders: !!options.headers }, '[ResendService] Email sent');
  return data;
}

// ─── Webhook Management ──────────────────────────────────────────

export async function createWebhook(endpoint: string, events: string[]) {
  const resend = await getResendClient();

  const { data, error } = await resend.webhooks.create({
    endpoint,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: events as any[],
  });

  if (error) {
    logger.error({ err: error }, '[ResendService] Error creating webhook');
    throw new Error(error.message || 'Failed to create webhook');
  }

  logger.info({ webhookId: data!.id }, '[ResendService] Webhook created');
  return data;
}

export async function listWebhooks() {
  const resend = await getResendClient();
  const { data, error } = await resend.webhooks.list();
  if (error) {
    throw new Error(error.message || 'Failed to list webhooks');
  }
  return data;
}

export async function deleteWebhook(webhookId: string) {
  const resend = await getResendClient();
  const { error } = await resend.webhooks.remove(webhookId);
  if (error) {
    throw new Error(error.message || 'Failed to delete webhook');
  }
}

// ─── API Key Management ──────────────────────────────────────────

export async function createApiKey(name: string, permission?: 'full_access' | 'sending_access', domainId?: string) {
  const resend = await getResendClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = { name };
  if (permission) params.permission = permission;
  if (domainId) params.domainId = domainId;

  const { data, error } = await resend.apiKeys.create(params);
  if (error) {
    throw new Error(error.message || 'Failed to create API key');
  }
  return data;
}

export async function listApiKeys() {
  const resend = await getResendClient();
  const { data, error } = await resend.apiKeys.list();
  if (error) {
    throw new Error(error.message || 'Failed to list API keys');
  }
  return data;
}

export async function deleteApiKey(keyId: string) {
  const resend = await getResendClient();
  const { error } = await resend.apiKeys.remove(keyId);
  if (error) {
    throw new Error(error.message || 'Failed to delete API key');
  }
}

// ─── Email Management ────────────────────────────────────────────

export async function getEmail(emailId: string, credentialId?: number) {
  const resend = await getResendClient(credentialId);
  const { data, error } = await resend.emails.get(emailId);
  if (error) throw new Error(error.message || 'Failed to retrieve email');
  return data;
}

export async function listEmails() {
  const resend = await getResendClient();
  const { data, error } = await resend.emails.list();
  if (error) throw new Error(error.message || 'Failed to list emails');
  return data;
}

// ─── Segments (formerly Audiences) ───────────────────────────────

export async function createSegment(name: string) {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (resend as any).segments.create({ name });
  if (error) throw new Error(error.message || 'Failed to create segment');
  logger.info({ segmentId: data?.id }, '[ResendService] Segment created');
  return data;
}

export async function listSegments() {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (resend as any).segments.list();
  if (error) throw new Error(error.message || 'Failed to list segments');
  return data;
}

export async function getSegment(segmentId: string) {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (resend as any).segments.get(segmentId);
  if (error) throw new Error(error.message || 'Failed to retrieve segment');
  return data;
}

export async function deleteSegment(segmentId: string) {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (resend as any).segments.remove(segmentId);
  if (error) throw new Error(error.message || 'Failed to delete segment');
}

// ─── Contacts ────────────────────────────────────────────────────

export async function createContact(options: {
  email: string;
  firstName?: string;
  lastName?: string;
  unsubscribed?: boolean;
  segments?: Array<{ id: string }>;
}) {
  const resend = await getResendClient();
  const { data, error } = await resend.contacts.create(options);
  if (error) throw new Error(error.message || 'Failed to create contact');
  logger.info({ contactId: data?.id }, '[ResendService] Contact created');
  return data;
}

export async function listContacts() {
  const resend = await getResendClient();
  const { data, error } = await resend.contacts.list();
  if (error) throw new Error(error.message || 'Failed to list contacts');
  return data;
}

export async function getContact(contactId: string) {
  const resend = await getResendClient();
  const { data, error } = await resend.contacts.get({ id: contactId });
  if (error) throw new Error(error.message || 'Failed to retrieve contact');
  return data;
}

export async function updateContact(contactId: string, updates: {
  firstName?: string;
  lastName?: string;
  unsubscribed?: boolean;
}) {
  const resend = await getResendClient();
  const { data, error } = await resend.contacts.update({ id: contactId, ...updates });
  if (error) throw new Error(error.message || 'Failed to update contact');
  return data;
}

export async function deleteContact(contactId: string) {
  const resend = await getResendClient();
  const { error } = await resend.contacts.remove({ id: contactId });
  if (error) throw new Error(error.message || 'Failed to delete contact');
}

// ─── Broadcasts ──────────────────────────────────────────────────

export async function createBroadcast(options: {
  segmentId: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  name?: string;
  send?: boolean;
  scheduledAt?: string;
}) {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (resend as any).broadcasts.create(options);
  if (error) throw new Error(error.message || 'Failed to create broadcast');
  logger.info({ broadcastId: data?.id }, '[ResendService] Broadcast created');
  return data;
}

export async function sendBroadcast(broadcastId: string, scheduledAt?: string) {
  throw new CustomerDeliverySetupError('broadcast_assignment_unsupported', 'Broadcast sending has no reviewed exact-account assistant binding. Use a reviewed outreach campaign instead.');
  /* c8 ignore next */
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {};
  if (scheduledAt) params.scheduledAt = scheduledAt;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (resend as any).broadcasts.send(broadcastId, params);
  if (error) throw new Error(error.message || 'Failed to send broadcast');
  logger.info({ broadcastId }, '[ResendService] Broadcast sent');
  return data;
}

export async function listBroadcasts() {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (resend as any).broadcasts.list();
  if (error) throw new Error(error.message || 'Failed to list broadcasts');
  return data;
}

export async function getBroadcast(broadcastId: string) {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (resend as any).broadcasts.get(broadcastId);
  if (error) throw new Error(error.message || 'Failed to retrieve broadcast');
  return data;
}

export async function deleteBroadcast(broadcastId: string) {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (resend as any).broadcasts.remove(broadcastId);
  if (error) throw new Error(error.message || 'Failed to delete broadcast');
}

export async function updateBroadcast(broadcastId: string, updates: {
  segmentId?: string;
  from?: string;
  subject?: string;
  html?: string;
  text?: string;
  replyTo?: string;
  name?: string;
}) {
  const resend = await getResendClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (resend as any).broadcasts.update({ id: broadcastId, ...updates });
  if (error) throw new Error(error.message || 'Failed to update broadcast');
  return data;
}

// ─── Domain Update ───────────────────────────────────────────────

export async function updateDomain(userId: number, resendDomainId: string, updates: {
  openTracking?: boolean;
  clickTracking?: boolean;
  tls?: 'enforced' | 'opportunistic';
}) {
  const resend = await getResendClient();

  const [domain] = await db
    .select()
    .from(resendDomainsTable)
    .where(and(eq(resendDomainsTable.resendDomainId, resendDomainId), eq(resendDomainsTable.userId, userId)));

  if (!domain) throw new Error('Domain not found');

  const { data, error } = await resend.domains.update({
    id: resendDomainId,
    ...updates,
  });
  if (error) throw new Error(error.message || 'Failed to update domain');

  // Update local DB tracking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbUpdates: any = { updatedAt: new Date() };
  if (updates.openTracking !== undefined) dbUpdates.openTracking = updates.openTracking;
  if (updates.clickTracking !== undefined) dbUpdates.clickTracking = updates.clickTracking;

  await db.update(resendDomainsTable).set(dbUpdates).where(eq(resendDomainsTable.id, domain.id));

  return data;
}
