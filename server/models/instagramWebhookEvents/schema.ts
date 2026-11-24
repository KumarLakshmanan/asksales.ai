import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Instagram Webhook Events Schema
 * Stores all webhook events from Instagram/Facebook
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { pgTable, serial, text, timestamp, integer, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const instagramWebhookEventsTable = pgTable("instagram_webhook_events", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(), // 'message', 'comment', 'like', 'follow', 'mention', 'story_insights', etc.
  pageId: text("page_id"), // Instagram/Facebook page ID
  senderId: text("sender_id"), // User who triggered the event
  recipientId: text("recipient_id"), // Recipient of the message
  messageId: text("message_id"), // Message ID for DMs
  messageText: text("message_text"), // Message content
  commentId: text("comment_id"), // Comment ID
  commentText: text("comment_text"), // Comment content
  mediaId: text("media_id"), // Media ID (post, story, etc.)
  timestamp: timestamp("timestamp"), // When the event occurred
  rawData: jsonb("raw_data"), // Full raw webhook payload
  processedAt: timestamp("processed_at").defaultNow(), // When we processed it
  isProcessed: boolean("is_processed").default(false), // Whether AI has processed this
  aiReplyGenerated: boolean("ai_reply_generated").default(false), // Whether AI reply was generated
  aiReplyText: text("ai_reply_text"), // AI-generated reply suggestion
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertInstagramWebhookEventSchema = createInsertSchema(instagramWebhookEventsTable);
export const selectInstagramWebhookEventSchema = createSelectSchema(instagramWebhookEventsTable);

export type InstagramWebhookEvent = typeof instagramWebhookEventsTable.$inferSelect;
export type NewInstagramWebhookEvent = typeof instagramWebhookEventsTable.$inferInsert;
