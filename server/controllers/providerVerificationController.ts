import type { Request, Response } from 'express';
import {
  listLatestProviderVerifications,
  publicProviderEndpoints,
  verifyProviderIntegration,
} from '../services/integrations/ProviderVerificationService.js';
import type { ProviderVerificationPlatform } from '../models/providerVerificationRuns/schema.js';
import { logger } from '../utils/logger.js';
import { inspectOfficialProviderBinding } from '../services/outreach/ProviderBindingService.js';
import { autonomousAdsService } from '../services/ads/AutonomousAdsService.js';
import { db } from '../models/db.js';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { and, desc, eq } from 'drizzle-orm';
import { inspectMSG91Credential } from '../utils/msg91Credentials.js';
import { businessOwnerIdOrNull as userId } from '../utils/businessOwnerId.js';

const PLATFORMS = new Set<ProviderVerificationPlatform>(['facebook', 'instagram', 'whatsapp', 'meta_ads', 'google_ads', 'youtube', 'gmail', 'resend', 'msg91']);

const readinessIssueLabels: Record<string, string> = {
  credential: 'No active official provider account is connected.',
  credential_type: 'Reconnect using the supported official credential type.',
  credential_material: 'The provider credential is incomplete.',
  unexpired_token: 'The provider token has expired and must be reconnected.',
  account_reference: 'Select a provider account identity.',
  encryption_metadata: 'Rotate this credential into encrypted storage.',
  required_scopes: 'Reconnect and approve every required provider permission.',
  provider_approval: 'Provider approval is still pending or unavailable.',
  provider_approval_metadata: 'Provider approval metadata has not been recorded.',
  api_version: 'Select a supported provider API version.',
  provider_verification: 'Run a successful provider verification.',
  readiness_error: 'The last provider readiness verification failed.',
};

function readinessIssues(missing: string[]): string[] {
  return missing.map((issue) => readinessIssueLabels[issue] || issue.replaceAll('_', ' '));
}

/**
 * GET /api/integration-readiness/business-journeys
 * Returns only non-secret readiness evidence used by the chat outreach and
 * paid-campaign executors. It never refreshes tokens or mutates providers.
 */
export async function getBusinessJourneyReadiness(req: Request, res: Response) {
  const id = userId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  try {
    const officialChannels = ['linkedin', 'facebook', 'instagram', 'twitter'] as const;
    const [officialResults, [smsCredential], adReadiness, adSettings] = await Promise.all([
      Promise.all(officialChannels.map(async (channel) => ({
        channel,
        readiness: await inspectOfficialProviderBinding(id, channel),
      }))),
      db.select().from(channelCredentialsTable).where(and(
        eq(channelCredentialsTable.userId, id),
        eq(channelCredentialsTable.platform, 'msg91_sms'),
        eq(channelCredentialsTable.isActive, true),
      )).orderBy(desc(channelCredentialsTable.isSelected), desc(channelCredentialsTable.updatedAt)).limit(1),
      autonomousAdsService.getAccountReadiness(id, false),
      autonomousAdsService.getSettings(id),
    ]);

    const outreach = Object.fromEntries(officialResults.map(({ channel, readiness }) => {
      const configured = !readiness.missing.includes('credential');
      return [channel, {
        ready: readiness.ready,
        configured,
        state: readiness.ready ? 'ready' : configured ? 'needs_attention' : 'not_connected',
        issues: readinessIssues(readiness.missing),
      }];
    }));
    const smsReadiness = inspectMSG91Credential(smsCredential);
    const smsIssues = smsReadiness.issue ? [smsReadiness.issue] : [];
    const smsReady = smsReadiness.ready;
    outreach.sms = {
      ready: smsReady,
      configured: Boolean(smsCredential),
      state: smsReady ? 'ready' : smsCredential ? 'needs_attention' : 'not_connected',
      issues: smsIssues,
    };

    const tenantMutationGate = adSettings.liveProviderMutationsEnabled;
    const environmentMutationGate = process.env.AD_PROVIDER_MUTATIONS_ENABLED === 'true';
    const ads = Object.fromEntries((['meta', 'google'] as const).map((platform) => {
      const providerReady = adReadiness[platform];
      const issues = [
        ...(adReadiness.reasons[platform] ? [adReadiness.reasons[platform]!] : []),
        ...(!tenantMutationGate ? ['Live provider mutations are disabled for this workspace.'] : []),
        ...(!environmentMutationGate ? ['Live provider mutations are disabled in this deployment.'] : []),
      ];
      return [platform, {
        ready: providerReady && tenantMutationGate && environmentMutationGate,
        providerReady,
        state: providerReady ? 'gated' : 'not_connected',
        issues,
      }];
    }));

    return res.json({
      checkedAt: new Date().toISOString(),
      outreach,
      ads,
      gates: { tenantMutationGate, environmentMutationGate },
    });
  } catch (error) {
    logger.error({ err: error, userId: id }, '[ProviderVerification] Failed to load business journey readiness');
    return res.status(500).json({ error: 'Unable to retrieve outreach and paid-campaign readiness.' });
  }
}

export async function listProviderVerificationStatus(req: Request, res: Response) {
  const id = userId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  try {
    return res.json({ verifications: await listLatestProviderVerifications(id), endpoints: publicProviderEndpoints() });
  } catch (error) {
    logger.error({ err: error, userId: id }, '[ProviderVerification] Failed to list readiness');
    return res.status(500).json({ error: 'Unable to retrieve provider verification status.' });
  }
}

export async function runProviderVerification(req: Request, res: Response) {
  const id = userId(req);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  const platform = String(req.params.platform || '').toLowerCase() as ProviderVerificationPlatform;
  if (!PLATFORMS.has(platform)) return res.status(400).json({ error: 'Unsupported provider platform.' });
  const credentialId = req.body?.credentialId === undefined ? undefined : Number(req.body.credentialId);
  if (credentialId !== undefined && (!Number.isSafeInteger(credentialId) || credentialId <= 0)) {
    return res.status(400).json({ error: 'credentialId must be a positive integer.' });
  }
  try {
    const result = await verifyProviderIntegration(id, platform, credentialId);
    return res.status(result.status === 'passing' ? 200 : 409).json(result);
  } catch (error) {
    logger.error({ err: error, userId: id, platform }, '[ProviderVerification] Verification failed');
    return res.status(500).json({ error: 'Provider verification could not be completed.' });
  }
}
