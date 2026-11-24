/**
 * API Pricing Schema
 * Admin-configurable pricing for all API services:
 * - LLM models (per 1M tokens)
 * - Image/Video generation (fixed credits per unit)
 * - Apify (margin % on actual run cost)
 * - ZeroBounce (fixed credits per email)
 */

 
import { pgTable, serial, varchar, decimal, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const apiPricingTable = pgTable("api_pricing", {
  id: serial("id").primaryKey(),
  category: varchar("category", { length: 50 }).notNull(),
  pricingKey: varchar("pricing_key", { length: 150 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 50 }),
  promptCostPerMillion: decimal("prompt_cost_per_million", { precision: 12, scale: 6 }).default("0"),
  completionCostPerMillion: decimal("completion_cost_per_million", { precision: 12, scale: 6 }).default("0"),
  creditsPerUnit: decimal("credits_per_unit", { precision: 10, scale: 2 }).default("0"),
  marginPercentage: decimal("margin_percentage", { precision: 5, scale: 2 }).default("0"),
  // Original API provider costs (what we pay) — for revenue tracking
  originalPromptCostPerMillion: decimal("original_prompt_cost_per_million", { precision: 12, scale: 6 }).default("0"),
  originalCompletionCostPerMillion: decimal("original_completion_cost_per_million", { precision: 12, scale: 6 }).default("0"),
  originalCreditsPerUnit: decimal("original_credits_per_unit", { precision: 10, scale: 2 }).default("0"),
  unitLabel: varchar("unit_label", { length: 100 }),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ApiPricingRecord = typeof apiPricingTable.$inferSelect;
export type InsertApiPricing = typeof apiPricingTable.$inferInsert;
