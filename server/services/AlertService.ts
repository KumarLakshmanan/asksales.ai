import { db } from '../models/db';
import { crmAlertsTable } from '../models/crmAlerts/schema';
import { crmAlertLogsTable } from '../models/crmAlertLogs/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { sendAdminEmail } from './adminEmailService';
import { renderAdminEmail } from '../utils/emailTemplates';
import { escapeHtml } from '../utils/personalization.js';

/**
 * Alert event types that users can configure rules for.
 */
export const ALERT_EVENT_TYPES = [
  { value: 'status_changed_to', label: 'Status Changed To (Incoming)' },
  { value: 'status_changed_from', label: 'Status Changed From (Outgoing)' },
  { value: 'proposal_sent', label: 'Proposal Sent' },
  { value: 'ticket_opened', label: 'Support Ticket Opened' },
  { value: 'ticket_closed', label: 'Support Ticket Closed' },
  { value: 'lead_created', label: 'New Lead Created' },
  { value: 'contact_created', label: 'New Contact Created' },
  { value: 'deal_won', label: 'Deal Won' },
  { value: 'deal_lost', label: 'Deal Lost' },
] as const;

class AlertService {
  private static instance: AlertService;

  static getInstance(): AlertService {
    if (!this.instance) this.instance = new AlertService();
    return this.instance;
  }

  // ─── CRUD ────────────────────────────────────────────────────────────

  async getAlerts(userId: number) {
    return db.select().from(crmAlertsTable)
      .where(eq(crmAlertsTable.userId, userId))
      .orderBy(desc(crmAlertsTable.createdAt));
  }

  async getAlert(userId: number, alertId: number) {
    const [alert] = await db.select().from(crmAlertsTable)
      .where(and(eq(crmAlertsTable.id, alertId), eq(crmAlertsTable.userId, userId)))
      .limit(1);
    return alert || null;
  }

  async createAlert(userId: number, data: {
    name: string;
    description?: string;
    eventType: string;
    conditions?: Record<string, unknown>;
    notifyUser?: boolean;
    notifyContact?: boolean;
  }) {
    const [alert] = await db.insert(crmAlertsTable).values({
      userId,
      name: data.name,
      description: data.description || null,
      eventType: data.eventType,
      conditions: data.conditions || {},
      notifyUser: data.notifyUser !== false,
      notifyContact: data.notifyContact || false,
    }).returning();
    return alert;
  }

  async updateAlert(userId: number, alertId: number, data: Partial<{
    name: string;
    description: string;
    eventType: string;
    conditions: Record<string, unknown>;
    enabled: boolean;
    notifyUser: boolean;
    notifyContact: boolean;
  }>) {
    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateFields.name = data.name;
    if (data.description !== undefined) updateFields.description = data.description;
    if (data.eventType !== undefined) updateFields.eventType = data.eventType;
    if (data.conditions !== undefined) updateFields.conditions = data.conditions;
    if (data.enabled !== undefined) updateFields.enabled = data.enabled;
    if (data.notifyUser !== undefined) updateFields.notifyUser = data.notifyUser;
    if (data.notifyContact !== undefined) updateFields.notifyContact = data.notifyContact;

    const [updated] = await db.update(crmAlertsTable)
      .set(updateFields)
      .where(and(eq(crmAlertsTable.id, alertId), eq(crmAlertsTable.userId, userId)))
      .returning();
    return updated || null;
  }

  async deleteAlert(userId: number, alertId: number) {
    const deleted = await db.delete(crmAlertsTable)
      .where(and(eq(crmAlertsTable.id, alertId), eq(crmAlertsTable.userId, userId)))
      .returning({ id: crmAlertsTable.id });
    return deleted.length > 0;
  }

  // ─── Alert Logs ──────────────────────────────────────────────────────

  async getAlertLogs(userId: number, alertId?: number, limit = 50) {
    const result = await db.execute(sql`
      SELECT
        al.id,
        al.alert_id AS "alertId",
        a.name AS "alertName",
        al.contact_id AS "contactId",
        COALESCE(
          TRIM(CONCAT(COALESCE(c.first_name, l.first_name, l.name, ''), ' ', COALESCE(c.last_name, l.last_name, ''))),
          'Unknown'
        ) AS "contactName",
        al.event_type AS "eventType",
        al.event_data AS "eventData",
        al.notified_user AS "notifiedUser",
        al.notified_contact AS "notifiedContact",
        al.created_at AS "createdAt"
      FROM crm_alert_logs al
      JOIN crm_alerts a ON a.id = al.alert_id
      LEFT JOIN crm_contacts c ON c.id = al.contact_id AND c.deleted_at IS NULL
      LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
      WHERE al.user_id = ${userId}
      ${alertId ? sql`AND al.alert_id = ${alertId}` : sql``}
      ORDER BY al.created_at DESC
      LIMIT ${limit}
    `);
    return result.rows || [];
  }

