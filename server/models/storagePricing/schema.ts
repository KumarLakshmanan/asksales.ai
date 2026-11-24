/**
 * Storage Pricing Schema
 * Admin-configurable pricing per GB of storage
 */

import { pgTable, serial, varchar, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const storagePricingTable = pgTable("storage_pricing", {
  id: serial("id").primaryKey(),
  pricingKey: varchar("pricing_key", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  pricePerGbCents: integer("price_per_gb_cents").notNull().default(0),
  currency: varchar("currency", { length: 10 }).notNull().default("USD"),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type StoragePricingRecord = typeof storagePricingTable.$inferSelect;
export type InsertStoragePricing = typeof storagePricingTable.$inferInsert;
