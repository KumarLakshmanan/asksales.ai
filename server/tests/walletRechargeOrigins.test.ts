import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// Actual service and origin repository; only database/provider boundaries are fake.
const credentials = [
  { id: 1, apiKey: 'rzp_live_fixtureA', apiSecret: 'synthetic-secret-A', isActive: true, isEncrypted: false, platform: 'razorpay' },
  { id: 2, apiKey: 'rzp_live_fixtureB', apiSecret: 'synthetic-secret-B', isActive: true, isEncrypted: false, platform: 'razorpay' },
];
const origins = new Map<string, Record<string, unknown>>();
let selectedId = 1;
let failLookup = false;
let failInsert = false;
let afterProviderCreate: () => void = () => {};
let systemConfig = { keyId: 'rzp_live_system', keySecret: 'synthetic-system-secret' };
const dialect = new PgDialect();
const execute = jest.fn(async (statement: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(statement);
  if (text.includes('SELECT credential_id')) return { rows: [{ credential_id: selectedId }] };
  if (text.includes('SELECT * FROM wallet_recharge_order_origins')) {
    if (failLookup) throw new Error('Synthetic lookup interruption');
    return { rows: origins.has(String(params[0])) ? [origins.get(String(params[0]))!] : [] };
  }
  if (text.includes('FROM admin_api_credentials')) {
    const row = credentials.find(value => value.id === params[0]);
    return { rows: row ? [{ api_key: row.apiKey, api_secret: row.apiSecret, is_encrypted: row.isEncrypted, is_active: row.isActive, platform: row.platform }] : [] };
  }
  if (text.includes('FROM system_integrations')) return { rows: [{ default_config: systemConfig }] };
  if (text.includes('INSERT INTO wallet_recharge_order_origins')) {
    if (failInsert) throw new Error('Synthetic persistence interruption');
    const [order_id, user_id, organization_id, credential_source, credential_id, key_id, amount_paise, currency, credits, recharge_rate] = params;
    origins.set(String(order_id), { order_id, user_id, organization_id, credential_source, credential_id, key_id, amount_paise, currency, credits, recharge_rate });
    return { rows: [] };
  }
  throw new Error('Unexpected synthetic database query');
});
function select() {
  let tableName = '';
  let condition: SQL;
  const rows = () => {
    if (tableName === 'system_integrations') return [{ defaultConfig: systemConfig }];
    const query = dialect.sqlToQuery(condition);
    const id = query.params.find(value => typeof value === 'number');
    return credentials.filter(row => (id === undefined || row.id === id)
      && (!query.sql.includes('is_active') || row.isActive));
  };
  return {
    from(table: Parameters<typeof getTableName>[0]) { tableName = getTableName(table); return this; },
    where(value: SQL) { condition = value; return this; },
    orderBy() { return this; },
    async limit() { return rows().slice(0, 1); },
    then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(rows()).then(resolve, reject); },
  };
}
const fakeDb = { execute, select, transaction: async <T>(work: (tx: { execute: typeof execute }) => Promise<T>) => work({ execute }) };
jest.unstable_mockModule('../models/db.js', () => ({ db: fakeDb }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ decryptAdminCredential: (row: unknown) => row }));
jest.unstable_mockModule('../services/SecretsManager.js', () => ({ decryptValue: (value: string) => value }));
const { razorpayService } = await import('../services/RazorpayService.js');
const authorizations: string[] = [];
const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
  authorizations.push(String((options?.headers as Record<string, string>)?.Authorization));
  if (options?.method === 'POST') {
    const body = JSON.parse(String(options.body));
    afterProviderCreate();
    return { ok: true, json: async () => ({ id: 'order_syntheticA', ...body, status: 'created' }) } as Response;
  }
  return { ok: true, json: async () => ({ id: String(url).split('/').at(-1) }) } as Response;
});
afterAll(() => fetchSpy.mockRestore());
beforeEach(() => {
  selectedId = 1; origins.clear(); failLookup = false; failInsert = false;
  credentials[0].apiKey = 'rzp_live_fixtureA'; credentials[0].apiSecret = 'synthetic-secret-A'; credentials[0].isActive = true;
  credentials[1].isActive = true;
  systemConfig = { keyId: 'rzp_live_system', keySecret: 'synthetic-system-secret' };
  afterProviderCreate = () => {}; authorizations.length = 0; execute.mockClear(); fetchSpy.mockClear();
});
const options = { amount: 100, receipt: 'wallet_7_fixture', recharge: { userId: 7, organizationId: 70, credits: 1000, rechargeRate: 10 },
  notes: { userId: '7', organizationId: '70', credits: '1000', rechargeRate: '10', type: 'wallet_recharge' } };
