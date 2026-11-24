import { pgTable, serial, integer, varchar, text, timestamp, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { businessProfileColumn } from '../businessProfileColumn.js';
import { usersTable } from '../users/schema.js';
import { crmPipelineAutomationsTable } from '../crmPipelineAutomations/schema.js';
import type { AutomationContext, AutomationDefinition } from '../../../shared/crmAutomations.js';

export const crmAutomationRuntimeTable = pgTable('crm_automation_runtime', {
  id: integer('id').primaryKey().default(1),
  enabled: boolean('enabled').notNull().default(false),
  cutoverAt: timestamp('cutover_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const crmAutomationReceiptsTable = pgTable('crm_automation_receipts',{
  id:serial('id').primaryKey(),userId:integer('user_id').notNull().references(()=>usersTable.id,{onDelete:'cascade'}),businessProfileId:businessProfileColumn(),
  channel:varchar('channel',{length:30}).notNull(),providerAccountId:varchar('provider_account_id',{length:255}).notNull(),
  providerMessageId:varchar('provider_message_id',{length:1000}).notNull(),status:varchar('status',{length:40}).notNull(),
  occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({receiptUnique:uniqueIndex('crm_automation_receipts_uq').on(table.businessProfileId,table.userId,table.channel,table.providerAccountId,table.providerMessageId,table.status)}));
export const crmAutomationEventsTable = pgTable('crm_automation_events', {
  id: serial('id').primaryKey(), userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  businessProfileId: businessProfileColumn(), type: varchar('event_type', { length: 80 }).notNull(),
  sourceKey: varchar('source_key', { length: 800 }).notNull(), origin: varchar('origin', { length: 30 }).notNull().default('system'),
  contactId: integer('contact_id'), conversationId: integer('conversation_id'), campaignId: integer('campaign_id'),
  context: jsonb('context').$type<AutomationContext>().notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'), dispatchCount: integer('dispatch_count').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }), leaseToken: varchar('lease_token', { length: 80 }),
  errorMessage: text('error_message'), occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  preparedAt: timestamp('prepared_at', { withTimezone: true }),
}, table => ({
  sourceUnique: uniqueIndex('crm_automation_events_source_uq').on(table.businessProfileId, table.userId, table.type, table.sourceKey),
  pendingIndex: index('crm_automation_events_pending_idx').on(table.status, table.availableAt),
}));
export const crmAutomationRunsTable = pgTable('crm_automation_runs', {
  id: serial('id').primaryKey(), userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  businessProfileId: businessProfileColumn(), automationId: integer('automation_id').notNull().references(() => crmPipelineAutomationsTable.id, { onDelete: 'cascade' }),
  automationName: varchar('automation_name', { length: 255 }).notNull(), revision: integer('revision').notNull(),
  priority: integer('priority').notNull().default(0),
  eventId: integer('event_id').notNull().references(() => crmAutomationEventsTable.id, { onDelete: 'cascade' }),
  eventType: varchar('event_type', { length: 80 }).notNull(), contactId: integer('contact_id'), contactName: text('contact_name'),
  definition: jsonb('definition').$type<AutomationDefinition>().notNull(), context: jsonb('context').$type<AutomationContext>().notNull(),
  status: varchar('status', { length: 20 }).notNull().default('queued'), errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => ({
  eventRuleUnique: uniqueIndex('crm_automation_runs_event_rule_uq').on(table.automationId, table.eventId),
  historyIndex: index('crm_automation_runs_history_idx').on(table.businessProfileId, table.automationId, table.id),
}));
export const crmAutomationRunStepsTable = pgTable('crm_automation_run_steps', {
  id: serial('id').primaryKey(), userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  businessProfileId: businessProfileColumn(), runId: integer('run_id').notNull().references(() => crmAutomationRunsTable.id, { onDelete: 'cascade' }),
  stepId: varchar('step_id', { length: 80 }).notNull(), position: integer('position').notNull(), actionType: varchar('action_type', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'), attempts: integer('attempts').notNull().default(0),
  dispatchStarted: boolean('dispatch_started').notNull().default(false), errorMessage: text('error_message'), result: jsonb('result').$type<Record<string, unknown>>(),
  prepared: jsonb('prepared').$type<Record<string, unknown>>(),
  providerMessageId: varchar('provider_message_id', { length: 1000 }), providerStatus: varchar('provider_status', { length: 40 }),
  channel: varchar('channel', { length: 30 }), providerAccountId: varchar('provider_account_id', { length: 255 }),
  reservationTransactionId: integer('reservation_transaction_id'), conversationId: integer('conversation_id'), messageId: integer('message_id'),
  refundPending: boolean('refund_pending').notNull().default(false),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => ({
  stepUnique: uniqueIndex('crm_automation_run_steps_step_uq').on(table.runId, table.stepId),
  receiptIndex: index('crm_automation_run_steps_receipt_idx').on(table.businessProfileId, table.channel, table.providerAccountId, table.providerMessageId),
}));
