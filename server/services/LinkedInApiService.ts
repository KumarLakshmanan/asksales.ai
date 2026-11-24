/**
 * LinkedIn API Service
 * LinkedIn Messaging API v2 integration for Direct Messages
 *
 * This service handles:
 * - Sending direct messages to LinkedIn members
 * - Fetching conversation threads
 * - Getting message history
 * - Token refresh (OAuth 2.0)
 *
 * Requirements:
 * - LinkedIn Developer App with Messaging permissions
 * - User must have granted w_member_social, r_liteprofile, w_messaging scopes
 *
 * API Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/
 */

import { db } from '../models/db';
import { refreshChannelCredential } from './ChannelCredentialRefreshService.js';
import { eq, and } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { logger } from '../utils/logger.js';
import {
  decryptChannelCredentialSecret,
} from '../utils/channelCredentialSecrets.js';

// LinkedIn API v2
const LINKEDIN_API_BASE = 'https://api.linkedin.com/v2';

// ── Interfaces ──

export interface LinkedInCredentials {
  accessToken: string;
  refreshToken?: string;
  memberUrn?: string;
  memberName?: string;
  expiresAt?: Date;
  /** Version confirmed during provider verification, in LinkedIn YYYYMM form. */
  apiVersion?: string;
}

export interface SendMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
}

type ProviderRequestError = Error & {
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
};

export interface LinkedInMessage {
  id: string;
  body: string;
  sender: string;
  recipients: string[];
  createdAt: string;
  messageType?: string;
}

export interface LinkedInConversation {
  id: string;
  participants: string[];
  lastActivity?: string;
  messages?: LinkedInMessage[];
}

export interface ConversationListResult {
  success: boolean;
  conversations?: LinkedInConversation[];
  error?: string;
}

export interface MessageListResult {
  success: boolean;
  messages?: LinkedInMessage[];
  error?: string;
}

// ── Service Class ──

