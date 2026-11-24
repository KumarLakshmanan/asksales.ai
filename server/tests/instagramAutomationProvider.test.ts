import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
// Transport tests assume readiness; socialCustomerDeliveryBoundary exercises the real gate.
jest.unstable_mockModule('../services/assistants/CustomerDeliveryGate.js', () => ({
  assertCustomerDeliveryReady: async () => ({}), assertCustomerDeliveryRuntime: () => {},
  deliverySetupFailure: () => undefined, CustomerDeliverySetupError: class extends Error {},
}));
import {
  emptyInstagramMessage,
  matchInstagramRule,
  newInstagramRule,
  renderInstagramText,
  instagramTextBytes,
  instagramFollowPrompt,
  instagramFollowRetryMessage,
  sortInstagramRules,
  validateInstagramMessage,
  validateInstagramProfile,
  validateInstagramRule,
  type InstagramMessage,
  type InstagramProfileConfig,
  type InstagramRuleDefinition,
} from '../../shared/instagramAutomations.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import type { InstagramAccountContext } from '../services/instagramAccountSelectionService.js';

const resolveAccount = jest.fn<(...args: unknown[]) => Promise<InstagramAccountContext | null>>();
const capabilityStatuses = jest.fn<(...args: any[]) => Promise<any[]>>();
const decryptSecret = jest.fn((value: unknown) => value as string | null);
const boundPageToken = jest.fn(
  (credential: any) => credential.sessionData?.pageAccessToken ?? null
);

jest.unstable_mockModule('../services/instagramAccountSelectionService.js', () => ({
  resolveInstagramAccountContext: resolveAccount,
}));
jest.unstable_mockModule('../services/integrations/MetaCapabilityRegistry.js', () => ({
  getMetaCapabilityStatuses: capabilityStatuses,
}));
jest.unstable_mockModule('../utils/metaCredentialSecrets.js', () => ({
  decryptMetaSecret: decryptSecret,
  boundMetaPageToken: boundPageToken,
}));
jest.unstable_mockModule('../utils/metaApiVersion.js', () => ({
  getGraphApiVersion: async () => 'v24.0',
}));

const {
  InstagramAutomationProvider,
  instagramAutomationReadiness,
  instagramAutomationsEnabled,
  instagramMessagePayload,
  profileProviderValue,
  requireInstagramAutomationAccount,
} = await import('../services/instagramAutomations/InstagramAutomationProvider.js');

const accountId = '17841450189502002';
const messageScope = 'instagram_business_manage_messages';
const commentScope = 'instagram_business_manage_comments';
const basicScope = 'instagram_business_basic';
const businessScope = { userId: 42, businessProfileId: 9 };
const account = (
  changes: Record<string, unknown> = {},
  connection: Record<string, unknown> = {}
): InstagramAccountContext =>
  ({
    credential: {
      id: 12,
      userId: 42,
      businessProfileId: 9,
      accountIdentifier: accountId,
      credentialType: 'oauth',
      accessToken: 'test-account-token',
      sessionData: { useInstagramLogin: true },
      grantedScopes: [basicScope, messageScope, commentScope],
      ...changes,
    },
    connection: {
      id: 7,
      userId: 42,
      instagramAccountId: accountId,
      webhookSubscribed: true,
      ...connection,
    },
  }) as unknown as InstagramAccountContext;
const textMessage = (text = 'Your requested content'): InstagramMessage => ({
  ...emptyInstagramMessage(),
  text,
});
const rule = (changes: Partial<InstagramRuleDefinition> = {}): InstagramRuleDefinition => ({
  ...newInstagramRule('comment_dm'),
  name: 'Send guide',
  message: textMessage(),
  trigger: {
    keywords: ['guide'],
    negativeKeywords: [],
    matchMode: 'contains',
    scope: 'all',
    mediaIds: [],
  },
  ...changes,
});
const menu = (): InstagramProfileConfig => ({
  locales: [
    {
      locale: 'default',
      questions: [],
      items: [
        {
          id: 'pricing',
          title: 'Pricing',
          type: 'action',
          url: '',
          payload: 'VIEW_PRICING',
          response: textMessage('Our prices'),
        },
        {
          id: 'website',
          title: 'Website',
          type: 'link',
          url: 'https://example.com',
          payload: '',
          response: emptyInstagramMessage(),
        },
      ],
    },
  ],
});
const icebreakers = (): InstagramProfileConfig => ({
  locales: [
    {
      locale: 'default',
      questions: [{ id: 'hours', question: 'What are your hours?' }],
      items: [],
    },
  ],
});
const subscription = (fields = ['messages', 'messaging_postbacks', 'comments']) =>
  Response.json({ data: [{ subscribed_fields: fields }] });
const fetchedBody = (index = 0) =>
  JSON.parse(String(jest.mocked(globalThis.fetch).mock.calls[index][1]?.body));
const fetchedUrl = (index = 0) =>
  new URL(String(jest.mocked(globalThis.fetch).mock.calls[index][0]));