const signature = (secret = 'synthetic-secret-A') => crypto.createHmac('sha256', secret).update('order_syntheticA|pay_syntheticA').digest('hex');

describe('wallet recharge originating credential', () => {
  it('returns the creating key and persists its identity before exposing checkout when selection changes during provider IO', async () => {
    afterProviderCreate = () => { selectedId = 2; };
    const order = await razorpayService.createOrder(options);
    expect(order).toMatchObject({ id: 'order_syntheticA', keyId: 'rzp_live_fixtureA' });
    expect(origins.get('order_syntheticA')).toMatchObject({ credential_id: 1, user_id: 7, organization_id: 70 });
    expect(execute.mock.calls.filter(([query]) => dialect.sqlToQuery(query).sql.includes('SELECT credential_id'))).toHaveLength(1);
  });

  it('uses a retained inactive originating credential for HMAC and both provider reads after another credential is selected', async () => {
    await razorpayService.createOrder(options);
    selectedId = 2; credentials[0].isActive = false; execute.mockClear(); authorizations.length = 0;
    const context = await razorpayService.getRechargeVerificationContext('order_syntheticA', 7, 70);
    expect(context.verifyPayment('order_syntheticA', 'pay_syntheticA', signature())).toBe(true);
    await Promise.all([context.getPaymentDetails('pay_syntheticA'), context.getOrderDetails('order_syntheticA')]);
    expect(authorizations).toEqual(Array(2).fill(`Basic ${Buffer.from('rzp_live_fixtureA:synthetic-secret-A').toString('base64')}`));
    expect(execute.mock.calls.some(([query]) => dialect.sqlToQuery(query).sql.includes('SELECT credential_id'))).toBe(false);
    expect(context.verifyPayment('order_other', 'pay_syntheticA', signature())).toBe(false);
    expect(await context.getOrderDetails('order_other')).toBeNull();
  });

  it.each([[8, 70], [7, 71]])('denies a known order for actor%s/payer%s before provider IO', async (actor, payer) => {
    await razorpayService.createOrder(options); fetchSpy.mockClear(); execute.mockClear();
    await expect(razorpayService.getRechargeVerificationContext('order_syntheticA', actor, payer)).rejects.toMatchObject({ status: 404, code: 'RECHARGE_ORDER_FORBIDDEN' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(execute.mock.calls).toHaveLength(1);
  });

  it('fails closed on origin lookup errors without selecting a legacy context', async () => {
    failLookup = true;
    await expect(razorpayService.getRechargeVerificationContext('order_syntheticA', 7, 70)).rejects.toMatchObject({ status: 503, code: 'RECHARGE_ORIGIN_UNAVAILABLE' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(execute.mock.calls).toHaveLength(1);
  });

  it('does not expose checkout or automatically retry creation when origin persistence fails', async () => {
    failInsert = true;
    await expect(razorpayService.createOrder(options)).rejects.toMatchObject({ code: 'RECHARGE_ORIGIN_UNAVAILABLE' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(origins.size).toBe(0);
  });

  it('does not expose checkout if the captured credential identity changes during provider IO', async () => {
    afterProviderCreate = () => { credentials[0].apiSecret = 'replacement-secret'; };
    await expect(razorpayService.createOrder(options)).rejects.toMatchObject({ status: 409, code: 'RECHARGE_CREDENTIAL_CHANGED' });
    expect(fetchSpy).toHaveBeenCalledTimes(1); expect(origins.size).toBe(0);
  });

  it('does not substitute the selected credential when the known original identity is unavailable', async () => {
    await razorpayService.createOrder(options); selectedId = 2; credentials[0].apiKey = 'rzp_live_changed'; fetchSpy.mockClear();
    await expect(razorpayService.getRechargeVerificationContext('order_syntheticA', 7, 70)).rejects.toMatchObject({ code: 'RECHARGE_ORIGIN_REVIEW_REQUIRED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses exactly one captured currently resolved context for genuinely unbound legacy orders', async () => {
    const context = await razorpayService.getRechargeVerificationContext('order_syntheticA', 7, 70);
    expect(context.origin).toBeNull(); selectedId = 2;
    expect(context.verifyPayment('order_syntheticA', 'pay_syntheticA', signature())).toBe(true);
    await Promise.all([context.getPaymentDetails('pay_syntheticA'), context.getOrderDetails('order_syntheticA')]);
    expect(authorizations).toEqual(Array(2).fill(`Basic ${Buffer.from('rzp_live_fixtureA:synthetic-secret-A').toString('base64')}`));
    expect(execute.mock.calls.filter(([query]) => dialect.sqlToQuery(query).sql.includes('SELECT credential_id'))).toHaveLength(1);
  });

  it('preserves sub-four-decimal quote rates without reading a replacement rate', async () => {
    await razorpayService.createOrder({ ...options, recharge: { ...options.recharge, credits: 1000.01, rechargeRate: 10.00012345 } });
    const context = await razorpayService.getRechargeVerificationContext('order_syntheticA', 7, 70);
    expect(context.origin?.rechargeRate).toBe(10.00012345);
  });

  it('retains the exact legacy system source for newly bound orders when an admin credential is later selected', async () => {
    selectedId = 0; credentials.forEach(row => { row.isActive = false; });
    const order = await razorpayService.createOrder(options);
    expect(order?.keyId).toBe('rzp_live_system');
    expect(origins.get('order_syntheticA')).toMatchObject({ credential_source: 'system', credential_id: null });
    selectedId = 2; credentials[1].isActive = true; authorizations.length = 0;
    const context = await razorpayService.getRechargeVerificationContext('order_syntheticA', 7, 70);
    expect(context.verifyPayment('order_syntheticA', 'pay_syntheticA', signature('synthetic-system-secret'))).toBe(true);
    await context.getPaymentDetails('pay_syntheticA');
    expect(authorizations).toEqual([`Basic ${Buffer.from('rzp_live_system:synthetic-system-secret').toString('base64')}`]);
    systemConfig = { keyId: 'rzp_live_replacedSystem', keySecret: 'replacement-secret' };
    await expect(razorpayService.getRechargeVerificationContext('order_syntheticA', 7, 70)).rejects.toMatchObject({ code: 'RECHARGE_ORIGIN_REVIEW_REQUIRED' });
  });

  it('never treats a malformed known origin as an unbound legacy order', async () => {
    origins.set('order_syntheticA', { order_id: 'order_syntheticA', user_id: 7, organization_id: 70,
      credential_source: 'admin', credential_id: null, key_id: 'rzp_live_fixtureA', amount_paise: 10000,
      currency: 'INR', credits: 1000, recharge_rate: 10 });
    await expect(razorpayService.getRechargeVerificationContext('order_syntheticA', 7, 70)).rejects.toMatchObject({ code: 'RECHARGE_ORIGIN_REVIEW_REQUIRED' });
    expect(fetchSpy).not.toHaveBeenCalled(); expect(execute.mock.calls).toHaveLength(1);
  });
});
