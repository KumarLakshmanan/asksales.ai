import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// The real check with a fake database: the template's category decides whether
// to look at all, and the query keeps to this account's own 131049 failures.
const execute = jest.fn<(query: SQL) => Promise<{ rows: unknown[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { recentMarketingLimitLeads } = await import('../services/whatsapp/WhatsAppMarketingLimit.js');

const query = (call: number) => new PgDialect().sqlToQuery(execute.mock.calls[call][0]);

beforeEach(() => { execute.mockReset(); });

describe('WhatsApp marketing limit check', () => {
  it('returns the contacts Meta recently held a marketing template back from', async () => {
    execute
      .mockResolvedValueOnce({ rows: [{ category: 'MARKETING' }] })
      .mockResolvedValueOnce({ rows: [{ lead_id: '144' }, { lead_id: 142 }] });
    await expect(recentMarketingLimitLeads({
      userId: 9, leadIds: [142, 142, 144, 150, -1], phoneNumberId: '1095711443622725', templateName: '2nightstay', templateLanguage: 'en',
    })).resolves.toEqual({ marketing: true, leadIds: [142, 144] });
    const check = query(1);
    expect(check.sql).toContain("'131049'");
    expect(check.sql).toContain("'provider_limit'");
    expect(check.params).toEqual(expect.arrayContaining([9, 142, 144, 150, '1095711443622725', 24]));
    expect(check.params).not.toContain(-1);
  });

  it('skips utility templates, which the marketing limit does not cover', async () => {
    execute.mockResolvedValueOnce({ rows: [{ category: 'UTILITY' }] });
    await expect(recentMarketingLimitLeads({ userId: 9, leadIds: [142], templateName: 'order_update' }))
      .resolves.toEqual({ marketing: false, leadIds: [] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown template as marketing, as billing does', async () => {
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(recentMarketingLimitLeads({ userId: 9, leadIds: [142], templateName: 'missing' }))
      .resolves.toEqual({ marketing: true, leadIds: [] });
  });
});
