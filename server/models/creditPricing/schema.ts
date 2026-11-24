/**
 * Credit Pricing Schema
 * Admin-controlled credit pricing configuration
 * Defines how many credits per rupee and credits for each event/action
 */

import { pgTable, serial, varchar, text, decimal, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const creditPricingTable = pgTable("credit_pricing", {
  id: serial("id").primaryKey(),
  
  // Unique key for this pricing config
  // e.g., 'recharge_rate', 'lead_generation', 'content_email', 'content_image', 
  // 'content_video', 'content_sms', 'content_social_post', 'outreach_email',
  // 'outreach_sms', 'outreach_whatsapp', 'outreach_instagram',
  // 'api_openai', 'api_apify', 'api_gemini', 'api_zerobounce'
  eventKey: varchar("event_key", { length: 100 }).notNull().unique(),
  
  // Human-readable name
  name: varchar("name", { length: 255 }).notNull(),
  
  // Description
  description: text("description"),
  
  // Category for grouping in UI
  // 'recharge', 'lead', 'content', 'outreach', 'api_usage', 'marketing'
  category: varchar("category", { length: 50 }).notNull(),
  
  // Credits cost for this event
  // For 'recharge_rate': this is credits per 1 INR (e.g., 10 means 10 credits per ₹1)
  // For events: this is the cost in credits (e.g., 5 means 5 credits deducted per use)
  creditsPerUnit: decimal("credits_per_unit", { precision: 10, scale: 2 }).notNull().default("1"),
  
  // Unit label (e.g., 'per lead', 'per message', 'per image', 'per 1000 tokens', 'per INR')
  unitLabel: varchar("unit_label", { length: 100 }),
  
  // Whether this pricing is active
  isActive: boolean("is_active").notNull().default(true),
  
  // Sort order for display
  sortOrder: integer("sort_order").default(0),
  
  // Extra config
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CreditPricingRecord = typeof creditPricingTable.$inferSelect;
export type InsertCreditPricing = typeof creditPricingTable.$inferInsert;
