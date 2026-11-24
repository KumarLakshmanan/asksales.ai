import { sql } from 'drizzle-orm';
/**
 * Wallet Transactions Schema
 * Tracks all credit transactions - recharges, deductions, refunds
 */

import { pgTable, serial, integer, decimal, varchar, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const walletTransactionsTable = pgTable("wallet_transactions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().default(sql`NULL`),
  actorUserId: integer("actor_user_id"),
  billingBusinessProfileId: integer("billing_business_profile_id"),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  
  // Transaction type: 'recharge' | 'deduction' | 'refund' | 'bonus' | 'adjustment'
  type: varchar("type", { length: 50 }).notNull(),
  
  // Amount (positive for credit, negative for debit)
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  
  // Balance after this transaction
  balanceAfter: decimal("balance_after", { precision: 12, scale: 2 }).notNull(),
  
  // Description
  description: text("description").notNull(),
  
  // Event category: 'lead_generation' | 'content_generation' | 'outreach' | 'api_usage' | 'recharge' | 'system'
  category: varchar("category", { length: 100 }),
  
  // Reference to what triggered this (e.g., content asset ID, lead ID, etc.)
  referenceType: varchar("reference_type", { length: 100 }), // 'lead', 'content', 'outreach', 'api_call', 'razorpay_order'
  referenceId: varchar("reference_id", { length: 255 }),
  
  // For recharge transactions - payment details
  paymentProvider: varchar("payment_provider", { length: 50 }), // 'razorpay'
  paymentId: varchar("payment_id", { length: 255 }),
  paymentOrderId: varchar("payment_order_id", { length: 255 }),
  amountPaid: decimal("amount_paid", { precision: 12, scale: 2 }), // Amount in INR
  currency: varchar("currency", { length: 10 }).default("INR"),
  
  // Extra metadata
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type WalletTransactionRecord = typeof walletTransactionsTable.$inferSelect;
export type InsertWalletTransaction = typeof walletTransactionsTable.$inferInsert;
