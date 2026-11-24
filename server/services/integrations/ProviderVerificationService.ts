import { and, desc, eq, or } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { channelCredentialsTable } from '../../models/channelCredentials/schema.js';
import { getActiveAdminCredential } from '../../models/adminApiCredentials/functions.js';
import { resendDomainsTable } from '../../models/resendDomains/schema.js';
import { metaPageConnectionsTable } from '../../models/metaPageConnections/schema.js';
import {
  providerVerificationRunsTable,
  type ProviderVerificationCheck,
  type ProviderVerificationPlatform,
  type ProviderVerificationStatus,
} from '../../models/providerVerificationRuns/schema.js';
import {
  decryptChannelCredentialSecret,
  decryptChannelCredentialSession,
} from '../../utils/channelCredentialSecrets.js';
import { getGraphApiVersion, getOAuthBaseUrl } from '../../utils/metaApiVersion.js';
import { logger } from '../../utils/logger.js';
import { boundMetaPageToken, decryptMetaSecret } from '../../utils/metaCredentialSecrets.js';
import { INSTAGRAM_LOGIN_MESSAGING_SCOPES, META_MESSAGING_SCOPES } from './MetaConnectionPolicy.js';
import { isDirectInstagramLogin } from '../../utils/instagramOAuthCredential.js';
import { getInstagramLoginApp } from './InstagramLogin.js';
import { getMetaAppReviewPermissions, inspectMetaToken, metaAppIdsMatch } from './MetaCapabilityRegistry.js';
import { getMetaAdsCreds } from '../../models/metaPageConnections/functions.js';
import { getGoogleAdsCredentials } from '../../controllers/integrationsController.js';
import { getGoogleAdsAccountInfo, verifyGoogleAdsCredentials } from '../ads/GoogleAdsService.js';
import { ChannelCredentialModel } from '../../models/channelCredentials/functions.js';
import { readMSG91Settings } from '../../utils/msg91Credentials.js';
import { verifyMSG91Configuration } from './MSG91ProviderService.js';

const VERIFICATION_TTL_MS = 6 * 60 * 60_000;
const PROVIDER_TIMEOUT_MS = 12_000;

type CheckStatus = ProviderVerificationCheck['status'];

export interface ProviderVerificationResult {
  platform: ProviderVerificationPlatform;
  status: ProviderVerificationStatus;
  credentialId: number | null;
  providerAccountId: string | null;
  checks: ProviderVerificationCheck[];
  providerRequestIds: string[];
  errorCode: string | null;
  checkedAt: string;
  expiresAt: string;
}

interface ProviderResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  requestId: string | null;
}

interface CredentialRow {
  id: number;
  platform: string;
  credentialType: string;
  accessToken: string | null;
  refreshToken: string | null;
  apiKey: string | null;
  tokenExpiry: Date | null;
  accountIdentifier: string | null;
  sessionData: unknown;
  encryptionVersion: string | null;
  encryptionKeyId: string | null;
  encryptedAt: Date | null;
  grantedScopes: string[];
}

interface MetaAppSubscription {
  id?: string | number;
  subscribed_fields?: string[];
  whatsapp_business_api_data?: {
    id?: string | number;
  };
}

/** Instagram Login's subscribed_apps returns an Instagram subscription ID,
 * not the public Instagram Login App ID. The account-scoped token only sees
 * this app's subscriptions, so verify the subscribed message fields instead. */
export function hasInstagramMessagingSubscription(subscriptions: MetaAppSubscription[] | null | undefined): boolean {
  return Boolean(subscriptions?.some(item =>
    item.subscribed_fields?.includes('messages') && item.subscribed_fields.includes('messaging_postbacks')));
}

interface WhatsAppHealthStatus {
  can_send_message?: string;
}

function check(id: string, status: CheckStatus, required: boolean, detail: string): ProviderVerificationCheck {
  return { id, status, required, detail };
}

export function hasConfiguredMetaAppSubscription(
  subscriptions: MetaAppSubscription[] | null | undefined,
  configuredAppId: string,
): boolean {
  if (!configuredAppId || !Array.isArray(subscriptions)) return false;
  return subscriptions.some((subscription) => metaAppIdsMatch(
    subscription.id ?? subscription.whatsapp_business_api_data?.id,
    configuredAppId,
  ));
}

export function evaluateProviderVerificationChecks(checks: ProviderVerificationCheck[]): {
  status: ProviderVerificationStatus;
  errorCode: string | null;
} {
  const required = checks.filter((item) => item.required);
  const failed = required.find((item) => item.status === 'fail');
  if (failed) return { status: 'failing', errorCode: failed.id.toUpperCase() };
  const blocked = required.find((item) => item.status === 'blocked');
  if (blocked) return { status: 'blocked', errorCode: blocked.id.toUpperCase() };
  return { status: 'passing', errorCode: null };
}

const RECONNECT_ERROR_CODES = new Set([
  'CREDENTIAL',
  'CREDENTIAL_ENCRYPTION',
  'CREDENTIAL_VALIDITY',
  'PROVIDER_TOKEN',
  'ACCOUNT_IDENTITY',
  'REQUIRED_SCOPES',
  'MSG91_AUTH_FAILED',
]);

