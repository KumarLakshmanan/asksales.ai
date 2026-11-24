import { describe, expect, it } from '@jest/globals';
import { metaAccountChoices, googleAccountChoices } from '../mastra/tools/adAccountChoices.js';

describe('safe Meta account selection summary', () => {
  it('returns only safe Google customer fields without claiming a complete inventory', () => {
    const result = googleAccountChoices({ customerId: '1234567890', refreshToken: 'SECRET', developerToken: 'SECRET' });
    expect(result.accounts).toEqual([{ id: '1234567890', selected: true }]);
    expect(result.providerVerified).toBe(false);
    expect(result.note).toContain('not all accessible accounts');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('lists choices without leaking root or nested credentials', () => {
    const result = metaAccountChoices({ accessToken: 'ROOT_SECRET', adAccountId: 'act_1', pageId: 'p1',
      adAccounts: [{ id: 'act_1', name: 'Main', currency: 'USD', timezone_name: 'UTC', access_token: 'ACCOUNT_SECRET' }],
      pages: [{ id: 'p1', name: 'Brand', accessToken: 'PAGE_SECRET' }] }, { accessToken: 'SELECTED_SECRET' });
    expect(result.accounts).toEqual([{ id: 'act_1', name: 'Main', currency: 'USD', timezone: 'UTC', selected: true }]);
    expect(result.pages).toEqual([{ id: 'p1', name: 'Brand', selected: true }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.providerVerified).toBe(false);
  });
  it('does not silently select the only available account', () => {
    const result = metaAccountChoices({ adAccounts: [{ id: 'act_1' }] }, null);
    expect(result.selectedAccountId).toBeNull();
    expect(result.accounts[0].selected).toBe(false);
  });
  it('supports the selected legacy connection without inventing other choices', () => {
    const result = metaAccountChoices(null, { adAccountId: 'act_2', adAccountName: 'Legacy', pageId: 'p2' });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ id: 'act_2', name: 'Legacy', selected: true });
  });
  it('deduplicates choices and tolerates malformed stored data', () => {
    const result = metaAccountChoices({ adAccounts: [null, {}, { id: 'act_1' }, { id: 'act_1' }], pages: 'invalid' }, null);
    expect(result.accounts).toHaveLength(1);
    expect(result.pages).toEqual([]);
  });
});
