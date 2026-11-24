import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Storage Files Schema
 * Metadata for every uploaded file in the system
 */

import { pgTable, serial, integer, varchar, text, bigint, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const storageFilesTable = pgTable("storage_files", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  originalName: varchar("original_name", { length: 500 }),
  storageKey: varchar("storage_key", { length: 1000 }).notNull(),
  storageBackend: varchar("storage_backend", { length: 20 }).notNull().default("local"),
  mimeType: varchar("mime_type", { length: 200 }),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull().default(0),
  category: varchar("category", { length: 100 }).notNull().default("general"),
  referenceType: varchar("reference_type", { length: 100 }),
  referenceId: varchar("reference_id", { length: 255 }),
  url: text("url"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  userIdx: index("storage_files_user_idx").on(table.userId),
  categoryIdx: index("storage_files_category_idx").on(table.category),
  storageKeyIdx: index("storage_files_storage_key_idx").on(table.storageKey),
  referenceIdx: index("storage_files_reference_idx").on(table.referenceType, table.referenceId),
}));

export type StorageFileRecord = typeof storageFilesTable.$inferSelect;
export type InsertStorageFile = typeof storageFilesTable.$inferInsert;
