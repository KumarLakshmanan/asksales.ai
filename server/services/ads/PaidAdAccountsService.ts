import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { getMetaAdsCreds } from '../../models/metaPageConnections/functions.js';
import { decryptMetaSecret } from '../../utils/metaCredentialSecrets.js';
import { discoverMetaAccountsWithToken } from './MetaAdAccountDiscovery.js';
import { discoverGoogleAdsAccounts } from './GoogleAdsService.js';
import { getCredential } from '../credentialService.js';
import { logger } from '../../utils/logger.js';

export interface PaidAdAccount {
  id: number; user_id: number; platform: 'meta' | 'google'; provider_account_id: string;
  name: string; currency: string | null; timezone: string | null; manager_account_id: string | null;
  credential_source: string; credential_id: number | null; is_manager: boolean; is_active: boolean;
  reporting_available: boolean; publishing_available: boolean; verified_at: string | null;
  last_attempt_at: string | null; last_succeeded_at: string | null; data_available_through: string | null; error_code: string | null;
}
async function getMetaConnectionsForUser(userId:number) {
  return (await import('../../models/metaPageConnections/functions.js')).getConnectionsForUser(userId);
}
export async function listPaidAdAccounts(userId: number): Promise<PaidAdAccount[]> {
  const result = await db.execute(sql`SELECT a.*,c.config->>'connectedAt' AS google_connected_at,c.created_at AS google_created_at
    FROM paid_ad_accounts a LEFT JOIN api_credentials c ON a.platform='google'
      AND c.user_id=a.user_id AND c.business_profile_id=a.business_profile_id
      AND c.service_name='google_ads' AND c.is_active=TRUE
      AND COALESCE(length(c.api_key),0)>0 AND COALESCE(length(c.api_secret),0)>0
      AND COALESCE(length(c.config->>'refreshToken'),0)>0
    WHERE a.user_id=${userId} AND a.is_active=TRUE AND (a.platform<>'google' OR c.id IS NOT NULL)
    ORDER BY a.platform,a.name,a.id`);
  return result.rows.flatMap((row: PaidAdAccount & { google_connected_at?: string; google_created_at?: string }) => {
    const { google_connected_at, google_created_at, ...account } = row;
    // A new Google login can authorize a different set of customers. Only
    // inventory verified since that grant belongs in the current chooser.
    if (account.platform === 'google' && !(Date.parse(String(account.verified_at || ''))
      >= Date.parse(String(google_connected_at || google_created_at || '')))) return [];
    return [account];
  });
}
export async function ownedPaidAdAccount(userId: number, id: number): Promise<PaidAdAccount> {
  const result = await db.execute(sql`SELECT * FROM paid_ad_accounts WHERE user_id=${userId} AND id=${id} AND is_active=TRUE`);
  if (!result.rows.length) throw new Error('Ad account is unavailable. Refresh connected accounts.');
  return result.rows[0] as unknown as PaidAdAccount;
}
async function saveAccount(userId: number, account: {
  platform: 'meta'|'google'; accountId: string; name: string; currency?: string; timezone?: string;
  managerId?: string; manager?: boolean; source: string; credentialId?: number; reporting: boolean; publishing: boolean; verifiedAt?: Date;
}) {
  await db.execute(sql`INSERT INTO paid_ad_accounts
    (user_id,platform,provider_account_id,name,currency,timezone,manager_account_id,credential_source,credential_id,is_manager,reporting_available,publishing_available,verified_at)
    VALUES (${userId},${account.platform},${account.accountId},${account.name},${account.currency || null},${account.timezone || null},${account.managerId || null},${account.source},${account.credentialId || null},${!!account.manager},${account.reporting},${account.publishing},${account.verifiedAt || sql`NOW()`})
    ON CONFLICT(business_profile_id, user_id,platform,provider_account_id) DO UPDATE SET name=EXCLUDED.name,currency=EXCLUDED.currency,
      timezone=EXCLUDED.timezone,manager_account_id=EXCLUDED.manager_account_id,credential_source=EXCLUDED.credential_source,
      credential_id=EXCLUDED.credential_id,is_manager=EXCLUDED.is_manager,reporting_available=EXCLUDED.reporting_available,publishing_available=EXCLUDED.publishing_available,
      is_active=TRUE,verified_at=EXCLUDED.verified_at,error_code=NULL,updated_at=NOW()
    WHERE paid_ad_accounts.verified_at IS NULL OR paid_ad_accounts.verified_at<=EXCLUDED.verified_at`);
}

