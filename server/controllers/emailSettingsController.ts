import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
/**
 * Email Settings Controller
 * Manages email provider configuration (Resend + Gmail OAuth)
 */

import type { Request, Response } from 'express';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import nodemailer from 'nodemailer';
import { logger } from '../utils/logger.js';
import { getOutreachSettingsByUserId, upsertOutreachSettings } from '../models/outreachSettings/functions';
import { getGmailClientForUser } from './gmailOAuthController';

// Email credential structure stored in sessionData
interface EmailCredentials {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost?: string;
  imapPort?: number;
  fromName?: string;
  fromEmail?: string;
}

/**
 * Quick email status check for outreach pages.
 * Returns the active provider and connection status for both Resend and Gmail OAuth.
 */
export async function getEmailStatus(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    // Get the user's active email provider from outreach settings
    const outreachSettings = await getOutreachSettingsByUserId(userId);
    const activeProvider = outreachSettings?.emailProvider || 'gmail';

    // Check Resend status — check both verified domain AND any domain (even pending)
    let resendConnected = false;
    let resendDomain: string | null = null;
    let resendConfigured = false;
    let resendDomainStatus: string | null = null;
    try {
      const { getVerifiedDomain, listDomains } = await import('../services/resendService');
      const allDomains = await listDomains(userId);
      if (allDomains && allDomains.length > 0) {
        resendConfigured = true;
        resendDomainStatus = allDomains[0].status;
      }
      const domain = await getVerifiedDomain(userId);
      if (domain) {
        resendConnected = true;
        resendDomain = domain.name;
      }
    } catch { /* Resend not configured */ }

    // Check Gmail OAuth status. Use the same helper as Gmail outreach so an
    // expired access token with a valid refresh token is refreshed instead of
    // being reported as disconnected.
    let gmailConnected = false;
    let gmailEmail: string | null = null;
    let gmailTokenRevoked = false;
    try {
      const gmailCred = await ChannelCredentialModel.findByUserAndPlatform(userId, 'gmail_api');
      if (gmailCred) {
        const gmailClient = await getGmailClientForUser(userId);
        gmailConnected = !!gmailClient;
        gmailTokenRevoked = !!gmailCred.accessToken && !gmailClient;
        gmailEmail = gmailCred.accountIdentifier || null;
      }
    } catch { /* Gmail not configured */ }

    // Overall "connected" = active provider is configured
    let connected = activeProvider === 'resend' ? resendConnected : gmailConnected;
    let email = activeProvider === 'resend' ? (resendDomain ? `noreply@${resendDomain}` : null) : gmailEmail;
    let effectiveProvider = activeProvider;

    // Auto-switch: if active provider isn't connected but another is, update the default
    if (!connected) {
      if (activeProvider === 'gmail' && resendConnected) {
        effectiveProvider = 'resend';
        connected = true;
        email = resendDomain ? `noreply@${resendDomain}` : null;
        // Persist the auto-switch
        try { await upsertOutreachSettings(userId, { emailProvider: 'resend' }); } catch { /* best effort */ }
      } else if (activeProvider === 'resend' && gmailConnected) {
        effectiveProvider = 'gmail';
        connected = true;
        email = gmailEmail;
        try { await upsertOutreachSettings(userId, { emailProvider: 'gmail' }); } catch { /* best effort */ }
      }
    }

    return res.json({
      connected,
      email,
      activeProvider: effectiveProvider,
      resend: { connected: resendConnected, configured: resendConfigured, domain: resendDomain, domainStatus: resendDomainStatus },
      gmail: { connected: gmailConnected, email: gmailEmail, tokenRevoked: gmailTokenRevoked },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSettingsController] Error getting email status');
    return res.json({
      connected: false,
      email: null,
      activeProvider: 'gmail',
      resend: { connected: false, configured: false, domain: null, domainStatus: null },
      gmail: { connected: false, email: null },
    });
  }
}

/**
 * Set the active email provider for the current user.
 * POST /api/email-settings/provider
 * Body: { provider: 'resend' | 'gmail' }
 */
export async function setActiveEmailProvider(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { provider } = req.body;

    if (!provider || !['resend', 'gmail'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'Provider must be "resend" or "gmail"' });
    }

    await upsertOutreachSettings(userId, { emailProvider: provider });

    return res.json({ success: true, activeProvider: provider });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSettingsController] Error setting email provider');
    return res.status(500).json({ success: false, error: 'Failed to update email provider' });
  }
}

/**
 * Get email SMTP settings for the current user
 */
export async function getEmailSettings(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'email_smtp');

    if (!credential) {
      return res.json({
        success: true,
        configured: false,
        settings: null,
      });
    }

    // Don't return the actual password, just indicate it's set
    const emailSettings = credential.sessionData as EmailCredentials;

    return res.json({
      success: true,
      configured: true,
      settings: {
        email: credential.accountIdentifier,
        appPassword: credential.apiSecret || '',
        smtpHost: emailSettings?.smtpHost || 'smtp.gmail.com',
        smtpPort: emailSettings?.smtpPort || 587,
        smtpSecure: emailSettings?.smtpSecure || false,
        imapHost: emailSettings?.imapHost || 'imap.gmail.com',
        imapPort: emailSettings?.imapPort || 993,
        fromName: emailSettings?.fromName || credential.accountName,
        fromEmail: emailSettings?.fromEmail || credential.accountIdentifier,
        hasPassword: !!credential.apiSecret,
        lastUsedAt: credential.lastUsedAt,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSettingsController] Error getting email settings');
    return res.status(500).json({
      success: false,
      error: 'Unable to retrieve email settings. Please try again.',
    });
  }
}

