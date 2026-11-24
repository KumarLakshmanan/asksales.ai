import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Content Plans Schema
 * Content planning and generation tracking
 */

import { pgTable, serial, integer, varchar, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const contentPlansTable = pgTable('content_plans', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  workflowId: integer('workflow_id'),
  
  // Plan details
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  contentType: varchar('content_type', { length: 100 }).notNull(), // blog, social, email, ad, video
  
  // Targeting
  targetAudience: jsonb('target_audience'), // ICP/persona details
  channels: jsonb('channels'), // Array of distribution channels
  
  // Planning
  topics: jsonb('topics'), // Array of content topics
  keywords: jsonb('keywords'), // SEO keywords
  contentCalendar: jsonb('content_calendar'), // Scheduled content items
  
  // Generation settings
  tone: varchar('tone', { length: 100 }), // professional, casual, friendly, etc.
  length: varchar('length', { length: 50 }), // short, medium, long
  format: varchar('format', { length: 100 }), // article, listicle, guide, etc.
  
  // Status
  status: varchar('status', { length: 50 }).notNull().default('draft'), // draft, in_progress, completed
  
  // Generated content
  generatedContent: jsonb('generated_content'), // Array of generated content pieces
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type ContentPlanRecord = typeof contentPlansTable.$inferSelect;
export type InsertContentPlan = typeof contentPlansTable.$inferInsert;
