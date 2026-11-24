import { getActiveAdminCredential } from '../../models/adminApiCredentials/functions.js';

export type MetaPermission =
  | 'instagram_business_basic'
  | 'instagram_business_manage_messages'
  | 'instagram_business_manage_comments'
  | 'instagram_business_content_publish'
  | 'instagram_business_manage_insights'
  | 'instagram_basic'
  | 'instagram_manage_insights'
  | 'pages_show_list'
  | 'pages_manage_metadata'
  | 'pages_read_engagement'
  | 'pages_manage_engagement'
  | 'pages_read_user_content'
  | 'pages_messaging'
  | 'pages_manage_posts'
  | 'instagram_manage_messages'
  | 'instagram_manage_comments'
  | 'instagram_content_publish'
  | 'ads_read'
  | 'ads_management'
  | 'whatsapp_business_messaging'
  | 'whatsapp_business_management';

export type MetaAppReviewStatus = 'approved' | 'testing' | 'pending' | 'rejected' | 'not_requested' | 'not_required' | 'unknown';

export interface MetaCapabilityDefinition {
  scope: MetaPermission;
  feature: string;
  graphOperation: string;
  uiRoute: string;
  readinessRequirements: string[];
}

export interface MetaCapabilityStatus {
  scope: MetaPermission;
  feature: string;
  tokenGranted: boolean;
  appReviewStatus: MetaAppReviewStatus;
  accountReady: boolean;
  status: 'available' | 'limited' | 'blocked';
  reason: string | null;
}

export const META_CAPABILITY_REGISTRY: readonly MetaCapabilityDefinition[] = [
  { scope: 'instagram_business_basic', feature: 'Instagram professional account', graphOperation: 'GET graph.instagram.com/me', uiRoute: '/dashboard/integrations/instagram', readinessRequirements: ['Instagram Business or Creator account'] },
  { scope: 'instagram_business_manage_messages', feature: 'Instagram messaging', graphOperation: 'POST graph.instagram.com/{ig-user-id}/messages', uiRoute: '/dashboard/outreach/instagram', readinessRequirements: ['selected Instagram account', 'webhook subscription'] },
  { scope: 'instagram_business_manage_comments', feature: 'Instagram comment management', graphOperation: 'POST graph.instagram.com/{comment-id}/replies', uiRoute: '/dashboard/outreach/instagram', readinessRequirements: ['selected Instagram account', 'explicit reply approval'] },
  { scope: 'instagram_business_content_publish', feature: 'Instagram publishing', graphOperation: 'POST graph.instagram.com/{ig-user-id}/media_publish', uiRoute: '/dashboard/saved-templates/social/publish', readinessRequirements: ['selected Instagram account'] },
  { scope: 'instagram_business_manage_insights', feature: 'Instagram organic analytics', graphOperation: 'GET graph.instagram.com/{ig-user-id}/insights', uiRoute: '/dashboard/marketing/analytics', readinessRequirements: ['selected Instagram account'] },
  { scope: 'pages_manage_engagement', feature: 'Facebook comment replies and moderation', graphOperation: 'POST /{comment-id}/comments or POST /{comment-id}', uiRoute: '/dashboard/marketing/analytics?tab=content', readinessRequirements: ['selected Page', 'Page access token', 'Meta App Review approval', 'explicit action confirmation'] },
  { scope: 'pages_read_user_content', feature: 'Facebook visitor comments and tagged content', graphOperation: 'GET /{post-id}/comments', uiRoute: '/dashboard/marketing/analytics?tab=listening', readinessRequirements: ['selected Page', 'Page access token', 'Meta App Review approval'] },
  { scope: 'pages_read_engagement', feature: 'Facebook organic analytics', graphOperation: 'GET /{page-id}/insights', uiRoute: '/dashboard/marketing/analytics', readinessRequirements: ['selected Page', 'Page access token', 'pages_read_engagement'] },
  { scope: 'pages_show_list', feature: 'Facebook Page selection', graphOperation: 'GET /me/accounts', uiRoute: '/dashboard/integrations/facebook', readinessRequirements: ['valid user token'] },
  { scope: 'pages_manage_metadata', feature: 'Facebook Page webhooks', graphOperation: 'POST /{page-id}/subscribed_apps', uiRoute: '/dashboard/integrations/facebook', readinessRequirements: ['selected Page', 'Page access token', 'webhook subscription'] },
  { scope: 'pages_read_engagement', feature: 'Facebook Page identity and engagement', graphOperation: 'GET /{page-id}', uiRoute: '/dashboard/integrations/facebook', readinessRequirements: ['selected Page'] },
  { scope: 'pages_messaging', feature: 'Facebook Messenger', graphOperation: 'POST /{page-id}/messages', uiRoute: '/dashboard/outreach/facebook', readinessRequirements: ['selected Page', 'webhook subscription'] },
  { scope: 'pages_manage_posts', feature: 'Facebook publishing', graphOperation: 'POST /{page-id}/feed', uiRoute: '/dashboard/saved-templates/social/publish', readinessRequirements: ['selected Page'] },
  { scope: 'instagram_basic', feature: 'Linked Instagram professional account', graphOperation: 'GET /{page-id}?fields=instagram_business_account', uiRoute: '/dashboard/integrations/instagram', readinessRequirements: ['selected Facebook Page', 'linked professional account'] },
  { scope: 'instagram_manage_insights', feature: 'Instagram organic analytics', graphOperation: 'GET /{ig-user-id}/insights', uiRoute: '/dashboard/marketing/analytics', readinessRequirements: ['selected linked Instagram professional account'] },
  { scope: 'instagram_manage_messages', feature: 'Instagram messaging', graphOperation: 'POST /{page-id}/messages', uiRoute: '/dashboard/outreach/instagram', readinessRequirements: ['selected linked Instagram account', 'selected Facebook Page', 'webhook subscription'] },
  { scope: 'instagram_manage_comments', feature: 'Instagram comment management', graphOperation: 'POST /{comment-id}/replies', uiRoute: '/dashboard/outreach/instagram', readinessRequirements: ['selected linked Instagram account', 'explicit reply approval'] },
  { scope: 'instagram_content_publish', feature: 'Instagram publishing', graphOperation: 'POST /{ig-user-id}/media_publish', uiRoute: '/dashboard/saved-templates/social/publish', readinessRequirements: ['selected linked Instagram account'] },
  { scope: 'ads_read', feature: 'Meta Ads reporting', graphOperation: 'GET /act_{ad-account-id}/campaigns', uiRoute: '/dashboard/integrations/meta', readinessRequirements: ['selected ad account'] },
  { scope: 'ads_management', feature: 'Meta Ads creation and activation', graphOperation: 'POST /act_{ad-account-id}/campaigns', uiRoute: '/dashboard/integrations/meta', readinessRequirements: ['selected ad account', 'selected Facebook Page', 'provider mutation gates'] },
  { scope: 'whatsapp_business_messaging', feature: 'WhatsApp messaging', graphOperation: 'POST /{phone-number-id}/messages', uiRoute: '/dashboard/outreach/whatsapp', readinessRequirements: ['selected phone number'] },
  { scope: 'whatsapp_business_management', feature: 'WhatsApp Business account management', graphOperation: 'GET /{waba-id}', uiRoute: '/dashboard/integrations/whatsapp', readinessRequirements: ['selected WhatsApp Business account'] },
] as const;

