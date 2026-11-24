import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// A live assistant bound to a connected WhatsApp number and a Gmail address
// whose sender was removed. Inbound WhatsApp replies must still route; email
// on the stale binding must not.
const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>();
const readiness = jest.fn((_draft: unknown, _catalog: unknown, _platform: unknown,
  bindings: { channel: string; surface: string; accountId: string }[]) => {
  const connected = bindings.length > 0 && bindings.every(b => b.channel === 'whatsapp' && b.accountId === '1095711443622725');
  return { ready: connected, checks: [{ key: 'accounts', label: 'Connected accounts', ok: connected, detail: '' }] };
});
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({
  requireBusinessScope: () => ({ userId: 9, businessProfileId: 7 }),
  currentBusinessScope: () => ({ userId: 9, businessProfileId: 7 }),
}));
jest.unstable_mockModule('../services/assistants/AssistantContext.js', () => ({
  assistantsRuntimeEnabled: () => true,
  freezeAssistant: (value: unknown) => value,
}));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  assistantProvenanceCurrent: jest.fn(), assertAssistantFresh: jest.fn(),
}));
jest.unstable_mockModule('../services/assistants/AssistantService.js', () => ({ assistantRow: jest.fn() }));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({
  assistantCatalog: async () => ({ accounts: [] }),
  assistantPlatformReadiness: async () => ({ classifier: true, privacyVault: true }),
}));
jest.unstable_mockModule('../services/assistants/AssistantConfiguration.js', () => ({
  assistantReadiness: readiness,
  parseAssistantDraft: (value: unknown) => value,
}));
const { resolveTurnAssistant, AssistantRoutingError } = await import('../services/assistants/AssistantResolver.js');

const siblings = [
  { channel: 'whatsapp', surface: 'private', account_id: '1095711443622725' },
  { channel: 'email', surface: 'private', account_id: 'removed@example.test' },
];
const assigned = { binding_id: 4, version: 1, revision: 2, assistant_id: 'a1', configuration: { name: 'Live', bindings: [] }, state: 'live' };

beforeEach(() => { execute.mockReset(); readiness.mockClear(); });

describe('inbound assistant routing with a disconnected sibling account', () => {
  it('routes WhatsApp when only another account on the same assistant is disconnected', async () => {
    execute
      .mockResolvedValueOnce({ rows: [{ provider_account_id: '1095711443622725', channel: 'whatsapp', sender_id: null }] })
      .mockResolvedValueOnce({ rows: [assigned] })
      .mockResolvedValueOnce({ rows: siblings });
    const resolved = await resolveTurnAssistant({ userId: 9, conversationId: 35619, channel: 'whatsapp', metadata: {} } as never);
    expect(resolved?.provenance).toMatchObject({ assistantId: 'a1', channel: 'whatsapp', accountId: '1095711443622725' });
    expect(readiness.mock.calls[0][3]).toEqual([{ channel: 'whatsapp', surface: 'private', accountId: '1095711443622725' }]);
  });

  it('still blocks the disconnected account itself', async () => {
    execute
      .mockResolvedValueOnce({ rows: [{ provider_account_id: 'removed@example.test', channel: 'email', sender_id: null }] })
      .mockResolvedValueOnce({ rows: [assigned] })
      .mockResolvedValueOnce({ rows: siblings });
    await expect(resolveTurnAssistant({ userId: 9, conversationId: 40, channel: 'email', metadata: {} } as never))
      .rejects.toThrow(new AssistantRoutingError('Assigned assistant needs attention: Connected accounts'));
    expect(readiness.mock.calls[0][3]).toEqual([{ channel: 'email', surface: 'private', accountId: 'removed@example.test' }]);
  });
});
