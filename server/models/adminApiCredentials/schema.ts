/**
 * Admin API Credentials Schema
 * Stores system-wide API credentials managed by admin
 * These are used across all users for:
 * - LLM services (OpenAI, OpenRouter, Gemini)
 * - Scraping (Apify)
 * - Email validation (ZeroBounce)
 * - System emails (SMTP for OTP, notifications)
 */

import { index, integer, pgTable, serial, varchar, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';
import { adminsTable } from '../admins/schema.js';

export const adminApiCredentialsTable = pgTable('admin_api_credentials', {
  id: serial('id').primaryKey(),
  
  // Platform identification
  platform: varchar('platform', { length: 50 }).notNull(), // 'openai', 'openrouter', 'apify', 'gemini', 'zerobounce', 'smtp'
  
  // Human-readable name for this credential
  name: varchar('name', { length: 255 }).notNull(),
  
  // Credentials
  apiKey: text('api_key').notNull(),
  apiSecret: text('api_secret'), // For SMTP password, etc.
  isEncrypted: boolean('is_encrypted').notNull().default(false),
  
  // Status and priority
  isActive: boolean('is_active').notNull().default(true),
  priority: varchar('priority', { length: 20 }).notNull().default('normal'), // 'high', 'normal', 'low', 'fallback'
  
  // Configuration (model, host, port, etc.)
  config: jsonb('config').$type<{
    model?: string;
    host?: string;
    port?: number;
    secure?: boolean;
    fromEmail?: string;
    fromName?: string;
    maxRequestsPerMinute?: number;
    maxRequestsPerDay?: number;
    [key: string]: unknown;
  }>().default({}),
  
  // Usage tracking
  lastUsedAt: timestamp('last_used_at'),
  usageCount: varchar('usage_count', { length: 50 }).default('0'),
  
  // Deactivation reason (rate_limit, quota_exceeded, invalid_key, manual)
  deactivationReason: varchar('deactivation_reason', { length: 100 }),
  deactivatedAt: timestamp('deactivated_at'),
  lastValidatedAt: timestamp('last_validated_at'),
  validationStatus: varchar('validation_status', { length: 20 }),
  validationMessage: text('validation_message'),
  rotatedAt: timestamp('rotated_at'),
  rotatedBy: integer('rotated_by').references(() => adminsTable.id, { onDelete: 'set null' }),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const adminCredentialAuditTable = pgTable('admin_credential_audit', {
  id: serial('id').primaryKey(),
  // Keep the historical credential ID after the credential is deleted. This
  // deliberately is not a foreign key: ON DELETE SET NULL would update an
  // append-only audit row and be rejected by the audit immutability trigger.
  credentialId: integer('credential_id'),
  platform: varchar('platform', { length: 50 }).notNull(),
  action: varchar('action', { length: 20 }).notNull(),
  adminId: integer('admin_id').references(() => adminsTable.id, { onDelete: 'set null' }),
  changedFields: jsonb('changed_fields').$type<string[]>().notNull().default([]),
  validationStatus: varchar('validation_status', { length: 20 }),
  message: text('message'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  credentialIdx: index('admin_credential_audit_credential_idx').on(table.credentialId, table.createdAt),
  platformIdx: index('admin_credential_audit_platform_idx').on(table.platform, table.createdAt),
  adminIdx: index('admin_credential_audit_admin_idx').on(table.adminId),
}));

export type AdminApiCredentialRecord = typeof adminApiCredentialsTable.$inferSelect;
export type InsertAdminApiCredential = typeof adminApiCredentialsTable.$inferInsert;
