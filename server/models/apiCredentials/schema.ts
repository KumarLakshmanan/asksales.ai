import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * API Credentials Schema
 * Stores API credentials for various integrations per user
 * Used by CredentialService for centralized credential management
 */

import { pgTable, serial, integer, varchar, text, timestamp, jsonb, boolean, unique } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';

export const apiCredentialsTable = pgTable('api_credentials', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  
  // Service identification
  serviceName: varchar('service_name', { length: 100 }).notNull(), // 'openai', 'apify', 'meta_ads', 'instagram', 'whatsapp', etc.
  
  // Credentials (encrypted where needed)
  apiKey: text('api_key'),
  apiSecret: text('api_secret'),
  
  // Additional config stored as JSON
  config: jsonb('config').default({}),
  
  // Status
  isActive: boolean('is_active').notNull().default(true),
  lastUsedAt: timestamp('last_used_at'),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  // Ensure unique service per user
  uniqueUserService: unique().on(table.businessProfileId, table.userId, table.serviceName),
}));

export type ApiCredentialRecord = typeof apiCredentialsTable.$inferSelect;
export type InsertApiCredential = typeof apiCredentialsTable.$inferInsert;
