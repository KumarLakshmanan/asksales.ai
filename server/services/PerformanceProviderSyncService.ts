import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { MetaInsightsError } from './social/MetaInsightsClient.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_BUSINESS_TIMEZONE } from '../utils/timezone.js';
import { MetaReportingError } from './ads/MetaReportingReader.js';

type SyncKind = 'paid_meta' | 'paid_google' | 'social';
type SyncOutcome = { status: number; body: Record<string, unknown> };

/** Atomic lease keeps multiple worker replicas from polling the same account. */
export async function runProviderSync(
  userId: number,
  kind: SyncKind,
  resourceKey: string,
  intervalMinutes: number,
  sync: () => Promise<SyncOutcome>,
  force = false,
): Promise<SyncOutcome | null> {
  const leaseToken = randomUUID();
  const claim = await db.execute(sql`
    INSERT INTO performance_sync_state (user_id, kind, resource_key, status, lease_token, lease_until, last_attempt_at)
    VALUES (${userId}, ${kind}, ${resourceKey}, 'running', ${leaseToken}::uuid, NOW() + INTERVAL '30 minutes', NOW())
    ON CONFLICT (business_profile_id, user_id, kind, resource_key) DO UPDATE SET
      status = 'running', lease_token = EXCLUDED.lease_token, lease_until = EXCLUDED.lease_until, last_attempt_at = NOW()
    WHERE (performance_sync_state.lease_until IS NULL OR performance_sync_state.lease_until < NOW())
      AND (${force} OR performance_sync_state.next_due_at <= NOW())
      AND (performance_sync_state.error_code IS DISTINCT FROM 'META_REPORTING_RATE_LIMITED' OR performance_sync_state.next_due_at <= NOW())
    RETURNING user_id
  `);
  if (!claim.rows.length) {
    if (force && kind === 'paid_meta') {
      const cooldown = await db.execute(sql`SELECT GREATEST(1,CEIL(EXTRACT(EPOCH FROM(next_due_at-NOW())))) AS retry_after
        FROM performance_sync_state WHERE user_id=${userId} AND kind=${kind} AND resource_key=${resourceKey}
          AND error_code='META_REPORTING_RATE_LIMITED' AND next_due_at>NOW()`);
      if (cooldown.rows[0]) return { status: 429, body: { code: 'META_REPORTING_RATE_LIMITED', error: 'Meta reporting is cooling down after a rate limit. Saved data remains available.', retryAfterSeconds: Number(cooldown.rows[0].retry_after) } };
    }
    return null;
  }
  let result: SyncOutcome;
  try {
    result = await sync();
  } catch (error) {
    // Provider exceptions can contain token-bearing URLs. Persist only a code.
    result = error instanceof MetaReportingError
      ? {status:error.code==='META_REPORTING_RATE_LIMITED'?429:502,body:{error:error.message,code:error.code,retryAfterSeconds:error.retryAfterSeconds}}
      : error instanceof MetaInsightsError ? {status:error.status,body:{error:error.message,code:error.code}} : { status: 502, body: { error: 'Provider data could not be synchronized. Try again shortly.', code: 'PROVIDER_SYNC_FAILED' } };
  }
  const succeeded = result.status < 400 && result.body.partialSuccess !== true;
  const delay = Math.max(5, Math.min(1440, intervalMinutes || 15));
  const rateLimited = result.body.code === 'META_REPORTING_RATE_LIMITED';
  const retrySeconds = Math.max(30, Math.min(86400, Number(result.body.retryAfterSeconds) || 300));
  await db.execute(sql`
    UPDATE performance_sync_state SET
      status = ${succeeded ? 'succeeded' : 'failed'},
      last_succeeded_at = CASE WHEN ${succeeded} THEN NOW() ELSE last_succeeded_at END,
      failure_count = CASE WHEN ${succeeded} THEN 0 ELSE failure_count + 1 END,
      next_due_at = CASE WHEN ${rateLimited} THEN NOW() + (${retrySeconds} * INTERVAL '1 second')
        ELSE NOW() + (CASE WHEN ${succeeded} THEN ${delay}
        ELSE LEAST(1440, ${delay} * POWER(2, LEAST(failure_count + 1, 7))) END * INTERVAL '1 minute') END,
      error_code = ${succeeded ? null : String(result.body.code || 'PROVIDER_SYNC_INCOMPLETE').slice(0, 100)},
      lease_token = NULL, lease_until = NULL
    WHERE user_id = ${userId} AND kind = ${kind} AND resource_key = ${resourceKey} AND lease_token = ${leaseToken}::uuid
  `);
  return result;
}

