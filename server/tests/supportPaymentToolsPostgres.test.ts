import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';
import type { SubAgentContext } from '../services/agents/subagents/SubAgentBase.js';

let database: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: (query: Parameters<typeof database.execute>[0]) => database.execute(query) } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
const configuration = jest.fn<(userId: number) => Promise<Record<string, unknown>>>();
jest.unstable_mockModule('../services/booking/PaymentProvider.js', () => ({
  getHotelPaymentConfiguration: configuration, isMockPaymentAllowed: () => false,
}));
const { PaymentSubAgent } = await import('../services/agents/subagents/PaymentSubAgent.js');
const agent = new PaymentSubAgent();
const context = (changes: Partial<SubAgentContext> = {}) => ({ userId: 9, businessProfileId: 7,
  conversationId: 20, lead: { id: 30 }, ...changes } as SubAgentContext);
const scoped = <T>(work: () => T, businessProfileId = 7, userId = 9) => withBusinessScope({ userId, businessProfileId }, work);
const local = process.env.SUPPORT_KNOWLEDGE_LOCAL_QA === '1' ? describe : describe.skip;

local('support payment tools against isolated PostgreSQL customer and business boundaries', () => {
  let admin: Pool; let fixture: Pool; let runtime: Pool; let schema: string;
  beforeAll(async () => {
    dotenv.config({ path: '.env', quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Payment QA requires local PostgreSQL');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_payment_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    fixture = new Pool({ ...config, max: 1, options: `-c search_path=${schema},pg_catalog` });
    await localBusinessFunctions(fixture);
    await fixture.query(`CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer);
      INSERT INTO company_settings VALUES(7,9),(17,9),(8,10);
      CREATE TABLE bookings(id integer PRIMARY KEY,user_id integer,business_profile_id integer,
        lead_id integer,outreach_conversation_id integer,status text,payment_status text,payment_link text,
        payment_provider text,total_price numeric,currency text);`);
    await localBusinessIsolation(fixture, schema, ['bookings']);
    runtime = createBusinessScopedPool(new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog` }));
    database = drizzle(runtime);
  });
  afterAll(async () => {
    await runtime?.end(); await fixture?.end();
    if (admin && /^support_payment_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    configuration.mockReset().mockResolvedValue({ paymentMethodsEnabled: true, provider: 'razorpay',
      methods: { manual: { enabled: true, instructions: 'Pay at reception.' } } });
    await fixture.query(`TRUNCATE bookings;
      INSERT INTO bookings VALUES
      (21,9,7,30,20,'pending_payment','pending','https://payments.example.test/current','razorpay',100,'INR'),
      (22,9,7,31,21,'pending_payment','pending','https://payments.example.test/other-customer','razorpay',200,'INR'),
      (23,9,7,30,21,'pending_payment','pending','https://payments.example.test/same-lead','razorpay',300,'INR'),
      (24,9,7,31,20,'pending_payment','pending','https://payments.example.test/same-conversation','razorpay',400,'INR'),
      (25,9,17,30,20,'pending_payment','pending','https://payments.example.test/other-business','razorpay',500,'INR'),
      (26,10,8,30,20,'pending_payment','pending','https://payments.example.test/other-owner','razorpay',600,'INR'),
      (27,9,7,NULL,-50,'pending_payment','pending','https://payments.example.test/widget','razorpay',700,'INR');`);
  });
  for (const tool of ['check_payment_status', 'send_payment_link']) {
    it.each([21, 23, 24])(`${tool} allows booking %s bound to the current customer or conversation`, async bookingId => scoped(async () => {
      const result = await agent.execute(tool, { booking_id: bookingId }, context());
      expect(result.toolResults?.[0].result).toMatchObject({ success: true, confirmedSideEffect: false, booking_id: bookingId });
      expect(result.effectProposals).toBeUndefined();
    }));
    it.each([22, 25, 26, 999])(`${tool} does not expose unrelated booking %s`, async bookingId => scoped(async () => {
      const result = await agent.execute(tool, { booking_id: bookingId }, context());
      expect(result.toolResults?.[0].result.success).not.toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/payments\.example|total_price|currency/);
    }));
    it(`${tool} accepts only the authenticated widget session's negative conversation`, async () => scoped(async () => {
      for (const widgetSession of [undefined, { id: 51, token: 'synthetic-session' }]) {
        const result = await agent.execute(tool, { booking_id: 27 }, context({ conversationId: -50, lead: {}, widgetSession }));
        expect(result.toolResults?.[0].result.success).toBe(false);
      }
      expect((await agent.execute(tool, { booking_id: 27 }, context({ conversationId: -50, lead: {},
        widgetSession: { id: 50, token: 'synthetic-session' } }))).toolResults?.[0].result.success).toBe(true);
    }));
    it(`${tool} denies absent verified customer identity`, async () => scoped(async () => {
      expect((await agent.execute(tool, { booking_id: 21 }, context({ conversationId: -1, lead: {} })))
        .toolResults?.[0].result.success).toBe(false);
    }));
  }
  it.each(['javascript:alert(1)', 'http://payments.example.test/unsafe', 'https://user:password@payments.example.test/unsafe'])('never returns an unsafe payment link %s', async url => scoped(async () => {
    await fixture.query('UPDATE bookings SET payment_link=$1 WHERE id=21', [url]);
    const result = await agent.execute('send_payment_link', { booking_id: 21 }, context());
    expect(result.toolResults?.[0].result.success).not.toBe(true);
    expect(result.toolResults?.[0].result.payment_link).toBeUndefined();
  }));
  it('reports verified pending and paid states without performing a payment', async () => scoped(async () => {
    expect((await agent.execute('check_payment_status', { booking_id: 21 }, context())).toolResults?.[0].result.paid).toBe(false);
    await fixture.query("UPDATE bookings SET payment_status='paid',status='confirmed' WHERE id=21");
    const result = await agent.execute('check_payment_status', { booking_id: 21 }, context());
    expect(result.toolResults?.[0].result).toMatchObject({ paid: true, confirmedSideEffect: false });
    expect(result.crmPipelineStatus).toBe('won');
  }));
  it('returns only configured public payment methods', async () => {
    const result = await agent.execute('get_payment_methods', {}, context());
    expect(configuration).toHaveBeenCalledWith(9);
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, configured: true, confirmedSideEffect: false });
    expect(JSON.stringify(result)).toContain('Pay at reception.');
  });
  it('does not expose disabled payment-method details in external booking mode', async () => {
    configuration.mockResolvedValue({ paymentMethodsEnabled: false, externalBooking: { url: 'https://booking.example.test' },
      methods: { manual: { enabled: true, instructions: 'Disabled private detail' } } });
    const result = await agent.execute('get_payment_methods', {}, context());
    expect(result.toolResults?.[0].result).toMatchObject({ success: true, payment_methods: [], mode: 'external_booking' });
    expect(JSON.stringify(result)).not.toContain('Disabled private detail');
  });
});
