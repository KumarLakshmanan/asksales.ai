import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Resend Domains Schema
 * Stores custom email domains registered via Resend API
 */

 
import { pgTable, serial, integer, varchar, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

export const resendDomainsTable = pgTable('resend_domains', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  resendDomainId: varchar('resend_domain_id', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('not_started'),
  region: varchar('region', { length: 50 }).default('us-east-1'),
  dnsRecords: jsonb('dns_records').default([]),
  openTracking: boolean('open_tracking').default(false),
  clickTracking: boolean('click_tracking').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type ResendDomainRecord = typeof resendDomainsTable.$inferSelect;
export type InsertResendDomain = typeof resendDomainsTable.$inferInsert;
