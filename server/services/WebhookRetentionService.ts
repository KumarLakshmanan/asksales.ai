import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withSystemScope } from '../tenancy/businessContext.js';

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 365;

export function getWebhookRetentionDays(): number {
  const configured = Number.parseInt(process.env.SUPPORT_WEBHOOK_LOG_RETENTION_DAYS || '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(1, configured));
}

class WebhookRetentionService {
  async purgeExpired(): Promise<{ integrationEvents: number; healthEvents: number }> {
    const days = getWebhookRetentionDays();
    const integrationResult = await db.execute(sql`
      DELETE FROM instagram_webhook_events
      WHERE COALESCE(created_at, processed_at, timestamp) < NOW() - (${days} * INTERVAL '1 day')
      RETURNING id
    `);
    const healthResult = await db.execute(sql`
      DELETE FROM webhook_events
      WHERE created_at < NOW() - (${days} * INTERVAL '1 day')
      RETURNING id
    `);
    const unroutedResult = await withSystemScope('Expire unrouted webhook telemetry', () => db.execute(sql`
      DELETE FROM webhook_events WHERE business_profile_id IS NULL AND user_id IS NULL
        AND created_at < NOW() - (${days} * INTERVAL '1 day') RETURNING id
    `));
    return {
      integrationEvents: integrationResult.rows.length,
      healthEvents: healthResult.rows.length + unroutedResult.rows.length,
    };
  }
}

export const webhookRetentionService = new WebhookRetentionService();
