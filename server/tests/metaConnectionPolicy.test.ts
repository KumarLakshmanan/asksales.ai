import { describe, expect, it } from '@jest/globals';
import { getInstagramLoginScopes, getMetaOAuthScopes, INSTAGRAM_LOGIN_MESSAGING_SCOPES, META_MESSAGING_SCOPES, metaMessagingReadiness } from '../services/integrations/MetaConnectionPolicy.js';
import { boundMetaPageToken } from '../utils/metaCredentialSecrets.js';

const account = { hasAccount: true, selected: true, tokenExpired: false, providerInvalid: false, pageId: 'page-one', webhookSubscribed: true };

describe('self-service Meta connection policy', () => {
  it('preserves the scope requirements of existing Facebook-backed accounts', () => {
    expect(getMetaOAuthScopes('instagram')).toEqual(['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_messages']);
    expect(getMetaOAuthScopes('facebook')).toEqual(['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_messaging']);
  });
  it('connects direct Instagram messaging without a Facebook Page and gates optional direct scopes', () => {
    expect(getInstagramLoginScopes()).toEqual(['instagram_business_basic', 'instagram_business_manage_messages']);
    expect(getInstagramLoginScopes('instagram_content_publish', { instagram_business_content_publish: 'approved' })).toContain('instagram_business_content_publish');
    expect(getInstagramLoginScopes('instagram_manage_insights', { instagram_business_manage_insights: 'testing' }))
      .toContain('instagram_business_manage_insights');
    expect(() => getInstagramLoginScopes('instagram_manage_insights', { instagram_business_manage_insights: 'not_requested' })).toThrow();
    expect(() => getInstagramLoginScopes('instagram_content_publish', { instagram_content_publish: 'approved' })).toThrow();
    const input = { ...account, pageId: null, useInstagramLogin: true, scopes: INSTAGRAM_LOGIN_MESSAGING_SCOPES };
    expect(metaMessagingReadiness('instagram', input).connected).toBe(true);
    expect(metaMessagingReadiness('instagram', { ...input, webhookSubscribed: false }).connected).toBe(false);
    expect(metaMessagingReadiness('instagram', { ...input, scopes: [] }).connected).toBe(false);
    expect(metaMessagingReadiness('instagram', { ...input, useInstagramLogin: false }).connected).toBe(false);
  });
  it('requires a supported and approved additional feature before expanding consent', () => {
    expect(getMetaOAuthScopes('instagram', 'instagram_content_publish', { instagram_content_publish: 'approved' })).toContain('instagram_content_publish');
    expect(() => getMetaOAuthScopes('instagram', 'instagram_content_publish', { instagram_content_publish: 'pending' })).toThrow('not available');
    expect(() => getMetaOAuthScopes('facebook', 'instagram_basic', { instagram_basic: 'approved' })).toThrow();
    expect(() => getMetaOAuthScopes('facebook', 'pages_read_user_content', { pages_read_user_content: 'approved' })).toThrow();
  });
  it.each(['facebook', 'instagram'] as const)('%s cannot claim connected from a token or an unselected account', platform => {
    const scopes = META_MESSAGING_SCOPES[platform];
    expect(metaMessagingReadiness(platform, { ...account, scopes }).connected).toBe(true);
    expect(metaMessagingReadiness(platform, { ...account, scopes, selected: false })).toMatchObject({ connected: false, authorized: true, selectionRequired: true });
    expect(metaMessagingReadiness(platform, { ...account, scopes: [] }).connected).toBe(false);
    expect(metaMessagingReadiness(platform, { ...account, scopes, webhookSubscribed: false }).connected).toBe(false);
    expect(metaMessagingReadiness(platform, { ...account, scopes, tokenExpired: true }).connected).toBe(false);
    expect(metaMessagingReadiness(platform, { ...account, scopes, providerInvalid: true }).connected).toBe(false);
  });
  it('does not turn a Facebook grant into an Instagram messaging connection', () => {
    expect(metaMessagingReadiness('instagram', { ...account, scopes: META_MESSAGING_SCOPES.facebook })).toMatchObject({ connected: false, missingScopes: ['instagram_basic', 'instagram_manage_messages'] });
  });
  it('only uses explicit OAuth Page token bindings and preserves manual App ID semantics', () => {
    expect(boundMetaPageToken({ credentialType: 'oauth', apiKey: 'encrypted-page', sessionData: { pageTokenBound: true } })).toBe('encrypted-page');
    expect(boundMetaPageToken({ credentialType: 'manual', apiKey: 'app-id', sessionData: { pageTokenBound: true } })).toBeNull();
    expect(boundMetaPageToken({ credentialType: 'oauth', apiKey: 'legacy-app-id' })).toBeNull();
  });
});
