import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// The real service with mocked I/O: Meta's reply decides the status, and the
// result is saved on the connection for the WhatsApp page.
const execute = jest.fn<(query: SQL) => Promise<{ rows: unknown[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: jest.fn() }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { WhatsAppApiService } = await import('../services/whatsappApiService.js');

const creds = {
  source: 'channel_credentials' as const, credId: 13, accessToken: 'token', phoneNumberId: 'phone',
  businessAccountId: 'waba-1', apiVersion: 'v25.0', isManual: false,
};
let service: InstanceType<typeof WhatsAppApiService>;

beforeEach(() => {
  execute.mockReset().mockResolvedValue({ rows: [] });
  service = new WhatsAppApiService();
  jest.spyOn(service, 'ensureTokenValidity').mockResolvedValue('token');
});

function metaReplies(body: unknown, ok = true) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: ok ? 200 : 400 }));
}
const saved = () => {
  const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
  return { sql: query.sql, params: query.params };
};

describe('WhatsApp payment method check', () => {
  it('reports a missing payment method and saves it on the connection', async () => {
    const fetcher = metaReplies({ id: 'waba-1' });
    await expect(service.checkPaymentMethod(creds)).resolves.toBe('missing');
    expect(String(fetcher.mock.calls[0][0])).toContain('/waba-1?fields=primary_funding_id');
    expect(saved().sql).toContain("jsonb_build_object('paymentMethod'");
    expect(saved().params).toEqual(expect.arrayContaining(['missing', 13]));
    fetcher.mockRestore();
  });

  it('reports a payment method Meta has on file', async () => {
    const fetcher = metaReplies({ id: 'waba-1', primary_funding_id: '987' });
    await expect(service.checkPaymentMethod(creds)).resolves.toBe('present');
    fetcher.mockRestore();
  });

  it('says unknown when Meta refuses the check instead of guessing', async () => {
    const fetcher = metaReplies({ error: { message: 'Permissions error' } }, false);
    await expect(service.checkPaymentMethod(creds)).resolves.toBe('unknown');
    expect(saved().params).toEqual(expect.arrayContaining(['unknown']));
    fetcher.mockRestore();
  });
});
