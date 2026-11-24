import { businessOwnerUserId } from '../tenancy/businessContext.js';
/**
 * Resend Controller
 * Manages Resend domains, API keys, and webhooks for the user-facing email integration.
 */

import type { Request, Response } from 'express';
import * as resendService from '../services/resendService';
import { logger } from '../utils/logger.js';
import { isEmailAddress } from '../../shared/emailAddress.js';

/**
 * Resend API keys and webhooks belong to the deployment-level Resend account,
 * not to a tenant.  Exposing those account-wide resources to any authenticated
 * tenant lets one customer inspect or delete another customer's resources.
 * Domains and senders remain tenant-scoped; provider administration is admin
 * only until a per-workspace Resend account/binding exists.
 */
function sharedAccountResourceForbidden(res: Response) {
  return res.status(403).json({
    error: 'This Resend account-level resource is managed by the workspace administrator.',
  });
}

// ─── Domains ──────────────────────────────────────────────────────

export async function addDomain(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const rawDomain = req.body?.domain ?? req.body?.name;
    if (!rawDomain || typeof rawDomain !== 'string') {
      return res.status(400).json({ error: 'Domain name is required (use "domain")' });
    }

    const domain = rawDomain.trim().toLowerCase();

    // Basic domain format validation
    const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    if (!domainRegex.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    const result = await resendService.createDomain(userId, domain);
    return res.json({ success: true, domain: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] addDomain error');
    return res.status(500).json({ error: 'Failed to add domain' });
  }
}

export async function verifyDomain(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const resendDomainId = req.params.id;
    if (!resendDomainId) return res.status(400).json({ error: 'Domain ID is required' });

    const result = await resendService.verifyDomainByResendId(userId, resendDomainId);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] verifyDomain error');
    return res.status(500).json({ error: 'Failed to verify domain' });
  }
}

export async function getDomainStatus(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const resendDomainId = req.params.id;
    if (!resendDomainId) return res.status(400).json({ error: 'Domain ID is required' });

    const result = await resendService.getDomainStatusByResendId(userId, resendDomainId);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] getDomainStatus error');
    return res.status(500).json({ error: 'Failed to get domain status' });
  }
}

export async function listDomains(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const domains = await resendService.listDomains(userId);
    return res.json({ success: true, domains });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] listDomains error');
    return res.status(500).json({ error: 'Failed to list domains' });
  }
}

export async function deleteDomain(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const resendDomainId = req.params.id;
    if (!resendDomainId) return res.status(400).json({ error: 'Domain ID is required' });

    await resendService.deleteDomainByResendId(userId, resendDomainId);
    return res.json({ success: true, message: 'Domain deleted' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] deleteDomain error');
    return res.status(500).json({ error: 'Failed to delete domain' });
  }
}

// ─── Enable Receiving ─────────────────────────────────────────────

export async function enableReceiving(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const resendDomainId = req.params.id;
    if (!resendDomainId) return res.status(400).json({ error: 'Domain ID is required' });

    const result = await resendService.enableReceivingByResendId(userId, resendDomainId);
    return res.json({ success: true, domain: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] enableReceiving error');
    return res.status(500).json({ error: 'Failed to enable receiving' });
  }
}

// ─── Send Test Email ──────────────────────────────────────────────

export async function sendTestEmail(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const to = typeof req.body?.to === 'string' ? req.body.to.trim().toLowerCase() : '';
    const domainId = req.body?.domainId === undefined ? undefined : Number(req.body.domainId);
    if (!to || to.length > 254 || !isEmailAddress(to)) {
      return res.status(400).json({ error: 'A valid recipient email is required' });
    }
    if (domainId !== undefined && (!Number.isSafeInteger(domainId) || domainId <= 0)) {
      return res.status(400).json({ error: 'Invalid domain ID' });
    }

    // Get the user's verified domain
    let domain;
    if (domainId !== undefined) {
      domain = await resendService.getDomainStatus(userId, domainId);
    } else {
      domain = await resendService.getVerifiedDomain(userId);
    }

    if (!domain || domain.status !== 'verified') {
      return res.status(400).json({ error: 'No verified domain found. Please add and verify a domain first.' });
    }

    const result = await resendService.sendEmail({
      from: `Test <noreply@${domain.name}>`,
      to,
      subject: 'Test Email from Sales & Marketing Platform',
      html: `
        <h2>Test Email</h2>
        <p>This is a test email sent via Resend from your verified domain <strong>${domain.name}</strong>.</p>
        <p>If you received this, your domain is configured correctly!</p>
        <hr/>
        <p style="color: #666; font-size: 12px;">Sent at: ${new Date().toLocaleString()}</p>
      `,
    });

    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] sendTestEmail error');
    const { deliverySetupFailure } = await import('../services/assistants/CustomerDeliveryGate.js');
    const setup = deliverySetupFailure(error);
    if (setup) return res.status(409).json(setup);
    return res.status(500).json({ error: 'Failed to send test email' });
  }
}

