import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Gemini Usage Tracking Schema
 * Tracks usage of Google Gemini API for image/video generation
 */

import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  jsonb,
  decimal,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const geminiUsagesTable = pgTable("gemini_usages", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  
  // Operation type: 'image_generation', 'video_generation', 'content_generation'
  operationType: varchar("operation_type", { length: 50 }).notNull(),
  
  // Model used (e.g., 'gemini-pro', 'gemini-pro-vision', 'imagegeneration@006')
  model: varchar("model", { length: 100 }).notNull(),
  
  // Request details
  prompt: text("prompt"),
  
  // Usage metrics
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  imagesGenerated: integer("images_generated").default(0),
  videosGenerated: integer("videos_generated").default(0),
  
  // Cost tracking (in cents)
  costCents: decimal("cost_cents", { precision: 20, scale: 8 }).default("0"),
  
  // Context info
  threadId: integer("thread_id"),
  resolution: varchar("resolution", { length: 50 }),
  service: varchar("service", { length: 100 }), // e.g., 'image_worker', 'video_worker', 'content_studio'
  purpose: varchar("purpose", { length: 100 }), // e.g., 'marketing_image', 'product_video'
  
  // Result
  status: varchar("status", { length: 20 }).default("success"), // 'success', 'error', 'partial'
  errorMessage: text("error_message"),
  
  // Additional metadata
  metadata: jsonb("metadata").default({}),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type GeminiUsage = typeof geminiUsagesTable.$inferSelect;
export type NewGeminiUsage = typeof geminiUsagesTable.$inferInsert;