const ACTIVE_SCOPES = new Set<MetaPermission>(META_CAPABILITY_REGISTRY.map((entry) => entry.scope));

export function isMetaPermission(value: string): value is MetaPermission {
  return ACTIVE_SCOPES.has(value as MetaPermission);
}

export function normalizeMetaAppReviewPermissions(value: unknown): Partial<Record<MetaPermission, MetaAppReviewStatus>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = new Set<MetaAppReviewStatus>(['approved', 'testing', 'pending', 'rejected', 'not_requested', 'not_required', 'unknown']);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([scope, status]) => isMetaPermission(scope) && typeof status === 'string' && allowed.has(status as MetaAppReviewStatus))) as Partial<Record<MetaPermission, MetaAppReviewStatus>>;
}

export async function getMetaAppReviewPermissions(): Promise<Partial<Record<MetaPermission, MetaAppReviewStatus>>> {
  const credential = await getActiveAdminCredential('meta_app');
  const config = credential?.config as Record<string, unknown> | null;
  return normalizeMetaAppReviewPermissions(config?.appReviewPermissions);
}

export async function getMetaCapabilityStatuses(input: {
  scopes?: readonly string[] | null;
  accountReady: boolean;
  permissions?: readonly MetaPermission[];
  /** Reuse the platform setup already read by a status handler. */
  review?: Partial<Record<MetaPermission, MetaAppReviewStatus>>;
}): Promise<MetaCapabilityStatus[]> {
  const granted = new Set((input.scopes || []).filter((scope): scope is string => typeof scope === 'string'));
  const review = input.review ?? await getMetaAppReviewPermissions();
  const wanted = input.permissions ? new Set(input.permissions) : null;
  return META_CAPABILITY_REGISTRY
    .filter((definition) => !wanted || wanted.has(definition.scope))
    .map((definition) => {
      const tokenGranted = granted.has(definition.scope);
      const appReviewStatus = review[definition.scope] || 'unknown';
      const reviewReady = appReviewStatus === 'approved' || appReviewStatus === 'not_required';
      const status: MetaCapabilityStatus['status'] = reviewReady && tokenGranted && input.accountReady
        ? 'available'
        : appReviewStatus === 'rejected' || appReviewStatus === 'not_requested' || appReviewStatus === 'unknown'
          ? 'blocked'
          : 'limited';
      let reason: string | null = null;
      if (!reviewReady) reason = appReviewStatus === 'rejected'
        ? 'Meta App Review has not approved this capability.'
        : appReviewStatus === 'testing'
          ? 'This permission is available to app testers; customer access still requires Meta App Review.'
          : appReviewStatus === 'pending'
          ? 'Meta App Review is pending for this capability.'
          : 'Meta App Review status has not been confirmed by an administrator.';
      else if (!tokenGranted) reason = 'The connected token did not grant this permission.';
      else if (!input.accountReady) reason = `Account readiness is incomplete: ${definition.readinessRequirements.join(', ')}.`;
      return {
        scope: definition.scope,
        feature: definition.feature,
        tokenGranted,
        appReviewStatus,
        accountReady: input.accountReady,
        status,
        reason,
      };
    });
}

