/* eslint-disable @typescript-eslint/no-explicit-any */
/** Generates and sends social auto-replies and public comment replies. */
import { isDirectInstagramLogin } from '../../utils/instagramOAuthCredential.js';
import { db } from '../../models/db';
import { eq, and, or, desc } from 'drizzle-orm';
import { channelCredentialsTable } from '../../models/channelCredentials/schema';
import { metaPageConnectionsTable } from '../../models/metaPageConnections/schema.js';
import { boundMetaPageToken, decryptMetaSecret } from '../../utils/metaCredentialSecrets.js';
import { logger } from '../../utils/logger.js';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, deliverySetupFailure } from '../../services/assistants/CustomerDeliveryGate.js';
import { resolveInstagramAccountContext } from '../../services/instagramAccountSelectionService.js';
import { getGraphApiVersion } from '../../utils/metaApiVersion.js';
import { stripSocialPlaceholders } from './shared.js';

/**
 * Post an AI reply to an Instagram comment via the Graph API.
 * Uses the page access token stored in channel_credentials (platform = 'instagram_api').
 * Returns true if the reply was sent successfully.
 */
export interface PublicCommentDeliveryResult {
  code?: string;
  reason?: string;
  setupUrl?: string;
  deliveryAttempted?: boolean;
  retryable?: boolean;
  success: boolean;
  providerMessageId: string | null;
  outcomeUncertain: boolean;
  error?: string;
}

export async function resolveMetaCommentAccessToken(
  userId: number,
  platform: 'instagram' | 'facebook',
  providerAccountId?: string,
): Promise<{ accessToken: string; accountId: string }> {
  const credentialPlatform = platform === 'instagram' ? 'instagram_api' : 'facebook_api';
  const credentialPredicates = [
    eq(channelCredentialsTable.userId, userId),
    eq(channelCredentialsTable.platform, credentialPlatform),
    eq(channelCredentialsTable.isActive, true),
  ];
  if (providerAccountId) {
    credentialPredicates.push(eq(channelCredentialsTable.accountIdentifier, providerAccountId));
  }
  const [credential] = await db.select()
    .from(channelCredentialsTable)
    .where(and(...credentialPredicates))
    .orderBy(
      desc(channelCredentialsTable.isSelected),
      desc(channelCredentialsTable.updatedAt),
    )
    .limit(1);
  if (!credential) return { accessToken: '', accountId: '' };

  const [connection] = await db.select({
    pageAccessToken: metaPageConnectionsTable.pageAccessToken,
    userAccessToken: metaPageConnectionsTable.userAccessToken,
  })
    .from(metaPageConnectionsTable)
    .where(and(
      eq(metaPageConnectionsTable.userId, userId),
      eq(metaPageConnectionsTable.isActive, true),
      platform === 'instagram'
        ? eq(metaPageConnectionsTable.instagramActive, true)
        : eq(metaPageConnectionsTable.facebookActive, true),
      ...(credential.accountIdentifier
        ? [platform === 'instagram'
          ? or(
            eq(metaPageConnectionsTable.instagramAccountId, credential.accountIdentifier),
            eq(metaPageConnectionsTable.pageId, credential.accountIdentifier),
          )!
          : eq(metaPageConnectionsTable.pageId, credential.accountIdentifier)]
        : []),
    ))
    .limit(1);

  const legacySession = credential.sessionData as { pageAccessToken?: string } | null;
  const accessToken = decryptMetaSecret(
    boundMetaPageToken(credential) || connection?.pageAccessToken
      || connection?.userAccessToken
      || legacySession?.pageAccessToken
      || credential.accessToken,
  );
  return { accessToken, accountId: credential.accountIdentifier || '' };
}