/** Refresh inventory even for accounts with no imported/managed campaigns. */
export async function syncDuePaidMetaAccounts() {
  const candidates = await db.execute(sql`
    WITH connected AS (
      SELECT user_id FROM meta_page_connections WHERE is_active = TRUE AND ad_account_id IS NOT NULL
      UNION SELECT user_id FROM channel_credentials WHERE is_active = TRUE AND platform = 'meta' AND account_identifier IS NOT NULL
    )
    SELECT connected.user_id, COALESCE(settings.analytics_sync_minutes, 15) AS interval_minutes
    FROM connected
    LEFT JOIN ad_settings settings ON settings.user_id = connected.user_id
    LEFT JOIN performance_sync_state state ON state.user_id = connected.user_id AND state.kind = 'paid_meta' AND state.resource_key = 'meta'
    WHERE (state.next_due_at IS NULL OR state.next_due_at <= NOW())
      AND (state.lease_until IS NULL OR state.lease_until < NOW())
      AND NOT EXISTS (SELECT 1 FROM paid_ad_accounts account WHERE account.user_id=connected.user_id AND account.platform='meta' AND account.is_active=TRUE AND account.reporting_available=TRUE)
    ORDER BY state.next_due_at ASC NULLS FIRST, connected.user_id LIMIT 50
  `);
  const { refreshMetaPerformanceCacheForUser } = await import('../controllers/performanceMarketingController.js');
  let completed = 0;
  let failed = 0;
  for (const row of candidates.rows as Array<{ user_id: number; interval_minutes: number }>) {
    const result = await runProviderSync(Number(row.user_id), 'paid_meta', 'meta', Number(row.interval_minutes), async () => {
      const refreshed = await refreshMetaPerformanceCacheForUser(Number(row.user_id), 'last_30d');
      return { status: 200, body: { ...refreshed, partialSuccess: refreshed.errors.length > 0 } };
    });
    if (result) {
      if (result.status < 400 && !result.body.partialSuccess) completed++;
      else failed++;
    }
  }
  logger.info({ completed, failed }, '[PerformanceSync] Paid Meta inventory cycle completed');
  return { completed, failed };
}

/** One lease covers account metrics and publication history, including manual jobs. */
export async function syncSocialAccount(userId: number, input: { platform:string;credentialId:number;startDate:string;endDate:string;timezone:string }, force = false, incremental = false) {
  return runProviderSync(userId,'social',String(input.credentialId),30,async () => {
    const { synchronizeSocialAnalytics } = await import('../controllers/socialAnalyticsController.js');
    let analytics: SyncOutcome;
    try { analytics = await synchronizeSocialAnalytics(userId,input,{incremental}); }
    catch(error) { analytics = {status:error instanceof MetaInsightsError?error.status:503,body:{error:error instanceof MetaInsightsError?error.message:'Account metrics could not be refreshed. Saved data is still available.',code:error instanceof MetaInsightsError?error.code:'SOCIAL_METRICS_UNAVAILABLE'}}; }
    if (input.platform!=='facebook' && input.platform!=='instagram') return analytics;
    let content: {count:number;complete:boolean;limitations:string[]};
    try {
      const { synchronizeSocialContent }=await import('./social/SocialContentInsightsService.js');
      content=await synchronizeSocialContent(userId,input.credentialId,input.startDate,incremental ? new Date().toISOString().slice(0,10) : input.endDate);
    } catch(error) { content={count:0,complete:false,limitations:[error instanceof MetaInsightsError?error.message:'Publication history could not be refreshed. Saved posts are still available.']}; }
    return {status:analytics.status,body:{...analytics.body,content,partialSuccess:analytics.body.partialSuccess===true || !content.complete}};
  },force);
}

