/**
 * Admin Email Service
 * Sends system emails (OTP, password reset, notifications) using admin SMTP or Resend credentials
 * This is separate from user outreach emails - uses admin-configured SMTP or Resend
 */

import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { logger } from '../utils/logger.js';
import { getActiveAdminCredential, getAdminCredentialById, markAdminCredentialInactive, updateAdminCredentialLastUsed } from '../models/adminApiCredentials/functions';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
}

/**
 * Determine if the active SMTP credential is a Resend-backed config
 */
function isResendConfig(config: Record<string, unknown>): boolean {
  return config.provider === 'resend';
}

/**
 * Send email via Resend SDK using a Resend-backed SMTP config
 */
async function sendViaResend(
  smtpCredential: { id: number; config: Record<string, unknown> },
  options: SendEmailOptions
): Promise<SendEmailResult> {
  const config = smtpCredential.config;
  const resendCredentialId = config.resendCredentialId as number;

  // Get the actual Resend API key from the referenced resend credential
  let apiKey: string | undefined;
  if (resendCredentialId) {
    const resendCred = await getAdminCredentialById(resendCredentialId);
    if (resendCred) {
      apiKey = resendCred.apiKey;
    }
  }

  // Fallback to general active resend credential
  if (!apiKey) {
    const resendCred = await getActiveAdminCredential('resend');
    apiKey = resendCred?.apiKey;
  }

  if (!apiKey) {
    return { success: false, deliveryAttempted: false, outcomeUncertain: false, error: 'Resend API key not configured. Set it in Admin Panel → Integrations → Resend.' };
  }

  const resend = new Resend(apiKey);
  const fromEmail = config.fromEmail as string;
  const fromName = config.fromName as string || 'AskSales.ai Platform';

  const { data, error } = await resend.emails.send({
    from: `${fromName} <${fromEmail}>`,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  if (error) {
    // An explicit client rejection (for example an unverified sender domain)
    // confirms no email was accepted. Timeouts and server failures stay uncertain.
    const rejected = typeof error.statusCode === 'number' && error.statusCode >= 400
      && error.statusCode < 500 && error.statusCode !== 408;
    return { success: false, error: error.message, deliveryAttempted: true, outcomeUncertain: !rejected };
  }

  if (!data?.id) return { success: false, deliveryAttempted: true, outcomeUncertain: true, error: 'Email provider did not confirm acceptance.' };

  await updateAdminCredentialLastUsed(smtpCredential.id);
  logger.info(`[AdminEmailService] Email sent via Resend to ${options.to}: ${data?.id}`);

  return { success: true, messageId: data?.id };
}

/**
 * Get from address from the active SMTP credential
 */
async function getFromAddress(): Promise<{ email: string; name: string } | null> {
  const smtpCredential = await getActiveAdminCredential('smtp');
  
  if (!smtpCredential) return null;
  
  const config = smtpCredential.config || {};
  
  return {
    email: config.fromEmail as string || smtpCredential.apiKey,
    name: config.fromName as string || 'AskSales.ai Platform',
  };
}

/**
 * Send email using admin credentials (auto-detects Resend or SMTP)
 */
export async function sendAdminEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  try {
    // Get the active SMTP credential to check if it's Resend-backed
    const smtpCredential = await getActiveAdminCredential('smtp');

    if (!smtpCredential) {
      return {
        success: false,
        deliveryAttempted: false,
        outcomeUncertain: false,
        error: 'No email configuration found. Please configure SMTP or Resend in Admin > Integrations.',
      };
    }

    const config = (smtpCredential.config || {}) as Record<string, unknown>;

    // If Resend-backed, use Resend SDK
    if (isResendConfig(config)) {
      return await sendViaResend({ id: smtpCredential.id, config }, options);
    }

    // Otherwise use traditional SMTP
    const transporter = nodemailer.createTransport({
      host: config.host as string || 'smtp.gmail.com',
      port: config.port as number || 587,
      secure: config.secure as boolean || false,
      auth: {
        user: smtpCredential.apiKey,
        pass: smtpCredential.apiSecret || '',
      },
    });

    const fromAddress = await getFromAddress();
    
    const mailOptions = {
      from: fromAddress ? `"${fromAddress.name}" <${fromAddress.email}>` : undefined,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    };
    
    const info = await transporter.sendMail(mailOptions);
    
    await updateAdminCredentialLastUsed(smtpCredential.id);
    
    logger.info(`[AdminEmailService] Email sent to ${options.to}: ${info.messageId}`);
    
    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: errorMessage }, '[AdminEmailService] Failed to send email:');
    
    // Check if this is an auth error and mark credential as inactive
    if (errorMessage.includes('auth') || errorMessage.includes('credentials') || errorMessage.includes('535')) {
      const smtpCredential = await getActiveAdminCredential('smtp');
      if (smtpCredential) {
        await markAdminCredentialInactive(smtpCredential.id, 'auth_failed');
      }
    }
    
    return {
      success: false,
      error: errorMessage,
    };
  }
}

