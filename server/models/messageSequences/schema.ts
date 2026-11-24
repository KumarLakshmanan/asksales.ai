import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Message Sequences Schema
 * Stores multi-step outreach sequence definitions
 */

import { pgTable, serial, integer, varchar, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

export const messageSequencesTable = pgTable('message_sequences', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  campaignId: integer('campaign_id'),
  
  // Sequence metadata
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  channel: varchar('channel', { length: 20 }).notNull(), // 'email', 'linkedin', 'instagram', 'twitter', 'whatsapp'
  
  // Sequence steps - array of step definitions
  steps: jsonb('steps').notNull().$type<Array<{
    stepNumber: number;
    delayDays: number;
    delayHours: number;
    messageType: 'template' | 'dynamic';
    template?: string;
    promptInstructions?: string;
    condition?: 'no_reply' | 'opened_no_reply' | 'clicked_no_reply' | 'always';
  }>>(),
  
  // Behavior settings
  pauseOnReply: boolean('pause_on_reply').notNull().default(true),
  pauseOnClick: boolean('pause_on_click').notNull().default(false),
  
  // Status
  isActive: boolean('is_active').notNull().default(true),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type MessageSequenceRecord = typeof messageSequencesTable.$inferSelect;
export type InsertMessageSequence = typeof messageSequencesTable.$inferInsert;