const originalEnabled = process.env.INSTAGRAM_AUTOMATIONS_ENABLED;
const originalTestAccounts = process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INSTAGRAM_AUTOMATIONS_ENABLED = 'true';
  delete process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS;
  resolveAccount.mockResolvedValue(account());
  capabilityStatuses.mockImplementation(async ({ scopes, accountReady, permissions }) =>
    permissions.map((scope: string) => ({
      scope,
      tokenGranted: scopes.includes(scope),
      accountReady,
      status: 'available',
      appReviewStatus: 'approved',
      feature: scope,
    }))
  );
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ message_id: 'message-1', recipient_id: 'recipient-1' }));
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalEnabled === undefined) delete process.env.INSTAGRAM_AUTOMATIONS_ENABLED;
  else process.env.INSTAGRAM_AUTOMATIONS_ENABLED = originalEnabled;
  if (originalTestAccounts === undefined) delete process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS;
  else process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS = originalTestAccounts;
});

describe('Instagram automation account ownership', () => {
  it('resolves the explicitly requested account within its business profile', async () => {
    const result = await withBusinessScope(businessScope, () =>
      requireInstagramAutomationAccount(42, accountId)
    );
    expect(result.credential.accountIdentifier).toBe(accountId);
    expect(resolveAccount).toHaveBeenCalledWith(42, { accountIdentifier: accountId });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['not-an-account', '../accounts', '', '1'.repeat(256)])(
    'rejects malformed account identifiers before lookup: %s',
    async (id) => {
      await expect(
        withBusinessScope(businessScope, () => requireInstagramAutomationAccount(42, id))
      ).rejects.toMatchObject({ status: 404 });
      expect(resolveAccount).not.toHaveBeenCalled();
    }
  );

  it('rejects an owner different from the current business scope', async () => {
    await expect(
      withBusinessScope(businessScope, () => requireInstagramAutomationAccount(43, accountId))
    ).rejects.toMatchObject({ status: 404 });
    expect(resolveAccount).not.toHaveBeenCalled();
  });

  it.each([{ businessProfileId: 10 }, { userId: 43 }])(
    'rejects credentials outside the requested ownership boundary: %j',
    async (changes) => {
      resolveAccount.mockResolvedValueOnce(account(changes));
      await expect(
        withBusinessScope(businessScope, () => requireInstagramAutomationAccount(42, accountId))
      ).rejects.toMatchObject({ status: 404 });
    }
  );

  it('rejects missing accounts and missing business scope', async () => {
    resolveAccount.mockResolvedValueOnce(null);
    await expect(
      withBusinessScope(businessScope, () => requireInstagramAutomationAccount(42, accountId))
    ).rejects.toMatchObject({ status: 404 });
    await expect(requireInstagramAutomationAccount(42, accountId)).rejects.toThrow(
      'business profile'
    );
  });
});

describe('Instagram automation provider readiness', () => {
  it('keeps saved authorization distinct from disabled automation rollout', async () => {
    process.env.INSTAGRAM_AUTOMATIONS_ENABLED = 'false';
    const result = await instagramAutomationReadiness(account());
    expect(result).toMatchObject({ authorized: true, enabled: false, messages: false, comments: false });
    expect(result.checks?.find(check => check.id === 'connection')).toMatchObject({ ready: true });
  });
  it.each(['APP_REVIEW', 'WEBHOOK_SUBSCRIPTION'])('does not report a %s setup blocker as lost authorization', async error => {
    const result = await instagramAutomationReadiness(account({ readinessErrorCode: error }));
    expect(result).toMatchObject({ authorized: true, messages: false, comments: false });
    expect(result.reasons).not.toContain('Reconnect this Instagram account before publishing or activating automations.');
  });
  it('marks authorization unavailable when a current provider check rejects the token', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 }));
    const result = await new InstagramAutomationProvider(account()).connectionHealth();
    expect(result).toMatchObject({ authorized: false, messages: false, comments: false });
    expect(result.checks?.find(check => check.id === 'connection')).toMatchObject({ ready: false, action: 'reconnect' });
  });
  it('requires the basic account permission before enabling any direct-login operation', async () => {
    expect(await instagramAutomationReadiness(account({ grantedScopes: [messageScope, commentScope] }))).toMatchObject({ messages: false, comments: false, profile: false });
    await expect(new InstagramAutomationProvider(account({ grantedScopes: [messageScope, commentScope] })).assertReady('profile')).rejects.toMatchObject({ status: 409 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['instagram_basic', 'pages_read_engagement', 'pages_manage_metadata'])('requires the Facebook-backed dependency %s', async missing => {
    const scopes = ['instagram_basic', 'pages_read_engagement', 'pages_manage_metadata', 'instagram_manage_messages', 'instagram_manage_comments'];
    expect(await instagramAutomationReadiness(account({ sessionData: { pageId: 'page-9' }, grantedScopes: scopes.filter(scope => scope !== missing) }))).toMatchObject({ messages: false, comments: false, profile: false });
  });
  it('requires rollout approval and supports an exact account allowlist', async () => {
    process.env.INSTAGRAM_AUTOMATIONS_ENABLED = 'false';
    expect(await instagramAutomationReadiness(account())).toMatchObject({
      enabled: false,
      messages: false,
      comments: false,
      profile: false,
    });
    process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS = ` other, ${accountId} `;
    expect(instagramAutomationsEnabled(accountId)).toBe(true);
    expect(instagramAutomationsEnabled(accountId.slice(0, -1))).toBe(false);
    expect(await instagramAutomationReadiness(account())).toMatchObject({
      enabled: true,
      messages: true,
      comments: true,
    });
  });

  it('requires each granted permission independently', async () => {
    expect(
      await instagramAutomationReadiness(account({ grantedScopes: [basicScope, messageScope] }))
    ).toMatchObject({ messages: true, comments: false });
    expect(
      await instagramAutomationReadiness(account({ grantedScopes: [basicScope, commentScope] }))
    ).toMatchObject({ messages: false, comments: true, profile: false });
  });

  it.each([
    [{ tokenExpiry: new Date(0) }, {}],
    [{ readinessErrorCode: 'TOKEN_EXPIRED' }, {}],
    [{ accessToken: null }, {}],
    [{}, { webhookSubscribed: false }],
  ])(
    'requires usable credentials and a saved webhook subscription',
    async (credential, connection) => {
      expect(await instagramAutomationReadiness(account(credential, connection))).toMatchObject({
        messages: false,
        comments: false,
        profile: false,
      });
    }
  );

  it('requires approved app capability outside the explicit test allowlist', async () => {
    capabilityStatuses.mockImplementation(async ({ accountReady, permissions }) =>
      permissions.map((scope: string) => ({
        scope,
        tokenGranted: true,
        accountReady,
        status: 'needs_app_review',
        appReviewStatus: 'testing',
        feature: scope,
      }))
    );
    expect(await instagramAutomationReadiness(account())).toMatchObject({
      messages: false,
      comments: false,
    });
    process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS = accountId;
    expect(await instagramAutomationReadiness(account())).toMatchObject({
      messages: true,
      comments: true,
    });
  });

  it('does not let an allowlisted testing capability bypass missing grants or account readiness', async () => {
    process.env.INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS = accountId;
    capabilityStatuses.mockResolvedValueOnce([
      {
        scope: messageScope,
        tokenGranted: false,
        accountReady: true,
        status: 'testing',
        appReviewStatus: 'testing',
      },
      {
        scope: commentScope,
        tokenGranted: true,
        accountReady: false,
        status: 'testing',
        appReviewStatus: 'testing',
      },
    ]);
    expect(await instagramAutomationReadiness(account())).toMatchObject({
      messages: false,
      comments: false,
    });
  });

  it('uses the correct permission family for Facebook-backed credentials', async () => {
    await instagramAutomationReadiness(
      account({
        sessionData: { pageId: 'page-9' },
        grantedScopes: ['instagram_basic', 'pages_read_engagement', 'pages_manage_metadata', 'instagram_manage_messages', 'instagram_manage_comments'],
      })
    );
    expect(capabilityStatuses).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: ['instagram_manage_messages', 'instagram_manage_comments', 'instagram_basic', 'pages_read_engagement', 'pages_manage_metadata'],
      })
    );
  });

  it('checks actual required subscription fields before allowing comment-to-DM activation', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(subscription(['messages', 'comments']));
    await expect(
      new InstagramAutomationProvider(account()).assertReady('comment_dm')
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('messaging_postbacks'),
    });
    expect(fetchedUrl().pathname).toBe(`/v24.0/${accountId}/subscribed_apps`);
  });

  it('only requires comment subscription for public reply automations', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(subscription(['comments']));
    await expect(
      new InstagramAutomationProvider(account({ grantedScopes: [basicScope, commentScope] })).assertReady(
        'comments'
      )
    ).resolves.toBeUndefined();
  });

  it('does not call Meta when local readiness fails', async () => {
    await expect(
      new InstagramAutomationProvider(account({ grantedScopes: [] })).assertReady('comment_dm')
    ).rejects.toMatchObject({ status: 409 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('Instagram automation delivery and provider outcomes', () => {
  it.each([{}, { owner: { id: 'other-account' } }])('rejects an unconfirmed media owner during Reel classification: %j', async result => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json(result));
    await expect(new InstagramAutomationProvider(account()).mediaIsReel('media-1')).rejects.toMatchObject({ status: 400 });
  });
  it('sends a private reply to the comment ID with the bound direct-login account token', async () => {
    await expect(
      new InstagramAutomationProvider(account()).sendPrivateReply('comment-42', 'Requested guide')
    ).resolves.toEqual({ messageId: 'message-1', recipientId: 'recipient-1' });
    expect(fetchedUrl().origin + fetchedUrl().pathname).toBe(
      `https://graph.instagram.com/v24.0/${accountId}/messages`
    );
    expect(fetchedUrl().searchParams.has('access_token')).toBe(false);
    expect(fetchedBody()).toEqual({
      recipient: { comment_id: 'comment-42' },
      message: { text: 'Requested guide' },
    });
    expect(jest.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer test-account-token' },
    });
  });

  it('routes Facebook-backed sends through the bound Page token and Page ID', async () => {
    const provider = new InstagramAutomationProvider(
      account(
        { sessionData: { pageId: 'page-9', pageAccessToken: 'bound-page-token' } },
        { pageId: 'page-9', pageAccessToken: 'other-page-token' }
      )
    );
    await provider.sendMessage('recipient-1', textMessage('Hello {{name}}'), { name: 'Asha' });
    expect(fetchedUrl().origin + fetchedUrl().pathname).toBe(
      'https://graph.facebook.com/v24.0/page-9/messages'
    );
    expect(fetchedBody()).toEqual({
      recipient: { id: 'recipient-1' },
      message: { text: 'Hello Asha' },
    });
    expect(jest.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer bound-page-token' },
    });
  });

  it('addresses Facebook-backed private replies to the Instagram account with the bound Page token', async () => {
    const provider = new InstagramAutomationProvider(
      account({ sessionData: { pageId: 'page-9', pageAccessToken: 'bound-page-token' } }, { pageId: 'page-9' })
    );
    await provider.sendPrivateReply('comment-42', 'Requested guide');
    expect(fetchedUrl().pathname).toBe(`/v24.0/${accountId}/messages`);
    expect(fetchedBody().recipient).toEqual({ comment_id: 'comment-42' });
    expect(jest.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer bound-page-token' } });
  });

  it('rejects oversized private replies and expanded DM responses before any provider write', async () => {
    const provider = new InstagramAutomationProvider(account());
    await expect(provider.sendPrivateReply('comment-42', '😀'.repeat(251))).rejects.toMatchObject({ status: 400 });
    await expect(provider.sendMessage('recipient', textMessage('Hi {{name}}'), { name: '😀'.repeat(250) })).rejects.toMatchObject({ status: 400 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [190, 'authorization expired'],
    [200, 'not authorized'],
    [10, 'not authorized'],
    [100, 'code 100'],
  ])(
    'treats explicit provider rejection code %s as a confirmed failure with sanitized details',
    async (code, detail) => {
      jest
        .mocked(globalThis.fetch)
        .mockResolvedValueOnce(
          Response.json(
            { error: { code, message: 'SECRET-TOKEN and private customer content' } },
            { status: 400 }
          )
        );
      const error = await new InstagramAutomationProvider(account())
        .sendPrivateReply('comment-1', 'private')
        .catch((e) => e);
      expect(error).toMatchObject({
        status: 502,
        uncertain: false,
        providerCode: code,
        message: expect.stringContaining(detail),
      });
      expect(error.message).not.toMatch(/SECRET-TOKEN|private customer/);
    }
  );

  it.each([
    ['non-JSON server response', () => new Response('secret upstream error', { status: 502 })],
    ['success without message receipt', () => Response.json({ success: true })],
    ['non-JSON success response', () => new Response('OK')],
  ])('marks %s as uncertain rather than claiming delivery', async (_name, response) => {
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(response());
    await expect(
      new InstagramAutomationProvider(account()).sendPrivateReply('comment-1', 'text')
    ).rejects.toMatchObject({ uncertain: true });
  });

  it('marks a network failure during a send uncertain and sanitizes its cause', async () => {
    jest.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('secret-token network timeout'));
    const error = await new InstagramAutomationProvider(account())
      .sendMessage('recipient', textMessage())
      .catch((e) => e);
    expect(error).toMatchObject({ uncertain: true });
    expect(error.message).not.toContain('secret-token');
  });

  it.each([
    [429, 613, undefined, 'limiting requests'],
    [400, 10, 2534022, 'messaging window has closed'],
    [400, 100, 2534025, 'fresh eligible comment'],
    [400, 200, 2534041, 'disabled Instagram message access'],
  ])('classifies provider rejection %s/%s/%s with actionable safe copy', async (status, code, subcode, expected) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code, error_subcode: subcode, message: 'secret customer input' } }), { status: Number(status), headers: { 'Content-Type': 'application/json' } }));
    await expect(new InstagramAutomationProvider(account()).sendPrivateReply('comment1', textMessage().text)).rejects.toMatchObject({ uncertain: false, message: expect.stringContaining(String(expected)) });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not mark a failed read as uncertain delivery', async () => {
    jest.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network error'));
    await expect(new InstagramAutomationProvider(account()).media()).rejects.toMatchObject({
      uncertain: false,
    });
  });

  it('uses pagination cursors from the account media response, without following provider URLs', async () => {
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: 'media-1', permalink: 'https://www.instagram.com/reel/abc/' }],
          paging: {
            next: 'https://untrusted.example/with-token',
            cursors: { after: 'next-cursor' },
          },
        })
      );
    expect(await new InstagramAutomationProvider(account()).media('prior-cursor')).toEqual({
      media: [{ id: 'media-1', permalink: 'https://www.instagram.com/reel/abc/', media_product_type: 'REELS' }],
      nextCursor: 'next-cursor',
    });
    expect(fetchedUrl().pathname).toBe(`/v24.0/${accountId}/media`);
    expect(fetchedUrl().searchParams.get('after')).toBe('prior-cursor');
    expect(fetchedUrl().searchParams.get('fields')).not.toMatch(/caption|media_product_type/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ owner: { id: 'another-account' } }, {}])(
    'rejects media without confirmed ownership: %j',
    async (response) => {
      jest.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json(response));
      await expect(
        new InstagramAutomationProvider(account()).verifyMedia(['media-1'])
      ).rejects.toThrow('owned by this Instagram account');
    }
  );

  it('accepts confirmed owned media and distinguishes a reel', async () => {
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(Response.json({ owner: { id: accountId } }));
    await expect(
      new InstagramAutomationProvider(account()).verifyMedia(['media-1'])
    ).resolves.toBeUndefined();
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        Response.json({ owner: { id: accountId }, permalink: 'https://www.instagram.com/reel/abc/' })
      );
    await expect(new InstagramAutomationProvider(account()).mediaIsReel('media-1')).resolves.toBe(
      true
    );
  });

  it.each([true, false])(
    'returns only an explicit boolean for follower status: %s',
    async (follows) => {
      jest
        .mocked(globalThis.fetch)
        .mockResolvedValueOnce(Response.json({ is_user_follow_business: follows }));
      await expect(
        new InstagramAutomationProvider(account()).followStatus('sender-1')
      ).resolves.toBe(follows);
      expect(fetchedUrl().searchParams.get('fields')).toBe('is_user_follow_business');
    }
  );

  it.each([{}, { is_user_follow_business: 'true' }, { is_user_follow_business: 1 }])(
    'does not infer a verified follow from incomplete provider data: %j',
    async (response) => {
      jest.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json(response));
      await expect(
        new InstagramAutomationProvider(account()).followStatus('sender-1')
      ).resolves.toBeNull();
    }
  );

  it('leaves follower verification unknown after permission errors or network failures', async () => {
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(Response.json({ error: { code: 200 } }, { status: 403 }));
    await expect(
      new InstagramAutomationProvider(account()).followStatus('sender-1')
    ).resolves.toBeNull();
    jest.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('timeout'));
    await expect(
      new InstagramAutomationProvider(account()).followStatus('sender-1')
    ).resolves.toBeNull();
  });
});

