import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { localBusinessFunctions, localBusinessIsolation } from '../../helpers/localBusinessPostgres.js';

export const distributions = [
  { name: 'sparse', leadEvery: 1000, receiptEvery: 100 },
  { name: 'receipt-heavy', leadEvery: 1000, receiptEvery: 2 },
  { name: 'dense-leads', leadEvery: 10, receiptEvery: 100 },
] as const;

/** Deliberately stricter than the application connection parser: URL query
 * parameters could otherwise override the loopback host/database we checked. */
export function validateBenchmarkUrl(value: string | undefined): string {
  if (!value) throw new Error('OUTREACH_QA_DATABASE_URL is required for this opt-in benchmark');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Benchmark requires a valid explicit loopback database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/implementation_synthetic' || url.search || url.hash) {
    throw new Error('Benchmark requires an explicit loopback implementation_synthetic URL without query parameters');
  }
  return value;
}

export type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Subplan Name'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
};
export type ExplainPlan = {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
};
export const planNodes = (plan: PlanNode): PlanNode[] =>
  [plan, ...(plan.Plans || []).flatMap(planNodes)];

/** Proposed query shape only. Start with the SQL emitted by the real service,
 * preserve every parameter/filter, and fail when its expected shape changes. */
function receiptParts(query: { sql: string; params: unknown[] }) {
  const marker = 'OR EXISTS (';
  const receiptStart = query.sql.lastIndexOf(marker);
  if (receiptStart < 0) return null; // Phone channels have no receipt branch.
  const receipt = query.sql.slice(receiptStart);
  const expression = receipt.match(/AND (lower\(trim\(COALESCE[\s\S]*?END\)\)\))=destination/);
  const from = receipt.indexOf('FROM sent_messages receipt WHERE');
  const select = query.sql.indexOf('SELECT destination FROM unnest');
  if (!expression || from < 0 || select < 0 || !receipt.trimEnd().endsWith(')')) {
    throw new Error('Service suppression SQL changed; review the proposed benchmark query');
  }
  const filters = receipt.slice(from).trimEnd().slice(0, -1).replace(expression[0], '');
  return { receiptStart, select, filters, expression: expression[1] };
}

export function materializeReceiptQuery(query: { sql: string; params: unknown[] }) {
  const parts = receiptParts(query);
  if (!parts) return query;
  const { receiptStart, select, filters, expression } = parts;
  const cte = `, suppressed_receipts AS MATERIALIZED (SELECT ${expression} AS destination ${filters})\n`;
  return { ...query, sql: query.sql.slice(0, select) + cte +
    query.sql.slice(select, receiptStart) +
    'OR EXISTS (SELECT 1 FROM suppressed_receipts blocked_receipt WHERE blocked_receipt.destination=address.destination)' };
}

/** A second proposal: one semi-join over the two sources instead of two
 * independent OR subplans. UNION ALL retains all evidence; EXISTS deduplicates. */
export function unionReceiptQuery(query: { sql: string; params: unknown[] }) {
  const parts = receiptParts(query);
  if (!parts) return query;
  const where = query.sql.indexOf('WHERE EXISTS (', parts.select);
  if (where < 0) throw new Error('Service suppression SQL changed; missing lead existence check');
  return { ...query, sql: query.sql.slice(0, where) + `WHERE EXISTS (
    SELECT 1 FROM (SELECT destination FROM suppressed_leads UNION ALL
      SELECT ${parts.expression} AS destination ${parts.filters}) blocked
    WHERE blocked.destination=address.destination)` };
}

