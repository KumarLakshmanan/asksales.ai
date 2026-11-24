import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, integer, timestamp, jsonb, serial, varchar, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const campaignsTable = pgTable("campaigns", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  goal: text("goal").notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  budget: integer("budget").notNull(),
  spent: integer("spent").notNull(),
  metrics: jsonb("metrics").notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("campaigns_status_idx").on(table.status),
  startDateIdx: index("campaigns_start_date_idx").on(table.startDate),
  userIdIdx: index("campaigns_user_id_idx").on(table.userId),
}));

export type CampaignRecord = typeof campaignsTable.$inferSelect;
export type InsertCampaign = typeof campaignsTable.$inferInsert;
