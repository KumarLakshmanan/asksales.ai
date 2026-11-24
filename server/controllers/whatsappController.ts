import { authorizeBusinessManager } from '../middleware/businessPermissions.js';
import { deliverySetupFailure } from '../services/assistants/CustomerDeliveryGate.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { currentBusinessScope, withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { rememberOAuthBusinessState } from '../tenancy/oauthBusinessScope.js';
/**
 * WhatsApp Integration Controller
 * Handles WhatsApp Business API configuration and messaging
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { CredentialService } from '../services/credentialService';
import { logger } from '../utils/logger.js';
import { getIntegrationOAuthCallbackUrl } from '../utils/integrationUrls.js';
import { timingSafeEqual } from '../utils/secureCompare.js';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { outreachMessagesTable } from '../models/outreachConversations/schema.js';
import { getOrCreateConversation } from '../models/outreachConversations/functions.js';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { leadsTable } from '../models/leads/schema.js';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';
import { WhatsAppMessagePayloadSchema, verifyMetaSignature } from '../utils/metaWebhookValidator.js';
import { normalizeWhatsAppInboundText } from '../services/agents/orchestration/SupportChoiceDelivery.js';
import { jobDispatcher } from '../queues/JobDispatcher.js';
import { whatsappApiService } from '../services/whatsappApiService.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { logWebhookEvent } from '../utils/webhookLogger.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { outreachAttachmentService } from '../services/OutreachAttachmentService.js';
import { inboundContactResolver } from '../services/InboundContactResolver.js';
import {
  privacyVaultService,
  redactPiiWithStableTokens,
} from '../services/agents/orchestration/PrivacyVaultService.js';
import {
  decryptChannelCredentialSession,
  encryptChannelCredentialSecret,
  encryptChannelCredentialSession,
  getChannelCredentialEncryptionKeyId,
} from '../utils/channelCredentialSecrets.js';
import { getMetaCapabilityStatuses, normalizeMetaAppReviewPermissions } from '../services/integrations/MetaCapabilityRegistry.js';
import { providerVerificationRequiresReconnect } from '../services/integrations/ProviderVerificationService.js';
const OAUTH_NONCE_TTL_SECONDS = 600; // 10 minutes

/** Mask a token for client-side display (keep first 6 + last 4 chars). */
function maskToken(token: string | null | undefined): string {
  if (!token) return '';
  if (token.length <= 12) return '*'.repeat(token.length);
  return `${token.slice(0, 6)}${'*'.repeat(Math.max(0, token.length - 10))}${token.slice(-4)}`;
}

interface WhatsAppConfig {
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  webhookVerifyToken: string;
  apiVersion: string;
}

