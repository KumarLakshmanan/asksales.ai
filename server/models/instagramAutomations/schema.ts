import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';
import { businessProfileColumn } from '../businessProfileColumn.js';
import type {
  InstagramRuleDefinition,
  InstagramProfileConfig,
} from '../../../shared/instagramAutomations.js';
const ownership = () => ({
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  businessProfileId: businessProfileColumn(),
});
const dates = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const instagramAutomationProfilesTable = pgTable(
  'instagram_automation_profiles',
  {
    ...ownership(),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    kind: varchar('kind', { length: 20 }).notNull(),
    config: jsonb('config').$type<InstagramProfileConfig>().notNull(),
    publishedConfig: jsonb('published_config').$type<InstagramProfileConfig>(),
    revision: integer('revision').notNull().default(1),
    syncStatus: varchar('sync_status', { length: 20 }).notNull().default('draft'),
    syncError: text('sync_error'),
    syncRemove: boolean('sync_remove').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    ...dates(),
  },
  (t) => ({
    accountKind: uniqueIndex('instagram_automation_profiles_account_uq').on(
      t.businessProfileId,
      t.userId,
      t.accountId,
      t.kind
    ),
  })
);
export const instagramAutomationRulesTable = pgTable('instagram_automation_rules', {
  ...ownership(),
  accountId: varchar('account_id', { length: 255 }).notNull(),
  definition: jsonb('definition').$type<InstagramRuleDefinition>().notNull(),
  status: varchar('status', { length: 20 }).notNull().default('paused'),
  priority: integer('priority').notNull().default(0),
  revision: integer('revision').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...dates(),
});
export const instagramAutomationRunsTable = pgTable(
  'instagram_automation_runs',
  {
    ...ownership(),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    sourceKey: varchar('source_key', { length: 1000 }).notNull(),
    ruleId: integer('rule_id').references(() => instagramAutomationRulesTable.id),
    ruleName: varchar('rule_name', { length: 120 }).notNull(),
    definition: jsonb('definition').notNull(),
    context: jsonb('context').notNull(),
    conversationId: integer('conversation_id'),
    senderId: varchar('sender_id', { length: 255 }).notNull(),
    recipientId: varchar('recipient_id', { length: 255 }),
    status: varchar('status', { length: 30 }).notNull().default('queued'),
    reason: text('reason'),
    privateMessageId: varchar('private_message_id', { length: 1000 }),
    publicMessageId: varchar('public_message_id', { length: 1000 }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    reservedAt: timestamp('reserved_at', { withTimezone: true }),
    ...dates(),
  },
  (t) => ({
    source: uniqueIndex('instagram_automation_runs_source_uq').on(
      t.businessProfileId,
      t.userId,
      t.accountId,
      t.sourceKey
    ),
  })
);
export const instagramAutomationEffectsTable = pgTable(
  'instagram_automation_effects',
  {
    ...ownership(),
    runId: integer('run_id')
      .notNull()
      .references(() => instagramAutomationRunsTable.id, { onDelete: 'cascade' }),
    effectKey: varchar('effect_key', { length: 1000 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('sending'),
    providerMessageId: varchar('provider_message_id', { length: 1000 }),
    recipientId: varchar('recipient_id', { length: 255 }),
    error: text('error'),
    ...dates(),
  },
  (t) => ({ effect: uniqueIndex('instagram_automation_effects_key_uq').on(t.runId, t.effectKey) })
);
