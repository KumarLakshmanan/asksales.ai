import { metaRetryable, providerRetryAfter } from './outreach/providerRetry.js';
/**
 * Facebook Messenger Service
 * Meta Graph API integration for Facebook Messenger messaging
 *
 * This service handles:
 * - Sending direct messages to users via Page Messaging
 * - Fetching conversations from the page inbox
 * - Getting message history
 *
 * Requirements:
 * - Facebook App with pages_messaging permissions
 * - Facebook Page connected to the app
 * - User must have granted pages_messaging, pages_manage_metadata permissions
 *
 * API Docs: https://developers.facebook.com/docs/messenger-platform
 */

import { db } from '../models/db';
import { eq, and, desc, sql } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { logger } from '../utils/logger.js';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, deliverySetupFailure } from './assistants/CustomerDeliveryGate.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { getGraphApiVersion, getGraphApiBase } from '../utils/metaApiVersion.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { outreachConversationsTable } from '../models/outreachConversations/schema';
import { outreachMessagesTable } from '../models/outreachConversations/schema';
import { boundMetaPageToken, decryptMetaSecret } from '../utils/metaCredentialSecrets.js';
import { metaPageConnectionsTable } from '../models/metaPageConnections/schema';
import type { SupportChoiceManifest } from './agents/orchestration/SupportChoiceDelivery.js';
import { buildMetaQuickReplies } from './agents/orchestration/SupportChoiceDelivery.js';

// Meta/Facebook API version (resolved dynamically from admin config)
// Sync constants kept for module-level code compatibility
const GRAPH_API_VERSION = 'v25.0';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ── Interfaces ──

export interface FacebookCredentials {
  accessToken: string;
  pageId: string;
  pageName?: string;
  expiresAt?: Date;
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
  error?: string;
  errorCode?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
}

export interface FacebookConversation {
  id: string;
  participants: {
    data: Array<{ id: string; name?: string; email?: string }>;
  };
  messages?: {
    data: Array<FacebookMessage>;
  };
  updatedTime?: string;
  unreadCount?: number;
}

export interface FacebookMessage {
  id: string;
  message?: string;
  from: { id: string; name?: string };
  to?: { data: Array<{ id: string; name?: string }> };
  created_time: string;
  attachments?: {
    data: Array<{ type: string; url?: string; size?: number; name?: string; payload?: { id?: string; url?: string } }>;
  };
}

export interface ConversationListResult {
  success: boolean;
  conversations?: FacebookConversation[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string };
  error?: string;
}

export interface MessageListResult {
  success: boolean;
  messages?: FacebookMessage[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string };
  error?: string;
}

export interface PageInfoResult {
  success: boolean;
  pageId?: string;
  name?: string;
  category?: string;
  fanCount?: number;
  followersCount?: number;
  picture?: string;
  error?: string;
}

// ── Service Class ──

export class FacebookMessengerService {
  private credentials: FacebookCredentials | null = null;
  private userId: number | null = null;

  constructor() {}

