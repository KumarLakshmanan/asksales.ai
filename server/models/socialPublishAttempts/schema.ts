import { businessProfileColumn } from "../businessProfileColumn.js";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema.js';
import { contentAssetsTable } from '../contentAssets/schema.js';
import { channelCredentialsTable } from '../channelCredentials/schema.js';
import type { YouTubePublishingOptions } from '../../utils/youtubePublishingOptions.js';
import type { InstagramPublishingOptions } from '../../utils/instagramPublishingOptions.js';

export type SocialPublishAttemptStatus =
  | 'pending'
  | 'claimed'
  | 'provider_succeeded'
  | 'succeeded'
  | 'retryable_failed'
  | 'ambiguous'
  | 'failed'
  | 'cancelled'
  | 'remote_deleted';

export interface OrganicPublishOrigin {
  userId: number;
  businessProfileId: number;
  businessActorUserId: number;
  billingOrganizationId: number;
  billingActorUserId: number;
}

export interface OrganicPublishSnapshot {
  publicationOrigin?: OrganicPublishOrigin;
  sourceAssetVersion?: number;
  sourceReviewToken?: string;
  /** Binds idempotent replay to the original root and reviewed request. */
  requestFingerprint?: string;
  platform: 'instagram' | 'facebook' | 'youtube' | 'linkedin';
  caption: string;
  postType: string;
  title?: string;
  tags?: string[];
  callToAction?: string;
  privacyStatus?: string;
  youtubeOptions?: YouTubePublishingOptions;
  imageUrls: string[];
  videoUrls: string[];
  credentialId: number;
  providerAccountId: string;
  /** Trusted media metadata used for current YouTube Shorts validation. */
  videoMetadata?: { durationSeconds?: number; width?: number; height?: number };
  instagramOptions?: InstagramPublishingOptions;
  timezone: string;
  scheduledFor?: string;
  approvedBy: number;
  approvedAt: string;
  brandContextSnapshot?: Record<string, unknown>;
  validationSnapshot?: Record<string, unknown>;
}

export const socialPublishAttemptsTable = pgTable('social_publish_attempts', {
  businessProfileId: businessProfileColumn(),
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  assetId: integer('asset_id').references(() => contentAssetsTable.id, { onDelete: 'set null' }),
  platform: varchar('platform', { length: 24 }).notNull(),
  credentialId: integer('credential_id').references(() => channelCredentialsTable.id, { onDelete: 'set null' }),
  providerAccountId: varchar('provider_account_id', { length: 255 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  status: varchar('status', { length: 32 }).$type<SocialPublishAttemptStatus>().notNull().default('pending'),
  reviewedPayload: jsonb('reviewed_payload').$type<OrganicPublishSnapshot>().notNull(),
  providerRequestId: varchar('provider_request_id', { length: 255 }),
  providerPostId: varchar('provider_post_id', { length: 255 }),
  providerPostUrl: text('provider_post_url'),
  errorCode: varchar('error_code', { length: 100 }),
  errorMessage: text('error_message'),
  attemptCount: integer('attempt_count').notNull().default(0),
  reconciliationCount: integer('reconciliation_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  claimedBy: varchar('claimed_by', { length: 255 }),
  providerSucceededAt: timestamp('provider_succeeded_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  organicInsights: jsonb('organic_insights').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  tenantKeyUnique: uniqueIndex('social_publish_attempts_tenant_key_uidx')
    .on(table.businessProfileId, table.userId, table.idempotencyKey),
  dueIdx: index('social_publish_attempts_due_idx')
    .on(table.status, table.nextAttemptAt),
  assetIdx: index('social_publish_attempts_asset_idx')
    .on(table.userId, table.assetId, table.createdAt),
  providerIdx: uniqueIndex('social_publish_attempts_provider_idx')
    .on(table.platform, table.providerPostId),
}));

export type SocialPublishAttempt = typeof socialPublishAttemptsTable.$inferSelect;
export type InsertSocialPublishAttempt = typeof socialPublishAttemptsTable.$inferInsert;