describe('Instagram profile publication and rich-message serialization', () => {
  it.each([true, false])('confirms the documented icebreaker locale-group readback for direct login %s', async direct => {
    const config = icebreakers();
    config.locales.push({ locale: 'en_US', questions: [{ id: 'english', question: 'What are your hours?' }], items: [] });
    const expected = profileProviderValue('icebreakers', config);
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(subscription()).mockResolvedValueOnce(Response.json({ result: 'success' })).mockResolvedValueOnce(Response.json({ data: [...expected].reverse() }));
    const value = direct ? account() : account({ sessionData: { pageId: 'page-9', pageAccessToken: 'page-token' }, grantedScopes: ['instagram_basic', 'pages_read_engagement', 'pages_manage_metadata', 'instagram_manage_messages', 'instagram_manage_comments'] }, { pageId: 'page-9' });
    await expect(new InstagramAutomationProvider(value).publishProfile('icebreakers', config)).resolves.toBeUndefined();
    expect(fetchedBody(1).platform).toBe('instagram');
    expect(fetchedUrl(2).searchParams.get('platform')).toBe('instagram');
  });

  it('accepts top-level menu readback and ignores unsupported composer metadata', async () => {
    const config = menu();
    const expected = (profileProviderValue('menu', config) as Record<string, unknown>[]).map(group => ({ ...group, composer_input_disabled: false, id: 'provider-metadata' }));
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ persistent_menu: expected }));
    await expect(new InstagramAutomationProvider(account()).verifyProfile('menu', config)).resolves.toBeUndefined();
  });

  it('publishes menu links and action payloads, then verifies the provider readback', async () => {
    const config = menu(),
      expected = profileProviderValue('menu', config);
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(subscription())
      .mockResolvedValueOnce(Response.json({ result: 'success' }))
      .mockResolvedValueOnce(Response.json({ data: [{ persistent_menu: expected }] }));
    await expect(
      new InstagramAutomationProvider(account()).publishProfile('menu', config)
    ).resolves.toBeUndefined();
    expect(fetchedBody(1)).toEqual({
      platform: 'instagram',
      persistent_menu: [
        {
          locale: 'default',
          call_to_actions: [
            { type: 'postback', title: 'Pricing', payload: 'IGA_MENU_VIEW_PRICING' },
            { type: 'web_url', title: 'Website', url: 'https://example.com' },
          ],
        },
      ],
    });
    expect(fetchedUrl(2).searchParams.get('fields')).toBe('persistent_menu');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves each locale and the starter payload during publication', async () => {
    const config = icebreakers();
    config.locales.push({
      locale: 'en_US',
      questions: [{ id: 'english_hours', question: 'When are you open?' }],
      items: [],
    });
    const expected = profileProviderValue('icebreakers', config);
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(subscription())
      .mockResolvedValueOnce(Response.json({ result: 'success' }))
      .mockResolvedValueOnce(Response.json({ data: [{ ice_breakers: expected }] }));
    await new InstagramAutomationProvider(account()).publishProfile('icebreakers', config);
    expect(fetchedBody(1)).toEqual({
      platform: 'instagram',
      ice_breakers: [
        {
          locale: 'default',
          call_to_actions: [{ question: 'What are your hours?', payload: 'IGA_START_hours' }],
        },
        {
          locale: 'en_US',
          call_to_actions: [{ question: 'When are you open?', payload: 'IGA_START_english_hours' }],
        },
      ],
    });
  });

  it('rejects an accepted profile update when the readback differs', async () => {
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(subscription())
      .mockResolvedValueOnce(Response.json({ result: 'success' }))
      .mockResolvedValueOnce(Response.json({ data: [{ persistent_menu: [] }] }));
    await expect(
      new InstagramAutomationProvider(account()).publishProfile('menu', menu())
    ).rejects.toThrow('readback differs');
  });

  it('confirms deletion by reading an empty profile field', async () => {
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(subscription())
      .mockResolvedValueOnce(Response.json({ result: 'success' }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(
      new InstagramAutomationProvider(account()).publishProfile('menu', menu(), true)
    ).resolves.toBeUndefined();
    expect(jest.mocked(globalThis.fetch).mock.calls[1][1]?.method).toBe('DELETE');
    expect(fetchedBody(1)).toEqual({ platform: 'instagram', fields: ['persistent_menu'] });
  });

  it('requires explicit publication acceptance and a well-formed removal readback', async () => {
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(subscription())
      .mockResolvedValueOnce(Response.json({ success: false }));
    await expect(
      new InstagramAutomationProvider(account()).publishProfile('menu', menu())
    ).rejects.toThrow('did not confirm');
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(subscription())
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    await expect(
      new InstagramAutomationProvider(account()).publishProfile('menu', menu(), true)
    ).rejects.toThrow('incomplete profile readback');
  });

  it('maps quick replies and URL button templates for normal DM delivery', async () => {
    const quick: InstagramMessage = {
      ...textMessage('Hello {{name}}'),
      format: 'quick_replies',
      quickReplies: [{ title: 'Pricing', payload: 'PRICING' }],
    };
    expect(instagramMessagePayload(quick, { name: 'Asha' })).toEqual({
      text: 'Hello Asha',
      quick_replies: [{ content_type: 'text', title: 'Pricing', payload: 'PRICING' }],
    });
    const buttons: InstagramMessage = {
      ...textMessage(),
      format: 'buttons',
      buttons: [{ title: 'Open guide', url: 'https://example.com/guide' }],
    };
    await new InstagramAutomationProvider(account()).sendMessage('recipient-1', buttons);
    expect(fetchedBody()).toEqual({
      recipient: { id: 'recipient-1' },
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: 'Your requested content',
            buttons: [{ type: 'web_url', title: 'Open guide', url: 'https://example.com/guide' }],
          },
        },
      },
    });
  });

  it('rejects incomplete message shapes before they reach editors or delivery', () => {
    const incomplete = {
      format: 'carousel',
      cards: [
        {
          title: 'A',
          subtitle: '',
          imageUrl: 'https://example.com/a.png',
          buttons: [{ title: 'Open', url: 'https://example.com' }],
        },
      ],
    };
    expect(validateInstagramMessage(incomplete)).not.toEqual([]);
    const publicRule = rule({
      kind: 'comment_reply',
      publicReplies: ['Thanks'],
    }) as unknown as Record<string, unknown>;
    delete publicRule.message;
    expect(validateInstagramRule(publicRule)).not.toEqual([]);
    const config = menu();
    delete (config.locales[0].items[1] as unknown as Record<string, unknown>).response;
    expect(validateInstagramProfile('menu', config)).not.toEqual([]);
  });
  it('maps carousel cards and substitutes supported text variables', () => {
    const message: InstagramMessage = {
      ...emptyInstagramMessage(),
      format: 'carousel',
      cards: [
        {
          title: 'Hello {{name}}',
          subtitle: 'Your {{keyword}}',
          imageUrl: 'https://example.com/image.jpg',
          buttons: [{ title: 'Open', url: 'https://example.com' }],
        },
      ],
    };
    expect(instagramMessagePayload(message, { name: 'Asha', keyword: 'guide' })).toEqual({
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: 'Hello Asha',
              subtitle: 'Your guide',
              image_url: 'https://example.com/image.jpg',
              buttons: [{ type: 'web_url', title: 'Open', url: 'https://example.com' }],
            },
          ],
        },
      },
    });
  });
});

