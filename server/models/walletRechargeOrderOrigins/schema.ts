import { decimal, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema.js';
import { adminApiCredentialsTable } from '../adminApiCredentials/schema.js';

/** Immutable server-owned checkout origin. Contains no copied credential secret. */
export const walletRechargeOrderOriginsTable = pgTable('wallet_recharge_order_origins', {
  orderId: text('order_id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'restrict' }),
  organizationId: integer('organization_id').notNull(),
  credentialSource: text('credential_source').notNull(),
  credentialId: integer('credential_id').references(() => adminApiCredentialsTable.id, { onDelete: 'restrict' }),
  keyId: text('key_id').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  currency: text('currency').notNull(),
  credits: decimal('credits', { precision: 20, scale: 2 }).notNull(),
  rechargeRate: decimal('recharge_rate').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
