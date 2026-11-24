import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Conversation Threads Schema
 * Tracks message history and conversation state across channels
 */

 
import { pgTable, serial, integer, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const conversationThreadsTable = pgTable('conversation_threads', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull(), // FK to leads
  userId: integer('user_id').notNull(),
  
  // Channel info
  channel: varchar('channel', { length: 20 }).notNull(), // 'email', 'linkedin', 'instagram', 'twitter', 'whatsapp'
  platformThreadId: varchar('platform_thread_id', { length: 255 }), // External thread/conversation ID
  
  // Conversation state
  lastMessageAt: timestamp('last_message_at').notNull().defaultNow(),
  messageCount: integer('message_count').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('active'), // 'active', 'archived', 'spam', 'unsubscribed'
  
  // Metadata
  metadata: jsonb('metadata').$type<{
    lastMessageDirection?: 'inbound' | 'outbound';
    unreadCount?: number;
    tags?: string[];
    sentiment?: 'positive' | 'neutral' | 'negative';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customData?: Record<string, any>;
  }>(),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type ConversationThreadRecord = typeof conversationThreadsTable.$inferSelect;
export type InsertConversationThread = typeof conversationThreadsTable.$inferInsert;
