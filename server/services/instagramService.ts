/**
 * Instagram DM Service
 * Handles Instagram direct message outreach through the official Meta API.
 * 
 * Integration with:
 * - ContentStudioAgent for AI-generated personalized messages
 * - OutreachAgent for campaign-based messaging
 */

import { LLMProviderFactory } from './agents/LLMProviderFactory';
import { getInstagramApiForUser, hasInstagramApiCredentials, sendMessageByUsername } from './instagramGraphApiService';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, deliverySetupFailure } from './assistants/CustomerDeliveryGate.js';

// Configuration: Use Graph API by default if available (for replies)
const USE_GRAPH_API = process.env.INSTAGRAM_USE_GRAPH_API !== 'false';

interface InstagramCredentials {
  username: string;
  password: string;
}

export interface InstagramDMResult {
  code?: string;
  reason?: string;
  setupUrl?: string;
  retryable?: boolean;
  providerCode?: number;
  retryAt?: string;
  deliveryAttempted?: boolean;
  outcomeUnknown?: boolean;
  success: boolean;
  userId?: string;
  username?: string;
  messageId?: string;
  error?: string;
}

interface InstagramConfig {
  credentials?: InstagramCredentials;
  sessionPath?: string;
  delayBetweenDMs?: number; // seconds
  openAIKey?: string; // OpenAI API key for browser bot AI features
}

export interface LeadInfo {
  username: string;
  fullName?: string;
  company?: string;
  role?: string;
  bio?: string;
}

export interface OutreachTemplate {
  subject?: string;
  body: string;
  cta?: string;
}

export class InstagramService {
  private credentials: InstagramCredentials | null = null;
  private delayBetweenDMs: number;
  private openAIKey: string | null = null;

  constructor(creds?: InstagramCredentials, openAIKey?: string) {
    this.delayBetweenDMs = 5; // 5 seconds delay to avoid spam detection
    if (creds) {
      this.credentials = creds;
    }
    if (openAIKey) {
      this.openAIKey = openAIKey;
    }
  }

  /**
   * Set OpenAI API key for browser bot AI features
   */
  setOpenAIKey(key: string): void {
    this.openAIKey = key;
  }

  /**
   * Initialize service with credentials
   */
  async initialize(config?: InstagramConfig): Promise<void> {
    if (config?.credentials) {
      this.credentials = config.credentials;
    } else {
      // No credentials provided — must be set via config parameter from DB
      this.credentials = {
        username: '',
        password: '',
      };
    }

    if (config?.delayBetweenDMs) {
      this.delayBetweenDMs = config.delayBetweenDMs;
    }
  }

  /**
   * Send a direct message to a user by username
   * Requires an eligible conversation under the Instagram Graph API.
   */
  async sendDirectMessage(
    username: string,
    message: string,
    userId?: number,
  ): Promise<InstagramDMResult> {
    try { assertCustomerDeliveryRuntime('instagram'); }
    catch (error) {
      const setupFailure = deliverySetupFailure(error);
      if (setupFailure) return { ...setupFailure, username, outcomeUnknown: false };
      throw error;
    }
    // 1. Try Instagram Graph API first if enabled and user has credentials
    // Graph API only works for users who have messaged you first
    if (USE_GRAPH_API && userId) {
      try {
        const hasGraphCredentials = await hasInstagramApiCredentials(userId);
        if (hasGraphCredentials) {
          logger.info({ username: username }, '[InstagramService] Trying Instagram Graph API to send DM to');
          const graphResult = await this.sendDirectMessageViaGraphApi(username, message, userId);
          
          // If Graph API succeeded, return result
          if (graphResult.success || graphResult.code === 'ASSISTANT_SETUP_REQUIRED') {
            return graphResult;
          }
          
        }
      } catch (error) {
        logger.info({ err: error instanceof Error ? error : String(error) }, '[InstagramService] Graph API not available');
      }
    }

    return {
      success: false,
      username,
      error: 'Instagram Graph API could not confirm an eligible conversation. ',
    };
  }

