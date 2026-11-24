import { normalizeCapacityError } from './billing/entitlements.js';
/**
 * Credential Service
 * 
 * Centralized service for fetching API credentials from the database.
 * All integrations should use this service instead of process.env variables.
 * 
 * Credentials are stored in the api_credentials table per user.
 */

import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { decryptValue, encryptValue } from './SecretsManager.js';
import {
  decryptSensitiveIntegrationConfig,
  encryptSensitiveIntegrationConfig,
} from '../utils/integrationSecrets.js';

const ENCRYPTED_SECRET_PATTERN = /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i;
const ENCRYPTED_SECRET_PREFIX = 'enc:v1:';

function encryptStoredSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith(ENCRYPTED_SECRET_PREFIX) || ENCRYPTED_SECRET_PATTERN.test(value)) return value;
  return `${ENCRYPTED_SECRET_PREFIX}${encryptValue(value)}`;
}

function decryptStoredSecret(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const ciphertext = value.startsWith(ENCRYPTED_SECRET_PREFIX)
    ? value.slice(ENCRYPTED_SECRET_PREFIX.length)
    : value;
  if (!ENCRYPTED_SECRET_PATTERN.test(ciphertext)) return value;
  try {
    return decryptValue(ciphertext);
  } catch (error) {
    logger.error({ err: error }, '[CredentialService] Unable to decrypt stored credential secret');
    throw new Error('Stored integration credential could not be decrypted');
  }
}

/**
 * Strict union of all known platform / integration service names that may
 * appear in `api_credentials.service_name` and `channel_credentials.platform`.
 *
 * Adding a new integration? Append the slug here so callers get compile-time
 * help and typos like "google_add" vs "google_ads" are caught at build time.
 *
 * Use `IntegrationService` for `getCredential()` / `saveCredential()` calls,
 * which read/write the `api_credentials` table.
 */
export type IntegrationService =
  // Email / messaging
  | 'gmail' | 'gmail_smtp' | 'resend' | 'sendgrid' | 'smtp'
  | 'twilio' | 'msg91'
  // LLM
  | 'openai' | 'gemini' | 'vertex_ai' | 'openrouter' | 'custom_ai'
  // Enrichment / scraping
  | 'apify' | 'clearbit' | 'zerobounce'
  // Social channels
  | 'instagram' | 'instagram_browser' | 'instagram_graph'
  | 'facebook' | 'facebook_messenger'
  | 'whatsapp' | 'whatsapp_browser'
  | 'twitter' | 'twitter_api' | 'twitter_browser'
  | 'linkedin' | 'linkedin_api' | 'linkedin_browser'
  // Ads
  | 'meta' | 'meta_ads' | 'google_ads' | 'linkedin_ads'
  // Search analytics
  | 'google_search_console'
  // Payments
  | 'razorpay' | 'stripe'
  // Content management systems
  | 'wordpress' | 'shopify';

export interface Credentials {
  openai?: {
    apiKey: string;
    model?: string;
  };
  apify?: {
    apiKey: string;
  };
  clearbit?: {
    apiKey: string;
  };
  email?: {
    provider: 'gmail_smtp' | 'sendgrid' | 'smtp';
    user?: string;
    password?: string;
    apiKey?: string;
    fromName?: string;
    fromEmail?: string;
    host?: string;
    port?: number;
  };
  instagram?: {
    username: string;
    password: string;
    sessionId?: string;
  };
  /** Meta credentials are admin-managed — not populated from per-user api_credentials */
  meta?: {
    appId: string;
    appSecret: string;
    adAccountId?: string;
    pageId?: string;
    apiVersion?: string;
  };
  twilio?: {
    accountSid: string;
    authToken: string;
    phoneNumber: string;
  };
  msg91?: {
    authKey: string;
    senderId: string;
  };
}

interface UserCredentialConfig {
  model?: string;
  user?: string;
  email?: string;
  fromName?: string;
  fromEmail?: string;
  host?: string;
  port?: number;
  username?: string;
  sessionId?: string;
  phoneNumber?: string;
  senderId?: string;
  [key: string]: unknown;
}

