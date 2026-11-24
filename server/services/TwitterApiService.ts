/**
 * Twitter/X API Service
 * Twitter API v2 integration for Direct Messages
 *
 * This service handles:
 * - Sending direct messages via API v2
 * - Fetching DM conversations
 * - Getting message history
 * - Token refresh (OAuth 2.0 with PKCE)
 *
 * Requirements:
 * - Twitter Developer App with OAuth 2.0 enabled
 * - User must have granted dm.read, dm.write, users.read, offline.access scopes
 *
 * API Docs: https://developer.x.com/en/docs/twitter-api/direct-messages
 */

import { db } from '../models/db';
import { refreshChannelCredential } from './ChannelCredentialRefreshService.js';
import { eq, and } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { logger } from '../utils/logger.js';
import {
  decryptChannelCredentialSecret,
} from '../utils/channelCredentialSecrets.js';

// Twitter API v2 base URL
const TWITTER_API_BASE = 'https://api.x.com/2';

// ── Interfaces ──

export interface TwitterCredentials {
  accessToken: string;
  refreshToken?: string;
  userId?: string;
  username?: string;
  expiresAt?: Date;
}

export interface SendDMResult {
  success: boolean;
  dmEventId?: string;
  error?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
}

type ProviderRequestError = Error & {
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
};

export interface TwitterDMEvent {
  id: string;
  text: string;
  event_type: string;
  dm_conversation_id: string;
  sender_id: string;
  created_at: string;
  attachments?: Array<{ media_key: string; type: string }>;
}

export interface TwitterConversation {
  id: string;
  type: string;
  participant_ids?: string[];
}

export interface ConversationListResult {
  success: boolean;
  conversations?: TwitterConversation[];
  dmEvents?: TwitterDMEvent[];
  nextToken?: string;
  error?: string;
}

export interface DMEventListResult {
  success: boolean;
  dmEvents?: TwitterDMEvent[];
  nextToken?: string;
  error?: string;
}

// ── Service Class ──

export class TwitterApiService {
  private credentials: TwitterCredentials | null = null;
  private userId: number | null = null;

  constructor() {}

  /**
   * Initialize service with user credentials from database
   */
  async initializeForUser(userId: number, providerAccountId?: string): Promise<boolean> {
    try {
      this.credentials = null;
      this.userId = userId;

      const [cred] = await db.select()
        .from(channelCredentialsTable)
        .where(and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'twitter_api'),
          eq(channelCredentialsTable.isActive, true),
          ...(providerAccountId ? [eq(channelCredentialsTable.accountIdentifier, providerAccountId)] : []),
        ))
        .limit(1);

      if (!cred || cred.credentialType !== 'oauth' || !cred.accessToken || !cred.accountIdentifier) {
        logger.info({ userId }, '[TwitterApi] No API credentials found for user');
        return false;
      }

      if (cred.tokenExpiry && new Date(cred.tokenExpiry).getTime() <= Date.now() && !cred.refreshToken) {
        this.credentials = null;
        return false;
      }