  /**
   * Send a direct message using Instagram Graph API (official Meta API)
   * This is the most reliable method for business accounts
   * NOTE: Graph API only allows messaging users who have messaged you first
   */
  private async sendDirectMessageViaGraphApi(username: string, message: string, userId: number): Promise<InstagramDMResult> {
    try {
      // Use the helper function that handles IGSID lookup from conversations
      const result = await sendMessageByUsername(userId, username, message);
      
      if (result.success) {
        return {
          success: true,
          username,
          messageId: result.messageId,
        };
      } else {
        return {
          ...result,
          success: false,
          username,
          error: result.error || 'Failed to send via Graph API',
        };
      }
    } catch (error) {
      logger.error({ err: error }, '[InstagramService] Graph API send error');
      const setupFailure = deliverySetupFailure(error);
      if (setupFailure) return { ...setupFailure, username };
      return {
        success: false,
        username,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send DMs to multiple users with delay
   * Uses the Graph API for eligible conversations
   */
  async sendBulkDirectMessages(
    users: Array<{ username: string; message: string }>,
    onProgress?: (result: InstagramDMResult, index: number, total: number) => void,
    userId?: number
  ): Promise<InstagramDMResult[]> {
    const results: InstagramDMResult[] = [];

    for (let i = 0; i < users.length; i++) {
      const { username, message } = users[i];

      try {
        const result = await this.sendDirectMessage(username, message, userId);
        results.push(result);

        if (onProgress) {
          onProgress(result, i, users.length);
        }

        // Delay between DMs to avoid spam detection
        if (i < users.length - 1) {
          await this.delay(this.delayBetweenDMs * 1000);
        }
      } catch (error) {
        const errorResult: InstagramDMResult = {
          success: false,
          username,
          error: error instanceof Error ? error.message : String(error),
        };
        results.push(errorResult);

        if (onProgress) {
          onProgress(errorResult, i, users.length);
        }
      }
    }

    return results;
  }

  /**
   * Helper delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Set credentials programmatically
   */
  setCredentials(credentials: InstagramCredentials): void {
    this.credentials = credentials;
  }

  /**
   * Check if credentials are configured
   */
  hasCredentials(): boolean {
    return !!(this.credentials?.username && this.credentials?.password);
  }

  /**
   * Generate AI-personalized DM message using LLM
   * Similar to insta_web-main's generate_ai_message functionality
   */
  async generatePersonalizedMessage(
    lead: LeadInfo,
    actionType: 'dm_request' | 'comment' | 'like' | 'follow' | 'outreach' = 'outreach',
    context?: { commentText?: string; campaignObjective?: string; valueProposition?: string },
    userId?: number
  ): Promise<string> {
    try {
      const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
      
      let prompt: string;
      
      switch (actionType) {
        case 'dm_request':
          prompt = `Generate a friendly Instagram DM response for a user who requested to be contacted.
Username: @${lead.username}
${lead.fullName ? `Name: ${lead.fullName}` : ''}
${lead.company ? `Company: ${lead.company}` : ''}

Rules:
- Keep it short (2-3 sentences max)
- Be friendly and welcoming
- Thank them for reaching out
- Use 1-2 relevant emojis
- Do NOT be salesy or promotional

Generate only the message, nothing else.`;
          break;
          
        case 'comment':
          prompt = `Generate a friendly, personalized Instagram DM response for a user who commented on our post.
Username: @${lead.username}
${lead.fullName ? `Name: ${lead.fullName}` : ''}
Their comment: "${context?.commentText || ''}"

Rules:
- Keep it short (2-3 sentences max)
- Be friendly and welcoming
- Thank them for engaging
- Respond naturally to their comment
- Ask if they have any questions
- Use 1-2 relevant emojis
- Do NOT be salesy or promotional

Generate only the message, nothing else.`;
          break;
          
        case 'like':
        case 'follow':
          prompt = `Generate a friendly, personalized Instagram DM for a user who ${actionType === 'follow' ? 'followed us' : 'liked our post'}.
Username: @${lead.username}
${lead.fullName ? `Name: ${lead.fullName}` : ''}
${lead.bio ? `Bio: ${lead.bio}` : ''}

Rules:
- Keep it short (2-3 sentences max)
- Be friendly and appreciative
- Thank them for the ${actionType === 'follow' ? 'follow' : 'like'}
- Invite them to ask questions or engage further
- Use 1-2 relevant emojis
- Do NOT be salesy or promotional

Generate only the message, nothing else.`;
          break;
          
        case 'outreach':
        default:
          prompt = `Generate a personalized Instagram DM for cold outreach.
Username: @${lead.username}
${lead.fullName ? `Name: ${lead.fullName}` : ''}
${lead.company ? `Company: ${lead.company}` : ''}
${lead.role ? `Role: ${lead.role}` : ''}
${lead.bio ? `Bio: ${lead.bio}` : ''}
${context?.campaignObjective ? `Campaign Goal: ${context.campaignObjective}` : ''}
${context?.valueProposition ? `Value Proposition: ${context.valueProposition}` : ''}

Rules:
- Keep it short (2-4 sentences max)
- Be friendly and professional
- Personalize based on their profile/company
- Include a clear but soft call-to-action
- Use 1-2 relevant emojis
- Do NOT be pushy or salesy
- Make it feel genuine, not templated

Generate only the message, nothing else.`;
      }

      const response = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: 'You are an expert at writing personalized, engaging Instagram direct messages for marketing outreach. Your messages feel authentic and personal, not like automated spam.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 200,
        ...(userId ? {
          loggingContext: {
            userId,
            purpose: 'instagram_dm_generation',
            service: 'InstagramService',
            action: 'generate_personalized_message',
          },
        } : {}),
      });

      return response.content?.trim() || `Hey @${lead.username}! 😊 Thanks for connecting!`;
    } catch (error) {
      logger.error({ err: error }, '[InstagramService] generatePersonalizedMessage error');
      // Fallback message
      return `Hey @${lead.username}! 😊 Thanks for connecting! Feel free to reach out if you have any questions!`;
    }
  }

  /**
   * Send personalized DM using ContentStudioAgent template
   * Integrates with OutreachAgent workflow
   */
  async sendPersonalizedDM(
    lead: LeadInfo,
    template?: OutreachTemplate,
    context?: { campaignObjective?: string; valueProposition?: string },
    userId?: number
  ): Promise<InstagramDMResult> {
    try {
      let message: string;
      
      if (template?.body) {
        // Use provided template with token replacement
        message = this.replaceTokens(template.body, lead);
      } else {
        // Generate AI message
        message = await this.generatePersonalizedMessage(lead, 'outreach', context);
      }

      return await this.sendDirectMessage(lead.username, message, userId);
    } catch (error) {
      logger.error({ err: error }, '[InstagramService] sendPersonalizedDM error');
      return {
        success: false,
        username: lead.username,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Replace personalization tokens in template
   */
  private replaceTokens(template: string, lead: LeadInfo): string {
    let message = template;
    
    const tokens: Record<string, string> = {
      '{{username}}': lead.username || '',
      // Canonical variables
      '{{first_name}}': lead.fullName?.split(' ')[0] || lead.username || 'there',
      '{{last_name}}': lead.fullName?.split(' ').slice(1).join(' ') || '',
      '{{full_name}}': lead.fullName || lead.username || 'there',
      '{{company_name}}': lead.company || 'your company',
      '{{job_title}}': lead.role || 'your role',
      // Legacy aliases (backward compatibility)
      '{{firstname}}': lead.fullName?.split(' ')[0] || lead.username || 'there',
      '{{lastname}}': lead.fullName?.split(' ').slice(1).join(' ') || '',
      '{{fullname}}': lead.fullName || lead.username || 'there',
      '{{company}}': lead.company || 'your company',
      '{{role}}': lead.role || 'your role',
      '{{bio}}': lead.bio || '',
    };
    
    for (const [token, value] of Object.entries(tokens)) {
      message = message.replace(new RegExp(token, 'gi'), value);
    }
    
    return message;
  }

  /**
   * Send bulk personalized DMs with AI-generated or template messages
   */
  async sendBulkPersonalizedDMs(
    leads: LeadInfo[],
    options: {
      template?: OutreachTemplate;
      campaignObjective?: string;
      valueProposition?: string;
      useAI?: boolean;
      userId?: number;
    },
    onProgress?: (result: InstagramDMResult, index: number, total: number) => void
  ): Promise<InstagramDMResult[]> {
    const results: InstagramDMResult[] = [];

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];

      try {
        let message: string;
        
        if (options.template?.body && !options.useAI) {
          message = this.replaceTokens(options.template.body, lead);
        } else {
          message = await this.generatePersonalizedMessage(lead, 'outreach', {
            campaignObjective: options.campaignObjective,
            valueProposition: options.valueProposition,
          });
        }

        const result = await this.sendDirectMessage(lead.username, message, options.userId);
        results.push(result);

        if (onProgress) {
          onProgress(result, i, leads.length);
        }

        // Delay between DMs to avoid spam detection
        if (i < leads.length - 1) {
          await this.delay(this.delayBetweenDMs * 1000);
        }
      } catch (error) {
        const errorResult: InstagramDMResult = {
          success: false,
          username: lead.username,
          error: error instanceof Error ? error.message : String(error),
        };
        results.push(errorResult);

        if (onProgress) {
          onProgress(errorResult, i, leads.length);
        }
      }
    }

    return results;
  }
}

export const instagramService = new InstagramService();

// Import database access for credential retrieval
import { db } from '../models/db';
import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

/**
 * Wrapper function for sending Instagram DM from conversations controller
 * Uses only the documented Graph API.
 */
export async function sendInstagramDM(params: {
  recipientId: string;
  message: string;
  userId: number;
  conversationId?: number;
  messageId?: number;
  skipCreditDeduction?: boolean;
  /** Bind replies to the Instagram identity that owns the conversation. */
  providerAccountId?: string;
  choice?: import('./agents/orchestration/SupportChoiceDelivery.js').SupportChoiceManifest;
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
  providerCode?: number;
  retryAt?: string;
}> {
  try {
    assertCustomerDeliveryRuntime('instagram');
    // 1. Try Instagram Graph API first (for existing conversations)
    if (USE_GRAPH_API) {
      try {
        const { resolveMetaSendAccount } = await import('./outreach/MetaSendAccount.js');
        const providerAccountId = await resolveMetaSendAccount(params.userId, 'instagram', params);
        await assertCustomerDeliveryReady({ userId: params.userId, channel: 'instagram', accountId: providerAccountId });
        const accountSelector = providerAccountId ? { accountIdentifier: providerAccountId } : {};
        const service = await getInstagramApiForUser(params.userId, accountSelector);
        if (service) {
          logger.info({ recipientId: params.recipientId }, '[InstagramService] Trying Graph API for DM to');

          // If recipientId is numeric it's already an IGSID — send directly without conversation lookup
          const isIgsid = /^\d+$/.test(params.recipientId);
          let graphResult: {
            success: boolean;
            code?: string;
            reason?: string;
            setupUrl?: string;
            retryable?: boolean;
  providerCode?: number;
  retryAt?: string;
            messageId?: string;
            error?: string;
            deliveryAttempted?: boolean;
            outcomeUncertain?: boolean;
          };
          if (isIgsid) {
            graphResult = await service.sendMessage(params.recipientId, params.message, params.choice);
          } else {
            graphResult = await sendMessageByUsername(params.userId, params.recipientId, params.message, accountSelector);
          }

          if (graphResult.success) {
            return {
              success: true,
              externalMessageId: graphResult.messageId,
              deliveryAttempted: true,
              outcomeUnknown: false,
            };
          }
          logger.info({ error: graphResult.error }, '[InstagramService] Graph API send failed');
          return {
            ...(graphResult.code ? { code: graphResult.code, reason: graphResult.reason, setupUrl: graphResult.setupUrl } : {}),
            success: false,
            error: graphResult.error || 'Instagram rejected the reply.',
            deliveryAttempted: graphResult.deliveryAttempted === true,
            outcomeUnknown: graphResult.outcomeUncertain === true,
            retryable: graphResult.retryable === true,
            providerCode: graphResult.providerCode,
            retryAt: graphResult.retryAt,
          };
        }
      } catch (error) {
        logger.info({ err: error instanceof Error ? error : String(error) }, '[InstagramService] Graph API not available');
        const setupFailure = deliverySetupFailure(error);
        if (setupFailure) return { ...setupFailure, outcomeUnknown: false };
        const providerError = error as Error & { deliveryAttempted?: boolean; outcomeUncertain?: boolean };
        return {
          success: false,
          error: providerError instanceof Error ? providerError.message : 'Instagram Graph API is unavailable.',
          deliveryAttempted: providerError?.deliveryAttempted === true,
          outcomeUnknown: providerError?.outcomeUncertain === true,
          retryable: false,
        };
      }
    }

    return {
      success: false,
      error: 'Instagram Graph API is required and did not confirm an eligible recipient conversation. ',
      deliveryAttempted: false,
      outcomeUnknown: false,
      retryable: false,
    };
  } catch (error) {
    logger.error({ err: error }, '[InstagramService] sendInstagramDM error');
    const setupFailure = deliverySetupFailure(error);
    if (setupFailure) return { ...setupFailure, outcomeUnknown: false };
    const deliveryAttempted = (error as { deliveryAttempted?: boolean })?.deliveryAttempted === true;
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send Instagram DM',
      deliveryAttempted,
      outcomeUnknown: deliveryAttempted,
      retryable: false,
    };
  }
}

/**
 * Fetch Instagram messages via Graph API and sync to outreach conversations.
 * Called when user clicks "Sync" on the Instagram outreach channel.
 * 
 * Flow:
 * 1. Initialize Graph API service for user
 * 2. Fetch conversations from Instagram Graph API
 * 3. For each conversation, resolve participant → lead
 * 4. Get or create outreach_conversation
 * 5. Sync messages that don't already exist in outreach_messages
 */
export async function fetchInstagramMessages(userId: number, providerAccountId?: string): Promise<number> {
  if (!providerAccountId) {
    const { ChannelCredentialModel } = await import('../models/channelCredentials/functions.js');
    const accounts = await ChannelCredentialModel.findAllByUserAndPlatform(userId, 'instagram_api');
    let count = 0;
    for (const account of accounts) if (account.accountIdentifier) count += await fetchInstagramMessages(userId, account.accountIdentifier);
    return count;
  }
  try {
    const service = await getInstagramApiForUser(userId, { accountIdentifier: providerAccountId });
    if (!service) {
      logger.info({ userId }, '[InstagramService] No Instagram Graph API credentials configured');
      return 0;
    }

    // Fetch conversations from Graph API
    const convResult = await service.getConversations(50);
    if (!convResult.success || !convResult.conversations?.length) {
      logger.info({ userId }, '[InstagramService] No Instagram conversations found via Graph API');
      return 0;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { getOrCreateConversation, createOutreachMessage, getMessageByExternalId, updateConversationWithMessage, updateOutreachConversation } = await import('../models/outreachConversations/functions');
    const { outreachAttachmentService } = await import('./OutreachAttachmentService.js');
    const { leadsTable } = await import('../models/leads/schema');
    const { ilike } = await import('drizzle-orm');

    let syncedMessageCount = 0;
    const credInfo = service.getCredentialsInfo();
    const ownIgsid = credInfo?.instagramAccountId;

    for (const conv of convResult.conversations) {
      try {
        // Find the other participant (not our own account)
        const otherParticipant = conv.participants?.data?.find(p => p.id !== ownIgsid);
        if (!otherParticipant) continue;

        const participantUsername = otherParticipant.username || '';
        const participantIgsid = otherParticipant.id;
        const participantName = otherParticipant.name || (participantUsername ? `@${participantUsername}` : '');

        // Resolve lead: try IGSID first, then username
        let lead = null;
        if (participantIgsid) {
          const [byIgsid] = await db.select().from(leadsTable)
            .where(and(eq(leadsTable.userId, userId), eq(leadsTable.instagramHandle, participantIgsid)))
            .limit(1);
          lead = byIgsid || null;
        }
        if (!lead && participantUsername) {
          const [byUsername] = await db.select().from(leadsTable)
            .where(and(eq(leadsTable.userId, userId), ilike(leadsTable.instagramHandle, participantUsername)))
            .limit(1);
          if (!byUsername) {
            const [byInstagram] = await db.select().from(leadsTable)
              .where(and(eq(leadsTable.userId, userId), ilike(leadsTable.instagram, participantUsername)))
              .limit(1);
            lead = byInstagram || null;
          } else {
            lead = byUsername;
          }
        }

        // Auto-create lead if not found
        if (!lead) {
          const [newLead] = await db.insert(leadsTable).values({
            userId,
            name: participantName || (participantUsername ? `@${participantUsername}` : `IG User ${participantIgsid}`),
            instagramHandle: participantUsername || participantIgsid,
            instagram: participantUsername || undefined,
            source: 'instagram_sync',
            status: 'new',
            platformType: 'instagram',
          }).returning();
          lead = newLead;
        }

        if (!lead) continue;

        // Store IGSID in platform_extended if not already there
        const existingExtended = (lead.platformExtended as Record<string, unknown>) || {};
        if (!existingExtended.instagram_id || existingExtended.instagram_id !== participantIgsid) {
          await db.update(leadsTable).set({
            platformExtended: { ...existingExtended, instagram_id: participantIgsid },
          }).where(eq(leadsTable.id, lead.id));
        }

        // Get or create outreach conversation
        const conversation = await getOrCreateConversation({
          userId,
          leadId: lead.id,
          channel: 'instagram',
          providerAccountId,
          leadName: participantName || lead.name || undefined,
          leadInstagram: participantUsername || participantIgsid,
          externalThreadId: participantIgsid,
          status: 'active',
        });

        // Sync messages from this conversation
        const messages = conv.messages?.data || [];
        let newMsgCount = 0;

        for (const msg of messages) {
          if (!msg.id) continue;

          const isInbound = msg.from?.id !== ownIgsid;
          const messageContent = msg.message || '[Media or attachment]';
          const existing = await getMessageByExternalId(msg.id);
          if (existing && (existing.userId !== userId || existing.conversationId !== conversation.id)) continue;
          const localMessage = existing || await createOutreachMessage({
              conversationId: conversation.id,
              userId,
              direction: isInbound ? 'inbound' : 'outbound',
              content: messageContent,
              status: 'delivered',
              externalMessageId: msg.id,
              providerAccountId,
              sentAt: new Date(msg.created_time),
              isRead: true, // Historical messages treated as read
            });
          if (!existing) newMsgCount++;

          // Attachment repair is deliberately not skipped for existing
          // messages. A manual refresh can replace expired/failed records with
          // a newly authenticated Graph response.
          let graphAttachments = msg.attachments?.data || [];
          if (graphAttachments.length === 0 || graphAttachments.some((attachment) => !attachment.url)) {
            const refreshed = await service.getMessage(msg.id);
            if (refreshed.success && refreshed.message?.attachments?.data?.length) {
              graphAttachments = refreshed.message.attachments.data;
            }
          }
          for (const [index, attachment] of graphAttachments.slice(0, 5).entries()) {
            if (!attachment.url) {
              await outreachAttachmentService.recordInboundFailure({
                userId,
                messageId: localMessage.id,
                fileName: `instagram-${attachment.type || 'attachment'}-${index + 1}`,
                providerAttachmentId: `${msg.id}:${index}`,
                source: 'instagram_graph_sync',
                error: new Error('Instagram did not provide a retrievable media URL.'),
                metadata: { providerAttachmentType: attachment.type || 'attachment' },
              }).catch(() => {});
              continue;
            }
            const type = String(attachment.type || 'attachment').toLowerCase();
            const mimeType = type === 'image' ? 'image/jpeg'
              : type === 'video' ? 'video/mp4'
                : type === 'audio' ? 'audio/mpeg'
                  : undefined;
            await outreachAttachmentService.persistInboundUrl({
              userId,
              messageId: localMessage.id,
              url: attachment.url,
              fileName: `instagram-${type}-${index + 1}`,
              mimeType,
              providerAttachmentId: `${msg.id}:${index}`,
              source: 'instagram_graph_sync',
              metadata: { providerAttachmentType: type },
            }).catch((error) => logger.warn({ err: error, messageId: msg.id, index }, '[InstagramService] Attachment repair failed'));
          }
        }

        // Update conversation metadata with latest message
        if (newMsgCount > 0 && messages.length > 0) {
          const latestMsg = messages[0]; // Graph API returns newest first
          const isLatestInbound = latestMsg.from?.id !== ownIgsid;
          await updateConversationWithMessage(
            conversation.id,
            isLatestInbound ? 'inbound' : 'outbound',
            latestMsg.message || '[Media or attachment]'
          );
        }

        syncedMessageCount += newMsgCount;
      } catch (convError) {
        logger.error({ err: convError, conversationId: conv.id }, '[InstagramService] Error syncing conversation');
        continue;
      }
    }

    logger.info({ userId, syncedMessageCount, conversationCount: convResult.conversations.length },
      '[InstagramService] Instagram Graph API sync complete');
    return syncedMessageCount;
  } catch (error) {
    logger.error({ err: error }, '[InstagramService] fetchInstagramMessages error');
    return 0;
  }
}
