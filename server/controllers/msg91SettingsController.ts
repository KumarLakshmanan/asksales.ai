import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
/**
 * MSG91 Settings Controller
 * Manages user-specific MSG91 SMS credentials for outreach
 */

import type { Request, Response } from 'express';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import { logger } from '../utils/logger.js';
import {
  decryptChannelCredentialSession,
  decryptChannelCredentialSecret,
  encryptChannelCredentialSecret,
  encryptChannelCredentialSession,
  getChannelCredentialEncryptionKeyId,
} from '../utils/channelCredentialSecrets.js';
import { validateMSG91Settings, type MSG91SenderSettings } from '../../shared/msg91.js';
import { inspectMSG91Credential, readMSG91Settings, validMSG91AuthKey } from '../utils/msg91Credentials.js';
import { verifyMSG91Configuration } from '../services/integrations/MSG91ProviderService.js';

function submittedSettings(body: Record<string, unknown> | undefined, saved: MSG91SenderSettings): MSG91SenderSettings {
  const field = (key: keyof MSG91SenderSettings) => body?.[key] === undefined
    ? saved[key] : typeof body[key] === 'string' ? body[key].trim() : '';
  return {
    senderId: field('senderId'),
    flowId: body?.flowId === undefined && body?.dltTemplateId !== undefined
      ? typeof body.dltTemplateId === 'string' ? body.dltTemplateId.trim() : '' : field('flowId'),
    messageVariable: field('messageVariable'),
  };
}

/**
 * Get MSG91 settings for the current user
 */
export async function getMsg91Settings(req: Request, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'msg91_sms');

    if (!credential) {
      return res.json({
        success: true,
        configured: false,
        connected: false,
        settings: null,
      });
    }

    // Don't return the actual auth key, just indicate it's set
    const { settings: smsSettings, configured, ready, issue } = inspectMSG91Credential(credential);
    const session = decryptChannelCredentialSession(credential.sessionData) as { templateName?: string } | null;

    return res.json({
      success: true,
      configured,
      connected: ready,
      settings: {
        senderId: smsSettings?.senderId || '',
        flowId: smsSettings.flowId,
        // Preserve the old response field while clients migrate to flowId.
        dltTemplateId: smsSettings.flowId,
        messageVariable: smsSettings?.messageVariable || 'message',
        hasAuthKey: !!credential.apiSecret,
        lastUsedAt: credential.lastUsedAt?.toISOString() || null,
        lastVerifiedAt: credential.providerVerifiedAt?.toISOString() || null,
        connectionStatus: ready ? 'ready' : credential.readinessErrorCode === 'MSG91_AUTH_FAILED' ? 'reauth_required' : 'action_required',
        readinessErrorCode: credential.readinessErrorCode || null,
        readinessMessage: issue,
        templateName: session?.templateName || null,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[MSG91SettingsController] Error getting MSG91 settings');
    return res.status(500).json({
      success: false,
      error: 'Unable to retrieve MSG91 settings. Please try again.',
    });
  }
}

/**
 * Save MSG91 settings for the current user
 */
export async function saveMsg91Settings(req: Request, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const submittedAuthKey = typeof req.body?.authKey === 'string' ? req.body.authKey.trim() : '';

    const existingCredential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'msg91_sms');
    const authKey = submittedAuthKey || decryptChannelCredentialSecret(existingCredential?.apiSecret);
    const smsSettings = submittedSettings(req.body, readMSG91Settings(existingCredential));
    if (!validMSG91AuthKey(authKey) || (req.body?.authKey !== undefined && typeof req.body.authKey !== 'string')) {
      return res.status(400).json({
        success: false,
        error: 'A valid MSG91 Auth Key is required. Leave it blank only to keep your saved key.',
      });
    }

    const invalid = validateMSG91Settings(smsSettings);
    if (invalid) return res.status(400).json({ success: false, error: invalid });

    const testResult = await verifyMSG91Configuration(authKey, smsSettings);

    if (!testResult.success) {
      return res.status(400).json({
        success: false,
        error: testResult.error,
        code: testResult.code,
      });
    }

    // Save credentials
    const checkedAt = new Date();

    const credentialData = {
      userId,
      platform: 'msg91_sms',
      credentialType: 'api_key',
      accountIdentifier: smsSettings.senderId,
      accountName: `MSG91 - ${smsSettings.senderId}`,
      apiKey: smsSettings.senderId,
      apiSecret: encryptChannelCredentialSecret(authKey),
      sessionData: encryptChannelCredentialSession({ ...smsSettings, templateName: testResult.templateName || null }),
      isActive: true,
      isSelected: true,
      encryptionVersion: 'v1',
      encryptionKeyId: getChannelCredentialEncryptionKeyId(),
      encryptedAt: checkedAt,
      providerVerifiedAt: checkedAt,
      lastReadinessCheckAt: checkedAt,
      readinessErrorCode: null,
      providerApiVersion: 'msg91-sms-v5',
      providerApprovalStatus: 'not_required',
      deactivationReason: null,
      deactivatedAt: null,
    } as const;
    if (existingCredential) {
      await ChannelCredentialModel.updateAccount(userId, 'msg91_sms', existingCredential.id, credentialData);
    } else {
      await ChannelCredentialModel.upsert(credentialData);
    }

    return res.json({
      success: true,
      message: 'MSG91 settings saved successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[MSG91SettingsController] Error saving MSG91 settings');
    return res.status(500).json({
      success: false,
      error: 'Unable to save MSG91 settings. Please try again.',
    });
  }
}

