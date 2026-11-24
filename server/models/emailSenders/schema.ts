import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Email Senders Schema
 * Unified table for multiple email sending accounts per user (Resend domains, Gmail OAuth)
 */

import { pgTable, serial, integer, varchar, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const emailSendersTable = pgTable('email_senders', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  type: varchar('type', { length: 20 }).notNull(), // 'resend' | 'gmail'
  label: varchar('label', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  isDefault: boolean('is_default').notNull().default(false),
  isVerified: boolean('is_verified').notNull().default(false),
  resendDomainId: integer('resend_domain_id'), // FK to resend_domains.id
  credentialId: integer('credential_id'), // FK to channel_credentials.id
  config: jsonb('config').default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type EmailSenderRecord = typeof emailSendersTable.$inferSelect;
export type InsertEmailSender = typeof emailSendersTable.$inferInsert;
