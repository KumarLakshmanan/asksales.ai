import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  createBenchmarkFixture, distributions, materializeReceiptQuery, planNodes, validateBenchmarkUrl,
  unionReceiptQuery,
  type ExplainPlan,
} from './benchmarks/suppression/fixture.js';

jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
const { getSuppressedRecipients } = await import('../services/outreach/RecipientSuppressionService.js');

// This benchmark has its own opt-in; the ordinary PostgreSQL QA flag is insufficient.
const run = process.env.OUTREACH_SUPPRESSION_BENCHMARK === '1' ? describe : describe.skip;
const trials = distributions.flatMap(distribution =>
  [1, 2].map(trial => ({ ...distribution, trial })));
const dialect = new PgDialect();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const outputPath = resolve(process.env.OUTREACH_SUPPRESSION_BENCHMARK_OUTPUT ||
  fileURLToPath(new URL('../.local/suppression-benchmark/latest.json', import.meta.url)));
let fixture: Awaited<ReturnType<typeof createBenchmarkFixture>> | undefined;
let captured: ReturnType<PgDialect['sqlToQuery']> | undefined;
let materializeReceipts = false;
let unionReceipts = false;
const results: Array<Record<string, unknown>> = [];
let metadata: Record<string, unknown> = {};
const executor = {
  execute: async (query: SQL) => {
    captured = dialect.sqlToQuery(query);
    if (materializeReceipts) captured = materializeReceiptQuery(captured);
    if (unionReceipts) captured = unionReceiptQuery(captured);
    return fixture!.scoped(captured.sql, captured.params);
  },
};
const suppressed = (channel: string, addresses: string[]) =>
  getSuppressedRecipients(991, channel, addresses, executor as never);

// Validate before creating a Pool. Never print the connection string on rejection.
describe('suppression benchmark isolation guard', () => {
  it.each([
    undefined,
    'not-a-url',
    'postgres://example.test/implementation_synthetic',
    'postgres://localhost/production',
    'postgres://localhost/implementation_synthetic?host=example.test',
    'postgres://localhost/implementation_synthetic?dbname=production',
    'https://localhost/implementation_synthetic',
    'postgres://localhost/implementation_synthetic#ignored',
  ])('rejects unsafe benchmark target %#', value => {
    expect(() => validateBenchmarkUrl(value)).toThrow();
  });
  it.each(['postgres://localhost/implementation_synthetic',
    'postgresql://fixture:fixture@127.0.0.1:55463/implementation_synthetic'])('accepts explicit isolated target %#', value => {
    expect(validateBenchmarkUrl(value)).toBe(value);
  });
  it('leaves phone-only SQL unchanged and rejects an unexpected receipt shape', () => {
    const query = { sql: 'SELECT 1', params: [] };
    expect(materializeReceiptQuery(query)).toBe(query);
    expect(unionReceiptQuery(query)).toBe(query);
    expect(() => materializeReceiptQuery({ sql: 'SELECT 1 OR EXISTS (SELECT 1)', params: [] })).toThrow();
  });
});

async function verifySemantics() {
  const phones = ['+91 (98888) 00001', '919888800002', '919888800009',
    '919888800003', '9888800003', '919888800004', '919888800005', '919888800006', '', '+91 (98888) 00001'];
  expect(await suppressed('whatsapp', phones)).toEqual(
    new Set(['919888800001', '919888800002', '919888800009', '9888800003']));
  expect(await suppressed('sms', phones)).toEqual(
    new Set(['919888800001', '919888800002', '919888800003']));
  const emails = [' STOP-RETIRED@EXAMPLE.TEST ', 'wa-only@example.test', 'local-phone@example.test',
    'email-only@example.test', 'BOUNCED@example.test', 'fallback@example.test', 'delivery-status@example.test',
    'receipt100@example.test', 'receipt700@example.test', 'other-business@example.test', 'other-user@example.test',
    'foreign@example.test', 'foreign-user@example.test', 'not-an-email@example.test', '', 'bounced@example.test'];
  const expected = new Set(['stop-retired@example.test', 'wa-only@example.test', 'local-phone@example.test',
    'email-only@example.test', 'bounced@example.test', 'fallback@example.test', 'delivery-status@example.test',
    'receipt100@example.test', 'receipt700@example.test']);
  for (const channel of ['email', 'gmail', 'resend']) {
    expect(await suppressed(channel, emails)).toEqual(expected);
  }
  // A caller cannot read another business through the runtime RLS policy.
  await suppressed('email', ['bounced@example.test', 'foreign@example.test']);
  const query = captured!;
  expect((await fixture!.scoped(query.sql, query.params, 2)).rows).toEqual([{ destination: 'foreign@example.test' }]);
  expect((await fixture!.scoped(query.sql, query.params, 3)).rows).toEqual([]);
}

