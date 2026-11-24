import { metaRetryable, providerRetryAfter } from './outreach/providerRetry.js';
import { normalizeCapacityError } from './billing/entitlements.js';
/**
 * Instagram Graph API Service
 * Official Meta Graph API integration for Instagram messaging
 * 
 * This service uses the official Instagram Messaging API to:
 * - Send direct messages to users
 * - Fetch conversations/inbox
 * - Get message history
 * - Handle message reactions
 * 
 * Requirements:
 * - Facebook App with Instagram Messaging permissions
 * - Instagram Business or Creator account connected to a Facebook Page
 * - User must have granted instagram_manage_messages permission
 * 
 * API Docs: https://developers.facebook.com/docs/messenger-platform/instagram
 */

import { db } from '../models/db';
import { eq, and } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { getCredential } from './credentialService';
import { logger } from '../utils/logger.js';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, deliverySetupFailure } from './assistants/CustomerDeliveryGate.js';
import { getGraphApiVersion, getGraphApiBase } from '../utils/metaApiVersion.js';
import { isDirectInstagramLogin, isUsableInstagramCredential } from '../utils/instagramOAuthCredential.js';
import { refreshInstagramLoginToken, subscribeInstagramLoginAccount } from './integrations/InstagramLogin.js';
import { boundMetaPageToken, decryptMetaSecret, encryptMetaSecret, metaSessionMetadata } from '../utils/metaCredentialSecrets.js';
import { getChannelCredentialEncryptionKeyId } from '../utils/channelCredentialSecrets.js';
import { metaPageConnectionsTable } from '../models/metaPageConnections/schema';
import {
  resolveInstagramAccountContext,
  type InstagramAccountSelector,
} from './instagramAccountSelectionService.js';
import type { SupportChoiceManifest } from './agents/orchestration/SupportChoiceDelivery.js';
import { buildMetaQuickReplies } from './agents/orchestration/SupportChoiceDelivery.js';

// Keep synchronous constants for backward-compat in module-level code
const GRAPH_API_VERSION = 'v25.0';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Environment configuration
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const APP_URL = process.env.APP_URL || process.env.API_URL;

/**
 * Get Meta credentials (appId + appSecret) from admin configuration.
 * Falls back to per-user api_credentials for backward compatibility.
 */
export async function getUserMetaCredentials(userId: number): Promise<{ appId: string; appSecret: string } | null> {
  // Primary: admin-managed credentials
  try {
    const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions');
    const adminCred = await getActiveAdminCredential('meta_app');
    if (adminCred?.apiKey && adminCred?.apiSecret) {
      return { appId: adminCred.apiKey, appSecret: adminCred.apiSecret };
    }
  } catch { /* fallback below */ }

  // Fallback: legacy per-user credentials
  const cred = await getCredential(userId, 'meta');
  if (cred?.apiKey && cred?.apiSecret) {
    return { appId: cred.apiKey, appSecret: cred.apiSecret };
  }
  return null;
}

export interface InstagramApiCredentials {
  accessToken: string;
  instagramAccountId: string;
  pageId: string;
  useInstagramLogin?: boolean;
  pageAccessToken?: string;
  username?: string;
  expiresAt?: Date;
}

export interface InstagramConversation {
  id: string;
  participants: {
    data: Array<{
      id: string;
      username?: string;
      name?: string;
    }>;
  };
  messages?: {
    data: Array<InstagramMessage>;
  };
  updatedTime?: string;
  unreadCount?: number;
}

export interface InstagramMessage {
  id: string;
  message?: string;
  from: {
    id: string;
    username?: string;
    name?: string;
  };
  to?: {
    data: Array<{
      id: string;
      username?: string;
    }>;
  };
  created_time: string;
  attachments?: {
    data: Array<{
      type: string;
      url?: string;
      name?: string;
      payload?: { id?: string; url?: string };
    }>;
  };
  reactions?: {
    data: Array<{
      reaction: string;
      username: string;
    }>;
  };
  is_unsupported?: boolean;
}

export interface SendMessageResult {
  code?: string;
  reason?: string;
  setupUrl?: string;
  retryable?: boolean;
  providerCode?: number;
  retryAt?: string;
  success: boolean;
  messageId?: string;
  recipientId?: string;
  attachmentId?: string;
  error?: string;
  errorCode?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
}

