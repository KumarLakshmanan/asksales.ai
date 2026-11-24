import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, timestamp, serial, varchar, integer, index, boolean, jsonb, doublePrecision } from "drizzle-orm/pg-core";
import { leadsTable } from "../leads/schema";
import { usersTable } from "../users/schema";

export const sentMessagesTable = pgTable("sent_messages", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: 'cascade' }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'set null' }),
  leadName: text("lead_name").notNull(),
  channel: text("channel").notNull(),
  subject: text("subject"),
  message: text("message").notNull(),
  messageFormat: varchar("message_format", { length: 4 }),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  sentAt: timestamp("sent_at").notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  // New columns for email tracking
  messageId: varchar("message_id", { length: 255 }),
  recipientAddress: text("recipient_address"),
  rfcMessageId: text("rfc_message_id"),
  referencesHeader: text("references_header"),
  outreachMessageId: integer("outreach_message_id"),
  inboxSearchText: text("inbox_search_text"),
  gmailThreadId: varchar("gmail_thread_id", { length: 255 }),
  gmailMessageId: varchar("gmail_message_id", { length: 255 }),
  campaignId: integer("campaign_id"),
  sequenceStep: integer("sequence_step"),
  followUpStep: integer("follow_up_step"),
  followUpDispatches: jsonb("follow_up_dispatches").$type<Record<string, import('../../services/outreach/ConfiguredFollowUpDispatchService.js').ConfiguredFollowUpDispatch>>().notNull().default({}),
  isReply: boolean("is_reply").default(false),
  // Email delivery status tracking
  deliveryStatus: varchar("delivery_status", { length: 50 }).default('pending'),
  deliveredAt: timestamp("delivered_at"),
  openedAt: timestamp("opened_at"),
  openCount: integer("open_count").default(0),
  clickedAt: timestamp("clicked_at"),
  clickCount: integer("click_count").default(0),
  bouncedAt: timestamp("bounced_at"),
  bounceReason: text("bounce_reason"),
  senderId: integer("sender_id"),
  // Reply tracking
  replyReceivedAt: timestamp("reply_received_at"),
  replyMessageId: varchar("reply_message_id", { length: 255 }),
  replyContent: text("reply_content"),
  // Smart reply
  smartReply: text("smart_reply"),
  smartReplyGeneratedAt: timestamp("smart_reply_generated_at"),
  smartReplyApproved: boolean("smart_reply_approved").default(false),
  smartReplySentAt: timestamp("smart_reply_sent_at"),
  replyContext: jsonb('reply_context').$type<import('../../services/outreach/CampaignEmailReplyService.js').EmailReplyContext>(),
  // Sentiment analysis columns
  sentiment: varchar("sentiment", { length: 50 }),
  sentimentConfidence: doublePrecision("sentiment_confidence"),
  sentimentAnalysis: jsonb("sentiment_analysis"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
}, (table) => ({
  leadIdIdx: index("sent_messages_lead_id_idx").on(table.leadId),
  userIdIdx: index("sent_messages_user_id_idx").on(table.userId),
  statusIdx: index("sent_messages_status_idx").on(table.status),
  sentAtIdx: index("sent_messages_sent_at_idx").on(table.sentAt),
  channelIdx: index("sent_messages_channel_idx").on(table.channel),
  isReplyIdx: index("sent_messages_is_reply_idx").on(table.isReply),
  followUpStepIdx: index("sent_messages_follow_up_step_idx").on(table.followUpStep),
  sentimentIdx: index("sent_messages_sentiment_idx").on(table.sentiment),
  deliveryStatusIdx: index("sent_messages_delivery_status_idx").on(table.deliveryStatus),
  gmailThreadIdIdx: index("sent_messages_gmail_thread_id_idx").on(table.gmailThreadId),
  senderIdIdx: index("sent_messages_sender_id_idx").on(table.senderId),
}));

export type SentMessageRecord = typeof sentMessagesTable.$inferSelect;
export type InsertSentMessage = typeof sentMessagesTable.$inferInsert;
