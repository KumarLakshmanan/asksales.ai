/**
 * Webhook Health Service (C1)
 *
 * Tracks unverifiable / rejected webhook payloads and surfaces them to admins
 * via Redis counters + EventBus alerts. Used when we cannot verify a Meta
 * X-Hub-Signature-256 signature because admin credentials are missing.
 *
 * We deliberately KEEP returning 200 to Meta so the page subscription is not
 * cancelled — but we make sure the operations team is not silently in the dark.
 */

import { getRedisConnection } from '../infrastructure/redis.js';
import { eventBus } from '../events/EventBus.js';
import { logger } from '../utils/logger.js';

const redis = () => getRedisConnection();

const COUNTER_KEY = (platform: string) => `webhook_health:drops:${platform}`;
const ALERT_DEDUP_KEY = (platform: string) => `webhook_health:alerted:${platform}`;
const COUNTER_TTL_SECONDS = 60 * 60 * 24; // keep counters for 24h
const ALERT_DEDUP_SECONDS = 60 * 5; // re-alert at most every 5 min

/** Severity levels for webhook health alerts. */
export type WebhookHealthSeverity = 'warning' | 'error' | 'critical';

interface RecordDropOptions {
  platform: 'instagram' | 'facebook' | 'whatsapp';
  reason: 'missing_app_secret' | 'invalid_signature' | 'unverifiable';
  severity?: WebhookHealthSeverity;
  context?: Record<string, unknown>;
}

/**
 * Record a webhook drop and (rate-limited) alert admins via EventBus.
 * Never throws — webhook handlers must never fail because of telemetry.
 */
export async function recordWebhookDrop(opts: RecordDropOptions): Promise<void> {
  const { platform, reason, severity = 'critical', context } = opts;
  try {
    const key = COUNTER_KEY(platform);
    const count = await redis().incr(key);
    if (count === 1) {
      await redis().expire(key, COUNTER_TTL_SECONDS);
    }

    // Rate-limit admin alerts so we don't flood
    const dedupKey = ALERT_DEDUP_KEY(platform);
    const wasAlerted = await redis().set(dedupKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (wasAlerted === 'OK') {
      await eventBus.publish({
        channel: 'events:notification' as never,
        userId: 0,
        timestamp: new Date().toISOString(),
        data: {
          type: 'webhook_health',
          severity,
          platform,
          reason,
          message: `${platform} webhook payload dropped: ${reason}. ${count} drops in last 24h.`,
          context: context || {},
        },
      });
    }

    logger.error(
      { platform, reason, count24h: count, ...context },
      `[WebhookHealth] Webhook payload dropped (${reason})`,
    );
  } catch (err) {
    // Telemetry must never break webhooks
    logger.warn({ err }, '[WebhookHealth] Failed to record webhook drop');
  }
}

