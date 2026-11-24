import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, numeric } from "drizzle-orm/pg-core";

export const embeddingUsagesTable = pgTable("embedding_usages", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  provider: varchar("provider", { length: 50 }).notNull().default("openai"),
  model: varchar("model", { length: 100 }).notNull(),
  purpose: varchar("purpose", { length: 100 }).notNull().default("embedding"),
  service: varchar("service", { length: 100 }).notNull().default("EmbeddingService"),
  action: varchar("action", { length: 255 }),
  inputTokens: integer("input_tokens"),
  totalTokens: integer("total_tokens"),
  estimatedCostCents: numeric("estimated_cost_cents", { precision: 20, scale: 8, mode: 'number' }).default(0),
  originalCostCents: numeric("original_cost_cents", { precision: 20, scale: 8, mode: 'number' }).default(0),
  dimensions: integer("dimensions"),
  textsCount: integer("texts_count").default(1),
  responseSuccess: integer("response_success").notNull().default(1),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type EmbeddingUsage = typeof embeddingUsagesTable.$inferSelect;
export type InsertEmbeddingUsage = typeof embeddingUsagesTable.$inferInsert;