// ─── Webhooks ─────────────────────────────────────────────────────

export async function createWebhook(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { endpoint, events } = req.body;
    if (!endpoint || !events?.length) {
      return res.status(400).json({ error: 'Endpoint and events are required' });
    }

    const result = await resendService.createWebhook(endpoint, events);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] createWebhook error');
    return res.status(500).json({ error: 'Failed to create webhook' });
  }
}

export async function listWebhooks(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const webhooks = await resendService.listWebhooks();
    return res.json({ success: true, data: webhooks });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] listWebhooks error');
    return res.status(500).json({ error: 'Failed to list webhooks' });
  }
}

export async function deleteWebhook(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { webhookId } = req.params;
    if (!webhookId) return res.status(400).json({ error: 'Webhook ID is required' });

    await resendService.deleteWebhook(webhookId);
    return res.json({ success: true, message: 'Webhook deleted' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] deleteWebhook error');
    return res.status(500).json({ error: 'Failed to delete webhook' });
  }
}

// ─── API Keys ─────────────────────────────────────────────────────

export async function createApiKey(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { name, permission, domainId } = req.body;
    if (!name) return res.status(400).json({ error: 'API key name is required' });

    const result = await resendService.createApiKey(name, permission, domainId);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] createApiKey error');
    return res.status(500).json({ error: 'Failed to create API key' });
  }
}

export async function listApiKeys(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const keys = await resendService.listApiKeys();
    return res.json({ success: true, data: keys });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] listApiKeys error');
    return res.status(500).json({ error: 'Failed to list API keys' });
  }
}

export async function deleteApiKey(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { keyId } = req.params;
    if (!keyId) return res.status(400).json({ error: 'API key ID is required' });

    await resendService.deleteApiKey(keyId);
    return res.json({ success: true, message: 'API key deleted' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] deleteApiKey error');
    return res.status(500).json({ error: 'Failed to delete API key' });
  }
}

// ─── Email Management ─────────────────────────────────────────────

export async function getEmailById(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { emailId } = req.params;
    if (!emailId) return res.status(400).json({ error: 'Email ID is required' });

    const result = await resendService.getEmail(emailId);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] getEmailById error');
    return res.status(500).json({ error: 'Failed to retrieve email' });
  }
}

export async function listSentEmails(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const result = await resendService.listEmails();
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] listSentEmails error');
    return res.status(500).json({ error: 'Failed to list emails' });
  }
}

// ─── Segments (formerly Audiences) ────────────────────────────────

export async function createSegment(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Segment name is required' });

    const result = await resendService.createSegment(name);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] createSegment error');
    return res.status(500).json({ error: 'Failed to create segment' });
  }
}

export async function listSegments(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const result = await resendService.listSegments();
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] listSegments error');
    return res.status(500).json({ error: 'Failed to list segments' });
  }
}

export async function getSegment(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { segmentId } = req.params;
    if (!segmentId) return res.status(400).json({ error: 'Segment ID is required' });

    const result = await resendService.getSegment(segmentId);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] getSegment error');
    return res.status(500).json({ error: 'Failed to retrieve segment' });
  }
}

export async function deleteSegment(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { segmentId } = req.params;
    if (!segmentId) return res.status(400).json({ error: 'Segment ID is required' });

    await resendService.deleteSegment(segmentId);
    return res.json({ success: true, message: 'Segment deleted' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] deleteSegment error');
    return res.status(500).json({ error: 'Failed to delete segment' });
  }
}

// ─── Contacts ─────────────────────────────────────────────────────