/**
 * Only authorization failures should send an owner back through OAuth.
 * Deployment readiness issues such as Meta App Review or a webhook outage are
 * actionable, but reconnecting the same valid account cannot repair them.
 */
export function providerVerificationRequiresReconnect(errorCode: string | null | undefined): boolean {
  return Boolean(errorCode && RECONNECT_ERROR_CODES.has(errorCode));
}

export function publicProviderEndpoints(baseUrl = getOAuthBaseUrl()): Record<string, string> {
  const normalized = baseUrl.replace(/\/+$/, '');
  return {
    facebook: `${normalized}/api/webhooks/facebook`,
    instagram: `${normalized}/api/webhooks/instagram`,
    meta_ads: `${normalized}/api/meta/oauth/callback`,
    google_ads: `${normalized}/api/google-ads/oauth/callback`,
    whatsapp: `${normalized}/api/whatsapp/webhook`,
    // Gmail Pub/Sub is deliberately mounted before the authenticated OAuth
    // router; Google cannot supply an application JWT with the push request.
    gmail: `${normalized}/api/gmail/oauth/webhook`,
    resend: `${normalized}/api/resend/webhook`,
    msg91: `${normalized}/api/webhooks/sms/:userToken/delivery`,
    youtube: `${normalized}/api/youtube/oauth/callback`,
  };
}

async function providerFetch<T>(url: string, init: RequestInit = {}): Promise<ProviderResponse<T>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: { accept: 'application/json', ...init.headers },
  });
  let data: T | null = null;
  try { data = await response.json() as T; } catch { /* response body is optional */ }
  return {
    ok: response.ok,
    status: response.status,
    data,
    requestId: response.headers.get('x-fb-trace-id')
      || response.headers.get('x-goog-request-id')
      || response.headers.get('x-request-id'),
  };
}

function scopesFrom(row: CredentialRow, session: Record<string, unknown>): string[] {
  const granted = Array.isArray(row.grantedScopes) ? row.grantedScopes : [];
  const sessionScope = typeof session.scope === 'string' ? session.scope.split(/\s+/) : [];
  return [...new Set([...granted, ...sessionScope].filter(Boolean))];
}

function requiredScopes(platform: ProviderVerificationPlatform, sessionData?: unknown): string[] {
  switch (platform) {
    // Connection verification covers messaging; optional features expose their own readiness.
    case 'facebook': return META_MESSAGING_SCOPES.facebook;
    case 'instagram': return isDirectInstagramLogin({ sessionData }) ? INSTAGRAM_LOGIN_MESSAGING_SCOPES : META_MESSAGING_SCOPES.instagram;
    case 'whatsapp': return ['whatsapp_business_messaging', 'whatsapp_business_management'];
    case 'meta_ads': return ['ads_read', 'ads_management'];
    case 'google_ads': return [];
    case 'youtube': return [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/youtube.readonly',
    ];
    case 'gmail': return [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
    ];
    case 'resend': return [];
    case 'msg91': return [];
  }
}

async function loadCredential(userId: number, platform: ProviderVerificationPlatform, credentialId?: number): Promise<CredentialRow | null> {
  const storedPlatform = platform === 'gmail' ? 'gmail_api'
    : platform === 'facebook' ? 'facebook_api'
      : platform === 'instagram' ? 'instagram_api'
        : platform;
  const predicates = [
    eq(channelCredentialsTable.userId, userId),
    eq(channelCredentialsTable.platform, storedPlatform),
    eq(channelCredentialsTable.isActive, true),
  ];
  if (credentialId) predicates.push(eq(channelCredentialsTable.id, credentialId));
  const [row] = await db.select({
    id: channelCredentialsTable.id,
    platform: channelCredentialsTable.platform,
    credentialType: channelCredentialsTable.credentialType,
    accessToken: channelCredentialsTable.accessToken,
    refreshToken: channelCredentialsTable.refreshToken,
    apiKey: channelCredentialsTable.apiKey,
    tokenExpiry: channelCredentialsTable.tokenExpiry,
    accountIdentifier: channelCredentialsTable.accountIdentifier,
    sessionData: channelCredentialsTable.sessionData,
    encryptionVersion: channelCredentialsTable.encryptionVersion,
    encryptionKeyId: channelCredentialsTable.encryptionKeyId,
    encryptedAt: channelCredentialsTable.encryptedAt,
    grantedScopes: channelCredentialsTable.grantedScopes,
  }).from(channelCredentialsTable).where(and(...predicates)).orderBy(
    desc(channelCredentialsTable.isSelected),
    desc(channelCredentialsTable.updatedAt),
  ).limit(1);
  return row || null;
}

async function refreshGoogleAccessTokenForVerification(
  userId: number,
  platform: 'youtube' | 'gmail',
  row: CredentialRow,
): Promise<string | null> {
  if (!row.refreshToken) return null;
  if (platform === 'gmail') {
    const { getGmailClientForUser } = await import('../../controllers/gmailOAuthController.js');
    const refreshed = await getGmailClientForUser(userId);
    const credential = refreshed?.credential as { id?: unknown; accessToken?: unknown } | undefined;
    return credential?.id === row.id && typeof credential.accessToken === 'string'
      ? credential.accessToken
      : null;
  }
  const { getYouTubeVerificationAccessToken } = await import('../social/YouTubePublishingService.js');
  return getYouTubeVerificationAccessToken(userId, row.id);
}