export async function sendInstagramCommentReply(
  userId: number,
  commentId: string,
  replyText: string,
  providerAccountId?: string,
): Promise<PublicCommentDeliveryResult> {
  let providerCallStarted = false;
  try {
    assertCustomerDeliveryRuntime('instagram');
    const { accessToken, accountId } = await resolveMetaCommentAccessToken(userId, 'instagram', providerAccountId);
    if (!accessToken) {
      logger.info({ userId }, '[WebhooksController] Empty access token for Instagram comment reply');
      return { success: false, providerMessageId: null, outcomeUncertain: false, error: 'Instagram access token unavailable.' };
    }

    const context = await resolveInstagramAccountContext(userId, { accountIdentifier: accountId });
    const graphHost = isDirectInstagramLogin(context?.credential) ? 'instagram' : 'facebook';
    const apiVersion = await getGraphApiVersion();
    await assertCustomerDeliveryReady({ userId, channel: 'instagram', accountId, surface: 'public_comment' });
    providerCallStarted = true;
    const response = await fetch(
      `https://graph.${graphHost}.com/${apiVersion}/${commentId}/replies`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: replyText }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ commentId, err: errText }, '[WebhooksController] Instagram comment reply API error');
      let providerCode: number | undefined;
      try { providerCode = JSON.parse(errText)?.error?.code; } catch { /* An unstructured response cannot confirm rejection. */ }
      return { success: false, providerMessageId: null, outcomeUncertain: !providerCode && response.status >= 500, error: `Instagram rejected or could not confirm the comment reply (${response.status}).` };
    }


    const result = await response.json() as any;
    if (!result?.id) return { success: false, providerMessageId: null, outcomeUncertain: true, error: 'Instagram returned no comment reply receipt.' };
    logger.info({ commentId, replyId: result?.id }, '[WebhooksController] Instagram comment reply sent');
    return {
      success: true,
      providerMessageId: result?.id ? String(result.id) : null,
      outcomeUncertain: false,
    };

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] sendInstagramCommentReply failed');
    const setupFailure = deliverySetupFailure(error);
    if (setupFailure) return { ...setupFailure, providerMessageId: null };
    return {
      success: false,
      providerMessageId: null,
      outcomeUncertain: providerCallStarted,
      error: error instanceof Error ? error.message : 'Instagram comment delivery failed.',
    };
  }
}

/**
 * Post an AI reply to a Facebook comment via the Graph API.
 * Uses the canonical Facebook Page token for the user's active connection.
 * Returns true if the reply was sent successfully.
 */
export async function sendFacebookCommentReply(
  userId: number,
  commentId: string,
  replyText: string,
  providerAccountId?: string
): Promise<PublicCommentDeliveryResult> {
  let providerCallStarted = false;
  try {
    assertCustomerDeliveryRuntime('facebook');
    const { accessToken, accountId } = await resolveMetaCommentAccessToken(userId, 'facebook', providerAccountId);
    if (!accessToken) {
      return { success: false, providerMessageId: null, outcomeUncertain: false, error: 'Facebook access token unavailable.' };
    }

    const apiVersion = await getGraphApiVersion();
    await assertCustomerDeliveryReady({ userId, channel: 'facebook', accountId, surface: 'public_comment' });
    providerCallStarted = true;
    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${commentId}/comments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: replyText }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ commentId, err: errText }, '[WebhooksController] Facebook comment reply API error');
      return { success: false, providerMessageId: null, outcomeUncertain: false, error: `Facebook rejected the comment reply (${response.status}).` };
    }

    const result = await response.json().catch(() => ({})) as { id?: string };
    logger.info({ commentId, replyId: result.id }, '[WebhooksController] Facebook comment reply sent');
    return {
      success: true,
      providerMessageId: result.id ? String(result.id) : null,
      outcomeUncertain: false,
    };

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] sendFacebookCommentReply failed');
    const setupFailure = deliverySetupFailure(error);
    if (setupFailure) return { ...setupFailure, providerMessageId: null };
    return {
      success: false,
      providerMessageId: null,
      outcomeUncertain: providerCallStarted,
      error: error instanceof Error ? error.message : 'Facebook comment delivery failed.',
    };
  }
}

/**
 * Generate welcome message for new followers
 */
export async function generateWelcomeMessage(

  llmProvider: any,
  kbContext: string,

  lead: any,
  channel: string
): Promise<string> {
  try {
    const prompt = `You are a friendly social media manager. Generate a short, warm welcome message for a new ${channel} follower.

Knowledge Base Context:
${kbContext}

Keep the message:
- Under 160 characters
- Friendly and welcoming
- Mention what they can expect from this account (use knowledge base context above)
- Don't be too salesy

CRITICAL RULES — STRICTLY FOLLOW:
- Output ONLY the final message text. No quotes, no labels, no formatting.
- NEVER use placeholders, brackets, or template variables such as [link], [name], [meeting link], [insert here], [your company], etc.
- Every word must be ready to send directly to the customer as-is.`;

    const aiResponse = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt },
      ],
      loggingContext: { purpose: 'instagram_welcome_reply', service: 'WebhooksController' },
    });

    return (aiResponse.success && aiResponse.content?.trim())
      ? stripSocialPlaceholders(aiResponse.content.trim())
      : 'Thanks for following! 🙌 We share updates about our products and services. Feel free to DM us anytime!';
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Error generating welcome message');
    return 'Thanks for following! 🙌 Feel free to reach out if you have any questions!';
  }
}

