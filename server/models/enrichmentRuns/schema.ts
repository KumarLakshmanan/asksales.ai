import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, numeric, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema.js';
import { leadsTable } from '../leads/schema.js';

export const enrichmentRunsTable = pgTable('enrichment_runs', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  leadId: integer('lead_id').references(() => leadsTable.id, { onDelete: 'set null' }),
  leadName: text('lead_name'),
  leadEmail: varchar('lead_email', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('running'),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  totalHandlesProcessed: integer('total_handles_processed').default(0),
  totalIterations: integer('total_iterations').default(0),
  emailsFound: integer('emails_found').default(0),
  phonesFound: integer('phones_found').default(0),
  websitesFound: integer('websites_found').default(0),
  errorMessage: text('error_message'),
  summary: jsonb('summary'),
  requestKey: varchar('request_key', { length: 128 }),
  requestFingerprint: varchar('request_fingerprint', { length: 64 }),
  billingTransactionId: integer('billing_transaction_id'),
  billingCredits: numeric('billing_credits', { precision: 10, scale: 2 }),
  billingStatus: varchar('billing_status', { length: 32 }),
  providerDispatchStartedAt: timestamp('provider_dispatch_started_at'),
  executionResult: jsonb('execution_result'),
  removalIntents: jsonb('removal_intents').notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, table => ({ requestKeyUq: uniqueIndex('enrichment_runs_request_key_uq').on(table.businessProfileId, table.userId, table.requestKey) }));
