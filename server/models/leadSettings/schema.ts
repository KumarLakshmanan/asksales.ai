import { businessProfileColumn } from "../businessProfileColumn.js";
import { uniqueIndex, pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const leadSettings = pgTable("lead_settings", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  minLeadScore: integer("min_lead_score").default(70),
  autoQualify: boolean("auto_qualify").default(false),
  enableDuplicateCheck: boolean("enable_duplicate_check").default(true),
  autoEnrich: boolean("auto_enrich").default(false),
  leadSources: text("lead_sources").array().default(["linkedin", "google", "justdial", "instagram", "facebook", "twitter"]),
  maxLeadsPerDay: integer("max_leads_per_day").default(500),
  notifyOnHighScore: boolean("notify_on_high_score").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [uniqueIndex("lead_settings_user_id_unique").on(table.businessProfileId, table.userId)]);

export type LeadSettings = typeof leadSettings.$inferSelect;
export type NewLeadSettings = typeof leadSettings.$inferInsert;
