import { verifyMetaManualIdentity } from '../services/metaManualIdentity.js';
import { authorizeBusinessManager } from '../middleware/businessPermissions.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
/**
 * Meta Manual Credentials Controller
 * Handles saving/retrieving user-provided (manual) developer credentials
 * for Facebook, Instagram, and WhatsApp integrations.
 *
 * Users can either:
 *   1. OAuth via the admin's Meta App (existing flow), or
 *   2. Enter their own App ID, App Secret, Page Access Token, etc.
 */

import { Request, Response } from 'express';
import { db } from '../models/db';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { metaPageConnectionsTable } from '../models/metaPageConnections/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { decryptMetaSecret, encryptMetaSecret, metaSessionMetadata } from '../utils/metaCredentialSecrets.js';
import {
  encryptChannelCredentialSecret,
  encryptChannelCredentialSession,
  getChannelCredentialEncryptionKeyId,
} from '../utils/channelCredentialSecrets.js';
import { resolveInstagramAccountContext } from '../services/instagramAccountSelectionService.js';

// ---------------------------------------------------------------------------
// Facebook Manual Credentials
// ---------------------------------------------------------------------------

/**
 * POST /api/facebook/manual-credentials
 * Save user-provided Facebook developer credentials
 */
export async function saveFacebookManualCredentials(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { appId, appSecret, pageAccessToken } = req.body;
    let { pageId, pageName } = req.body;

    if (!appId || !appSecret || !pageAccessToken || !pageId) {
      return res.status(400).json({
        error: 'App ID, App Secret, Page Access Token, and Page ID are required',
      });
    }

    let identity;
    try {
      identity = await verifyMetaManualIdentity({ appId, appSecret, accessToken: pageAccessToken, platform: 'facebook', pageId });
      pageId = identity.pageId;
      pageName = identity.pageName;
    } catch {
      return res.status(400).json({ error: 'Meta could not verify the app, permissions, and exact Page identity.' });
    }

    await db.transaction(async (tx: typeof db) => {
    // Upsert channel_credentials
    const existing = await tx
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'facebook_api')
        )
      )
      .limit(1);

    const sessionData = {
      ...metaSessionMetadata(existing[0]?.sessionData),
      connectedViaManual: true,
      connectedAt: new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
    };

    if (existing.length > 0) {
      await tx
        .update(channelCredentialsTable)
        .set({
          accessToken: encryptMetaSecret(pageAccessToken),
          apiKey: encryptMetaSecret(appId),
          apiSecret: encryptMetaSecret(appSecret),
          accountIdentifier: pageId,
          accountName: pageName || pageId,
          credentialType: 'manual',
          isActive: true,
          sessionData,
          lastRefreshedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(channelCredentialsTable.id, existing[0].id));
    } else {
      await tx.insert(channelCredentialsTable).values({
        userId,
        platform: 'facebook_api',
        credentialType: 'manual',
        accessToken: encryptMetaSecret(pageAccessToken),
        apiKey: encryptMetaSecret(appId),
        apiSecret: encryptMetaSecret(appSecret),
        accountIdentifier: pageId,
        accountName: pageName || pageId,
        isActive: true,
        sessionData,
        lastRefreshedAt: new Date(),
      });
    }

    // Also upsert meta_page_connections for centralized routing
    const existingConn = await tx
      .select()
      .from(metaPageConnectionsTable)
      .where(
        and(
          eq(metaPageConnectionsTable.userId, userId),
          eq(metaPageConnectionsTable.pageId, pageId)
        )
      )
      .limit(1);

    if (existingConn.length > 0) {
      await tx
        .update(metaPageConnectionsTable)
        .set({
          pageName: pageName || pageId,
          pageAccessToken: encryptMetaSecret(pageAccessToken)!,
          userAccessToken: encryptMetaSecret(pageAccessToken)!,
          facebookActive: true,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(metaPageConnectionsTable.id, existingConn[0].id));
    } else {
      await tx.insert(metaPageConnectionsTable).values({
        userId,
        pageId,
        pageName: pageName || pageId,
        pageAccessToken: encryptMetaSecret(pageAccessToken)!,
        userAccessToken: encryptMetaSecret(pageAccessToken)!,
        facebookActive: true,
        instagramActive: false,
        isActive: true,
      });
    }

    });

    res.json({ success: true, message: 'Facebook manual credentials saved successfully' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[MetaManualCreds] Facebook save error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * GET /api/facebook/manual-credentials
 * Get saved manual credentials info (masked)
 */
export async function getFacebookManualCredentials(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const creds = await db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'facebook_api'),
          eq(channelCredentialsTable.isActive, true)
        )
      )
      .limit(1);

    if (!creds.length) {
      return res.json({ success: true, hasManualCredentials: false });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionData = creds[0].sessionData as any || {};

    res.json({
      success: true,
      hasManualCredentials: !!sessionData.connectedViaManual,
      credentials: {
        appId: maskString(decryptMetaSecret(creds[0].apiKey) || String(sessionData.appId || '')),
        pageId: creds[0].accountIdentifier || '',
        pageName: creds[0].accountName || '',
        connectedAt: sessionData.connectedAt || creds[0].createdAt,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[MetaManualCreds] Facebook get error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// Instagram Manual Credentials
// ---------------------------------------------------------------------------

/**
 * POST /api/instagram/manual-credentials
 * Save user-provided Instagram developer credentials
 */
export async function saveInstagramManualCredentials(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { appId, appSecret, accessToken } = req.body;
    let { instagramAccountId, instagramUsername, pageId } = req.body;

    if (!appId || !appSecret || !accessToken || !instagramAccountId) {
      return res.status(400).json({
        error: 'App ID, App Secret, Access Token, and Instagram Account ID are required',
      });
    }

    let identity;
    try {
      identity = await verifyMetaManualIdentity({ appId, appSecret, accessToken, platform: 'instagram', pageId, instagramAccountId });
      pageId = identity.pageId;
      instagramAccountId = identity.instagramAccountId;
      instagramUsername = identity.instagramUsername;
    } catch {
      return res.status(400).json({ error: 'Meta could not verify the app, permissions, and exact Instagram/Page linkage.' });
    }

    await db.transaction(async (tx: typeof db) => {
    // Upsert channel_credentials
    const existing = await tx
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'instagram_api'),
          eq(channelCredentialsTable.accountIdentifier, instagramAccountId),
        )
      )
      .limit(1);

    const routingPageId = pageId || instagramAccountId;
    const sessionData = {
      ...metaSessionMetadata(existing[0]?.sessionData),
      connectedViaManual: true,
      connectedAt: new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
    };

    await tx.update(channelCredentialsTable).set({ isSelected: false, updatedAt: new Date() }).where(and(
      eq(channelCredentialsTable.userId, userId),
      eq(channelCredentialsTable.platform, 'instagram_api'),
    ));

    if (existing.length > 0) {
      await tx
        .update(channelCredentialsTable)
        .set({
          accessToken: encryptMetaSecret(accessToken),
          apiKey: encryptMetaSecret(appId),
          apiSecret: encryptMetaSecret(appSecret),
          accountIdentifier: instagramAccountId,
          accountName: instagramUsername || instagramAccountId,
          credentialType: 'manual',
          isActive: true,
          isSelected: true,
          deactivationReason: null,
          deactivatedAt: null,
          sessionData,
          lastRefreshedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(channelCredentialsTable.id, existing[0].id));
    } else {
      await tx.insert(channelCredentialsTable).values({
        userId,
        platform: 'instagram_api',
        credentialType: 'manual',
        accessToken: encryptMetaSecret(accessToken),
        apiKey: encryptMetaSecret(appId),
        apiSecret: encryptMetaSecret(appSecret),
        accountIdentifier: instagramAccountId,
        accountName: instagramUsername || instagramAccountId,
        isActive: true,
        isSelected: true,
        sessionData,
        lastRefreshedAt: new Date(),
      });
    }

    // Store a routing row for every manual connection. Direct Instagram Login
    // uses its IG account ID as the routing key when no Facebook Page exists.
    {
      const existingConn = await tx
        .select()
        .from(metaPageConnectionsTable)
        .where(
          and(
            eq(metaPageConnectionsTable.userId, userId),
            eq(metaPageConnectionsTable.pageId, routingPageId)
          )
        )
        .limit(1);

      if (existingConn.length > 0) {
        await tx
          .update(metaPageConnectionsTable)
          .set({
            instagramAccountId,
            instagramUsername: instagramUsername || null,
            pageAccessToken: encryptMetaSecret(accessToken)!,
            userAccessToken: encryptMetaSecret(accessToken)!,
            isActive: true,
            instagramActive: true,
            updatedAt: new Date(),
          })
          .where(eq(metaPageConnectionsTable.id, existingConn[0].id));
      } else {
        await tx.insert(metaPageConnectionsTable).values({
          userId,
          pageId: routingPageId,
          pageAccessToken: encryptMetaSecret(accessToken)!,
          userAccessToken: encryptMetaSecret(accessToken)!,
          instagramAccountId,
          instagramUsername: instagramUsername || null,
          isActive: true,
          facebookActive: false,
          instagramActive: true,
        });
      }
    }

    });

    res.json({ success: true, message: 'Instagram manual credentials saved successfully' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[MetaManualCreds] Instagram save error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * GET /api/instagram/manual-credentials
 * Get saved manual credentials info (masked)
 */
export async function getInstagramManualCredentials(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const accountContext = await resolveInstagramAccountContext(userId);
    const credential = accountContext?.credential;
    if (!credential) {
      return res.json({ success: true, hasManualCredentials: false });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionData = credential.sessionData as any || {};

    res.json({
      success: true,
      hasManualCredentials: !!sessionData.connectedViaManual,
      credentials: {
        appId: maskString(decryptMetaSecret(credential.apiKey) || String(sessionData.appId || '')),
        instagramAccountId: credential.accountIdentifier || '',
        username: credential.accountName || '',
        connectedAt: sessionData.connectedAt || credential.createdAt,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[MetaManualCreds] Instagram get error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// WhatsApp Manual Credentials
// ---------------------------------------------------------------------------

/**
 * POST /api/whatsapp/manual-credentials
 * Save user-provided WhatsApp developer credentials
 */
export async function saveWhatsAppManualCredentials(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { appId, appSecret, accessToken, phoneNumberId, businessAccountId, webhookVerifyToken } = req.body;

    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({
        error: 'Access Token and Phone Number ID are required',
      });
    }

    // Validate by calling WhatsApp Cloud API (token in Authorization header)
    let verifiedDisplayPhone = '';
    let verifiedName = '';
    try {
      const verifyRes = await fetch(
        `https://graph.facebook.com/v25.0/${phoneNumberId}?fields=id,display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verifyData: any = await verifyRes.json();
      if (verifyData.error) {
        return res.status(400).json({
          error: `Invalid credentials: ${verifyData.error.message}`,
        });
      }
      verifiedDisplayPhone = verifyData.display_phone_number || '';
      verifiedName = verifyData.verified_name || '';
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    } catch (verifyErr: any) {
      return res.status(400).json({ error: 'Failed to verify credentials with WhatsApp Cloud API' });
    }

    // Save via CredentialService (existing whatsapp pattern)
    const { CredentialService } = await import('../services/credentialService.js');
    const config = {
      phoneNumberId,
      businessAccountId: businessAccountId || '',
      accessToken,
      webhookVerifyToken: webhookVerifyToken || '',
      apiVersion: 'v25.0',
      appId: appId || '',
      appSecret: appSecret || '',
      connectedViaManual: true,
      connectedAt: new Date().toISOString(),
    };

    // Keep the legacy api_credentials row for callers that have not moved to
    // channel_credentials yet, but do not leave a token in its plaintext
    // api_key column. CredentialService encrypts the token-bearing config.
    await CredentialService.saveCredential(userId, 'whatsapp', '', appSecret || '', config);

    // Also save to channel_credentials so all consumers (worker outreach, template sync, etc.) can find it
    const existingCC = await db.select({ id: channelCredentialsTable.id })
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'whatsapp')
      ))
      .limit(1);

    const ccValues = {
      userId,
      platform: 'whatsapp' as const,
      credentialType: 'manual' as const,
      accessToken: encryptChannelCredentialSecret(accessToken),
      apiKey: encryptChannelCredentialSecret(accessToken),
      accountIdentifier: phoneNumberId,
      accountName: `WhatsApp (${phoneNumberId})`,
      isActive: true,
      sessionData: encryptChannelCredentialSession({
        connectedViaManual: true,
        phoneNumberId,
        businessAccountId: businessAccountId || '',
        webhookVerifyToken: webhookVerifyToken || '',
        appId: appId || '',
        appSecret: appSecret || '',
        displayPhoneNumber: verifiedDisplayPhone,
        verifiedName: verifiedName,
        apiVersion: 'v25.0',
        connectedAt: new Date().toISOString(),
      }),
      encryptionVersion: 'secrets-manager-v1',
      encryptionKeyId: getChannelCredentialEncryptionKeyId(),
      encryptedAt: new Date(),
      lastRefreshedAt: new Date(),
      updatedAt: new Date(),
    };

    if (existingCC.length > 0) {
      await db.update(channelCredentialsTable)
        .set(ccValues)
        .where(eq(channelCredentialsTable.id, existingCC[0].id));
    } else {
      await db.insert(channelCredentialsTable).values({
        ...ccValues,
        createdAt: new Date(),
      });
    }

    // H5: Subscribe WABA to webhooks so inbound messages reach us
    if (businessAccountId) {
      try {
        const { whatsappApiService } = await import('../services/whatsappApiService.js');
        const sub = await whatsappApiService.subscribeWabaWebhook(businessAccountId, accessToken, 'v25.0');
        if (!sub.success) {
          logger.warn({ wabaId: businessAccountId, error: sub.error }, '[MetaManualCreds] WABA webhook subscription failed (non-fatal)');
        } else {
          logger.info({ wabaId: businessAccountId }, '[MetaManualCreds] WABA subscribed to webhooks');
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (subErr: any) {
        logger.warn({ err: subErr }, '[MetaManualCreds] Webhook subscription error (non-fatal)');
      }
    }

    const credentialId = existingCC[0]?.id || (await db.select({ id: channelCredentialsTable.id })
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'whatsapp'),
        eq(channelCredentialsTable.accountIdentifier, phoneNumberId),
      ))
      .limit(1))[0]?.id;
    const verification = credentialId
      ? await (await import('../services/integrations/ProviderVerificationService.js'))
        .verifyProviderIntegration(userId, 'whatsapp', credentialId)
      : null;

    res.status(verification?.status === 'passing' ? 200 : 409).json({
      success: verification?.status === 'passing',
      message: verification?.status === 'passing'
        ? 'WhatsApp manual credentials saved and verified successfully'
        : 'WhatsApp credentials were saved, but provider verification requires attention.',
      verification,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[MetaManualCreds] WhatsApp save error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * GET /api/whatsapp/manual-credentials
 * Get saved WhatsApp manual credentials info (masked)
 */
export async function getWhatsAppManualCredentials(req: Request, res: Response) {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { CredentialService } = await import('../services/credentialService.js');
    const cred = await CredentialService.getCredential(userId, 'whatsapp');

    if (!cred) {
      return res.json({ success: true, hasManualCredentials: false });
    }

    const config = cred.config || {};

    res.json({
      success: true,
      hasManualCredentials: !!config.connectedViaManual,
      credentials: {
        phoneNumberId: config.phoneNumberId || '',
        businessAccountId: config.businessAccountId || '',
        appId: maskString(config.appId || ''),
        connectedAt: config.connectedAt,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[MetaManualCreds] WhatsApp get error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskString(str: string): string {
  if (!str || str.length < 8) return str ? '••••' : '';
  return str.substring(0, 4) + '••••' + str.substring(str.length - 4);
}