  /**
   * Initialize service with user credentials from database
   */
  async initializeForUser(userId: number, providerAccountId?: string): Promise<boolean> {
    try {
      this.userId = userId;

      const credentialPredicates = [
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'facebook_api'),
        eq(channelCredentialsTable.isActive, true),
      ];
      if (providerAccountId) {
        credentialPredicates.push(eq(channelCredentialsTable.accountIdentifier, providerAccountId));
      }
      const [cred] = await db.select()
        .from(channelCredentialsTable)
        .where(and(...credentialPredicates))
        .orderBy(desc(channelCredentialsTable.isSelected), desc(channelCredentialsTable.updatedAt))
        .limit(1);

      if (!cred || !['oauth', 'manual'].includes(cred.credentialType) || !cred.accessToken) {
        logger.info({ userId }, '[FacebookMessenger] No API credentials found for user');
        return false;
      }

      const [connection] = await db.select({ pageId: metaPageConnectionsTable.pageId, pageAccessToken: metaPageConnectionsTable.pageAccessToken })
        .from(metaPageConnectionsTable)
        .where(and(
          eq(metaPageConnectionsTable.userId, userId),
          eq(metaPageConnectionsTable.pageId, cred.accountIdentifier || ''),
          eq(metaPageConnectionsTable.isActive, true),
          eq(metaPageConnectionsTable.facebookActive, true),
        ))
        .limit(1);

      this.credentials = {
        // Prefer Page Access Token (required for /{pageId}/messages) over User Access Token
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        accessToken: decryptMetaSecret(boundMetaPageToken(cred) || connection?.pageAccessToken || cred.accessToken),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pageId: connection?.pageId || cred.accountIdentifier || '',
        pageName: cred.accountName || undefined,
        expiresAt: cred.tokenExpiry || undefined,
      };

      return true;
    } catch (error) {
      logger.error({ err: error }, '[FacebookMessenger] Error initializing');
      return false;
    }
  }

  /**
   * Check if service is initialized with valid credentials
   */
  isInitialized(): boolean {
    return !!(this.credentials?.accessToken && this.credentials?.pageId);
  }

  /**
   * Send a message to a recipient via Page Messaging
   */
  async sendMessage(
    recipientId: string,
    messageText: string,
    choice?: SupportChoiceManifest,
    webUrlAction?: { title: string; url: string },
  ): Promise<SendMessageResult> {
    if (!this.credentials) {
      return { success: false, error: 'Facebook credentials not initialized' };
    }

    if (!this.credentials.pageId) {
      return { success: false, error: 'Facebook Page ID not configured' };
    }

    let deliveryAttempted = false;
    try {
      const version = await getGraphApiVersion();
      const apiBase = getGraphApiBase(version);
      const quickReplies = choice ? buildMetaQuickReplies(choice) : undefined;
      const webUrl = webUrlAction ? new URL(webUrlAction.url) : null;
      if (webUrl && (webUrl.protocol !== 'https:' || webUrl.username || webUrl.password)) {
        return { success: false, error: 'Facebook web URL action requires a credential-free HTTPS URL.' };
      }
      const message = webUrl ? {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: messageText,
            buttons: [{ type: 'web_url', url: webUrlAction!.url, title: webUrlAction!.title.slice(0, 20) || 'Book now' }],
          },
        },
      } : {
        text: quickReplies ? choice!.prompt : messageText,
        ...(quickReplies ? { quick_replies: quickReplies } : {}),
      };
      await assertCustomerDeliveryReady({ userId: this.userId || 0, channel: 'facebook', accountId: this.credentials.pageId });
      deliveryAttempted = true;
      const response = await fetch(`${apiBase}/${this.credentials.pageId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.credentials.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message,
          messaging_type: 'RESPONSE',
        }),
      });

      if (response.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await response.json() as any;
        return {
          success: true,
          messageId: data.message_id,
          recipientId: data.recipient_id,
          deliveryAttempted,
          outcomeUncertain: false,
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorData = await response.json().catch(() => null) as any;
      const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
      logger.error({ err: errorMsg, recipientId }, '[FacebookMessenger] Send message failed');
      return { success: false, error: errorMsg, deliveryAttempted,
        outcomeUncertain: !errorData?.error && response.status >= 500,
        providerCode: errorData?.error?.code,
        retryable: metaRetryable(errorData?.error?.code, response.status),
        retryAt: providerRetryAfter(response.headers.get('retry-after')) };
    } catch (error) {
      logger.error({ err: error }, '[FacebookMessenger] Send message error');
      const setupFailure = deliverySetupFailure(error);
      if (setupFailure) return { ...setupFailure, errorCode: setupFailure.code };
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        deliveryAttempted,
        outcomeUncertain: deliveryAttempted,
      };
    }
  }

  async sendMessageWithAttachment(
    recipientId: string,
    attachmentType: 'image' | 'audio' | 'video' | 'file',
    attachmentUrl: string,
    _messageText?: string,
  ): Promise<SendMessageResult> {
    if (!this.credentials?.pageId) return { success: false, error: 'Facebook credentials not initialized' };
    let deliveryAttempted = false;
    try {
      const version = await getGraphApiVersion();
      const apiBase = getGraphApiBase(version);
      const message: Record<string, unknown> = {
        attachment: { type: attachmentType, payload: { url: attachmentUrl, is_reusable: false } },
      };
      // Messenger rejects a message object that contains both `text` and
      // `attachment`. Any owner-approved caption must be sent as its own
      // idempotent text part by the delivery layer.
      await assertCustomerDeliveryReady({ userId: this.userId || 0, channel: 'facebook', accountId: this.credentials.pageId });
      deliveryAttempted = true;
      const response = await fetch(`${apiBase}/${this.credentials.pageId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.credentials.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message,
          messaging_type: 'RESPONSE',
        }),
      });
      const data = await response.json().catch(() => ({})) as { message_id?: string; recipient_id?: string; error?: { message?: string; code?: number } };
      if (!response.ok || data.error || !data.message_id) {
        return {
          success: false,
          error: data.error?.message || `Missing message acknowledgement (HTTP ${response.status})`,
          errorCode: data.error?.code ? `META_GRAPH_${data.error.code}` : `META_HTTP_${response.status}`,
          deliveryAttempted,
          outcomeUncertain: !data.error && (response.ok || response.status >= 500),
        };
      }
      return {
        success: true,
        messageId: data.message_id,
        recipientId: data.recipient_id,
        deliveryAttempted,
        outcomeUncertain: false,
      };
    } catch (error) {
      const setupFailure = deliverySetupFailure(error);
      if (setupFailure) return { ...setupFailure, errorCode: setupFailure.code };
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Facebook attachment send failed',
        deliveryAttempted,
        outcomeUncertain: deliveryAttempted,
      };
    }
  }

  /**
   * Get conversations (inbox) for the page
   */
  async getConversations(limit = 25): Promise<ConversationListResult> {
    if (!this.credentials) {
      return { success: false, error: 'Facebook credentials not initialized' };
    }

    try {
      const version = await getGraphApiVersion();
      const apiBase = getGraphApiBase(version);
      const url = new URL(`${apiBase}/${this.credentials.pageId}/conversations`);
      url.searchParams.append('fields', 'participants,messages.limit(1){message,from,created_time},updated_time,unread_count');
      url.searchParams.append('limit', String(limit));

      const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${this.credentials.accessToken}` } });

      if (response.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await response.json() as any;
        return {
          success: true,
          conversations: data.data || [],
          paging: data.paging,
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorData = await response.json().catch(() => null) as any;
      return { success: false, error: errorData?.error?.message || `HTTP ${response.status}` };
    } catch (error) {
      logger.error({ err: error }, '[FacebookMessenger] Get conversations error');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get Facebook Page info including follower/fan counts
   */
  async getPageInfo(): Promise<PageInfoResult> {
    if (!this.credentials) {
      return { success: false, error: 'Facebook credentials not initialized' };
    }

    try {
      const version = await getGraphApiVersion();
      const apiBase = getGraphApiBase(version);
      const url = new URL(`${apiBase}/${this.credentials.pageId}`);
      url.searchParams.append('fields', 'id,name,category,fan_count,followers_count,picture{url}');

      const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${this.credentials.accessToken}` } });

      if (response.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await response.json() as any;
        return {
          success: true,
          pageId: data.id,
          name: data.name,
          category: data.category,
          fanCount: data.fan_count,
          followersCount: data.followers_count,
          picture: data.picture?.data?.url,
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorData = await response.json().catch(() => null) as any;
      return { success: false, error: errorData?.error?.message || `HTTP ${response.status}` };
    } catch (error) {
      logger.error({ err: error }, '[FacebookMessenger] Get page info error');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get messages for a specific conversation
   */
  async getConversationMessages(conversationId: string, limit = 25): Promise<MessageListResult> {
    if (!this.credentials) {
      return { success: false, error: 'Facebook credentials not initialized' };
    }

    try {
      const version = await getGraphApiVersion();
      const apiBase = getGraphApiBase(version);
      const url = new URL(`${apiBase}/${conversationId}/messages`);
      url.searchParams.append('fields', 'message,from,to,created_time,attachments');
      url.searchParams.append('limit', String(limit));

      const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${this.credentials.accessToken}` } });

      if (response.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await response.json() as any;
        return {
          success: true,
          messages: data.data || [],
          paging: data.paging,
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorData = await response.json().catch(() => null) as any;
      return { success: false, error: errorData?.error?.message || `HTTP ${response.status}` };
    } catch (error) {
      logger.error({ err: error }, '[FacebookMessenger] Get messages error');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Authenticated message re-fetch used to refresh protected/expiring media URLs. */
  async getMessage(messageId: string): Promise<{ success: boolean; message?: FacebookMessage; error?: string }> {
    if (!this.credentials) return { success: false, error: 'Facebook credentials not initialized' };
    try {
      const version = await getGraphApiVersion();
      const apiBase = getGraphApiBase(version);
      const url = new URL(`${apiBase}/${messageId}`);
      url.searchParams.append('fields', 'id,message,from,to,created_time,attachments');
      const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${this.credentials.accessToken}` } });
      const data = await response.json().catch(() => ({})) as FacebookMessage & { error?: { message?: string } };
      if (!response.ok || !data.id) return { success: false, error: data.error?.message || `HTTP ${response.status}` };
      return { success: true, message: data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Facebook message lookup failed' };
    }
  }
}