export async function createContact(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { email, firstName, lastName, unsubscribed, segments } = req.body;
    if (!email) return res.status(400).json({ error: 'Contact email is required' });

    const result = await resendService.createContact({ email, firstName, lastName, unsubscribed, segments });
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] createContact error');
    return res.status(500).json({ error: 'Failed to create contact' });
  }
}

export async function listContacts(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const result = await resendService.listContacts();
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] listContacts error');
    return res.status(500).json({ error: 'Failed to list contacts' });
  }
}

export async function getContact(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { contactId } = req.params;
    if (!contactId) return res.status(400).json({ error: 'Contact ID is required' });

    const result = await resendService.getContact(contactId);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] getContact error');
    return res.status(500).json({ error: 'Failed to retrieve contact' });
  }
}

export async function updateContact(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { contactId } = req.params;
    if (!contactId) return res.status(400).json({ error: 'Contact ID is required' });

    const { firstName, lastName, unsubscribed } = req.body;
    const result = await resendService.updateContact(contactId, { firstName, lastName, unsubscribed });
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] updateContact error');
    return res.status(500).json({ error: 'Failed to update contact' });
  }
}

export async function deleteContact(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { contactId } = req.params;
    if (!contactId) return res.status(400).json({ error: 'Contact ID is required' });

    await resendService.deleteContact(contactId);
    return res.json({ success: true, message: 'Contact deleted' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] deleteContact error');
    return res.status(500).json({ error: 'Failed to delete contact' });
  }
}

// ─── Broadcasts ───────────────────────────────────────────────────

export async function createBroadcast(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { segmentId, from, subject, html, text, replyTo, name, send, scheduledAt } = req.body;
    if (!segmentId || !from || !subject || !html) {
      return res.status(400).json({ error: 'segmentId, from, subject, and html are required' });
    }

    const result = await resendService.createBroadcast({ segmentId, from, subject, html, text, replyTo, name, send, scheduledAt });
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] createBroadcast error');
    return res.status(500).json({ error: 'Failed to create broadcast' });
  }
}

export async function sendBroadcast(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { broadcastId } = req.params;
    if (!broadcastId) return res.status(400).json({ error: 'Broadcast ID is required' });

    const { scheduledAt } = req.body;
    const result = await resendService.sendBroadcast(broadcastId, scheduledAt);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] sendBroadcast error');
    return res.status(500).json({ error: 'Failed to send broadcast' });
  }
}

export async function listBroadcasts(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const result = await resendService.listBroadcasts();
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] listBroadcasts error');
    return res.status(500).json({ error: 'Failed to list broadcasts' });
  }
}

export async function getBroadcast(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { broadcastId } = req.params;
    if (!broadcastId) return res.status(400).json({ error: 'Broadcast ID is required' });

    const result = await resendService.getBroadcast(broadcastId);
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] getBroadcast error');
    return res.status(500).json({ error: 'Failed to retrieve broadcast' });
  }
}

export async function deleteBroadcast(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { broadcastId } = req.params;
    if (!broadcastId) return res.status(400).json({ error: 'Broadcast ID is required' });

    await resendService.deleteBroadcast(broadcastId);
    return res.json({ success: true, message: 'Broadcast deleted' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] deleteBroadcast error');
    return res.status(500).json({ error: 'Failed to delete broadcast' });
  }
}

export async function updateBroadcast(req: Request, res: Response) {
  return sharedAccountResourceForbidden(res);
  /* c8 ignore next */
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { broadcastId } = req.params;
    if (!broadcastId) return res.status(400).json({ error: 'Broadcast ID is required' });

    const { segmentId, from, subject, html, text, replyTo, name } = req.body;
    const result = await resendService.updateBroadcast(broadcastId, { segmentId, from, subject, html, text, replyTo, name });
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] updateBroadcast error');
    return res.status(500).json({ error: 'Failed to update broadcast' });
  }
}

// ─── Domain Update ────────────────────────────────────────────────

export async function updateDomain(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const resendDomainId = req.params.id;
    if (!resendDomainId) return res.status(400).json({ error: 'Domain ID is required' });

    const { openTracking, clickTracking, tls } = req.body;
    const result = await resendService.updateDomain(userId, resendDomainId, { openTracking, clickTracking, tls });
    return res.json({ success: true, data: result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ResendController] updateDomain error');
    return res.status(500).json({ error: 'Failed to update domain' });
  }
}