run('synthetic suppression query benchmark under business RLS', () => {
  beforeAll(async () => {
    const url = validateBenchmarkUrl(process.env.OUTREACH_QA_DATABASE_URL);
    fixture = await createBenchmarkFixture(url);
    metadata = { ...await fixture.metadata(), nodeVersion: process.version,
      serviceSourceSha256: createHash('sha256').update(await readFile(
        new URL('../services/outreach/RecipientSuppressionService.ts', import.meta.url))).digest('hex') };
  }, 30000);

  afterAll(async () => {
    try {
      await fixture?.dispose();
    } finally {
      // Persist completed measurements even if a later assertion fails.
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify({
        evidence: 'Isolated synthetic PostgreSQL only; no production data or provider delivery',
        benchmarkIntroducedAtBase: '1de1a4af9eaee6678fdb00e58cfa9bc33e1e2a42',
        metadata, method: 'One discarded warmup plus three EXPLAIN ANALYZE BUFFERS samples; median execution time',
        fixture: { generatedLeads: 30000, generatedReceipts: 30000, additionalLeads: 6, additionalReceipts: 6 },
        results,
      }, null, 2) + '\n');
    }
  });

  it.each(trials)('compares current and proposed queries for $name trial $trial', async distribution => {
    await fixture!.seed(distribution);
    const baseline = new Map<string, string[]>();
    for (const variant of ['base', 'proposed-receipt-index', 'proposed-materialized-receipts', 'proposed-union-receipts']) {
      materializeReceipts = variant === 'proposed-materialized-receipts';
      unionReceipts = variant === 'proposed-union-receipts';
      if (materializeReceipts || unionReceipts) await fixture!.dropCandidateIndex();
      const indexBytes = variant === 'proposed-receipt-index' ? await fixture!.candidateIndex() : 0;
      await verifySemantics();
      for (const channel of ['whatsapp', 'sms', 'email']) {
        for (const size of [1, 50, 200]) {
          const addresses = Array.from({ length: size }, (_, i) => channel === 'email'
            ? ['absent0@example.test', 'bounced@example.test', 'fallback@example.test', 'stop-retired@example.test', 'receipt700@example.test'][i] || `absent${i}@example.test`
            : ['919888800001', '919888800002', '919888800009'][i] || `91${9000000000 + i}`);
          const actual = [...await suppressed(channel, addresses)].sort();
          const key = `${channel}:${size}`;
          if (variant === 'base') baseline.set(key, actual);
          else expect(actual).toEqual(baseline.get(key));
          const query = captured!;
          const explain = async () => (await fixture!.scoped<{ 'QUERY PLAN': ExplainPlan[] }>(
            'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + query.sql, query.params,
          )).rows[0]['QUERY PLAN'][0];
          await explain(); // Warm cache consistently before measured samples.
          const samples = [await explain(), await explain(), await explain()];
          const plan = samples[2];
          const nodes = planNodes(plan.Plan);
          // An available index need not be chosen. Record the actual plan;
          // requiring one plan shape would conceal the instability being measured.
          if (variant === 'proposed-receipt-index') expect(indexBytes).toBeGreaterThan(0);
          if (materializeReceipts && channel === 'email') {
            const receiptCte = nodes.find(node => node['Subplan Name'] === 'CTE suppressed_receipts');
            expect(receiptCte).toBeDefined();
            expect(receiptCte!['Actual Loops']).toBe(1);
          }
          const leadCte = nodes.find(node => node['Subplan Name'] === 'CTE suppressed_leads');
          expect(leadCte).toBeDefined();
          expect(leadCte!['Actual Loops']).toBe(1);
          results.push({ distribution: distribution.name, trial: distribution.trial, leadEvery: distribution.leadEvery,
            receiptEvery: distribution.receiptEvery, variant, channel, size,
            suppressedCount: actual.length, indexBytes,
            medianExecutionMs: median(samples.map(sample => sample['Execution Time'])),
            medianPlanningMs: median(samples.map(sample => sample['Planning Time'])),
            executionSamplesMs: samples.map(sample => sample['Execution Time']),
            plan, sql: query.sql, params: query.params,
          });
        }
      }
    }
    console.info(`Suppression benchmark completed: ${distribution.name}, trial ${distribution.trial}; evidence: ${outputPath}`);
  }, 120000);
});