  // ─── Event Trigger ───────────────────────────────────────────────────

  /**
   * Fire an event and check all matching user alerts.
   * Sends emails based on alert configuration and logs the trigger.
   */
  async fireEvent(userId: number, eventType: string, data: {
    contactId?: number;
    oldStatus?: string;
    newStatus?: string;
    metadata?: Record<string, unknown>;
  }) {
    try {
      // Find all enabled alerts for this user & event type
      const alerts = await db.select().from(crmAlertsTable)
        .where(and(
          eq(crmAlertsTable.userId, userId),
          eq(crmAlertsTable.enabled, true),
          eq(crmAlertsTable.eventType, eventType)
        ));

      if (alerts.length === 0) return;

      // Fetch contact and user info once
      let contactEmail: string | null = null;
      let contactName: string | null = null;
      let userName: string | null = null;
      let userEmail: string | null = null;

      if (data.contactId) {
        const contactResult = await db.execute(sql`
          SELECT
            COALESCE(c.email, l.email) AS email,
            TRIM(CONCAT(COALESCE(c.first_name, l.first_name, l.name, ''), ' ', COALESCE(c.last_name, l.last_name, ''))) AS name
          FROM crm_contacts c
          LEFT JOIN leads l ON l.id = c.lead_id
          WHERE c.id = ${data.contactId} AND c.user_id = ${userId}
          LIMIT 1
        `);
        const row = (contactResult.rows as Record<string, string>[])?.[0];
        if (row) {
          contactEmail = row.email;
          contactName = row.name?.trim() || null;
        }
      }

      const userResult = await db.execute(sql`
        SELECT email, COALESCE(NULLIF(name,''), 'User') AS name FROM users WHERE id = ${userId} LIMIT 1
      `);
      const user = (userResult.rows as Record<string, string>[])?.[0];
      userEmail = user?.email;
      userName = user?.name;

      for (const alert of alerts) {
        // Check conditions (e.g. specific stage match)
        if (!this.matchesConditions(alert, data)) continue;

        let notifiedUser = false;
        let notifiedContact = false;
        let emailError: string | null = null;
        let notifiedSlack = false;
        let slackError: string | null = null;

        const eventDescription = this.buildEventDescription(eventType, data, contactName);

        // Notify user
        if (alert.notifyUser && userEmail) {
          try {
            const delivery = await sendAdminEmail({
              to: userEmail,
              subject: `Alert: ${alert.name}`,
              html: buildAlertEmailHtml({
                alertName: alert.name,
                eventDescription,
                contactName,
                contactEmail,
                eventType,
                timestamp: new Date(),
              }),
            });
            if (!delivery.success) throw new Error(delivery.error || 'Alert email was not accepted');
            notifiedUser = true;
          } catch (err) {
            logger.error({ err, alertId: alert.id }, '[AlertService] Failed to email user');
            emailError = err instanceof Error ? err.message : String(err);
          }
        }

        // Notify contact
        if (alert.notifyContact && contactEmail) {
          try {
            const delivery = await sendAdminEmail({
              to: contactEmail,
              subject: this.getContactAlertSubject(eventType, alert.name),
              html: buildContactAlertHtml({
                eventType,
                contactName,
                senderName: userName || 'Our Team',
                description: alert.description || eventDescription,
              }),
            });
            if (!delivery.success) throw new Error(delivery.error || 'Contact alert email was not accepted');
            notifiedContact = true;
          } catch (err) {
            logger.error({ err, alertId: alert.id }, '[AlertService] Failed to email contact');
            emailError = [emailError, err instanceof Error ? err.message : String(err)].filter(Boolean).join('; ');
          }
        }

        // Notify Slack if webhook is configured
        try {
          const settingsResult = await db.execute(sql`
            SELECT slack_webhook_url FROM outreach_settings WHERE user_id = ${userId} LIMIT 1
          `);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slackWebhookUrl = (settingsResult.rows as any)?.[0]?.slack_webhook_url;
          
          if (slackWebhookUrl) {
            const emoji = getEventEmoji(eventType);
            const payload = {
              text: `${emoji} *CRM Alert:* ${alert.name}\n${eventDescription}`,
              blocks: [
                {
                  type: 'header',
                  text: {
                    type: 'plain_text',
                    text: `${emoji} CRM Alert: ${alert.name}`,
                  },
                },
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `*Event:* ${eventDescription}\n*Time:* ${new Date().toLocaleString()}`,
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
              throw new Error(`Slack returned status ${response.status}: ${await response.text()}`);
            }
            notifiedSlack = true;
          }
        } catch (err) {
          logger.warn({ err, alertId: alert.id }, '[AlertService] Failed to dispatch Slack webhook');
          slackError = err instanceof Error ? err.message : String(err);
        }

        // Log the alert trigger
        await db.insert(crmAlertLogsTable).values({
          alertId: alert.id,
          userId,
          contactId: data.contactId || null,
          eventType,
          eventData: {
            ...data.metadata,
            oldStatus: data.oldStatus,
            newStatus: data.newStatus,
            notifiedSlack,
            slackError,
            emailError,
          },
          notifiedUser,
          notifiedContact,
        });
      }
    } catch (err) {
      logger.error({ err, userId, eventType }, '[AlertService] Failed to fire event');
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private matchesConditions(alert: typeof crmAlertsTable.$inferSelect, data: {
    oldStatus?: string;
    newStatus?: string;
  }): boolean {
    const conditions = (alert.conditions || {}) as Record<string, unknown>;

    // For status_changed_to alerts: check if newStatus matches the configured stage
    if (alert.eventType === 'status_changed_to' && conditions.stage && conditions.stage !== 'any') {
      return data.newStatus === conditions.stage;
    }

    // For status_changed_from alerts: check if oldStatus matches the configured stage
    if (alert.eventType === 'status_changed_from' && conditions.stage && conditions.stage !== 'any') {
      return data.oldStatus === conditions.stage;
    }

    // No conditions or non-status events = always match
    return true;
  }

  private buildEventDescription(eventType: string, data: {
    oldStatus?: string;
    newStatus?: string;
  }, contactName: string | null): string {
    const contact = contactName || 'A contact';
    switch (eventType) {
      case 'status_changed_to':
      case 'status_changed_from':
        return `${contact} status changed from "${data.oldStatus || 'unknown'}" to "${data.newStatus || 'unknown'}"`;
      case 'proposal_sent':
        return `A proposal was sent to ${contact}`;
      case 'ticket_opened':
        return `A support ticket was opened for ${contact}`;
      case 'ticket_closed':
        return `A support ticket was closed for ${contact}`;
      case 'lead_created':
        return `New lead created: ${contact}`;
      case 'contact_created':
        return `New contact created: ${contact}`;
      case 'deal_won':
        return `Deal won with ${contact}`;
      case 'deal_lost':
        return `Deal lost with ${contact}`;
      default:
        return `Event "${eventType}" triggered for ${contact}`;
    }
  }

  private getContactAlertSubject(eventType: string, alertName: string): string {
    const subjects: Record<string, string> = {
      proposal_sent: 'You have a new proposal to review',
      ticket_opened: 'Your support ticket has been opened',
      ticket_closed: 'Your support ticket has been resolved',
    };
    return subjects[eventType] || alertName;
  }
}

export const alertService = AlertService.getInstance();

// ─── Email Template Helpers ───────────────────────────────────────────────────

function buildAlertEmailHtml(data: {
  alertName: string;
  eventDescription: string;
  contactName: string | null;
  contactEmail: string | null;
  eventType: string;
  timestamp: Date;
}): string {
  const alertName = escapeHtml(data.alertName);
  const eventDescription = escapeHtml(data.eventDescription);
  const contactName = escapeHtml(data.contactName || '');
  const contactEmail = escapeHtml(data.contactEmail || '');
  return renderAdminEmail({
    title: `CRM alert: ${alertName}`,
    preheader: eventDescription,
    content: `
      <div style="background: #f8fafc; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0; margin-bottom: 20px;">
        <p style="margin: 0 0 16px; color: #334155; font-size: 14px; line-height: 1.6;">${eventDescription}</p>
        ${contactName ? `<p style="margin: 0 0 4px; color: #475569; font-size: 13px;">Contact: <strong>${contactName}</strong>${contactEmail ? ` (${contactEmail})` : ''}</p>` : ''}
        <p style="margin: 16px 0 0; color: #64748b; font-size: 12px;">Triggered at: ${data.timestamp.toLocaleString()}</p>
      </div>
    `,
    footer: 'Sent by AskSales.ai Platform'
  });
}

function buildContactAlertHtml(data: {
  eventType: string;
  contactName: string | null;
  senderName: string;
  description: string;
}): string {
  const description = escapeHtml(data.description);
  const senderName = escapeHtml(data.senderName);
  return renderAdminEmail({
    title: 'Update Regarding Your Request',
    preheader: description,
    name: data.contactName ? escapeHtml(data.contactName) : undefined,
    content: description,
    footer: `Best regards,<br/>${senderName}`
  });
}

function getEventEmoji(eventType: string): string {
  switch (eventType) {
    case 'deal_won':
      return '🎉';
    case 'deal_lost':
      return '😢';
    case 'ticket_opened':
      return '🎫';
    case 'ticket_closed':
      return '✅';
    case 'proposal_sent':
      return '📄';
    case 'lead_created':
    case 'contact_created':
      return '👤';
    default:
      return '🔔';
  }
}
