import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
 
import type { AuthenticatedRequest } from '../types/express.js';
/**
 * Email Senders Controller
 * CRUD endpoints for managing multiple email sending accounts (Resend domains, Gmail OAuth)
 */

 
import type { Response } from 'express';
import * as EmailSenderModel from '../models/emailSenders/functions';
import { logger } from '../utils/logger.js';


/**
 * GET /api/email-senders
 * List all email senders for the current user
 */
export async function listEmailSenders(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const senders = await EmailSenderModel.listByUser(userId);
    if (req.query.availableOnly === 'true') {
      const { getCreationOptions } = await import('../services/outreach/CreationService.js');
      const options = await getCreationOptions(userId, 'email');
      const available = new Set(options.accounts.map(account => account.senderId));
      return res.json({ success: true, senders: senders
        .filter(sender => available.has(sender.id))
        .map(sender => ({ ...sender, connectionActive: true })) });
    }
    const { ChannelCredentialModel } = await import('../models/channelCredentials/functions');
    const gmailCredentials = await ChannelCredentialModel.findAllByUserAndPlatform(userId, 'gmail_api');
    const gmailById = new Map(gmailCredentials.map(credential => [credential.id, credential]));
    return res.json({ success: true, senders: senders.map(sender => {
      if (sender.type !== 'gmail') return sender;
      const credential = sender.credentialId ? gmailById.get(sender.credentialId) : undefined;
      const connectionActive = Boolean(credential?.accessToken
        && credential.accountIdentifier?.trim().toLowerCase() === sender.email.trim().toLowerCase()
        && (!credential.tokenExpiry || credential.tokenExpiry > new Date() || credential.refreshToken));
      return { ...sender, connectionActive };
    }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSendersController] Error listing senders');
    return res.status(500).json({ error: 'Failed to list email senders' });
  }
}

/**
 * GET /api/email-senders/default
 * Get the default sender for the current user
 */
export async function getDefaultSender(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const sender = await EmailSenderModel.getDefault(userId);
    return res.json({ success: true, sender: sender || null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSendersController] Error getting default sender');
    return res.status(500).json({ error: 'Failed to get default sender' });
  }
}

/**
 * POST /api/email-senders
 * Create a new email sender
 */
export async function createEmailSender(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { type, resendDomainId, credentialId } = req.body;
    let { label, email, displayName } = req.body;

    if (!type || !['resend', 'gmail'].includes(type)) {
      return res.status(400).json({ error: 'type must be "resend" or "gmail"' });
    }
    if (type === 'resend' && (!label || !email)) {
      return res.status(400).json({ error: 'label and email are required' });
    }

    // Determine verification status based on type
    let isVerified = false;
    
    if (type === 'resend' && resendDomainId != null) {
      // Check if the associated Resend domain is verified
      try {
        const { getDomainById } = await import('../services/resendService');
        const domain = await getDomainById(userId, parseInt(String(resendDomainId), 10));
        isVerified = domain?.status === 'verified';
      } catch {
        // Domain lookup failed, assume not verified
        isVerified = false;
      }
    } else if (type === 'gmail' && credentialId != null) {
      const { ChannelCredentialModel } = await import('../models/channelCredentials/functions');
      const gmailCreds = await ChannelCredentialModel.findAllByUserAndPlatform(userId, 'gmail_api');
      const gmailCred = gmailCreds.find((cred) => cred.id === parseInt(String(credentialId), 10));
      if (!gmailCred?.accountIdentifier) {
        return res.status(400).json({ error: 'Connected Gmail account not found for this sender' });
      }

      // Gmail sends from the OAuth account. Keep sender records aligned with that
      // account so the UI cannot store a different visible name/email pair.
      email = gmailCred.accountIdentifier;
      displayName = gmailCred.accountName || gmailCred.accountIdentifier;
      label = label || `Gmail - ${gmailCred.accountIdentifier}`;
      isVerified = true;
    }

    const sender = await EmailSenderModel.create({
      userId,
      type,
      label,
      email,
      displayName: displayName || null,
      isVerified,
      resendDomainId: resendDomainId != null ? parseInt(String(resendDomainId), 10) : null,
      credentialId: credentialId || null,
    });

    // Automatically set up Gmail Pub/Sub watch when a Gmail OAuth sender is added
    if (type === 'gmail' && credentialId) {
      try {
        const { getGmailClientForUser } = await import('./gmailOAuthController');
        const { setupGmailWatchForUser } = await import('./gmailOAuthController');
        const clientResult = await getGmailClientForUser(userId, {
          credentialId: Number(credentialId), accountIdentifier: email,
        });
        if (clientResult) {
          const { google } = await import('googleapis');
          const gmail = google.gmail({ version: 'v1', auth: clientResult.client });
          await setupGmailWatchForUser(userId, gmail, Number(clientResult.credential.id));
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (watchErr: any) {
        logger.warn({ err: watchErr, userId }, '[EmailSendersController] Auto-watch setup failed for Gmail sender — user can retry manually');
      }
    }

    return res.json({ success: true, sender });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[EmailSendersController] Error creating sender');
    return res.status(500).json({ error: 'Failed to create email sender' });
  }
}

/**
 * PATCH /api/email-senders/:id
 * Update a sender
 */
export async function updateEmailSender(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sender ID' });

    const { label, config } = req.body;
    let { email, displayName, isVerified } = req.body;
    const existingSender = await EmailSenderModel.getById(userId, id);
    if (!existingSender) return res.status(404).json({ error: 'Sender not found' });

    if (existingSender.type === 'gmail') {
      const { ChannelCredentialModel } = await import('../models/channelCredentials/functions');
      const gmailCreds = await ChannelCredentialModel.findAllByUserAndPlatform(userId, 'gmail_api');
      const gmailCred = gmailCreds.find((cred) => cred.id === existingSender.credentialId);
      if (!gmailCred?.accountIdentifier) {
        return res.status(400).json({ error: 'Connected Gmail account not found for this sender' });
      }

      email = gmailCred.accountIdentifier;
      displayName = gmailCred.accountName || gmailCred.accountIdentifier;
      isVerified = true;
    }

    const sender = await EmailSenderModel.update(userId, id, {
      ...(label !== undefined && { label }),
      ...(email !== undefined && { email }),
      ...(displayName !== undefined && { displayName }),
      ...(isVerified !== undefined && { isVerified }),
      ...(config !== undefined && { config }),
    });

    return res.json({ success: true, sender });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[EmailSendersController] Error updating sender');
    return res.status(500).json({ error: 'Failed to update email sender' });
  }
}

/**
 * POST /api/email-senders/:id/default
 * Set a sender as default
 */
export async function setDefaultEmailSender(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sender ID' });

    // Verify ownership
    const sender = await EmailSenderModel.getById(userId, id);
    if (!sender) return res.status(404).json({ error: 'Sender not found' });

    await EmailSenderModel.setDefault(userId, id);
    return res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSendersController] Error setting default sender');
    return res.status(500).json({ error: 'Failed to set default sender' });
  }
}

