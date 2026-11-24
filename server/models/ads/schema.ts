import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, integer, timestamp, serial, varchar, decimal, index } from "drizzle-orm/pg-core";
import { campaignsTable } from "../campaigns/schema";

export const adsTable = pgTable("ads", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").references(() => campaignsTable.id).notNull(),
  platform: varchar("platform", { length: 50 }).notNull(), // 'google', 'meta', 'linkedin', 'twitter'
  adName: text("ad_name").notNull(),
  status: varchar("status", { length: 50 }).notNull(), // 'active', 'paused', 'completed', 'draft'
  impressions: integer("impressions").default(0).notNull(),
  clicks: integer("clicks").default(0).notNull(),
  conversions: integer("conversions").default(0).notNull(),
  spend: decimal("spend", { precision: 10, scale: 2 }).default("0").notNull(),
  ctr: decimal("ctr", { precision: 5, scale: 2 }).default("0").notNull(), // click-through rate
  cpc: decimal("cpc", { precision: 10, scale: 2 }).default("0").notNull(), // cost per click
  creativeUrl: text("creative_url"),
  targeting: text("targeting"), // JSON string for targeting criteria
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  campaignIdIdx: index("ads_campaign_id_idx").on(table.campaignId),
  platformIdx: index("ads_platform_idx").on(table.platform),
  statusIdx: index("ads_status_idx").on(table.status),
}));

export type AdRecord = typeof adsTable.$inferSelect;
export type InsertAd = typeof adsTable.$inferInsert;
