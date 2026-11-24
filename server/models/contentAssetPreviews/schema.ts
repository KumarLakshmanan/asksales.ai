import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, timestamp, serial, varchar, integer, index } from "drizzle-orm/pg-core";
import { leadsTable } from "../leads/schema";
import { usersTable } from "../users/schema";

export const contentAssetPreviewsTable = pgTable("content_asset_previews", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  type: varchar("type", { length: 50 }).notNull(),
  message: text("message").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  channel: varchar("channel", { length: 50 }).notNull(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: 'cascade' }),
  leadName: text("lead_name").notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("content_asset_previews_user_id_idx").on(table.userId),
  userLeadIdx: index("content_asset_previews_user_lead_idx").on(table.userId, table.leadId),
  leadIdIdx: index("content_asset_previews_lead_id_idx").on(table.leadId),
  statusIdx: index("content_asset_previews_status_idx").on(table.status),
}));

export type ContentAssetPreviewRecord = typeof contentAssetPreviewsTable.$inferSelect;
export type InsertContentAssetPreview = typeof contentAssetPreviewsTable.$inferInsert;
