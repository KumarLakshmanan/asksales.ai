import crypto from 'crypto';
import mustache from 'mustache';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { QUEUE_NAMES, queueRegistry } from '../queues/index.js';
import { decryptValue } from './SecretsManager.js';
import { logger } from '../utils/logger.js';
import { fetchPublicHttpUrl } from '../utils/safeRemoteFetch.js';
import { eventBus } from '../events/EventBus.js';
import { getSupportNotificationEmailSender } from './SupportNotificationEmailConfiguration.js';
import { serializeSupportTimestamp } from '../utils/supportTimestamp.js';
import { resolveSupportNotificationSource } from './SupportNotificationSource.js';
import { supportNotificationDeliveryClaim } from './SupportNotificationDeliveryClaim.js';

export type SupportNotificationChannel =
  | 'email'
  | 'whatsapp'
  | 'slack'
  | 'teams'
  | 'browser_push'
  | 'instagram'
  | 'facebook';

export type SupportNotificationEvent =
  | 'ticket_created_unassigned'
  | 'ticket_assigned'
  | 'ticket_reassigned'
  | 'human_handoff'
  | 'customer_replied'
  | 'ticket_reopened'
  | 'sla_at_risk'
  | 'sla_breached'
  | 'approval_required'
  | 'delivery_failed'
  | 'ticket_resolved';

export type SupportDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'retry'
  | 'accepted'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'uncertain'
  | 'cancelled'
  | 'suppressed'
  | 'dead_letter';

export type SupportPlatformAvailability =
  | 'available'
  | 'configuration_required'
  | 'verification_required'
  | 'policy_blocked'
  | 'provider_unavailable';

export interface EventPayload {
  ticketId: number;
  ticketNumber: string;
  subject?: string;
  priority: string;
  sourceChannel?: string;
  ticketPath: string;
  safeSummary?: string;
  requiredAction?: string;
  category?: string;
  slaDeadline?: string | null;
  previousAssignedMemberId?: number | null;
}

interface EventRow {
  id: number;
  user_id: number;
  ticket_id: number;
  handoff_id: number | null;
  event_type: SupportNotificationEvent;
  event_key: string;
  assigned_member_id: number | null;
  team_id: number | null;
  payload: EventPayload;
  severity: 'info' | 'normal' | 'high' | 'urgent';
  source_channel: string | null;
  category: string | null;
  safe_summary: string;
  required_action: string;
  sla_deadline: string | Date | null;
  processing_attempts: number;
}

interface DeliveryRow {
  id: number;
  user_id: number;
  member_id: number;
  event_id: number | null;
  event_type: SupportNotificationEvent;
  event_key: string;
  channel: SupportNotificationChannel;
  destination_id: number | null;
  recipient_ciphertext: string | null;
  recipient: string | null;
  destination_hint: string | null;
  status: SupportDeliveryStatus;
  payload: EventPayload;
  attempt_count: number;
  max_attempts: number;
}

interface AdapterResult {
  outcome: 'accepted' | 'delivered' | 'permanent_failure' | 'suppressed' | 'uncertain';
  providerMessageId?: string | null;
  providerStatus: string;
  errorCode?: string;
  error?: string;
}

export function supportNotificationProviderAcknowledgement(providerMessageId: unknown): AdapterResult {
  return typeof providerMessageId === 'string' && providerMessageId.trim().length > 0
    ? { outcome: 'accepted', providerMessageId, providerStatus: 'accepted' }
    : { outcome: 'uncertain', providerStatus: 'missing_acknowledgement', errorCode: 'PROVIDER_ACK_MISSING' };
}

export function supportNotificationDeliveryJob(
  deliveryId: number, userId: number, attemptCount: number, nextAttemptAt: unknown, now = Date.now(),
) {
  const dueAt = new Date(serializeSupportTimestamp(nextAttemptAt) || new Date(now).toISOString()).getTime();
  return {
    // A retained failed BullMQ job must not swallow the next ledger retry.
    // Concurrent recovery passes for the same attempt still use the same ID.
    jobId: `support-member-notification-${userId}-${deliveryId}-${attemptCount}-${dueAt}`,
    delay: Math.max(0, dueAt - now),
    attempts: 1, // The durable ledger owns backoff and retry limits.
  };
}

export function supportNotificationSubmissionIsUncertain(channel: SupportNotificationChannel, error: unknown): boolean {
  // Resend retries use its provider idempotency key. Meta/webhook submissions do not.
  if (channel === 'email') return false;
  const value = error as { name?: string; code?: string; message?: string } | null;
  return ['AbortError', 'TimeoutError'].includes(value?.name || '')
    || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(value?.code || '')
    || /timed? ?out|timeout|fetch failed|socket hang up|connection reset/i.test(value?.message || '');
}

export interface SupportTicketAlertRenderModel {
  ticket_number: string;
  priority: string;
  source_channel: string;
  safe_summary: string;
  required_action: string;
  response_target: string;
  ticket_url: string;
}

const DEFAULT_WHATSAPP_VARIABLE_MAPPING: Record<string, keyof SupportTicketAlertRenderModel> = {
  '1': 'ticket_number',
  '2': 'priority',
  '3': 'source_channel',
  '4': 'safe_summary',
  '5': 'required_action',
  '6': 'response_target',
  '7': 'ticket_url',
};

interface TicketNotificationInput {
  id: number;
  userId: number;
  ticketNumber: string;
  subject: string;
  priority: string;
  teamId?: number | null;
  assignedMemberId?: number | null;
  eventKey?: string;
}

interface HandoffNotificationInput {
  id: number;
  userId: number;
  supportTicketId: number;
  teamId?: number | null;
  assignedMemberId?: number | null;
  channel: string;
  priority: string;
}