export async function discoverPaidAdAccounts(userId: number, platform: 'meta'|'google') {
  const failures: string[] = [];
  if (platform === 'google') {
    // Do not let an old in-flight discovery become current after a new grant.
    const verifiedAt = new Date();
    const creds = await (await import('../../controllers/integrationsController.js')).getGoogleAdsCredentials(userId);
    if (!creds) throw new Error('Authorize Google Ads first.');
    const discovery = await discoverGoogleAdsAccounts(creds);
    failures.push(...discovery.failures);
    for (const account of discovery.accounts) await saveAccount(userId, {
      platform,accountId:account.customerId,name:account.name || account.customerId,currency:account.currency,
      timezone:account.timeZone,managerId:account.managerAccountId,manager:account.manager,source:'google_ads',reporting:!account.manager,publishing:!account.manager,verifiedAt,
    });
  } else {
    const pages = (await getMetaConnectionsForUser(userId)).filter(page => page.isActive && page.userAccessToken && (!page.tokenExpiry || new Date(page.tokenExpiry) > new Date()));
    const sources: Array<{token:string;source:string;credentialId?:number}> = pages.map(page => ({token:decryptMetaSecret(page.userAccessToken!),source:'meta_page',credentialId:page.id}));
    // OAuth can be connected before a Page binding exists. Its user token still
    // authorizes account discovery, including when no default account was chosen.
    const oauth = await getCredential(userId, 'meta_ads');
    const oauthConfig = oauth?.config || {};
    const oauthExpiry = Date.parse(String(oauthConfig.tokenExpiry || ''));
    if (typeof oauthConfig.accessToken === 'string' && oauthConfig.accessToken &&
      (!Number.isFinite(oauthExpiry) || oauthExpiry > Date.now()))
      sources.push({token:oauthConfig.accessToken,source:'meta_oauth'});
    if (!sources.length) {
      const creds = await getMetaAdsCreds(userId);
      if (creds) sources.push({token:creds.accessToken,source:'meta_default'});
    }
    if (!sources.length) {
      logger.warn({userId}, '[PaidAdAccounts] Meta discovery has no active credential');
      throw new Error('Authorize Meta Ads first.');
    }
    const seenTokens = new Set<string>();
    for (const source of sources) {
      if (seenTokens.has(source.token)) continue;
      seenTokens.add(source.token);
      try {
        const discovery = await discoverMetaAccountsWithToken(source.token);
        for (const account of discovery.accounts) await saveAccount(userId, {
          platform,accountId:account.id.replace(/^act_/,''),name:account.name,currency:account.currency,timezone:account.timezone_name,
          source:source.source,credentialId:source.credentialId,reporting:true,publishing:discovery.publishingAvailable,
        });
      } catch (error) {
        logger.warn({userId,source:source.source,reason:error instanceof Error?error.message:'unknown'}, '[PaidAdAccounts] Meta discovery failed');
        failures.push('Some Meta accounts could not be verified. Check permissions and reconnect.');
      }
    }
    logger.info({userId,sourceCount:seenTokens.size,failures:failures.length}, '[PaidAdAccounts] Meta discovery completed');
  }
  return {accounts:await listPaidAdAccounts(userId),failures};
}

