import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

const PLATFORM_TABLE_MAP: Record<string, { table: string; orderColumn: string }> = {
  msg91: { table: 'webhook_events', orderColumn: 'created_at' },
  instagram: { table: 'instagram_webhook_events', orderColumn: 'processed_at' },
  whatsapp: { table: 'instagram_webhook_events', orderColumn: 'processed_at' },
  facebook: { table: 'instagram_webhook_events', orderColumn: 'processed_at' },
  meta: { table: 'webhook_events', orderColumn: 'created_at' },
  gmail: { table: 'webhook_events', orderColumn: 'created_at' },
  resend: { table: 'webhook_events', orderColumn: 'created_at' },
  razorpay: { table: 'webhook_events', orderColumn: 'created_at' },
  twitter: { table: 'instagram_webhook_events', orderColumn: 'processed_at' },
  linkedin: { table: 'instagram_webhook_events', orderColumn: 'processed_at' },
};

function parsePaginationValue(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

/**
 * GET /api/integrations/:platform/webhook-events
 * Returns recent webhook events for a platform, scoped to current user when applicable.
 */
export const getIntegrationWebhookEvents = async (req: Request, res: Response) => {
  const platform = (req.params.platform || '').toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const limit = Math.max(1, parsePaginationValue(req.query.limit, 50, 200));
  const offset = parsePaginationValue(req.query.offset, 0, 1_000_000);

  const config = PLATFORM_TABLE_MAP[platform];
  if (!config) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }

  try {
    let rows;
    if (platform === 'instagram') {
      // Instagram telemetry is intentionally read from both stores:
      // - instagram_webhook_events contains the domain events (message, comment, like, ...)
      // - webhook_events contains receipt/processing telemetry and the original callback payload
      // Older rows did not always receive user_id, so page ownership is used as a tenant-safe fallback.
      rows = (await db.execute(sql`
        WITH combined_events AS (
          SELECT CONCAT('instagram:', id) AS event_key,
                 id, 'instagram_events' AS source, 'instagram' AS platform,
                 event_type, page_id, sender_id, message_text, raw_data AS payload,
                 user_id, NULL::boolean AS signature_valid,
                 is_processed AS processed, NULL::text AS error,
                 COALESCE(timestamp, processed_at, created_at) AS created_at
          FROM instagram_webhook_events
          WHERE (
            user_id = ${userId}
            OR page_id IN (
              SELECT owned_page_id
              FROM (
                SELECT page_id AS owned_page_id
                FROM meta_page_connections
                WHERE user_id = ${userId} AND is_active = TRUE AND instagram_active = TRUE
                UNION
                SELECT instagram_account_id AS owned_page_id
                FROM meta_page_connections
                WHERE user_id = ${userId} AND is_active = TRUE AND instagram_active = TRUE
                UNION
                SELECT account_identifier AS owned_page_id
                FROM channel_credentials
                WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                UNION
                SELECT session_data->>'pageId' AS owned_page_id
                FROM channel_credentials
                WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                UNION
                SELECT session_data->>'instagramAccountId' AS owned_page_id
                FROM channel_credentials
                WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
              ) owned_pages
              WHERE owned_page_id IS NOT NULL
            )
          )
          AND event_type NOT LIKE 'whatsapp%'
          AND event_type NOT LIKE 'facebook%'
          AND event_type NOT LIKE 'twitter%'
          AND event_type NOT LIKE 'linkedin%'

          UNION ALL

          SELECT CONCAT('webhook:', id) AS event_key,
                 id, 'webhook_log' AS source, platform,
                 event_type, page_id, NULL::text AS sender_id, NULL::text AS message_text, payload,
                 user_id, signature_valid, processed, error, created_at
          FROM webhook_events
          WHERE platform = 'instagram'
            AND (
              user_id = ${userId}
              OR page_id IN (
                SELECT owned_page_id
                FROM (
                  SELECT page_id AS owned_page_id
                  FROM meta_page_connections
                  WHERE user_id = ${userId} AND is_active = TRUE AND instagram_active = TRUE
                  UNION
                  SELECT instagram_account_id AS owned_page_id
                  FROM meta_page_connections
                  WHERE user_id = ${userId} AND is_active = TRUE AND instagram_active = TRUE
                  UNION
                  SELECT account_identifier AS owned_page_id
                  FROM channel_credentials
                  WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                  UNION
                  SELECT session_data->>'pageId' AS owned_page_id
                  FROM channel_credentials
                  WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                  UNION
                  SELECT session_data->>'instagramAccountId' AS owned_page_id
                  FROM channel_credentials
                  WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                ) owned_pages
                WHERE owned_page_id IS NOT NULL
              )
            )
        )
        SELECT *
        FROM combined_events
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `)).rows || [];
    } else if (config.table === 'instagram_webhook_events') {
      // Build platform-specific filter for instagram_webhook_events
      // whatsapp events → event_type LIKE 'whatsapp%'
      // facebook events → event_type LIKE 'facebook%'
      // instagram events → all others
      const platformFilter = platform === 'whatsapp'
        ? sql`event_type LIKE 'whatsapp%' AND user_id = ${userId}`
        : platform === 'facebook'
        ? sql`event_type LIKE 'facebook%' AND (
            user_id = ${userId}
            OR (user_id IS NULL AND page_id IN (
              SELECT page_id FROM meta_page_connections
              WHERE user_id = ${userId} AND is_active = TRUE AND facebook_active = TRUE
              UNION
              SELECT account_identifier FROM channel_credentials
              WHERE user_id = ${userId} AND platform = 'facebook_api' AND is_active = TRUE
              UNION
              SELECT session_data->>'pageId' FROM channel_credentials
              WHERE user_id = ${userId} AND platform = 'facebook_api' AND is_active = TRUE
            ))
          )`
        : platform === 'twitter'
        ? sql`event_type LIKE 'twitter%' AND user_id = ${userId}`
        : platform === 'linkedin'
        ? sql`event_type LIKE 'linkedin%' AND user_id = ${userId}`
        : sql`event_type NOT LIKE 'whatsapp%' AND event_type NOT LIKE 'facebook%' AND event_type NOT LIKE 'twitter%' AND event_type NOT LIKE 'linkedin%' AND user_id = ${userId}`;

      rows = (await db.execute(sql`
        SELECT id, event_type, page_id, sender_id, message_text, comment_text, raw_data AS payload,
               user_id, is_processed AS processed, NULL AS error,
               COALESCE(processed_at, created_at) AS created_at
        FROM instagram_webhook_events
        WHERE ${platformFilter}
        ORDER BY COALESCE(processed_at, created_at) DESC
        LIMIT ${limit} OFFSET ${offset}
      `)).rows || [];
    } else {
      rows = (await db.execute(sql`
        SELECT id, platform, event_type, page_id, user_id, payload, signature_valid, processed, error, created_at
        FROM ${sql.raw(config.table)}
        WHERE platform = ${platform}
          AND user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `)).rows || [];
    }

    return res.json({ success: true, platform, events: rows, pagination: { limit, offset } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.error({ err, platform }, '[IntegrationWebhookLogs] Failed to fetch events');
    return res.status(500).json({ error: 'Webhook events could not be loaded. Please try again.' });
  }
};

/**
 * GET /api/integrations/:platform/webhook-stats
 * Returns counts grouped by event_type over the last 7 days.
 */
export const getIntegrationWebhookStats = async (req: Request, res: Response) => {
  const platform = (req.params.platform || '').toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const config = PLATFORM_TABLE_MAP[platform];
  if (!config) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }

  try {
    let rows;
    if (platform === 'instagram') {
      rows = (await db.execute(sql`
        WITH combined_events AS (
          SELECT event_type, COALESCE(timestamp, processed_at, created_at) AS received_at
          FROM instagram_webhook_events
          WHERE (
            user_id = ${userId}
            OR page_id IN (
              SELECT owned_page_id
              FROM (
                SELECT page_id AS owned_page_id
                FROM meta_page_connections
                WHERE user_id = ${userId} AND is_active = TRUE AND instagram_active = TRUE
                UNION
                SELECT instagram_account_id AS owned_page_id
                FROM meta_page_connections
                WHERE user_id = ${userId} AND is_active = TRUE AND instagram_active = TRUE
                UNION
                SELECT account_identifier AS owned_page_id
                FROM channel_credentials
                WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                UNION
                SELECT session_data->>'pageId' AS owned_page_id
                FROM channel_credentials
                WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                UNION
                SELECT session_data->>'instagramAccountId' AS owned_page_id
                FROM channel_credentials
                WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
              ) owned_pages
              WHERE owned_page_id IS NOT NULL
            )
          )
          AND event_type NOT LIKE 'whatsapp%'
          AND event_type NOT LIKE 'facebook%'
          AND event_type NOT LIKE 'twitter%'
          AND event_type NOT LIKE 'linkedin%'

          UNION ALL

          SELECT event_type, created_at AS received_at
          FROM webhook_events
          WHERE platform = 'instagram'
            AND (
              user_id = ${userId}
              OR page_id IN (
                SELECT owned_page_id
                FROM (
                  SELECT page_id AS owned_page_id
                  FROM meta_page_connections
                  WHERE user_id = ${userId} AND is_active = TRUE AND instagram_active = TRUE
                  UNION
                  SELECT instagram_account_id AS owned_page_id
                  FROM meta_page_connections
                  WHERE user_id = ${userId} AND is_active = TRUE AND instagram_active = TRUE
                  UNION
                  SELECT account_identifier AS owned_page_id
                  FROM channel_credentials
                  WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                  UNION
                  SELECT session_data->>'pageId' AS owned_page_id
                  FROM channel_credentials
                  WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                  UNION
                  SELECT session_data->>'instagramAccountId' AS owned_page_id
                  FROM channel_credentials
                  WHERE user_id = ${userId} AND platform = 'instagram_api' AND is_active = TRUE
                ) owned_pages
                WHERE owned_page_id IS NOT NULL
              )
            )
        )
        SELECT event_type, COUNT(*)::int AS count, MAX(received_at) AS last_received
        FROM combined_events
        WHERE received_at > NOW() - INTERVAL '7 days'
        GROUP BY event_type
        ORDER BY count DESC
      `)).rows || [];
    } else if (config.table === 'instagram_webhook_events') {
      const platformFilter = platform === 'whatsapp'
        ? sql`event_type LIKE 'whatsapp%' AND user_id = ${userId} AND COALESCE(processed_at, created_at) > NOW() - INTERVAL '7 days'`
        : platform === 'facebook'
        ? sql`event_type LIKE 'facebook%' AND user_id = ${userId} AND COALESCE(processed_at, created_at) > NOW() - INTERVAL '7 days'`
        : platform === 'twitter'
        ? sql`event_type LIKE 'twitter%' AND user_id = ${userId} AND COALESCE(processed_at, created_at) > NOW() - INTERVAL '7 days'`
        : platform === 'linkedin'
        ? sql`event_type LIKE 'linkedin%' AND user_id = ${userId} AND COALESCE(processed_at, created_at) > NOW() - INTERVAL '7 days'`
        : sql`event_type NOT LIKE 'whatsapp%' AND event_type NOT LIKE 'facebook%' AND event_type NOT LIKE 'twitter%' AND event_type NOT LIKE 'linkedin%' AND user_id = ${userId} AND COALESCE(processed_at, created_at) > NOW() - INTERVAL '7 days'`;

      rows = (await db.execute(sql`
        SELECT event_type, COUNT(*)::int AS count, MAX(COALESCE(processed_at, created_at)) AS last_received
        FROM instagram_webhook_events
        WHERE ${platformFilter}
        GROUP BY event_type
        ORDER BY count DESC
      `)).rows || [];
    } else {
      rows = (await db.execute(sql`
        SELECT event_type, COUNT(*)::int AS count, MAX(created_at) AS last_received
        FROM ${sql.raw(config.table)}
        WHERE platform = ${platform}
          AND created_at > NOW() - INTERVAL '7 days'
          AND user_id = ${userId}
        GROUP BY event_type
        ORDER BY count DESC
      `)).rows || [];
    }

    return res.json({ success: true, platform, stats: rows });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.error({ err, platform }, '[IntegrationWebhookLogs] Failed to fetch stats');
    return res.status(500).json({ error: 'Webhook statistics could not be loaded. Please try again.' });
  }
};

/**
 * GET /api/admin/webhook-logs
 * Admin-only: aggregated webhook events across all platforms and users.
 */
export const getAdminWebhookLogs = async (req: Request, res: Response) => {
  const platform = (req.query.platform as string)?.toLowerCase();
  const rawTargetUserId = req.query.userId;
  const targetUserId = typeof rawTargetUserId === 'string' ? Number.parseInt(rawTargetUserId, 10) : undefined;
  if (rawTargetUserId !== undefined && (!Number.isInteger(targetUserId) || (targetUserId || 0) <= 0)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  const limit = Math.max(1, parsePaginationValue(req.query.limit, 100, 500));
  const offset = parsePaginationValue(req.query.offset, 0, 1_000_000);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];

    // Instagram and WhatsApp events live in instagram_webhook_events
    // All other platforms live in webhook_events
    if (platform === 'whatsapp') {
      const userFilter = targetUserId ? sql`AND user_id = ${targetUserId}` : sql``;
      rows = (await db.execute(sql`
        SELECT id,
               'whatsapp' AS platform,
               event_type, page_id, user_id, raw_data AS payload,
               is_processed AS processed, NULL AS error,
               COALESCE(processed_at, created_at) AS created_at
        FROM instagram_webhook_events
        WHERE event_type LIKE 'whatsapp%' ${userFilter}
        ORDER BY COALESCE(processed_at, created_at) DESC
        LIMIT ${limit} OFFSET ${offset}
      `)).rows || [];
    } else if (platform === 'facebook') {
      const userFilter = targetUserId ? sql`AND user_id = ${targetUserId}` : sql``;
      rows = (await db.execute(sql`
        SELECT id,
               'facebook' AS platform,
               event_type, page_id, user_id, raw_data AS payload,
               is_processed AS processed, NULL AS error,
               COALESCE(processed_at, created_at) AS created_at
        FROM instagram_webhook_events
        WHERE event_type LIKE 'facebook%' ${userFilter}
        ORDER BY COALESCE(processed_at, created_at) DESC
        LIMIT ${limit} OFFSET ${offset}
      `)).rows || [];
    } else if (platform === 'instagram' || platform === 'twitter' || platform === 'linkedin') {
      const userFilter = targetUserId ? sql`AND user_id = ${targetUserId}` : sql``;
      const platformFilter = platform === 'twitter'
        ? sql`event_type LIKE 'twitter%'`
        : platform === 'linkedin'
        ? sql`event_type LIKE 'linkedin%'`
        : sql`event_type NOT LIKE 'whatsapp%' AND event_type NOT LIKE 'facebook%' AND event_type NOT LIKE 'twitter%' AND event_type NOT LIKE 'linkedin%'`;
      rows = (await db.execute(sql`
        SELECT id,
               ${platform} AS platform,
               event_type, page_id, user_id, raw_data AS payload,
               is_processed AS processed, NULL AS error,
               COALESCE(processed_at, created_at) AS created_at
        FROM instagram_webhook_events
        WHERE ${platformFilter} ${userFilter}
        ORDER BY COALESCE(processed_at, created_at) DESC
        LIMIT ${limit} OFFSET ${offset}
      `)).rows || [];
    } else if (!platform || platform === 'all') {
      // All platforms: UNION both tables
      const userFilter = targetUserId ? sql`AND user_id = ${targetUserId}` : sql``;
      const genericUserFilter = targetUserId ? sql`AND user_id = ${targetUserId}` : sql``;
      rows = (await db.execute(sql`
        SELECT id,
               CASE
                 WHEN event_type LIKE 'whatsapp%' THEN 'whatsapp'
                 WHEN event_type LIKE 'facebook%' THEN 'facebook'
                 WHEN event_type LIKE 'twitter%' THEN 'twitter'
                 WHEN event_type LIKE 'linkedin%' THEN 'linkedin'
                 ELSE 'instagram'
               END AS platform,
               event_type, page_id, user_id, raw_data AS payload,
               is_processed AS processed, NULL AS error,
               COALESCE(processed_at, created_at) AS created_at
        FROM instagram_webhook_events
        WHERE 1=1 ${userFilter}
        UNION ALL
        SELECT id, platform, event_type, page_id, user_id, payload, processed, error, created_at
        FROM webhook_events
        WHERE 1=1 ${genericUserFilter}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `)).rows || [];
    } else {
      // Other platforms (gmail, resend, razorpay, etc.) from webhook_events
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const weFilters: any[] = [sql`platform = ${platform}`];
      if (targetUserId) weFilters.push(sql`user_id = ${targetUserId}`);
      const weWhere = weFilters.reduce((acc, f) => sql`${acc} AND ${f}`, sql`1=1`);
      rows = (await db.execute(sql`
        SELECT id, platform, event_type, page_id, user_id, payload, processed, error, created_at
        FROM webhook_events
        WHERE ${weWhere}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `)).rows || [];
    }

    return res.json({
      success: true,
      events: rows,
      pagination: { limit, offset, total: rows.length + offset },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.error({ err }, '[AdminWebhookLogs] Failed to fetch logs');
    return res.status(500).json({ error: 'Webhook logs could not be loaded. Please try again.' });
  }
};
