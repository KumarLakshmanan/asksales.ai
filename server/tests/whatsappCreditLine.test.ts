import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Attaching and revoking our Meta credit line on a customer's WABA. The
 * database, the admin credential store, admin notifications and Meta's Graph
 * API are fakes.
 */

type Row = Record<string, unknown>;

function sqlText(query: { queryChunks?: unknown[] }): string {
  return (query.queryChunks || []).map((chunk) => {
    if (chunk && typeof chunk === 'object' && Array.isArray((chunk as { value?: unknown }).value)) return (chunk as { value: string[] }).value.join('');
    return '?';
  }).join('').replace(/\s+/g, ' ');
}

const state = {
  account: null as Row | null,
  rateCategories: 4,
  siblings: [] as Row[],
  writes: [] as string[],
};

const execute = jest.fn(async (query: { queryChunks?: unknown[] }): Promise<{ rows: Row[] }> => {
  const text = sqlText(query);
  if (text.includes('COUNT(DISTINCT category)')) return { rows: [{ count: String(state.rateCategories) }] };
  if (text.includes('SELECT allocation_config_id, credit_line_status')) return { rows: state.account ? [state.account] : [] };
  if (text.includes('RETURNING waba_id')) { state.writes.push(text); return { rows: state.siblings }; }
  if (text.includes('whatsapp_billing_accounts')) { state.writes.push(text); return { rows: [] }; }
  throw new Error(`Unexpected SQL: ${text}`);
});

const notifyAllAdmins = jest.fn(async (_input: Row) => undefined);
const credential = {
  id: 3, config: {
    whatsappBillingCreditLineId: '1234567', whatsappBillingSystemToken: 'system-token-value', whatsappBillingCurrency: 'INR',
    whatsappBillingAttachOnSignup: true, apiVersion: 'v25.0',
  },
};

jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getActiveAdminCredential: async () => credential, getAdminCredentialsByPlatform: async () => [credential],
}));
jest.unstable_mockModule('../models/adminNotifications/functions.js', () => ({ notifyAllAdmins }));

const creditLine = await import('../services/whatsapp/WhatsAppCreditLine.js');

const realFetch = global.fetch;
const graphCalls: Array<{ method: string; url: string; auth: string | null }> = [];
function mockGraph(responses: Record<string, Row>) {
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    graphCalls.push({ method: init?.method ?? 'GET', url: href, auth: new Headers(init?.headers).get('authorization') });
    const key = Object.keys(responses).find(part => href.includes(part));
    const body = key ? responses[key] : { error: { message: 'Unknown Graph path' } };
    return new Response(JSON.stringify(body), { status: (body as { error?: unknown }).error ? 400 : 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  graphCalls.length = 0;
  process.env.WHATSAPP_PLATFORM_BILLING_ENABLED = 'true';
  Object.assign(state, { account: null, rateCategories: 4, siblings: [], writes: [] });
});
afterEach(() => {
  delete process.env.WHATSAPP_PLATFORM_BILLING_ENABLED;
  global.fetch = realFetch;
});

describe('attaching the credit line', () => {
  it('attaches, verifies the funding source and switches the WABA to platform billing', async () => {
    mockGraph({
      whatsapp_credit_sharing_and_attach: { allocation_config_id: '999' },
      '/999?': { receiving_credential: { id: 'fund-1' } },
      '/55555?': { primary_funding_id: 'fund-1' },
    });
    await expect(creditLine.attachCreditLine({ wabaId: '55555', userId: 7, customerToken: 'customer-token', reason: 'signup' }))
      .resolves.toEqual({ status: 'attached', allocationConfigId: '999', verified: true });
    expect(graphCalls[0]).toMatchObject({ method: 'POST', auth: 'Bearer system-token-value' });
    expect(graphCalls[0].url).toContain('/1234567/whatsapp_credit_sharing_and_attach');
    expect(graphCalls[0].url).toContain('waba_currency=INR');
    expect(state.writes.at(-1)).toContain('INSERT INTO whatsapp_billing_accounts');
  });

  it('does not attach while platform billing is switched off', async () => {
    delete process.env.WHATSAPP_PLATFORM_BILLING_ENABLED;
    mockGraph({});
    await expect(creditLine.attachCreditLine({ wabaId: '55555', reason: 'admin' })).resolves.toMatchObject({ status: 'skipped' });
    expect(graphCalls).toHaveLength(0);
  });

  it('does not attach without a complete rate card, and alerts admins at signup', async () => {
    state.rateCategories = 3;
    mockGraph({});
    await expect(creditLine.attachCreditLine({ wabaId: '55555', userId: 7, reason: 'signup' }))
      .resolves.toMatchObject({ status: 'skipped', error: expect.stringContaining('no complete INR rate card') });
    expect(graphCalls).toHaveLength(0);
    expect(notifyAllAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'WhatsApp credit line not attached at signup' }));
  });

  it('records a failed attach and leaves the customer on their own billing', async () => {
    mockGraph({ whatsapp_credit_sharing_and_attach: { error: { message: 'Permissions error' } } });
    await expect(creditLine.attachCreditLine({ wabaId: '55555', reason: 'admin' })).resolves.toEqual({ status: 'failed', error: 'Permissions error' });
    expect(state.writes.at(-1)).toContain('INSERT INTO whatsapp_billing_accounts');
    expect(notifyAllAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'WhatsApp credit line could not be attached' }));
  });
});

describe('revoking the credit line', () => {
  it("marks the owner's other attached WABAs as revoked too and tells admins", async () => {
    state.account = { allocation_config_id: '999', credit_line_status: 'attached', user_id: 7 };
    state.siblings = [{ waba_id: '66666' }];
    mockGraph({ '/999': { success: true } });
    await expect(creditLine.revokeCreditLine('55555', 'test')).resolves.toEqual({ status: 'revoked' });
    expect(graphCalls[0].method).toBe('DELETE');
    expect(state.writes.some(text => text.includes("credit_line_status = 'revoked'") && text.includes('waba_id <>'))).toBe(true);
    expect(notifyAllAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'WhatsApp credit line revoked on more than one account' }));
  });

  it('only switches billing back when no credit line was attached', async () => {
    state.account = { allocation_config_id: null, credit_line_status: 'failed', user_id: 7 };
    mockGraph({});
    await expect(creditLine.revokeCreditLine('55555', 'test')).resolves.toEqual({ status: 'skipped' });
    expect(graphCalls).toHaveLength(0);
  });
});