export async function resolveMetaReportingAccount(userId: number, id: number) {
  const account = await ownedPaidAdAccount(userId,id);
  if (account.platform !== 'meta' || !account.reporting_available) throw new Error('Meta reporting is unavailable for this account.');
  if (account.credential_source === 'meta_page') {
    const page = (await getMetaConnectionsForUser(userId)).find(row => row.id === account.credential_id && row.isActive);
    if (!page?.userAccessToken || (page.tokenExpiry && new Date(page.tokenExpiry) <= new Date())) throw new Error('Reconnect Meta Ads to refresh this account.');
    const matches = String(page.adAccountId || '').replace(/^act_/,'') === account.provider_account_id;
    return {accessToken:decryptMetaSecret(page.userAccessToken),adAccountId:account.provider_account_id,apiVersion:'v25.0',pageId:matches ? page.pageId : '',expiresAt:page.tokenExpiry,
      adAccountName:account.name,adAccountCurrency:account.currency,adAccountTimezone:account.timezone,
      pageName:matches ? page.pageName : null,instagramAccountId:matches ? page.instagramAccountId : null,instagramUsername:matches ? page.instagramUsername : null};
  }
  if (account.credential_source === 'meta_oauth') {
    const oauth = await getCredential(userId, 'meta_ads');
    const config = oauth?.config || {};
    const expiry = Date.parse(String(config.tokenExpiry || ''));
    if (typeof config.accessToken !== 'string' || !config.accessToken ||
      (Number.isFinite(expiry) && expiry <= Date.now())) throw new Error('Reconnect Meta Ads to refresh this account.');
    const matches = String(config.adAccountId || '').replace(/^act_/, '') === account.provider_account_id;
    return {accessToken:config.accessToken,adAccountId:account.provider_account_id,apiVersion:'v25.0',
      pageId:matches?String(config.pageId || ''):'',pageName:matches?String(config.pageName || ''):null,
      adAccountName:account.name,adAccountCurrency:account.currency,adAccountTimezone:account.timezone,
      instagramAccountId:matches?String(config.instagramAccountId || ''):null,
      instagramUsername:matches?String(config.instagramUsername || ''):null,
      expiresAt:Number.isFinite(expiry)?new Date(expiry):null};
  }
  const creds = await getMetaAdsCreds(userId);
  if (!creds) throw new Error('Reconnect Meta Ads to refresh this account.');
  const matches = creds.adAccountId.replace(/^act_/,'') === account.provider_account_id;
  return {...creds,pageId:matches?creds.pageId:'',pageName:matches?creds.pageName:null,instagramAccountId:matches?creds.instagramAccountId:null,instagramUsername:matches?creds.instagramUsername:null,adAccountId:account.provider_account_id,adAccountName:account.name,adAccountCurrency:account.currency,adAccountTimezone:account.timezone};
}
export async function resolveGoogleReportingAccount(userId: number, id: number) {
  const account = await ownedPaidAdAccount(userId,id);
  if (account.platform !== 'google' || account.is_manager || !account.reporting_available) throw new Error('Select a Google Ads customer with reporting access.');
  const creds = await (await import('../../controllers/integrationsController.js')).getGoogleAdsCredentials(userId);
  if (!creds) throw new Error('Reconnect Google Ads.');
  return {...creds,customerId:account.provider_account_id,managerAccountId:account.manager_account_id || ''};
}

async function campaignAccountBinding(userId:number,campaignId:number,platform:'meta'|'google') {
  const result=await db.execute(sql`SELECT ad_account_id,ad_platform,settings FROM performance_ad_campaigns WHERE user_id=${userId} AND id=${campaignId}`);
  const campaign=result.rows[0];
  if(!campaign)throw new Error('Campaign not found.');
  const snapshot=campaign.settings?.accountSnapshot || {};
  const providerId=String((platform==='google'?snapshot.google?.customerId:snapshot.meta?.adAccountId) || (campaign.ad_platform===platform?campaign.ad_account_id:null) || snapshot.adAccountId || '').replace(/^act_/,'').replaceAll('-','');
  if(!providerId)return {providerId,account:null};
  const rows=await db.execute(sql`SELECT id FROM paid_ad_accounts WHERE user_id=${userId} AND platform=${platform} AND provider_account_id=${providerId} AND is_active=TRUE AND reporting_available=TRUE`);
  return {providerId,account:rows.rows[0]?.id ? Number(rows.rows[0].id):null};
}
export async function resolveCampaignMetaCredentials(userId:number,campaignId:number) {
  const binding=await campaignAccountBinding(userId,campaignId,'meta');
  if(binding.account)return resolveMetaReportingAccount(userId,binding.account);
  const creds=await getMetaAdsCreds(userId);
  if(binding.providerId && (!creds || creds.adAccountId.replace(/^act_/,'')!==binding.providerId))throw new Error('Reconnect the Meta account bound to this campaign.');
  return creds;
}
export async function resolveCampaignGoogleCredentials(userId:number,campaignId:number) {
  const binding=await campaignAccountBinding(userId,campaignId,'google');
  if(binding.account)return resolveGoogleReportingAccount(userId,binding.account);
  const creds=await (await import('../../controllers/integrationsController.js')).getGoogleAdsCredentials(userId);
  if(binding.providerId && (!creds || creds.customerId!==binding.providerId))throw new Error('Reconnect the Google customer bound to this campaign.');
  return creds;
}