export class LinkedInApiService {
  private credentials: LinkedInCredentials | null = null;
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
          eq(channelCredentialsTable.platform, 'linkedin_api'),
          eq(channelCredentialsTable.isActive, true),
          ...(providerAccountId ? [eq(channelCredentialsTable.accountIdentifier, providerAccountId)] : []),
        ))
        .limit(1);

      if (!cred || cred.credentialType !== 'oauth' || !cred.accessToken || !cred.accountIdentifier) {
        logger.info({ userId }, '[LinkedInApi] No API credentials found for user');
        return false;
      }

      if (cred.tokenExpiry && new Date(cred.tokenExpiry).getTime() <= Date.now() && !cred.refreshToken) {
        this.credentials = null;
        return false;
      }

      // Check if token is expired and attempt refresh
      if (cred.tokenExpiry && new Date(cred.tokenExpiry).getTime() <= Date.now() + 60_000 && cred.refreshToken) {
        logger.info({ userId }, '[LinkedInApi] Token expired, attempting refresh...');
        const refreshed = await this.refreshAccessToken(userId, cred);
        if (!refreshed) return false;
        // Re-read credentials after refresh
        const [refreshedCred] = await db.select()
          .from(channelCredentialsTable)
          .where(and(eq(channelCredentialsTable.id, cred.id), eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, 'linkedin_api'), eq(channelCredentialsTable.isActive, true)))
          .limit(1);
        if (!refreshedCred) return false;
        this.credentials = {
          accessToken: decryptChannelCredentialSecret(refreshedCred.accessToken),
          refreshToken: decryptChannelCredentialSecret(refreshedCred.refreshToken) || undefined,
          memberUrn: refreshedCred.accountIdentifier || undefined,
          memberName: refreshedCred.accountName || undefined,
          expiresAt: refreshedCred.tokenExpiry || undefined,
          apiVersion: refreshedCred.providerApiVersion || undefined,
        };
        return true;
      }

      this.credentials = {
        accessToken: decryptChannelCredentialSecret(cred.accessToken),
        refreshToken: decryptChannelCredentialSecret(cred.refreshToken) || undefined,
        memberUrn: cred.accountIdentifier || undefined,
        memberName: cred.accountName || undefined,
        expiresAt: cred.tokenExpiry || undefined,
        apiVersion: cred.providerApiVersion || undefined,
      };

      return true;
    } catch (error) {
      logger.error({ err: error }, '[LinkedInApi] Error initializing');
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
   * Make a LinkedIn API v2 request
   */
  private async apiRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    data?: Record<string, unknown>,
    params?: Record<string, string>
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('LinkedIn API credentials not initialized');
    }

    const url = new URL(`${LINKEDIN_API_BASE}${endpoint}`);
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
        ...(/^\d{6}$/.test(this.credentials.apiVersion || '')
          ? { 'LinkedIn-Version': this.credentials.apiVersion! }
          : {}),
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
        cause instanceof Error ? cause.message : 'LinkedIn request failed before a receipt was returned.',
      ) as ProviderRequestError;
      error.deliveryAttempted = method !== 'GET';
      error.outcomeUncertain = method !== 'GET';
      throw error;
    }

    if (!response.ok && response.status !== 201) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorData = await response.json().catch(() => null) as any;
      const errorMsg = errorData?.message || errorData?.error_description || `HTTP ${response.status}`;
      const error = new Error(errorMsg) as ProviderRequestError;
      error.deliveryAttempted = method !== 'GET';
      error.outcomeUncertain = false;
      throw error;
    }

    // LinkedIn returns the authoritative message/thread receipt for successful
    // creates in x-linkedin-id, frequently with an empty response body.
    const linkedInId = response.headers.get('x-linkedin-id')?.trim() || undefined;
    const text = await response.text();
    if (!text) return (linkedInId ? { __linkedInId: linkedInId } : {}) as T;
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch (cause) {
      if (linkedInId) return { __linkedInId: linkedInId } as T;
      const error = new Error('LinkedIn returned an unreadable provider response.', { cause }) as ProviderRequestError;
      error.deliveryAttempted = method !== 'GET';
      error.outcomeUncertain = method !== 'GET';
      throw error;
    }
    if (linkedInId && parsed && typeof parsed === 'object') {
      (parsed as Record<string, unknown>).__linkedInId = linkedInId;
    }
    return parsed;
  }

  /**
   * Send a message to one or more recipients
   */
  async sendMessage(recipientUrn: string, messageBody: string): Promise<SendMessageResult> {
    const { assertCustomerDeliveryRuntime } = await import('./assistants/CustomerDeliveryGate.js');
    assertCustomerDeliveryRuntime('linkedin');
    if (!this.credentials) {
      return { success: false, error: 'LinkedIn credentials not initialized' };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.apiRequest<any>('/messages', 'POST', {
        recipients: [recipientUrn],
        body: messageBody,
        messageType: 'MEMBER_TO_MEMBER',
      });

      return {
        success: true,
        messageId: data.id || data.value?.id || data.__linkedInId,
        deliveryAttempted: true,
        outcomeUncertain: !(data.id || data.value?.id || data.__linkedInId),
      };
    } catch (error) {
      logger.error({ err: error, recipientUrn }, '[LinkedInApi] Send message failed');
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
   * Get conversations for the authenticated user
   */
  async getConversations(limit = 25): Promise<ConversationListResult> {
    if (!this.credentials) {
      return { success: false, error: 'LinkedIn credentials not initialized' };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.apiRequest<any>('/conversations', 'GET', undefined, {
        count: String(limit),
      });

      return {
        success: true,
        conversations: data.elements || [],
      };
    } catch (error) {
      logger.error({ err: error }, '[LinkedInApi] Get conversations error');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get messages in a specific conversation
   */
  async getConversationMessages(conversationId: string, limit = 25): Promise<MessageListResult> {
    if (!this.credentials) {
      return { success: false, error: 'LinkedIn credentials not initialized' };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.apiRequest<any>(
        `/conversations/${conversationId}/events`,
        'GET',
        undefined,
        { count: String(limit) }
      );

      return {
        success: true,
        messages: data.elements || [],
      };
    } catch (error) {
      logger.error({ err: error }, '[LinkedInApi] Get conversation messages error');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get the authenticated user's profile URN
   */
  async getOwnProfile(): Promise<{ urn: string; name: string } | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.apiRequest<any>('/me', 'GET', undefined, {
        fields: 'id,firstName,lastName',
      });
      if (!data.id) return null;
      const firstName = data.firstName?.localized?.en_US || '';
      const lastName = data.lastName?.localized?.en_US || '';
      return { urn: `urn:li:person:${data.id}`, name: `${firstName} ${lastName}`.trim() };
    } catch (error) {
      logger.error({ err: error }, '[LinkedInApi] Get own profile error');
      return null;
    }
  }

  /**
   * Refresh the access token using OAuth 2.0 refresh token
   * LinkedIn tokens expire after 60 days
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async refreshAccessToken(userId: number, cred: { id: number; accountIdentifier?: string }): Promise<boolean> {
    try {
      const { getCredential } = await import('./credentialService');
      const app = await getCredential(userId, 'linkedin_api') || await getCredential(userId, 'linkedin');
      if (!app?.apiKey || !app?.apiSecret) throw new Error('Provider app configuration unavailable');
      const result = await refreshChannelCredential({ userId, credentialId: cred.id, platform: 'linkedin_api', accountIdentifier: cred.accountIdentifier }, async current => {
        const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptChannelCredentialSecret(current.refreshToken), client_id: app.apiKey, client_secret: app.apiSecret }),
        });
        const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
        if (!response.ok) throw Object.assign(new Error('Provider token refresh rejected'), { response: { data: { error: data.error } } });
        if (!data.access_token?.trim() || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new Error('Provider refresh receipt incomplete');
        return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000) };
      });
      return Boolean(result.credential);
    } catch {
      logger.warn({ userId, credentialId: cred.id }, '[linkedinApi] Token refresh unavailable');
      return false;
    }
  }

}

// ── Exported Helper Functions ──

/**
 * Get an initialized LinkedInApiService for a user
 */
export async function getLinkedInApiForUser(userId: number, providerAccountId?: string): Promise<LinkedInApiService | null> {
  const service = new LinkedInApiService();
  const initialized = await service.initializeForUser(userId, providerAccountId);
  return initialized ? service : null;
}

/**
 * Check if a user has LinkedIn API credentials
 */
export async function hasLinkedInApiCredentials(userId: number): Promise<boolean> {
  const [cred] = await db.select({
    accessToken: channelCredentialsTable.accessToken,
    accountIdentifier: channelCredentialsTable.accountIdentifier,
    credentialType: channelCredentialsTable.credentialType,
    tokenExpiry: channelCredentialsTable.tokenExpiry,
  })
    .from(channelCredentialsTable)
    .where(and(
      eq(channelCredentialsTable.userId, userId),
      eq(channelCredentialsTable.platform, 'linkedin_api'),
      eq(channelCredentialsTable.isActive, true)
    ))
    .limit(1);

  return Boolean(
    cred?.accessToken
    && cred.accountIdentifier
    && cred.credentialType === 'oauth'
    && (!cred.tokenExpiry || new Date(cred.tokenExpiry).getTime() > Date.now())
  );
}

/**
 * Send a LinkedIn DM — top-level helper for outreach controller
 */
export async function sendLinkedInDM(params: {
  recipientUrn: string;
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
    assertCustomerDeliveryRuntime('linkedin');
    const service = await getLinkedInApiForUser(params.userId, params.providerAccountId);
    if (!service) {
      return {
        success: false,
        error: 'LinkedIn OAuth with approved messaging permissions is required. Browser fallback is disabled.',
        deliveryAttempted: false,
        outcomeUnknown: false,
        retryable: false,
      };
    }

    const result = await service.sendMessage(params.recipientUrn, params.message);
    if (result.success && result.messageId) {
      return {
        success: true,
        externalMessageId: result.messageId,
        deliveryAttempted: true,
        outcomeUnknown: false,
        retryable: false,
      };
    }

    return {
      success: false,
      error: result.error || 'LinkedIn did not return a message receipt. Manual review is required before retrying.',
      deliveryAttempted: result.deliveryAttempted === true,
      outcomeUnknown: result.outcomeUncertain === true || result.success,
      retryable: result.deliveryAttempted !== true || result.outcomeUncertain === false,
    };
  } catch (error) {
    logger.error({ err: error }, '[LinkedInApi] sendLinkedInDM error');
    const { deliverySetupFailure } = await import('./assistants/CustomerDeliveryGate.js');
    const setup = deliverySetupFailure(error);
    if (setup) return { ...setup, outcomeUnknown: false };
    return {
      success: false,
      error: 'LinkedIn delivery could not be confirmed. Review provider history before retrying.',
      deliveryAttempted: true,
      outcomeUnknown: true,
      retryable: false,
    };
  }
}
