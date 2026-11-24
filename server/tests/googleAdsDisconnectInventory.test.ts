import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { mockAuthRequest, mockResponse } from './helpers/mockHelpers.js';
import type { AuthenticatedRequest } from '../types/express.js';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { disconnectGoogleAds } = await import('../controllers/integrationsController.js');
const { listPaidAdAccounts, discoverPaidAdAccounts } = await import('../services/ads/PaidAdAccountsService.js');
const compiled = (index: number) => new PgDialect().sqlToQuery(execute.mock.calls[index][0] as SQL);
const owner = <T>(work: () => T) => withBusinessScope({ userId: 41, businessProfileId: 42 }, work);
beforeEach(() => { execute.mockReset().mockResolvedValue({ rows: [] }); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('Google Ads disconnected inventory', () => {
  it('deactivates only the business-owned Google inventory after removing authorization', async () => {
    const res = mockResponse();
    await owner(() => disconnectGoogleAds(mockAuthRequest(41) as AuthenticatedRequest, res));
    expect(res._json).toEqual({ success: true });
    expect(compiled(0).sql).toContain('DELETE FROM api_credentials');
    expect(compiled(0).params).toEqual([41, 'google_ads']);
    expect(compiled(1).sql).toContain("platform='google'");
    expect(compiled(1).sql).toContain('is_active=FALSE');
    expect(compiled(1).sql).toContain('reporting_available=FALSE');
    expect(compiled(1).sql).toContain('publishing_available=FALSE');
    expect(compiled(1).params).toEqual([41]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('does not claim success if removing credentials fails', async () => {
    execute.mockRejectedValueOnce(new Error('Synthetic database error'));
    const res = mockResponse();
    await owner(() => disconnectGoogleAds(mockAuthRequest(41) as AuthenticatedRequest, res));
    expect(res._status).toBe(500);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('excludes legacy disconnected Google inventory using authorization in the same business', async () => {
    await owner(() => listPaidAdAccounts(41));
    const query = compiled(0);
    expect(query.params).toEqual([41]);
    expect(query.sql).toContain("a.platform<>'google' OR c.id IS NOT NULL");
    expect(query.sql).toContain('c.user_id=a.user_id AND c.business_profile_id=a.business_profile_id');
    expect(query.sql).toContain("c.service_name='google_ads' AND c.is_active=TRUE");
    expect(query.sql).toContain("length(c.config->>'refreshToken')");
  });
  it('keeps accounts from the old Google login hidden while offering multiple accounts verified with the new grant', async () => {
    const grant = '2026-10-28T10:00:00.000Z';
    const account = { platform: 'google', is_active: true, google_connected_at: grant, google_created_at: '2026-01-01T00:00:00Z' };
    execute.mockResolvedValue({ rows: [
      { ...account, id: 1, verified_at: '2026-10-27T10:00:00Z' },
      { ...account, id: 2, verified_at: '2026-10-28T10:01:00Z' },
      { ...account, id: 3, verified_at: '2026-10-28T10:02:00Z' },
      { ...account, id: 4, verified_at: null },
      { id: 5, platform: 'meta', verified_at: '2026-10-27T10:00:00Z' },
    ] });
    const accounts = await owner(() => listPaidAdAccounts(41));
    expect(accounts.map(account => account.id)).toEqual([2, 3, 5]);
    expect(accounts[0]).not.toHaveProperty('google_connected_at');
    expect(accounts[0]).not.toHaveProperty('google_created_at');
  });
  it('uses authorization creation time for legacy Google credentials without a connectedAt value', async () => {
    execute.mockResolvedValue({ rows: [
      { id: 1, platform: 'google', google_created_at: '2026-10-28T10:00:00Z', verified_at: '2026-10-27T10:00:00Z' },
      { id: 2, platform: 'google', google_created_at: '2026-10-28T10:00:00Z', verified_at: '2026-10-28T11:00:00Z' },
    ] });
    expect((await owner(() => listPaidAdAccounts(41))).map(account => account.id)).toEqual([2]);
  });
  it('does not stamp a late discovery response as verified under a newer grant', async () => {
    jest.useFakeTimers();
    const started = new Date('2026-10-28T10:00:00Z');
    jest.setSystemTime(started);
    execute.mockImplementation(async query => new PgDialect().sqlToQuery(query as SQL).sql.includes('FROM api_credentials')
      ? { rows: [{ id: 1, api_key: 'qa-client', api_secret: 'qa-secret', is_active: true,
        config: { refreshToken: 'qa-refresh', developerToken: 'qa-developer', connectedAt: '2026-10-28T09:00:00Z' } }] }
      : { rows: [] });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('oauth2')) return ok({ access_token: 'offline-token', expires_in: 3600 });
      if (String(url).includes('listAccessibleCustomers')) return ok({ resourceNames: ['customers/1234567890'] });
      jest.setSystemTime(new Date('2026-10-28T11:00:00Z'));
      return ok({ results: [{ customer: { id: '1234567890', descriptiveName: 'Synthetic account', manager: false } }] });
    });
    await owner(() => discoverPaidAdAccounts(41, 'google'));
    const insertIndex = execute.mock.calls.findIndex(([query]) => new PgDialect().sqlToQuery(query as SQL).sql.includes('INSERT INTO paid_ad_accounts'));
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(compiled(insertIndex).params).toContainEqual(started);
    expect(compiled(insertIndex).sql).toContain('verified_at=EXCLUDED.verified_at');
    expect(compiled(insertIndex).sql).toContain('WHERE paid_ad_accounts.verified_at IS NULL OR paid_ad_accounts.verified_at<=EXCLUDED.verified_at');
  });
});