/**
 * Test MSG91 connection
 */
export async function testMsg91Connection_handler(req: Request, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const submittedAuthKey = typeof req.body?.authKey === 'string' ? req.body.authKey.trim() : '';
    const credential = await ChannelCredentialModel.findByUserAndPlatform(userId, 'msg91_sms');
    const authKey = submittedAuthKey || decryptChannelCredentialSecret(credential?.apiSecret);
    const savedSettings = readMSG91Settings(credential);
    const settings = submittedSettings(req.body, savedSettings);

    if (!validMSG91AuthKey(authKey) || (req.body?.authKey !== undefined && typeof req.body.authKey !== 'string')) {
      return res.status(400).json({
        success: false,
        error: 'A valid MSG91 Auth Key is required.',
      });
    }

    const invalid = validateMSG91Settings(settings);
    if (invalid) return res.status(400).json({ success: false, error: invalid });
    const result = await verifyMSG91Configuration(authKey, settings);

    // Testing a draft must not change the readiness of a different saved sender/template.
    if (credential && authKey === decryptChannelCredentialSecret(credential.apiSecret)
      && Object.keys(savedSettings).every(key => savedSettings[key as keyof MSG91SenderSettings] === settings[key as keyof MSG91SenderSettings])) {
      const checkedAt = new Date();
      await ChannelCredentialModel.updateAccount(userId, 'msg91_sms', credential.id, {
        providerVerifiedAt: result.success ? checkedAt : null,
        lastReadinessCheckAt: checkedAt,
        readinessErrorCode: result.code || null,
      });
    }

    return res.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[MSG91SettingsController] Error testing connection');
    return res.status(500).json({
      success: false,
      error: 'Unable to test connection. Please try again.',
    });
  }
}

/**
 * Disconnect MSG91 settings
 */
export async function disconnectMsg91(req: Request, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    await ChannelCredentialModel.delete(userId, 'msg91_sms');

    return res.json({
      success: true,
      message: 'MSG91 settings disconnected successfully',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[MSG91SettingsController] Error disconnecting MSG91');
    return res.status(500).json({
      success: false,
      error: 'Unable to disconnect MSG91. Please try again.',
    });
  }
}
