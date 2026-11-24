import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
// @ts-expect-error Application migrations use the JavaScript migration runner.
import { up as up595 } from '../migrations/595_whatsapp_platform_billing.js';
// @ts-expect-error Application migrations use the JavaScript migration runner.
import { up as up596 } from '../migrations/596_whatsapp_billing_scope_classification.js';
// @ts-expect-error Application migrations use the JavaScript migration runner.
import { up as up599 } from '../migrations/599_whatsapp_billing_payment_issue.js';
// @ts-expect-error Application migrations use the JavaScript migration runner.
import { up as up600 } from '../migrations/600_whatsapp_charge_outreach_batch.js';
// @ts-expect-error Application migrations use the JavaScript migration runner.
import { up as up601 } from '../migrations/601_whatsapp_volume_tiers_and_invoices.js';

/**
 * WhatsApp platform billing against real PostgreSQL: the migrations apply, and
 * the service's own SQL (market prefix match, versioned rates, daily cap,
 * wamid binding, settlement, payment-problem flags, the stale sweep and quotes)
 * behaves as the unit tests assume. The wallet, Meta and pricing lookups are
 * fakes; everything else is the real query against real tables.
 *
 * Runs only with WHATSAPP_BILLING_QA_DATABASE_URL pointing at a disposable
 * database named whatsapp_billing_qa on loopback. Everything happens in one
 * transaction, in a throwaway schema, and is rolled back.
 */
