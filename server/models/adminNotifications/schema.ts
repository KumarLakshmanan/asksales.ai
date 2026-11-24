import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { adminsTable } from "../admins/schema";

export const adminNotifications = pgTable("admin_notifications", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id").references(() => adminsTable.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: text("type").notNull().default("info"), // info, success, warning, error
  category: text("category").notNull().default("general"), // general, pricing, system
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AdminNotification = typeof adminNotifications.$inferSelect;
export type NewAdminNotification = typeof adminNotifications.$inferInsert;
