import { businessProfileColumn } from "../businessProfileColumn.js";
import { uniqueIndex, pgTable, serial, integer, text, varchar, boolean, real, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const aiSettings = pgTable("ai_settings", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  aiProvider: varchar("ai_provider", { length: 50 }).default("openai"),
  aiModel: text("ai_model").default("gpt-4"),
  imageProvider: varchar("image_provider", { length: 50 }).default("google"),
  imageModel: text("image_model").default("gemini-2.5-flash-image"),
  videoProvider: varchar("video_provider", { length: 50 }).default("google"),
  videoModel: text("video_model").default("veo-3.1-fast-generate-001"),
  temperature: real("temperature").default(0.7),
  maxTokens: integer("max_tokens").default(2000),
  enableAutoResponse: boolean("enable_auto_response").default(true),
  enableLearning: boolean("enable_learning").default(true),
  responseDelay: real("response_delay").default(1),
  confidenceThreshold: real("confidence_threshold").default(0.8),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [uniqueIndex("ai_settings_user_id_unique").on(table.businessProfileId, table.userId)]);

export type AISettings = typeof aiSettings.$inferSelect;
export type NewAISettings = typeof aiSettings.$inferInsert;
