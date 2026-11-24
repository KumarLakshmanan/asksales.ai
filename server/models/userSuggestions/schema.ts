import { businessProfileColumn } from "../businessProfileColumn.js";
 
import { pgTable, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const userSuggestionsTable = pgTable("user_suggestions", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => usersTable.id, { onDelete: "cascade" })
    .notNull(),
  suggestions: jsonb("suggestions").$type<string[]>().notNull().default([]),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  basedOnProfile: jsonb("based_on_profile").$type<{
    companyName?: string;
    industry?: string;
    goals?: string[];
    platforms?: string[];
  }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserSuggestion = typeof userSuggestionsTable.$inferSelect;
export type NewUserSuggestion = typeof userSuggestionsTable.$inferInsert;