/**
 * Get all credentials for a user from the database
 */
export async function getUserCredentials(userId: number): Promise<Credentials> {
  try {
    const results = await db.execute(
      sql`SELECT service_name, api_key, api_secret, config, is_active 
          FROM api_credentials 
          WHERE user_id = ${userId} AND is_active = true`
    );

    const credentials: Credentials = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of results.rows as any[]) {
      const serviceName = row.service_name;
      const storedConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {};
      const config = decryptSensitiveIntegrationConfig(storedConfig) as UserCredentialConfig;
      const apiSecret = decryptStoredSecret(row.api_secret);

      switch (serviceName) {
        case 'openai':
          credentials.openai = {
            apiKey: row.api_key,
            model: config.model || 'gpt-5.2',
          };
          break;
        case 'apify':
          credentials.apify = {
            apiKey: row.api_key,
          };
          break;
        case 'clearbit':
          credentials.clearbit = {
            apiKey: row.api_key,
          };
          break;
        case 'email':
        case 'gmail_smtp':
        case 'sendgrid':
        case 'smtp':
          credentials.email = {
            provider: serviceName === 'email' ? 'smtp' : serviceName,
            user: config.user || config.email,
            password: apiSecret,
            apiKey: row.api_key,
            fromName: config.fromName,
            fromEmail: config.fromEmail,
            host: config.host,
            port: config.port,
          };
          break;
        case 'instagram':
        case 'instagram_browser':
          credentials.instagram = {
            username: config.username || '',
            password: apiSecret,
            sessionId: config.sessionId,
          };
          break;
        case 'twilio':
          credentials.twilio = {
            accountSid: row.api_key,
            authToken: apiSecret,
            phoneNumber: config.phoneNumber || '',
          };
          break;
        case 'msg91':
          credentials.msg91 = {
            authKey: row.api_key,
            senderId: config.senderId || '',
          };
          break;
      }
    }

    return credentials;
  } catch (error) {
    logger.error({ err: error }, '[CredentialService] Error fetching credentials:');
    return {};
  }
}

/**
 * Get a specific credential for a user
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getCredential(userId: number, serviceName: string): Promise<any | null> {
  try {
    const results = await db.execute(
      sql`SELECT id, api_key, api_secret, config, is_active
          FROM api_credentials 
          WHERE user_id = ${userId} AND service_name = ${serviceName} AND is_active = true
          LIMIT 1`
    );

    if (!results.rows || results.rows.length === 0) {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = results.rows[0] as any;
    const storedConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {};
    const config = decryptSensitiveIntegrationConfig(storedConfig);

    return {
      id: row.id,
      apiKey: row.api_key,
      apiSecret: decryptStoredSecret(row.api_secret),
      config,
      isActive: row.is_active,
    };
  } catch (error) {
    logger.error({ err: error }, `[CredentialService] Error fetching ${serviceName} credential:`);
    return null;
  }
}

/**
 * Check if a user has a specific credential configured
 */
export async function hasCredential(userId: number, serviceName: string): Promise<boolean> {
  try {
    const results = await db.execute(
      sql`SELECT COUNT(*) as count 
          FROM api_credentials 
          WHERE user_id = ${userId} AND service_name = ${serviceName} AND is_active = true`
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (results.rows[0] as any)?.count > 0;
  } catch (error) {
    logger.error({ err: error }, `[CredentialService] Error checking ${serviceName} credential:`);
    return false;
  }
}

/**
 * Save or update a credential
 */
export async function saveCredential(
  userId: number, 
  serviceName: string, 
  apiKey: string, 
  apiSecret?: string, 
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: Record<string, any>
): Promise<boolean> {
  try {
    const encryptedSecret = encryptStoredSecret(apiSecret);
    const encryptedConfig = encryptSensitiveIntegrationConfig(config || {});
    await db.execute(
      sql`INSERT INTO api_credentials (user_id, service_name, api_key, api_secret, config, is_active, updated_at)
          VALUES (${userId}, ${serviceName}, ${apiKey}, ${encryptedSecret}, ${JSON.stringify(encryptedConfig)}::jsonb, true, NOW())
          ON CONFLICT (business_profile_id, user_id, service_name)
          DO UPDATE SET 
            api_key = ${apiKey},
            api_secret = ${encryptedSecret},
            config = ${JSON.stringify(encryptedConfig)}::jsonb,
            is_active = true,
            updated_at = NOW()`
    );
    return true;
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) throw capacityError;
    logger.error({ err: error }, `[CredentialService] Error saving ${serviceName} credential:`);
    return false;
  }
}

