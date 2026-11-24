import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { MetaAdsService } from './MetaAdsService.js';
import { ownedPaidAdAccount, resolveMetaReportingAccount } from './PaidAdAccountsService.js';
import { providerReportingWindow } from './ProviderReportingWindow.js';
import { adLeadQuality } from './AdLeadQualityService.js';

export async function metaAdsCampaignDiagnostics(userId: number, accountId: number, campaignId: string, period = '30d') {
  const account = await ownedPaidAdAccount(userId, accountId);
  if (account.platform !== 'meta') throw new Error('Select a Meta ad account.');
  const credentials = await resolveMetaReportingAccount(userId, accountId);
  const window = providerReportingWindow(period === '7d' ? 'last_7d' : period === '90d' ? 'last_90d' : 'last_30d');
  const managed = await db.execute(sql`SELECT id FROM performance_ad_campaigns WHERE user_id=${userId} AND ad_platform='meta' AND platform_campaign_id=${campaignId} AND REGEXP_REPLACE(COALESCE(ad_account_id,''),'^act_','')=${account.provider_account_id} ORDER BY id DESC LIMIT 1`);
  const result = await new MetaAdsService({
    accessToken: credentials.accessToken,
    adAccountId: credentials.adAccountId,
    expiresAt: credentials.expiresAt || undefined,
  }).getCampaignDiagnostics(campaignId, window.start, window.end);
  if (!result.success || !result.diagnostics) throw new Error(result.error || 'Meta diagnostics unavailable.');
  return {
    account: { id: account.id, name: account.name, accountId: account.provider_account_id, currency: account.currency, timezone: account.timezone },
    reportingWindow: window,
    leadQuality: await adLeadQuality(userId,{managedCampaignId:managed.rows[0]?.id?Number(managed.rows[0].id):null,providerCampaignId:campaignId,start:window.start,end:window.end}),
    ...result.diagnostics,
  };
}

export async function managedMetaAdsCampaignDiagnostics(userId: number, campaignId: number, period = '30d') {
  const result = await db.execute(sql`SELECT ad_platform,ad_account_id,platform_campaign_id FROM performance_ad_campaigns WHERE user_id=${userId} AND id=${campaignId}`);
  const campaign = result.rows[0];
  if (!campaign || campaign.ad_platform !== 'meta' || !campaign.platform_campaign_id) throw new Error('Meta campaign not found.');
  const providerAccountId = String(campaign.ad_account_id || '').replace(/^act_/, '');
  const account = await db.execute(sql`SELECT id FROM paid_ad_accounts WHERE user_id=${userId} AND platform='meta' AND provider_account_id=${providerAccountId} AND is_active=TRUE LIMIT 1`);
  if (!account.rows[0]) throw new Error('Refresh connected Meta ad accounts before loading diagnostics.');
  return metaAdsCampaignDiagnostics(userId, Number(account.rows[0].id), String(campaign.platform_campaign_id), period);
}
