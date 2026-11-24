import { getActiveAdminCredential } from '../../models/adminApiCredentials/functions.js';
import type { AdminApiCredentialRecord } from '../../models/adminApiCredentials/schema.js';
import { getGraphApiVersion } from '../../utils/metaApiVersion.js';
import { logger } from '../../utils/logger.js';

export interface InstagramLoginApp { appId: string; appSecret: string }

/** The Instagram product's credentials differ from the parent Facebook App ID. */
export async function getInstagramLoginApp(parent?: AdminApiCredentialRecord | null): Promise<InstagramLoginApp | null> {
  const admin = parent === undefined ? await getActiveAdminCredential('meta_app') : parent;
  const config = admin?.config as { instagramAppId?: string; instagramAppSecret?: string } | null;
  if (config?.instagramAppId && config.instagramAppSecret) {
    return { appId: config.instagramAppId, appSecret: config.instagramAppSecret };
  }
  const legacy = await getActiveAdminCredential('instagram_app');
  const legacyConfig = legacy?.config as { appId?: string; appSecret?: string } | null;
  const appId = legacyConfig?.appId || legacy?.apiKey;
  const appSecret = legacyConfig?.appSecret || legacy?.apiSecret;
  return appId && appSecret ? { appId, appSecret } : null;
}

/** Accept only deployment-owned signing secrets during the login migration. */
export async function getInstagramWebhookSigningSecrets(): Promise<string[]> {
  const [parent, instagram] = await Promise.all([getActiveAdminCredential('meta_app'), getInstagramLoginApp()]);
  return [...new Set([parent?.apiSecret, instagram?.appSecret].filter((secret): secret is string => Boolean(secret)))];
}

type ProviderError = { error?: { message?: string }; error_message?: string; error_type?: string };
async function instagramResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & ProviderError;
  if (!response.ok || data.error || data.error_type) {
    throw new Error(data.error?.message || data.error_message || fallback);
  }
  return data;
}

export interface InstagramLoginProfile {
  id?: string; user_id?: string; username?: string; name?: string; account_type?: string;
  profile_picture_url?: string; followers_count?: number;
}

export async function inspectInstagramLoginToken(accessToken: string, version: string) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const profile = await instagramResponse<InstagramLoginProfile>(await fetch(
    `https://graph.instagram.com/${version}/me?fields=id,user_id,username,name,account_type,profile_picture_url,followers_count`,
    { headers, signal: AbortSignal.timeout(15_000) },
  ), 'Instagram could not verify your account. Reconnect with a Business or Creator account.');
  const accountId = String(profile.user_id || profile.id || '');
  if (!accountId || !profile.username || profile.account_type === 'PERSONAL') {
    throw new Error('Connect an Instagram Business or Creator account. Switch your personal account to a professional account in Instagram first.');
  }
  return { profile, accountId };
}

export async function exchangeInstagramLoginCode(app: InstagramLoginApp, code: string, redirectUri: string, requestedScopes: readonly string[]) {
  type ShortToken = { access_token?: string; user_id?: string | number; permissions?: string | string[] };
  const shortResponse = await instagramResponse<ShortToken & { data?: ShortToken[] }>(await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
    signal: AbortSignal.timeout(15_000),
  }), 'Instagram sign-in could not be completed. Please try again.');
  const tokenGrant = shortResponse.data?.[0] || shortResponse;
  const shortToken = tokenGrant.access_token;
  if (!shortToken) throw new Error('Instagram did not return an access token. Please try connecting again.');
  // Instagram Login returns the actual grants with the short-lived token. Its
  // Instagram User object has no /me/permissions edge (unlike Facebook Login).
  const permissions = tokenGrant.permissions;
  if (!permissions) throw new Error('Instagram did not return the permissions you granted. Please reconnect.');
  const grantedScopes = [...new Set((Array.isArray(permissions) ? permissions : permissions.split(','))
    .map(scope => scope.trim()).filter(Boolean))];
  const declinedScopes = requestedScopes.filter(scope => !grantedScopes.includes(scope));

  // Instagram requires GET for this exchange. This URL stays server-side and is never logged.
  const url = new URL('https://graph.instagram.com/access_token');
  url.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: app.appSecret, access_token: shortToken }).toString();
  const token = await instagramResponse<{ access_token?: string; expires_in?: number }>(await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  }), 'Instagram could not extend your authorization. Please try again.');
  if (!token.access_token) throw new Error('Instagram did not return a long-lived token. Please try again.');
  const identity = await inspectInstagramLoginToken(token.access_token, await getGraphApiVersion());
  return { ...identity, grantedScopes, declinedScopes, accessToken: token.access_token, expiresIn: token.expires_in || 5184000 };
}

export async function subscribeInstagramLoginAccount(accountId: string, accessToken: string, scopes: readonly string[]) {
  const fields = ['messages', 'messaging_postbacks'];
  if (scopes.includes('instagram_business_manage_comments')) fields.push('comments');
  const subscribe = async (subscribed: string[]) => instagramResponse<{ success?: boolean }>(await fetch(
    `https://graph.instagram.com/${await getGraphApiVersion()}/${encodeURIComponent(accountId)}/subscribed_apps`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ subscribed_fields: subscribed.join(',') }), signal: AbortSignal.timeout(15_000),
    },
  ), 'Instagram could not enable incoming messages. Reconnect to retry, or contact support.');
  // messaging_seen carries read receipts (Instagram sends no delivery receipts).
  // Read receipts are a bonus: if Meta refuses the field, for example because
  // the app's webhook doesn't list it, connect with messaging alone.
  let result = await subscribe([...fields, 'messaging_seen']).catch((error: unknown) => {
    logger.warn({ err: error }, '[InstagramLogin] Read receipts unavailable; subscribing to messages only');
    return null;
  });
  if (!result) result = await subscribe(fields);
  if (result.success !== true) throw new Error('Instagram did not confirm the messaging subscription.');
}

/** Refresh a still-valid long-lived Instagram token (at least 24 hours old). */
export async function refreshInstagramLoginToken(accessToken: string) {
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: accessToken }).toString();
  const token = await instagramResponse<{ access_token?: string; expires_in?: number }>(await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  }), 'Instagram authorization could not be refreshed. Please reconnect.');
  if (!token.access_token) throw new Error('Instagram did not return a refreshed token.');
  return { accessToken: token.access_token, expiresIn: token.expires_in || 5184000 };
}
