/**
 * Storage Plans Schema
 * Defines different storage tiers with limits and pricing
 */

import { pgTable, serial, varchar, text, bigint, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const storagePlansTable = pgTable("storage_plans", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }).notNull().default(1073741824), // 1 GB
  pricePerGbCents: integer("price_per_gb_cents").notNull().default(0),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type StoragePlanRecord = typeof storagePlansTable.$inferSelect;
export type InsertStoragePlan = typeof storagePlansTable.$inferInsert;
