import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Channel Credentials Schema
 * Securely stores OAuth tokens and session data for outreach channels
 */

import { pgTable, serial, integer, varchar, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

export const channelCredentialsTable = pgTable('channel_credentials', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  
  // Platform identification
  platform: varchar('platform', { length: 50 }).notNull(), // 'linkedin', 'instagram', 'twitter', 'facebook', 'whatsapp'
  credentialType: varchar('credential_type', { length: 50 }).notNull(), // 'oauth', 'session', 'api_key'
  
  // OAuth tokens (encrypted)
  accessToken: text('access_token'), // AES-256-GCM encrypted
  refreshToken: text('refresh_token'), // AES-256-GCM encrypted
  tokenExpiry: timestamp('token_expiry'),
  
  // Session data (encrypted)
  sessionCookies: text('session_cookies'), // Encrypted cookie string
  sessionData: jsonb('session_data'), // Additional session metadata
  
  // API keys (encrypted)
  apiKey: text('api_key'), // For platforms using API keys
  apiSecret: text('api_secret'), // For platforms requiring secrets
  
  // Account info
  accountIdentifier: varchar('account_identifier', { length: 255 }), // Platform user ID or username
  accountName: varchar('account_name', { length: 255 }), // Display name
  
  // Status
  isActive: boolean('is_active').notNull().default(true),
  // Exactly one credential may be selected for a user/platform.  Keeping this
  // separate from `isActive` lets an OAuth reconnect add an account without
  // taking the previously authorized account offline.
  isSelected: boolean('is_selected').notNull().default(false),
  deactivationReason: text('deactivation_reason'), // Reason for deactivation (e.g., 'quota_exceeded', 'rate_limit')
  deactivatedAt: timestamp('deactivated_at'), // When the credential was deactivated
  lastUsedAt: timestamp('last_used_at'),
  lastRefreshedAt: timestamp('last_refreshed_at'),

  // Envelope-encryption migration metadata. Secret-bearing rows with no
  // version are legacy and must be rotated before production use.
  encryptionVersion: varchar('encryption_version', { length: 32 }),
  encryptionKeyId: varchar('encryption_key_id', { length: 255 }),
  encryptedAt: timestamp('encrypted_at'),

  // Non-secret official-provider readiness metadata. These fields are
  // intentionally separate from sessionData so readiness checks never need to
  // read or serialize a token-bearing JSON object.
  grantedScopes: jsonb('granted_scopes').$type<string[]>().notNull().default([]),
  providerApprovalStatus: varchar('provider_approval_status', { length: 24 }).notNull().default('unknown'),
  providerApiVersion: varchar('provider_api_version', { length: 32 }),
  providerVerifiedAt: timestamp('provider_verified_at'),
  lastReadinessCheckAt: timestamp('last_readiness_check_at'),
  readinessErrorCode: varchar('readiness_error_code', { length: 64 }),

  // SHA-256 only: compatibility binding for provider callbacks that still use
  // a previously issued per-tenant URL token. The bearer token is never stored.
  legacyWebhookTokenHash: varchar('legacy_webhook_token_hash', { length: 64 }),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type ChannelCredentialRecord = typeof channelCredentialsTable.$inferSelect;
export type InsertChannelCredential = typeof channelCredentialsTable.$inferInsert;