/** Direct Instagram tokens are verified on Instagram, never Facebook debug_token. */
async function verifyInstagramLogin(row: CredentialRow, token: string) {
  const app = await getInstagramLoginApp();
  const base = `https://graph.instagram.com/${await getGraphApiVersion()}`;
  const headers = { authorization: `Bearer ${token}` };
  const account = await providerFetch<{ id?: string; user_id?: string }>(`${base}/me?fields=id,user_id`, { headers });
  const subscriptions = row.accountIdentifier
    ? await providerFetch<{ data?: MetaAppSubscription[] }>(`${base}/${encodeURIComponent(row.accountIdentifier)}/subscribed_apps`, { headers })
    : null;
  const identityMatches = account.ok && String(account.data?.user_id || account.data?.id || '') === row.accountIdentifier;
  const subscribed = Boolean(app && subscriptions?.ok && hasInstagramMessagingSubscription(subscriptions.data?.data));
  // Instagram Login reports granted permissions during the code exchange. Its
  // Instagram User does not expose Facebook Login's /me/permissions edge.
  // Keep those provider-issued grants, and separately verify the live account
  // identity and messaging subscription with the current token.
  const scopes = Array.isArray(row.grantedScopes) ? row.grantedScopes : [];
  return {
    scopes, requestIds: [account.requestId, subscriptions?.requestId].filter((id): id is string => Boolean(id)),
    checks: [
      check('provider_token', !app ? 'blocked' : account.ok ? 'pass' : 'fail', true,
        !app ? 'Instagram Login app credentials are not configured.' : account.ok ? 'Instagram accepted the authorization.' : 'Instagram could not validate this authorization. Reconnect your account.'),
      check('account_identity', identityMatches ? 'pass' : 'fail', true,
        identityMatches ? 'Instagram account identity matches the stored workspace binding.' : 'Instagram account identity does not match this connection.'),
      check('webhook_subscription', subscribed ? 'pass' : 'fail', true,
        subscribed ? 'The configured Instagram app is subscribed to this account.' : 'The configured Instagram app is not subscribed. Reconnect to enable incoming messages.'),
    ],
  };
}

