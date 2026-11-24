/**
 * Storage Quotas Schema
 * Tracks per-user storage usage and limits
 */

import { pgTable, serial, integer, bigint, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { storagePlansTable } from "../storagePlans/schema";

export const storageQuotasTable = pgTable("storage_quotas", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull().unique(),
  planId: integer("plan_id").references(() => storagePlansTable.id, { onDelete: "set null" }),
  storageUsedBytes: bigint("storage_used_bytes", { mode: "number" }).notNull().default(0),
  maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }), // Override plan limit per user
  fileCount: integer("file_count").notNull().default(0),
  lastCalculatedAt: timestamp("last_calculated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type StorageQuotaRecord = typeof storageQuotasTable.$inferSelect;
export type InsertStorageQuota = typeof storageQuotasTable.$inferInsert;
