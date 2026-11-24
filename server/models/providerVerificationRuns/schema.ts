import { businessProfileColumn } from "../businessProfileColumn.js";
import { index, integer, jsonb, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core';

export type ProviderVerificationPlatform = 'facebook' | 'instagram' | 'whatsapp' | 'meta_ads' | 'google_ads' | 'youtube' | 'gmail' | 'resend' | 'msg91';
export type ProviderVerificationStatus = 'passing' | 'failing' | 'blocked';

export interface ProviderVerificationCheck {
  id: string;
  status: 'pass' | 'fail' | 'blocked' | 'not_applicable';
  required: boolean;
  detail: string;
}

export const providerVerificationRunsTable = pgTable('provider_verification_runs', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  platform: varchar('platform', { length: 24 }).$type<ProviderVerificationPlatform>().notNull(),
  credentialId: integer('credential_id'),
  providerAccountId: varchar('provider_account_id', { length: 255 }),
  status: varchar('status', { length: 16 }).$type<ProviderVerificationStatus>().notNull(),
  checks: jsonb('checks').$type<ProviderVerificationCheck[]>().notNull().default([]),
  providerRequestIds: jsonb('provider_request_ids').$type<string[]>().notNull().default([]),
  errorCode: varchar('error_code', { length: 80 }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => ({
  userPlatformIdx: index('provider_verification_runs_user_platform_idx').on(table.userId, table.platform, table.checkedAt),
}));

export type ProviderVerificationRun = typeof providerVerificationRunsTable.$inferSelect;
export type InsertProviderVerificationRun = typeof providerVerificationRunsTable.$inferInsert;