interface MetaGraphRequestError extends Error {
  code?: string;
  providerCode?: number;
  providerSubcode?: number;
  retryable?: boolean;
  retryAt?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
}

function createMetaGraphRequestError(input: {
  message: string;
  status: number;
  method: 'GET' | 'POST' | 'DELETE';
  providerCode?: number;
  providerSubcode?: number;
  retryAt?: string;
}): MetaGraphRequestError {
  const error = new Error(input.message) as MetaGraphRequestError;
  error.code = input.providerCode
    ? `META_GRAPH_${input.providerCode}`
    : `META_HTTP_${input.status}`;
  error.providerCode = input.providerCode;
  error.providerSubcode = input.providerSubcode;
  error.retryAt = input.retryAt;
  error.retryable = metaRetryable(input.providerCode, input.status);
  error.deliveryAttempted = input.method === 'POST';
  // An unstructured gateway error after a POST is not proof of rejection.
  error.outcomeUncertain = input.method === 'POST' && !input.providerCode && input.status >= 500;
  return error;
}

export interface ConversationListResult {
  success: boolean;
  conversations?: InstagramConversation[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
  };
  error?: string;
}

export interface MessageListResult {
  success: boolean;
  messages?: InstagramMessage[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
  };
  error?: string;
}

/**
 * Instagram Graph API Service Class
 */
export class InstagramGraphApiService {
  private credentials: InstagramApiCredentials | null = null;
  private userId: number | null = null;
  private credentialId: number | null = null;

  constructor() {}

