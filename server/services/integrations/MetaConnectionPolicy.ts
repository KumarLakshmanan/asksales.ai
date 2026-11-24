import type { MetaAppReviewStatus, MetaPermission } from './MetaCapabilityRegistry.js';

export const INSTAGRAM_LOGIN_MESSAGING_SCOPES: MetaPermission[] = ['instagram_business_basic', 'instagram_business_manage_messages'];

export function getInstagramLoginScopes(feature?: string, review: Partial<Record<MetaPermission, MetaAppReviewStatus>> = {}): MetaPermission[] {
  const aliases: Record<string, MetaPermission> = {
    instagram_content_publish: 'instagram_business_content_publish',
    instagram_manage_comments: 'instagram_business_manage_comments',
    instagram_manage_insights: 'instagram_business_manage_insights',
  };
  if (!feature) return [...INSTAGRAM_LOGIN_MESSAGING_SCOPES];
  const permission = aliases[feature] || feature as MetaPermission;
  if (!Object.values(aliases).includes(permission) || !['approved', 'not_required', 'testing'].includes(review[permission] || 'unknown')) {
    throw new Error('This additional Instagram feature is not available yet. Connect messaging first, or contact support.');
  }
  return [...INSTAGRAM_LOGIN_MESSAGING_SCOPES, permission];
}

/** DM-first onboarding. Additional capabilities have their own consent action. */
export const META_MESSAGING_SCOPES: Record<'facebook' | 'instagram', MetaPermission[]> = {
  facebook: ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_messaging'],
  instagram: ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_messages'],
};

const OPTIONAL_SCOPES: Record<'facebook' | 'instagram', MetaPermission[]> = {
  facebook: ['pages_manage_posts', 'pages_manage_engagement'],
  instagram: ['instagram_manage_insights', 'instagram_content_publish', 'instagram_manage_comments'],
};

export function getMetaOAuthScopes(
  platform: 'facebook' | 'instagram',
  feature?: string,
  review: Partial<Record<MetaPermission, MetaAppReviewStatus>> = {},
): MetaPermission[] {
  const core = META_MESSAGING_SCOPES[platform];
  if (!feature) return [...core];
  if (!OPTIONAL_SCOPES[platform].includes(feature as MetaPermission)
    || !['approved', 'not_required'].includes(review[feature as MetaPermission] || 'unknown')) {
    throw new Error('This additional feature is not available yet. Connect messaging first, or contact support.');
  }
  return [...core, feature as MetaPermission];
}

export function metaMessagingReadiness(platform: 'facebook' | 'instagram', input: {
  hasAccount: boolean; selected: boolean; tokenExpired: boolean; providerInvalid: boolean;
  pageId?: string | null; webhookSubscribed?: boolean; scopes?: readonly string[] | null;
  useInstagramLogin?: boolean;
}) {
  const authorized = input.hasAccount && !input.tokenExpired && !input.providerInvalid;
  const direct = platform === 'instagram' && input.useInstagramLogin === true;
  const missingScopes = (direct ? INSTAGRAM_LOGIN_MESSAGING_SCOPES : META_MESSAGING_SCOPES[platform]).filter(scope => !input.scopes?.includes(scope));
  return {
    authorized,
    selectionRequired: authorized && !input.selected,
    missingScopes,
    connected: authorized && input.selected && Boolean((direct || input.pageId) && input.webhookSubscribed) && missingScopes.length === 0,
  };
}
