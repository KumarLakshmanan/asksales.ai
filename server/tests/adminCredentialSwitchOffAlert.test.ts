/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const notifyAllAdmins = jest.fn<(...args: any[]) => Promise<void>>();
let previousActive: boolean;
let activeCredentials: any[];
const openRouterRow = { id: 28, platform: 'openrouter', isActive: false, isEncrypted: false, apiKey: 'k', config: {} };
let updatedRow: any = openRouterRow;

/** A chainable query whose result depends on the calls made on it. */
function query(kind: 'select' | 'update') {
  const calls: string[] = [];
  const chain: any = new Proxy({}, {
    get(_target, prop: string) {
      if (prop === 'then') {
        const rows = kind === 'update'
          ? (calls.includes('returning') ? [updatedRow] : [])
          : calls.includes('limit') ? [{ isActive: previousActive }] : activeCredentials.splice(0);
        return (resolve: (value: unknown) => void) => resolve(rows);
      }
      return (..._args: unknown[]) => { calls.push(prop); return chain; };
    },
  });
  return chain;
}

jest.unstable_mockModule('../models/db.js', () => ({ db: { select: () => query('select'), update: () => query('update') } }));
jest.unstable_mockModule('../models/adminNotifications/functions.js', () => ({ notifyAllAdmins }));
jest.unstable_mockModule('../services/SecretsManager.js', () => ({ decryptValue: (v: string) => v, encryptValue: (v: string) => v }));
const { markAdminCredentialInactive } = await import('../models/adminApiCredentials/functions.js');

beforeEach(() => {
  notifyAllAdmins.mockReset().mockResolvedValue(undefined);
  previousActive = true;
  activeCredentials = [];
  updatedRow = openRouterRow;
});

describe('switching off an AI provider key', () => {
  it('alerts administrators once when the last AI key runs out of credits', async () => {
    await markAdminCredentialInactive(28, 'quota_exceeded');
    expect(notifyAllAdmins).toHaveBeenCalledTimes(1);
    const alert = notifyAllAdmins.mock.calls[0][0] as any;
    expect(alert).toMatchObject({ title: 'OpenRouter key switched off', type: 'error', category: 'system' });
    expect(alert.message).toContain('ran out of credits');
    expect(alert.message).toContain('No AI provider is active now');
    expect(alert.message).toContain('Approved WhatsApp templates still send');
    expect(alert.message).toContain('switches the key back on by itself');
  });

  // One query per AI platform; the key is returned by the first.
  it('says how many other keys are still active', async () => {
    activeCredentials = [{ id: 3, platform: 'openrouter', isActive: true, isEncrypted: false, apiKey: 'k', config: {} }];
    await markAdminCredentialInactive(28, 'quota_exceeded');
    expect((notifyAllAdmins.mock.calls[0][0] as any).message).toContain('1 other AI provider key is still active');
  });

  it.each(['rate_limit_429', 'service_overloaded', 'manual'])('does not alert for %s', async reason => {
    await markAdminCredentialInactive(28, reason);
    expect(notifyAllAdmins).not.toHaveBeenCalled();
  });

  it('does not alert again for a key that was already off', async () => {
    previousActive = false;
    await markAdminCredentialInactive(28, 'quota_exceeded');
    expect(notifyAllAdmins).not.toHaveBeenCalled();
  });
});

describe('switching off an Apify key', () => {
  it("names the key, gives Apify's reason and points to API Integrations", async () => {
    updatedRow = { id: 27, name: 'punctilious_lotus', platform: 'apify', isActive: false, isEncrypted: false, apiKey: 'k', config: {} };
    await markAdminCredentialInactive(27, 'billing_or_account_capacity', 'Too many outstanding invoices');
    const alert = notifyAllAdmins.mock.calls[0][0] as any;
    expect(alert.title).toBe('Apify key "punctilious_lotus" switched off');
    expect(alert.message).toContain('Apify said: Too many outstanding invoices');
    expect(alert.message).toContain('lead searches cannot run');
    expect(alert.message).toContain('API Integrations');
    expect(alert.message).not.toContain('LLM Providers');
  });
});
