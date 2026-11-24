/**
 * Email Utility for System Emails (verification, password reset, etc.)
 * 
 * PRIORITY FOR EMAIL SENDING:
 * 1. Resend API (admin_api_credentials with platform='resend')
 * 2. Admin SMTP (admin_api_credentials with platform='smtp')
 * 3. Legacy system SMTP credentials (api_credentials with serviceName='smtp' and isSystemKey=true)
 * 4. Environment variables (GMAIL_USER, GMAIL_APP_PASSWORD) - fallback
 */

import { logger } from './logger.js';
import nodemailer, { type Transporter } from "nodemailer";
import { db } from "../models/db";
import { apiCredentialsTable } from "../models/apiCredentials/schema";
import { adminApiCredentialsTable } from "../models/adminApiCredentials/schema";
import { decryptAdminCredential } from "../models/adminApiCredentials/functions";
import { eq, and, sql } from "drizzle-orm";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName?: string;
  fromEmail?: string;
}

interface ResendConfig {
  apiKey: string;
  fromName?: string;
  fromEmail?: string;
}

interface MailPayload {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

/**
 * Get active Resend configuration from admin_api_credentials.
 * Resolves fromEmail by checking:
 *   1. Resend credential config.fromEmail
 *   2. Resend-backed SMTP credential config.fromEmail
 *   3. DEFAULT_FROM_EMAIL env var
 */
async function getResendConfig(): Promise<ResendConfig | null> {
  try {
    const [credential] = await db
      .select()
      .from(adminApiCredentialsTable)
      .where(
        and(
          eq(adminApiCredentialsTable.platform, "resend"),
          eq(adminApiCredentialsTable.isActive, true)
        )
      )
      .limit(1);

    if (!credential || !credential.apiKey) {
      return null;
    }
    const resolvedCredential = decryptAdminCredential(credential);

    const config = credential.config || {};
    let fromEmail = config.fromEmail as string | undefined;
    let fromName = config.fromName as string | undefined;

    // If the Resend credential itself doesn't specify fromEmail,
    // try the Resend-backed SMTP credential (which requires fromEmail).
    if (!fromEmail) {
      const [smtpCred] = await db
        .select()
        .from(adminApiCredentialsTable)
        .where(
          and(
            eq(adminApiCredentialsTable.platform, "smtp"),
            eq(adminApiCredentialsTable.isActive, true)
          )
        )
        .limit(1);

      const smtpConfig = (smtpCred?.config || {}) as Record<string, unknown>;
      if (smtpConfig.provider === 'resend' && smtpConfig.fromEmail) {
        fromEmail = smtpConfig.fromEmail as string;
        if (!fromName && smtpConfig.fromName) {
          fromName = smtpConfig.fromName as string;
        }
      }
    }

    // Final fallback: DEFAULT_FROM_EMAIL env var
    if (!fromEmail) {
      fromEmail = process.env.DEFAULT_FROM_EMAIL;
    }

    if (!fromEmail) {
      logger.error('[Email] Resend credential found but no fromEmail configured. Set fromEmail in the Resend or SMTP integration config, or set DEFAULT_FROM_EMAIL env var.');
      return null;
    }

    logger.info({ fromEmail }, '[Email] Found active Resend configuration');
    return {
      apiKey: resolvedCredential.apiKey,
      fromName: fromName,
      fromEmail: fromEmail,
    };
  } catch (error) {
    logger.error({ err: error }, '[Email] Error getting Resend config');
    return null;
  }
}

/**
 * Send email via Resend API
 */
async function sendViaResend(resendConfig: ResendConfig, payload: MailPayload): Promise<{ success: boolean; error?: unknown }> {
  const { Resend } = await import('resend');
  const resend = new Resend(resendConfig.apiKey);

  const fromEmail = resendConfig.fromEmail;
  const fromName = resendConfig.fromName || 'Sales & Marketing';
  const from = payload.from || `${fromName} <${fromEmail}>`;

  const { error } = await resend.emails.send({
    from,
    to: [payload.to],
    subject: payload.subject,
    html: payload.html,
  });

  if (error) {
    logger.error({ err: error }, '[Email] Resend send failed');
    return { success: false, error };
  }

  logger.info({ to: payload.to }, '[Email] Sent via Resend');
  return { success: true };
}

/**
 * Unified email sender: tries Resend first, falls back to SMTP.
 */
async function sendSystemEmail(payload: MailPayload): Promise<{ success: boolean; error?: unknown }> {
  // 1. Try Resend first
  const resendConfig = await getResendConfig();
  if (resendConfig) {
    try {
      return await sendViaResend(resendConfig, payload);
    } catch (err) {
      logger.warn({ err }, '[Email] Resend failed, falling back to SMTP');
    }
  }

  // 2. Fall back to SMTP
  const { transporter, fromAddress } = await createSmtpTransporter();
  await transporter.sendMail({
    from: payload.from || fromAddress,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
  });
  return { success: true };
}

/**
 * Get admin SMTP configuration from new admin_api_credentials table
 */
async function getNewAdminSmtpConfig(): Promise<SmtpConfig | null> {
  try {
    const [adminCredential] = await db
      .select()
      .from(adminApiCredentialsTable)
      .where(
        and(
          eq(adminApiCredentialsTable.platform, "smtp"),
          eq(adminApiCredentialsTable.isActive, true)
        )
      )
      .orderBy(sql`CASE 
        WHEN ${adminApiCredentialsTable.priority} = 'high' THEN 1 
        WHEN ${adminApiCredentialsTable.priority} = 'normal' THEN 2 
        WHEN ${adminApiCredentialsTable.priority} = 'low' THEN 3 
        ELSE 4 
      END`)
      .limit(1);

    if (!adminCredential || !adminCredential.apiKey) {
      return null;
    }
    const resolvedCredential = decryptAdminCredential(adminCredential);

    const config = resolvedCredential.config || {};
    
    logger.info('[Email] Using admin SMTP configuration from admin_api_credentials');
    return {
      host: config.host as string || 'smtp.gmail.com',
      port: config.port as number || 587,
      secure: config.secure as boolean || false,
      user: resolvedCredential.apiKey,
      pass: resolvedCredential.apiSecret || '',
      fromName: config.fromName as string,
      fromEmail: config.fromEmail as string,
    };
  } catch (error) {
    logger.error({ err: error }, '[Email] Error getting new admin SMTP config:');
    return null;
  }
}

/**
 * Get admin SMTP configuration from legacy api_credentials table
 */
async function getLegacyAdminSmtpConfig(): Promise<SmtpConfig | null> {
  try {
    const systemCredentials = await db
      .select({
        apiKey: apiCredentialsTable.apiKey,
        apiSecret: apiCredentialsTable.apiSecret,
        config: apiCredentialsTable.config,
      })
      .from(apiCredentialsTable)
      .where(
        and(
          eq(apiCredentialsTable.serviceName, "smtp"),
          eq(apiCredentialsTable.isActive, true),
          sql`(${apiCredentialsTable.config}->>'isSystemKey')::boolean = true`
        )
      )
      .limit(1);

    if (systemCredentials.length === 0 || !systemCredentials[0].apiKey || !systemCredentials[0].apiSecret) {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = systemCredentials[0].config as Record<string, any> || {};
    
    logger.info('[Email] Using legacy admin SMTP configuration');
    return {
      host: config.host || 'smtp.gmail.com',
      port: config.port || 587,
      secure: config.secure || false,
      user: systemCredentials[0].apiKey,
      pass: systemCredentials[0].apiSecret,
      fromName: config.fromName,
      fromEmail: config.fromEmail,
    };
  } catch (error) {
    logger.error({ err: error }, '[Email] Error getting legacy admin SMTP config:');
    return null;
  }
}

/**
 * Create nodemailer transporter with admin SMTP config or fallback to env vars
 */
async function createSmtpTransporter(): Promise<{ transporter: Transporter; fromAddress: string }> {
  // Try to get new admin SMTP config first
  let adminConfig = await getNewAdminSmtpConfig();
  
  // Fallback to legacy admin SMTP config
  if (!adminConfig) {
    adminConfig = await getLegacyAdminSmtpConfig();
  }
  
  if (adminConfig) {
    const transporter = nodemailer.createTransport({
      host: adminConfig.host,
      port: adminConfig.port,
      secure: adminConfig.secure,
      auth: {
        user: adminConfig.user,
        pass: adminConfig.pass,
      },
    });
    
    const fromEmail = adminConfig.fromEmail || adminConfig.user;
    const fromName = adminConfig.fromName || 'Sales & Marketing';
    const fromAddress = `${fromName} <${fromEmail}>`;
    
    return { transporter, fromAddress };
  }
  
  throw new Error('SMTP not configured. Set it in Admin Panel → Integrations → SMTP.');
}

export async function sendVerificationEmail(email: string, otp: string, name: string) {
  try {
    const { renderAdminEmail } = await import('./emailTemplates');
    const clientUrl = (process.env.CLIENT_URL || process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const verificationUrl = `${clientUrl}/verify-email?email=${encodeURIComponent(email)}`;
    
    const html = renderAdminEmail({
      title: 'Verify Your Email Address',
      preheader: 'Your six-digit AskSales.ai verification OTP is ready.',
      name: name,
      content: 'Thank you for registering. Use the six-digit verification OTP below to verify your email address and complete your registration.',
      otp,
      otpLabel: 'Your Verification OTP',
      cta: {
        label: 'Open Verification Page',
        url: verificationUrl,
      },
      footer: 'This verification OTP expires in 10 minutes. If you didn’t create an account, please ignore this email.'
    });

    const result = await sendSystemEmail({
      to: email,
      subject: "Verify Your Email Address",
      html: html,
    });

    logger.info(`[Email] Verification email sent to ${email}`);
    return result;
  } catch (error) {
    logger.error({ err: error }, "Error sending verification email:");
    return { success: false, error };
  }
}

export async function sendResetPasswordEmail(email: string, otp: string, name: string) {
  try {
    const { renderAdminEmail } = await import('./emailTemplates');

    const html = renderAdminEmail({
      title: 'Reset Your Password',
      preheader: 'You requested to reset your password. Use the code below to set a new one.',
      name: name,
      content: 'You requested to reset your password. Use the security code below to reset your password and secure your account.',
      otp: otp,
      footer: 'This OTP will expire in 15 minutes. If you didn’t request a password reset, please ignore this email.'
    });

    const result = await sendSystemEmail({
      to: email,
      subject: "Reset Your Password",
      html: html,
    });

    logger.info(`[Email] Password reset email sent to ${email}`);
    return result;
  } catch (error) {
    logger.error({ err: error }, "Error sending reset password email:");
    return { success: false, error };
  }
}

export async function sendApprovalPendingEmail(email: string, name: string) {
  try {
    const { renderAdminEmail } = await import('./emailTemplates');

    const html = renderAdminEmail({
      title: 'Your Account is Under Review',
      preheader: 'Thank you for completing your onboarding! Our team is reviewing your account.',
      name: name,
      content: 'Thank you for completing your onboarding setup! Your account is currently under review by our admin team. We will notify you once your account is fully activated.'
    });

    const result = await sendSystemEmail({
      to: email,
      subject: "Your Account is Under Review",
      html: html,
    });

    logger.info(`[Email] Approval pending email sent to ${email}`);
    return result;
  } catch (error) {
    logger.error({ err: error }, "Error sending approval pending email:");
    return { success: false, error };
  }
}

export async function sendNewUserNotificationToAdmin(adminEmail: string, userName: string, userEmail: string) {
  try {
    const { renderAdminEmail } = await import('./emailTemplates');
    const adminUrl = `${process.env.ADMIN_URL || process.env.CLIENT_URL || 'http://localhost:5173'}/users`;

    const html = renderAdminEmail({
      title: 'New User Registration',
      preheader: `A new user ${userName} has registered and awaits approval.`,
      content: `A new user has registered and is awaiting approval. Please log in to the admin panel to review and approve this user before they can access all platform features.`,
      footer: `New User: ${userName} (${userEmail})`,
      cta: {
        label: 'Review in Admin Panel',
        url: adminUrl
      }
    });

    const result = await sendSystemEmail({
      to: adminEmail,
      subject: "New User Registration - Approval Required",
      html: html,
    });

    logger.info(`[Email] New user notification sent to admin ${adminEmail}`);
    return result;
  } catch (error) {
    logger.error({ err: error }, "Error sending admin notification email:");
    return { success: false, error };
  }
}

export async function sendApprovalConfirmationEmail(email: string, name: string) {
  try {
    const { renderAdminEmail } = await import('./emailTemplates');
    const loginUrl = `${process.env.CLIENT_URL || process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;

    const html = renderAdminEmail({
      title: 'Your Account Has Been Approved!',
      preheader: 'Great news! Your AskSales.ai account is now active and ready for use.',
      name: name,
      content: 'Great news! Your account has been successfully approved by our admin team. You can now access all features of our powerful sales and marketing automation platform.',
      cta: {
        label: 'Log In Now',
        url: loginUrl
      }
    });

    const result = await sendSystemEmail({
      to: email,
      subject: "Your Account Has Been Approved!",
      html: html,
    });

    logger.info(`[Email] Approval confirmation email sent to ${email}`);
    return result;
  } catch (error) {
    logger.error({ err: error }, "Error sending approval confirmation email:");
    return { success: false, error };
  }
}
