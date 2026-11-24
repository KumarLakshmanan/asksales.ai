import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Client } from 'pg';
// @ts-expect-error JS migration has no TypeScript declaration.
import { up, down } from '../migrations/245_harden_whatsapp_template_submission_lifecycle.js';

const connectionString = process.env.SUPPORT_TEMPLATE_QA_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
let client: Client;

describePostgres('WhatsApp submission persistence in isolated PostgreSQL temporary tables', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('Template QA requires an explicitly configured local PostgreSQL connection.');
    }
    client = new Client({ connectionString });
    await client.connect();
    await client.query(`CREATE TEMP TABLE whatsapp_templates (
      id integer PRIMARY KEY, submission_status varchar(30) NOT NULL,
      updated_at timestamp NOT NULL DEFAULT NOW(),
      CONSTRAINT whatsapp_templates_submission_status_check CHECK (submission_status IN ('local_draft','approved'))
    )`);
    await up(client);
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => { await client.query('TRUNCATE pg_temp.whatsapp_templates'); });

  it('persists each new state while still rejecting unknown states', async () => {
    for (const [index, state] of ['submitting', 'submission_uncertain', 'submission_failed', 'identity_conflict', 'approved'].entries()) {
      await client.query('INSERT INTO pg_temp.whatsapp_templates(id,submission_status) VALUES($1,$2)', [index, state]);
    }
    await expect(client.query("INSERT INTO pg_temp.whatsapp_templates(id,submission_status) VALUES(10,'invented')"))
      .rejects.toMatchObject({ code: '23514' });
    expect((await client.query('SELECT count(*)::int AS count FROM pg_temp.whatsapp_templates')).rows[0].count).toBe(5);
  });

  it('claims a microsecond revision once without overwriting a concurrent revision', async () => {
    await client.query("INSERT INTO pg_temp.whatsapp_templates(id,submission_status,updated_at) VALUES(3,'local_draft','2026-09-05 00:00:00.123456')");
    const revision = (await client.query('SELECT updated_at::text AS revision FROM pg_temp.whatsapp_templates WHERE id=3')).rows[0].revision;
    const query = "UPDATE pg_temp.whatsapp_templates SET submission_status='submitting',updated_at=$1::timestamp WHERE id=3 AND updated_at=$2::timestamp RETURNING id";
    expect((await client.query(query, ['2026-09-05 00:00:00.124', revision])).rowCount).toBe(1);
    expect((await client.query(query, ['2026-09-05 00:00:00.125', revision])).rowCount).toBe(0);
  });

  it('refuses rollback while a provider outcome remains unresolved', async () => {
    await client.query("INSERT INTO pg_temp.whatsapp_templates(id,submission_status) VALUES(3,'submission_uncertain')");
    await expect(down(client)).rejects.toThrow('Reconcile outstanding');
    expect((await client.query('SELECT submission_status FROM pg_temp.whatsapp_templates WHERE id=3')).rows[0].submission_status)
      .toBe('submission_uncertain');
  });
});