/**
 * DELETE /api/email-senders/:id
 * Delete a sender
 */
export async function deleteEmailSender(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sender ID' });

    const removed = await EmailSenderModel.remove(userId, id);
    if (!removed) return res.status(404).json({ error: 'Sender not found' });
    return res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSendersController] Error deleting sender');
    return res.status(500).json({ error: 'Failed to delete email sender' });
  }
}

/**
 * POST /api/email-senders/sync
 * Auto-detect and create senders from existing Resend domains and Gmail OAuth credentials
 */
export async function syncEmailSenders(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created: any[] = [];

    // Sync Resend domains
    try {
      const { listDomains } = await import('../services/resendService');
      const domains = await listDomains(userId);
      for (const domain of domains) {
        const existing = await EmailSenderModel.findByResendDomain(userId, domain.id);
        if (!existing) {
          const sender = await EmailSenderModel.create({
            userId,
            type: 'resend',
            label: `Resend - ${domain.name}`,
            email: `noreply@${domain.name}`,
            displayName: null,
            isVerified: domain.status === 'verified',
            resendDomainId: domain.id,
          });
          created.push(sender);
        } else if (existing.isVerified !== (domain.status === 'verified')) {
          // Update verification status
          await EmailSenderModel.update(userId, existing.id, { isVerified: domain.status === 'verified' });
        }
      }
    } catch { /* Resend not configured */ }

    // Sync Gmail OAuth accounts
    try {
      const { ChannelCredentialModel } = await import('../models/channelCredentials/functions');
      const gmailCreds = await ChannelCredentialModel.findAllByUserAndPlatform(userId, 'gmail_api');
      
      // Build a set of active credential IDs for cleanup
      const activeCredIds = new Set(gmailCreds.map(c => c.id));
      
      // Remove stale Gmail senders whose credential no longer exists
      const allSenders = await EmailSenderModel.listByUser(userId);
      for (const sender of allSenders) {
        if (sender.type === 'gmail' && sender.credentialId && !activeCredIds.has(sender.credentialId)) {
          await EmailSenderModel.remove(userId, sender.id);
        }
      }
      
      for (const cred of gmailCreds) {
        if (!cred.accessToken) continue;
        const existing = await EmailSenderModel.findByCredential(userId, cred.id);
        if (!existing) {
          // Also check by email address to prevent duplicates when reconnecting
          const gmailEmail = cred.accountIdentifier || '';
          const existingByEmail = gmailEmail ? await EmailSenderModel.findByEmailAndType(userId, gmailEmail, 'gmail') : undefined;
          if (existingByEmail) {
            // Update credential reference to the new credential ID
            await EmailSenderModel.update(userId, existingByEmail.id, {
              credentialId: cred.id,
              email: gmailEmail,
              displayName: cred.accountName || gmailEmail,
              isVerified: true,
            });
          } else {
            const sender = await EmailSenderModel.create({
              userId,
              type: 'gmail',
              label: `Gmail - ${cred.accountIdentifier || cred.accountName || 'Account'}`,
              email: gmailEmail,
              displayName: cred.accountName || null,
              isVerified: true,
              credentialId: cred.id,
            });
            created.push(sender);
          }
        } else if (
          existing.email !== (cred.accountIdentifier || '') ||
          existing.displayName !== (cred.accountName || null) ||
          !existing.isVerified
        ) {
          await EmailSenderModel.update(userId, existing.id, {
            email: cred.accountIdentifier || existing.email,
            displayName: cred.accountName || cred.accountIdentifier || null,
            isVerified: true,
          });
        }
      }
    } catch { /* Gmail not configured */ }

    const senders = await EmailSenderModel.listByUser(userId);
    return res.json({ success: true, senders, synced: created.length });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[EmailSendersController] Error syncing senders');
    return res.status(500).json({ error: 'Failed to sync email senders' });
  }
}
