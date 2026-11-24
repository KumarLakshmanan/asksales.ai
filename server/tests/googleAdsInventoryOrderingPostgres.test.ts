import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { Pool, defaults as pgDefaults, types as pgTypes } from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

// This opt-in test only connects to an explicitly named disposable local DB.
const target = process.env.ADS_AVAILABILITY_TEST_DATABASE;
// Match the production driver's UTC handling for timestamp-without-time-zone.
pgDefaults.parseInputDatesAsUTC = true;
pgTypes.setTypeParser(1114, value => new Date(`${value}Z`));
const suite = target ? describe : describe.skip;
let pool: Pool;
const dialect = new PgDialect();
const discovery = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: (query: SQL) => {
  const compiled = dialect.sqlToQuery(query);
  return pool.query(compiled.sql, compiled.params);
} } }));
jest.unstable_mockModule('../controllers/integrationsController.js', () => ({ getGoogleAdsCredentials: async () => ({ clientId: 'offline' }) }));
jest.unstable_mockModule('../services/ads/GoogleAdsService.js', () => ({ discoverGoogleAdsAccounts: discovery }));
const { discoverPaidAdAccounts, listPaidAdAccounts } = await import('../services/ads/PaidAdAccountsService.js');
const owner = <T>(work: () => T) => withBusinessScope({ userId: 41, businessProfileId: 42 }, work);
afterAll(async () => { jest.useRealTimers(); await pool?.end(); });

suite('Google inventory ordering against disposable PostgreSQL', () => {
  it('preserves the newer verified account when an older discovery finishes last', async () => {
    if (!target?.startsWith('asksales_ads_availability_')) throw new Error('A disposable ads availability database is required.');
    pool = new Pool({ host: '127.0.0.1', port: Number(process.env.ADS_AVAILABILITY_TEST_PORT), database: target, user: 'codex_qa', max: 2, options: '-c timezone=UTC' });
    await pool.query(`CREATE TABLE api_credentials (
      id serial PRIMARY KEY,user_id integer,business_profile_id integer,service_name text,is_active boolean,
      api_key text,api_secret text,config jsonb,created_at timestamp DEFAULT NOW());
      CREATE TABLE paid_ad_accounts (
        id serial PRIMARY KEY,user_id integer,business_profile_id integer DEFAULT 42,platform text,provider_account_id text,
        name text,currency text,timezone text,manager_account_id text,credential_source text,credential_id integer,is_manager boolean,
        reporting_available boolean,publishing_available boolean,is_active boolean DEFAULT TRUE,verified_at timestamp,error_code text,updated_at timestamp,
        UNIQUE(business_profile_id,user_id,platform,provider_account_id));
      INSERT INTO api_credentials(user_id,business_profile_id,service_name,is_active,api_key,api_secret,config)
        VALUES(41,42,'google_ads',TRUE,'offline-client','offline-secret','{"refreshToken":"offline","connectedAt":"2026-10-28T10:30:00.000Z"}');`);
    let oldResponse!: (value: unknown) => void;
    let oldStarted!: () => void;
    const started = new Promise<void>(resolve => { oldStarted = resolve; });
    discovery.mockImplementationOnce(() => { oldStarted(); return new Promise(resolve => { oldResponse = resolve; }); });
    const result = (name: string) => ({ accounts: [{ customerId: '1234567890', name, manager: false }], failures: [] });
    discovery.mockResolvedValueOnce(result('Current Google account'));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-28T10:00:00Z'));
    const old = owner(() => discoverPaidAdAccounts(41, 'google'));
    await started;
    jest.setSystemTime(new Date('2026-10-28T11:00:00Z'));
    await owner(() => discoverPaidAdAccounts(41, 'google'));
    oldResponse(result('Old Google account'));
    await old;
    const accounts = await owner(() => listPaidAdAccounts(41));
    expect(accounts.map(account => account.name)).toEqual(['Current Google account']);
    const row = (await pool.query("SELECT verified_at AT TIME ZONE 'UTC' AS verified_at FROM paid_ad_accounts")).rows[0];
    expect(row.verified_at.toISOString()).toBe('2026-10-28T11:00:00.000Z');
  });
});