      // Check if token is expired and attempt refresh
      if (cred.tokenExpiry && new Date(cred.tokenExpiry).getTime() <= Date.now() + 60_000 && cred.refreshToken) {
        logger.info({ userId }, '[TwitterApi] Token expired, attempting refresh...');
        const refreshed = await this.refreshAccessToken(userId, cred);
        if (!refreshed) return false;
        // Re-read credentials after refresh
        const [refreshedCred] = await db.select()
          .from(channelCredentialsTable)
          .where(and(eq(channelCredentialsTable.id, cred.id), eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, 'twitter_api'), eq(channelCredentialsTable.isActive, true)))
          .limit(1);
        if (!refreshedCred) return false;
        this.credentials = {
          accessToken: decryptChannelCredentialSecret(refreshedCred.accessToken),
          refreshToken: decryptChannelCredentialSecret(refreshedCred.refreshToken) || undefined,
          userId: refreshedCred.accountIdentifier || undefined,
          username: refreshedCred.accountName || undefined,
          expiresAt: refreshedCred.tokenExpiry || undefined,
        };
        return true;
      }

      this.credentials = {
        accessToken: decryptChannelCredentialSecret(cred.accessToken),
        refreshToken: decryptChannelCredentialSecret(cred.refreshToken) || undefined,
        userId: cred.accountIdentifier || undefined,
        username: cred.accountName || undefined,
        expiresAt: cred.tokenExpiry || undefined,
      };

      return true;
    } catch (error) {
      logger.error({ err: error }, '[TwitterApi] Error initializing');
      return false;
    }
  }

  /**
   * Check if service is initialized with valid credentials
   */
  isInitialized(): boolean {
    return !!this.credentials?.accessToken;
  }

  /**
   * Make a Twitter API v2 request
   */
  private async apiRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    data?: Record<string, unknown>,
    params?: Record<string, string>
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Twitter API credentials not initialized');
    }

    const url = new URL(`${TWITTER_API_BASE}${endpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
      }
    }

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.credentials.accessToken}`,
      },
    };

    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        ...options,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      const error = new Error(
        cause instanceof Error ? cause.message : 'Twitter/X request failed before a receipt was returned.',
      ) as ProviderRequestError;
      error.deliveryAttempted = method !== 'GET';
      error.outcomeUncertain = method !== 'GET';
      throw error;
    }

    if (!response.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorData = await response.json().catch(() => null) as any;
      const errorMsg = errorData?.detail || errorData?.title || `HTTP ${response.status}`;
      const error = new Error(errorMsg) as ProviderRequestError;
      error.deliveryAttempted = method !== 'GET';
      error.outcomeUncertain = false;
      throw error;
    }

    try {
      return await response.json() as T;
    } catch (cause) {
      const error = new Error('Twitter/X returned an unreadable provider response.', { cause }) as ProviderRequestError;
      error.deliveryAttempted = method !== 'GET';
      error.outcomeUncertain = method !== 'GET';
      throw error;
    }
  }

  /**
   * Send a direct message to a user
   */
  async sendMessage(recipientId: string, messageText: string): Promise<SendDMResult> {
    const { assertCustomerDeliveryRuntime } = await import('./assistants/CustomerDeliveryGate.js');
    assertCustomerDeliveryRuntime('twitter');
    if (!this.credentials) {
      return { success: false, error: 'Twitter credentials not initialized' };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.apiRequest<any>(
        `/dm_conversations/with/${recipientId}/messages`,
        'POST',
        { text: messageText }
      );

      return {
        success: true,
        dmEventId: data.data?.dm_event_id,
        deliveryAttempted: true,
        outcomeUncertain: !data.data?.dm_event_id,
      };
    } catch (error) {
      logger.error({ err: error, recipientId }, '[TwitterApi] Send DM failed');
      const providerError = error as ProviderRequestError;
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        deliveryAttempted: providerError.deliveryAttempted === true,
        outcomeUncertain: providerError.outcomeUncertain === true,
      };
    }
  }

  /**
   * Get DM events (inbox) for the authenticated user
   */
  async getDMEvents(limit = 25, paginationToken?: string): Promise<DMEventListResult> {
    if (!this.credentials) {
      return { success: false, error: 'Twitter credentials not initialized' };
    }

    try {
      const params: Record<string, string> = {
        'dm_event.fields': 'id,text,event_type,dm_conversation_id,sender_id,created_at,attachments',
        'max_results': String(Math.min(limit, 100)),
      };
      if (paginationToken) params.pagination_token = paginationToken;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.apiRequest<any>('/dm_events', 'GET', undefined, params);

      return {
        success: true,
        dmEvents: data.data || [],
        nextToken: data.meta?.next_token,
      };
    } catch (error) {
      logger.error({ err: error }, '[TwitterApi] Get DM events error');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get messages in a specific DM conversation
   */
  async getConversationMessages(conversationId: string, limit = 25, paginationToken?: string): Promise<DMEventListResult> {
    if (!this.credentials) {
      return { success: false, error: 'Twitter credentials not initialized' };
    }

    try {
      const params: Record<string, string> = {
        'dm_event.fields': 'id,text,event_type,dm_conversation_id,sender_id,created_at,attachments',
        'max_results': String(Math.min(limit, 100)),
      };
      if (paginationToken) params.pagination_token = paginationToken;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.apiRequest<any>(
        `/dm_conversations/${conversationId}/dm_events`,
        'GET',
        undefined,
        params
      );

      return {
        success: true,
        dmEvents: data.data || [],
        nextToken: data.meta?.next_token,
      };
    } catch (error) {
      logger.error({ err: error }, '[TwitterApi] Get conversation messages error');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Look up a user by username to get their ID
   */
  async getUserByUsername(username: string): Promise<{ id: string; name: string; username: string } | null> {
    try {
      const cleanUsername = username.replace(/^@/, '');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.apiRequest<any>(
        `/users/by/username/${cleanUsername}`,
        'GET',
        undefined,
        { 'user.fields': 'id,name,username,profile_image_url' }
      );
      return data.data || null;
    } catch (error) {
      logger.error({ err: error, username }, '[TwitterApi] User lookup error');
      return null;
    }
  }

  /**
   * Refresh the access token using OAuth 2.0 refresh token
   * Twitter tokens expire after 2 hours
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async refreshAccessToken(userId: number, cred: { id: number; accountIdentifier?: string }): Promise<boolean> {
    try {
      const { getCredential } = await import('./credentialService');
      const app = await getCredential(userId, 'twitter_api') || await getCredential(userId, 'twitter');
      if (!app?.apiKey || !app?.apiSecret) throw new Error('Provider app configuration unavailable');
      const result = await refreshChannelCredential({ userId, credentialId: cred.id, platform: 'twitter_api', accountIdentifier: cred.accountIdentifier }, async current => {
        const response = await fetch('https://api.x.com/2/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${app.apiKey}:${app.apiSecret}`).toString('base64')}` },
          signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptChannelCredentialSecret(current.refreshToken) }),
        });
        const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
        if (!response.ok) throw Object.assign(new Error('Provider token refresh rejected'), { response: { data: { error: data.error } } });
        if (!data.access_token?.trim() || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new Error('Provider refresh receipt incomplete');
        return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000) };
      });
      return Boolean(result.credential);
    } catch {
      logger.warn({ userId, credentialId: cred.id }, '[twitterApi] Token refresh unavailable');
      return false;
    }
  }

  /**
   * Publish a tweet (post) using Twitter API v2
   */
  async publishTweet(text: string, mediaUrls?: string[]): Promise<{ success: boolean; platformPostId?: string; postUrl?: string; error?: string }> {
    try {
      if (!this.isInitialized()) {
        return { success: false, error: 'Twitter API service not initialized for user' };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload: Record<string, any> = { text };

      if (mediaUrls && mediaUrls.length > 0) {
        payload.text = `${text}\n\n${mediaUrls.join('\n')}`;
      }

      interface TweetResponse {
        data?: {
          id: string;
          text: string;
        };
        errors?: Array<{ message: string }>;
      }

      const response = await this.apiRequest<TweetResponse>('/tweets', 'POST', payload);

      if (response.errors && response.errors.length > 0) {
        return { success: false, error: response.errors[0].message };
      }

      if (!response.data?.id) {
        return { success: false, error: 'Failed to retrieve published tweet ID' };
      }

      const tweetId = response.data.id;
      const username = this.credentials?.username || 'user';

      return {
        success: true,
        platformPostId: tweetId,
        postUrl: `https://x.com/${username}/status/${tweetId}`,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[TwitterApi] Error publishing tweet');
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Delete a tweet using Twitter API v2
   */
  async deleteTweet(tweetId: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.isInitialized()) {
        throw new Error('Twitter API service not initialized');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.apiRequest<any>(`/tweets/${tweetId}`, 'DELETE');
      return { success: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error, tweetId }, '[TwitterApi] Error deleting tweet');
      return { success: false, error: error.message || String(error) };
    }
  }
}

// ── Exported Helper Functions ──

/**
 * Get an initialized TwitterApiService for a user
 */
export async function getTwitterApiForUser(userId: number, providerAccountId?: string): Promise<TwitterApiService | null> {
  const service = new TwitterApiService();
  const initialized = await service.initializeForUser(userId, providerAccountId);
  return initialized ? service : null;
}

/**
 * Send a Twitter DM — top-level helper for outreach controller
 */
export async function sendTwitterDM(params: {
  recipientId: string;
  message: string;
  userId: number;
  /** Exact reviewed account; never replace with the tenant's current default. */
  providerAccountId?: string;
}): Promise<{
  success: boolean;
  code?: string;
  reason?: string;
  setupUrl?: string;
  error?: string;
  externalMessageId?: string;
  deliveryAttempted?: boolean;
  outcomeUnknown?: boolean;
  retryable?: boolean;
}> {
  try {
    const { assertCustomerDeliveryRuntime } = await import('./assistants/CustomerDeliveryGate.js');
    assertCustomerDeliveryRuntime('twitter');
    const service = await getTwitterApiForUser(params.userId, params.providerAccountId);
    if (!service) {
      return {
        success: false,
        error: 'Twitter/X OAuth with DM permissions is required. Browser fallback is disabled.',
        deliveryAttempted: false,
        outcomeUnknown: false,
        retryable: false,
      };
    }

    const result = await service.sendMessage(params.recipientId, params.message);
    if (result.success && result.dmEventId) {
      return {
        success: true,
        externalMessageId: result.dmEventId,
        deliveryAttempted: true,
        outcomeUnknown: false,
        retryable: false,
      };
    }

    return {
      success: false,
      error: result.error || 'Twitter/X did not return a message receipt. Manual review is required before retrying.',
      deliveryAttempted: result.deliveryAttempted === true,
      outcomeUnknown: result.outcomeUncertain === true || result.success,
      retryable: result.deliveryAttempted !== true || result.outcomeUncertain === false,
    };
  } catch (error) {
    logger.error({ err: error }, '[TwitterApi] sendTwitterDM error');
    const { deliverySetupFailure } = await import('./assistants/CustomerDeliveryGate.js');
    const setup = deliverySetupFailure(error);
    if (setup) return { ...setup, outcomeUnknown: false };
    return {
      success: false,
      error: 'Twitter/X delivery could not be confirmed. Review provider history before retrying.',
      deliveryAttempted: true,
      outcomeUnknown: true,
      retryable: false,
    };
  }
}
