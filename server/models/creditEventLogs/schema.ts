import { sql } from 'drizzle-orm';
import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Credit Event Logs Schema  
 * Detailed log of every credit-consuming event
 */

import { pgTable, serial, integer, decimal, varchar, text, timestamp, jsonb, numeric } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const creditEventLogsTable = pgTable("credit_event_logs", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().default(sql`NULL`),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  
  // Event identification (matches credit_pricing.event_key)
  eventKey: varchar("event_key", { length: 100 }).notNull(),
  
  // Credits deducted
  creditsUsed: decimal("credits_used", { precision: 10, scale: 2 }).notNull(),
  
  // Balance after deduction
  balanceAfter: decimal("balance_after", { precision: 12, scale: 2 }).notNull(),
  
  // Description
  description: text("description"),
  
  // Service that triggered this event
  service: varchar("service", { length: 100 }),
  
  // Reference (what entity was created/used)
  referenceType: varchar("reference_type", { length: 100 }),
  referenceId: varchar("reference_id", { length: 255 }),
  
  // For API usage events - track the actual cost
  apiProvider: varchar("api_provider", { length: 50 }), // 'openai', 'apify', 'gemini', 'zerobounce'
  apiCostCents: numeric("api_cost_cents", { precision: 20, scale: 8, mode: 'number' }), // Fractional cents retained
  
  // Ledger row this event belongs to: the deduction for a charge, or the refund
  // for a reversal row (negative creditsUsed). Unique when set.
  walletTransactionId: integer("wallet_transaction_id"),

  // Extra context
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CreditEventLogRecord = typeof creditEventLogsTable.$inferSelect;
export type InsertCreditEventLog = typeof creditEventLogsTable.$inferInsert;