// ── Exported Helper Functions ──

/**
 * Get an initialized FacebookMessengerService for a user
 */
export async function getFacebookApiForUser(userId: number, providerAccountId?: string): Promise<FacebookMessengerService | null> {
  const service = new FacebookMessengerService();
  const initialized = await service.initializeForUser(userId, providerAccountId);
  return initialized ? service : null;
}

/**
 * Check if a user has Facebook Messenger API credentials
 */
export async function hasFacebookApiCredentials(userId: number): Promise<boolean> {
  const [cred] = await db.select({
    accessToken: channelCredentialsTable.accessToken,
    accountIdentifier: channelCredentialsTable.accountIdentifier,
    credentialType: channelCredentialsTable.credentialType,
    sessionData: channelCredentialsTable.sessionData,
    tokenExpiry: channelCredentialsTable.tokenExpiry,
  })
    .from(channelCredentialsTable)
    .where(and(
      eq(channelCredentialsTable.userId, userId),
      eq(channelCredentialsTable.platform, 'facebook_api'),
      eq(channelCredentialsTable.isActive, true)
    ))
    .limit(1);

  const pageId = cred?.accountIdentifier;
  const pageToken = cred?.accessToken;
  return Boolean(
    pageId
    && pageToken
    && ['oauth', 'manual'].includes(cred?.credentialType || '')
    && (!cred.tokenExpiry || new Date(cred.tokenExpiry).getTime() > Date.now())
  );
}

