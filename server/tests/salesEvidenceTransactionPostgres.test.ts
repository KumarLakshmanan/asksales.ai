import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PaymentEvidenceExecutor } from '../services/insights/SalesEvidence.js';

const directExecute = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const transaction = jest.fn<(work: (tx: PaymentEvidenceExecutor) => Promise<void>) => Promise<void>>();
const scopes = new AsyncLocalStorage<{ userId: number; actorUserId: number; businessProfileId: number }>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: directExecute, transaction } }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({
  requireBusinessScope: () => scopes.getStore() || ({ userId: 7, actorUserId: 7, businessProfileId: 11 }),
}));
const { recordPaymentEvidence } = await import('../services/insights/SalesEvidence.js');
const localQA = process.env.SALES_EVIDENCE_LOCAL_QA === '1' ? describe : describe.skip;
const dialect = new PgDialect();
const container = `sales-evidence-qa-${process.pid}`;
let directory: string;
let socketDirectory: string;
let created = false;
let admin: pg.Client;
const evidence = { bookingId: 4, paymentId: 'manual:receipt-ht05b', amountMinor: 20000, currency: 'INR',
  occurredAt: '2026-10-23T12:00:00.000Z', source: 'manual' as const };

async function connect() {
  const client = new pg.Client({ host: socketDirectory, database: 'sales_evidence_qa', user: 'postgres' });
  await client.connect();
  return client;
}
function executor(client: pg.Client): PaymentEvidenceExecutor {
  return { execute: async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    return client.query(compiled.sql, compiled.params);
  } };
}
async function runTransaction(work: (tx: PaymentEvidenceExecutor, client: pg.Client) => Promise<void>) {
  const client = await connect();
  try {
    await client.query('BEGIN');
    await work(executor(client), client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
}
async function invoke(input: Parameters<typeof recordPaymentEvidence>[0], mode: 'standalone' | 'caller') {
  if (mode === 'caller') await runTransaction(tx => recordPaymentEvidence(input, tx));
  else await recordPaymentEvidence(input);
}

localQA('payment evidence in network-disabled disposable PostgreSQL', () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'sales-evidence-qa-'));
    socketDirectory = join(directory, 'socket');
    mkdirSync(socketDirectory);
    // Only the ephemeral test socket is shared with this network-none container.
    chmodSync(socketDirectory, 0o777);
    execFileSync('docker', ['run', '--detach', '--name', container, '--network', 'none',
      '--tmpfs', '/var/lib/postgresql/data:rw', '--mount', `type=bind,source=${socketDirectory},target=/var/run/postgresql`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=sales_evidence_qa', 'pgvector/pgvector:pg16'], { stdio: 'pipe' });
    created = true;
    for (let attempt = 0; attempt < 40; attempt++) {
      const logs = execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (logs.includes('PostgreSQL init process complete; ready for start up.')) {
        try { admin = await connect(); break; } catch { /* final server may still be restarting */ }
      }
      if (attempt === 39) throw new Error('Disposable sales evidence PostgreSQL did not start.');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await admin.query(`
      CREATE TABLE bookings (id integer PRIMARY KEY, user_id integer, business_profile_id integer,
        currency text, payment_id text, status text, outreach_conversation_id integer);
      CREATE TABLE outreach_conversations (id integer PRIMARY KEY, business_profile_id integer,
        channel text, crm_contact_id integer);
      CREATE TABLE sales_outcome_events (id serial PRIMARY KEY, business_profile_id integer, user_id integer,
        actor_user_id integer, source_key text, kind text, contact_id integer, booking_id integer,
        conversation_kind text, conversation_id integer, channel text, amount numeric(18,2), currency text,
        evidence text, payment_id text, verified boolean, occurred_at timestamptz,
        UNIQUE(business_profile_id,source_key));
      CREATE TABLE qa_reject_capture (enabled boolean);
      INSERT INTO qa_reject_capture VALUES(false);
      CREATE FUNCTION qa_payment_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.kind='payment_captured' AND (SELECT enabled FROM qa_reject_capture) THEN
          RAISE EXCEPTION 'synthetic ledger failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qa_payment_failure BEFORE INSERT ON sales_outcome_events
        FOR EACH ROW EXECUTE FUNCTION qa_payment_failure();
    `);
  }, 30000);

  beforeEach(async () => {
    directExecute.mockReset(); transaction.mockReset();
    transaction.mockImplementation(work => runTransaction(tx => work(tx)));
    await admin.query(`TRUNCATE sales_outcome_events,bookings;
      UPDATE qa_reject_capture SET enabled=false;
      INSERT INTO bookings VALUES(4,7,11,'INR','pay_valid','pending_payment',NULL),
        (5,7,11,'INR','pay_other','confirmed',NULL);`);
  });

  afterAll(async () => {
    if (admin) await admin.end();
    if (created) {
      execFileSync('docker', ['stop', container], { stdio: 'pipe' });
      execFileSync('docker', ['rm', container], { stdio: 'pipe' });
    }
    if (directory) rmSync(directory, { recursive: true });
  }, 30000);

  it('rolls back caller booking confirmation when an INR200 ledger insert trigger fails', async () => {
    await admin.query('UPDATE qa_reject_capture SET enabled=true');
    await expect(runTransaction(async (tx, client) => {
      await client.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      await recordPaymentEvidence(evidence, tx);
    })).rejects.toThrow('synthetic ledger failure');
    expect((await admin.query('SELECT status FROM bookings WHERE id=4')).rows[0].status).toBe('pending_payment');
    expect((await admin.query('SELECT count(*)::integer AS count FROM sales_outcome_events')).rows[0].count).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
    expect(directExecute).not.toHaveBeenCalled();
  });

  it('leaves booking and ledger uncommitted until the caller commits both', async () => {
    const client = await connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      await recordPaymentEvidence(evidence, executor(client));
      expect((await admin.query('SELECT status FROM bookings WHERE id=4')).rows[0].status).toBe('pending_payment');
      expect((await admin.query('SELECT count(*)::integer AS count FROM sales_outcome_events')).rows[0].count).toBe(0);
      await client.query('COMMIT');
      expect((await admin.query('SELECT status FROM bookings WHERE id=4')).rows[0].status).toBe('confirmed');
      expect((await admin.query('SELECT amount FROM sales_outcome_events')).rows).toEqual([{ amount: '200.00' }]);
    } finally { await client.end(); }
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rolls back caller state on payment validation failure', async () => {
    await expect(runTransaction(async (tx, client) => {
      await client.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      await recordPaymentEvidence({ ...evidence, currency: 'USD' }, tx);
    })).rejects.toThrow('Payment currency or booking mismatch.');
    expect((await admin.query('SELECT status FROM bookings WHERE id=4')).rows[0].status).toBe('pending_payment');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects one of two concurrent bookings claiming the same previously unseen source key', async () => {
    await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
    let arrivals = 0;
    let release!: () => void;
    const bothReadEmpty = new Promise<void>(resolve => { release = resolve; });
    const claim = (bookingId: number) => runTransaction(async (tx) => {
      let replayLookupSeen = false;
      const gated: PaymentEvidenceExecutor = { execute: async (query: SQL) => {
        const result = await tx.execute(query);
        const text = dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ');
        if (!replayLookupSeen && text.startsWith('SELECT') && text.includes('FROM sales_outcome_events') && text.includes('source_key')) {
          replayLookupSeen = true;
          expect(result.rows).toHaveLength(0);
          arrivals++;
          if (arrivals === 2) release();
          await bothReadEmpty;
        }
        return result;
      } };
      await recordPaymentEvidence({ ...evidence, bookingId }, gated);
    });
    const results = await Promise.allSettled([claim(4), claim(5)]);
    expect(arrivals).toBe(2);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.message).toBe('Payment identity belongs to a different booking.');
    expect((await admin.query('SELECT count(*)::integer AS count FROM sales_outcome_events')).rows[0].count).toBe(1);
    expect(transaction).not.toHaveBeenCalled();
  }, 10000);

  it('keeps one-argument calls transactional and a same-booking replay idempotent', async () => {
    await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
    await recordPaymentEvidence(evidence);
    await recordPaymentEvidence(evidence);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(directExecute).not.toHaveBeenCalled();
    expect((await admin.query('SELECT count(*)::integer AS count FROM sales_outcome_events')).rows[0].count).toBe(1);
  });

  for (const mode of ['standalone', 'caller'] as const) {
    it(`WI02 rejects a changed amount for an existing receipt (${mode})`, async () => {
      await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      await invoke({ ...evidence, amountMinor: 10000 }, mode);
      await expect(invoke({ ...evidence, amountMinor: 20000 }, mode)).rejects.toThrow();
      expect((await admin.query('SELECT amount FROM sales_outcome_events')).rows).toEqual([{ amount: '100.00' }]);
    });

    it(`WI02 permits the same source key independently in two businesses without relying on RLS (${mode})`, async () => {
      await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4; UPDATE bookings SET business_profile_id=12 WHERE id=5");
      await scopes.run({ userId: 7, actorUserId: 7, businessProfileId: 12 }, () => invoke({ ...evidence, bookingId: 5 }, mode));
      await invoke(evidence, mode);
      expect((await admin.query('SELECT business_profile_id,booking_id FROM sales_outcome_events ORDER BY business_profile_id')).rows)
        .toEqual([{ business_profile_id: 11, booking_id: 4 }, { business_profile_id: 12, booking_id: 5 }]);
    });

    it(`WI03 accepts exact 30 minor capture followed by 10 plus 20 minor refunds (${mode})`, async () => {
      await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      const paid = { ...evidence, source: 'razorpay' as const, paymentId: 'pay_valid', amountMinor: 30 };
      await invoke(paid, mode);
      await invoke({ ...paid, refundId: 'refund-10', amountMinor: 10 }, mode);
      await invoke({ ...paid, refundId: 'refund-20', amountMinor: 20 }, mode);
      expect((await admin.query("SELECT SUM(CASE WHEN kind='payment_captured' THEN amount ELSE -amount END)::text AS remaining FROM sales_outcome_events")).rows)
        .toEqual([{ remaining: '0.00' }]);
      await admin.query("UPDATE bookings SET status='cancelled' WHERE id=4");
      await invoke({ ...paid, refundId: 'refund-20', amountMinor: 20 }, mode);
      expect((await admin.query('SELECT count(*)::integer AS count FROM sales_outcome_events')).rows[0].count).toBe(3);
    });

    it.each([
      ['kind', 'payment_refunded'], ['payment_id', 'different-payment'], ['currency', 'USD'],
      ['evidence', 'razorpay'], ['verified', false],
    ])(`WI02 rejects altered immutable %s in a persisted receipt (${mode})`, async (column, value) => {
      await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      await invoke(evidence, mode);
      // Column names are the fixed synthetic fixture cases above, never user input.
      await admin.query(`UPDATE sales_outcome_events SET ${column}=$1`, [value]);
      await expect(invoke(evidence, mode)).rejects.toThrow('Payment identity was replayed with different evidence.');
      expect((await admin.query('SELECT count(*)::integer AS count FROM sales_outcome_events')).rows[0].count).toBe(1);
    });

    it(`WI02 permits an exact receipt replay after booking cancellation (${mode})`, async () => {
      await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      await invoke(evidence, mode);
      await admin.query("UPDATE bookings SET status='cancelled' WHERE id=4");
      await invoke(evidence, mode);
      expect((await admin.query('SELECT status FROM bookings WHERE id=4')).rows[0].status).toBe('cancelled');
      expect((await admin.query('SELECT count(*)::integer AS count FROM sales_outcome_events')).rows[0].count).toBe(1);
    });

    it(`WI03 serializes concurrent 10 plus 20 minor refunds against 30 minor (${mode})`, async () => {
      await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      const paid = { ...evidence, source: 'razorpay' as const, paymentId: 'pay_valid', amountMinor: 30 };
      await invoke(paid, mode);
      await Promise.all([
        invoke({ ...paid, refundId: 'fractional-first', amountMinor: 10 }, mode),
        invoke({ ...paid, refundId: 'fractional-second', amountMinor: 20 }, mode),
      ]);
      expect((await admin.query("SELECT SUM(CASE WHEN kind='payment_captured' THEN amount ELSE -amount END)::text AS remaining FROM sales_outcome_events")).rows)
        .toEqual([{ remaining: '0.00' }]);
    });

    it(`WI03 rejects one concurrent refund when 20 plus 20 exceeds 30 minor (${mode})`, async () => {
      await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      const paid = { ...evidence, source: 'razorpay' as const, paymentId: 'pay_valid', amountMinor: 30 };
      await invoke(paid, mode);
      const results = await Promise.allSettled([
        invoke({ ...paid, refundId: 'overdraw-first', amountMinor: 20 }, mode),
        invoke({ ...paid, refundId: 'overdraw-second', amountMinor: 20 }, mode),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason.message).toBe('Refund exceeds verified payment.');
      expect((await admin.query("SELECT SUM(CASE WHEN kind='payment_captured' THEN amount ELSE -amount END)::text AS remaining FROM sales_outcome_events")).rows)
        .toEqual([{ remaining: '0.10' }]);
    });

    it(`WI03 stores the largest safe minor amount without a floating-point conversion (${mode})`, async () => {
      await admin.query("UPDATE bookings SET status='confirmed' WHERE id=4");
      await invoke({ ...evidence, amountMinor: Number.MAX_SAFE_INTEGER }, mode);
      expect((await admin.query('SELECT amount FROM sales_outcome_events')).rows).toEqual([{ amount: '90071992547409.91' }]);
    });
  }
});