const connectionString = process.env.WHATSAPP_BILLING_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `whatsapp_billing_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let database: NodePgDatabase;

const wallet = { balance: 100, next: 500, deductions: new Map<number, number>() };
const fees: Record<string, number> = {};
const notifyAllAdmins = jest.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('../models/db.js', () => ({
  db: new Proxy({}, { get: (_target, key) => {
    const value = (database as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === 'function' ? value.bind(database) : value;
  } }),
}));
jest.unstable_mockModule('../services/billing/organizations.js', () => ({ resolveBillingOrganization: async () => 1 }));
jest.unstable_mockModule('../services/CreditService.js', () => ({
  creditService: {
    async deductForEvent({ overrideAmount }: { overrideAmount: number }) {
      if (overrideAmount <= 0) return { success: true, creditsDeducted: 0 };
      if (wallet.balance < overrideAmount) return { success: false, error: 'Insufficient credits. Please recharge your wallet.' };
      wallet.balance -= overrideAmount;
      const transactionId = wallet.next++;
      wallet.deductions.set(transactionId, overrideAmount);
      return { success: true, transactionId };
    },
    async deductOnceForResource({ overrideAmount }: { overrideAmount: number }) {
      if (wallet.balance < overrideAmount) return { success: false };
      wallet.balance -= overrideAmount;
      return { success: true, transactionId: wallet.next++ };
    },
    async settleReservation({ transactionId, actualCredits }: { transactionId: number; actualCredits: number }) {
      const reserved = wallet.deductions.get(transactionId);
      if (reserved === undefined) return { success: true, alreadyRefunded: true };
      wallet.balance += reserved - actualCredits;
      wallet.deductions.delete(transactionId);
      return { success: true };
    },
    async refundDeduction({ transactionId }: { transactionId: number }) {
      const reserved = wallet.deductions.get(transactionId);
      if (reserved === undefined) return { success: false, alreadyRefunded: true };
      wallet.balance += reserved;
      wallet.deductions.delete(transactionId);
      return { success: true };
    },
  },
}));
jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({
  getPricingByKey: async (key: string) => key in fees ? { isActive: true, creditsPerUnit: String(fees[key]) } : undefined,
  getRechargeRate: async () => 10,
}));
jest.unstable_mockModule('../utils/currency.js', () => ({ getUsdToInrRate: () => 85 }));
jest.unstable_mockModule('../models/wallets/functions.js', () => ({ getBalance: async () => wallet.balance }));
jest.unstable_mockModule('../models/adminNotifications/functions.js', () => ({ notifyAllAdmins }));
const resolveCreds = jest.fn(async () => ({ businessAccountId: 'waba-pg', phoneNumberId: 'phone-pg' }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { resolveCreds } }));

const billing = await import('../services/whatsapp/WhatsAppBillingService.js');
const maintenance = await import('../services/whatsapp/WhatsAppBillingMaintenance.js');
const creditLogs = await import('../models/creditEventLogs/functions.js');
const statement = await import('../services/whatsapp/WhatsAppBillingStatement.js');

async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await client!.query(text, params)).rows as T[];
}

const send = (to: string, payload: Record<string, unknown> = { type: 'template', template: { name: 'order_update', language: { code: 'en' } } }) =>
  billing.reserveWhatsAppSend({ userId: 7, wabaId: 'waba-pg', phoneNumberId: 'phone-pg', payload: { to, ...payload } });

suite('WhatsApp platform billing on PostgreSQL', () => {
  beforeAll(async () => {
    const target = connectionString ? new URL(connectionString) : null;
    if (target?.hostname !== '127.0.0.1' || target.pathname !== '/whatsapp_billing_qa') {
      throw new Error('Use a disposable PostgreSQL database named whatsapp_billing_qa on loopback');
    }
    pool = new pg.Pool({ connectionString });
    client = await pool.connect();
    database = drizzle(client);
    await client.query('BEGIN');
    // Just enough of the platform schema for 595's foreign keys, grants and
    // row security to apply. Role creation is transactional and rolled back.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salesmarketing_business_runtime') THEN
          CREATE ROLE salesmarketing_business_runtime NOLOGIN;
        END IF;
      END $$;
      CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}; SET LOCAL timezone = 'UTC';
      CREATE TABLE users (id integer PRIMARY KEY);
      CREATE TABLE company_settings (id integer PRIMARY KEY);
      CREATE TABLE credit_pricing (id serial PRIMARY KEY, event_key text UNIQUE);
      CREATE TABLE wallet_transactions (user_id integer, reference_type text, reference_id text, type text);
      CREATE TABLE business_scope_tables (table_name text PRIMARY KEY, owner_column text, global_read boolean, parent_links jsonb);
      CREATE TABLE business_scope_accounts (table_name text PRIMARY KEY);
      CREATE TABLE whatsapp_templates (id serial PRIMARY KEY, user_id integer, name text, language text, category text);
      CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE FUNCTION app_business_access(integer) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION enforce_business_ownership() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
      INSERT INTO users VALUES (7); INSERT INTO company_settings VALUES (1);
      INSERT INTO whatsapp_templates(user_id, name, language, category) VALUES (7, 'order_update', 'en', 'UTILITY');
      CREATE TABLE outreach_batches (id uuid PRIMARY KEY, name text);
      CREATE TABLE outreach_messages (id serial PRIMARY KEY, user_id integer, batch_id uuid, direction text,
        external_message_id text, provider_message_id text, waba_message_id text);
      CREATE TABLE chat_threads (id serial PRIMARY KEY, user_id integer, business_id integer, title varchar(255), selected_agent varchar(255),
        metadata jsonb, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), deleted_at timestamp, deleted_by integer);
      CREATE TABLE credit_event_logs (business_profile_id integer DEFAULT 1, id serial PRIMARY KEY, organization_id integer, user_id integer,
        event_key varchar(100), credits_used numeric(10,2), balance_after numeric(12,2), description text, service varchar(100),
        reference_type varchar(100), reference_id varchar(255), api_provider varchar(50), api_cost_cents numeric(20,8),
        wallet_transaction_id integer, metadata jsonb, created_at timestamp NOT NULL DEFAULT now());
    `);
    await up595(client);
    await up596(client);
    await up599(client);
    await up600(client);
    await up601(client);
    await client.query(`
      INSERT INTO whatsapp_rate_markets(calling_code, market) VALUES ('1', 'North America'), ('9715', 'UAE Mobile'), ('971', 'UAE');
      INSERT INTO whatsapp_rate_cards(market, category, currency, rate, effective_from) VALUES
        ('India', 'marketing', 'INR', 0.8631, '2026-01-01'), ('India', 'utility', 'INR', 0.115, '2026-01-01'),
        ('India', 'authentication', 'INR', 0.115, '2026-01-01'), ('India', 'service', 'INR', 0.1, '2026-01-01'),
        ('India', 'utility', 'INR', 0.2, '2020-01-01'),
        ('India', 'utility', 'INR', 9.99, current_date + 30),
        ('UAE Mobile', 'utility', 'INR', 1.5, '2026-01-01'), ('UAE', 'utility', 'INR', 3, '2026-01-01');
      INSERT INTO whatsapp_billing_accounts(waba_id, billing_mode, currency, user_id) VALUES ('waba-pg', 'platform', 'INR', 7);
    `);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool?.end();
  });

  beforeEach(async () => {
    process.env.WHATSAPP_PLATFORM_BILLING_ENABLED = 'true';
    Object.assign(wallet, { balance: 100 });
    for (const key of Object.keys(fees)) delete fees[key];
    notifyAllAdmins.mockClear();
    await client!.query(`DELETE FROM whatsapp_message_charges; UPDATE whatsapp_billing_accounts
      SET daily_spend_cap_credits = NULL, payment_issue_at = NULL, payment_issue_detail = NULL`);
  });

  it('classifies every billing table so the API can start', async () => {
    const [scoped] = await query<{ n: number }>(`SELECT count(*)::int n FROM business_scope_tables WHERE table_name = 'whatsapp_message_charges'`);
    const global = await query<{ table_name: string }>('SELECT table_name FROM business_scope_accounts ORDER BY 1');
    expect(scoped.n).toBe(1);
    expect(global.map(row => row.table_name)).toEqual(['whatsapp_billing_accounts', 'whatsapp_billing_invoices', 'whatsapp_billing_reconciliation',
      'whatsapp_rate_cards', 'whatsapp_rate_markets', 'whatsapp_rate_tiers']);
  });

  it("reserves today's rate for the longest matching calling code", async () => {
    const india = await send('919876543210');
    expect(india?.credits).toBe(1.15);
    await send('971501234567');
    const charges = await query<{ recipient_market: string; reserved_rate: string; expected_category: string; status: string }>(
      'SELECT recipient_market, reserved_rate, expected_category, status FROM whatsapp_message_charges ORDER BY id');
    expect(charges).toEqual([
      { recipient_market: 'India', reserved_rate: '0.115000', expected_category: 'utility', status: 'reserved' },
      { recipient_market: 'UAE Mobile', reserved_rate: '1.500000', expected_category: 'utility', status: 'reserved' },
    ]);
    expect(wallet.balance).toBe(100 - 1.15 - 15);
  });

  it('sends a support reply to an unknown country (no rate there) reserved at 0', async () => {
    await expect(send('4420000000', { type: 'text' })).resolves.toMatchObject({ credits: 0 });
    const [charge] = await query<{ recipient_market: string; message_kind: string; reserved_credits: string }>(
      'SELECT recipient_market, message_kind, reserved_credits FROM whatsapp_message_charges');
    expect(charge).toEqual({ recipient_market: 'Unknown', message_kind: 'service', reserved_credits: '0.00' });
  });

  it('enforces the daily cap from real totals, ignoring refunded charges', async () => {
    await client!.query(`UPDATE whatsapp_billing_accounts SET daily_spend_cap_credits = 2.5`);
    await send('919876543210');
    await send('919876543210');
    await expect(send('919876543210')).rejects.toMatchObject({ code: 'WHATSAPP_DAILY_SPEND_CAP' });
    await client!.query(`UPDATE whatsapp_message_charges SET status = 'refunded' WHERE id = (SELECT min(id) FROM whatsapp_message_charges)`);
    await expect(send('919876543210')).resolves.toMatchObject({ credits: 1.15 });
  });

  it('binds the wamid, settles once from the delivery webhook, and ignores the repeat', async () => {
    const charge = (await send('919876543210'))!;
    await billing.markWhatsAppSendAccepted(charge, 'wamid.pg1');
    const delivered = { phoneNumberId: 'phone-pg', wamid: 'wamid.pg1', status: 'delivered',
      pricing: { billable: true, pricing_model: 'PMP', type: 'regular', category: 'utility' } };
    await expect(billing.settleWhatsAppChargeFromStatus(delivered)).resolves.toBe('settled');
    await expect(billing.settleWhatsAppChargeFromStatus({ ...delivered, status: 'read' })).resolves.toBe('skipped');
    const [row] = await query<{ status: string; charged_credits: string; meta_category: string }>(
      'SELECT status, charged_credits, meta_category FROM whatsapp_message_charges');
    expect(row).toEqual({ status: 'settled', charged_credits: '1.15', meta_category: 'utility' });
    expect(wallet.balance).toBeCloseTo(98.85);
  });

  it('refunds a failed delivery and flags a payment problem once per 6 hours', async () => {
    const payment = [{ code: 131042, title: 'Business eligibility payment issue' }];
    for (const wamid of ['wamid.pg2', 'wamid.pg3']) {
      const charge = (await send('919876543210'))!;
      await billing.markWhatsAppSendAccepted(charge, wamid);
      await expect(billing.settleWhatsAppChargeFromStatus({ phoneNumberId: 'phone-pg', wamid, status: 'failed', errors: payment }))
        .resolves.toBe('refunded');
    }
    expect(wallet.balance).toBe(100);
    expect(notifyAllAdmins).toHaveBeenCalledTimes(1);
    const [account] = await query<{ flagged: boolean; payment_issue_detail: string }>(
      `SELECT payment_issue_at IS NOT NULL AS flagged, payment_issue_detail FROM whatsapp_billing_accounts WHERE waba_id = 'waba-pg'`);
    expect(account).toEqual({ flagged: true, payment_issue_detail: 'Meta error 131042: Business eligibility payment issue' });

    const charge = (await send('919876543210'))!;
    await billing.markWhatsAppSendAccepted(charge, 'wamid.pg4');
    await billing.settleWhatsAppChargeFromStatus({ phoneNumberId: 'phone-pg', wamid: 'wamid.pg4', status: 'delivered',
      pricing: { billable: true, pricing_model: 'PMP', type: 'regular', category: 'utility' } });
    const [cleared] = await query<{ flagged: boolean }>(`SELECT payment_issue_at IS NOT NULL AS flagged FROM whatsapp_billing_accounts`);
    expect(cleared.flagged).toBe(false);
  });

  it('sweeps reservations Meta never confirmed into review', async () => {
    await send('919876543210'); // a fresh one stays reserved
    const charge = (await send('919876543210'))!;
    await client!.query(`UPDATE whatsapp_message_charges SET created_at = now() - interval '8 days', updated_at = now() - interval '8 days' WHERE id = $1`, [charge.id]);
    await expect(maintenance.sweepStaleWhatsAppCharges()).resolves.toBe(1);
    const [row] = await query<{ status: string }>('SELECT status FROM whatsapp_message_charges WHERE id = $1', [charge.id]);
    expect(row.status).toBe('needs_review');
  });

  it('links charges to their outreach and groups wallet spend per outreach', async () => {
    const batch = '11111111-1111-4111-8111-111111111111';
    await client!.query(`INSERT INTO outreach_batches VALUES ($1, 'Diwali offer')`, [batch]);
    await client!.query(`INSERT INTO outreach_messages(user_id, batch_id, direction, waba_message_id)
      VALUES (7, $1, 'outbound', 'wamid.batch1'), (7, $1, 'outbound', 'wamid.batch2')`, [batch]);
    const delivered = { billable: true, pricing_model: 'PMP', type: 'regular', category: 'utility' };
    const charges: number[] = [];
    for (const wamid of ['wamid.batch1', 'wamid.batch2', 'wamid.reply']) {
      const charge = (await send('919876543210'))!;
      charges.push(charge.id);
      await billing.markWhatsAppSendAccepted(charge, wamid);
      await billing.settleWhatsAppChargeFromStatus({ phoneNumberId: 'phone-pg', wamid, status: 'delivered', pricing: delivered });
    }
    const linked = await query<{ outreach_batch_id: string | null }>('SELECT outreach_batch_id FROM whatsapp_message_charges ORDER BY id');
    expect(linked.map(row => row.outreach_batch_id)).toEqual([batch, batch, null]);

    await client!.query(`INSERT INTO chat_threads(id, user_id, title) VALUES (5, 7, 'Lead research')`);
    await client!.query(`INSERT INTO credit_event_logs(organization_id, user_id, event_key, credits_used, balance_after, reference_type, reference_id) VALUES
        (1, 7, 'outreach_whatsapp_meta', 1.15, 90, 'whatsapp_message_charge', $1), (1, 7, 'outreach_whatsapp_meta', 1.15, 89, 'whatsapp_message_charge', $2),
        (1, 7, 'outreach_whatsapp_meta', 0.5, 88, 'whatsapp_message_charge_topup', $2), (1, 7, 'outreach_whatsapp_meta', 1.15, 87, 'whatsapp_message_charge', $3),
        (1, 7, 'content_generation', 3, 84, 'chat_thread', '5')`, charges.map(String));
    const { groups, total } = await creditLogs.getCreditEventsByReference(7);
    expect(total).toBe(3);
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceType: 'whatsapp_outreach', referenceId: batch, title: 'Diwali offer', totalCredits: 2.8 }),
      expect.objectContaining({ referenceType: 'whatsapp_outreach', referenceId: 'other_messages', title: 'WhatsApp replies and other messages', totalCredits: 1.15 }),
      expect.objectContaining({ referenceType: 'chat_thread', referenceId: '5', title: 'Lead research', totalCredits: 3 }),
    ]));
    const details = await creditLogs.getCreditEventDetails(7, 'whatsapp_outreach', batch);
    expect(details.total).toBe(3);
    const providers = await creditLogs.getCreditEventProviderBreakdown(7, 'whatsapp_outreach', 'other_messages');
    expect(providers).toEqual([expect.objectContaining({ totalCredits: 1.15 })]);
    await expect(creditLogs.getCreditEventsByReference(7, { referenceType: 'whatsapp_outreach' })).resolves.toMatchObject({ total: 2 });
  });

  it("builds the month's statement with volume tiers, Meta's counts and the invoice", async () => {
    const delivered = (category: string) => ({ billable: true, pricing_model: 'PMP', type: 'regular', category });
    for (const [index, payload] of [
      { type: 'template', template: { name: 'order_update', language: { code: 'en' } } },
      { type: 'template', template: { name: 'order_update', language: { code: 'en' } } },
      { type: 'template', template: { name: 'order_update', language: { code: 'en' } } },
      { type: 'template', template: { name: 'promo', language: { code: 'en' } } },
    ].entries()) {
      const charge = (await send('919876543210', payload))!;
      await billing.markWhatsAppSendAccepted(charge, `wamid.stmt${index}`);
      await billing.settleWhatsAppChargeFromStatus({ phoneNumberId: 'phone-pg', wamid: `wamid.stmt${index}`, status: 'delivered',
        pricing: delivered(index === 3 ? 'marketing' : 'utility') });
    }
    const month = (await query<{ month: string }>(`SELECT to_char(now(), 'YYYY-MM') AS month`))[0].month;
    await client!.query(`INSERT INTO whatsapp_rate_tiers(market, category, currency, effective_from, volume_from, volume_to, rate) VALUES
      ('India', 'utility', 'INR', '2026-01-01', 0, 2, 0.115), ('India', 'utility', 'INR', '2026-01-01', 2, NULL, 0.05)`);
    await client!.query(`INSERT INTO whatsapp_billing_reconciliation(waba_id, day, category, meta_volume, meta_cost, currency)
      VALUES ('waba-pg', current_date, 'utility', 3, 0, 'INR'), ('waba-pg', current_date, 'marketing', 1, 0, 'INR')`);
    await statement.saveWhatsAppInvoice({ month, currency: 'INR', amount: 1.15, reference: 'INV-1', adminId: 1 });
    await statement.saveWhatsAppInvoice({ month, currency: 'INR', amount: 1.2, reference: 'INV-1', adminId: 1 });

    const result = await statement.buildWhatsAppStatement(month, 'INR');
    expect(result.tierVersion).toBe('2026-01-01');
    expect(result.lines).toEqual([
      expect.objectContaining({ category: 'marketing', messages: 1, listCost: 0.8631, expectedCost: 0.8631, tiered: false }),
      expect.objectContaining({ category: 'utility', messages: 3, listCost: 0.345, expectedCost: 0.28, tiered: true }),
    ]);
    expect(result.totals).toMatchObject({ messages: 4, listCost: 1.2081, expectedCost: 1.1431, tierSavings: 0.065, metaMessages: 4 });
    expect(result.accounts).toEqual([expect.objectContaining({ wabaId: 'waba-pg', userId: 7, metaMessages: 4 })]);
    expect(result.invoice).toMatchObject({ amount: 1.2, reference: 'INV-1' });
    expect(result.difference).toBe(0.06);
    await expect(statement.buildWhatsAppStatement('2020-01', 'INR')).resolves.toMatchObject({ lines: [], invoice: null, difference: null, tierVersion: null });
  });

  it('quotes a batch from the latest rate per market and category', async () => {
    fees.outreach_whatsapp_platform = 2;
    const quote = await billing.quoteWhatsAppBatch({ userId: 7, items: [
      { recipient: '919876543210', templateName: 'order_update', templateLanguage: 'en' },
      { recipient: '971501234567', templateName: 'order_update', templateLanguage: 'en' },
      { recipient: '919876543210' },
    ] });
    expect(quote).toMatchObject({ platformBilled: true, messageCredits: 17.15, platformFeeCredits: 6, totalCredits: 23.15, missingRates: [], sufficient: true });
    await client!.query(`DELETE FROM whatsapp_rate_cards WHERE category = 'service'`);
    const missing = await billing.quoteWhatsAppBatch({ userId: 7, items: [{ recipient: '919876543210' }] });
    expect(missing).toMatchObject({ missingRates: ['service / India'], sufficient: false });
  });
});
