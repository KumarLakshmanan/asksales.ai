import { pgTable, serial, integer, text, boolean, timestamp, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const userPreferences = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull().unique(),
  language: text("language").default("en"),
  locale: varchar("locale", { length: 35 }).default("en-US").notNull(),
  currency: varchar("currency", { length: 3 }).default("USD").notNull(),
  theme: varchar("theme", { length: 10 }).default("system").notNull(),
  timezone: text("timezone").default("Asia/Kolkata"),
  dateFormat: text("date_format").default("MM/DD/YYYY"),
  timeFormat: text("time_format").default("12h"),
  emailNotifications: boolean("email_notifications").default(true),
  pushNotifications: boolean("push_notifications").default(false),
  darkMode: boolean("dark_mode").default(false),
  compactView: boolean("compact_view").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;
