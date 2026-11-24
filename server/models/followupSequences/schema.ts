import { businessProfileColumn } from "../businessProfileColumn.js";
 
import { pgTable, text, timestamp, serial, varchar, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { leadsTable } from "../leads/schema";
import { usersTable } from "../users/schema";

/**
 * Follow-up Sequences Table
 * Tracks automated email follow-up sequences for B2B leads
 */
export const followupSequencesTable = pgTable("followup_sequences", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: 'cascade' }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  campaignId: integer("campaign_id"),
  recipientEmail: varchar("recipient_email", { length: 255 }).notNull(),
  recipientName: varchar("recipient_name", { length: 255 }),
  initialSubject: text("initial_subject").notNull(),
  initialBody: text("initial_body").notNull(),
  initialSentAt: timestamp("initial_sent_at").notNull(),
  threadKey: varchar("thread_key", { length: 512 }).notNull(),
  conversationId: integer("conversation_id"),
  steps: jsonb("steps").notNull().$type<{
    name: string;
    delaySeconds: number;
    delayDays?: number;
    subject?: string;
    body?: string;
    sentAt?: string;
    status: 'pending' | 'sent' | 'skipped';
  }>(),
  retirementState: varchar("retirement_state", { length: 30 }),
  retiredAt: timestamp("retired_at"),
  completed: boolean("completed").default(false).notNull(),
  deadLead: boolean("dead_lead").default(false).notNull(),
  repliedAt: timestamp("replied_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  channel: varchar("channel", { length: 50 }).default('email'),
}, (table) => ({
  leadIdIdx: index("followup_sequences_lead_id_idx").on(table.leadId),
  userIdIdx: index("followup_sequences_user_id_idx").on(table.userId),
  threadKeyIdx: index("followup_sequences_thread_key_idx").on(table.threadKey),
  conversationIdIdx: index("followup_sequences_conversation_id_idx").on(table.conversationId),
  completedIdx: index("followup_sequences_completed_idx").on(table.completed),
}));

export type FollowupSequenceRecord = typeof followupSequencesTable.$inferSelect;
export type InsertFollowupSequence = typeof followupSequencesTable.$inferInsert;