async function verifyMeta(
  userId: number,
  platform: 'facebook' | 'instagram' | 'whatsapp',
  row: CredentialRow,
  token: string,
  session: Record<string, unknown>,
): Promise<{ checks: ProviderVerificationCheck[]; requestIds: string[]; scopes: string[] }> {
  if (platform === 'instagram' && isDirectInstagramLogin(row)) return verifyInstagramLogin(row, token);
  const version = await getGraphApiVersion();
  const admin = await getActiveAdminCredential('meta_app');
  const manualAppId = row.credentialType === 'manual' && typeof session.appId === 'string'
    ? session.appId.trim() : '';
  const manualAppSecret = row.credentialType === 'manual' && typeof session.appSecret === 'string'
    ? session.appSecret.trim() : '';
  const verifierAppId = manualAppId || admin?.apiKey || '';
  const verifierAppSecret = manualAppSecret || admin?.apiSecret || '';
  const requestIds: string[] = [];
  const checks: ProviderVerificationCheck[] = [];
  let scopes = scopesFrom(row, session);

  if (verifierAppId && verifierAppSecret) {
    const debugUrl = new URL(`https://graph.facebook.com/${version}/debug_token`);
    debugUrl.searchParams.set('input_token', token);
    const debug = await providerFetch<{ data?: { is_valid?: boolean; app_id?: string | number; scopes?: string[] } }>(
      debugUrl.toString(),
      {
        headers: {
          authorization: `Bearer ${verifierAppId}|${verifierAppSecret}`,
        },
      },
    );
    if (debug.requestId) requestIds.push(debug.requestId);
    const valid = Boolean(debug.ok && debug.data?.data?.is_valid
      && metaAppIdsMatch(debug.data.data.app_id, verifierAppId));
    checks.push(check('provider_token', valid ? 'pass' : 'fail', true, valid
      ? 'Provider confirmed a valid token issued to the configured Meta app.'
      : `Provider could not validate this token for the configured ${manualAppId ? 'tenant' : 'deployment'} Meta app.`));
    // Provider-confirmed scopes replace cached/requested values. Keeping a
    // union here would make revoked permissions appear granted indefinitely.
    scopes = [...new Set(debug.data?.data?.scopes || [])];
  } else {
    checks.push(check('provider_token', 'blocked', true, 'The deployment Meta app credential is not configured.'));
  }

  const accountId = row.accountIdentifier || '';
  let pageSubscriptionToken = token;
  let resolvedPageId = String(session.pageId || session.facebookPageId || '');
  if (platform === 'facebook' || platform === 'instagram') {
    const [connection] = await db.select({
      pageId: metaPageConnectionsTable.pageId,
      pageAccessToken: metaPageConnectionsTable.pageAccessToken,
    }).from(metaPageConnectionsTable).where(and(
      eq(metaPageConnectionsTable.userId, userId),
      eq(metaPageConnectionsTable.isActive, true),
      platform === 'facebook'
        ? eq(metaPageConnectionsTable.pageId, accountId)
        : or(
          eq(metaPageConnectionsTable.instagramAccountId, accountId),
          eq(metaPageConnectionsTable.pageId, resolvedPageId || accountId),
        ),
    )).orderBy(desc(metaPageConnectionsTable.updatedAt)).limit(1);
    if (connection?.pageId) resolvedPageId = connection.pageId;
    if (connection?.pageAccessToken) pageSubscriptionToken = decryptMetaSecret(connection.pageAccessToken);
    if (boundMetaPageToken(row)) pageSubscriptionToken = decryptMetaSecret(boundMetaPageToken(row));
  }
  const fields = platform === 'whatsapp' ? 'id,display_phone_number,verified_name' : platform === 'instagram' ? 'id,username,name' : 'id,name';
  const account = accountId ? await providerFetch<{ id?: string }>(
    `https://graph.facebook.com/${version}/${encodeURIComponent(accountId)}?fields=${encodeURIComponent(fields)}`,
    { headers: { authorization: `Bearer ${token}` } },
  ) : null;
  if (account?.requestId) requestIds.push(account.requestId);
  const identityMatches = Boolean(account?.ok && account.data?.id === accountId);
  checks.push(check('account_identity', identityMatches ? 'pass' : accountId ? 'fail' : 'blocked', true,
    identityMatches ? 'Provider account identity matches the stored tenant binding.' : 'Provider account identity could not be confirmed.'));

  const webhookOwnerId = platform === 'whatsapp'
    ? String(session.businessAccountId || '')
    : resolvedPageId || (platform === 'facebook' ? accountId : '');
  if (webhookOwnerId) {
    const subscriptions = await providerFetch<{ data?: MetaAppSubscription[] }>(
      `https://graph.facebook.com/${version}/${encodeURIComponent(webhookOwnerId)}/subscribed_apps`,
      { headers: { authorization: `Bearer ${pageSubscriptionToken}` } },
    );
    if (subscriptions.requestId) requestIds.push(subscriptions.requestId);
    const subscribed = Boolean(subscriptions.ok && hasConfiguredMetaAppSubscription(
      subscriptions.data?.data,
      verifierAppId,
    ));
    checks.push(check('webhook_subscription', subscribed ? 'pass' : 'fail', true, subscribed
      ? 'Provider reports an active webhook subscription for the configured Meta app.'
      : 'The configured Meta app is not subscribed to this account webhook.'));

    if (platform === 'whatsapp') {
      const phoneInventory = await providerFetch<{ data?: Array<{ id?: string }> }>(
        `https://graph.facebook.com/${version}/${encodeURIComponent(webhookOwnerId)}/phone_numbers?fields=id`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (phoneInventory.requestId) requestIds.push(phoneInventory.requestId);
      const phoneBound = Boolean(phoneInventory.ok
        && Array.isArray(phoneInventory.data?.data)
        && phoneInventory.data.data.some((phone) => phone.id === accountId));
      checks.push(check('phone_number_binding', phoneBound ? 'pass' : 'fail', true, phoneBound
        ? 'The selected phone number is registered on the connected WhatsApp Business Account.'
        : 'The selected phone number is no longer registered on this WhatsApp Business Account.'));

      const health = await providerFetch<{ health_status?: WhatsAppHealthStatus }>(
        `https://graph.facebook.com/${version}/${encodeURIComponent(webhookOwnerId)}?fields=health_status`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (health.requestId) requestIds.push(health.requestId);
      const healthState = String(health.data?.health_status?.can_send_message || '').toUpperCase();
      const healthAvailable = health.ok && healthState !== 'BLOCKED';
      checks.push(check('waba_health', healthAvailable ? 'pass' : health.ok ? 'fail' : 'blocked', true, healthAvailable
        ? 'The WhatsApp Business Account is not blocked from sending messages.'
        : health.ok
          ? 'Meta reports that this WhatsApp Business Account is blocked from sending messages.'
          : 'WhatsApp Business Account health could not be verified.'));
    }
  } else {
    checks.push(check('webhook_subscription', 'blocked', true, 'Webhook owner metadata is missing; reconnect or resubscribe the account.'));
  }
  return { checks, requestIds, scopes };
}

async function verifyGoogle(
  platform: 'youtube' | 'gmail',
  row: CredentialRow,
  token: string,
  session: Record<string, unknown>,
): Promise<{ checks: ProviderVerificationCheck[]; requestIds: string[]; scopes: string[] }> {
  const url = platform === 'youtube'
    ? 'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true'
    : 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
  const response = await providerFetch<{ items?: Array<{ id?: string }>; emailAddress?: string }>(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const requestIds = response.requestId ? [response.requestId] : [];
  const providerIdentity = platform === 'youtube' ? response.data?.items?.[0]?.id : response.data?.emailAddress;
  const matches = Boolean(response.ok && providerIdentity && providerIdentity.toLowerCase() === row.accountIdentifier?.toLowerCase());
  const checks = [check('account_identity', matches ? 'pass' : response.ok ? 'fail' : 'blocked', true, matches
    ? 'Google account identity matches the stored tenant binding.'
    : 'Google account identity could not be confirmed; reconnect this account.')];
  if (platform === 'gmail') {
    const watchExpires = Number(session.watchExpiration || session.watchExpiresAt || 0);
    const activeWatch = Number.isFinite(watchExpires) && watchExpires > Date.now();
    checks.push(check('webhook_subscription', activeWatch ? 'pass' : 'fail', true, activeWatch
      ? 'Gmail push watch metadata is active.'
      : 'Gmail push watch is missing or expired and must be renewed.'));
  }
  return { checks, requestIds, scopes: scopesFrom(row, session) };
}

async function verifyResend(userId: number): Promise<{
  credentialId: null;
  providerAccountId: string | null;
  checks: ProviderVerificationCheck[];
  requestIds: string[];
}> {
  const admin = await getActiveAdminCredential('resend');
  const webhookSecret = typeof admin?.config?.webhookSecret === 'string'
    ? admin.config.webhookSecret.trim()
    : (process.env.RESEND_WEBHOOK_SECRET || '').trim();
  const [domain] = await db.select().from(resendDomainsTable).where(eq(resendDomainsTable.userId, userId))
    .orderBy(desc(resendDomainsTable.updatedAt)).limit(1);
  if (!admin?.apiKey) return { credentialId: null, providerAccountId: domain?.name || null, requestIds: [], checks: [
    check('provider_token', 'blocked', true, 'The deployment Resend credential is not configured.'),
    check('dns_verification', domain ? 'blocked' : 'fail', true, domain ? 'Cannot verify DNS without the provider credential.' : 'No tenant-owned Resend domain is configured.'),
  ] };
  if (!domain) return { credentialId: null, providerAccountId: null, requestIds: [], checks: [
    check('provider_token', 'pass', true, 'A Resend provider credential is configured.'),
    check('dns_verification', 'fail', true, 'No tenant-owned Resend domain is configured.'),
  ] };
  const domainResponse = await providerFetch<{ id?: string; name?: string; status?: string; records?: Array<{ status?: string }> }>(
    `https://api.resend.com/domains/${encodeURIComponent(domain.resendDomainId)}`,
    { headers: { authorization: `Bearer ${admin.apiKey}` } },
  );
  const requestIds = domainResponse.requestId ? [domainResponse.requestId] : [];
  const identityMatches = Boolean(domainResponse.ok && domainResponse.data?.id === domain.resendDomainId && domainResponse.data?.name === domain.name);
  const dnsVerified = Boolean(identityMatches && domainResponse.data?.status === 'verified'
    && (domainResponse.data.records || []).every((record) => record.status === 'verified'));
  const webhooks = await providerFetch<{ data?: Array<{ endpoint?: string; status?: string }> }>('https://api.resend.com/webhooks', {
    headers: { authorization: `Bearer ${admin.apiKey}` },
  });
  if (webhooks.requestId) requestIds.push(webhooks.requestId);
  const expected = publicProviderEndpoints().resend;
  const webhookReady = Boolean(webhooks.ok && webhooks.data?.data?.some((item) => item.endpoint === expected && item.status !== 'disabled'));
  return {
    credentialId: null,
    providerAccountId: domain.name,
    requestIds,
    checks: [
      check('provider_token', identityMatches ? 'pass' : 'fail', true, identityMatches ? 'Provider domain identity is tenant-bound.' : 'Provider domain identity could not be confirmed.'),
      check('dns_verification', dnsVerified ? 'pass' : 'fail', true, dnsVerified ? 'All required Resend DNS records are verified.' : 'Required Resend DNS records are not fully verified.'),
      check('webhook_subscription', webhookReady ? 'pass' : 'fail', true, webhookReady ? 'Resend webhook endpoint is registered.' : `Register the expected Resend webhook endpoint: ${expected}`),
      check('webhook_signature_secret', webhookSecret ? 'pass' : 'fail', true, webhookSecret
        ? 'A Resend/Svix webhook signing secret is configured.'
        : 'Configure the Resend webhook signing secret before accepting external events.'),
    ],
  };
}

async function verifyMetaAds(userId: number): Promise<{
  credentialId: null;
  providerAccountId: string | null;
  checks: ProviderVerificationCheck[];
  requestIds: string[];
}> {
  const credentials = await getMetaAdsCreds(userId);
  if (!credentials) return { credentialId: null, providerAccountId: null, requestIds: [], checks: [
    check('credential', 'blocked', true, 'No selected Meta ad account and Facebook Page are connected.'),
  ] };
  const admin = await getActiveAdminCredential('meta_app');
  if (!admin?.apiKey || !admin.apiSecret) return { credentialId: null, providerAccountId: credentials.adAccountId, requestIds: [], checks: [
    check('provider_token', 'blocked', true, 'The deployment Meta app credential is not configured.'),
  ] };
  const apiVersion = await getGraphApiVersion();
  const inspection = await inspectMetaToken({ accessToken: credentials.accessToken, appId: admin.apiKey, appSecret: admin.apiSecret, apiVersion });
  const checks: ProviderVerificationCheck[] = [
    check('provider_token', inspection.valid ? 'pass' : 'fail', true, inspection.valid ? 'Meta confirmed a valid Ads token.' : 'Meta rejected the Ads token for this app.'),
  ];
  const missingScopes = ['ads_read', 'ads_management'].filter((scope) => !inspection.grantedScopes.includes(scope));
  checks.push(check('required_scopes', missingScopes.length ? 'fail' : 'pass', true, missingScopes.length
    ? `Reconnect with required provider permission(s): ${missingScopes.join(', ')}`
    : 'Meta confirmed ads_read and ads_management.'));
  const review = await getMetaAppReviewPermissions();
  const unapproved = ['ads_read', 'ads_management'].filter((scope) => !['approved', 'not_required'].includes(review[scope as 'ads_read' | 'ads_management'] || 'unknown'));
  checks.push(check('app_review', unapproved.length ? 'blocked' : 'pass', true, unapproved.length
    ? `Meta App Review is not approved for: ${unapproved.join(', ')}`
    : 'Meta App Review approval is recorded for Ads capabilities.'));

  const account = await providerFetch<{ id?: string; currency?: string; account_status?: number }>(
    `https://graph.facebook.com/${apiVersion}/act_${encodeURIComponent(credentials.adAccountId)}?fields=id,currency,account_status`,
    { headers: { authorization: `Bearer ${credentials.accessToken}` } },
  );
  const page = await providerFetch<{ id?: string }>(
    `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(credentials.pageId)}?fields=id`,
    { headers: { authorization: `Bearer ${credentials.accessToken}` } },
  );
  const requestIds = [...inspection.providerRequestIds, account.requestId, page.requestId].filter((value): value is string => Boolean(value));
  const accountMatches = Boolean(account.ok && account.data?.id?.replace(/^act_/, '') === credentials.adAccountId);
  checks.push(check('ad_account_identity', accountMatches ? 'pass' : 'fail', true, accountMatches ? 'The selected ad account identity was confirmed.' : 'Meta did not confirm the selected ad account.'));
  checks.push(check('ad_account_currency', account.data?.currency ? 'pass' : 'fail', true, account.data?.currency ? `Account currency is ${account.data.currency}.` : 'The ad account currency is unavailable.'));
  checks.push(check('ad_account_status', Number(account.data?.account_status) === 1 ? 'pass' : 'fail', true, Number(account.data?.account_status) === 1 ? 'The ad account is active.' : `The ad account status is ${account.data?.account_status ?? 'unknown'}.`));
  checks.push(check('page_identity', page.ok && page.data?.id === credentials.pageId ? 'pass' : 'fail', true, page.ok && page.data?.id === credentials.pageId ? 'The selected Facebook Page identity was confirmed.' : 'Meta did not confirm the selected Facebook Page.'));
  return { credentialId: null, providerAccountId: credentials.adAccountId, checks, requestIds };
}

async function verifyGoogleAds(userId: number): Promise<{
  credentialId: null;
  providerAccountId: string | null;
  checks: ProviderVerificationCheck[];
  requestIds: string[];
}> {
  const credentials = await getGoogleAdsCredentials(userId);
  if (!credentials) return { credentialId: null, providerAccountId: null, requestIds: [], checks: [
    check('credential', 'blocked', true, 'No Google Ads OAuth and developer-token credential is configured.'),
  ] };
  const customerId = credentials.customerId.replaceAll('-', '');
  const materialReady = Boolean(credentials.clientId && credentials.clientSecret
    && credentials.developerToken && credentials.refreshToken && /^\d{10}$/.test(customerId));
  const checks = [check('credential_material', materialReady ? 'pass' : 'fail', true, materialReady
    ? 'Google Ads OAuth, developer token, and customer identity are configured.'
    : 'Google Ads requires OAuth client credentials, refresh token, developer token, and a 10-digit customer ID.')];
  if (!materialReady) return { credentialId: null, providerAccountId: customerId || null, requestIds: [], checks };

  const scoped = { ...credentials, customerId };
  const [authorization, account] = await Promise.all([
    verifyGoogleAdsCredentials(scoped),
    getGoogleAdsAccountInfo(scoped),
  ]);
  checks.push(check('provider_token', authorization.valid ? 'pass' : 'fail', true, authorization.valid
    ? 'Google Ads accepted the OAuth credential and developer token.'
    : 'Google Ads rejected the OAuth credential or developer token.'));
  const identityMatches = Boolean(account.valid && account.account?.customerId.replaceAll('-', '') === customerId);
  checks.push(check('ad_account_identity', identityMatches ? 'pass' : 'fail', true, identityMatches
    ? 'The selected Google Ads customer identity was confirmed.'
    : 'Google Ads did not confirm the selected customer identity.'));
  checks.push(check('ad_account_currency', account.account?.currency ? 'pass' : 'fail', true, account.account?.currency
    ? `Account currency is ${account.account.currency}.`
    : 'The Google Ads account currency is unavailable.'));
  checks.push(check('ad_account_status', account.account && !account.account.manager ? 'pass' : 'fail', true, account.account?.manager
    ? 'The selected Google Ads account is a manager; select a customer account for publishing.'
    : account.account ? 'The selected Google Ads customer is eligible for campaign review.' : 'The selected Google Ads customer is unavailable.'));
  return { credentialId: null, providerAccountId: customerId, checks, requestIds: [] };
}

export async function verifyProviderIntegration(
  userId: number,
  platform: ProviderVerificationPlatform,
  credentialId?: number,
): Promise<ProviderVerificationResult> {
  const checkedAt = new Date();
  const expiresAt = new Date(checkedAt.getTime() + VERIFICATION_TTL_MS);
  let selectedCredentialId: number | null = null;
  let providerAccountId: string | null = null;
  let checks: ProviderVerificationCheck[] = [];
  let providerRequestIds: string[] = [];

  try {
    if (platform === 'msg91') {
      const row = credentialId
        ? await ChannelCredentialModel.findActiveAccountById(userId, 'msg91_sms', credentialId)
        : await ChannelCredentialModel.findByUserAndPlatform(userId, 'msg91_sms');
      if (!row) {
        checks.push(check('credential', 'blocked', true, 'Connect an MSG91 sender in Integrations → SMS.'));
      } else {
        selectedCredentialId = row.id;
        providerAccountId = row.accountIdentifier;
        const encryptionReady = Boolean(row.encryptionVersion && row.encryptionKeyId && row.encryptedAt);
        checks.push(check('credential_encryption', encryptionReady ? 'pass' : 'fail', true,
          encryptionReady ? 'MSG91 credentials are stored with encryption metadata.' : 'Save the MSG91 connection again to protect its credentials.'));
        const smsSettings = readMSG91Settings(row);
        const senderBound = row.credentialType === 'api_key' && row.accountIdentifier === smsSettings.senderId;
        checks.push(check('account_identity', senderBound ? 'pass' : 'fail', true,
          senderBound ? 'The selected MSG91 account matches the configured Sender ID.' : 'Save the SMS settings again to verify the selected sender.'));
        const verified = await verifyMSG91Configuration(decryptChannelCredentialSecret(row.apiSecret), smsSettings);
        checks.push(check(verified.code?.toLowerCase() || 'sms_template', verified.success ? 'pass' : verified.code === 'MSG91_PROVIDER_UNAVAILABLE' ? 'blocked' : 'fail', true,
          verified.success ? 'MSG91 confirmed the active template, Sender ID, and message variable.' : verified.error || 'Verify the MSG91 connection.'));
        if (verified.providerRequestId) providerRequestIds.push(verified.providerRequestId);
        await ChannelCredentialModel.updateAccount(userId, 'msg91_sms', row.id, {
          providerVerifiedAt: verified.success && encryptionReady && senderBound ? checkedAt : null,
          lastReadinessCheckAt: checkedAt,
          readinessErrorCode: verified.code || (!encryptionReady ? 'MSG91_CREDENTIAL_ENCRYPTION' : !senderBound ? 'MSG91_SENDER_BINDING' : null),
          providerApiVersion: 'msg91-sms-v5',
          providerApprovalStatus: 'not_required',
        });
      }
    } else if (platform === 'resend') {
      const result = await verifyResend(userId);
      selectedCredentialId = result.credentialId;
      providerAccountId = result.providerAccountId;
      checks = result.checks;
      providerRequestIds = result.requestIds;
    } else if (platform === 'meta_ads') {
      const result = await verifyMetaAds(userId);
      selectedCredentialId = result.credentialId;
      providerAccountId = result.providerAccountId;
      checks = result.checks;
      providerRequestIds = result.requestIds;
    } else if (platform === 'google_ads') {
      const result = await verifyGoogleAds(userId);
      selectedCredentialId = result.credentialId;
      providerAccountId = result.providerAccountId;
      checks = result.checks;
      providerRequestIds = result.requestIds;
    } else {
      const row = await loadCredential(userId, platform, credentialId);
      if (!row) {
        checks = [check('credential', 'blocked', true, 'No active tenant credential is connected for this provider.')];
      } else {
        selectedCredentialId = row.id;
        providerAccountId = row.accountIdentifier;
        const session = decryptChannelCredentialSession(row.sessionData || {}) as Record<string, unknown>;
        let token = decryptChannelCredentialSecret(row.accessToken || row.apiKey);
        const encryptionMetadataReady = Boolean(row.encryptionVersion && row.encryptionKeyId && row.encryptedAt);
        checks.push(check('credential_encryption', encryptionMetadataReady ? 'pass' : 'fail', true,
          encryptionMetadataReady ? 'Credential encryption metadata is present.' : 'Credential must be rotated to encrypted storage.'));
        let activeToken = Boolean(token && (!row.tokenExpiry || row.tokenExpiry.getTime() > Date.now()));
        if (!activeToken && (platform === 'youtube' || platform === 'gmail')) {
          token = await refreshGoogleAccessTokenForVerification(userId, platform, row) || '';
          activeToken = Boolean(token);
        }
        checks.push(check('credential_validity', activeToken ? 'pass' : 'fail', true, activeToken
          ? 'Credential material is present and not expired.' : 'Credential is missing or expired.'));
        if (activeToken) {
          const verified = platform === 'facebook' || platform === 'instagram' || platform === 'whatsapp'
            ? await verifyMeta(userId, platform, row, token, session)
            : await verifyGoogle(platform, row, token, session);
          checks.push(...verified.checks);
          providerRequestIds = verified.requestIds;
          const required = requiredScopes(platform, session);
          const missingScopes = required.filter((scope) => !verified.scopes.includes(scope));
          checks.push(check('required_scopes', missingScopes.length ? 'fail' : 'pass', true, missingScopes.length
            ? `Reconnect with required provider permission(s): ${missingScopes.join(', ')}`
            : 'Required provider permissions are present.'));
          if (platform === 'facebook' || platform === 'instagram' || platform === 'whatsapp') {
            const review = await getMetaAppReviewPermissions();
            const unapproved = required.filter((scope) => !['approved', 'not_required'].includes(review[scope as keyof typeof review] || 'unknown'));
            checks.push(check('app_review', unapproved.length ? 'blocked' : 'pass', true, unapproved.length
              ? `Meta App Review is not approved for: ${unapproved.join(', ')}`
              : 'Meta App Review approval is recorded for every required capability.'));
          }
          const credentialEvaluation = evaluateProviderVerificationChecks(checks);
          const authorizationReady = !providerVerificationRequiresReconnect(credentialEvaluation.errorCode);
          await db.update(channelCredentialsTable).set({
            grantedScopes: verified.scopes,
            // This legacy field records whether a separate provider approval
            // concept applies. Meta App Review lives in deployment config and
            // is evaluated above; it must never be inferred from a user token.
            providerApprovalStatus: platform === 'facebook' || platform === 'instagram' || platform === 'whatsapp'
              ? 'not_required'
              : credentialEvaluation.status === 'passing' ? 'not_required' : 'pending',
            providerApiVersion: platform === 'facebook' || platform === 'instagram' || platform === 'whatsapp'
              ? await getGraphApiVersion() : platform === 'youtube' ? 'youtube-data-v3' : 'gmail-v1',
            providerVerifiedAt: authorizationReady ? checkedAt : null,
            lastReadinessCheckAt: checkedAt,
            readinessErrorCode: credentialEvaluation.errorCode,
            updatedAt: checkedAt,
          }).where(and(eq(channelCredentialsTable.id, row.id), eq(channelCredentialsTable.userId, userId)));
        }
      }
    }
  } catch (error) {
    logger.warn({ err: error, userId, platform, credentialId }, '[ProviderVerification] Provider check failed safely');
    checks.push(check('provider_connectivity', 'blocked', true, 'Provider verification could not complete. Retry after checking credentials and network access.'));
  }

  const publicEndpoint = publicProviderEndpoints()[platform];
  const endpointSecure = publicEndpoint.startsWith('https://');
  checks.push(check('public_callback_https', endpointSecure ? 'pass' : 'blocked', platform !== 'msg91', endpointSecure
    ? 'Public provider callback uses HTTPS.' : 'Set APP_URL or API_URL to the public HTTPS API origin.'));
  const evaluated = evaluateProviderVerificationChecks(checks);
  const [stored] = await db.insert(providerVerificationRunsTable).values({
    userId,
    platform,
    credentialId: selectedCredentialId,
    providerAccountId,
    status: evaluated.status,
    checks,
    providerRequestIds: [...new Set(providerRequestIds)],
    errorCode: evaluated.errorCode,
    checkedAt,
    expiresAt,
  }).returning();
  return {
    platform,
    status: stored.status,
    credentialId: stored.credentialId,
    providerAccountId: stored.providerAccountId,
    checks: stored.checks,
    providerRequestIds: stored.providerRequestIds,
    errorCode: stored.errorCode,
    checkedAt: stored.checkedAt.toISOString(),
    expiresAt: stored.expiresAt.toISOString(),
  };
}

export async function listLatestProviderVerifications(userId: number): Promise<ProviderVerificationResult[]> {
  const platforms: ProviderVerificationPlatform[] = ['facebook', 'instagram', 'whatsapp', 'meta_ads', 'google_ads', 'youtube', 'gmail', 'resend', 'msg91'];
  const latest = await Promise.all(platforms.map(async (platform) => {
    const [row] = await db.select().from(providerVerificationRunsTable)
      .where(and(
        eq(providerVerificationRunsTable.userId, userId),
        eq(providerVerificationRunsTable.platform, platform),
      ))
      .orderBy(desc(providerVerificationRunsTable.checkedAt))
      .limit(1);
    return row || null;
  }));
  return latest.filter((row): row is NonNullable<typeof row> => row !== null).map((row) => ({
    platform: row.platform,
    status: row.expiresAt.getTime() > Date.now() ? row.status : 'blocked',
    credentialId: row.credentialId,
    providerAccountId: row.providerAccountId,
    checks: row.checks,
    providerRequestIds: row.providerRequestIds,
    errorCode: row.expiresAt.getTime() > Date.now() ? row.errorCode : 'VERIFICATION_EXPIRED',
    checkedAt: row.checkedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}
