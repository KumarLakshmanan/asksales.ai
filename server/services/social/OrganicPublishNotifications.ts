import type { SocialPublishAttempt } from '../../models/socialPublishAttempts/schema.js';
import { logger } from '../../utils/logger.js';
import { escapeHtml } from '../../../shared/html.js';

/** Called only after an atomic transition into a terminal or uncertain outcome. */
export async function notifyOrganicPublishFailure(attempt: SocialPublishAttempt): Promise<void> {
  const publishedWarning = attempt.status === 'succeeded' && attempt.errorCode === 'YOUTUBE_EXTRAS_FAILED';
  if (!['failed', 'ambiguous'].includes(attempt.status) && !publishedWarning) return;
  try {
    const { NotificationService } = await import('../NotificationService.js');
    const { db } = await import('../../models/db.js');
    const { usersTable } = await import('../../models/users/schema.js');
    const { eq } = await import('drizzle-orm');
    const [user] = await db.select({ email: usersTable.email, name: usersTable.name, preferences: usersTable.notificationPreferences })
      .from(usersTable).where(eq(usersTable.id, attempt.userId)).limit(1);
    if (!user || user.preferences?.campaignUpdates === false) return;
    const uncertain = attempt.status === 'ambiguous';
    const platformNames: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube' };
    const platformName = platformNames[attempt.platform] || attempt.platform;
    const title = publishedWarning ? 'YouTube video published with a setup warning' : uncertain ? `${platformName} publishing needs a status check` : `${platformName} publishing failed`;
    const message = `${attempt.reviewedPayload.title || 'Your post'}: ${attempt.errorMessage || 'The provider could not complete publishing.'} ${publishedWarning ? 'Open the published video in YouTube Studio to finish its thumbnail or playlist settings.' : uncertain ? 'Check provider status before retrying.' : 'Open the calendar to review the error and recovery options.'}`;
    const actionUrl = `/dashboard/content-calendar?assetId=${attempt.assetId}`;
    await NotificationService.notify(attempt.userId, title, message, uncertain || publishedWarning ? 'warning' : 'error', { actionUrl });
    if (user.preferences?.emailNotifications !== false && user.email) {
      const { sendAdminEmail } = await import('../adminEmailService.js');
      const { renderAdminEmail } = await import('../../utils/emailTemplates.js');
      await sendAdminEmail({ to: user.email, subject: title, html: renderAdminEmail({
        title, name: user.name || user.email, preheader: title,
        content: `${escapeHtml(message)}<br><br><a href="https://asksales.ai${actionUrl}">Review publishing in the content calendar</a>`,
        footer: 'Manage publishing notifications in your account notification preferences.',
      }) });
    }
  } catch (error) {
    // A notification outage must not rewrite the provider outcome or repeat a send.
    logger.warn({ err: error, attemptId: attempt.id }, '[OrganicPublishing] Failure notification could not be delivered');
  }
}
