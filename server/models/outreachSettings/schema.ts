import { businessProfileColumn } from "../businessProfileColumn.js";
import { uniqueIndex, pgTable, serial, integer, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import type { EmailDesignPreferences } from '../../../shared/emailDesigns.js';

export interface FollowUpStep {
  id: number;
  delayHours: number;
  templateId: number | null;
  templateName: string;
  customSubject: string;
  customBody: string;
}

export interface ChannelFollowUp {
  id: string;
  delayDays: number;
  delayHours: number;
  delayMinutes: number;
  enabled: boolean;
  templateId?: number | null;
  templateName?: string;
}

export interface ChannelFollowUpSettings {
  /** Opaque per-save fencing value; schedulers ignore it. */
  revision?: string;
  enabled: boolean;
  maxFollowUps: number;
  followUps: ChannelFollowUp[];
}

export interface ChannelFollowUps {
  email?: ChannelFollowUpSettings;
  sms?: ChannelFollowUpSettings;
  instagram?: ChannelFollowUpSettings;
  facebook?: ChannelFollowUpSettings;
  whatsapp?: ChannelFollowUpSettings;
}

export const outreachSettings = pgTable("outreach_settings", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  emailProvider: text("email_provider").default("gmail"),
  senderName: text("sender_name"),
  senderEmail: text("sender_email"),
  replyToEmail: text("reply_to_email"),
  emailSignature: text("email_signature"),
  emailDesignPreferences: jsonb('email_design_preferences').$type<EmailDesignPreferences>().notNull().default({ outreach: 'classic', assistant: 'classic', revision: 'initial' }),
  enableAutoFollowUp: boolean("enable_auto_follow_up").default(true),
  followUpDelay: integer("follow_up_delay").default(3),
  followUpDelayHours: integer("follow_up_delay_hours").default(72),
  maxFollowUps: integer("max_follow_ups").default(3),
  followUpSteps: jsonb("follow_up_steps").$type<FollowUpStep[]>().default([]),
  channelFollowUps: jsonb("channel_follow_ups").$type<ChannelFollowUps>().default({}),
  enableTracking: boolean("enable_tracking").default(true),
  personalizeMessages: boolean("personalize_messages").default(true),
  sendTimeOptimization: boolean("send_time_optimization").default(true),
  dailyEmailLimit: integer("daily_email_limit").default(200),
  autoTicketDedupWindowMinutes: integer("auto_ticket_dedup_window_minutes").default(30),
  blockOnZeroCredit: boolean("block_on_zero_credit").default(false),
  slackWebhookUrl: text("slack_webhook_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [uniqueIndex("outreach_settings_user_id_unique").on(table.businessProfileId, table.userId)]);

export type OutreachSettings = typeof outreachSettings.$inferSelect;
export type NewOutreachSettings = typeof outreachSettings.$inferInsert;
