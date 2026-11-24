/**
 * Channel Auth Manager (Fixed with Drizzle ORM)
 * Securely manages OAuth tokens, sessions, and cookies for social platforms
 */

import crypto from 'crypto';
import { businessCacheKey } from '../tenancy/businessContext.js';
import { logger } from '../utils/logger.js';
import { ChannelCredentialModel } from '../models';
import { CHANNEL_SESSION_CACHE_TIMEOUT_MS, CHANNEL_SESSION_CLEANUP_INTERVAL_MS } from '../utils/timingConstants';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const encoded = process.env.CHANNEL_AUTH_ENCRYPTION_KEY;
  if (!encoded || !/^[0-9a-fA-F]{64}$/.test(encoded)) {
    throw new Error('CHANNEL_AUTH_ENCRYPTION_KEY must be a stable 32-byte hex key');
  }
  return Buffer.from(encoded, 'hex');
}

export interface ChannelCredentials {
  id?: number;
  userId: number;
  platform: 'linkedin' | 'instagram' | 'twitter' | 'whatsapp' | 'facebook';
  credentialType: 'oauth' | 'session' | 'api_key';
  
  // OAuth credentials
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: Date;
  
  // Session/Cookie credentials (for browser automation)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionCookies?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionData?: any;
  
  // API credentials
  apiKey?: string;
  apiSecret?: string;
  
  // Metadata
  accountIdentifier?: string;
  accountName?: string;
  isActive?: boolean;
  lastUsedAt?: Date | null;
  lastRefreshedAt?: Date | null;
  
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ChannelSession {
  platform: string;
  accessToken: string;
  expiresAt: Date;
  accountId: string;
}

export class ChannelAuthManager {
  private static instance: ChannelAuthManager;