/**
 * Generate reply to comments on posts/reels
 */
export async function generateCommentReply(

  llmProvider: any,
  kbContext: string,
  comment: string,

  lead: any,
  channel: string
): Promise<string> {
  try {
    const prompt = `You are a social media manager replying to a ${channel} comment. Generate a helpful, engaging reply.

Comment: "${comment}"

Knowledge Base Context (use if relevant):
${kbContext}

Guidelines:
- Keep under 200 characters
- Be friendly and helpful
- If the comment is a question, answer it using the knowledge base if available
- If you don't have enough info, thank them and invite them to DM for more details
- Use appropriate emojis sparingly
- Don't be too promotional

CRITICAL RULES — STRICTLY FOLLOW:
- Output ONLY the final reply text. No quotes, no labels, no formatting.
- NEVER use placeholders, brackets, or template variables such as [link], [name], [meeting link], [insert calendar link], [insert here], [your company], etc.
- Every word must be ready to send directly to the customer as-is. No editing required.`;

    const aiResponse = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { role: 'system', content: 'You are a helpful social media manager.' },
        { role: 'user', content: prompt },
      ],
      loggingContext: { purpose: 'instagram_comment_reply', service: 'WebhooksController' },
    });

    return (aiResponse.success && aiResponse.content?.trim())
      ? stripSocialPlaceholders(aiResponse.content.trim())
      : 'Thanks for your comment! Feel free to DM us if you have any questions 😊';
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Error generating comment reply');
    return 'Thanks for your comment! Let us know if you have any questions 😊';
  }
}

/**
 * Generate reply to DMs
 */
export async function generateDMReply(

  llmProvider: any,
  kbContext: string,
  message: string,

  lead: any,
  channel: string
): Promise<string> {
  try {
    const prompt = `You are a helpful customer service representative responding to a ${channel} direct message.

Message: "${message}"

Lead info (if available):
- Name: ${lead?.name || 'Unknown'}
- Company: ${lead?.company || 'Unknown'}

Knowledge Base Context (use to answer questions):
${kbContext}

Guidelines:
- Be helpful, professional but friendly
- Answer questions directly using the knowledge base if applicable
- Keep under 300 characters
- If you can't fully answer, offer to help further or ask them to share more details
- Don't make up information not in the knowledge base
- Use appropriate emojis sparingly

CRITICAL RULES — STRICTLY FOLLOW:
- Output ONLY the final reply text. No quotes, no labels, no formatting.
- NEVER use placeholders, brackets, or template variables such as [link], [name], [meeting link], [insert calendar link], [insert here], [your company], [contact us at], etc.
- Every word must be ready to send directly to the customer as-is. No editing required.`;

    const aiResponse = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { role: 'system', content: 'You are a helpful customer service representative.' },
        { role: 'user', content: prompt },
      ],
      loggingContext: { purpose: 'instagram_dm_reply', service: 'WebhooksController' },
    });

    return (aiResponse.success && aiResponse.content?.trim())
      ? stripSocialPlaceholders(aiResponse.content.trim())
      : 'Thanks for reaching out! We\'ll get back to you soon with more details. 😊';
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Error generating DM reply');
    return 'Thanks for your message! Our team will get back to you shortly.';
  }
}

/**
 * Send auto-reply via the appropriate channel
 */
