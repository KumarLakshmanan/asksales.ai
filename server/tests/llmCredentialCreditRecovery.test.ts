/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const notifyAllAdmins = jest.fn<(...args: any[]) => Promise<void>>();
const recordAdminCredentialAudit = jest.fn<(...args: any[]) => Promise<void>>();
let claimedRows: any[];
let reactivationMatches: boolean;
const updates: Array<Record<string, unknown>> = [];

/** db.update(...).set(values).where(...)[.returning(...)] resolving by what is being set. */
function update() {
  let values: Record<string, unknown> = {};
  const chain: any = {
    set(next: Record<string, unknown>) { values = next; updates.push(next); return chain; },
    where() { return chain; },
    returning() { return chain; },
    then(resolve: (rows: unknown) => void) {
      if ('lastValidatedAt' in values) return resolve(claimedRows);
      if (values.isActive === true) return resolve(reactivationMatches ? [{ id: 1 }] : []);
      return resolve([]);
    },
  };
  return chain;
}

jest.unstable_mockModule('../models/db.js', () => ({ db: { update } }));
jest.unstable_mockModule('../models/adminNotifications/functions.js', () => ({ notifyAllAdmins }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  decryptAdminCredential: (row: any) => row,
  LLM_ADMIN_PLATFORMS: ['gemini', 'openai', 'vertex_ai', 'openrouter', 'custom_ai'],
  recordAdminCredentialAudit,
}));
const { recoverCreditDisabledLLMCredentials, probeLLMCredential } = await import('../services/LLMCredentialRecoveryService.js');

const openrouterKey = {
  id: 1, platform: 'openrouter', name: 'Main', apiKey: 'sk-or', isActive: false,
  deactivationReason: 'quota_exceeded', config: { selectedModel: 'openai/gpt-4o-mini' },
};

beforeEach(() => {
  notifyAllAdmins.mockReset().mockResolvedValue(undefined);
  recordAdminCredentialAudit.mockReset().mockResolvedValue(undefined);
  claimedRows = [openrouterKey];
  reactivationMatches = true;
  updates.length = 0;
});

describe('AI keys switched off for lack of credits', () => {
  it('switches the key back on once a test request succeeds', async () => {
    const result = await recoverCreditDisabledLLMCredentials(async () => ({ ok: true }));
    expect(result).toEqual({ checked: 1, reactivated: [1] });
    expect(updates.find(values => values.isActive === true)).toMatchObject({
      isActive: true, deactivationReason: null, deactivatedAt: null, validationStatus: 'valid',
    });
    expect(recordAdminCredentialAudit).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 1, action: 'activate' }));
    expect(notifyAllAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'OpenRouter key switched back on', type: 'success' }));
  });

  it('leaves an unfunded key off without alerting anyone', async () => {
    const result = await recoverCreditDisabledLLMCredentials(async () => ({ ok: false, message: '402 Insufficient credits' }));
    expect(result).toEqual({ checked: 1, reactivated: [] });
    expect(updates.some(values => values.isActive === true)).toBe(false);
    expect(updates.find(values => values.validationStatus === 'invalid')?.validationMessage).toContain('402 Insufficient credits');
    expect(notifyAllAdmins).not.toHaveBeenCalled();
    expect(recordAdminCredentialAudit).not.toHaveBeenCalled();
  });

  it('keeps an administrator change made while the check ran', async () => {
    reactivationMatches = false;
    const result = await recoverCreditDisabledLLMCredentials(async () => ({ ok: true }));
    expect(result.reactivated).toEqual([]);
    expect(notifyAllAdmins).not.toHaveBeenCalled();
  });

  it('does nothing when no key is waiting for a check', async () => {
    claimedRows = [];
    const probe = jest.fn(async () => ({ ok: true as const }));
    expect(await recoverCreditDisabledLLMCredentials(probe)).toEqual({ checked: 0, reactivated: [] });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('the credit test request', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('sends one tiny OpenRouter completion with the configured model', async () => {
    const fetchMock = jest.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchMock as any;
    expect(await probeLLMCredential(openrouterKey as any)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'openai/gpt-4o-mini', max_tokens: 16 });
  });

  it('reports the provider reason when credits are still missing', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 })) as any;
    expect(await probeLLMCredential(openrouterKey as any)).toEqual({ ok: false, message: '402 Insufficient credits' });
  });
});