export const FACEBOOK_META_SCOPES: MetaPermission[] = [
  'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_messaging', 'pages_manage_posts', 'pages_manage_engagement', 'pages_read_user_content',
];

export const INSTAGRAM_META_SCOPES: MetaPermission[] = [
  'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_messaging', 'pages_manage_posts',
  'instagram_basic', 'instagram_manage_insights', 'instagram_manage_messages', 'instagram_manage_comments', 'instagram_content_publish',
];

export const META_ADS_SCOPES: MetaPermission[] = ['ads_read', 'ads_management', 'pages_show_list'];

export const INSTAGRAM_LOGIN_SCOPES: MetaPermission[] = [
  'instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments',
  'instagram_business_content_publish', 'instagram_business_manage_insights',
];

export interface MetaTokenInspection {
  valid: boolean;
  grantedScopes: string[];
  declinedScopes: string[];
  providerRequestIds: string[];
  granularScopes: Array<{ scope: string; targetIds: string[] }>;
}

/** Meta may serialize app_id as either a JSON string or number. */
export function metaAppIdsMatch(providerAppId: unknown, configuredAppId: string): boolean {
  return (typeof providerAppId === 'string' || typeof providerAppId === 'number')
    && String(providerAppId).trim() === configuredAppId.trim();
}

/**
 * Reads the provider's view of a token. Requested scopes are deliberately not
 * accepted as evidence because consent can be partial or later revoked.
 */
export async function inspectMetaToken(input: {
  accessToken: string;
  appId: string;
  appSecret: string;
  apiVersion: string;
}): Promise<MetaTokenInspection> {
  const requestIds: string[] = [];
  const debugUrl = new URL(`https://graph.facebook.com/${input.apiVersion}/debug_token`);
  debugUrl.searchParams.set('input_token', input.accessToken);
  const debugResponse = await fetch(debugUrl, {
    headers: {
      authorization: `Bearer ${input.appId}|${input.appSecret}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const debug = await debugResponse.json().catch(() => ({})) as { data?: { is_valid?: boolean; app_id?: string | number; scopes?: string[]; granular_scopes?: Array<{ scope?: string; target_ids?: unknown }> } };
  const debugRequestId = debugResponse.headers.get('x-fb-trace-id');
  if (debugRequestId) requestIds.push(debugRequestId);
  // Meta's debug_token response has represented app_id as both a JSON string
  // and a JSON number. Normalize the provider value before comparing it with
  // the configured App ID so a valid token is not rejected on type alone.
  const appIdMatches = metaAppIdsMatch(debug.data?.app_id, input.appId);
  const valid = Boolean(debugResponse.ok && debug.data?.is_valid && appIdMatches);
  if (!valid) return { valid: false, grantedScopes: [], declinedScopes: [], providerRequestIds: requestIds, granularScopes: [] };

  const permissionResponse = await fetch(`https://graph.facebook.com/${input.apiVersion}/me/permissions`, {
    headers: { authorization: `Bearer ${input.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const permissions = await permissionResponse.json().catch(() => ({})) as { data?: Array<{ permission?: string; status?: string }> };
  const permissionRequestId = permissionResponse.headers.get('x-fb-trace-id');
  if (permissionRequestId) requestIds.push(permissionRequestId);
  const providerPermissions = Array.isArray(permissions.data) ? permissions.data : [];
  const grantedScopes = providerPermissions.length
    ? providerPermissions.filter((entry) => entry.status === 'granted' && entry.permission).map((entry) => entry.permission!)
    : (debug.data?.scopes || []);
  const declinedScopes = providerPermissions
    .filter((entry) => entry.status === 'declined' && entry.permission)
    .map((entry) => entry.permission!);
  const granularScopes = (debug.data?.granular_scopes || [])
    .filter((entry): entry is { scope: string; target_ids?: unknown } => typeof entry.scope === 'string')
    .map((entry) => ({
      scope: entry.scope,
      targetIds: Array.isArray(entry.target_ids)
        ? entry.target_ids.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id))
        : [],
    }));
  return {
    valid,
    grantedScopes: [...new Set(grantedScopes)],
    declinedScopes: [...new Set(declinedScopes)],
    providerRequestIds: requestIds,
    granularScopes,
  };
}