/**
 * Get the Facebook daily outreach limit (default 20) for a user / page.
 */
async function getFacebookDailySettings(userId: number, providerAccountId?: string): Promise<{ limit: number; pageId?: string }> {
  try {
    const predicates = [
      eq(channelCredentialsTable.userId, userId),
      eq(channelCredentialsTable.platform, 'facebook_api'),
      eq(channelCredentialsTable.isActive, true),
    ];
    if (providerAccountId) predicates.push(eq(channelCredentialsTable.accountIdentifier, providerAccountId));
    const [cred] = await db.select()
      .from(channelCredentialsTable)
      .where(and(...predicates))
      .orderBy(desc(channelCredentialsTable.isSelected), desc(channelCredentialsTable.updatedAt))
      .limit(1);
    const sd = (cred?.sessionData as { dailyOutreachLimit?: number } | null) || {};
    return {
      limit: typeof sd.dailyOutreachLimit === 'number' ? sd.dailyOutreachLimit : 20,
      pageId: cred?.accountIdentifier || undefined,
    };
  } catch {
    return { limit: 20 };
  }
}

function facebookDailyKey(userId: number, pageId?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return pageId
    ? `facebook:daily_outreach:${userId}:${pageId}:${today}`
    : `facebook:daily_outreach:${userId}:${today}`;
}

async function getFacebookDailyCount(userId: number, pageId?: string): Promise<number> {
  try {
    const redis = getRedisConnection();
    const value = await redis.get(facebookDailyKey(userId, pageId));
    return value ? parseInt(value, 10) : 0;
  } catch {
    return 0;
  }
}

async function incrementFacebookDailyCount(userId: number, pageId?: string): Promise<void> {
  try {
    const redis = getRedisConnection();
    const key = facebookDailyKey(userId, pageId);
    await redis.incr(key);
    await redis.expire(key, 90000); // ~25 hours
  } catch (err) {
    logger.warn({ err }, '[FacebookMessenger] Failed to increment daily counter');
  }
}

/**
 * Check whether the recipient has already replied in any active conversation
 * (so we know to skip the cold-outreach quota).
 */
