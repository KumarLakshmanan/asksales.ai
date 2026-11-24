import { getOAuthBaseUrl } from './metaApiVersion.js';

export const INTEGRATION_OAUTH_CALLBACK_PATHS = {
  facebook: '/api/facebook/oauth/callback',
  gmail: '/api/gmail/oauth/callback',
  googleAds: '/api/google-ads/oauth/callback',
  googleSearchConsole: '/api/ai-visibility/gsc/oauth/callback',
  instagram: '/api/instagram/oauth/callback',
  meta: '/api/meta/oauth/callback',
  whatsapp: '/api/whatsapp/oauth/callback',
  youtube: '/api/youtube/oauth/callback',
} as const;

export type IntegrationOAuthProvider = keyof typeof INTEGRATION_OAUTH_CALLBACK_PATHS;

/**
 * Build an OAuth callback from the public URL of the current deployment.
 * Keeping the provider paths here prevents authorization and token-exchange
 * handlers from drifting to different redirect URIs.
 */
export function getIntegrationOAuthCallbackUrl(provider: IntegrationOAuthProvider): string {
  const baseUrl = getOAuthBaseUrl().replace(/\/+$/, '');
  return `${baseUrl}${INTEGRATION_OAUTH_CALLBACK_PATHS[provider]}`;
}
