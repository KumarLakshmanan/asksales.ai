/**
 * System Integrations Schema
 * Stores system-wide integration configurations (admin-controlled)
 */

import { pgTable, serial, varchar, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

/**
 * System Integrations Table
 * Each row represents a configured integration available in the system
 */
export const systemIntegrationsTable = pgTable('system_integrations', {
  id: serial('id').primaryKey(),
  
  // Integration identification
  integrationId: varchar('integration_id', { length: 100 }).notNull().unique(), // e.g., 'email_gmail', 'instagram_official'
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  
  // Categorization
  category: varchar('category', { length: 50 }).notNull(), // 'email', 'social', 'messaging', 'automation'
  type: varchar('type', { length: 50 }).notNull(), // 'official', 'automation'
  
  // Status
  status: varchar('status', { length: 50 }).notNull().default('available'), // 'available', 'beta', 'coming_soon', 'maintenance', 'disabled'
  isEnabled: boolean('is_enabled').notNull().default(true),
  
  // Configuration
  features: jsonb('features').$type<string[]>().default([]),
  configSchema: jsonb('config_schema'), // JSON Schema for configuration options
  defaultConfig: jsonb('default_config'), // Default configuration values
  
  // OAuth/API settings (for official integrations)
  oauthSettings: jsonb('oauth_settings').$type<{
    clientIdEnvVar?: string;
    clientSecretEnvVar?: string;
    scopes?: string[];
    authUrl?: string;
    tokenUrl?: string;
    webhookSupported?: boolean;
  }>(),
  
  // Automation settings (for browser automation)
  automationSettings: jsonb('automation_settings').$type<{
    botUrl?: string;
    botPort?: number;
    requiresProxy?: boolean;
    sessionTimeout?: number;
  }>(),
  
  // Documentation
  documentationUrl: text('documentation_url'),
  iconName: varchar('icon_name', { length: 50 }), // Lucide icon name
  
  // Usage limits
  rateLimit: jsonb('rate_limit').$type<{
    maxRequestsPerMinute?: number;
    maxRequestsPerHour?: number;
    maxRequestsPerDay?: number;
  }>(),
  
  // Metadata
  version: varchar('version', { length: 20 }).default('1.0.0'),
  lastTestedAt: timestamp('last_tested_at'),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type SystemIntegrationRecord = typeof systemIntegrationsTable.$inferSelect;
export type InsertSystemIntegration = typeof systemIntegrationsTable.$inferInsert;