async function recipientHasReplied(userId: number, recipientId: string, providerAccountId: string): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT 1
      FROM ${outreachConversationsTable} c
      JOIN ${outreachMessagesTable} m ON m.conversation_id = c.id
      WHERE c.user_id = ${userId}
        AND c.channel = 'facebook'
        AND c.provider_account_id = ${providerAccountId}
        AND c.external_thread_id = ${recipientId}
        AND m.direction = 'inbound'
      LIMIT 1
    `);
    return (result.rows?.length || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Send a Facebook DM — top-level helper for outreach controller
 */
export async function sendFacebookDM(params: {
  conversationId?: number;
  recipientId: string;
  message: string;
  userId: number;
  skipOutreachLimits?: boolean;
  /** Bind the reply to the Facebook Page that received the inbound PSID. */
  providerAccountId?: string;
  choice?: SupportChoiceManifest;
  webUrlAction?: { title: string; url: string };
}): Promise<{
  success: boolean;
  code?: string;
  reason?: string;
  setupUrl?: string;
  error?: string;
  externalMessageId?: string;
  method?: string;
  deliveryAttempted?: boolean;
  outcomeUnknown?: boolean;
  retryable?: boolean;
  providerCode?: number;
  retryAt?: string;
}> {
  try {
    assertCustomerDeliveryRuntime('facebook');
    const { resolveMetaSendAccount } = await import('./outreach/MetaSendAccount.js');
    const providerAccountId = await resolveMetaSendAccount(params.userId, 'facebook', params);
    await assertCustomerDeliveryReady({ userId: params.userId, channel: 'facebook', accountId: providerAccountId });
    const replied = params.skipOutreachLimits
      ? false
      : await recipientHasReplied(params.userId, params.recipientId, providerAccountId);

    // H3: enforce daily quota for cold outreach (mirrors Instagram router behaviour).
    if (!replied && !params.skipOutreachLimits) {
      const { limit, pageId } = await getFacebookDailySettings(params.userId, providerAccountId);
      const sentToday = await getFacebookDailyCount(params.userId, pageId);
      if (sentToday >= limit) {
        logger.info({ userId: params.userId, sentToday, limit, pageId }, '[FacebookMessenger] Daily outreach limit reached');
        return { success: false, error: 'DAILY_LIMIT_REACHED', method: 'delayed', deliveryAttempted:false,outcomeUnknown:false,retryable:limit>0,retryAt:new Date(new Date().setUTCHours(24,0,0,0)).toISOString() };
      }
    }

    const service = await getFacebookApiForUser(params.userId, providerAccountId);
    if (!service) {
      return {
        success: false,
        error: 'Facebook Page OAuth with Messenger permissions is required. Browser fallback is disabled.',
        method: 'graph_api',
        retryable: false,
      };
    }

    const result = await service.sendMessage(params.recipientId, params.message, params.choice, params.webUrlAction);
    if (result.success) {
      if (!replied && !params.skipOutreachLimits) {
        const { pageId } = await getFacebookDailySettings(params.userId, providerAccountId);
        await incrementFacebookDailyCount(params.userId, pageId);
      }
      return {
        success: true,
        externalMessageId: result.messageId,
        method: 'graph_api',
        deliveryAttempted: true,
        outcomeUnknown: false,
      };
    }

    return {
      ...(result.code ? { code: result.code, reason: result.reason, setupUrl: result.setupUrl } : {}),
      success: false,
      error: result.error || 'Facebook did not confirm the message. Manual review is required before retrying.',
      method: 'graph_api',
      deliveryAttempted: result.deliveryAttempted === true,
      outcomeUnknown: result.outcomeUncertain === true,
      retryable: result.retryable === true,
      providerCode: result.providerCode,
      retryAt: result.retryAt,
    };
  } catch (error) {
    logger.error({ err: error }, '[FacebookMessenger] sendFacebookDM error');
    const setupFailure = deliverySetupFailure(error);
    if (setupFailure) return { ...setupFailure, method: 'graph_api', outcomeUnknown: false };
    return {
      success: false,
      error: 'Facebook delivery could not be started. Review the provider binding before retrying.',
      method: 'graph_api',
      deliveryAttempted: false,
      outcomeUnknown: false,
      retryable: false,
    };
  }
}
