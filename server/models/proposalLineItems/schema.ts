import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, decimal, index, boolean } from 'drizzle-orm/pg-core';
import { proposalsTable } from '../proposals/schema';

export const proposalLineItemsTable = pgTable('proposal_line_items', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  proposalId: integer('proposal_id').notNull().references(() => proposalsTable.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').default(0),
  name: varchar('name', { length: 500 }).notNull(),
  catalogId: integer('catalog_id'),
  isComplimentary: boolean('is_complimentary').notNull().default(false),
  priceConfirmed: boolean('price_confirmed').notNull().default(true),
  isOptional: boolean('is_optional').notNull().default(false),
  selected: boolean('selected').notNull().default(true),
  packageId: varchar('package_id', { length: 100 }),
  billingPeriod: varchar('billing_period', { length: 20 }).notNull().default('one_time'),
  description: text('description'),
  quantity: decimal('quantity', { precision: 10, scale: 2 }).default('1'),
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).default('0'),
  unit: varchar('unit', { length: 50 }).default('unit'),
  discount: decimal('discount', { precision: 12, scale: 2 }).default('0'),
  total: decimal('total', { precision: 12, scale: 2 }).default('0'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  proposalIdIdx: index('idx_proposal_line_items_proposal_id').on(table.proposalId),
}));