export async function sendAutoReply(
  userId: number,

  lead: any,
  channel: string,
  replyText: string,

  rawData: any
): Promise<void> {
  try {
    // Get channel credentials - try _api variant first for twitter/linkedin
    const platformVariants = ['twitter', 'linkedin'].includes(channel)
      ? [`${channel}_api`, channel]
      : [channel];


    let credentials: any = null;
    for (const platform of platformVariants) {
      const [cred] = await db.select()
        .from(channelCredentialsTable)
        .where(and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform),
          eq(channelCredentialsTable.isActive, true)
        ))
        .limit(1);
      if (cred) {
        credentials = cred;
        break;
      }
    }

    if (!credentials) {
      logger.info({ userId, channel }, '[WebhooksController] No credentials found for channel');
      return;
    }

    switch (channel) {
      case 'instagram':
        await sendInstagramReply(credentials, rawData, replyText);
        break;
      case 'facebook':
        await sendFacebookReply(credentials, rawData, replyText);
        break;
      case 'whatsapp':
        await sendWhatsAppReply(credentials, rawData, replyText);
        break;
      case 'twitter':
        await sendTwitterReply(credentials, rawData, replyText);
        break;
      case 'linkedin':
        await sendLinkedInReply(credentials, rawData, replyText);
        break;
    }

    logger.info({ channel }, '[WebhooksController] Sent auto-reply');
  } catch (error) {
    logger.error({ err: error, channel }, '[WebhooksController] Failed to send auto-reply');
  }
}

/**
 * Send Instagram DM reply
 */

export async function sendInstagramReply(credentials: any, rawData: any, replyText: string): Promise<void> {
  try {
    const accessToken = credentials.accessToken;
    const senderId = rawData.sender?.id;
    const pageId = credentials.pageId || credentials.instagramBusinessId;

    if (!senderId || !accessToken || !pageId) {
      logger.info('[WebhooksController] Missing Instagram credentials for reply');
      return;
    }

    const apiVersion = await getGraphApiVersion();
    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: senderId },
          message: { text: replyText },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error({ err: error }, '[WebhooksController] Instagram send error');
    }
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Instagram reply error');
  }
}

/**
 * Send Facebook Messenger reply
 */

export async function sendFacebookReply(credentials: any, rawData: any, replyText: string): Promise<void> {
  try {
    const accessToken = credentials.accessToken;
    const senderId = rawData.sender?.id;
    const pageId = credentials.pageId;

    if (!senderId || !accessToken || !pageId) {
      logger.info('[WebhooksController] Missing Facebook credentials for reply');
      return;
    }

    const apiVersion = await getGraphApiVersion();
    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: senderId },
          message: { text: replyText },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error({ err: error }, '[WebhooksController] Facebook send error');
    }
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Facebook reply error');
  }
}

/**
 * Send WhatsApp reply
 */

export async function sendWhatsAppReply(credentials: any, rawData: any, replyText: string): Promise<void> {
  try {
    const userId = Number(credentials?.userId);
    const phoneNumberId = rawData.metadata?.phone_number_id || credentials?.phoneNumberId;
    const recipientPhone = rawData.message?.from;

    if (!userId || !recipientPhone || !phoneNumberId) {
      logger.info('[WebhooksController] Missing WhatsApp credentials for reply');
      return;
    }

    // Through the WhatsApp service so opt-outs, readiness and platform billing
    // apply, like every other WhatsApp send.
    const { whatsappApiService } = await import('../../services/whatsappApiService.js');
    await whatsappApiService.sendText({ userId, phoneNumberId: String(phoneNumberId), to: String(recipientPhone), text: replyText });
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] WhatsApp reply error');
  }
}

/**
 * Send Twitter DM reply
 */

export async function sendTwitterReply(credentials: any, rawData: any, replyText: string): Promise<void> {
  try {
    const accessToken = credentials.accessToken;
    const senderId = rawData.message_create?.sender_id;

    if (!senderId || !accessToken) {
      logger.info('[WebhooksController] Missing Twitter credentials for reply');
      return;
    }

    const response = await fetch(
      `https://api.x.com/2/dm_conversations/with/${senderId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ text: replyText }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error({ err: error }, '[WebhooksController] Twitter send error');
    }
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Twitter reply error');
  }
}

/**
 * Send LinkedIn message reply
 */

export async function sendLinkedInReply(credentials: any, rawData: any, replyText: string): Promise<void> {
  try {
    const accessToken = credentials.accessToken;
    const senderId = rawData.data?.from || rawData.actor || rawData.from;

    if (!senderId || !accessToken) {
      logger.info('[WebhooksController] Missing LinkedIn credentials for reply');
      return;
    }

    const response = await fetch(
      'https://api.linkedin.com/v2/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'LinkedIn-Version': '202401',
        },
        body: JSON.stringify({
          recipients: [String(senderId)],
          body: replyText,
          messageType: 'MEMBER_TO_MEMBER',
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error({ err: error }, '[WebhooksController] LinkedIn send error');
    }
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] LinkedIn reply error');
  }
}