export async function createBenchmarkFixture(connectionString: string) {
  validateBenchmarkUrl(connectionString);
  const schema = `suppression_benchmark_${randomBytes(8).toString('hex')}`;
  const connection = { connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 };
  const admin = new Pool(connection);
  const fixture = new Pool({ ...connection, options: `-c search_path=${schema},pg_catalog` });
  let created = false;
  const dispose = async () => {
    await fixture.end();
    try {
      if (created && /^suppression_benchmark_[a-f0-9]{16}$/.test(schema)) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      }
    } finally { await admin.end(); }
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await localBusinessFunctions(fixture);
    await fixture.query(`
      CREATE TABLE company_settings(id int PRIMARY KEY,user_id int);
      INSERT INTO company_settings VALUES(1,991),(2,991),(3,992);
      CREATE TABLE leads(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id int,business_profile_id int,phone text,whatsapp text,email text,
        blacklisted boolean,do_not_contact boolean,email_unsubscribed boolean,deleted_at timestamp);
      CREATE TABLE sent_messages(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id int,business_profile_id int,channel text,recipient_address text,lead_name text,
        bounced_at timestamp,status text,delivery_status text);
      CREATE INDEX sent_messages_user_id_idx ON sent_messages(user_id);
      CREATE INDEX sent_messages_status_idx ON sent_messages(status);
      CREATE INDEX sent_messages_channel_idx ON sent_messages(channel);
      CREATE INDEX sent_messages_delivery_status_idx ON sent_messages(delivery_status);
    `);
    // Apply the relevant real base migrations, never a copied service query.
    // @ts-expect-error Application migrations use the JavaScript migration runner.
    const receiptMigration = await import('../../../migrations/350_outreach_delivery_identity.js');
    // @ts-expect-error Application migrations use the JavaScript migration runner.
    const leadMigration = await import('../../../migrations/584_outreach_suppression_read_indexes.js');
    await receiptMigration.up(fixture);
    await leadMigration.up(fixture);
    await localBusinessIsolation(fixture, schema, ['leads', 'sent_messages']);

    return {
      schema,
      async metadata() {
        return (await fixture.query(`SELECT version() AS version,
          current_setting('jit') AS jit, current_setting('shared_buffers') AS shared_buffers,
          current_setting('work_mem') AS work_mem`)).rows[0];
      },
      async seed(distribution: typeof distributions[number]) {
        await fixture.query('DROP INDEX IF EXISTS benchmark_receipt_destination_idx');
        await fixture.query('TRUNCATE leads,sent_messages RESTART IDENTITY');
        await fixture.query(`INSERT INTO leads(user_id,business_profile_id,phone,email,
            blacklisted,do_not_contact,email_unsubscribed)
          SELECT 991,1,'+91'||(9000000000+i)::text,'guest'||i||'@example.test',
            i % $1 = 0,false,i % 100 = 0 FROM generate_series(1,30000) i`, [distribution.leadEvery]);
        await fixture.query(`INSERT INTO sent_messages(user_id,business_profile_id,channel,
            recipient_address,lead_name,bounced_at,status,delivery_status)
          SELECT 991,1,(ARRAY['email','gmail','resend'])[1+i%3],
            CASE WHEN i%7=0 THEN NULL ELSE ' RECEIPT'||i||'@EXAMPLE.TEST ' END,
            CASE WHEN i%7=0 THEN 'receipt'||i||'@example.test' ELSE 'Synthetic guest' END,
            CASE WHEN i % $1=0 THEN TIMESTAMP '2026-01-01' END,
            CASE WHEN i % $1=0 THEN 'bounced' ELSE 'sent' END,
            CASE WHEN i % $1=0 THEN 'bounced' ELSE 'delivered' END
          FROM generate_series(1,30000) i`, [distribution.receiptEvery]);
        await fixture.query(`
          INSERT INTO leads(user_id,business_profile_id,phone,whatsapp,email,
            blacklisted,do_not_contact,email_unsubscribed,deleted_at) VALUES
            (991,1,'+91 (98888) 00001',NULL,' STOP-RETIRED@EXAMPLE.TEST ',true,false,false,TIMESTAMP '2026-01-01'),
            (991,1,'+919888800002','+91 (98888) 00009','wa-only@example.test',false,true,false,NULL),
            (991,1,'9888800003',NULL,'local-phone@example.test',false,true,false,NULL),
            (991,1,'+919888800004',NULL,'email-only@example.test',false,false,true,NULL),
            (991,2,'+919888800005',NULL,'other-business@example.test',true,false,false,NULL),
            (992,3,'+919888800006',NULL,'other-user@example.test',true,false,false,NULL);
          INSERT INTO sent_messages(user_id,business_profile_id,channel,recipient_address,
            lead_name,bounced_at,status,delivery_status) VALUES
            (991,1,'email',' BOUNCED@EXAMPLE.TEST ',NULL,TIMESTAMP '2026-01-01','bounced','bounced'),
            (991,1,'gmail','','fallback@example.test',NULL,'complained','sent'),
            (991,1,'resend',NULL,'delivery-status@example.test',NULL,'sent','complained'),
            (991,1,'email',NULL,'Not an email',TIMESTAMP '2026-01-01','bounced','bounced'),
            (991,2,'email','foreign@example.test',NULL,TIMESTAMP '2026-01-01','bounced','bounced'),
            (992,3,'email','foreign-user@example.test',NULL,TIMESTAMP '2026-01-01','bounced','bounced');
          ANALYZE company_settings; ANALYZE leads; ANALYZE sent_messages;
        `);
      },
      async candidateIndex() {
        const sql = await readFile(new URL('./proposals/receipt-normalization-index.sql', import.meta.url), 'utf8');
        await fixture.query(sql);
        await fixture.query('ANALYZE sent_messages');
        return (await fixture.query(`SELECT pg_relation_size('benchmark_receipt_destination_idx')::int AS bytes`)).rows[0].bytes as number;
      },
      async dropCandidateIndex() {
        await fixture.query('DROP INDEX IF EXISTS benchmark_receipt_destination_idx');
      },
      async scoped<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = [], businessId = 1, userId = 991): Promise<QueryResult<T>> {
        const client = await fixture.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE salesmarketing_business_runtime');
          await client.query(`SELECT set_config('app.current_user_id',$1,true),
            set_config('app.business_profile_id',$2,true)`, [String(userId), String(businessId)]);
          const result = await client.query<T>(text, values);
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
