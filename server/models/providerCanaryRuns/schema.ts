import { businessProfileColumn } from "../businessProfileColumn.js";
import { index, integer, jsonb, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core';
import type { ProviderVerificationCheck, ProviderVerificationPlatform } from '../providerVerificationRuns/schema.js';

export type ProviderCanaryStatus = 'planned' | 'passing' | 'failing' | 'blocked';

/**
 * Immutable, secret-free evidence for an operator initiated provider canary.
 * Tokens, upload URLs, recipient addresses, and provider response bodies are
 * intentionally never persisted here.
 */
export interface ProviderCanaryEvidence {
  mode: 'dry_run' | 'execute';
  requestedAccountIdentifier: string | null;
  resolvedCredentialId: number | null;
  resolvedAccountIdentifier: string | null;
  accountBindingMatches: boolean;
  checks?: ProviderVerificationCheck[];
  providerRequestIds?: string[];
  errorCode?: string | null;
}

export const providerCanaryRunsTable = pgTable('provider_canary_runs', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  platform: varchar('platform', { length: 24 }).$type<ProviderVerificationPlatform>().notNull(),
  credentialId: integer('credential_id'),
  requestedAccountIdentifier: varchar('requested_account_identifier', { length: 255 }),
  status: varchar('status', { length: 16 }).$type<ProviderCanaryStatus>().notNull(),
  evidence: jsonb('evidence').$type<ProviderCanaryEvidence>().notNull(),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userPlatformCreatedIdx: index('provider_canary_runs_user_platform_created_idx').on(table.userId, table.platform, table.createdAt),
}));

export type ProviderCanaryRun = typeof providerCanaryRunsTable.$inferSelect;
