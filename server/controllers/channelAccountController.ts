import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { isDirectInstagramLogin } from '../utils/instagramOAuthCredential.js';
import type { Request, Response } from 'express';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import { findInstagramConnectionForUserAndAccount } from '../models/metaPageConnections/functions';
import { verifyProviderIntegration } from '../services/integrations/ProviderVerificationService';
import { httpsUrlOrNull as httpsImage } from '../utils/httpsUrl.js';

const allowedPlatforms = new Set(['facebook_api', 'instagram_api', 'youtube']);
const removablePlatforms = new Set(['facebook_api', 'instagram_api']);

const analyticsScopeByPlatform: Record<string, string> = {
  facebook_api: 'pages_read_engagement',
  instagram_api: 'instagram_manage_insights',
  youtube: 'https://www.googleapis.com/auth/yt-analytics.readonly',
};

function analyticsReadiness(row: Awaited<ReturnType<typeof ChannelCredentialModel.findAllByUserAndPlatform>>[number]) {
  const requiredScope = row.platform === 'instagram_api' && isDirectInstagramLogin(row) ? 'instagram_business_manage_insights' : analyticsScopeByPlatform[row.platform];
  const grantedScopes = Array.isArray(row.grantedScopes) ? row.grantedScopes : [];
  const expired = Boolean(row.tokenExpiry && row.tokenExpiry.getTime() <= Date.now());
  if (expired) return {
    analyticsReady: false,
    analyticsReadinessCode: 'TOKEN_EXPIRED',
    analyticsReadinessMessage: 'Reconnect this account because its provider authorization has expired.',
  };
  if ((requiredScope && !grantedScopes.includes(requiredScope))) return {
    analyticsReady: false,
    analyticsReadinessCode: 'ANALYTICS_PERMISSION_REQUIRED',
    analyticsReadinessMessage: `Reconnect this account and grant the provider analytics permission before Social Insights can synchronize metrics.`,
  };
  return { analyticsReady: true, analyticsReadinessCode: null, analyticsReadinessMessage: null };
}

export async function listChannelAccounts(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req) as number | undefined;
  const platform = String(req.params.platform || '');
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!allowedPlatforms.has(platform)) return res.status(404).json({ error: 'Unknown multi-account platform' });
  const rows = await ChannelCredentialModel.findAllByUserAndPlatform(userId, platform);
  const instagramProfiles = platform === 'instagram_api'
    ? await Promise.all(rows.map((row) => row.accountIdentifier
      ? findInstagramConnectionForUserAndAccount(userId, row.accountIdentifier)
      : null))
    : [];
  // Tokens/session data are deliberately never part of the chooser contract.
  return res.json(rows.map((row, index) => ({
    id: row.id,
    platform: row.platform,
    accountIdentifier: row.accountIdentifier,
    accountName: row.accountName,
    displayName: platform === 'instagram_api' && isDirectInstagramLogin(row)
      ? instagramProfiles[index]?.pageName || row.accountName
      : row.accountName,
    profilePictureUrl: httpsImage(instagramProfiles[index]?.instagramProfilePicture),
    isSelected: row.isSelected,
    usesInstagramLogin: platform === 'instagram_api' ? isDirectInstagramLogin(row) : false,
    pageId: platform === 'instagram_api' && !isDirectInstagramLogin(row) && row.sessionData && typeof row.sessionData === 'object'
      && typeof (row.sessionData as { pageId?: unknown }).pageId === 'string'
      ? (row.sessionData as { pageId: string }).pageId : null,
    tokenExpiry: row.tokenExpiry,
    lastUsedAt: row.lastUsedAt,
    ...analyticsReadiness(row),
  })));
}

export async function selectChannelAccount(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req) as number | undefined;
  const platform = String(req.params.platform || '');
  const credentialId = Number(req.body?.credentialId);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!allowedPlatforms.has(platform)) return res.status(404).json({ error: 'Unknown multi-account platform' });
  if (!Number.isInteger(credentialId)) return res.status(400).json({ error: 'credentialId is required' });
  const selected = await ChannelCredentialModel.selectAccount(userId, platform, credentialId);
  if (!selected) return res.status(404).json({ error: 'Account not found' });
  const verificationPlatform = platform === 'facebook_api' ? 'facebook'
    : platform === 'instagram_api' ? 'instagram'
      : null;
  const verification = verificationPlatform
    ? await verifyProviderIntegration(userId, verificationPlatform, selected.id).catch(() => null)
    : null;
  return res.json({
    id: selected.id,
    platform: selected.platform,
    accountIdentifier: selected.accountIdentifier,
    accountName: selected.accountName,
    isSelected: selected.isSelected,
    verification,
  });
}

export async function removeChannelAccount(req: Request, res: Response) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req) as number | undefined;
  const platform = String(req.params.platform || '');
  const credentialId = Number(req.params.credentialId);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!allowedPlatforms.has(platform)) return res.status(404).json({ error: 'Unknown multi-account platform' });
  if (!removablePlatforms.has(platform)) return res.status(404).json({ error: 'Account removal is not supported for this platform' });
  if (!Number.isSafeInteger(credentialId) || credentialId <= 0) {
    return res.status(400).json({ error: 'A valid credentialId is required' });
  }

  const removed = await ChannelCredentialModel.removeAccount(userId, platform, credentialId);
  if (!removed) return res.status(404).json({ error: 'Account not found' });
  return res.json({
    removedId: removed.removedId,
    removedAccountIdentifier: removed.removedAccountIdentifier,
    selected: removed.selected ? {
      id: removed.selected.id,
      platform: removed.selected.platform,
      accountIdentifier: removed.selected.accountIdentifier,
      accountName: removed.selected.accountName,
      isSelected: removed.selected.isSelected,
    } : null,
  });
}