/**
 * Delete a credential
 */
export async function deleteCredential(userId: number, serviceName: string): Promise<boolean> {
  try {
    await db.execute(
      sql`DELETE FROM api_credentials 
          WHERE user_id = ${userId} AND service_name = ${serviceName}`
    );
    return true;
  } catch (error) {
    logger.error({ err: error }, `[CredentialService] Error deleting ${serviceName} credential:`);
    return false;
  }
}

/**
 * Get OpenAI API key for a user
 */
export async function getOpenAIKey(userId: number): Promise<string | null> {
  const cred = await getCredential(userId, 'openai');
  return cred?.apiKey || null;
}

/**
 * Get Apify API key for a user
 */
export async function getApifyKey(userId: number): Promise<string | null> {
  const cred = await getCredential(userId, 'apify');
  return cred?.apiKey || null;
}

/**
 * Get email configuration for a user
 */
export async function getEmailConfig(userId: number): Promise<Credentials['email'] | null> {
  // Check for different email providers
  for (const provider of ['email', 'gmail_smtp', 'sendgrid', 'smtp']) {
    const cred = await getCredential(userId, provider);
    if (cred) {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        user: cred.config?.user || cred.config?.email,
        password: cred.apiSecret,
        apiKey: cred.apiKey,
        fromName: cred.config?.fromName,
        fromEmail: cred.config?.fromEmail,
        host: cred.config?.host,
        port: cred.config?.port,
      };
    }
  }
  return null;
}

/**
 * Get Instagram browser credentials for a user
 */
export async function getInstagramCredentials(userId: number): Promise<Credentials['instagram'] | null> {
  const cred = await getCredential(userId, 'instagram_browser');
  if (!cred) {
    const cred2 = await getCredential(userId, 'instagram');
    if (cred2) {
      return {
        username: cred2.config?.username,
        password: cred2.apiSecret,
        sessionId: cred2.config?.sessionId,
      };
    }
    return null;
  }
  return {
    username: cred.config?.username,
    password: cred.apiSecret,
    sessionId: cred.config?.sessionId,
  };
}

/**
 * Get Meta/Facebook credentials for a user
 * Uses admin-managed config (meta_app in admin_api_credentials) + user's OAuth connection.
 * Per-user Meta app credentials have been removed — use OAuth connect buttons instead.
 */
export async function getMetaCredentials(userId: number): Promise<Credentials['meta'] | null> {
  const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions.js');
  const { getActiveConnectionForUser } = await import('../models/metaPageConnections/functions.js');

  const adminCred = await getActiveAdminCredential('meta_app');
  const connection = await getActiveConnectionForUser(userId);

  if (adminCred?.apiKey && adminCred?.apiSecret) {
    return {
      appId: adminCred.apiKey,
      appSecret: adminCred.apiSecret,
      adAccountId: connection?.adAccountId ?? undefined,
      pageId: connection?.pageId ?? undefined,
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      apiVersion: adminCred.config?.apiVersion || 'v25.0',
    };
  }

  return null;
}

export const CredentialService = {
  getUserCredentials,
  getCredential,
  hasCredential,
  saveCredential,
  deleteCredential,
  getOpenAIKey,
  getApifyKey,
  getEmailConfig,
  getInstagramCredentials,
  getMetaCredentials,
};

export default CredentialService;
