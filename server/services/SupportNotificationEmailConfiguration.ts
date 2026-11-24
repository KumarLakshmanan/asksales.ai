import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';

interface EmailCredential {
  apiKey?: string | null;
  config?: Record<string, unknown> | null;
}

/** Use the same configured sender as platform mail; never invent a sending domain. */
export function resolveSupportNotificationEmailSender(
  resend: EmailCredential | null,
  smtp: EmailCredential | null,
  environment: { SUPPORT_NOTIFICATION_FROM_EMAIL?: string; DEFAULT_FROM_EMAIL?: string },
): string | null {
  if (!resend?.apiKey) return null;
  const sender = environment.SUPPORT_NOTIFICATION_FROM_EMAIL
    || resend.config?.fromEmail
    || (smtp?.config?.provider === 'resend' ? smtp.config.fromEmail : undefined)
    || environment.DEFAULT_FROM_EMAIL;
  // Only a mailbox is accepted here; display names are supplied by the service.
  return typeof sender === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender.trim())
    ? sender.trim() : null;
}

export async function getSupportNotificationEmailSender(): Promise<string | null> {
  const [resend, smtp] = await Promise.all([
    getActiveAdminCredential('resend'), getActiveAdminCredential('smtp'),
  ]);
  return resolveSupportNotificationEmailSender(resend, smtp, process.env);
}
