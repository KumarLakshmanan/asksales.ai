/**
 * Webhook Event Logger
 * Logs incoming webhook events to the webhook_events table for debugging and health monitoring.
 */

import { db } from '../models/db.js';
import { webhookEventsTable } from '../models/webhookEvents/schema.js';
import { logger } from '../utils/logger.js';
import { redactWebhookText, sanitizeWebhookPayload } from './webhookPayloadSanitizer.js';
import { currentBusinessScope, withSystemScope } from '../tenancy/businessContext.js';

interface LogWebhookEventParams {
  platform: string;
  eventType?: string;
  pageId?: string;
  userId?: number;
  payload?: unknown;
  signatureValid?: boolean;
  processed?: boolean;
  error?: string;
}

export async function logWebhookEvent(params: LogWebhookEventParams): Promise<void> {
  try {
    const scope = currentBusinessScope();
    const write = () => db.insert(webhookEventsTable).values({
      platform: params.platform,
      eventType: params.eventType || null,
      pageId: params.pageId || null,
      userId: scope?.userId ?? null,
      businessProfileId: scope?.businessProfileId ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: sanitizeWebhookPayload(params.payload) as any,
      signatureValid: params.signatureValid ?? true,
      processed: params.processed ?? false,
      error: redactWebhookText(params.error) || null,
    });
    if (scope) await write();
    else await withSystemScope('Record unrouted webhook health telemetry', write);
  } catch (err) {
    // Never let logging failures break webhook handling
    logger.error({ err }, '[WebhookLogger] Failed to log webhook event');
  }
}
