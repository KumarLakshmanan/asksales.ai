import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, integer, jsonb, serial, varchar, timestamp, index } from "drizzle-orm/pg-core";

export const leadGenCampaignsTable = pgTable("lead_gen_campaigns", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  leadsFound: integer("leads_found").default(0).notNull(),
  enriched: integer("enriched").default(0).notNull(),
  outreached: integer("outreached").default(0).notNull(),
  icpData: jsonb("icp_data"),
  strategyData: jsonb("strategy_data"),
  channels: jsonb("channels"),
  leads: jsonb("leads"),
  sentMessages: jsonb("sent_messages"),
}, (table) => ({
  statusIdx: index("lead_gen_campaigns_status_idx").on(table.status),
  createdAtIdx: index("lead_gen_campaigns_created_at_idx").on(table.createdAt),
}));

export type LeadGenCampaignRecord = typeof leadGenCampaignsTable.$inferSelect;
export type InsertLeadGenCampaign = typeof leadGenCampaignsTable.$inferInsert;
