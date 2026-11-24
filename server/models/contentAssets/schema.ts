import { pgTable, text, timestamp, jsonb, serial, varchar, index, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "../users/schema";
import { brandToolkitsTable } from "../brandToolkits/schema";
import { companySettings } from "../companySettings/schema";

export const contentAssetsTable = pgTable("content_assets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),  // The user who created the asset
  threadId: integer("thread_id"),  // The chat thread where the asset was created (nullable for standalone creations)
  parentAssetId: integer("parent_asset_id"),  // Parent content asset (e.g., image linked to a social post)
  businessProfileId: integer("business_profile_id").references(() => companySettings.id, { onDelete: "set null" }),
  brandToolkitId: integer("brand_toolkit_id").references(() => brandToolkitsTable.id, { onDelete: "set null" }),
  sourceTemplateId: integer("source_template_id"),
  sourceTemplateVersion: integer("source_template_version"),
  type: varchar("type", { length: 50 }).notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  channel: varchar("channel", { length: 50 }).notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  imageUrl: text("image_url"),  // URL for image content (legacy single image)
  videoUrl: text("video_url"),  // URL for video content (legacy single video)
  imageUrls: jsonb("image_urls").$type<string[]>(),  // Array of image URLs for multi-media support
  videoUrls: jsonb("video_urls").$type<string[]>(),  // Array of video URLs for multi-media support
  performance: jsonb("performance"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  brandContextSnapshot: jsonb("brand_context_snapshot").$type<Record<string, unknown>>().default({}).notNull(),
  validationSnapshot: jsonb("validation_snapshot").$type<Record<string, unknown>>(),
  approvalStatus: varchar("approval_status", { length: 24 }).default("draft").notNull(),
  approvedBy: integer("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  version: integer("version").default(1).notNull(),
  // Publishing tracking fields
  publishedPostId: text("published_post_id"),       // External platform post ID (e.g. Instagram media ID)
  publishedAt: timestamp("published_at"),            // When the post was successfully published
  publishedUrl: text("published_url"),               // Direct URL to the live post
  publishPlatform: varchar("publish_platform", { length: 50 }),  // 'facebook' | 'instagram' | 'youtube'
  scheduledPublishAt: timestamp("scheduled_publish_at"),  // When a scheduled post should go live
  retryCount: integer("retry_count").default(0).notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("content_assets_status_idx").on(table.status),
  typeIdx: index("content_assets_type_idx").on(table.type),
  channelIdx: index("content_assets_channel_idx").on(table.channel),
  userIdx: index("content_assets_user_idx").on(table.userId),
  threadIdx: index("content_assets_thread_idx").on(table.threadId),
  parentAssetIdx: index("content_assets_parent_asset_idx").on(table.parentAssetId),
  userUpdatedIdx: index("content_assets_user_updated_idx").on(table.userId, table.updatedAt.desc()),
  userTypeUpdatedIdx: index("content_assets_user_type_updated_idx").on(table.userId, table.type, table.updatedAt.desc()),
  userThreadUpdatedIdx: index("content_assets_user_thread_updated_idx")
    .on(table.userId, table.threadId, table.updatedAt.desc())
    .where(sql`${table.threadId} IS NOT NULL`),
}));

export type ContentAssetRecord = typeof contentAssetsTable.$inferSelect;
export type InsertContentAsset = typeof contentAssetsTable.$inferInsert;
