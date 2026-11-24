/**
 * NotificationService
 * Creates in-app notifications for users on key platform events.
 */

import { createNotification } from '../models/notifications/functions.js';
import { logger } from '../utils/logger.js';
import { db } from '../models/db.js';
import { usersTable } from '../models/users/schema.js';
import { eq } from 'drizzle-orm';

type NotificationPreference = 'leadAlerts' | 'campaignUpdates';

export class NotificationService {
  /**
   * Save a notification for a user. Non-blocking — errors are logged but not thrown.
   */
  static async notify(
    userId: number,
    title: string,
    message: string,
    type: 'info' | 'success' | 'warning' | 'error' = 'info',
    options?: { actionUrl?: string; preference?: NotificationPreference },
  ): Promise<boolean> {
    try {
      if (options?.preference) {
        const [user] = await db
          .select({ notificationPreferences: usersTable.notificationPreferences })
          .from(usersTable)
          .where(eq(usersTable.id, userId))
          .limit(1);
        if (!user || user.notificationPreferences?.[options.preference] === false) {
          return false;
        }
      }
      const actionUrl = options?.actionUrl && /^\/dashboard(?:\/|$)/.test(options.actionUrl) && !options.actionUrl.includes('\\')
        ? options.actionUrl
        : null;
      const notification = await createNotification({ userId, title, message, type, actionUrl });
      
      // The database record is authoritative. Redis/WebSocket fan-out is
      // best-effort and must never hold up the user-facing mutation while a
      // broker is reconnecting.
      void import('../events/EventBus.js')
        .then(({ eventBus }) => eventBus.publish({
          channel: 'events:notification',
          userId,
          data: { notification },
          timestamp: new Date().toISOString(),
        }))
        .catch((busErr) => {
          logger.warn({ err: busErr, userId }, '[NotificationService] Failed to publish notification to EventBus');
        });
      return true;
    } catch (err) {
      logger.error({ err, userId, title }, '[NotificationService] Failed to save notification');
      return false;
    }
  }

  /**
   * Queued outreach stopped because the wallet ran out. Each message fails on
   * its own, so a large queue would otherwise fail silently by the thousand;
   * tell the owner once a day per business instead.
   */
  static async outreachOutOfCredits(userId: number, channel: string): Promise<boolean> {
    try {
      const { getRedisConnection } = await import('../infrastructure/redis.js');
      const { currentBusinessScope } = await import('../tenancy/businessContext.js');
      const business = currentBusinessScope()?.businessProfileId ?? 'none';
      const first = await getRedisConnection().set(`notify:outreach-credits:${userId}:${business}`, '1', 'EX', 86_400, 'NX');
      if (first !== 'OK') return false;
    } catch (err) {
      // Without Redis we cannot tell whether today's notice already went out; skip rather than repeat it per message.
      logger.warn({ err, userId }, '[NotificationService] Could not check the out-of-credits notice');
      return false;
    }
    const label = channel === 'whatsapp' ? 'WhatsApp' : channel === 'gmail' || channel === 'resend' ? 'email' : channel;
    return NotificationService.notify(userId, 'Outreach stopped: wallet is empty',
      `Queued ${label} messages can't be sent until you recharge. Messages that already failed for this reason can be retried from Reports after recharging.`,
      'error', { actionUrl: '/dashboard/billing/recharge' });
  }

  static async icpGenerated(userId: number, campaignName: string, fitScore: number): Promise<void> {
    await this.notify(
      userId,
      'ICP Profile Generated',
      `Your ICP "${campaignName}" has been created with a ${fitScore}% fit score.`,
      'success',
      { actionUrl: '/dashboard/campaigns', preference: 'campaignUpdates' },
    );
  }

  static async leadsGenerated(userId: number, count: number, source?: string): Promise<void> {
    await this.notify(
      userId,
      'Leads Generated',
      `${count} lead${count !== 1 ? 's' : ''} have been generated${source ? ` from ${source}` : ''}.`,
      'success',
      { actionUrl: '/dashboard/leads', preference: 'leadAlerts' },
    );
  }

  static async campaignCreated(userId: number, campaignName: string): Promise<void> {
    await this.notify(
      userId,
      'Campaign Created',
      `Campaign "${campaignName}" has been created successfully.`,
      'success',
      { actionUrl: '/dashboard/campaigns', preference: 'campaignUpdates' },
    );
  }

  static async outreachStarted(userId: number, campaignName: string, leadCount: number): Promise<void> {
    await this.notify(
      userId,
      'Outreach Campaign Started',
      `Outreach for "${campaignName}" has started for ${leadCount} lead${leadCount !== 1 ? 's' : ''}.`,
      'info',
      { actionUrl: '/dashboard/outreach', preference: 'campaignUpdates' },
    );
  }

  static async contentGenerated(userId: number, contentType: string, title?: string): Promise<void> {
    await this.notify(
      userId,
      'Content Generated',
      title
        ? `"${title}" (${contentType}) has been generated successfully.`
        : `Your ${contentType} has been generated successfully.`,
      'success',
      { actionUrl: '/dashboard/content/templates' },
    );
  }

  // ── Support ──────────────────────────────────────────────────────────────

  static async ticketCreated(
    userId: number,
    ticketNumber: string,
    subject: string,
    priority = 'medium',
  ): Promise<void> {
    const urgent = priority === 'urgent' || priority === 'critical';
    await this.notify(
      userId,
      urgent ? 'Urgent Support Ticket Created' : 'Support Ticket Created',
      `Ticket #${ticketNumber} — "${subject}" has been created${urgent ? ' and requires prompt attention' : ''}.`,
      urgent ? 'warning' : 'info',
      { actionUrl: '/dashboard/support' },
    );
  }

