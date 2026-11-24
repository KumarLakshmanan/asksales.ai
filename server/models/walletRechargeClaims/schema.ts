import { sql } from 'drizzle-orm';
import { decimal, index, integer, pgTable, serial, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { walletTransactionsTable } from '../walletTransactions/schema';

/** Immutable idempotency ledger for externally captured wallet payments. */
export const walletRechargeClaimsTable = pgTable('wallet_recharge_claims', {
  id: serial('id').primaryKey(),
  organizationId: integer("organization_id").notNull().default(sql`NULL`),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  paymentProvider: varchar('payment_provider', { length: 50 }).notNull().default('razorpay'),
  paymentId: varchar('payment_id', { length: 255 }).notNull(),
  paymentOrderId: varchar('payment_order_id', { length: 255 }).notNull(),
  amountPaid: decimal('amount_paid', { precision: 12, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull(),
  rechargeRate: decimal('recharge_rate', { precision: 12, scale: 4 }).notNull(),
  creditsAdded: decimal('credits_added', { precision: 12, scale: 2 }).notNull(),
  transactionId: integer('transaction_id').references(() => walletTransactionsTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  paymentIdUnique: uniqueIndex('wallet_recharge_claims_payment_id_uq').on(table.paymentProvider, table.paymentId),
  orderIdUnique: uniqueIndex('wallet_recharge_claims_order_id_uq').on(table.paymentProvider, table.paymentOrderId),
  userCreatedIdx: index('wallet_recharge_claims_user_created_idx').on(table.userId, table.createdAt),
}));