  /**
   * Initialize service with user credentials from database
   */
  async initializeForUser(userId: number, selector: InstagramAccountSelector = {}): Promise<boolean> {
    try {
      this.userId = userId;

      const accountContext = await resolveInstagramAccountContext(userId, selector);
      if (!accountContext) {
        logger.info({ userId: userId }, '[InstagramGraphApi] No API credentials found for user');
        return false;
      }

      const { credential: cred, connection } = accountContext;
      if (!isUsableInstagramCredential(cred)) {
        logger.warn({ userId }, '[InstagramGraphApi] Incomplete credential rejected');
        return false;
      }
      this.credentialId = cred.id;
      this.credentials = {
        accessToken: decryptMetaSecret(cred.accessToken),
        instagramAccountId: cred.accountIdentifier || '',
        pageId: isDirectInstagramLogin(cred) ? cred.accountIdentifier || '' : connection?.pageId || cred.accountIdentifier || '',
        useInstagramLogin: isDirectInstagramLogin(cred),
        pageAccessToken: decryptMetaSecret(boundMetaPageToken(cred) || connection?.pageAccessToken || cred.accessToken),
        username: cred.accountName || undefined,
        expiresAt: cred.tokenExpiry || undefined,
      };

      // H10: Proactive refresh — refresh if expired OR within 7 days of expiry
      const now = Date.now();
      const expiresAtMs = cred.tokenExpiry ? new Date(cred.tokenExpiry).getTime() : 0;
      const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
      if (cred.credentialType === 'oauth' && expiresAtMs && (expiresAtMs < now || expiresAtMs - now < REFRESH_WINDOW_MS)) {
        logger.info({ userId, expiresAt: cred.tokenExpiry }, '[InstagramGraphApi] Token near/past expiry, refreshing');
        const refreshed = await this.refreshAccessToken(decryptMetaSecret(cred.accessToken || cred.refreshToken || ''));
        if (!refreshed && expiresAtMs < now) {
          // Only fail if already expired; if just within window, continue with current token
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error({ err: error }, '[InstagramGraphApi] Error initializing');
      return false;
    }
  }

  /**
   * Set credentials directly (for testing or manual initialization)
   */
  setCredentials(credentials: InstagramApiCredentials): void {
    this.credentials = credentials;
  }

  /**
   * Check if service is initialized with valid credentials
   */
  isInitialized(): boolean {
    return !!(this.credentials?.accessToken && this.credentials?.instagramAccountId);
  }

  /**
   * Get current credentials info (without sensitive data)
   */
  getCredentialsInfo(): { instagramAccountId?: string; username?: string; expiresAt?: Date } | null {
    if (!this.credentials) return null;
    return {
      instagramAccountId: this.credentials.instagramAccountId,
      username: this.credentials.username,
      expiresAt: this.credentials.expiresAt,
    };
  }

  /**
   * Make a Graph API request
   */
  private async graphRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    data?: Record<string, unknown>,
    usePageToken = false,
    graphHost?: 'facebook' | 'instagram',
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Instagram API credentials not initialized');
    }

    const token = usePageToken && this.credentials.pageAccessToken 
      ? this.credentials.pageAccessToken 
      : this.credentials.accessToken;

    // Use admin-configured Graph API version when available
    const version = await getGraphApiVersion();
    const base = (this.credentials.useInstagramLogin || graphHost === 'instagram')
      ? `https://graph.instagram.com/${version}`
      : getGraphApiBase(version);
    const url = new URL(`${base}${endpoint}`);
    
    if (method === 'GET') {
      if (data) {
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined && value !== null) {
            url.searchParams.append(key, String(value));
          }
        }
      }
    }

    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    if (method === 'POST') {
      options.body = JSON.stringify(data || {});
    }

    if (method === 'POST' && endpoint.endsWith('/messages')) {
      await assertCustomerDeliveryReady({ userId: this.userId || 0, channel: 'instagram', accountId: this.credentials.instagramAccountId });
    }
    const response = await fetch(url.toString(), options);
    const responseData = await response.json() as T & { error?: { message: string; code: number; type: string; error_subcode?: number } };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!response.ok || (responseData as any).error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const error = (responseData as any).error;

      // Detect expired/invalid token (OAuthException code 190) and attempt one refresh
      const isTokenExpired = error?.type === 'OAuthException' || error?.code === 190 || response.status === 401;
      if (isTokenExpired && this.credentials) {
        let retryDispatched = false;
        try {
          logger.info('[InstagramGraphApi] Token expired, attempting refresh...');
          await this.refreshAccessToken();
          // Retry request once with the new token
          const retryToken = usePageToken && this.credentials.pageAccessToken
            ? this.credentials.pageAccessToken
            : this.credentials.accessToken;
          const retryHeaders = new Headers(options.headers);
          retryHeaders.set('Authorization', `Bearer ${retryToken}`);
          options.headers = retryHeaders;
          if (method === 'POST' && endpoint.endsWith('/messages')) {
            await assertCustomerDeliveryReady({ userId: this.userId || 0, channel: 'instagram', accountId: this.credentials.instagramAccountId });
          }
          retryDispatched = method === 'POST';
          const retryResponse = await fetch(url.toString(), options);
          const retryData = await retryResponse.json() as T & { error?: { message: string; code: number; type: string } };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (!retryResponse.ok || (retryData as any).error) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const retryError = (retryData as any).error;
            throw createMetaGraphRequestError({
              message: retryError?.message || `Graph API retry failed: ${retryResponse.status}`,
              status: retryResponse.status,
              method,
              providerCode: retryError?.code,
              providerSubcode: retryError?.error_subcode,
              retryAt:providerRetryAfter(retryResponse.headers.get('retry-after')),
            });
          }
          return retryData;
        } catch (refreshErr) {
          if (deliverySetupFailure(refreshErr)) throw refreshErr;
          if (retryDispatched && (refreshErr as MetaGraphRequestError)?.outcomeUncertain !== false) {
            throw Object.assign(refreshErr instanceof Error ? refreshErr : new Error('Meta retry outcome is unknown.'), {
              deliveryAttempted: true, outcomeUncertain: true,
            });
          }
          logger.error({ err: refreshErr }, '[InstagramGraphApi] Token refresh failed during retry');
        }
      }

      throw createMetaGraphRequestError({
        message: error?.message || `Graph API request failed: ${response.status}`,
        status: response.status,
        method,
        providerCode: error?.code,
        providerSubcode: error?.error_subcode,
        retryAt:providerRetryAfter(response.headers.get('retry-after')),
      });
    }

    return responseData;
  }

  /**
   * Send a direct message to an Instagram user
   * Note: Can only message users who have previously messaged the business account
   * 
   * @param recipientId - Instagram-scoped user ID (IGSID)
   * @param message - Text message to send
   */
  async sendMessage(recipientId: string, message: string, choice?: SupportChoiceManifest): Promise<SendMessageResult> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    try {
      // Direct login routes by Instagram user ID; legacy credentials route by Page ID.
      const pageId = this.credentials.pageId;
      const endpoint = `/${pageId}/messages`;
      
      const quickReplies = choice ? buildMetaQuickReplies(choice) : undefined;
      const result = await this.graphRequest<{ recipient_id: string; message_id: string }>(
        endpoint,
        'POST',
        {
          recipient: { id: recipientId },
          message: {
            text: quickReplies ? choice!.prompt : message,
            ...(quickReplies ? { quick_replies: quickReplies } : {}),
          },
          ...(this.credentials.useInstagramLogin ? {} : { messaging_type: 'RESPONSE' }),
        },
        true // Use page access token
      );

      logger.info({ result: result }, '[InstagramGraphApi] Message sent via Page API');

      return {
        success: true,
        messageId: result.message_id,
        recipientId: result.recipient_id,
        deliveryAttempted: true,
        outcomeUncertain: false,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Send message error');
      const setupFailure = deliverySetupFailure(error);
      if (setupFailure) return { ...setupFailure, errorCode: setupFailure.code };
      return {
        success: false,
        error: error.message,
        errorCode: error.code,
        providerCode: error.providerCode,
        retryable: error.retryable === true,
        retryAt: error.retryAt,
        deliveryAttempted: error?.deliveryAttempted === true,
        outcomeUncertain: typeof error?.outcomeUncertain === 'boolean'
          ? error.outcomeUncertain
          : error?.deliveryAttempted === true,
      };
    }
  }

  /**
   * Send a message with an attachment (image, video, etc.)
   */
  async sendMessageWithAttachment(
    recipientId: string,
    attachmentType: 'image' | 'video' | 'audio' | 'file',
    attachmentUrl: string,
    _message?: string
  ): Promise<SendMessageResult> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    let deliveryAttempted = false;
    try {
      const message = {
        attachment: {
          type: attachmentType,
          payload: { url: attachmentUrl },
        },
      };

      // Facebook Login installations use the linked Page transport. This is
      // attempted first because it matches the token and recipient namespace
      // used for the already-working text conversation.
      deliveryAttempted = true;
      try {
        const pageResult = await this.graphRequest<{ recipient_id: string; message_id: string }>(
          `/${this.credentials.pageId}/messages`,
          'POST',
          {
            recipient: { id: recipientId },
            message,
            ...(this.credentials.useInstagramLogin ? {} : { messaging_type: 'RESPONSE' }),
          },
          true,
        );
        if (!pageResult.message_id) throw Object.assign(new Error('Instagram returned no message acknowledgement.'), { outcomeUncertain: true });
        return {
          success: true,
          messageId: pageResult.message_id,
          recipientId: pageResult.recipient_id,
          deliveryAttempted,
          outcomeUncertain: false,
        };
      } catch (pageError) {
        if (deliverySetupFailure(pageError)) throw pageError;
        // Never try another transport after a network timeout or otherwise
        // ambiguous mutation. A second send could duplicate an accepted image.
        if ((pageError as MetaGraphRequestError)?.outcomeUncertain !== false) throw pageError;
      }

      // Instagram Login and newer account-scoped installations use Meta's
      // Instagram Send API host. A confirmed Page rejection is safe to fall
      // through because Meta explicitly reported that no message was accepted.
      const result = await this.graphRequest<{ recipient_id: string; message_id: string }>(
        `/${this.credentials.instagramAccountId}/messages`,
        'POST',
        {
          recipient: { id: recipientId },
          message,
        },
        false,
        'instagram',
      );

      if (!result.message_id) throw Object.assign(new Error('Instagram returned no message acknowledgement.'), { outcomeUncertain: true });

      return {
        success: true,
        messageId: result.message_id,
        recipientId: result.recipient_id,
        deliveryAttempted,
        outcomeUncertain: false,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Send attachment error');
      const setupFailure = deliverySetupFailure(error);
      if (setupFailure) return { ...setupFailure, errorCode: setupFailure.code };
      return {
        success: false,
        error: error.message,
        errorCode: error.code,
        providerCode: error.providerCode,
        retryable: error.retryable === true,
        retryAt: error.retryAt,
        deliveryAttempted,
        outcomeUncertain: typeof error?.outcomeUncertain === 'boolean'
          ? error.outcomeUncertain
          : deliveryAttempted,
      };
    }
  }

  /**
   * Get conversations (inbox) for the Instagram business account
   */
  async getConversations(
    limit = 20,
    cursor?: string
  ): Promise<ConversationListResult> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    try {
      // Use the Page API endpoint for conversations (works for both FB and IG)
      const endpoint = `/${this.credentials.pageId}/conversations`;
      
      const params: Record<string, unknown> = {
        fields: 'id,participants,messages{id,message,from,to,created_time,attachments,reactions,is_unsupported},updated_time',
        limit,
        platform: 'instagram',
      };

      if (cursor) {
        params.after = cursor;
      }

      const result = await this.graphRequest<{
        data: InstagramConversation[];
        paging?: { cursors?: { before?: string; after?: string }; next?: string };
      }>(endpoint, 'GET', params, true);

      return {
        success: true,
        conversations: result.data || [],
        paging: result.paging,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Get conversations error');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get messages from a specific conversation
   */
  async getConversationMessages(
    conversationId: string,
    limit = 50,
    cursor?: string
  ): Promise<MessageListResult> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    try {
      const endpoint = `/${conversationId}/messages`;
      
      const params: Record<string, unknown> = {
        fields: 'id,message,from,to,created_time,attachments,reactions,is_unsupported',
        limit,
      };

      if (cursor) {
        params.after = cursor;
      }

      const result = await this.graphRequest<{
        data: InstagramMessage[];
        paging?: { cursors?: { before?: string; after?: string }; next?: string };
      }>(endpoint, 'GET', params, true);

      return {
        success: true,
        messages: result.data || [],
        paging: result.paging,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Get messages error');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get a specific message by ID
   */
  async getMessage(messageId: string): Promise<{ success: boolean; message?: InstagramMessage; error?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    try {
      const endpoint = `/${messageId}`;
      
      const result = await this.graphRequest<InstagramMessage>(
        endpoint,
        'GET',
        { fields: 'id,message,from,to,created_time,attachments,reactions,is_unsupported' },
        true
      );

      return {
        success: true,
        message: result,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Get message error');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get user profile information
   */
  async getUserProfile(userId: string): Promise<{ 
    success: boolean; 
    profile?: { id: string; username?: string; name?: string; profile_pic?: string };
    error?: string;
  }> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    try {
      const endpoint = `/${userId}`;
      
      const result = await this.graphRequest<{
        id: string;
        username?: string;
        name?: string;
      }>(endpoint, 'GET', { fields: 'id,username,name' }, true);

      return {
        success: true,
        profile: result,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Get user profile error');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Refresh the access token using the token from meta_page_connections
   */
  async refreshAccessToken(_unusedToken?: string): Promise<boolean> {
    if (!this.userId) {
      logger.error('[InstagramGraphApi] User ID not set, cannot refresh token');
      return false;
    }

    const accountIdentifier = this.credentials?.instagramAccountId;
    const accountContext = accountIdentifier
      ? await resolveInstagramAccountContext(this.userId, { accountIdentifier })
      : null;
    const conn = accountContext?.connection;
    if (!conn) {
      logger.error('[InstagramGraphApi] No active meta_page_connection found for refresh');
      return false;
    }
    const userToken = decryptMetaSecret(accountContext?.credential.accessToken || conn.userAccessToken || conn.pageAccessToken);

    if (!userToken) {
      logger.error('[InstagramGraphApi] No user_access_token in meta_page_connections');
      return false;
    }

    const useFacebookEndpoint = !isDirectInstagramLogin(accountContext?.credential);
    try {
      let data: { access_token?: string; expires_in?: number; error?: { message: string } };
      if (!useFacebookEndpoint) {
        const refreshed = await refreshInstagramLoginToken(userToken);
        data = { access_token: refreshed.accessToken, expires_in: refreshed.expiresIn };
      } else {
        const metaCreds = await getUserMetaCredentials(this.userId);
        if (!metaCreds) return false;
        const response = await fetch(`${getGraphApiBase(await getGraphApiVersion())}/oauth/access_token`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: metaCreds.appId,
            client_secret: metaCreds.appSecret, fb_exchange_token: userToken }),
          signal: AbortSignal.timeout(15_000),
        });
        data = await response.json() as typeof data;
        if (!response.ok) return false;
      }

      if (data.error) {
        logger.error({ err: data.error }, '[InstagramGraphApi] Token refresh failed');
        return false;
      }

      if (data.access_token && this.userId) {
        // Calculate new expiry
        const expiresAt = new Date();
        expiresAt.setSeconds(expiresAt.getSeconds() + (data.expires_in || 5184000)); // Default 60 days

        // Update meta_page_connections
        await db.update(metaPageConnectionsTable)
          .set({
            userAccessToken: encryptMetaSecret(data.access_token)!,
            pageAccessToken: useFacebookEndpoint ? conn.pageAccessToken : encryptMetaSecret(data.access_token)!,
            tokenExpiry: expiresAt,
            updatedAt: new Date(),
          })
          .where(eq(metaPageConnectionsTable.id, conn.id));

        // Also update channel_credentials
        await db.update(channelCredentialsTable)
          .set({
            accessToken: encryptMetaSecret(data.access_token),
            ...(!useFacebookEndpoint ? { apiKey: encryptMetaSecret(data.access_token) } : {}),
            tokenExpiry: expiresAt,
            lastRefreshedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(channelCredentialsTable.id, this.credentialId || accountContext.credential.id),
            eq(channelCredentialsTable.userId, this.userId),
            eq(channelCredentialsTable.platform, 'instagram_api')
          ));

        // Update local credentials
        if (this.credentials) {
          this.credentials.accessToken = data.access_token;
          if (!useFacebookEndpoint) this.credentials.pageAccessToken = data.access_token;
          this.credentials.expiresAt = expiresAt;
        }

        logger.info('[InstagramGraphApi] Token refreshed successfully');
        return true;
      }

      return false;
    } catch (error) {
      logger.error({ err: error }, '[InstagramGraphApi] Token refresh error');
      return false;
    }
  }

  /**
   * Subscribe to webhooks for the Instagram account
   * This should be called after OAuth to set up webhook subscriptions
   */
  async subscribeToWebhooks(): Promise<{ success: boolean; error?: string }> {
    if (!this.credentials?.pageId) {
      return { success: false, error: 'Page ID not available' };
    }

    try {
      if (this.credentials.useInstagramLogin) {
        const context = this.userId ? await resolveInstagramAccountContext(this.userId, { accountIdentifier: this.credentials.instagramAccountId }) : null;
        await subscribeInstagramLoginAccount(this.credentials.instagramAccountId, this.credentials.accessToken, context?.credential.grantedScopes || []);
        return { success: true };
      }
      // Subscribe the page to the app's webhooks
      const endpoint = `/${this.credentials.pageId}/subscribed_apps`;
      
      await this.graphRequest(
        endpoint,
        'POST',
        {
          subscribed_fields: ['messages', 'message_echoes', 'messaging_postbacks', 'messaging_optins', 'message_deliveries', 'message_reads'],
        },
        true
      );

      logger.info({ pageId: this.credentials.pageId }, '[InstagramGraphApi] Webhook subscription successful for page');
      return { success: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Webhook subscription error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get Instagram Business Account info
   */
  async getBusinessAccountInfo(): Promise<{
    success: boolean;
    account?: {
      id: string;
      username: string;
      name?: string;
      profilePictureUrl?: string;
      followersCount?: number;
      mediaCount?: number;
    };
    error?: string;
  }> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    try {
      const endpoint = `/${this.credentials.instagramAccountId}`;
      
      const result = await this.graphRequest<{
        id: string;
        username: string;
        name?: string;
        profile_picture_url?: string;
        followers_count?: number;
        media_count?: number;
      }>(
        endpoint,
        'GET',
        { fields: 'id,username,name,profile_picture_url,followers_count,media_count' },
        true
      );

      return {
        success: true,
        account: {
          id: result.id,
          username: result.username,
          name: result.name,
          profilePictureUrl: result.profile_picture_url,
          followersCount: result.followers_count,
          mediaCount: result.media_count,
        },
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Get account info error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Reply to a specific message
   */
  async replyToMessage(
    originalMessageId: string,
    recipientId: string,
    replyText: string
  ): Promise<SendMessageResult> {
    // For Instagram, replying is the same as sending, but we can track the original message
    const result = await this.sendMessage(recipientId, replyText);
    
    if (result.success) {
      logger.info({ originalMessageId: originalMessageId }, '[InstagramGraphApi] Replied to message');
    }
    
    return result;
  }

  /**
   * Mark conversation as read (send read receipt)
   */
  async markAsRead(conversationId: string): Promise<{ success: boolean; error?: string }> {
    // Note: Instagram doesn't have an explicit "mark as read" API
    // Read receipts are sent automatically when messages are fetched in some cases
    logger.info({ conversationId: conversationId }, '[InstagramGraphApi] Mark as read not directly supported for conversation');
    return { success: true };
  }

  /**
   * Get ice breaker questions configured for the account
   */
  async getIceBreakers(): Promise<{
    success: boolean;
    iceBreakers?: Array<{ question: string; payload: string }>;
    error?: string;
  }> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    try {
      const endpoint = `/${this.credentials.pageId}/messenger_profile`;
      
      const result = await this.graphRequest<{
        data: Array<{ ice_breakers?: Array<{ question: string; payload: string }> }>;
      }>(endpoint, 'GET', { fields: 'ice_breakers' }, true);

      return {
        success: true,
        iceBreakers: result.data?.[0]?.ice_breakers || [],
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Get ice breakers error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Set ice breaker questions for the account
   */
  async setIceBreakers(
    iceBreakers: Array<{ question: string; payload: string }>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Instagram API credentials not initialized' };
    }

    try {
      const endpoint = `/${this.credentials.pageId}/messenger_profile`;
      
      await this.graphRequest(
        endpoint,
        'POST',
        {
          platform: 'instagram',
          ice_breakers: iceBreakers,
        },
        true
      );

      return { success: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[InstagramGraphApi] Set ice breakers error');
      return { success: false, error: error.message };
    }
  }
}

// Export singleton instance
export const instagramGraphApiService = new InstagramGraphApiService();

/**
 * Helper function to get Instagram API service initialized for a user
 */
export async function getInstagramApiForUser(
  userId: number,
  selector: InstagramAccountSelector = {},
): Promise<InstagramGraphApiService | null> {
  const service = new InstagramGraphApiService();
  const initialized = await service.initializeForUser(userId, selector);
  return initialized ? service : null;
}

/**
 * Check if user has Instagram API credentials configured
 */
export async function hasInstagramApiCredentials(userId: number): Promise<boolean> {
  try {
    const accountContext = await resolveInstagramAccountContext(userId);
    return isUsableInstagramCredential(accountContext?.credential);
  } catch (error) {
    logger.error({ err: error }, '[InstagramGraphApi] Error checking credentials');
    return false;
  }
}

/**
 * Find Instagram-scoped user ID (IGSID) by username from existing conversations
 * Instagram Graph API only allows messaging users who have already messaged you
 */
export async function findUserIgsidByUsername(
  userId: number,
  targetUsername: string,
  selector: InstagramAccountSelector = {},
): Promise<{ igsid: string | null; error?: string }> {
  try {
    const service = await getInstagramApiForUser(userId, selector);
    if (!service) {
      return { igsid: null, error: 'Instagram Graph API not configured' };
    }

    // Get all conversations to find the user
    const conversations = await service.getConversations(100);
    if (!conversations.success || !conversations.conversations) {
      return { igsid: null, error: 'Failed to retrieve conversations' };
    }

    // Search through participants to find the username
    for (const conversation of conversations.conversations) {
      if (conversation.participants?.data) {
        for (const participant of conversation.participants.data) {
          if (participant.username?.toLowerCase() === targetUsername.toLowerCase()) {
            return { igsid: participant.id };
          }
        }
      }
    }

    return { igsid: null, error: `User @${targetUsername} not found in existing conversations. Instagram Graph API only allows messaging users who have messaged you first.` };
  } catch (error) {
    logger.error({ err: error }, '[InstagramGraphApi] Error finding IGSID');
    return { igsid: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Send message to a user by username (wrapper that handles IGSID lookup)
 */
export async function sendMessageByUsername(
  userId: number,
  targetUsername: string,
  message: string,
  selector: InstagramAccountSelector = {},
): Promise<SendMessageResult> {
  try {
    assertCustomerDeliveryRuntime('instagram');
    const context = await resolveInstagramAccountContext(userId, selector);
    await assertCustomerDeliveryReady({ userId, channel: 'instagram', accountId: context?.credential.accountIdentifier || '' });
    const service = await getInstagramApiForUser(userId, selector);
    if (!service) {
      return { success: false, error: 'Instagram Graph API not configured' };
    }

    // First, try to find the user's IGSID from existing conversations
    const lookupResult = await findUserIgsidByUsername(userId, targetUsername, selector);
    
    if (!lookupResult.igsid) {
      return { 
        success: false, 
        error: lookupResult.error || `Cannot find user @${targetUsername}. They must message you first for Instagram Graph API to work.` 
      };
    }

    // Send the message using the IGSID
    const sendResult = await service.sendMessage(lookupResult.igsid, message);
    
    return sendResult;
  } catch (error) {
    logger.error({ err: error }, '[InstagramGraphApi] Error sending message by username');
    const setupFailure = deliverySetupFailure(error);
    if (setupFailure) return { ...setupFailure, errorCode: setupFailure.code };
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Store Instagram API credentials after OAuth
 */
export async function storeInstagramApiCredentials(
  userId: number,
  credentials: {
    accessToken: string;
    refreshToken?: string;
    instagramAccountId: string;
    pageId: string;
    pageAccessToken: string;
    username: string;
    expiresIn?: number;
    connectedViaOAuth?: boolean;
    connectedViaManual?: boolean;
    useInstagramLogin?: boolean;
    grantedScopes?: string[];
    declinedScopes?: string[];
  }
): Promise<boolean> {
  try {
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (credentials.expiresIn || 5184000)); // Default 60 days

    await db.transaction(async (tx: typeof db) => {
      const [existing] = await tx.select()
        .from(channelCredentialsTable)
        .where(and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'instagram_api'),
          eq(channelCredentialsTable.accountIdentifier, credentials.instagramAccountId),
        ))
        .limit(1);

      const previousSession = metaSessionMetadata(existing?.sessionData);
      const sessionData = {
        ...previousSession,
        pageTokenBound: credentials.connectedViaOAuth === true,
        pageId: credentials.pageId || credentials.instagramAccountId,
        ...(credentials.connectedViaOAuth ? { connectedViaOAuth: true, connectedAt: new Date().toISOString() } : {}),
        ...(credentials.connectedViaManual ? { connectedViaManual: true } : {}),
        useInstagramLogin: credentials.useInstagramLogin === true,
        ...(credentials.declinedScopes ? { declinedScopes: credentials.declinedScopes } : {}),
      };

      await tx.update(channelCredentialsTable).set({ isSelected: false, updatedAt: new Date() }).where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'instagram_api'),
      ));

      const credentialValues = {
        credentialType: 'oauth',
        ...(credentials.grantedScopes ? { grantedScopes: credentials.grantedScopes, readinessErrorCode: null, providerVerifiedAt: null, lastReadinessCheckAt: null } : {}),
        accessToken: encryptMetaSecret(credentials.accessToken),
        apiKey: encryptMetaSecret(credentials.pageAccessToken),
        refreshToken: encryptMetaSecret(credentials.refreshToken),
        tokenExpiry: expiresAt,
        accountIdentifier: credentials.instagramAccountId,
        accountName: credentials.username,
        sessionData,
        isActive: true,
        isSelected: true,
        deactivationReason: null,
        deactivatedAt: null,
        lastRefreshedAt: new Date(),
        encryptionVersion: 'secrets-manager-v1',
        encryptionKeyId: getChannelCredentialEncryptionKeyId(),
        encryptedAt: new Date(),
        updatedAt: new Date(),
      };

      if (existing) {
        await tx.update(channelCredentialsTable)
          .set(credentialValues)
          .where(eq(channelCredentialsTable.id, existing.id));
      } else {
        await tx.insert(channelCredentialsTable)
          .values({ userId, platform: 'instagram_api', ...credentialValues });
      }
    });

    logger.info({ userId: userId }, '[InstagramGraphApi] Credentials stored for user');
    return true;
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) throw capacityError;
    logger.error({ err: error }, '[InstagramGraphApi] Error storing credentials');
    return false;
  }
}