  static async ticketResolved(userId: number, ticketNumber: string, subject: string): Promise<void> {
    await this.notify(
      userId,
      'Support Ticket Resolved',
      `Ticket #${ticketNumber} — "${subject}" has been resolved and closed.`,
      'success',
      { actionUrl: '/dashboard/support' },
    );
  }

  static async ticketReplied(userId: number, ticketNumber: string, subject: string): Promise<void> {
    await this.notify(
      userId,
      'Customer Replied to Ticket',
      `A customer replied to ticket #${ticketNumber} — "${subject}".`,
      'info',
      { actionUrl: '/dashboard/support' },
    );
  }

  static async ticketSlaBreached(
    userId: number,
    ticketNumber: string,
    subject: string,
    priority: string,
  ): Promise<boolean> {
    return this.notify(
      userId,
      'Support SLA Breached',
      `Ticket #${ticketNumber} — "${subject}" missed its ${priority} priority response deadline.`,
      'error',
      { actionUrl: '/dashboard/support' },
    );
  }

  // ── Leads ────────────────────────────────────────────────────────────────

  static async leadsImported(userId: number, count: number): Promise<void> {
    await this.notify(
      userId,
      'Leads Imported',
      `${count} lead${count !== 1 ? 's' : ''} have been imported successfully.`,
      'success',
      { actionUrl: '/dashboard/leads', preference: 'leadAlerts' },
    );
  }

  static async leadsEnriched(userId: number, count: number): Promise<void> {
    await this.notify(
      userId,
      'Lead Enrichment Complete',
      `${count} lead${count !== 1 ? 's' : ''} have been enriched with additional data.`,
      'success',
      { actionUrl: '/dashboard/leads', preference: 'leadAlerts' },
    );
  }

  // ── Workflow ──────────────────────────────────────────────────────────────

  static async workflowCompleted(userId: number, workflowName: string): Promise<void> {
    await this.notify(
      userId,
      'Workflow Completed',
      `Workflow "${workflowName}" has completed successfully.`,
      'success',
      { actionUrl: '/dashboard/home' },
    );
  }

  static async workflowFailed(userId: number, workflowName: string, reason?: string): Promise<void> {
    await this.notify(
      userId,
      'Workflow Failed',
      reason
        ? `Workflow "${workflowName}" failed: ${reason}`
        : `Workflow "${workflowName}" encountered an error and could not complete.`,
      'error',
      { actionUrl: '/dashboard/home' },
    );
  }

  // ── Errors / Reminders ───────────────────────────────────────────────────

  static async operationFailed(userId: number, operationName: string, reason?: string): Promise<void> {
    await this.notify(
      userId,
      `${operationName} Failed`,
      reason || `The "${operationName}" operation could not be completed. Please try again.`,
      'error'
    );
  }

  static async reminder(userId: number, title: string, message: string): Promise<void> {
    await this.notify(userId, title, message, 'warning', { actionUrl: '/dashboard/crm/reminders' });
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  static async imageGenerated(userId: number, prompt?: string): Promise<void> {
    await this.notify(
      userId,
      'Image Generated',
      prompt ? `Your image for "${prompt.slice(0, 60)}..." is ready.` : 'Your AI-generated image is ready.',
      'success',
      { actionUrl: '/dashboard/saved-templates/image' },
    );
  }

  static async videoGenerated(userId: number, title?: string): Promise<void> {
    await this.notify(
      userId,
      'Video Ready',
      title ? `Your video "${title}" has finished processing.` : 'Your AI-generated video is ready.',
      'success',
      { actionUrl: '/dashboard/saved-templates/video' },
    );
  }

  // ── Ads & Marketing ──────────────────────────────────────────────────────

  static async adCampaignPublished(userId: number, campaignName: string, platforms: string[]): Promise<void> {
    const platformList = platforms.join(', ');
    await this.notify(
      userId,
      'Ad Campaign Published',
      `Campaign "${campaignName}" has been published to ${platformList}.`,
      'success',
      { actionUrl: '/dashboard/ads?tab=campaigns', preference: 'campaignUpdates' },
    );
  }

  static async adCampaignCreatedPaused(userId: number, campaignName: string, platforms: string[]): Promise<void> {
    const platformList = platforms.join(', ');
    await this.notify(
      userId,
      'Ad Campaign Created — Paused',
      `Campaign "${campaignName}" was created on ${platformList} in PAUSED state. It is not active yet.`,
      'info',
      { actionUrl: '/dashboard/ads?tab=campaigns', preference: 'campaignUpdates' },
    );
  }

  static async bulkEmailsSent(userId: number, sent: number, campaignName?: string): Promise<void> {
    await this.notify(
      userId,
      'Emails Sent',
      campaignName
        ? `${sent} email${sent !== 1 ? 's' : ''} sent for campaign "${campaignName}".`
        : `${sent} email${sent !== 1 ? 's' : ''} have been sent successfully.`,
      'success',
      { actionUrl: '/dashboard/outreach', preference: 'campaignUpdates' },
    );
  }

  // ── Billing ────────────────────────────────────────────────────────────────

  static async creditsAdded(userId: number, credits: number, newBalance: number): Promise<void> {
    await this.notify(
      userId,
      'Credits Added',
      `${credits} credits have been added to your account. New balance: ${newBalance} credits.`,
      'success',
      { actionUrl: '/dashboard/billing' },
    );
  }
}
