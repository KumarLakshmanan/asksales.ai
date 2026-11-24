import { businessProfileColumn } from "../businessProfileColumn.js";
import { index, integer, jsonb, pgTable, serial, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/** Tenant-owned, normalized daily YouTube Analytics snapshots. */
export const youtubeAnalyticsSnapshotsTable = pgTable('youtube_analytics_snapshots', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  credentialId: integer('credential_id').notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  videoId: varchar('video_id', { length: 255 }).notNull().default('__channel__'),
  metricDate: varchar('metric_date', { length: 10 }).notNull(),
  metrics: jsonb('metrics').$type<Record<string, number>>().notNull(),
  syncedAt: timestamp('synced_at').notNull().defaultNow(),
}, (table) => ({
  tenantVideoDate: uniqueIndex('youtube_analytics_snapshots_tenant_video_date_uq').on(table.businessProfileId, table.userId, table.credentialId, table.channelId, table.videoId, table.metricDate),
  tenantSynced: index('youtube_analytics_snapshots_tenant_synced_idx').on(table.userId, table.credentialId, table.syncedAt.desc()),
}));
