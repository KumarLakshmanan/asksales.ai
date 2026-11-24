import { sql } from 'drizzle-orm';
/**
 * Wallets Schema
 * User wallet with credit balance for the billing system
 */

import { pgTable, serial, integer, decimal, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const walletsTable = pgTable("wallets", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().unique().default(sql`NULL`),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  
  // Credit balance (stored as decimal for precision)
  balance: decimal("balance", { precision: 12, scale: 2 }).notNull().default("0"),
  
  // Lifetime stats
  totalCreditsAdded: decimal("total_credits_added", { precision: 12, scale: 2 }).notNull().default("0"),
  totalCreditsUsed: decimal("total_credits_used", { precision: 12, scale: 2 }).notNull().default("0"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type WalletRecord = typeof walletsTable.$inferSelect;
export type InsertWallet = typeof walletsTable.$inferInsert;
