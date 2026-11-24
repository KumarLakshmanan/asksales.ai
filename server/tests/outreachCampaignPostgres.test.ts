import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';

// Explicit opt-in only. TEMP tables shadow application tables for this one
// connection and disappear at disconnect; no application data/provider calls.
const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute: (query: SQL) => database.execute(query),
  transaction: (callback: Parameters<typeof database.transaction>[0]) => database.transaction(callback),
} }));
const { reconcileOutreachJobCampaign, reconcilePendingOutreachJobCampaigns, recordOutreachEmailDelivery } = await import('../services/outreach/OutreachJobCampaignService.js');

describePostgres('outreach campaign reconciliation against isolated PostgreSQL tables', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('Outreach QA requires an explicit local PostgreSQL connection');
    }
    client = new Client({ connectionString });
    await client.connect();
    // TEMP-only name resolution: an incomplete fixture must never fall back
    // to updating application tables in public or another saved search path.
    await client.query('SET search_path TO pg_temp, pg_catalog');
    database = drizzle(client);
    await client.query(`
      CREATE TEMP TABLE outreach_campaigns (
        id integer PRIMARY KEY, user_id integer, campaign_type text, status text, settings jsonb,
        start_date timestamp, is_active boolean, messages_sent integer, messages_delivered integer,
        messages_failed integer, launched_at timestamp, completed_at timestamp, updated_at timestamp, created_at timestamp DEFAULT NOW()
      );
      CREATE TEMP TABLE outreach_jobs (
        id integer PRIMARY KEY, user_id integer, campaign_id integer, lead_id integer,
        status text, external_message_id text, metadata jsonb, sequence_step_id integer DEFAULT 1
      );
      CREATE TEMP TABLE sent_messages (
        id integer PRIMARY KEY, user_id integer, campaign_id integer, lead_id integer, message_id text,
        channel text, is_reply boolean DEFAULT false, status text, delivery_status text,
        delivered_at timestamp, opened_at timestamp, bounced_at timestamp, bounce_reason text, updated_at timestamp
      );
    `);
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    await client.query('TRUNCATE pg_temp.sent_messages, pg_temp.outreach_jobs, pg_temp.outreach_campaigns');
    await client.query(`INSERT INTO outreach_campaigns (id, user_id, campaign_type, status, settings, start_date)
      VALUES (9, 12, 'email', 'scheduled', $1::jsonb, NOW())`, [JSON.stringify({
      queueStatus: 'preparing', selectionSnapshot: { leadIds: [73, 74, 75] }, unrelatedSetting: 'keep',
    })]);
    await client.query(`INSERT INTO outreach_jobs (id, user_id, campaign_id, lead_id, status, external_message_id, metadata) VALUES
      (14, 12, 9, 73, 'sent', 'receipt-73', '{}'),
      (15, 12, 9, 74, 'pending', NULL, '{}'),
      (16, 99, 9, 999, 'sent', 'foreign-receipt', '{}')`);
    await client.query(`INSERT INTO sent_messages (id, user_id, campaign_id, lead_id, message_id, channel, status, delivery_status)
      VALUES (1, 12, 9, 73, 'receipt-73', 'resend', 'sent', 'sent'),
        (2, 99, 9, 73, 'receipt-73', 'resend', 'delivered', 'delivered')`);
  });

  it('reconciles enqueue → partial acceptance → confirmed delivery/bounce idempotently and tenant-scoped', async () => {
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({ status: 'running', enqueueComplete: false, total: 2, sent: 1, delivered: 0 });
    expect(await reconcileOutreachJobCampaign(9, 99)).toBeNull();
    expect(await reconcileOutreachJobCampaign(9, 12, { queuedCount: 2, failedBeforeEnqueueCount: 1 }))
      .toMatchObject({ status: 'running', failed: 1 });
    await client.query("UPDATE outreach_jobs SET status = 'failed' WHERE id = 15");
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({ status: 'partial_success', sent: 1, failed: 2, delivered: 0 });
    await recordOutreachEmailDelivery('receipt-73', 'delivered');
    await recordOutreachEmailDelivery('receipt-73', 'delivered');
    await recordOutreachEmailDelivery('receipt-73', 'sent');
    const delivered = await client.query('SELECT messages_sent, messages_delivered, messages_failed, settings FROM outreach_campaigns WHERE id = 9');
    expect(delivered.rows[0]).toMatchObject({ messages_sent: 1, messages_delivered: 1, messages_failed: 2, settings: { unrelatedSetting: 'keep' } });
    await recordOutreachEmailDelivery('receipt-73', 'bounced', 'Fake provider bounce');
    await recordOutreachEmailDelivery('receipt-73', 'sent');
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({ status: 'failed', sent: 1, failed: 3, delivered: 0 });
    const bounced = await client.query('SELECT status, delivery_status FROM sent_messages WHERE id = 1');
    expect(bounced.rows[0]).toEqual({ status: 'bounced', delivery_status: 'bounced' });
  });

  it('a late/replayed enqueue acknowledgement never regresses fast worker completion', async () => {
    await client.query("UPDATE outreach_jobs SET status = 'sent', external_message_id = 'receipt-74' WHERE id = 15");
    const receipt = { queuedCount: 2, failedBeforeEnqueueCount: 1 };
    const expected = { status: 'partial_success', sent: 2, failed: 1, terminal: true };
    expect(await reconcileOutreachJobCampaign(9, 12, receipt)).toMatchObject(expected);
    expect(await reconcileOutreachJobCampaign(9, 12, receipt)).toMatchObject(expected);
    expect(await reconcileOutreachJobCampaign(9, 12, { queuedCount: 3, failedBeforeEnqueueCount: 0 }))
      .toMatchObject({ status: 'needs_attention', queueIssue: 'queue_receipt_conflict', sent: 2, failed: 1 });
  });

  it('retains cancellation and treats missing provider receipts as needing review', async () => {
    await client.query("UPDATE outreach_jobs SET status = 'sent', external_message_id = NULL WHERE id = 15");
    expect(await reconcileOutreachJobCampaign(9, 12, { queuedCount: 2, failedBeforeEnqueueCount: 1 }))
      .toMatchObject({ status: 'needs_attention', sent: 1, uncertain: 1 });
    await client.query("UPDATE outreach_campaigns SET status = 'cancelled' WHERE id = 9");
    await recordOutreachEmailDelivery('receipt-73', 'delivered');
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({ status: 'cancelled', isActive: false });
  });

  it('recovers lost closure only from complete, exact persisted recipient coverage', async () => {
    await client.query(`INSERT INTO outreach_jobs (id, user_id, campaign_id, lead_id, status, external_message_id)
      VALUES (17, 12, 9, 75, 'sent', 'receipt-75')`);
    await client.query("UPDATE outreach_jobs SET status='sent', external_message_id='receipt-74' WHERE id=15");
    await reconcilePendingOutreachJobCampaigns();
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({ status: 'completed', sent: 3, enqueueComplete: true, queueIssue: null });
    const row = await client.query('SELECT settings FROM outreach_campaigns WHERE id=9');
    expect(row.rows[0].settings).toMatchObject({ queueStatus: 'queued', queuedCount: 3, failedBeforeEnqueueCount: 0 });
  });

  it('persists a conflict when recovery closed the queue before the producer reported a lost INSERT acknowledgement', async () => {
    await client.query(`INSERT INTO outreach_jobs (id, user_id, campaign_id, lead_id, status, external_message_id)
      VALUES (17, 12, 9, 75, 'sent', 'receipt-75')`);
    await reconcilePendingOutreachJobCampaigns();
    expect(await reconcileOutreachJobCampaign(9, 12, { queuedCount: 2, failedBeforeEnqueueCount: 1 }))
      .toMatchObject({ status: 'needs_attention', queueIssue: 'queue_receipt_conflict', failed: 0, total: 3 });
    const row = await client.query('SELECT settings FROM outreach_campaigns WHERE id=9');
    expect(row.rows[0].settings).toMatchObject({ queueIssue: 'queue_receipt_conflict', queuedCount: 3, failedBeforeEnqueueCount: 0 });
  });

  it('persists a stalled closure without assuming missing recipients failed or succeeded', async () => {
    await client.query("UPDATE outreach_campaigns SET created_at=NOW()-INTERVAL '20 minutes' WHERE id=9");
    await client.query("UPDATE outreach_jobs SET status='sent', external_message_id='receipt-74' WHERE id=15");
    await reconcilePendingOutreachJobCampaigns();
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({ status: 'needs_attention', queueIssue: 'enqueue_closure_stalled', failed: 0, sent: 2 });
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({ status: 'needs_attention', queueIssue: 'enqueue_closure_stalled' });
  });

  it('will not mark existing jobs failed-before-enqueue after their INSERT acknowledgements were lost', async () => {
    expect(await reconcileOutreachJobCampaign(9, 12, { queuedCount: 0, failedBeforeEnqueueCount: 3 }))
      .toMatchObject({ status: 'needs_attention', queueIssue: 'queue_receipt_conflict', total: 2, sent: 1, failed: 0 });
    expect(await reconcileOutreachJobCampaign(9, 12)).toMatchObject({ status: 'needs_attention', queueIssue: 'queue_receipt_conflict' });
  });

  it('periodically reconciles finalized campaigns even when the last worker update was lost', async () => {
    await reconcileOutreachJobCampaign(9, 12, { queuedCount: 2, failedBeforeEnqueueCount: 1 });
    await client.query("UPDATE outreach_jobs SET status='sent', external_message_id='receipt-74' WHERE id=15");
    await reconcilePendingOutreachJobCampaigns();
    const row = await client.query('SELECT status, messages_sent, messages_failed FROM outreach_campaigns WHERE id=9');
    expect(row.rows[0]).toMatchObject({ status: 'partial_success', messages_sent: 2, messages_failed: 1 });
  });
});