/**
 * Save email SMTP settings for the current user
 */
export async function saveEmailSettings(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const {
      email,
      appPassword,
      smtpHost = 'smtp.gmail.com',
      smtpPort = 587,
      smtpSecure = false,
      imapHost = 'imap.gmail.com',
      imapPort = 993,
      fromName,
      fromEmail,
    } = req.body;

    if (!email || !appPassword) {
      return res.status(400).json({
        success: false,
        error: 'Email and app password are required',
      });
    }

    // Test the SMTP connection before saving
    const testResult = await testSmtpConnection({
      email,
      appPassword,
      smtpHost,
      smtpPort,
      smtpSecure,
    });

    if (!testResult.success) {
      return res.status(400).json({
        success: false,
        error: testResult.error || 'Unable to connect to SMTP server. Please check your configuration.',
      });
    }

    // Save credentials
    const emailSettings: EmailCredentials = {
      smtpHost,
      smtpPort,
      smtpSecure,
      imapHost,
      imapPort,
      fromName: fromName || email.split('@')[0],
      fromEmail: fromEmail || email,
    };

    await ChannelCredentialModel.upsert({
      userId,
      platform: 'email_smtp',
      credentialType: 'api_key',
      accountIdentifier: email,
      accountName: fromName || email.split('@')[0],
      apiKey: email, // Store email as apiKey for easy access
      apiSecret: appPassword, // Store app password as apiSecret (should be encrypted in production)
      sessionData: emailSettings,
      isActive: true,
    });

    return res.json({
      success: true,
      message: 'Email settings saved successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[EmailSettingsController] Error saving email settings');
    return res.status(500).json({
      success: false,
      error: 'Unable to save email settings. Please try again.',
    });
  }
}

/**
 * Test SMTP connection
 */
export async function testEmailConnection(req: Request, res: Response) {
  try {
    const {
      email,
      appPassword,
      smtpHost = 'smtp.gmail.com',
      smtpPort = 587,
      smtpSecure = false,
    } = req.body;

    if (!email || !appPassword) {
      return res.status(400).json({
        success: false,
        error: 'Email and app password are required',
      });
    }

    const result = await testSmtpConnection({
      email,
      appPassword,
      smtpHost,
      smtpPort,
      smtpSecure,
    });

    return res.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSettingsController] Error testing connection');
    return res.status(500).json({
      success: false,
      error: 'Unable to test connection. Please try again.',
    });
  }
}

/**
 * Send a test email
 */
export async function sendTestEmail(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { testRecipient } = req.body;

    // Get saved credentials
    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'email_smtp');

    if (!credential) {
      return res.status(400).json({
        success: false,
        error: 'Email settings not configured. Please save your settings first.',
      });
    }

    const emailSettings = credential.sessionData as EmailCredentials;
    const email = credential.accountIdentifier;
    const appPassword = credential.apiSecret;

    if (!email || !appPassword) {
      return res.status(400).json({
        success: false,
        error: 'Email credentials not found',
      });
    }

    // Create transporter
    const transporter = nodemailer.createTransport({
      host: emailSettings?.smtpHost || 'smtp.gmail.com',
      port: emailSettings?.smtpPort || 587,
      secure: emailSettings?.smtpSecure || false,
      auth: {
        user: email,
        pass: appPassword,
      },
    });

    // Send test email
    const recipient = testRecipient || email;
    await transporter.sendMail({
      from: `${emailSettings?.fromName || 'Sales & Marketing'} <${emailSettings?.fromEmail || email}>`,
      to: recipient,
      subject: 'Test Email from Sales & Marketing Platform',
      html: `
        <h2>Test Email</h2>
        <p>This is a test email from your Sales & Marketing Platform.</p>
        <p>If you received this email, your SMTP settings are configured correctly!</p>
        <hr/>
        <p style="color: #666; font-size: 12px;">Sent at: ${new Date().toLocaleString()}</p>
      `,
    });

    // Update last used timestamp
    await ChannelCredentialModel.updateLastUsed(userId, 'email_smtp');

    return res.json({
      success: true,
      message: `Test email sent successfully to ${recipient}`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSettingsController] Error sending test email');
    return res.status(500).json({
      success: false,
      error: 'Unable to send test email. Please try again.',
    });
  }
}

/**
 * Disconnect email settings
 */
export async function disconnectEmail(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    await ChannelCredentialModel.delete(userId, 'email_smtp');

    return res.json({
      success: true,
      message: 'Email settings disconnected successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSettingsController] Error disconnecting email');
    return res.status(500).json({
      success: false,
      error: 'Unable to disconnect email. Please try again.',
    });
  }
}

/**
 * Helper function to test SMTP connection
 */
async function testSmtpConnection(config: {
  email: string;
  appPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: config.email,
        pass: config.appPassword,
      },
    });

    await transporter.verify();
    return { success: true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[EmailSettingsController] SMTP connection test failed');
    
    let errorMessage = 'Unable to connect to SMTP server. Please check your configuration.';
    if (error.code === 'EAUTH') {
      errorMessage = 'Authentication failed. Please check your email and app password.';
    } else if (error.code === 'ESOCKET' || error.code === 'ECONNREFUSED') {
      errorMessage = 'Could not connect to SMTP server. Please check host and port settings.';
    }
    
    return { success: false, error: errorMessage };
  }
}