/** Organic analytics runs independently of ad automation and of open browsers. */
export async function syncDueSocialAccounts(now = new Date()) {
  const candidates = await db.execute(sql`
    SELECT credential.id, credential.user_id, credential.platform
    FROM channel_credentials credential
    LEFT JOIN performance_sync_state state ON state.user_id = credential.user_id AND state.kind = 'social' AND state.resource_key = credential.id::text
    WHERE credential.is_active = TRUE AND credential.account_identifier IS NOT NULL
      AND credential.platform IN ('facebook_api', 'facebook_page', 'instagram_api', 'youtube')
      AND (state.next_due_at IS NULL OR state.next_due_at <= NOW())
      AND (state.lease_until IS NULL OR state.lease_until < NOW())
    ORDER BY state.next_due_at ASC NULLS FIRST, credential.id LIMIT 50
  `);
  const end = new Date(now); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 29);
  let completed = 0;
  let failed = 0;
  for (const row of candidates.rows as Array<{ id: number; user_id: number; platform: string }>) {
    const platform = row.platform.startsWith('facebook') ? 'facebook' : row.platform.replace('_api', '');
    const result = await syncSocialAccount(Number(row.user_id), {
      platform, credentialId: Number(row.id), startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), timezone: DEFAULT_BUSINESS_TIMEZONE,
    }, false, true);
    if (result) {
      if (result.status < 400 && !result.body.partialSuccess) completed++;
      else failed++;
    }
  }
  logger.info({ completed, failed }, '[PerformanceSync] Social analytics cycle completed');
  return { completed, failed };
}

/** Account-specific leases keep Google and Meta discovery current without changing publishing defaults. */
export async function syncPaidAdAccount(userId:number, accountId:number, force=false) {
  const {ownedPaidAdAccount}=await import('./ads/PaidAdAccountsService.js');
  const account=await ownedPaidAdAccount(userId,accountId);
  return runProviderSync(userId,account.platform==='google'?'paid_google':'paid_meta',`account:${accountId}`,30,async()=>{
    await db.execute(sql`UPDATE paid_ad_accounts SET last_attempt_at=NOW() WHERE id=${accountId} AND user_id=${userId}`);
    try {
      let body: Record<string,unknown>;
      if(account.platform==='google') {
        body=await (await import('./ads/GoogleAdsInventoryService.js')).refreshGoogleAdsInventory(userId,accountId);
      } else {
        const result=await (await import('../controllers/performanceMarketingController.js')).refreshMetaPerformanceCacheForUser(userId,'last_90d',undefined,accountId);
        const rateLimit=result.errors.find(error=>error.code==='META_REPORTING_RATE_LIMITED');
        body={...result,partialSuccess:result.errors.length>0,...(rateLimit?{code:rateLimit.code,error:rateLimit.message,retryAfterSeconds:rateLimit.retryAfterSeconds}:{})};
      }
      if(!body.partialSuccess) await db.execute(sql`UPDATE paid_ad_accounts SET last_succeeded_at=NOW(),data_available_through=CURRENT_DATE,error_code=NULL WHERE id=${accountId} AND user_id=${userId}`);
      else await db.execute(sql`UPDATE paid_ad_accounts SET error_code=${String(body.code||'INCOMPLETE_REPORTING')} WHERE id=${accountId} AND user_id=${userId}`);
      return {status:body.code==='META_REPORTING_RATE_LIMITED'?429:200,body};
    } catch (error) {
      const code=error instanceof MetaReportingError?error.code:'REPORTING_FAILED';
      await db.execute(sql`UPDATE paid_ad_accounts SET error_code=${code} WHERE id=${accountId} AND user_id=${userId}`);
      return {status:code==='META_REPORTING_RATE_LIMITED'?429:502,body:{code,error:error instanceof MetaReportingError?error.message:'Account reporting failed. Check permissions and reconnect if needed. Saved data remains available.',...(error instanceof MetaReportingError?{retryAfterSeconds:error.retryAfterSeconds}:{})}};
    }
  },force);
}
export async function syncDuePaidAdAccounts() {
  const result=await db.execute(sql`SELECT account.id,account.user_id FROM paid_ad_accounts account
    LEFT JOIN performance_sync_state state ON state.user_id=account.user_id AND state.resource_key='account:'||account.id::text
      AND state.kind=CASE WHEN account.platform='google' THEN 'paid_google' ELSE 'paid_meta' END
    WHERE account.is_active=TRUE AND account.is_manager=FALSE AND account.reporting_available=TRUE
      AND (state.next_due_at IS NULL OR state.next_due_at<=NOW()) AND (state.lease_until IS NULL OR state.lease_until<NOW())
    ORDER BY state.next_due_at NULLS FIRST LIMIT 50`);
  for(const row of result.rows) await syncPaidAdAccount(Number(row.user_id),Number(row.id));
}
