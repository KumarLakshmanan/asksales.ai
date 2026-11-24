/**
 * WhatsApp platform billing tables (migration 595).
 * See docs/WHATSAPP_PLATFORM_BILLING_PLAN.md and services/whatsapp/WhatsAppBillingService.ts.
 */
import { businessProfileColumn } from '../businessProfileColumn.js';
import { pgTable, serial, bigserial, integer, varchar, char, numeric, date, text, boolean, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Country calling code -> Meta rate-card market (for example '91' -> 'India'). */
export const whatsappRateMarketsTable = pgTable('whatsapp_rate_markets', {
  callingCode: varchar('calling_code', { length: 8 }).primaryKey(),
  market: varchar('market', { length: 80 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Meta's list rate per market and category, one version per effective date. */
export const whatsappRateCardsTable = pgTable('whatsapp_rate_cards', {
  id: serial('id').primaryKey(),
  market: varchar('market', { length: 80 }).notNull(),
  category: varchar('category', { length: 24 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  rate: numeric('rate', { precision: 14, scale: 6 }).notNull(),
  effectiveFrom: date('effective_from').notNull(),
  source: varchar('source', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** WABAs whose Meta spend is billed to our credit line. */
export const whatsappBillingAccountsTable = pgTable('whatsapp_billing_accounts', {
  wabaId: varchar('waba_id', { length: 64 }).primaryKey(),
  billingMode: varchar('billing_mode', { length: 16 }).notNull().default('customer_own'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  dailySpendCapCredits: numeric('daily_spend_cap_credits', { precision: 12, scale: 2 }),
  allocationConfigId: varchar('allocation_config_id', { length: 64 }),
  creditLineStatus: varchar('credit_line_status', { length: 16 }).notNull().default('none'),
  creditLineError: text('credit_line_error'),
  attachedAt: timestamp('attached_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** Set when Meta refused a message for a payment problem (migration 599). */
  paymentIssueAt: timestamp('payment_issue_at', { withTimezone: true }),
  paymentIssueDetail: text('payment_issue_detail'),
  userId: integer('user_id'),
  businessProfileId: integer('business_profile_id'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Meta's reported cost per WABA, day and category, beside our ledger's total. */
export const whatsappBillingReconciliationTable = pgTable('whatsapp_billing_reconciliation', {
  id: serial('id').primaryKey(),
  wabaId: varchar('waba_id', { length: 64 }).notNull(),
  day: date('day').notNull(),
  category: varchar('category', { length: 40 }).notNull(),
  metaVolume: integer('meta_volume').notNull().default(0),
  metaCost: numeric('meta_cost', { precision: 14, scale: 6 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  ledgerVolume: integer('ledger_volume').notNull().default(0),
  ledgerCost: numeric('ledger_cost', { precision: 14, scale: 6 }).notNull().default('0'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per message sent on a platform-billed WABA. */
export const whatsappMessageChargesTable = pgTable('whatsapp_message_charges', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull(),
  businessProfileId: businessProfileColumn(),
  wabaId: varchar('waba_id', { length: 64 }).notNull(),
  phoneNumberId: varchar('phone_number_id', { length: 64 }).notNull(),
  wamid: varchar('wamid', { length: 255 }),
  messageKind: varchar('message_kind', { length: 16 }).notNull(),
  templateName: varchar('template_name', { length: 512 }),
  templateLanguage: varchar('template_language', { length: 20 }),
  expectedCategory: varchar('expected_category', { length: 24 }).notNull(),
  recipientMarket: varchar('recipient_market', { length: 80 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  reservedRate: numeric('reserved_rate', { precision: 14, scale: 6 }).notNull(),
  reservedCredits: numeric('reserved_credits', { precision: 12, scale: 2 }).notNull(),
  reservationTransactionId: integer('reservation_transaction_id'),
  status: varchar('status', { length: 16 }).notNull().default('reserved'),
  metaBillable: boolean('meta_billable'),
  metaCategory: varchar('meta_category', { length: 40 }),
  metaPricingType: varchar('meta_pricing_type', { length: 40 }),
  settledRate: numeric('settled_rate', { precision: 14, scale: 6 }),
  chargedCredits: numeric('charged_credits', { precision: 12, scale: 2 }),
  topupTransactionId: integer('topup_transaction_id'),
  pricingRaw: jsonb('pricing_raw'),
  reviewReason: text('review_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  /** The outreach batch this message belongs to, filled at settlement (migration 600). */
  outreachBatchId: uuid('outreach_batch_id'),
});
