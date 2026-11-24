import { businessProfileColumn } from "../businessProfileColumn.js";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { outreachConversationsTable, outreachMessagesTable } from '../outreachConversations/schema.js';
import { usersTable } from '../users/schema.js';

export const socialFollowUpSchedulesTable = pgTable('social_follow_up_schedules', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conversationId: integer('conversation_id').notNull()
    .references(() => outreachConversationsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull()
    .references(() => usersTable.id, { onDelete: 'cascade' }),
  channel: varchar('channel', { length: 24 }).notNull(),
  anchorMessageId: integer('anchor_message_id').notNull()
    .references(() => outreachMessagesTable.id, { onDelete: 'cascade' }),
  steps: jsonb('steps').notNull(),
  nextStep: integer('next_step').notNull().default(1),
  nextRunAt: timestamp('next_run_at').notNull(),
  status: varchar('status', { length: 24 }).notNull().default('active'),
  deliveryMessageId: integer('delivery_message_id')
    .references(() => outreachMessagesTable.id, { onDelete: 'set null' }),
  cancelledAt: timestamp('cancelled_at'),
  cancellationReason: varchar('cancellation_reason', { length: 64 }),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  conversationUq: uniqueIndex('social_follow_up_schedules_conversation_uq')
    .on(table.conversationId),
  dueIdx: index('social_follow_up_schedules_due_idx')
    .on(table.status, table.nextRunAt)
    .where(sql`${table.status} = 'active'`),
  userChannelIdx: index('social_follow_up_schedules_user_channel_idx')
    .on(table.userId, table.channel),
  channelCheck: check(
    'social_follow_up_schedules_channel_check',
    sql`${table.channel} IN ('instagram', 'facebook', 'whatsapp')`,
  ),
  statusCheck: check(
    'social_follow_up_schedules_status_check',
    sql`${table.status} IN ('active', 'queued', 'sending', 'completed', 'cancelled')`,
  ),
  nextStepCheck: check(
    'social_follow_up_schedules_next_step_check',
    sql`${table.nextStep} > 0`,
  ),
  stepsCheck: check(
    'social_follow_up_schedules_steps_check',
    sql`jsonb_typeof(${table.steps}) = 'array' AND jsonb_array_length(${table.steps}) > 0`,
  ),
}));

export type SocialFollowUpScheduleRecord = typeof socialFollowUpSchedulesTable.$inferSelect;
export type InsertSocialFollowUpSchedule = typeof socialFollowUpSchedulesTable.$inferInsert;