describe('Instagram automation shared configuration validation', () => {
  it('accepts valid text DM and public comment definitions', () => {
    expect(validateInstagramRule(rule())).toEqual([]);
    expect(
      validateInstagramRule(
        rule({
          kind: 'comment_reply',
          publicReplies: ['Thanks {{username}}!'],
          message: emptyInstagramMessage(),
        })
      )
    ).toEqual([]);
  });

  it('requires selected media for specific rules and enforces keyword limits', () => {
    const definition = rule();
    definition.trigger.scope = 'specific';
    expect(validateInstagramRule(definition)).toContain(
      'Choose keywords, a match mode and a valid post scope.'
    );
    definition.trigger.mediaIds = ['media-1'];
    expect(validateInstagramRule(definition)).toEqual([]);
    definition.trigger.keywords = Array.from({ length: 21 }, (_, i) => `keyword-${i}`);
    expect(validateInstagramRule(definition)).toContain(
      'Choose keywords, a match mode and a valid post scope.'
    );
  });

  it('requires a verified interaction path before configuring rich comment-to-DM content', () => {
    const definition = rule({
      message: {
        ...textMessage(),
        format: 'quick_replies',
        quickReplies: [{ title: 'Continue', payload: 'CONTINUE' }],
      },
    });
    expect(validateInstagramRule(definition)).toContain(
      'Rich messages require a follow-gate interaction before delivery. Initial comment private replies use text.'
    );
    definition.followGate.enabled = true;
    expect(validateInstagramRule(definition)).toEqual([]);
    definition.filters.followers = 'non_followers';
    expect(validateInstagramRule(definition)).toContain(
      'The follow gate cannot be combined with a non-followers-only filter.'
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid delivery limits: %s', (limit) => {
    const definition = rule();
    definition.filters.maxPerDay = limit;
    expect(validateInstagramRule(definition)).toContain('Set valid audience and delivery limits.');
  });

  it('validates the exact text and rich message format limits', () => {
    expect(validateInstagramMessage(textMessage('a'.repeat(1000)))).toEqual([]);
    expect(validateInstagramMessage(textMessage('a'.repeat(1001)))).not.toEqual([]);
    expect(validateInstagramMessage(textMessage('😀'.repeat(250)))).toEqual([]);
    expect(validateInstagramMessage(textMessage('😀'.repeat(251)))).not.toEqual([]);
    expect(validateInstagramMessage(textMessage('ந'.repeat(333)))).toEqual([]);
    expect(validateInstagramMessage(textMessage('ந'.repeat(334)))).not.toEqual([]);
    const buttonMessage = { ...textMessage('a'.repeat(640)), format: 'buttons' as const, buttons: [{ title: 'Open', url: 'https://example.com' }] };
    expect(validateInstagramMessage(buttonMessage)).toEqual([]);
    expect(validateInstagramMessage({ ...buttonMessage, text: 'a'.repeat(641) })).not.toEqual([]);
    expect(
      validateInstagramMessage({
        ...textMessage(),
        format: 'quick_replies',
        quickReplies: Array.from({ length: 14 }, () => ({ title: 'Reply', payload: 'REPLY' })),
      })
    ).not.toEqual([]);
    expect(
      validateInstagramMessage({
        ...textMessage(),
        format: 'buttons',
        buttons: [{ title: 'Open', url: 'http://example.com' }],
      })
    ).not.toEqual([]);
    expect(
      validateInstagramMessage({
        ...textMessage(),
        format: 'buttons',
        buttons: [{ title: 'Open', url: 'https://user:password@example.com' }],
      })
    ).not.toEqual([]);
    expect(
      validateInstagramMessage({ ...textMessage(), format: 'carousel', cards: [] })
    ).not.toEqual([]);
  });

  it('counts Unicode bytes and includes required follow instructions without duplicating them', () => {
    expect(instagramTextBytes('Hi 😀ந')).toBe(10);
    expect(instagramFollowPrompt('Please follow, then reply DONE.')).toBe('Please follow, then reply DONE.');
    expect(instagramFollowRetryMessage('Reply DONE to retry.')).toBe('Reply DONE to retry.');
    const definition = rule();
    definition.followGate.enabled = true;
    definition.followGate.prompt = 'a'.repeat(990);
    expect(validateInstagramRule(definition)).not.toEqual([]);
    definition.followGate.prompt = 'DONE ' + 'a'.repeat(995);
    expect(validateInstagramRule(definition)).toEqual([]);
    definition.followGate.prompt = '';
    expect(validateInstagramRule(definition)).not.toEqual([]);
  });

  it('requires unique locales and a default locale', () => {
    const config = icebreakers();
    expect(validateInstagramProfile('icebreakers', config)).toEqual([]);
    config.locales[0].locale = 'en_US';
    expect(validateInstagramProfile('icebreakers', config)).toContain(
      'Keep a default language group.'
    );
    config.locales.push({ ...config.locales[0] });
    expect(validateInstagramProfile('icebreakers', config)).toContain(
      'Use unique language codes such as en_US, plus a default group.'
    );
  });

  it('enforces four questions per locale and the 80-character question limit', () => {
    const config = icebreakers();
    config.locales[0].questions = Array.from({ length: 4 }, (_, i) => ({
      id: `question-${i}`,
      question: 'a'.repeat(80),
    }));
    expect(validateInstagramProfile('icebreakers', config)).toEqual([]);
    config.locales[0].questions[0].question += 'a';
    expect(validateInstagramProfile('icebreakers', config)).toContain(
      'Questions must contain 1–80 characters.'
    );
    config.locales[0].questions.push({ id: 'question-5', question: 'Question?' });
    expect(validateInstagramProfile('icebreakers', config)).toContain(
      'Each language needs 1–4 questions.'
    );
  });

  it('enforces three menu items, 30-character labels, HTTPS URLs and unique action payloads', () => {
    const config = menu();
    expect(validateInstagramProfile('menu', config)).toEqual([]);
    config.locales[0].items[0].title = 'a'.repeat(31);
    config.locales[0].items[1].url = 'javascript:alert(1)';
    expect(validateInstagramProfile('menu', config)).toEqual(
      expect.arrayContaining([
        'Menu labels must contain 1–30 characters.',
        'Menu links must use HTTPS.',
      ])
    );
    const duplicate = { ...config.locales[0].items[0], id: 'pricing-copy', title: 'Pricing copy' };
    config.locales[0].items.push(duplicate);
    expect(validateInstagramProfile('menu', config)).toContain(
      'Menu actions need unique payloads using letters, numbers, underscores or hyphens.'
    );
    config.locales[0].items.push({ ...duplicate, id: 'pricing-copy-2' });
    expect(validateInstagramProfile('menu', config)).toContain(
      'Each language needs 1–3 menu items.'
    );
  });

  it('requires a configured response for menu actions', () => {
    const config = menu();
    config.locales[0].items[0].response = emptyInstagramMessage();
    expect(validateInstagramProfile('menu', config)).toContain(
      'DM text must contain 1–1,000 UTF-8 bytes. Emoji and some languages use multiple bytes.'
    );
  });
});

describe('Instagram deterministic matching and rule precedence', () => {
  const comment = { text: 'Please send a GUIDE', mediaId: 'media-1', isReel: false };

  it('normalizes casing and Unicode while preserving the matched configured keyword', () => {
    const definition = rule();
    definition.trigger.keywords = ['ＧＵＩＤＥ'];
    expect(matchInstagramRule(definition, comment)).toBe('ＧＵＩＤＥ');
  });

  it('checks negative keywords before positive matches', () => {
    const definition = rule();
    definition.trigger.negativeKeywords = ['spam'];
    expect(matchInstagramRule(definition, { ...comment, text: 'guide SPAM' })).toBeNull();
    expect(matchInstagramRule(definition, comment)).toBe('guide');
  });

  it('distinguishes exact keyword matching from contains matching', () => {
    const definition = rule();
    definition.trigger.matchMode = 'exact';
    expect(matchInstagramRule(definition, comment)).toBeNull();
    expect(matchInstagramRule(definition, { ...comment, text: '  GUIDE  ' })).toBe('guide');
  });

  it('requires media membership for specific rules and reel media for reels-only rules', () => {
    const definition = rule();
    definition.trigger.scope = 'specific';
    definition.trigger.mediaIds = ['media-2'];
    expect(matchInstagramRule(definition, comment)).toBeNull();
    expect(matchInstagramRule(definition, { ...comment, mediaId: 'media-2' })).toBe('guide');
    definition.trigger.scope = 'reels';
    expect(matchInstagramRule(definition, comment)).toBeNull();
    expect(matchInstagramRule(definition, { ...comment, isReel: true })).toBe('guide');
  });

  it('ranks specific media before reels before all, then list priority and stable ID', () => {
    const make = (id: number, scope: 'all' | 'reels' | 'specific', priority: number) => {
      const definition = rule();
      definition.trigger.scope = scope;
      return { id, priority, definition };
    };
    const input = [
      make(1, 'all', 0),
      make(2, 'reels', 0),
      make(9, 'specific', 1),
      make(5, 'specific', 0),
      make(4, 'specific', 0),
    ];
    expect(sortInstagramRules(input).map((item) => item.id)).toEqual([4, 5, 9, 2, 1]);
    expect(input.map((item) => item.id)).toEqual([1, 2, 9, 5, 4]);
  });

  it('only substitutes known variables and limits expanded message length', () => {
    expect(
      renderInstagramText('Hi {{ name }}, {{username}} asked for {{keyword}} {{unknown}}', {
        username: 'asha',
        keyword: 'guide',
      })
    ).toBe('Hi there, asha asked for guide {{unknown}}');
    expect(renderInstagramText('{{name}}', { name: 'a'.repeat(2500) })).toHaveLength(2000);
  });
});