const TEMPLATE_VARIABLES = new Set([
  'event_title',
  'ticket_number',
  'priority',
  'source_channel',
  'safe_summary',
  'required_action',
  'response_target',
  'ticket_url',
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderSupportNotificationTemplate(
  subjectTemplate: string,
  textTemplate: string,
  values: object,
): { subject: string; text: string; html: string } {
  const subject = safeText(mustache.render(subjectTemplate, values), 500);
  const text = safeMultilineText(mustache.render(textTemplate, values), 5000);
  return {
    subject,
    text,
    html: `<div style="font-family:system-ui,sans-serif;white-space:pre-line">${escapeHtml(text)}</div>`,
  };
}

function safeText(value: unknown, maxLength = 1000): string {
  return String(value || '')
    .replace(/\+?\d(?:[\s().-]*\d){7,14}/g, '[PHONE]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[PAYMENT DATA]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeMultilineText(value: unknown, maxLength = 5000): string {
  return String(value || '')
    .replace(/\+?\d(?:[\s().-]*\d){7,14}/g, '[PHONE]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[PAYMENT DATA]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function eventTitle(eventType: SupportNotificationEvent, severity: string): string {
  const prefix = severity === 'urgent' ? 'Urgent ' : '';
  const labels: Record<SupportNotificationEvent, string> = {
    ticket_created_unassigned: 'unassigned support ticket',
    ticket_assigned: 'ticket assignment',
    ticket_reassigned: 'ticket reassignment',
    human_handoff: 'human handoff',
    customer_replied: 'customer reply',
    ticket_reopened: 'reopened support ticket',
    sla_at_risk: 'SLA at risk',
    sla_breached: 'SLA breached',
    approval_required: 'support approval required',
    delivery_failed: 'support delivery failed',
    ticket_resolved: 'support ticket resolved',
  };
  return `${prefix}${labels[eventType]}`;
}

function responseTarget(deadline: string | Date | null | undefined): string {
  if (!deadline) return 'Not configured';
  const parsed = new Date(deadline);
  if (!Number.isFinite(parsed.getTime())) return 'Not configured';
  const minutes = Math.ceil((parsed.getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return `${Math.abs(minutes)} minutes overdue`;
  if (minutes >= 60) return `${Math.ceil(minutes / 60)} hours remaining`;
  return `${minutes} minutes remaining`;
}

export function supportNotificationDestinationHint(channel: SupportNotificationChannel, destination: string): string {
  if (channel === 'email') {
    const [local, domain] = destination.split('@');
    if (!local || !domain) return 'configured email';
    return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(8, local.length - 2)))}@${domain}`;
  }
  if (channel === 'whatsapp') {
    const normalized = destination.replace(/\D/g, '');
    return normalized.length > 4 ? `••••${normalized.slice(-4)}` : 'configured number';
  }
  if (channel === 'slack') return 'configured Slack webhook';
  if (channel === 'teams') return 'configured Teams webhook';
  if (channel === 'browser_push') return 'this browser';
  return destination.length > 4 ? `${destination.slice(0, 2)}••${destination.slice(-2)}` : 'configured account';
}

export function supportNotificationBackoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 3_000 * 2 ** Math.max(0, attempt - 1));
}

export function supportNotificationQuietHoursDelayMs(
  quietHours: unknown,
  timezone: string,
  now = new Date(),
): number {
  const value = quietHours as { enabled?: boolean; start?: string; end?: string } | null;
  if (!value?.enabled || !/^\d{2}:\d{2}$/.test(value.start || '') || !/^\d{2}:\d{2}$/.test(value.end || '')) return 0;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const current = Number(parts.hour) * 60 + Number(parts.minute);
    const [startHour, startMinute] = value.start!.split(':').map(Number);
    const [endHour, endMinute] = value.end!.split(':').map(Number);
    const start = startHour * 60 + startMinute; const end = endHour * 60 + endMinute;
    const inQuiet = start < end ? current >= start && current < end : current >= start || current < end;
    if (!inQuiet) return 0;
    const minutes = end > current ? end - current : 24 * 60 - current + end;
    return Math.max(60_000, minutes * 60_000);
  } catch { return 0; }
}

export function shouldCreateSupportNotificationEmailFallback(
  _channel: SupportNotificationChannel,
  _outcome: AdapterResult['outcome'],
): boolean {
  return false;
}

export function isSupportNotificationDeliveryRetryable(status: string): boolean {
  return status === 'failed' || status === 'dead_letter';
}

export function buildSupportMemberNotificationMessage(
  eventType: SupportNotificationEvent | 'new_ticket_assignment',
  payload: EventPayload,
  secureTicketUrl?: string,
): string {
  const normalizedEvent = eventType === 'new_ticket_assignment' ? 'ticket_assigned' : eventType;
  const priority = String(payload.priority || 'medium').toUpperCase();
  const link = secureTicketUrl || payload.ticketPath;
  const lines = [
    eventTitle(normalizedEvent, ['URGENT', 'CRITICAL'].includes(priority) ? 'urgent' : 'normal'),
    '',
    `Ticket: ${payload.ticketNumber}`,
    `Priority: ${priority}`,
    payload.sourceChannel ? `Source: ${safeText(payload.sourceChannel, 40)}` : null,
    `Issue: ${payload.safeSummary ? safeText(payload.safeSummary, 500) : 'A support request needs attention.'}`,
    payload.requiredAction ? `Required action: ${safeText(payload.requiredAction, 300)}` : null,
    payload.slaDeadline ? `Response target: ${responseTarget(payload.slaDeadline)}` : null,
    '',
    `Open ticket: ${link}`,
  ];
  return lines.filter((line) => line !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

function secureTicketUrl(ticketId: number): string {
  const path = `/support/tickets/${ticketId}`;
  const configured = process.env.CLIENT_URL || process.env.APP_URL || 'https://asksales.ai';
  try {
    const url = new URL(path, configured);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') return `https://asksales.ai${path}`;
    return url.toString();
  } catch {
    return `https://asksales.ai${path}`;
  }
}

function secureSupportPathUrl(path: string): string {
  const configured = process.env.CLIENT_URL || process.env.APP_URL || 'https://asksales.ai';
  try {
    const url = new URL(path.startsWith('/') ? path : '/', configured);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') return `https://asksales.ai${path.startsWith('/') ? path : '/'}`;
    return url.toString();
  } catch { return 'https://asksales.ai/dashboard/support/notifications'; }
}

function deliveryMode(): 'simulate' | 'disabled' | 'live' {
  const configured = process.env.SUPPORT_NOTIFICATION_DELIVERY_MODE;
  if (configured === 'live' || configured === 'disabled' || configured === 'simulate') return configured;
  return process.env.NODE_ENV === 'production' ? 'live' : 'simulate';
}
function adapterEnabled(channel: SupportNotificationChannel): boolean {
  return process.env[`SUPPORT_NOTIFICATION_${channel.toUpperCase()}_ENABLED`] !== 'false';
}

export async function withSupportNotificationTenant<T>(
  userId: number,
  operation: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${String(userId)}, true)`);
    return operation(tx);
  });
}

function hmacKey(): string {
  const key = process.env.SUPPORT_NOTIFICATION_HMAC_KEY
    || process.env.PRIVACY_VAULT_ENCRYPTION_KEY
    || process.env.ENCRYPTION_KEY;
  if (!key && process.env.NODE_ENV === 'production') throw new Error('SUPPORT_NOTIFICATION_HMAC_KEY is required in production.');
  return key || 'development-support-notification-key';
}

function titleForOwner(event: EventRow): string {
  return eventTitle(event.event_type, event.severity).replace(/^./, (character) => character.toUpperCase());
}

export class SupportMemberNotificationService {
  static destinationDigest(channel: SupportNotificationChannel, destination: string, userId = 0): string {
    return crypto.createHmac('sha256', hmacKey())
      .update(`${userId}:${channel}:${destination.trim().toLowerCase()}`).digest('hex');
  }

  platformAvailability(): Record<SupportNotificationChannel, SupportPlatformAvailability> {
    const mode = deliveryMode();
    return {
      email: mode === 'disabled' || !adapterEnabled('email') ? 'provider_unavailable' : 'available',
      whatsapp: mode === 'disabled' ? 'provider_unavailable'
        : !adapterEnabled('whatsapp') ? 'provider_unavailable'
          : 'available',
      slack: mode === 'disabled' || !adapterEnabled('slack') ? 'provider_unavailable' : 'available',
      teams: mode === 'disabled' || !adapterEnabled('teams') ? 'provider_unavailable' : 'available',
      browser_push: 'available',
      instagram: 'policy_blocked',
      facebook: 'policy_blocked',
    };
  }

  private async queueEvent(eventId: number, userId: number, severity: string): Promise<void> {
    try {
      await queueRegistry.addJob(QUEUE_NAMES.GENERAL, 'support-notification-event', {
        type: 'support-notification-event', userId, eventId, createdAt: new Date().toISOString(),
      }, { jobId: `support-notification-event-${eventId}`, priority: severity === 'urgent' ? 1 : 2 });
    } catch (error) {
      logger.error({ err: error, userId, eventId }, '[SupportNotifications] Event queue unavailable; recovery will retry');
    }
  }

  private async queueDelivery(deliveryId: number, userId: number, eventType: SupportNotificationEvent): Promise<void> {
    try {
      const pending = await withSupportNotificationTenant(userId, async (tx) => {
        // A worker crash after submission has an unknown provider outcome.
        // Do not resend a possibly accepted notification automatically.
        await tx.execute(sql`UPDATE support_member_notification_deliveries
          SET status='uncertain', error_code='WORKER_OUTCOME_UNKNOWN', updated_at=NOW()
          WHERE id=${deliveryId} AND user_id=${userId} AND status='sending'
            AND updated_at < NOW() - INTERVAL '5 minutes'`);
        const result = await tx.execute(sql`SELECT attempt_count,next_attempt_at
          FROM support_member_notification_deliveries WHERE id=${deliveryId} AND user_id=${userId}
            AND status IN ('pending','retry') AND attempt_count < max_attempts`);
        return result.rows[0] as { attempt_count: number; next_attempt_at: unknown } | undefined;
      });
      if (!pending) return;
      await queueRegistry.addJob(QUEUE_NAMES.GENERAL, 'support-member-notification', {
        type: 'support-member-notification', userId, deliveryId, createdAt: new Date().toISOString(),
      }, { ...supportNotificationDeliveryJob(deliveryId, userId, pending.attempt_count, pending.next_attempt_at),
        priority: ['human_handoff', 'sla_breached'].includes(eventType) ? 1 : 2 });
    } catch (error) {
      logger.error({ err: error, userId, deliveryId }, '[SupportNotifications] Delivery queue unavailable; recovery will retry');
    }
  }

  async processPendingEvents(limit = 100): Promise<number> {
    const claimed = await db.execute(sql`SELECT * FROM claim_pending_support_notification_events(${limit})`);
    for (const row of claimed.rows as Array<{ id: number; user_id: number }>) {
      await this.queueEvent(Number(row.id), Number(row.user_id), 'normal');
    }
    return claimed.rows.length;
  }

  async processDueDeliveries(limit = 100): Promise<number> {
    const due = await db.execute(sql`SELECT * FROM claim_due_support_notification_deliveries(${limit})`);
    for (const row of due.rows as Array<{ id: number; user_id: number }>) {
      await this.queueDelivery(Number(row.id), Number(row.user_id), 'ticket_assigned');
    }
    return due.rows.length;
  }

  private async resolveRecipients(tx: typeof db, event: EventRow): Promise<number[]> {
    if (!event.assigned_member_id) return [];
    const assigned = await tx.execute(sql`
      SELECT id FROM team_members
      WHERE id=${event.assigned_member_id} AND user_id=${event.user_id}
        AND is_active IS TRUE
        AND (${event.team_id || null}::INTEGER IS NULL OR team_id=${event.team_id || null})
      LIMIT 1
    `);
    return assigned.rows[0] ? [Number((assigned.rows[0] as { id: number }).id)] : [];
  }

  private async resolveTemplate(tx: typeof db, event: EventRow, channel: SupportNotificationChannel, memberId: number) {
    const templateEvent: SupportNotificationEvent = event.event_type === 'ticket_reassigned' ? 'ticket_assigned' : event.event_type;
    const payload: EventPayload = {
      ...event.payload,
      safeSummary: event.safe_summary,
      requiredAction: event.required_action,
      sourceChannel: event.source_channel || event.payload.sourceChannel,
      category: event.category || undefined,
      slaDeadline: event.sla_deadline ? new Date(event.sla_deadline).toISOString() : null,
    };
    const ticketUrl = secureTicketUrl(event.ticket_id);
    const values: SupportTicketAlertRenderModel & { event_title: string } = {
      event_title: eventTitle(event.event_type, event.severity),
      ticket_number: payload.ticketNumber,
      priority: String(payload.priority || event.severity).toUpperCase(),
      source_channel: payload.sourceChannel || 'customer conversation',
      safe_summary: safeText(event.safe_summary, 1000),
      required_action: safeText(event.required_action, 500),
      response_target: responseTarget(event.sla_deadline),
      ticket_url: ticketUrl,
    };
    const result = await tx.execute(sql`
      SELECT v.subject_template, v.text_template
      FROM support_notification_templates t
      JOIN support_notification_template_versions v ON v.template_id = t.id AND v.version = t.active_version
      JOIN team_members tm ON tm.id = ${memberId} AND tm.user_id = t.user_id
      WHERE t.user_id = ${event.user_id}
        AND t.team_id IS NULL
        AND t.event_type = ${templateEvent} AND t.channel = ${channel}
        AND t.locale IN (tm.locale, 'en-IN') AND t.status = 'published'
      ORDER BY (t.locale = tm.locale) DESC, t.updated_at DESC LIMIT 1
    `);
    const template = result.rows[0] as { subject_template?: string; text_template?: string } | undefined;
    const fallback = buildSupportMemberNotificationMessage(event.event_type, payload, ticketUrl);
    return {
      ...renderSupportNotificationTemplate(
        template?.subject_template || `${values.event_title} · ${values.ticket_number}`,
        template?.text_template || fallback,
        values,
      ),
      model: values,
    };
  }

  private async createDelivery(tx: typeof db, input: {
    event: EventRow; memberId: number; channel: SupportNotificationChannel; destinationId: number | null;
    recipientCiphertext: string; destinationHint: string; payload: EventPayload;
  }): Promise<number | null> {
    const inserted = await tx.execute(sql`
      INSERT INTO support_member_notification_deliveries (
        user_id, member_id, event_id, event_type, event_key, channel, destination_id,
        recipient_ciphertext, destination_hint, payload, max_attempts, expires_at
      ) VALUES (
        ${input.event.user_id}, ${input.memberId}, ${input.event.id}, ${input.event.event_type},
        ${input.event.event_key}, ${input.channel}, ${input.destinationId}, ${input.recipientCiphertext},
        ${input.destinationHint}, ${JSON.stringify(input.payload)}::jsonb, 5, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (event_key, member_id, channel) DO NOTHING RETURNING id
    `);
    return Number((inserted.rows[0] as { id?: number } | undefined)?.id || 0) || null;
  }

  async processEvent(eventId: number, userId: number): Promise<void> {
    const deliveryJobs: Array<{ id: number; eventType: SupportNotificationEvent }> = [];
    let realtimePayload: Record<string, unknown> | null = null;
    try {
      await withSupportNotificationTenant(userId, async (tx) => {
        const eventResult = await tx.execute(sql`
          SELECT * FROM support_notification_events
          WHERE id = ${eventId} AND user_id = ${userId} AND processing_status = 'processing' LIMIT 1
        `);
        const event = eventResult.rows[0] as unknown as EventRow | undefined;
        if (!event) return;
        if (!event.source_channel && !event.payload.sourceChannel) {
          const source = await resolveSupportNotificationSource(tx, userId, event.ticket_id);
          if (source) {
            event.source_channel = source;
            event.payload = { ...event.payload, sourceChannel: source };
            await tx.execute(sql`
              UPDATE support_notification_events
              SET source_channel = ${source},
                  payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{sourceChannel}', to_jsonb(${source}::text))
              WHERE id = ${eventId} AND user_id = ${userId} AND processing_status = 'processing'
            `);
          }
        }
        const recipients = await this.resolveRecipients(tx, event);
        const payload: EventPayload = {
          ...event.payload,
          safeSummary: safeText(event.safe_summary, 1000), requiredAction: safeText(event.required_action, 500),
          sourceChannel: event.source_channel || event.payload.sourceChannel, category: event.category || undefined,
          slaDeadline: event.sla_deadline ? new Date(event.sla_deadline).toISOString() : null,
        };
        if (event.event_type === 'ticket_reassigned' && Number(payload.previousAssignedMemberId) > 0) {
          const previousMemberId = Number(payload.previousAssignedMemberId);
          await tx.execute(sql`
            UPDATE support_notification_receipts r SET cancelled_at=COALESCE(cancelled_at,NOW()),acknowledged_at=COALESCE(acknowledged_at,NOW())
            FROM support_notification_events previous_event
            WHERE r.event_id=previous_event.id AND r.user_id=${userId} AND r.member_id=${previousMemberId}
              AND previous_event.ticket_id=${event.ticket_id} AND previous_event.id<>${event.id}
          `);
          await tx.execute(sql`
            UPDATE support_member_notification_deliveries SET status='cancelled',updated_at=NOW()
            WHERE user_id=${userId} AND member_id=${previousMemberId} AND event_id IN(
              SELECT id FROM support_notification_events WHERE user_id=${userId} AND ticket_id=${event.ticket_id} AND id<>${event.id}
            ) AND status IN('pending','retry')
          `);
        }
        const ownerNotification = await tx.execute(sql`
          INSERT INTO notifications (user_id, title, message, type, action_url, event_key)
          VALUES (${userId}, ${titleForOwner(event)},
            ${`${payload.ticketNumber} · ${payload.safeSummary} ${payload.requiredAction}`.slice(0, 1500)},
            ${event.severity === 'urgent' ? 'error' : event.severity === 'high' ? 'warning' : 'info'},
            ${`/dashboard/support/${event.ticket_id}`}, ${event.event_key})
          ON CONFLICT (business_profile_id, user_id, event_key) WHERE event_key IS NOT NULL DO NOTHING RETURNING id
        `);
        realtimePayload = { eventId: event.id, eventType: event.event_type, ticketId: event.ticket_id, memberIds: recipients,
          notificationId: Number((ownerNotification.rows[0] as { id?: number } | undefined)?.id || 0) || undefined };

        const usedDestinations = new Set<string>();
        for (const memberId of recipients) {
          await tx.execute(sql`
            INSERT INTO support_notification_receipts (user_id, event_id, member_id)
            VALUES (${userId}, ${event.id}, ${memberId}) ON CONFLICT (event_id, member_id) DO NOTHING
          `);
          const preferences = ['ticket_assigned', 'ticket_reassigned'].includes(event.event_type)
            ? await tx.execute(sql`
            SELECT s.channel, s.enabled, d.id destination_id,
              d.destination_ciphertext, d.destination_hint, d.destination_hash, d.verification_status,
              tm.timezone, tm.quiet_hours
            FROM support_notification_channel_settings s
            JOIN team_members tm ON tm.id=${memberId} AND tm.user_id=s.user_id
            LEFT JOIN support_notification_destinations d ON d.user_id=s.user_id
              AND d.member_id=tm.id AND d.channel=s.channel
            WHERE s.user_id=${userId} AND s.enabled IS TRUE AND s.channel IN ('email','whatsapp')
            ORDER BY s.channel
          `) : { rows: [] };
          for (const row of preferences.rows as Array<{
            channel: SupportNotificationChannel; enabled: boolean; destination_id: number | null;
            destination_ciphertext: string | null; destination_hint: string | null;
            destination_hash: string | null; verification_status: string | null;
            timezone: string; quiet_hours: unknown;
          }>) {
            if (!row.enabled || !row.destination_ciphertext || !['verified', 'owner_verified'].includes(row.verification_status || '')) {
              await tx.execute(sql`
                INSERT INTO support_notification_audit_logs
                  (user_id,member_id,actor_type,action,entity_type,entity_id,metadata,expires_at)
                VALUES (${userId},${memberId},'system','delivery.destination_missing',
                  'support_notification_event',${event.id},
                  ${JSON.stringify({ channel: row.channel, eventType: event.event_type })}::jsonb,
                  NOW()+INTERVAL '365 days')
              `);
              continue;
            }
            if (['instagram', 'facebook', 'browser_push'].includes(row.channel)) continue;
            const dedupe = `${row.channel}:${row.destination_hash || row.destination_id}`;
            if (usedDestinations.has(dedupe)) continue;
            usedDestinations.add(dedupe);
            const deliveryId = await this.createDelivery(tx, {
              event, memberId, channel: row.channel, destinationId: row.destination_id,
              recipientCiphertext: row.destination_ciphertext, destinationHint: row.destination_hint || 'verified destination', payload,
            });
            const delayMs=event.severity==='urgent'?0:supportNotificationQuietHoursDelayMs(row.quiet_hours,row.timezone||'Asia/Kolkata');
            if(deliveryId&&delayMs>0)await tx.execute(sql`UPDATE support_member_notification_deliveries SET next_attempt_at=NOW()+(${delayMs}||' milliseconds')::interval,provider_status='quiet_hours_deferred' WHERE id=${deliveryId}`);
            if (deliveryId) deliveryJobs.push({ id: deliveryId, eventType: event.event_type });
          }
        }
        await tx.execute(sql`
          UPDATE support_notification_events SET processing_status = 'expanded', expanded_at = NOW(), processing_error = NULL
          WHERE id = ${event.id} AND user_id = ${userId}
        `);
        await tx.execute(sql`
          INSERT INTO support_notification_audit_logs (user_id, member_id, actor_type, action, entity_type, entity_id, metadata)
          VALUES (${userId}, NULL, 'system', 'event.expanded', 'support_notification_event', ${event.id},
            ${JSON.stringify({ recipients: recipients.length, deliveries: deliveryJobs.length, eventType: event.event_type })}::jsonb)
        `);
      });
    } catch (error) {
      await withSupportNotificationTenant(userId, async (tx) => {
        const message = error instanceof Error ? safeText(error.message, 2000) : 'Notification expansion failed.';
        await tx.execute(sql`
          UPDATE support_notification_events
          SET processing_status = CASE WHEN processing_attempts >= 5 THEN 'failed' ELSE 'retry' END,
              processing_error = ${message}, next_attempt_at = NOW() + INTERVAL '1 minute'
          WHERE id = ${eventId} AND user_id = ${userId}
        `);
      }).catch(() => undefined);
      throw error;
    }
    for (const delivery of deliveryJobs) await this.queueDelivery(delivery.id, userId, delivery.eventType);
    if (realtimePayload) {
      await eventBus.publish({ channel: 'events:notification', userId, timestamp: new Date().toISOString(),
        data: { supportNotification: realtimePayload } })
        .catch((error) => logger.warn({ err: error, userId, eventId }, '[SupportNotifications] Realtime publish failed'));
    }
  }

  async queueTicketCreated(_ticket: TicketNotificationInput): Promise<number | null> {
    await this.processPendingEvents(25);
    return null;
  }

  async queueHumanHandoff(_handoff: HandoffNotificationInput): Promise<number | null> {
    await this.processPendingEvents(25);
    return null;
  }

  private async renderDelivery(delivery: DeliveryRow) {
    return withSupportNotificationTenant(delivery.user_id, async (tx) => {
      if (!delivery.event_id) {
        const ticketUrl = delivery.payload.ticketId > 0 ? secureTicketUrl(delivery.payload.ticketId) : secureSupportPathUrl(delivery.payload.ticketPath);
        const text = buildSupportMemberNotificationMessage(delivery.event_type, delivery.payload, ticketUrl);
        const model: SupportTicketAlertRenderModel = {
          ticket_number: safeText(delivery.payload.ticketNumber, 100),
          priority: safeText(delivery.payload.priority, 40).toUpperCase(),
          source_channel: safeText(delivery.payload.sourceChannel || 'customer conversation', 40),
          safe_summary: safeText(delivery.payload.safeSummary || 'A support request needs attention.', 1000),
          required_action: safeText(delivery.payload.requiredAction || 'Review and reply in the support portal.', 500),
          response_target: responseTarget(delivery.payload.slaDeadline),
          ticket_url: ticketUrl,
        };
        return { subject: `${eventTitle(delivery.event_type, 'normal')} · ${delivery.payload.ticketNumber}`, text,
          html: `<div style="white-space:pre-line">${escapeHtml(text)}</div>`, model };
      }
      const result = await tx.execute(sql`SELECT * FROM support_notification_events WHERE id = ${delivery.event_id} AND user_id = ${delivery.user_id}`);
      const event = result.rows[0] as unknown as EventRow | undefined;
      if (!event) throw new Error('Notification event is unavailable.');
      return this.resolveTemplate(tx, event, delivery.channel, delivery.member_id);
    });
  }

  private async sendAdapter(delivery: DeliveryRow, recipient: string): Promise<AdapterResult> {
    const mode = deliveryMode();
    if (mode === 'disabled') return { outcome: 'suppressed', providerStatus: 'delivery_disabled', errorCode: 'DELIVERY_DISABLED', error: 'Support notification delivery is disabled.' };
    if (!adapterEnabled(delivery.channel)) return { outcome: 'suppressed', providerStatus: 'adapter_disabled', errorCode: 'ADAPTER_DISABLED', error: `${delivery.channel} support notifications are disabled.` };
    const rendered = await this.renderDelivery(delivery);
    if (delivery.channel === 'whatsapp') {
      const bindingEvent: SupportNotificationEvent = delivery.event_type === 'ticket_reassigned' ? 'ticket_assigned' : delivery.event_type;
      const binding = await withSupportNotificationTenant(delivery.user_id, async (tx) => {
        const result = await tx.execute(sql`
          SELECT b.language, b.variable_mapping, wt.name
          FROM support_notification_provider_bindings b
          JOIN whatsapp_templates wt ON wt.id=b.whatsapp_template_id AND wt.user_id=b.user_id
          WHERE b.user_id=${delivery.user_id} AND b.channel='whatsapp' AND b.enabled IS TRUE
            AND b.event_type=${bindingEvent}
            AND b.team_id IS NULL
            AND wt.waba_template_id IS NOT NULL
            AND UPPER(COALESCE(wt.meta_status,wt.status,''))='APPROVED'
            AND wt.has_local_changes IS FALSE
            AND UPPER(wt.status)='APPROVED'
            AND wt.language=b.language
            AND UPPER(wt.category)='UTILITY'
          ORDER BY b.updated_at DESC LIMIT 1
        `);
        return result.rows[0] as { language?: string; variable_mapping?: unknown; name?: string } | undefined;
      });
      if (!binding?.name) return { outcome: 'permanent_failure', providerStatus: 'template_binding_missing',
        errorCode: 'WHATSAPP_TEMPLATE_REQUIRED', error: 'Select an approved tenant WhatsApp utility template for this support event.' };
      const rawMapping = binding.variable_mapping && typeof binding.variable_mapping === 'object'
        ? binding.variable_mapping as Record<string, unknown>
        : DEFAULT_WHATSAPP_VARIABLE_MAPPING;
      const entries = Object.entries(rawMapping).sort(([left], [right]) => Number(left) - Number(right));
      if (entries.length !== 7 || entries.some(([position, variable], index) => Number(position) !== index + 1
        || !Object.hasOwn(rendered.model, String(variable)))
        || new Set(entries.map(([, variable]) => String(variable))).size !== entries.length) {
        return { outcome: 'permanent_failure', providerStatus: 'template_mapping_invalid',
          errorCode: 'WHATSAPP_TEMPLATE_MAPPING_INVALID', error: 'The WhatsApp support template variable mapping is invalid.' };
      }
      if (mode === 'simulate') return { outcome: 'accepted', providerMessageId: `simulated-whatsapp-${delivery.id}`, providerStatus: 'simulated' };
      const { whatsappApiService } = await import('./whatsappApiService.js');
      const result = await whatsappApiService.sendTemplate({ userId: delivery.user_id, to: recipient, templateName: binding.name,
        language: binding.language || 'en_US',
        components: [{ type: 'body', parameters: entries.map(([, variable]) => ({
          type: 'text' as const,
          text: String(rendered.model[String(variable) as keyof SupportTicketAlertRenderModel]).slice(0, 1000),
        })) }] });
      return supportNotificationProviderAcknowledgement(result?.messages?.[0]?.id);
    }
    if (mode === 'simulate') return { outcome: 'accepted', providerMessageId: `simulated-${delivery.channel}-${delivery.id}`, providerStatus: 'simulated' };
    if (delivery.channel === 'email') {
      const { sendEmail } = await import('./resendService.js');
      const from = await getSupportNotificationEmailSender();
      if (!from) return { outcome: 'permanent_failure', providerStatus: 'configuration_required',
        errorCode: 'EMAIL_SENDER_NOT_CONFIGURED', error: 'Configure the platform email sender in Admin Integrations.' };
      const result = await sendEmail({ from: `AskSales Support <${from}>`, to: recipient, subject: rendered.subject,
        text: rendered.text, html: rendered.html,
        idempotencyKey: `support-notification/${delivery.event_key}/${delivery.member_id}/email`.slice(0, 256) });
      return supportNotificationProviderAcknowledgement(result?.id);
    }
    if (delivery.channel === 'slack' || delivery.channel === 'teams') {
      const body = delivery.channel === 'slack' ? { text: rendered.text }
        : { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive',
          content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: rendered.text, wrap: true }] } }] };
      const { response } = await fetchPublicHttpUrl(recipient, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }, 0);
      if (!response.ok) throw new Error(`${delivery.channel} webhook returned HTTP ${response.status}.`);
      return { outcome: 'delivered', providerStatus: `http_${response.status}` };
    }
    return { outcome: 'suppressed', providerStatus: 'policy_blocked', errorCode: 'PROVIDER_POLICY_BLOCKED',
      error: `${delivery.channel} employee alerts require provider-scoped enrollment.` };
  }

  async processDelivery(deliveryId: number, userId: number): Promise<void> {
    const delivery = await withSupportNotificationTenant(userId, async (tx) => {
      const claimed = await tx.execute(supportNotificationDeliveryClaim(userId, deliveryId));
      return claimed.rows[0] as unknown as DeliveryRow | undefined;
    });
    if (!delivery || delivery.status !== 'sending') return;
    try {
      const encryptedRecipient = delivery.recipient_ciphertext || delivery.recipient;
      if (!encryptedRecipient) throw new Error('Notification destination is unavailable.');
      const recipient = (() => { try { return decryptValue(encryptedRecipient); } catch { return encryptedRecipient; } })();
      const result = await this.sendAdapter(delivery, recipient);
      await withSupportNotificationTenant(userId, async (tx) => {
        const status: SupportDeliveryStatus = result.outcome === 'accepted' ? 'accepted' : result.outcome === 'delivered' ? 'delivered'
          : result.outcome === 'uncertain' ? 'uncertain' : result.outcome === 'suppressed' ? 'suppressed' : 'failed';
        await tx.execute(sql`
          UPDATE support_member_notification_deliveries SET status = ${status}, provider_message_id = ${result.providerMessageId || null},
            provider_status = ${result.providerStatus}, error_code = ${result.errorCode || null}, last_error = ${result.error || null},
            accepted_at = CASE WHEN ${status} = 'accepted' THEN NOW() ELSE accepted_at END,
            delivered_at = CASE WHEN ${status} = 'delivered' THEN NOW() ELSE delivered_at END,
            sent_at = CASE WHEN ${status} IN ('accepted', 'delivered') THEN NOW() ELSE sent_at END, updated_at = NOW()
          WHERE id = ${deliveryId} AND user_id = ${userId}
        `);
      });
    } catch (error) {
      const exhausted = delivery.attempt_count >= delivery.max_attempts;
      const uncertain = supportNotificationSubmissionIsUncertain(delivery.channel, error);
      const message = error instanceof Error ? safeText(error.message, 2000) : 'Notification provider failed.';
      await withSupportNotificationTenant(userId, async (tx) => {
        await tx.execute(sql`
          UPDATE support_member_notification_deliveries
          SET status = ${uncertain ? 'uncertain' : exhausted ? 'dead_letter' : 'retry'},
            error_code = ${uncertain ? 'PROVIDER_OUTCOME_UNKNOWN' : exhausted ? 'RETRY_EXHAUSTED' : 'TRANSIENT_PROVIDER_ERROR'},
            last_error = ${message}, next_attempt_at = NOW() + (${supportNotificationBackoffMs(delivery.attempt_count)} || ' milliseconds')::interval, updated_at = NOW()
          WHERE id = ${deliveryId} AND user_id = ${userId}
        `);
      });
      if (!exhausted && !uncertain) throw error;
    }
  }

  async acknowledgeReceipt(userId: number, memberId: number, receiptId: number): Promise<boolean> {
    return withSupportNotificationTenant(userId, async (tx) => {
      const result = await tx.execute(sql`
        UPDATE support_notification_receipts SET acknowledged_at = COALESCE(acknowledged_at, NOW())
        WHERE id = ${receiptId} AND user_id = ${userId} AND member_id = ${memberId} RETURNING id
      `);
      return result.rows.length === 1;
    });
  }

  async retryDelivery(userId: number, deliveryId: number): Promise<boolean> {
    const updated = await withSupportNotificationTenant(userId, async (tx) => {
      const result = await tx.execute(sql`
        UPDATE support_member_notification_deliveries SET status = 'retry', attempt_count = 0, next_attempt_at = NOW(),
          updated_at = NOW(), last_error = NULL, error_code = NULL
        WHERE id = ${deliveryId} AND user_id = ${userId} AND status IN ('failed', 'dead_letter')
        RETURNING id, event_type
      `);
      return result.rows[0] as { id?: number; event_type?: SupportNotificationEvent } | undefined;
    });
    if (!updated?.id) return false;
    await this.queueDelivery(Number(updated.id), userId, updated.event_type || 'ticket_assigned');
    return true;
  }

  async queueOwnerTestDelivery(userId: number, memberId: number, channel: 'email' | 'whatsapp'): Promise<number> {
    const deliveryId = await withSupportNotificationTenant(userId, async (tx) => {
      const destination = await tx.execute(sql`
        SELECT d.id,d.destination_ciphertext,d.destination_hint
        FROM support_notification_destinations d
        JOIN support_notification_channel_settings s ON s.user_id=d.user_id AND s.channel=d.channel
        WHERE d.user_id=${userId} AND d.member_id=${memberId} AND d.channel=${channel}
          AND d.verification_status IN('verified','owner_verified') AND s.enabled IS TRUE LIMIT 1
      `);
      const row = destination.rows[0] as { id?: number; destination_ciphertext?: string; destination_hint?: string } | undefined;
      if (!row?.id || !row.destination_ciphertext) throw new Error(`Enable and save ${channel} notifications for this member first.`);
      if (channel === 'whatsapp') {
        const binding = await tx.execute(sql`
          SELECT b.id FROM support_notification_provider_bindings b
          JOIN whatsapp_templates wt ON wt.id=b.whatsapp_template_id AND wt.user_id=b.user_id
          WHERE b.user_id=${userId} AND b.event_type='ticket_assigned' AND b.channel='whatsapp'
            AND b.enabled IS TRUE AND b.team_id IS NULL
            AND wt.waba_template_id IS NOT NULL
            AND UPPER(COALESCE(wt.meta_status,wt.status,''))='APPROVED'
            AND UPPER(wt.category)='UTILITY'
          ORDER BY b.updated_at DESC LIMIT 1
        `);
        if (!binding.rows[0]) throw new Error('Select an approved WhatsApp support template before sending a test.');
      }
      const eventKey = `support-notification-test:${crypto.randomUUID()}`;
      const payload: EventPayload = {
        ticketId: 0, ticketNumber: 'TKT-TEST', priority: 'normal', sourceChannel: 'Dashboard test',
        ticketPath: '/dashboard/support/notifications', safeSummary: 'This is a support notification configuration test.',
        requiredAction: 'No action is required.', slaDeadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      };
      const created = await tx.execute(sql`
        INSERT INTO support_member_notification_deliveries (
          user_id,member_id,event_id,event_type,event_key,channel,destination_id,recipient_ciphertext,
          destination_hint,payload,max_attempts,expires_at
        ) VALUES (${userId},${memberId},NULL,'ticket_assigned',${eventKey},${channel},${Number(row.id)},
          ${row.destination_ciphertext},${row.destination_hint || 'verified destination'},${JSON.stringify(payload)}::jsonb,3,NOW()+INTERVAL '7 days')
        RETURNING id
      `);
      const id = Number((created.rows[0] as { id?: number } | undefined)?.id || 0);
      await tx.execute(sql`
        INSERT INTO support_notification_audit_logs (user_id,member_id,actor_type,action,entity_type,entity_id,metadata)
        VALUES (${userId},${memberId},'owner','delivery.test_queued','support_notification_delivery',${id},
          ${JSON.stringify({ channel, destinationHint: row.destination_hint })}::jsonb)
      `);
      return id;
    });
    if (!deliveryId) throw new Error('Unable to queue the test notification.');
    await this.queueDelivery(deliveryId, userId, 'ticket_assigned');
    return deliveryId;
  }

  async runMaintenance(): Promise<{ events: number; deliveries: number; escalations: number; purged: number }> {
    const events = await this.processPendingEvents(200);
    const deliveries = await this.processDueDeliveries(200);
    const tenantRows = await db.execute(sql`SELECT DISTINCT user_id FROM support_tickets WHERE deleted_at IS NULL`);
    let escalations = 0;
    let purged = 0;
    for (const row of tenantRows.rows as Array<{ user_id: number }>) {
      const userId = Number(row.user_id);
      const result = await withSupportNotificationTenant(userId, async (tx) => {
        const legacyFingerprints = await tx.execute(sql`
          SELECT id, channel, destination_ciphertext FROM support_notification_destinations
          WHERE user_id=${userId} AND fingerprint_version<2 LIMIT 200
        `);
        for (const destination of legacyFingerprints.rows as Array<{id:number;channel:SupportNotificationChannel;destination_ciphertext:string}>) {
          try {
            const plaintext=decryptValue(destination.destination_ciphertext);
            await tx.execute(sql`UPDATE support_notification_destinations SET destination_hash=${SupportMemberNotificationService.destinationDigest(destination.channel,plaintext,userId)},fingerprint_version=2,updated_at=NOW() WHERE id=${destination.id}`);
          } catch (error) {
            logger.warn({err:error,userId,destinationId:destination.id},'[SupportNotifications] Legacy destination fingerprint needs manual repair');
          }
        }
        const escalated = await tx.execute(sql`
          WITH candidates AS (
            SELECT r.id, r.event_id FROM support_notification_receipts r
            JOIN support_notification_events e ON e.id = r.event_id
            LEFT JOIN support_notification_policies p ON p.user_id = e.user_id AND p.team_id = e.team_id
            WHERE r.user_id = ${userId} AND r.acknowledged_at IS NULL AND e.severity = 'urgent'
              AND e.processing_status = 'expanded'
              AND r.created_at < NOW() - (COALESCE(p.urgent_escalation_minutes, 10) || ' minutes')::interval
              AND r.escalation_level = 0
          ) UPDATE support_notification_receipts r SET escalation_level = 1, escalated_at = NOW()
          FROM candidates c WHERE r.id = c.id RETURNING r.id, r.event_id
        `);
        for (const candidate of escalated.rows as Array<{ id: number; event_id: number }>) {
          await tx.execute(sql`
            INSERT INTO support_notification_escalations (user_id, event_id, receipt_id, escalation_level, reason)
            VALUES (${userId}, ${candidate.event_id}, ${candidate.id}, 1, 'urgent_unacknowledged') ON CONFLICT DO NOTHING
          `);
        }
        const deleted = await tx.execute(sql`
          WITH removed_deliveries AS (DELETE FROM support_member_notification_deliveries WHERE user_id = ${userId} AND expires_at < NOW() RETURNING 1),
          removed_receipts AS (DELETE FROM support_notification_receipts WHERE user_id = ${userId} AND created_at < NOW() - INTERVAL '90 days' RETURNING 1),
          removed_events AS (DELETE FROM support_notification_events WHERE user_id = ${userId} AND expires_at < NOW() RETURNING 1),
          removed_audits AS (DELETE FROM support_notification_audit_logs WHERE user_id = ${userId} AND expires_at < NOW() RETURNING 1)
          SELECT (SELECT COUNT(*) FROM removed_deliveries) + (SELECT COUNT(*) FROM removed_receipts)
            + (SELECT COUNT(*) FROM removed_events) + (SELECT COUNT(*) FROM removed_audits) AS count
        `);
        return { escalations: escalated.rows.length, purged: Number((deleted.rows[0] as { count?: number } | undefined)?.count || 0) };
      });
      escalations += result.escalations;
      purged += result.purged;
    }
    return { events, deliveries, escalations, purged };
  }

  async sendVerification(userId: number, channel: SupportNotificationChannel, destination: string, code: string): Promise<void> {
    if (deliveryMode() === 'disabled') throw new Error('Support notification delivery is disabled.');
    if (!adapterEnabled(channel)) throw new Error(`${channel} support notifications are disabled.`);
    if (channel === 'email') {
      const { sendEmail } = await import('./resendService.js');
      const from = await getSupportNotificationEmailSender();
      if (!from) throw new Error('Configure the platform email sender in Admin Integrations.');
      await sendEmail({ from: `AskSales Support <${from}>`, to: destination,
        subject: 'Verify your support notification email',
        text: `Your AskSales support notification verification code is ${code}. It expires in 10 minutes.`,
        html: `<p>Your AskSales support notification verification code is <strong>${escapeHtml(code)}</strong>.</p><p>It expires in 10 minutes.</p>`,
        idempotencyKey: `support-verification/${userId}/email/${crypto.createHash('sha256').update(code).digest('hex').slice(0, 24)}` });
      return;
    }
    if (channel === 'slack' || channel === 'teams') {
      const { response } = await fetchPublicHttpUrl(destination, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `AskSales support notification verification code: ${code} (expires in 10 minutes).` }),
        signal: AbortSignal.timeout(15_000) }, 0);
      if (!response.ok) throw new Error(`${channel} verification returned HTTP ${response.status}.`);
      return;
    }
    if (channel === 'whatsapp') {
      const templateName = process.env.SUPPORT_NOTIFICATION_WHATSAPP_VERIFICATION_TEMPLATE;
      if (!templateName) throw new Error('An approved WhatsApp verification template is not configured.');
      const { whatsappApiService } = await import('./whatsappApiService.js');
      await whatsappApiService.sendTemplate({ userId, to: destination, templateName,
        language: process.env.SUPPORT_NOTIFICATION_WHATSAPP_TEMPLATE_LANGUAGE || 'en_US',
        components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }] });
      return;
    }
    throw new Error(`${channel} verification is not available.`);
  }

  async previewForOwner(userId: number, input: {
    eventType: SupportNotificationEvent;
    channel: SupportNotificationChannel;
    teamId?: number | null;
    memberId?: number | null;
  }) {
    return withSupportNotificationTenant(userId, async (tx) => {
      let memberId = Number(input.memberId || 0);
      if (!memberId) {
        const member = await tx.execute(sql`
          SELECT id FROM team_members WHERE user_id=${userId}
            AND (${input.teamId || null}::INTEGER IS NULL OR team_id=${input.teamId || null})
          ORDER BY is_active DESC,id LIMIT 1
        `);
        memberId = Number((member.rows[0] as { id?: number } | undefined)?.id || 0);
      }
      if (!memberId) throw new Error('Add a support member before previewing notifications.');
      const event: EventRow = {
        id: 0, user_id: userId, ticket_id: 123, handoff_id: null, event_type: input.eventType,
        event_key: 'preview', assigned_member_id: memberId, team_id: input.teamId || null,
        payload: {
          ticketId: 123, ticketNumber: 'TKT-EXAMPLE', priority: 'urgent', sourceChannel: 'WhatsApp',
          ticketPath: '/support/tickets/123', safeSummary: 'Customer needs help confirming room occupancy details.',
          requiredAction: 'Review and reply in the support portal.', slaDeadline: new Date(Date.now() + 18 * 60_000).toISOString(),
        },
        severity: 'urgent', source_channel: 'WhatsApp', category: 'booking',
        safe_summary: 'Customer needs help confirming room occupancy details.',
        required_action: 'Review and reply in the support portal.',
        sla_deadline: new Date(Date.now() + 18 * 60_000), processing_attempts: 0,
      };
      return this.resolveTemplate(tx, event, input.channel, memberId);
    });
  }

  static allowedTemplateVariables(): string[] {
    return [...TEMPLATE_VARIABLES];
  }
}

export const supportMemberNotificationService = new SupportMemberNotificationService();