  // In-memory session cache (reduces DB queries)
  private sessionCache: Map<string, ChannelSession> = new Map();
  private cacheTimeout = CHANNEL_SESSION_CACHE_TIMEOUT_MS;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  private constructor() {
    // Start session cleanup interval
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), CHANNEL_SESSION_CLEANUP_INTERVAL_MS);
    // Don't keep the process alive solely for this timer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (this.cleanupTimer && typeof (this.cleanupTimer as any).unref === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.cleanupTimer as any).unref();
    }
  }

  public static getInstance(): ChannelAuthManager {
    if (!ChannelAuthManager.instance) {
      ChannelAuthManager.instance = new ChannelAuthManager();
    }
    return ChannelAuthManager.instance;
  }

  /**
   * Phase 4.13 / DEPLOY-004: clear the cleanup interval and the in-memory
   * session cache. Safe to call multiple times. Used by graceful-shutdown
   * handlers in the worker / server process.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessionCache.clear();
  }

  /**
   * Store channel credentials securely
   */
  public async storeCredentials(credentials: ChannelCredentials): Promise<number> {
    // Encrypt sensitive fields
    const encrypted = this.encryptCredentials(credentials);
    
    try {
      const saved = await ChannelCredentialModel.upsert({
        userId: credentials.userId,
        platform: credentials.platform,
        credentialType: credentials.credentialType,
        accessToken: encrypted.accessToken,
        refreshToken: encrypted.refreshToken,
        tokenExpiry: credentials.tokenExpiry || null,
        sessionCookies: encrypted.sessionCookies,
        sessionData: credentials.sessionData || null,
        apiKey: encrypted.apiKey,
        apiSecret: encrypted.apiSecret,
        accountIdentifier: credentials.accountIdentifier,
        accountName: credentials.accountName,
        isActive: credentials.isActive !== false,
      });

      const credentialId = saved.id;
      
      // Cache the session if it's an active OAuth token
      if (credentials.accessToken && credentials.tokenExpiry) {
        this.cacheSession({
          platform: credentials.platform,
          accessToken: credentials.accessToken,
          expiresAt: credentials.tokenExpiry,
          accountId: credentials.accountIdentifier || `user_${credentials.userId}`,
        });
      }

      logger.info(`[ChannelAuth] Stored credentials for ${credentials.platform} (ID: ${credentialId})`);
      return credentialId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[ChannelAuth] Error storing credentials:', error);
      throw new Error(`Failed to store channel credentials: ${error.message}`);
    }
  }

  /**
   * Retrieve channel credentials for a user
   */
  public async getCredentials(
    userId: number,
    platform: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    accountIdentifier?: string
  ): Promise<ChannelCredentials | null> {
    try {
      const row = await ChannelCredentialModel.findByUserAndPlatform(userId, platform);

      if (!row) {
        return null;
      }
      
      // Decrypt sensitive fields
      const decrypted = this.decryptCredentials(row);
      
      // Update last used timestamp
      await ChannelCredentialModel.updateLastUsed(userId, platform);

      return decrypted;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[ChannelAuth] Error retrieving credentials:', error);
      return null;
    }
  }

  /**
   * Get active access token (checks cache first, then DB)
   */
  public async getAccessToken(
    userId: number,
    platform: string
  ): Promise<string | null> {
    // Check cache first
    const cacheKey = businessCacheKey(`${userId}:${platform}`);
    const cached = this.sessionCache.get(cacheKey);
    
    if (cached && cached.expiresAt > new Date()) {
      return cached.accessToken;
    }

    // Fetch from DB
    const credentials = await this.getCredentials(userId, platform);
    
    if (!credentials || !credentials.accessToken) {
      return null;
    }

    // Check if token is expired
    if (credentials.tokenExpiry && credentials.tokenExpiry < new Date()) {
      // Try to refresh
      const refreshed = await this.refreshToken(userId, platform, credentials);
      return refreshed ? refreshed.accessToken! : null;
    }

    return credentials.accessToken;
  }

  /**
   * Refresh OAuth token
   */
  public async refreshToken(
    userId: number,
    platform: string,
    credentials?: ChannelCredentials
  ): Promise<ChannelCredentials | null> {
    if (!credentials) {
      const fetchedCredentials = await this.getCredentials(userId, platform);
      if (!fetchedCredentials) {
        logger.error(`[ChannelAuth] No credentials found for ${platform}`);
        return null;
      }
      credentials = fetchedCredentials;
    }

    if (!credentials || !credentials.refreshToken) {
      logger.error(`[ChannelAuth] No refresh token available for ${platform}`);
      return null;
    }

    // Skip refresh for manual credentials — they manage their own tokens
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((credentials.credentialType as string) === 'manual' || (credentials as any).sessionData?.connectedViaManual) {
      logger.info(`[ChannelAuth] Skipping token refresh for manual ${platform} credentials`);
      return credentials;
    }

    try {
      let newTokens: {
        accessToken: string;
        refreshToken?: string;
        expiresAt: Date;
      };

      // Platform-specific refresh logic
      switch (platform) {
        case 'linkedin':
          newTokens = await this.refreshLinkedInToken(credentials.refreshToken,userId);
          break;
        case 'instagram':
        case 'facebook':
          newTokens = await this.refreshMetaToken(credentials.accessToken!,userId);
          break;
        case 'twitter':
          newTokens = await this.refreshTwitterToken(credentials.refreshToken,userId);
          break;
        default:
          throw new Error(`Token refresh not implemented for ${platform}`);
      }

      // Update credentials with new tokens
      const updated: ChannelCredentials = {
        ...credentials,
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken || credentials.refreshToken,
        tokenExpiry: newTokens.expiresAt,
        lastRefreshedAt: new Date(),
      };

      await this.storeCredentials(updated);
      
      logger.info(`[ChannelAuth] Successfully refreshed ${platform} token`);
      return updated;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error(`[ChannelAuth] Error refreshing ${platform} token:`, error);
      
      // Mark credentials as inactive if refresh fails
      await this.deactivateCredentials(userId, platform);
      return null;
    }
  }

  /**
   * Deactivate credentials (e.g., after failed refresh or user disconnect)
   */
  public async deactivateCredentials(
    userId: number,
    platform: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    accountIdentifier?: string
  ): Promise<void> {
    try {
      await ChannelCredentialModel.deactivate(userId, platform);
      
      // Clear from cache
      const cacheKey = businessCacheKey(`${userId}:${platform}`);
      this.sessionCache.delete(cacheKey);

      logger.info(`[ChannelAuth] Deactivated credentials for ${platform}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[ChannelAuth] Error deactivating credentials:', error);
    }
  }

  /**
   * List all active channels for a user
   */
  public async listActiveChannels(userId: number): Promise<string[]> {
    try {
      return await ChannelCredentialModel.findActivePlatforms(userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('[ChannelAuth] Error listing active channels:', error);
      return [];
    }
  }

  /**
   * Encryption helpers
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private encryptCredentials(credentials: ChannelCredentials): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encrypted: any = { ...credentials };

    if (credentials.accessToken) {
      encrypted.accessToken = this.encrypt(credentials.accessToken);
    }
    if (credentials.refreshToken) {
      encrypted.refreshToken = this.encrypt(credentials.refreshToken);
    }
    if (credentials.apiKey) {
      encrypted.apiKey = this.encrypt(credentials.apiKey);
    }
    if (credentials.apiSecret) {
      encrypted.apiSecret = this.encrypt(credentials.apiSecret);
    }
    if (credentials.sessionCookies) {
      encrypted.sessionCookies = this.encrypt(JSON.stringify(credentials.sessionCookies));
    }
    if (credentials.sessionData) {
      encrypted.sessionData = this.encrypt(JSON.stringify(credentials.sessionData));
    }

    return encrypted;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private decryptCredentials(row: any): ChannelCredentials {
    const credentials: ChannelCredentials = {
      id: row.id,
      userId: row.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: row.platform as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credentialType: row.credentialType as any,
      accountIdentifier: row.accountIdentifier || undefined,
      accountName: row.accountName || undefined,
      isActive: row.isActive,
      tokenExpiry: row.tokenExpiry || undefined,
      lastUsedAt: row.lastUsedAt || undefined,
      lastRefreshedAt: row.lastRefreshedAt || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };

    if (row.accessToken) {
      credentials.accessToken = this.decrypt(row.accessToken);
    }
    if (row.refreshToken) {
      credentials.refreshToken = this.decrypt(row.refreshToken);
    }
    if (row.apiKey) {
      credentials.apiKey = this.decrypt(row.apiKey);
    }
    if (row.apiSecret) {
      credentials.apiSecret = this.decrypt(row.apiSecret);
    }
    if (row.sessionCookies) {
      credentials.sessionCookies = JSON.parse(this.decrypt(row.sessionCookies));
    }
    if (row.sessionData) {
      credentials.sessionData = JSON.parse(this.decrypt(row.sessionData));
    }

    return credentials;
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const key = getEncryptionKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  private decrypt(encryptedText: string): string {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = getEncryptionKey();
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  /**
   * Session cache helpers
   */
  private cacheSession(session: ChannelSession): void {
    const cacheKey = businessCacheKey(`${session.accountId}:${session.platform}`);
    this.sessionCache.set(cacheKey, session);
  }

  private cleanupExpiredSessions(): void {
    const now = new Date();
    for (const [key, session] of this.sessionCache.entries()) {
      if (session.expiresAt < now) {
        this.sessionCache.delete(key);
      }
    }
  }

  /**
   * Platform-specific token refresh implementations
   * Note: LinkedIn, Meta, and Twitter credentials should be stored per-user in the database
   */
  private async refreshLinkedInToken(refreshToken: string, userId?: number): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }> {
    // LinkedIn OAuth2 token refresh
    // Credentials should be fetched from user's integration settings
    const { getCredential } = await import('./credentialService');
    const cred = userId ? await getCredential(userId, 'linkedin') : null;
    const clientId = cred?.apiKey || '';
    const clientSecret = cred?.apiSecret || '';
    
    if (!clientId || !clientSecret) {
      throw new Error('LinkedIn credentials not configured. Please add your LinkedIn App credentials in Settings → Integrations');
    }
    
    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`LinkedIn token refresh failed: ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  private async refreshMetaToken(accessToken: string, userId?: number): Promise<{
    accessToken: string;
    expiresAt: Date;
  }> {
    // Meta (Facebook/Instagram) long-lived token exchange
    // Try admin-managed credentials first
    const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions.js');
    const adminCred = await getActiveAdminCredential('meta_app');

    let appId = adminCred?.apiKey || '';
    let appSecret = adminCred?.apiSecret || '';

    // Fallback: per-user credentials
    if (!appId || !appSecret) {
      const { getCredential } = await import('./credentialService');
      const cred = userId ? await getCredential(userId, 'meta') : null;
      appId = cred?.apiKey || '';
      appSecret = cred?.apiSecret || '';
    }
    
    if (!appId || !appSecret) {
      throw new Error('Meta App not configured by admin. Please contact your administrator.');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiVersion = (adminCred?.config as any)?.apiVersion || 'v25.0';
    const response = await fetch(`https://graph.facebook.com/${apiVersion}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: accessToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Meta token refresh failed: ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    
    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in || 5184000) * 1000), // 60 days default
    };
  }

  private async refreshTwitterToken(refreshToken: string, userId?: number): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }> {
    // Twitter/X OAuth 2.0 token refresh
    // Credentials should be fetched from user's integration settings
    const { getCredential } = await import('./credentialService');
    const cred = userId ? await getCredential(userId, 'twitter') : null;
    const clientId = cred?.apiKey || '';
    const clientSecret = cred?.apiSecret || '';
    
    if (!clientId || !clientSecret) {
      throw new Error('Twitter credentials not configured. Please add your Twitter App credentials in Settings → Integrations');
    }
    
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(
          `${clientId}:${clientSecret}`
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Twitter token refresh failed: ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }
}