interface WhatsAppOAuthPhone {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

interface WhatsAppOAuthAccountCandidate {
  wabaId: string;
  phones: WhatsAppOAuthPhone[];
}

const WHATSAPP_LIMITED_READINESS_CODES = new Set(['WABA_HEALTH']);

export function getWhatsAppConnectionStatus(
  readinessErrorCode: string | null | undefined,
): 'ready' | 'limited' | 'action_required' | 'reauth_required' {
  if (!readinessErrorCode) return 'ready';
  if (WHATSAPP_LIMITED_READINESS_CODES.has(readinessErrorCode)) return 'limited';
  if (readinessErrorCode.startsWith('meta_190_') || providerVerificationRequiresReconnect(readinessErrorCode)) {
    return 'reauth_required';
  }
  return 'action_required';
}

export function whatsappOAuthVerificationAllowsConnection(
  verification: { status: string; errorCode?: string | null },
): boolean {
  return verification.status === 'passing'
    || WHATSAPP_LIMITED_READINESS_CODES.has(String(verification.errorCode || ''));
}

/**
 * Select the account being reconnected without depending on Meta's target-id
 * ordering. A Facebook user may administer several WABAs, so taking the first
 * granular-scope target can silently bind a tenant to the wrong business.
 */
export function selectWhatsAppOAuthAccount(
  candidates: WhatsAppOAuthAccountCandidate[],
  preferred: { wabaId?: string; phoneNumberId?: string },
): { wabaId: string; phone: WhatsAppOAuthPhone } {
  const available = candidates.flatMap((candidate) =>
    candidate.phones.map((phone) => ({ wabaId: candidate.wabaId, phone })),
  );

  if (preferred.phoneNumberId) {
    const phoneMatch = available.find(({ phone }) => phone.id === preferred.phoneNumberId);
    if (phoneMatch) return phoneMatch;
  }

  if (preferred.wabaId) {
    const wabaMatches = available.filter(({ wabaId }) => wabaId === preferred.wabaId);
    if (wabaMatches.length === 1) return wabaMatches[0];
  }

  if (available.length === 1) return available[0];
  if (available.length === 0) {
    throw new Error('No WhatsApp Business phone number is available for the selected Meta account. Add and verify a Cloud API phone number in WhatsApp Manager, then reconnect.');
  }

  throw new Error('Multiple WhatsApp Business phone numbers are available and none matches this workspace.');
}

export function buildWhatsAppEmbeddedSignupUrl(input: {
  appId: string;
  apiVersion: string;
  redirectUri: string;
  state: string;
  configId: string;
}): string {
  const url = new URL(`https://www.facebook.com/${input.apiVersion}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: input.appId,
    redirect_uri: input.redirectUri,
    state: input.state,
    config_id: input.configId,
    response_type: 'code',
    override_default_response_type: 'true',
    auth_type: 'rerequest',
  }).toString();
  return url.toString();
}

function normalizeWhatsAppRecipient(value: unknown): string | null {
  const digits = String(value || '').replace(/\D/g, '');
  // Meta expects an international E.164 number without `+`. Do not guess a
  // country code for local numbers: it would create a potentially misrouted
  // production message.
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

function providerErrorResponse(error: unknown): { status: number; error: string; retryable: boolean; retryAfterMs?: number; code?: string; reason?: string; setupUrl?: string; deliveryAttempted?: boolean; outcomeUncertain?: boolean } {
  const setup = deliverySetupFailure(error);
  if (setup) return { ...setup, status: 409 };
  const candidate = error as { status?: number; message?: string; retryable?: boolean; retryAfterMs?: number };
  const retryable = candidate?.retryable === true;
  return {
    status: retryable ? 503 : candidate?.status && candidate.status >= 400 && candidate.status < 500 ? candidate.status : 502,
    error: candidate?.message || 'WhatsApp provider request failed',
    retryable,
    ...(candidate?.retryAfterMs ? { retryAfterMs: candidate.retryAfterMs } : {}),
  };
}

/**
 * GET /api/whatsapp/config
 * Get WhatsApp configuration status
 */
export async function getWhatsAppConfig(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Resolve from BOTH channel_credentials (OAuth) and api_credentials (manual)
    const resolved = await whatsappApiService.resolveCreds(userId);

    if (!resolved) {
      return res.json({
        success: true,
        configured: false,
        enabled: true,
        config: null,
      });
    }

    const sd = resolved.sessionData || {};
    const expiresAt = sd.accessTokenExpiresAt ? new Date(sd.accessTokenExpiresAt) : null;
    const now = Date.now();
    const [adminCred, credentials] = await Promise.all([
      getActiveAdminCredential('meta_app'),
      db.select({
        grantedScopes: channelCredentialsTable.grantedScopes,
        providerVerifiedAt: channelCredentialsTable.providerVerifiedAt,
        lastReadinessCheckAt: channelCredentialsTable.lastReadinessCheckAt,
        readinessErrorCode: channelCredentialsTable.readinessErrorCode,
      }).from(channelCredentialsTable).where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'whatsapp'),
        eq(channelCredentialsTable.isActive, true),
      )).limit(1),
    ]);
    const [credential] = credentials;
    const adminConfig = adminCred?.config as { webhookVerifyToken?: unknown } | undefined;
    const webhookConfigured = !!(adminConfig?.webhookVerifyToken || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
    const readinessErrorCode = credential?.readinessErrorCode || null;
    const tokenStatus = readinessErrorCode?.startsWith('meta_190_')
      ? 'invalid'
      : !expiresAt
        ? 'unknown'
        : expiresAt.getTime() <= now
          ? 'expired'
          : expiresAt.getTime() - now < 7 * 24 * 60 * 60 * 1000
            ? 'expiring_soon'
            : 'active';
    const connectionStatus = getWhatsAppConnectionStatus(readinessErrorCode);
    const customerReplyReady = Boolean(
      resolved.accessToken
      && resolved.phoneNumberId
      && resolved.businessAccountId
      && webhookConfigured
      && tokenStatus !== 'invalid'
      && tokenStatus !== 'expired'
      && (connectionStatus === 'ready' || connectionStatus === 'limited'),
    );
    const capabilities = await getMetaCapabilityStatuses({
      scopes: credential?.grantedScopes,
      accountReady: Boolean(
        resolved.accessToken
        && resolved.phoneNumberId
        && resolved.businessAccountId
        && webhookConfigured
        && connectionStatus === 'ready',
      ),
      permissions: ['whatsapp_business_messaging', 'whatsapp_business_management'],
      review: normalizeMetaAppReviewPermissions(adminCred?.config?.appReviewPermissions),
    });
    return res.json({
      success: true,
      configured: true,
      source: resolved.source,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      enabled: (sd as any).whatsappEnabled !== false, // default to true
      config: {
        phoneNumberId: resolved.phoneNumberId,
        businessAccountId: resolved.businessAccountId || '',
        accessToken: maskToken(resolved.accessToken), // masked (H6)
        webhookVerifyToken: maskToken(sd.webhookVerifyToken),
        apiVersion: resolved.apiVersion,
        hasAccessToken: !!resolved.accessToken,
        hasWebhookVerifyToken: !!sd.webhookVerifyToken,
        displayPhoneNumber: sd.displayPhoneNumber || '',
        verifiedName: sd.verifiedName || '',
        wabaName: sd.wabaName || '',
        qualityRating: sd.qualityRating || '',
        connectedViaManual: !!sd.connectedViaManual || resolved.isManual,
        accessTokenExpiresAt: sd.accessTokenExpiresAt || null,
        tokenStatus,
        connectionStatus,
        readinessErrorCode,
        readiness: {
          // `sending` is retained for existing clients and means unrestricted,
          // business-initiated delivery. Customer-service replies have their
          // own capability because Meta may allow them while billing is absent.
          sending: customerReplyReady && connectionStatus === 'ready',
          customerReplies: customerReplyReady,
          proactiveSending: customerReplyReady && connectionStatus === 'ready',
          webhook: webhookConfigured,
          oauth: !!adminCred?.apiKey && !!adminCred?.apiSecret,
        },
        grantedScopes: credential?.grantedScopes || [],
        capabilities,
        lastVerifiedAt: credential?.lastReadinessCheckAt?.toISOString() || credential?.providerVerifiedAt?.toISOString() || null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        paymentMethod: (sd as any).paymentMethod?.status || null,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppController] Error getting config');
    res.status(500).json({ error: 'Unable to retrieve WhatsApp configuration. Please try again.' });
  }
}

/**
 * POST /api/whatsapp/toggle
 * Enable/disable WhatsApp integration for the user
 */
export async function toggleWhatsApp(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    // Store the toggle state in channel_credentials session_data
    const existing = await db.select().from(channelCredentialsTable).where(
      and(eq(channelCredentialsTable.userId, userId), eq(channelCredentialsTable.platform, 'whatsapp'))
    );

    if (existing.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentSessionData = (existing[0].sessionData as any) || {};
      await db.execute(sql`
        UPDATE channel_credentials
        SET session_data = ${JSON.stringify({ ...currentSessionData, whatsappEnabled: enabled })}::jsonb,
            updated_at = NOW()
        WHERE user_id = ${userId} AND platform = 'whatsapp'
      `);
    }

    return res.json({ success: true, enabled });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[WhatsAppController] Error toggling WhatsApp');
    res.status(500).json({ error: 'Failed to toggle WhatsApp' });
  }
}

/**
 * POST /api/whatsapp/config
 * Save WhatsApp configuration
 */
export async function saveWhatsAppConfig(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      phoneNumberId,
      businessAccountId,
      accessToken,
      webhookVerifyToken,
      apiVersion,
    } = req.body;

    if (!phoneNumberId) {
      return res.status(400).json({ error: 'Phone Number ID is required' });
    }

    // Get existing credentials to preserve tokens if not provided
    const existingCreds = await CredentialService.getCredential(userId, 'whatsapp');
    
    const config: WhatsAppConfig = {
      phoneNumberId,
      businessAccountId: businessAccountId || '',
      accessToken: accessToken || (existingCreds?.config as { accessToken?: string } | undefined)?.accessToken || (existingCreds?.apiKey as string) || '',
      webhookVerifyToken: webhookVerifyToken || '',
      apiVersion: apiVersion || 'v25.0',
    };

    // Save to credentials table (Meta App ID/Secret now comes from admin config, not per-user)
    await CredentialService.saveCredential(userId, 'whatsapp', '', '', config);

    return res.json({
      success: true,
      message: 'WhatsApp configuration saved successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[WhatsAppController] Error saving config');
    res.status(500).json({ error: 'Unable to save WhatsApp configuration. Please try again.' });
  }
}

/**
 * POST /api/whatsapp/test
 * Test WhatsApp connection
 */
/** Accounts on AskSales' credit line need no card of their own in Meta. */
async function paymentMethodStatus(userId: number, resolved: NonNullable<Awaited<ReturnType<typeof whatsappApiService.resolveCreds>>>) {
  const { isPlatformBilledAccount } = await import('../services/whatsapp/WhatsAppBillingService.js');
  if (await isPlatformBilledAccount(userId, resolved.phoneNumberId).catch(() => false)) return 'billed_by_asksales' as const;
  return whatsappApiService.checkPaymentMethod(resolved);
}

export async function testWhatsAppConnection(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { phoneNumberId: bodyPhoneId, accessToken: bodyToken, apiVersion: bodyApiVersion } = req.body || {};

    // Resolve from stored credentials, allow body to override (e.g. testing fresh creds before save)
    const resolved = await whatsappApiService.resolveCreds(userId);
    const phoneNumberId = bodyPhoneId || resolved?.phoneNumberId;
    const token = bodyToken || resolved?.accessToken;
    const apiVersion = bodyApiVersion || resolved?.apiVersion || 'v25.0';

    if (!phoneNumberId || !token) {
      return res.status(400).json({ error: 'WhatsApp not configured. Save credentials first.' });
    }

    // Test connection — token in Authorization header (H7), never query string
    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) {
      const errorData = await response.json() as { error?: { message?: string; code?: number; error_subcode?: number } };
      if (resolved) {
        await whatsappApiService.recordReadiness(resolved, {
          ok: false,
          code: errorData.error?.code,
          subcode: errorData.error?.error_subcode,
        });
      }
      const reconnectRequired = errorData.error?.code === 190;
      const phoneNumberUnavailable = errorData.error?.code === 100
        && errorData.error?.error_subcode === 33;
      // A 401/403 here belongs to Meta, not to the signed-in AskSales user.
      // Returning the provider status directly makes the client auth layer
      // treat a stale WhatsApp token as an expired AskSales session and log
      // the owner out. Keep application authentication distinct and expose
      // the upstream failure as a failed dependency instead.
      return res.status(424).json({
        success: false,
        reconnectRequired,
        code: reconnectRequired
          ? 'WHATSAPP_REAUTH_REQUIRED'
          : phoneNumberUnavailable
            ? 'WHATSAPP_PHONE_NUMBER_UNAVAILABLE'
            : 'WHATSAPP_CONNECTION_FAILED',
        error: reconnectRequired
          ? 'WhatsApp authorization is no longer valid. Reconnect WhatsApp to restore replies.'
          : phoneNumberUnavailable
            ? 'The selected phone number is no longer available on the connected WhatsApp Business Account. Check account restrictions, phone registration, and business verification in WhatsApp Manager before reconnecting.'
            : 'WhatsApp Cloud API rejected the connection test.',
      });
    }

    const data = await response.json() as { verified_name?: string; display_phone_number?: string };
    if (resolved) await whatsappApiService.recordReadiness(resolved, { ok: true });
    // Only the saved connection is checked; a body token is a pre-save test.
    const paymentMethod = resolved && !bodyToken && !bodyPhoneId
      ? await paymentMethodStatus(userId, resolved)
      : undefined;

    return res.json({
      success: true,
      businessName: data.verified_name || data.display_phone_number,
      message: 'WhatsApp connection successful',
      ...(paymentMethod ? { paymentMethod } : {}),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppController] Error testing connection');
    res.status(500).json({ 
      success: false,
      error: 'Unable to test the WhatsApp connection. Please try again.' 
    });
  }
}

/**
 * DELETE /api/whatsapp/config
 * Delete WhatsApp configuration
 */
export async function deleteWhatsAppConfig(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const currentResolved = await whatsappApiService.resolveCreds(userId);
    const currentSession = currentResolved?.sessionData || {};
    // Keep only non-secret account identity so a later Embedded Signup can
    // deterministically reconnect the same phone even when Meta authorizes
    // several WABAs. Tokens and other reusable secret material are removed.
    const retiredSession = currentResolved ? encryptChannelCredentialSession({
      phoneNumberId: currentResolved.phoneNumberId,
      businessAccountId: currentResolved.businessAccountId || '',
      apiVersion: currentResolved.apiVersion,
      displayPhoneNumber: currentSession.displayPhoneNumber || '',
      verifiedName: currentSession.verifiedName || '',
      wabaName: currentSession.wabaName || '',
      qualityRating: currentSession.qualityRating || '',
    }) : {};

    // Provider verification and canary records are immutable and retain a
    // reference to the credential that was verified. Physically deleting a
    // channel credential therefore (correctly) fails. Disconnect by retiring
    // the credential and removing all reusable secret material while keeping
    // the stable row/account identity for audit and a future reconnect.
    await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`
        UPDATE channel_credentials
           SET is_active = false,
               is_selected = false,
               access_token = NULL,
               refresh_token = NULL,
               api_key = NULL,
               api_secret = NULL,
               session_cookies = NULL,
               session_data = ${JSON.stringify(retiredSession)}::jsonb,
               token_expiry = NULL,
               granted_scopes = '[]'::jsonb,
               provider_verified_at = NULL,
               last_readiness_check_at = NOW(),
               readiness_error_code = 'DISCONNECTED',
               deactivation_reason = 'user_disconnected',
               deactivated_at = NOW(),
               updated_at = NOW()
         WHERE user_id = ${userId}
           AND platform = 'whatsapp'
      `);

      // The legacy/manual credential store is retired in place for the same
      // reason and so no usable token survives a disconnect.
      await tx.execute(sql`
        UPDATE api_credentials
           SET api_key = '',
               api_secret = NULL,
               config = '{}'::jsonb,
               is_active = false,
               updated_at = NOW()
         WHERE user_id = ${userId}
           AND service_name = 'whatsapp'
      `);
    });

    if (currentResolved?.businessAccountId) {
      const { revokeWhatsAppCreditLinesAfterDisconnect } = await import('../services/whatsapp/WhatsAppCreditLineDisconnect.js');
      await revokeWhatsAppCreditLinesAfterDisconnect(userId, [currentResolved.businessAccountId]);
    }

    return res.json({
      success: true,
      message: 'WhatsApp disconnected successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppController] Error deleting config');
    res.status(500).json({ error: 'Unable to delete WhatsApp configuration. Please try again.' });
  }
}

/**
 * GET /api/whatsapp/webhook
 * WhatsApp webhook verification (GET)
 */
export async function verifyWebhook(req: Request, res: Response) {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe') {
      // Verify token against admin-configured webhook verify token
      const adminCred = await getActiveAdminCredential('meta_app');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const expectedToken = (adminCred?.config as any)?.webhookVerifyToken
        || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
        || process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;

      if (!expectedToken) {
        logger.error('[WhatsApp Webhook] Verify token is not configured');
        return res.sendStatus(503);
      }
      if (typeof token !== 'string' || typeof challenge !== 'string' || !timingSafeEqual(token, expectedToken)) {
        logger.warn('[WhatsApp Webhook] Verify token mismatch');
        return res.sendStatus(403);
      }

      logger.info('[WhatsApp Webhook] Verification successful');
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppController] Webhook verification error');
    res.sendStatus(500);
  }
}

/**
 * POST /api/whatsapp/webhook
 * WhatsApp webhook for incoming messages (POST)
 */
export async function handleWebhook(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const signature = req.headers['x-hub-signature-256'] as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isLegacyTokenAuth = (req as any)._legacyTokenAuth === true;

    if (!isLegacyTokenAuth) {
      if (!rawBody?.length) {
        logger.error('[WhatsApp Webhook] Raw request body unavailable; refusing unverifiable event');
        return res.status(400).json({ error: 'Invalid webhook payload' });
      }
      // Load App Secret to verify
      const adminCred = await getActiveAdminCredential('meta_app');
      if (!adminCred || !adminCred.apiSecret) {
        logger.error('Meta App Secret missing for webhook validation');
        return res.status(500).json({ error: 'System configuration error' });
      }

      if (!verifyMetaSignature(signature, rawBody, adminCred.apiSecret)) {
        logger.warn({ ip: req.ip }, '[WhatsApp Webhook] Invalid signature');
        return res.status(403).json({ error: 'Invalid signature' });
      }
    }

    // Defensive parsing with Zod
    const parsedPayload = WhatsAppMessagePayloadSchema.safeParse(req.body);
    if (!parsedPayload.success) {
      logger.debug({ issues: parsedPayload.error.issues }, '[WhatsApp Webhook] Received webhook but failed Zod structured validation. Potentially non-message event.');
      return res.sendStatus(200); // Always 200 to prevent retries
    }

    const body = parsedPayload.data;

    for (const entry of body.entry) {
      for (const change of entry.changes) {
        if (change.field === 'messages' || change.field === 'smb_message_echoes') {
          const value = change.value;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const displayPhoneNumber = value.metadata.display_phone_number;
          const phoneNumberId = value.metadata.phone_number_id;
          
          if (!value.messages?.length && !value.statuses?.length && !value.message_echoes?.length) continue;

          // Tenant Resolution
          const lookup = () => db.select().from(channelCredentialsTable).where(and(eq(channelCredentialsTable.accountIdentifier, phoneNumberId), eq(channelCredentialsTable.platform, 'whatsapp'), eq(channelCredentialsTable.isActive, true)));
          const existingCreds = currentBusinessScope() ? await lookup() : await withSystemScope('Resolve signed WhatsApp phone', lookup);
          const credential = existingCreds.length === 1 ? existingCreds[0] : null;
          
          if (!credential) {
            logger.warn({ phoneNumberId }, '[WhatsApp Webhook] No tenant configured for this phone_number_id. Dropping.');
            continue;
          }

          const userId = credential.userId;
          if (!credential.businessProfileId) continue;
          await withBusinessScope({ userId, businessProfileId:credential.businessProfileId }, async () => {
          for (const echo of value.message_echoes || []) {
            const { persistNativeSocialMessage } = await import('../services/SocialMessagePersistence.js');
            const message = echo.type === 'edit' ? echo.edit?.message || echo : echo;
            const media = message.image || message.video || message.audio || message.document;
            await persistNativeSocialMessage({ userId, channel: 'whatsapp', accountId: phoneNumberId,
              recipientId: echo.to.replace(/\D/g, ''), providerMessageId: echo.id,
              timestamp: new Date(Number(echo.timestamp) * 1000), text: message.text?.body || media?.caption || '',
              eventType: echo.type === 'edit' ? 'edit' : echo.type === 'revoke' ? 'revoke' : 'message',
              originalMessageId: echo.edit?.original_message_id || echo.revoke?.original_message_id,
              attachments: media ? [{ type: message.type, name: media.filename, mimeType: media.mime_type, mediaId: media.id }] : [],
            });
          }
          for (const message of value.messages || []) {
            const senderPhone = message.from;
            const messageId = message.id;
            const normalizedInbound = normalizeWhatsAppInboundText(message);
            const messageContent = normalizedInbound.text;
            const inboundPreview = redactPiiWithStableTokens(messageContent);
            const messageTimestamp = message.timestamp ? new Date(parseInt(message.timestamp) * 1000) : new Date();

            // Idempotency DB check — check both waba_message_id and external_message_id columns
            const existingMsgResult = await db.execute(sql`
              SELECT m.id,m.conversation_id FROM outreach_messages m
              JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
              WHERE m.user_id = ${userId} AND c.channel='whatsapp' AND c.provider_account_id=${phoneNumberId}
                AND m.direction='inbound' AND (m.waba_message_id = ${messageId}
                  OR m.external_message_id = ${messageId})
              LIMIT 1
            `);

            const existingMessage = existingMsgResult.rows[0];

            // Database Persistence
            try {
              let conversationId: number;

              // Find strictly matching tenant isolation
              const existingConvResult = await db.execute(sql`
                SELECT id FROM outreach_conversations 
                WHERE channel = 'whatsapp' AND user_id = ${userId} AND external_thread_id = ${senderPhone}
                  AND provider_account_id = ${phoneNumberId}
                  AND session_ended_at IS NULL
                  AND status NOT IN ('closed', 'resolved')
                  AND automation_mode NOT IN ('closed', 'resolved')
                ORDER BY last_message_at DESC NULLS LAST
                LIMIT 1
              `);

              if (existingMessage) {
                conversationId = Number(existingMessage.conversation_id);
              } else if (existingConvResult.rows.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                conversationId = (existingConvResult.rows[0] as any).id;
                
              } else {
                // Try to map sender phone -> existing lead so analytics/CRM stitch correctly (H4)
                let leadId = 0;
                let leadName = value.contacts?.[0]?.profile?.name || senderPhone;
                try {
                  // Match by phone (with or without leading +) using explicit OR conditions
                  const senderPhonePlus = `+${senderPhone}`;
                  const leadRows = await db.execute(sql`
                    SELECT id, name, full_name FROM leads
                    WHERE user_id = ${userId}
                      AND (
                        phone = ${senderPhone} OR phone = ${senderPhonePlus}
                        OR whatsapp = ${senderPhone} OR whatsapp = ${senderPhonePlus}
                      )
                    ORDER BY id ASC
                    LIMIT 1
                  `);
                  if (leadRows.rows.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const lr: any = leadRows.rows[0];
                    leadId = lr.id;
                    leadName = lr.full_name || lr.name || leadName;
                  }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } catch (lookupErr: any) {
                  logger.warn({ err: lookupErr, userId }, '[WhatsApp Webhook] Lead phone lookup failed, will auto-create.');
                }

                // Auto-create a lead for unknown WhatsApp senders so the FK constraint is satisfied
                if (!leadId) {
                  try {
                    const contactName = value.contacts?.[0]?.profile?.name || null;
                    const { lockSocialProviderMessage } = await import('../services/SocialMessagePersistence.js');
                    const newLeadRows = await db.transaction(async (tx: typeof db) => {
                      await lockSocialProviderMessage(tx,userId,'whatsapp',phoneNumberId,`recipient:${senderPhone}`);
                      const prior = await tx.execute(sql`SELECT id,name FROM leads WHERE user_id=${userId}
                        AND (regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=${senderPhone.replace(/\D/g,'')}
                          OR platform_extended->>'whatsapp_id'=${senderPhone}) ORDER BY id LIMIT 1`);
                      if (prior.rows.length) return prior;
                      return tx.execute(sql`
                      INSERT INTO leads (uuid, user_id, name, first_name, phone, status, source, platform_extended, created_at, updated_at)
                      VALUES (
                        ${crypto.randomUUID()},
                        ${userId},
                        ${contactName || senderPhone},
                        ${contactName?.split(' ')[0] || senderPhone},
                        ${senderPhone},
                        'new',
                        'whatsapp',
                        ${JSON.stringify({ whatsapp: senderPhone, whatsapp_id: senderPhone })}::jsonb,
                        NOW(),
                        NOW()
                      )
                      RETURNING id, name
                    `);
                    });
                    if (newLeadRows.rows.length > 0) {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const nl: any = newLeadRows.rows[0];
                      leadId = nl.id;
                      leadName = nl.name || leadName;
                      logger.info({ userId, leadId }, '[WhatsApp Webhook] Auto-created lead for unknown sender.');
                    }
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  } catch (leadErr: any) {
                    logger.error({ err: leadErr, userId }, '[WhatsApp Webhook] Failed to auto-create lead.');
                  }
                }

                if (!leadId) {
                  logger.warn({ userId }, '[WhatsApp Webhook] Cannot create conversation: no lead resolved. Skipping.');
                  throw new Error('No lead could be resolved for the inbound WhatsApp message.');
                }

                const newConv = await getOrCreateConversation({
                  userId,
                  leadId,
                  channel: 'whatsapp',
                  providerAccountId: phoneNumberId,
                  integrationProvider: 'whatsapp_cloud',
                  externalThreadId: senderPhone, // single conversation per phone (like IG/FB)
                  leadName,
                  status: 'active',
                  lastMessageAt: messageTimestamp,
                  lastMessageBy: 'lead',
                  lastMessagePreview: inboundPreview.redactedText.substring(0, 200),
                  totalMessages: 0,
                  unreadCount: 0,
                  metadata: { phoneNumber: senderPhone, phoneNumberId: phoneNumberId },
                });
                conversationId = newConv.id;
              }

              // Serialize by receiving account and provider ID. A retry resumes the
              // durable dispatch below, while only the first insert changes counters.
              const { lockSocialProviderMessage } = await import('../services/SocialMessagePersistence.js');
              const persistedMessage = await db.transaction(async (tx: typeof db) => {
                await lockSocialProviderMessage(tx,userId,'whatsapp',phoneNumberId,messageId);
                const prior = (await tx.execute(sql`SELECT m.id,m.conversation_id FROM outreach_messages m
                  JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
                  WHERE m.user_id=${userId} AND c.channel='whatsapp' AND c.provider_account_id=${phoneNumberId}
                    AND m.direction='inbound' AND (m.waba_message_id=${messageId} OR m.external_message_id=${messageId}) LIMIT 1`)).rows[0];
                if (prior) return {id:Number(prior.id),conversationId:Number(prior.conversation_id)};
                const [created] = await tx.insert(outreachMessagesTable).values({
                  conversationId,userId,direction:'inbound',content:inboundPreview.redactedText,
                  externalMessageId:messageId,wabaMessageId:messageId,providerMessageId:messageId,
                  phoneNumberId,providerAccountId:phoneNumberId,messageType:message.type,status:'delivered',
                  sentAt:messageTimestamp,deliveredAt:messageTimestamp,
                  metadata:{from:senderPhone,...(normalizedInbound.selection?{nativeSelection:normalizedInbound.selection}:{})},
                }).returning();
                await tx.execute(sql`UPDATE outreach_conversations
                  SET last_message_at=GREATEST(last_message_at,${messageTimestamp}),last_message_by='lead',
                    last_message_preview=${inboundPreview.redactedText.substring(0,200)},
                    total_messages=COALESCE(total_messages,0)+1,unread_count=COALESCE(unread_count,0)+1,updated_at=NOW()
                  WHERE id=${conversationId} AND user_id=${userId}`);
                return {id:created.id,conversationId};
              });
              conversationId=persistedMessage.conversationId;
              const { registerSupportTurnInput } = await import('../services/agents/orchestration/SupportConversationTurn.js');
              await registerSupportTurnInput('process_whatsapp_webhook', {
                userId, conversationId, phoneNumberId, messageId, inboundMessageId: persistedMessage.id,
                inboundText: inboundPreview.redactedText,
              }, false);
              const protectedInbound = await privacyVaultService.protectInbound({
                userId,
                conversationId,
                channel: 'whatsapp',
                rawText: messageContent,
                providerMessageId: messageId,
                messageId: persistedMessage.id,
                entityType: 'outreach_message',
                entityId: persistedMessage.id,
              });

              // Resolve and link the durable CRM identity for every accepted
              // inbound event. This happens synchronously before agent work so
              // a new playbook run can hydrate trusted profile fields.
              await inboundContactResolver.reconcile({
                userId,
                conversationId,
                channel: 'whatsapp',
                messageId: persistedMessage.id,
                providerMessageId: messageId,
                externalIdentifier: senderPhone,
                displayName: value.contacts?.[0]?.profile?.name || undefined,
                source: 'whatsapp',
                trust: 'provider',
                recordReply: true,
              });

              let attachmentContext = '';
              const voiceReplyRequested = message.type === 'audio';
              let audioTranscriptionUnavailable = voiceReplyRequested;
              if (['image', 'document', 'audio'].includes(message.type)) {
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const media = (message as any)[message.type] as { id?: string; filename?: string; mime_type?: string; voice?: boolean } | undefined;
                  if (media?.id) {
                    const downloaded = await whatsappApiService.downloadMedia(userId, media.id, phoneNumberId);
                    const extension = message.type === 'image'
                      ? (downloaded.mimeType === 'image/png' ? 'png' : 'jpg')
                      : message.type === 'audio'
                        ? (downloaded.mimeType.includes('ogg') ? 'ogg' : downloaded.mimeType.includes('mp4') ? 'm4a' : 'mp3')
                        : 'bin';
                    const attachment = await outreachAttachmentService.persistInboundBuffer({
                      userId,
                      messageId: persistedMessage.id,
                      buffer: downloaded.buffer,
                      mimeType: downloaded.mimeType,
                      fileName: media.filename || `${message.type}-${media.id}.${extension}`,
                      providerAttachmentId: `${messageId}:${media.id}`,
                      providerMediaId: media.id,
                      source: 'whatsapp_webhook',
                      metadata: {
                        isVoiceMessage: message.type === 'audio' && media.voice === true,
                        providerMessageType: message.type,
                      },
                    });
                    audioTranscriptionUnavailable = voiceReplyRequested && attachment.extractionStatus !== 'success';
                    attachmentContext = redactPiiWithStableTokens(
                      await outreachAttachmentService.getGroundedContext([persistedMessage.id], userId),
                    ).redactedText;
                  }
                } catch (attachmentError) {
                  logger.warn({ err: attachmentError, messageId, messageType: message.type }, '[WhatsApp Webhook] Attachment could not be safely persisted');
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const failedMedia = (message as any)[message.type] as { id?: string; filename?: string; mime_type?: string; voice?: boolean } | undefined;
                  await outreachAttachmentService.recordInboundFailure({
                    userId,
                    messageId: persistedMessage.id,
                    fileName: failedMedia?.filename || `${message.type}-${failedMedia?.id || messageId}`,
                    mimeType: failedMedia?.mime_type,
                    providerAttachmentId: `${messageId}:${failedMedia?.id || message.type}`,
                    providerMediaId: failedMedia?.id,
                    source: 'whatsapp_webhook',
                    error: attachmentError,
                    metadata: {
                      isVoiceMessage: message.type === 'audio' && failedMedia?.voice === true,
                      providerMessageType: message.type,
                    },
                  }).catch((recordError) => {
                    logger.warn({ err: recordError, messageId }, '[WhatsApp Webhook] Attachment failure metadata could not be persisted');
                  });
                }
              }

              const { cancelSocialFollowUpsForConversation } = await import('../services/socialFollowUpService.js');
              await cancelSocialFollowUpsForConversation(conversationId, 'reply_received');

              logger.info({ userId, conversationId }, '[WhatsApp] Message stored successfully. Enqueueing AI generation job.');

              // Enqueue Async Job
              await jobDispatcher.dispatch('process_whatsapp_webhook', {
                conversationId,
                userId,
                phoneNumberId,
                inboundText: attachmentContext
                  ? `${protectedInbound.redactedText}\n\nSuccessfully extracted attachment content:\n${attachmentContext}`
                  : audioTranscriptionUnavailable
                    ? `${protectedInbound.redactedText}\n\nAudio transcription is unavailable. Do not claim to understand or quote the recording; reply safely and ask the sender to restate key details in text if needed.`
                    : protectedInbound.redactedText,
                messageId,
                inboundMessageId: persistedMessage.id,
                voiceReplyRequested,
                privacyPreprotected: {
                  vaultId: protectedInbound.vaultId,
                  piiTypes: protectedInbound.piiTypes,
                  tokenCount: protectedInbound.tokenCount,
                },
              });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (err: any) {
              logger.error({ err, messageId }, '[WhatsApp Webhook] Failure during message persistence.');
              throw err;
            }
          }

          // C5: Process delivery / read / failed status events
          if (value.statuses && value.statuses.length > 0) {
            for (const st of value.statuses) {
              try {
                const { processWhatsAppStatus } = await import('./webhooksController.js');
                await processWhatsAppStatus(userId, st, { phone_number_id: phoneNumberId });
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } catch (statusErr: any) {
                logger.error({ err: statusErr, statusEvent: st }, '[WhatsApp Webhook] Status update failed');
                throw statusErr;
              }
            }
          }
          });
        }
      }
    }

    return res.sendStatus(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppController] Webhook error');
    res.sendStatus(500);
  }
}

 

export async function getOAuthUrl(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const adminCred = await getActiveAdminCredential('meta_app');
  if (!adminCred || !adminCred.apiKey) {
    return res.status(500).json({ error: 'Meta App not configured by admin. Please contact your administrator.' });
  }

  const metaConfig = adminCred.config as { apiVersion?: string; configId?: unknown } | undefined;
  const apiVersion = metaConfig?.apiVersion || 'v25.0';
  const embeddedSignupConfigId = String(metaConfig?.configId || '').trim();
  if (!/^\d{5,30}$/.test(embeddedSignupConfigId)) {
    return res.status(503).json({
      error: 'WhatsApp Embedded Signup is not configured by the platform administrator.',
    });
  }
  const redirectUri = getIntegrationOAuthCallbackUrl('whatsapp');

  // H1: CSRF nonce stored in Redis, replayable only once within 10 min
  const nonce = crypto.randomBytes(24).toString('hex');
  await getRedisConnection().setex(`wa_oauth_nonce:${nonce}`, OAUTH_NONCE_TTL_SECONDS, String(userId));
  const state = Buffer.from(JSON.stringify({ userId, nonce })).toString('base64url');
  await rememberOAuthBusinessState(state);

  const authUrl = buildWhatsAppEmbeddedSignupUrl({
    appId: adminCred.apiKey,
    apiVersion,
    redirectUri,
    state,
    configId: embeddedSignupConfigId,
  });

  res.json({ url: authUrl });
}

export async function handleOAuthCallback(req: Request, res: Response) {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
  let oauthStage = 'callback_validation';
  try {
    const { code, state, error, error_description } = req.query;

    // Handle OAuth errors (user denied, cancelled, etc.)
    if (error) {
      logger.warn({ error, error_description }, '[WhatsAppOAuth] OAuth error/cancel');
      return res.redirect(
        `${FRONTEND_URL}/dashboard/integrations/whatsapp?error=${encodeURIComponent(String(error_description || error))}`
      );
    }
    
    if (!state) return res.redirect(`${FRONTEND_URL}/dashboard/integrations/whatsapp?error=State+missing`);

    // Decode state and validate CSRF nonce (H1)
    let stateData: { userId?: number; nonce?: string };
    try {
      stateData = JSON.parse(Buffer.from(state as string, 'base64url').toString());
    } catch {
      try { stateData = JSON.parse(Buffer.from(state as string, 'base64').toString()); }
      catch { return res.redirect(`${FRONTEND_URL}/dashboard/integrations/whatsapp?error=${encodeURIComponent('Invalid state')}`); }
    }
    const userId = stateData.userId;
    const nonce = stateData.nonce;
    if (!userId) return res.redirect(`${FRONTEND_URL}/dashboard/integrations/whatsapp?error=Unauthorized`);
    if (nonce) {
      const stored = await getRedisConnection().get(`wa_oauth_nonce:${nonce}`);
      if (!stored || stored !== String(userId)) {
        logger.warn({ nonce, userId }, '[WhatsAppOAuth] CSRF nonce mismatch or expired');
        return res.redirect(`${FRONTEND_URL}/dashboard/integrations/whatsapp?error=${encodeURIComponent('Session expired. Please retry.')}`);
      }
      await getRedisConnection().del(`wa_oauth_nonce:${nonce}`); // single-use
    }

    if (!code) {
      throw new Error('OAuth code missing');
    }

    const adminCred = await getActiveAdminCredential('meta_app');
    if (!adminCred || !adminCred.apiKey || !adminCred.apiSecret) {
      return res.status(400).json({ error: 'Global Meta App credentials not configured' });
    }

    const appId = adminCred.apiKey;
    const appSecret = adminCred.apiSecret;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiVersion = (adminCred.config as any)?.apiVersion || 'v25.0';
    // Standard OAuth redirect URI matching Meta's exact allowed callback
    const redirectUri = getIntegrationOAuthCallbackUrl('whatsapp');

    const existingResolved = await whatsappApiService.resolveCreds(userId);
    // Disconnect retires provider secrets but deliberately preserves the
    // account identifier for audit and deterministic reconnects. resolveCreds
    // returns only active rows, so consult the latest historical credential as
    // well; otherwise a reconnect forgets the workspace's previously selected
    // phone at exactly the point where Meta may return several/partial assets.
    const [historicalCredential] = existingResolved ? [] : await db.select({
      phoneNumberId: channelCredentialsTable.accountIdentifier,
      sessionData: channelCredentialsTable.sessionData,
    })
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'whatsapp'),
      ))
      .orderBy(desc(channelCredentialsTable.updatedAt), desc(channelCredentialsTable.id))
      .limit(1);
    const historicalSession = historicalCredential?.sessionData
      ? decryptChannelCredentialSession(historicalCredential.sessionData as Record<string, unknown>)
      : {};
    const preferredWabaId = existingResolved?.businessAccountId
      || (typeof historicalSession.businessAccountId === 'string' ? historicalSession.businessAccountId : undefined);
    const preferredPhoneNumberId = existingResolved?.phoneNumberId
      || historicalCredential?.phoneNumberId
      || undefined;

    // 1. Exchange code for access_token (H2: encode redirect_uri & code)
    oauthStage = 'token_exchange';
    const tokenResponse = await fetch(`https://graph.facebook.com/${apiVersion}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        redirect_uri: redirectUri,
        client_secret: appSecret,
        code: String(code),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenData = await tokenResponse.json() as any;
    logger.info({
      ok: tokenResponse.ok,
      hasAccessToken: typeof tokenData.access_token === 'string',
      tokenType: tokenData.token_type || null,
      expiresIn: Number.isFinite(Number(tokenData.expires_in)) ? Number(tokenData.expires_in) : null,
    }, '[WhatsAppOAuth] Token exchange completed');

    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error(tokenData?.error?.message || 'Failed to exchange OAuth code');
    }
    
    // Explicit token metadata extraction
    const accessToken = tokenData.access_token;
    const tokenType = tokenData.token_type || 'bearer';
    const expiresIn = tokenData.expires_in; // Seconds
    const issuedAt = new Date().toISOString();
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    // 2. Discover every authorized WABA. Meta does not guarantee the ordering
    // of granular-scope target IDs, and a Facebook user can administer several
    // businesses. Reconnects must preserve the workspace's existing phone.
    oauthStage = 'account_discovery';
    const candidateWabaIds = new Set<string>();
    if (preferredWabaId) candidateWabaIds.add(preferredWabaId);

    // Try the standard /me endpoint first
    const meResponse = await fetch(`https://graph.facebook.com/${apiVersion}/me?fields=whatsapp_business_account`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meData = await meResponse.json() as any;
    logger.info({
      ok: meResponse.ok,
      hasWhatsAppBusinessAccount: Boolean(meData.whatsapp_business_account?.id),
      providerCode: Number.isFinite(Number(meData?.error?.code)) ? Number(meData.error.code) : null,
    }, '[WhatsAppOAuth] /me discovery completed');

    if (meData.whatsapp_business_account?.id) {
      candidateWabaIds.add(String(meData.whatsapp_business_account.id));
    }

    try {
      const debugUrl = new URL(`https://graph.facebook.com/${apiVersion}/debug_token`);
      debugUrl.searchParams.set('input_token', accessToken);
      const debugResp = await fetch(debugUrl, {
        headers: {
          Authorization: `Bearer ${appId}|${appSecret}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debugData = await debugResp.json() as any;
      const granularScopes = Array.isArray(debugData?.data?.granular_scopes)
        ? debugData.data.granular_scopes
        : [];
      for (const scope of granularScopes) {
        if (!['whatsapp_business_messaging', 'whatsapp_business_management'].includes(String(scope?.scope))) continue;
        for (const targetId of Array.isArray(scope?.target_ids) ? scope.target_ids : []) {
          if (targetId) candidateWabaIds.add(String(targetId));
        }
      }
      logger.info({ candidateCount: candidateWabaIds.size }, '[WhatsAppOAuth] Discovered authorized WABA candidates');
    } catch (err) {
      logger.warn({ err }, '[WhatsAppOAuth] Could not inspect granular WhatsApp scopes');
    }

    if (candidateWabaIds.size === 0) {
      throw new Error('No WhatsApp Business Account associated with this token. Ensure your Facebook account has a WhatsApp Business Account and the app has whatsapp_business_management permission.');
    }

    // 3. Fetch the authorized phone numbers and deterministically preserve the
    // tenant's existing account binding when this is a reconnect.
    oauthStage = 'phone_discovery';
    const accountCandidates: WhatsAppOAuthAccountCandidate[] = [];
    const orderedWabaIds = Array.from(candidateWabaIds).slice(0, 50);
    for (const [candidateIndex, candidateWabaId] of orderedWabaIds.entries()) {
      const phoneResponse = await fetch(`https://graph.facebook.com/${apiVersion}/${candidateWabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const phoneData = await phoneResponse.json() as any;
      const phones = phoneResponse.ok && Array.isArray(phoneData?.data)
        ? phoneData.data as WhatsAppOAuthPhone[]
        : [];
      accountCandidates.push({ wabaId: candidateWabaId, phones });
      logger.info({
        candidateIndex,
        ok: phoneResponse.ok,
        status: phoneResponse.status,
        phoneCount: phones.length,
        providerCode: Number.isFinite(Number(phoneData?.error?.code)) ? Number(phoneData.error.code) : null,
        providerSubcode: Number.isFinite(Number(phoneData?.error?.error_subcode)) ? Number(phoneData.error.error_subcode) : null,
        providerType: typeof phoneData?.error?.type === 'string' ? phoneData.error.type : null,
      }, '[WhatsAppOAuth] Phone discovery result');
      if (preferredPhoneNumberId && phones.some((phone) => phone.id === preferredPhoneNumberId)) break;
    }

    // Meta can omit the WABA phone edge during a reconnect even while the
    // freshly issued token still authorizes the previously selected phone.
    // Validate that preserved ID directly and bind it only when the WABA is
    // otherwise unambiguous. This recovers the tenant's existing connection
    // without guessing or silently selecting a different business asset.
    const discoveredPhoneCount = accountCandidates.reduce((total, candidate) => total + candidate.phones.length, 0);
    if (discoveredPhoneCount === 0 && preferredPhoneNumberId && preferredWabaId) {
      const preservedPhoneResponse = await fetch(
        `https://graph.facebook.com/${apiVersion}/${preferredPhoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preservedPhoneData = await preservedPhoneResponse.json() as any;
      const preservedPhone = preservedPhoneResponse.ok
        && typeof preservedPhoneData?.id === 'string'
        && preservedPhoneData.id === preferredPhoneNumberId
        ? preservedPhoneData as WhatsAppOAuthPhone
        : null;
      logger.info({
        ok: preservedPhoneResponse.ok,
        status: preservedPhoneResponse.status,
        matchedPreservedPhone: Boolean(preservedPhone),
        providerCode: Number.isFinite(Number(preservedPhoneData?.error?.code)) ? Number(preservedPhoneData.error.code) : null,
        providerSubcode: Number.isFinite(Number(preservedPhoneData?.error?.error_subcode)) ? Number(preservedPhoneData.error.error_subcode) : null,
        providerType: typeof preservedPhoneData?.error?.type === 'string' ? preservedPhoneData.error.type : null,
      }, '[WhatsAppOAuth] Preserved phone validation result');
      const preferredCandidate = accountCandidates.find((candidate) => candidate.wabaId === preferredWabaId);
      if (preservedPhone && preferredCandidate) preferredCandidate.phones.push(preservedPhone);
    }

    const selectedAccount = selectWhatsAppOAuthAccount(accountCandidates, {
      wabaId: preferredWabaId,
      phoneNumberId: preferredPhoneNumberId,
    });
    const wabaId = selectedAccount.wabaId;
    const phoneNumberId = selectedAccount.phone.id;
    const displayNumber = selectedAccount.phone.display_phone_number;
    const verifiedName = selectedAccount.phone.verified_name || '';
    const qualityRating = selectedAccount.phone.quality_rating || '';
    logger.info({
      candidateCount: accountCandidates.length,
      selectedExistingPhone: phoneNumberId === preferredPhoneNumberId,
      selectedExistingWaba: wabaId === preferredWabaId,
    }, '[WhatsAppOAuth] Selected authorized WhatsApp account');

    // 3b. Fetch WABA profile info (name)
    let wabaName = '';
    try {
      const wabaResponse = await fetch(`https://graph.facebook.com/${apiVersion}/${wabaId}?fields=name`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wabaData = await wabaResponse.json() as any;
      wabaName = wabaData.name || '';
    } catch (wabaErr) {
      logger.warn({ err: wabaErr }, '[WhatsAppController] Could not fetch WABA name (non-blocking)');
    }

    // Use verified_name > WABA name > display phone as the account display name
    const accountName = verifiedName || wabaName || displayNumber || '';

    // Multi-Phone OAuth Deduplication
    const existingPhoneCreds = await db.select().from(channelCredentialsTable).where(eq(channelCredentialsTable.accountIdentifier, phoneNumberId));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conflictingCred = existingPhoneCreds.find((c: any) => c.userId !== userId && c.platform === 'whatsapp');
    if (conflictingCred) {
      // H8: redirect (not JSON) so the popup-flow UI handles it
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations/whatsapp?error=${encodeURIComponent('This phone number is already connected to another workspace. Disconnect it there first, then retry.')}`);
    }

    // 4. Persist the selected account and freshly issued token.
    oauthStage = 'credential_persistence';
    const config = {
      phoneNumberId,
      businessAccountId: wabaId,
      accessToken: accessToken,
      tokenType,
      expiresIn,
      issuedAt,
      accessTokenExpiresAt: expiresAt,
      webhookVerifyToken: '', // Admin level
      apiVersion,
      displayPhoneNumber: displayNumber,
      verifiedName,
      wabaName,
      qualityRating,
    };

    // Preserve the stable credential id because immutable provider-verification
    // audits reference it. A reconnect reactivates and rotates the same
    // tenant/account row; it never deletes history to make room for a token.
    const insertedCredential = await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`
        UPDATE channel_credentials
           SET is_selected = false,
               updated_at = NOW()
         WHERE user_id = ${userId}
           AND platform = 'whatsapp'
      `);
      return tx.execute(sql`
        INSERT INTO channel_credentials (
          user_id, platform, credential_type, api_key, api_secret,
          account_identifier, account_name, session_data, access_token,
          token_expiry, last_refreshed_at, encryption_version,
          encryption_key_id, encrypted_at, is_active, is_selected,
          deactivation_reason, deactivated_at, provider_verified_at,
          last_readiness_check_at, readiness_error_code
        )
        VALUES (
          ${userId}, 'whatsapp', 'oauth', ${encryptChannelCredentialSecret(accessToken)}, NULL,
          ${phoneNumberId}, ${accountName}, ${JSON.stringify(encryptChannelCredentialSession(config))}::jsonb,
          ${encryptChannelCredentialSecret(accessToken)}, ${expiresAt ? new Date(expiresAt) : null},
          NOW(), 'secrets-manager-v1', ${getChannelCredentialEncryptionKeyId()}, NOW(),
          true, true, NULL, NULL, NULL, NULL, NULL
        )
        ON CONFLICT (business_profile_id, user_id, platform, account_identifier)
          WHERE account_identifier IS NOT NULL
        DO UPDATE SET
          credential_type = EXCLUDED.credential_type,
          api_key = EXCLUDED.api_key,
          api_secret = NULL,
          account_name = EXCLUDED.account_name,
          session_data = EXCLUDED.session_data,
          access_token = EXCLUDED.access_token,
          refresh_token = NULL,
          token_expiry = EXCLUDED.token_expiry,
          last_refreshed_at = NOW(),
          encryption_version = EXCLUDED.encryption_version,
          encryption_key_id = EXCLUDED.encryption_key_id,
          encrypted_at = NOW(),
          is_active = true,
          is_selected = true,
          deactivation_reason = NULL,
          deactivated_at = NULL,
          granted_scopes = '[]'::jsonb,
          provider_approval_status = 'unknown',
          provider_verified_at = NULL,
          last_readiness_check_at = NULL,
          readiness_error_code = NULL,
          updated_at = NOW()
        RETURNING id
      `);
    });
    const insertedCredentialId = Number((insertedCredential.rows[0] as { id: number }).id);

    // Subscribe WABA to webhooks for real-time message updates
    try {
      const subscribeUrl = `https://graph.facebook.com/${apiVersion}/${wabaId}/subscribed_apps`;
      const subResponse = await fetch(subscribeUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subData = await subResponse.json() as any;
      if (subData.success) {
        logger.info({ wabaId }, '[WhatsAppOAuth] WABA subscribed to webhooks');
      } else {
        logger.warn({ wabaId, error: subData.error }, '[WhatsAppOAuth] Webhook subscription returned non-success');
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (subErr: any) {
      logger.warn({ err: subErr }, '[WhatsAppOAuth] Webhook subscription failed (non-fatal)');
    }

    // Platform billing: put the WABA on our Meta credit line (we pay Meta, the
    // wallet pays us). Off unless the flag and the admin setting are both on;
    // a failure leaves the customer on their own Meta billing and alerts admins.
    oauthStage = 'credit_line';
    const { attachCreditLineOnSignup } = await import('../services/whatsapp/WhatsAppCreditLine.js');
    await attachCreditLineOnSignup({
      wabaId: String(wabaId), userId, businessProfileId: currentBusinessScope()?.businessProfileId ?? undefined, customerToken: accessToken,
    });

    oauthStage = 'provider_verification';
    const verification = await (await import('../services/integrations/ProviderVerificationService.js'))
      .verifyProviderIntegration(userId, 'whatsapp', insertedCredentialId);
    if (!whatsappOAuthVerificationAllowsConnection(verification)) {
      return res.redirect(`${FRONTEND_URL}/dashboard/integrations/whatsapp?error=${encodeURIComponent('WhatsApp connected, but Meta verification failed. Review the required app permissions and reconnect.')}`);
    }
    // A customer who clicks Finish without adding a card in Meta cannot send paid
    // templates; save the check so the WhatsApp page can say so. Never fails signup.
    const signupCreds = await whatsappApiService.resolveCreds(userId).catch(() => null);
    if (signupCreds) await paymentMethodStatus(userId, signupCreds).catch(() => undefined);
    const limited = verification.errorCode === 'WABA_HEALTH';
    res.redirect(`${FRONTEND_URL}/dashboard/integrations/whatsapp?whatsapp_connected=true${limited ? '&whatsapp_limited=payment_required' : ''}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error, stage: oauthStage }, '[WhatsAppController] WhatsApp OAuth callback failed');
    const safeErrors = new Set([
      'No WhatsApp Business phone number is available for the selected Meta account. Add and verify a Cloud API phone number in WhatsApp Manager, then reconnect.',
      'Multiple WhatsApp Business phone numbers are available and none matches this workspace.',
    ]);
    const publicMessage = safeErrors.has(String(error?.message))
      ? String(error.message)
      : `WhatsApp connection could not be completed during ${oauthStage.replaceAll('_', ' ')}.`;
    res.redirect(`${FRONTEND_URL}/dashboard/integrations/whatsapp?error=${encodeURIComponent(publicMessage)}`);
  }
}

/**
 * POST /api/whatsapp/send/template
 * Send a WhatsApp template message to a phone number.
 * Body: { to, templateName, language?, components? }
 */
export async function sendWhatsAppTemplate(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { to, templateName, language = 'en_US', components, phoneNumberId } = req.body || {};
    const recipient = normalizeWhatsAppRecipient(to);
    if (!recipient || typeof templateName !== 'string' || !/^[a-z0-9_]{1,512}$/i.test(templateName)) {
      return res.status(400).json({ error: 'to and templateName are required' });
    }

    const result = await whatsappApiService.sendTemplate({
      userId,
      phoneNumberId: typeof phoneNumberId === 'string' ? phoneNumberId : undefined,
      to: recipient,
      templateName,
      language,
      components: components || [],
    });

    logger.info({ userId, to, templateName }, '[WhatsAppController] Template sent');
    return res.json({ success: true, result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppController] sendWhatsAppTemplate error');
    const mapped = providerErrorResponse(error);
    return res.status(mapped.status).json({ success: false, ...mapped });
  }
}

/**
 * POST /api/whatsapp/send/text
 * Send a free-form text message (only within 24h customer-service window).
 * Body: { to, message }
 */
export async function sendWhatsAppText(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { to, message, phoneNumberId } = req.body || {};
    const recipient = normalizeWhatsAppRecipient(to);
    if (!recipient || typeof message !== 'string' || !message.trim() || message.length > 4096) {
      return res.status(400).json({ error: 'to and message are required' });
    }

    const result = await whatsappApiService.sendText({
      userId,
      phoneNumberId: typeof phoneNumberId === 'string' ? phoneNumberId : undefined,
      to: recipient,
      text: message.trim(),
    });

    logger.info({ userId, to }, '[WhatsAppController] Text sent');
    return res.json({ success: true, result });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WhatsAppController] sendWhatsAppText error');
    const mapped = providerErrorResponse(error);
    return res.status(mapped.status).json({ success: false, ...mapped });
  }
}
