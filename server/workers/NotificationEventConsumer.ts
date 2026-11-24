import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { eventBus, type EventPayload } from '../events/EventBus.js';
import { systemAlertsTable } from '../models/systemAlerts/schema.js';

class NotificationEventConsumer {
  private static instance: NotificationEventConsumer;
  private isSubscribed = false;
  private readonly handler = async (event: EventPayload) => {
    try {
      const userId = event.userId;
      const data = event.data || {};
      // NotificationService persisted this before publishing it for
      // WebSocket delivery. Do not create a duplicate system alert.
      if (data.notification?.id) return;
      
      const title = data.title || `System Alert: ${data.type || 'info'}`;
      const message = data.message || `An alert event of type ${data.type || 'info'} was triggered.`;
      const severity = data.severity || 'medium';
      const type = data.type || 'info';
      const ticketId = data.ticketId ? Number(data.ticketId) : null;

      const [inserted] = await db.insert(systemAlertsTable).values({
        userId,
        ticketId,
        title,
        message,
        type,
        severity,
        metadata: data,
        read: false,
      }).returning();

      logger.info({ userId, alertId: inserted?.id, type }, '[NotificationEventConsumer] Persisted system alert');

      try {
        const settingsResult = await db.execute(sql`
          SELECT slack_webhook_url FROM outreach_settings WHERE user_id = ${userId} LIMIT 1
        `);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slackWebhookUrl = (settingsResult.rows as any)?.[0]?.slack_webhook_url;

        if (slackWebhookUrl) {
          const severityEmoji = severity === 'critical' ? '🔴 🚨' : severity === 'high' ? '⚠️' : '🔔';
          const payload = {
            text: `${severityEmoji} *[${severity.toUpperCase()}] ${title}*\n${message}`,
            blocks: [
              {
                type: 'header',
                text: {
                  type: 'plain_text',
                  text: `${severityEmoji} [${severity.toUpperCase()}] ${title}`,
                },
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*Alert Message:* ${message}\n*Time:* ${new Date().toLocaleString()}`,
                },
              },
            ],
          };

          const response = await fetch(slackWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            logger.warn({ status: response.status }, '[NotificationEventConsumer] Slack webhook returned error status');
          } else {
            logger.info({ userId }, '[NotificationEventConsumer] Slack notification successfully dispatched');
          }
        }
      } catch (slackErr) {
        logger.error({ err: slackErr, userId }, '[NotificationEventConsumer] Failed to dispatch Slack alert');
      }
    } catch (eventErr) {
      logger.error({ err: eventErr }, '[NotificationEventConsumer] Error processing notification event');
    }
  };

  static getInstance(): NotificationEventConsumer {
    if (!this.instance) this.instance = new NotificationEventConsumer();
    return this.instance;
  }

  async start(): Promise<void> {
    if (this.isSubscribed) return;

    try {
      await eventBus.subscribe('events:notification', this.handler, undefined, { persistent: true });

      this.isSubscribed = true;
      logger.info('[NotificationEventConsumer] Successfully subscribed to events:notification');
    } catch (err) {
      logger.error({ err }, '[NotificationEventConsumer] Failed to start notification event subscriber');
    }
  }

  async stop(): Promise<void> {
    if (!this.isSubscribed) return;
    await eventBus.unsubscribe('events:notification');
    this.isSubscribed = false;
    logger.info('[NotificationEventConsumer] Stopped');
  }
}

export const notificationEventConsumer = NotificationEventConsumer.getInstance();
