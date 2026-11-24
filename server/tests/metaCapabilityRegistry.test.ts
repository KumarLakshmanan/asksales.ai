import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { FACEBOOK_META_SCOPES, INSTAGRAM_META_SCOPES, getMetaCapabilityStatuses, inspectMetaToken, metaAppIdsMatch, normalizeMetaAppReviewPermissions } from '../services/integrations/MetaCapabilityRegistry.js';

describe('Meta capability contracts', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('does not request the scope rejected by Meta OAuth', () => {
    expect(FACEBOOK_META_SCOPES).not.toContain('read_insights');
    expect(INSTAGRAM_META_SCOPES).not.toContain('read_insights');
    expect(FACEBOOK_META_SCOPES).toContain('pages_read_engagement');
    expect(INSTAGRAM_META_SCOPES).toContain('instagram_manage_insights');
  });

  it('keeps Instagram permissions out of the Facebook-only connection flow', () => {
    expect(FACEBOOK_META_SCOPES).toEqual([
      'pages_show_list',
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_messaging',
      'pages_manage_posts',
      'pages_manage_engagement',
      'pages_read_user_content',
    ]);
    expect(FACEBOOK_META_SCOPES.every((scope) => !scope.startsWith('instagram_'))).toBe(true);
    expect(INSTAGRAM_META_SCOPES).toContain('instagram_basic');
  });

  it('accepts only supported permissions and review states', () => {
    expect(normalizeMetaAppReviewPermissions({
      instagram_basic: 'approved',
      instagram_manage_insights: 'pending',
      instagram_business_manage_insights: 'testing',
      pages_read_user_content: 'approved',
      ads_management: 'invented',
    })).toEqual({ instagram_basic: 'approved', instagram_manage_insights: 'pending', instagram_business_manage_insights: 'testing', pages_read_user_content: 'approved' });
  });

  it('uses an already-read review without a database lookup and retains account/grant checks', async () => {
    const input = { permissions: ['pages_messaging'] as const, review: { pages_messaging: 'approved' as const } };
    expect(await getMetaCapabilityStatuses({ ...input, scopes: ['pages_messaging'], accountReady: true })).toEqual([
      expect.objectContaining({ status: 'available', tokenGranted: true, accountReady: true }),
    ]);
    expect(await getMetaCapabilityStatuses({ ...input, scopes: [], accountReady: true })).toEqual([
      expect.objectContaining({ status: 'limited', tokenGranted: false }),
    ]);
    expect(await getMetaCapabilityStatuses({ ...input, scopes: ['pages_messaging'], accountReady: false })).toEqual([
      expect.objectContaining({ status: 'limited', accountReady: false }),
    ]);
    expect(await getMetaCapabilityStatuses({ ...input, review: {}, scopes: ['pages_messaging'], accountReady: true })).toEqual([
      expect.objectContaining({ status: 'blocked', appReviewStatus: 'unknown' }),
    ]);
  });

  it('normalizes provider App IDs without accepting unrelated values', () => {
    expect(metaAppIdsMatch(1373318641307190, '1373318641307190')).toBe(true);
    expect(metaAppIdsMatch(' 1373318641307190 ', '1373318641307190')).toBe(true);
    expect(metaAppIdsMatch('different-app', '1373318641307190')).toBe(false);
    expect(metaAppIdsMatch(undefined, '1373318641307190')).toBe(false);
  });

  it('stores provider-confirmed grants and declined permissions instead of requested scopes', async () => {
    const responses = [
      new Response(JSON.stringify({ data: { is_valid: true, app_id: 'app-1', scopes: ['pages_show_list'], granular_scopes: [{ scope: 'pages_show_list', target_ids: ['12345'] }] } }), {
        status: 200,
        headers: { 'x-fb-trace-id': 'trace-debug' },
      }),
      new Response(JSON.stringify({ data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'pages_messaging', status: 'declined' },
      ] }), { status: 200, headers: { 'x-fb-trace-id': 'trace-permissions' } }),
    ];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!);
    await expect(inspectMetaToken({ accessToken: 'token', appId: 'app-1', appSecret: 'secret', apiVersion: 'v25.0' })).resolves.toEqual({
      valid: true,
      grantedScopes: ['pages_show_list'],
      declinedScopes: ['pages_messaging'],
      providerRequestIds: ['trace-debug', 'trace-permissions'],
      granularScopes: [{ scope: 'pages_show_list', targetIds: ['12345'] }],
    });
    const debugCall = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(String(debugCall[0])).toContain('/debug_token?input_token=token');
    expect(debugCall[1]).not.toHaveProperty('method', 'POST');
    expect(debugCall[1]).not.toHaveProperty('body');
  });

  it('accepts a numeric app_id returned by Meta for a configured string App ID', async () => {
    const responses = [
      new Response(JSON.stringify({ data: { is_valid: true, app_id: 1373318641307190, scopes: ['pages_show_list'] } }), {
        status: 200,
        headers: { 'x-fb-trace-id': 'trace-debug' },
      }),
      new Response(JSON.stringify({ data: [
        { permission: 'pages_show_list', status: 'granted' },
      ] }), { status: 200, headers: { 'x-fb-trace-id': 'trace-permissions' } }),
    ];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!);

    await expect(inspectMetaToken({
      accessToken: 'token',
      appId: '1373318641307190',
      appSecret: 'secret',
      apiVersion: 'v25.0',
    })).resolves.toMatchObject({
      valid: true,
      grantedScopes: ['pages_show_list'],
      declinedScopes: [],
    });
  });
});
