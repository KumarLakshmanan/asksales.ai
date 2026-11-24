import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

const execute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const tracking = await import('../services/outreach/OutreachTrackingService.js');
const batches = await import('../services/outreach/OutreachBatchService.js');
const { projectSends } = await import('../services/outreach/OutreachUpcomingProjection.js');
const state = await import('../services/outreach/OutreachDeliveryState.js');

const dialect = new PgDialect();
const scoped = <T>(run: () => Promise<T>) => withBusinessScope({ userId: 7, businessProfileId: 11 }, run);
const query = (call: number) => dialect.sqlToQuery(execute.mock.calls[call][0] as SQL);
const BATCH = '0b0f3c1e-8a55-4a57-9d0f-2f1f0c4f6a10';
const batchRow = {
  id: BATCH, name: 'WhatsApp · spring_sale', channel: 'whatsapp', provider_account_id: 'phone-1', template_name: 'spring_sale',
  template_language: 'en', source: 'new_outreach', status: 'queued', created_at: new Date('2026-11-10T08:00:00Z'), scheduled_at: null,
  expires_at: new Date('2026-12-10T08:00:00Z'), requested_count: 12, skipped_count: 2, skipped_reasons: { 'Lead not found': 2 },
};

beforeEach(() => { execute.mockReset(); });

describe('outreach tracking reads', () => {
  /** Stands in for the database during a recount: the stored row comes back with what the UPDATE wrote. */
  const recountReturns = () => execute.mockImplementation(async (statement: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(statement);
    if (!text.includes('RETURNING *')) return { rows: [] };
    return { rows: [{ ...batchRow, counts: JSON.parse(String(params[0])), follow_up_counts: JSON.parse(String(params[1])),
      next_attempt_at: params[2], last_activity_at: params[3], counts_at: new Date(), counts_dirty: false }] };
  });

  it('counts an outreach that has never been counted from its own messages, and stores the result', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [
      { message_kind: 'outreach', state: 'delivered', count: 6, next_at: null },
      { message_kind: 'outreach', state: 'read', count: 1, next_at: null },
      { message_kind: 'outreach', state: 'waiting_limit', count: 2, next_at: new Date('2026-11-11T00:00:01Z') },
      { message_kind: 'outreach', state: 'expired', count: 1, next_at: null },
      { message_kind: 'follow_up', state: 'sent', count: 3, next_at: null },
    ] });
    recountReturns();

    const summary = await scoped(() => tracking.getOutreachBatchSummary(7, BATCH));

    expect(summary.counts).toMatchObject({ total: 10, delivered: 6, read: 1, waitingLimit: 2, expired: 1 });
    expect(summary.followUps).toMatchObject({ total: 3, sent: 3 });
    expect(summary.nextAttemptAt).toBe('2026-11-11T00:00:01.000Z');
    expect(summary.skippedReasons).toEqual([{ reason: 'Lead not found', count: 2 }]);
    expect(summary.batch).toMatchObject({ id: BATCH, requested: 12, skipped: 2, admission: 'queued', receiptSupport: 'full' });

    // The dirty flag is cleared before counting, so a change during the count is not lost.
    expect(query(1).sql).toContain('SET counts_dirty=false');
    const counts = query(2);
    expect(counts.sql).toContain('m.batch_id=');
    expect(counts.sql).not.toContain('sent_messages');
    expect(counts.sql).not.toContain('outreach_jobs');
    expect(query(3).sql).toContain('counts_at=now()');
  });

  it('reports no single next send time when a waiting message has none recorded', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [
      { message_kind: 'outreach', state: 'waiting', count: 4, next_at: null },
      { message_kind: 'outreach', state: 'scheduled', count: 4, next_at: new Date('2026-11-12T09:00:00Z') },
    ] });
    recountReturns();
    await expect(scoped(() => tracking.getOutreachBatchSummary(7, BATCH))).resolves.toMatchObject({ nextAttemptAt: null });
  });

  it('reads stored counts without counting, unless they are behind and the background job is late', async () => {
    const stored = { ...batchRow, counts: { total: 4, sent: 4 }, follow_up_counts: null, next_attempt_at: null,
      last_activity_at: new Date('2026-11-10T09:00:00Z'), counts_at: new Date(), counts_dirty: true };
    execute.mockResolvedValueOnce({ rows: [stored] });
    const fresh = await scoped(() => tracking.getOutreachBatchSummary(7, BATCH));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fresh.counts).toMatchObject({ total: 4, sent: 4, failed: 0 });
    expect(fresh.lastActivityAt).toBe('2026-11-10T09:00:00.000Z');

    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [{ ...stored, counts_at: new Date(Date.now() - 60_000) }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ message_kind: 'outreach', state: 'read', count: 5, next_at: null }] });
    recountReturns();
    const late = await scoped(() => tracking.getOutreachBatchSummary(7, BATCH));
    expect(late.counts).toMatchObject({ total: 5, read: 5 });
  });

  it('claims dirty outreaches so several workers never recount the same one, and retires dead launches', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'gone' }] }).mockResolvedValueOnce({ rows: [{ id: BATCH }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    recountReturns();
    await expect(tracking.refreshOutreachBatchCounts()).resolves.toEqual({ recounted: 1, failed: 0, interrupted: 1 });
    expect(query(0).sql).toContain("SET status='interrupted'");
    expect(query(1).sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('marks an outreach dirty again when its recount fails', async () => {
    execute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ rows: [] });
    await expect(tracking.recountOutreachBatch(BATCH)).rejects.toThrow('timeout');
    expect(query(2).sql).toContain('SET counts_dirty=true');
  });

  it('answers 404 for an outreach outside the business, and for a malformed id without querying', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(scoped(() => tracking.getOutreachBatchSummary(7, BATCH))).rejects.toMatchObject({ status: 404 });
    await expect(scoped(() => tracking.getOutreachBatchSummary(7, 'not-an-id'))).rejects.toMatchObject({ status: 404 });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(scoped(() => tracking.listOutreachBatches(8))).rejects.toMatchObject({ status: 403 });
  });

  it('pages recipients by message id and filters on the derived state', async () => {
    const row = (id: number) => ({ id, conversation_id: id + 100, lead_id: id + 200, lead_name: `Guest ${id}`, recipient: `9198000000${id}`,
      state: 'failed', sent_at: null, delivered_at: null, read_at: null, failed_at: '2026-11-10T09:00:00Z', next_at: null,
      reason: 'Message undeliverable', provider_code: '131026' });
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [row(1), row(2), row(3)] });

    const page = await scoped(() => tracking.listOutreachRecipients(7, BATCH, { status: 'failed', limit: '2', cursor: '40', q: '98000' }));

    expect(page.items.map(item => item.messageId)).toEqual([1, 2]);
    expect(page.nextCursor).toBe(2);
    expect(page.items[0]).toMatchObject({ name: 'Guest 1', state: 'failed', providerCode: '131026', failedAt: '2026-11-10T09:00:00Z' });
    const recipients = query(1);
    expect(recipients.sql).toContain('m.id>');
    expect(recipients.sql).toContain('ORDER BY id LIMIT');
    expect(recipients.sql).toContain('c.external_thread_id LIKE');
    expect(recipients.params).toEqual(expect.arrayContaining([40, 3, '%98000%', 'failed', 'expired']));
  });

  it('searches names with wildcards escaped and rejects unknown filters', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [] });
    await scoped(() => tracking.listOutreachRecipients(7, BATCH, { q: '50%_off' }));
    expect(query(1).params).toContain('%50\\%\\_off%');
    await expect(scoped(() => tracking.listOutreachRecipients(7, BATCH, { status: 'bounced' }))).rejects.toThrow();
    await expect(scoped(() => tracking.listOutreachBatches(7, { pageSize: 500 }))).rejects.toThrow();
  });

  it('lists outreaches with their stored counts, without counting messages', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...batchRow, counts: { total: 10, sent: 5, scheduled: 5 }, receipt_support: 'none' }] })
      .mockResolvedValueOnce({ rows: [{ total: 31 }] });

    const list = await scoped(() => tracking.listOutreachBatches(7, { state: 'active', q: 'spring', page: '2' }));

    expect(list).toMatchObject({ page: 2, pageSize: 20, total: 31 });
    expect(list.items[0].counts).toMatchObject({ total: 10, sent: 5, scheduled: 5 });
    expect(list.items[0].receiptSupport).toBe('none');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(query(0).sql).toContain("m.status IN('pending','sending')");
    expect(query(0).params).toEqual(expect.arrayContaining(['%spring%', 20, 20]));
  });

  it('groups failure reasons for failed, expired and review messages only', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] })
      .mockResolvedValueOnce({ rows: [{ provider_code: '131026', reason: 'Message undeliverable', count: 9 }] });
    await expect(scoped(() => tracking.listOutreachFailures(7, BATCH))).resolves
      .toEqual([{ providerCode: '131026', reason: 'Message undeliverable', count: 9 }]);
    expect(query(1).sql).toContain("state IN('failed','expired','needs_attention')");
    // Reasons that differ only by numbers or ids are one group, shown with one real example.
    expect(query(1).sql).toContain('GROUP BY provider_code,regexp_replace(');
    expect(query(1).sql).toContain('MIN(reason) AS reason');
  });

  it('searches every address a person might type, and narrows a status filter by raw status first', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [] });
    await scoped(() => tracking.listOutreachRecipients(7, BATCH, { status: 'cancelled', q: '@asha.travels' }));
    const search = query(1);
    for (const column of ['c.lead_name ILIKE', 'c.lead_email ILIKE', 'c.lead_instagram ILIKE', 'c.external_thread_id ILIKE']) expect(search.sql).toContain(column);
    expect(search.params).toEqual(expect.arrayContaining(['%asha.travels%', 'cancelled']));
    expect(search.sql.split('WHERE m.batch_id')[1]).toContain('m.status IN(');

    // Delivered can come from a receipt on almost any raw status, so it is never narrowed that way.
    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [] });
    await scoped(() => tracking.listOutreachRecipients(7, BATCH, { status: 'delivered' }));
    expect(query(1).sql.split('WHERE m.batch_id')[1]).not.toContain('m.status IN(');
  });
});

describe('one delivery state for tracking and Reports', () => {
  const sqlOf = (statement: SQL) => dialect.sqlToQuery(statement);

  it('lets receipts win, keeps requeued failures waiting and knows the older status spellings', () => {
    const { sql: text, params } = sqlOf(state.messageDeliveryState);
    expect(text.indexOf("THEN 'read'")).toBeLessThan(text.indexOf("THEN 'delivered'"));
    expect(text.indexOf("THEN 'delivered'")).toBeLessThan(text.indexOf("THEN 'needs_attention'"));
    expect(text.indexOf("enqueueNeeded'='true' THEN 'waiting'")).toBeLessThan(text.indexOf("THEN 'expired'"));
    expect(params).toEqual(expect.arrayContaining(['accepted', 'opened', 'clicked', 'replied', 'queued', 'processing']));
  });

  it('folds every tracking state into the Reports state it always had', () => {
    const { sql: text } = sqlOf(state.reportStateSql(state.messageDeliveryState));
    for (const [from, to] of [['read', 'delivered'], ['delivered', 'delivered'], ['sent', 'accepted'], ['needs_attention', 'review'],
      ['scheduled', 'queued'], ['waiting', 'queued'], ['waiting_limit', 'queued'], ['sending', 'processing'], ['failed', 'failed'],
      ['expired', 'failed'], ['cancelled', 'cancelled']]) expect(text).toContain(`WHEN '${from}' THEN '${to}'`);
  });

  it('only narrows a recipient filter by statuses that cover every way into it', () => {
    expect(state.recipientRawStatuses.waiting).toEqual(expect.arrayContaining(['pending', 'queued', 'sending', 'processing', 'failed', 'bounced']));
    expect(state.recipientRawStatuses.delivered).toBeUndefined();
    expect(state.recipientRawStatuses.read).toBeUndefined();
    expect(state.recipientRawStatuses.needs_attention).toBeUndefined();
  });
});

describe('outreach day-by-day activity', () => {
  it('counts each event on the local day it happened and fills the quiet days', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [
      { day: '2026-11-10', series: 'sent', count: 40 }, { day: '2026-11-10', series: 'delivered', count: 30 },
      { day: '2026-11-12', series: 'delivered', count: 8 }, { day: '2026-11-12', series: 'read', count: 5 },
      { day: '2026-11-12', series: 'failed', count: 2 }, { day: '2026-11-20', series: 'sent', count: 99 },
    ] });

    const activity = await scoped(() => tracking.getDailyActivity(7, { from: '2026-11-10', to: '2026-11-13', tz: 'Asia/Kolkata' }, BATCH));

    expect(activity.days).toEqual([
      { date: '2026-11-10', sent: 40, delivered: 30, read: 0, failed: 0 },
      { date: '2026-11-11', sent: 0, delivered: 0, read: 0, failed: 0 },
      { date: '2026-11-12', sent: 0, delivered: 8, read: 5, failed: 2 },
      { date: '2026-11-13', sent: 0, delivered: 0, read: 0, failed: 0 },
    ]);
    expect(activity.totals).toEqual({ sent: 40, delivered: 38, read: 5, failed: 2 });
    const daily = query(1);
    // Send, delivery, read and failure times are each bucketed by their own column, never by creation time.
    for (const column of ['m.sent_at', 'm.delivered_at', 'm.read_at', 'm.failed_at']) expect(daily.sql).toContain(`${column}>=`);
    expect(daily.sql).not.toContain('created_at');
    expect(daily.sql).toContain('m.batch_id=');
    expect(daily.params.filter(value => value === 'Asia/Kolkata').length).toBeGreaterThanOrEqual(12);
    expect(daily.params).toEqual(expect.arrayContaining(['2026-11-10', '2026-11-13']));
  });

  it('covers the whole business when no outreach is given, with channel and template filters', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await scoped(() => tracking.getDailyActivity(7, { from: '2026-11-10', to: '2026-11-10', channel: 'email', templateName: 'welcome' }));
    const daily = query(0);
    expect(daily.sql).not.toContain('m.batch_id');
    expect(daily.sql).toContain('c.channel IN(');
    expect(daily.params).toEqual(expect.arrayContaining(['gmail', 'resend', 'welcome', 'UTC']));
    // Older send records have no template, so a template view does not read them.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('adds messages sent before Message tracking and older send records to the business-wide days', async () => {
    execute.mockResolvedValueOnce({ rows: [
      { day: '2026-11-10', series: 'sent', count: 3 },
    ] }).mockResolvedValueOnce({ rows: [
      { day: '2026-11-10', series: 'sent', count: 5 }, { day: '2026-11-11', series: 'failed', count: 1 },
    ] });

    const activity = await scoped(() => tracking.getDailyActivity(7, { from: '2026-11-10', to: '2026-11-11', tz: 'Asia/Kolkata', kind: 'all' }));

    expect(activity.days).toEqual([
      { date: '2026-11-10', sent: 8, delivered: 0, read: 0, failed: 0 },
      { date: '2026-11-11', sent: 0, delivered: 0, read: 0, failed: 1 },
    ]);
    // Messages without an outreach count too.
    expect(query(0).sql).not.toContain('m.batch_id');
    // Older records come from the Reports projection, which drops the ones already counted as outreach messages.
    const legacy = query(1);
    expect(legacy.sql).toContain('legacy_sent AS');
    expect(legacy.sql).toContain('i.message_id IS NULL');
  });

  it('keeps one outreach to its own messages', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [] });
    await scoped(() => tracking.getDailyActivity(7, { from: '2026-11-10', to: '2026-11-10' }, BATCH));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(query(1).sql).not.toContain('intents');
  });

  it('rejects reversed, oversized and malformed ranges and unknown timezones', async () => {
    const run = (input: Record<string, string>) => scoped(() => tracking.getDailyActivity(7, input));
    await expect(run({ from: '2026-11-13', to: '2026-11-10' })).rejects.toThrow();
    await expect(run({ from: '2026-01-01', to: '2026-06-01' })).rejects.toThrow();
    await expect(run({ from: '10/11/2026', to: '2026-11-10' })).rejects.toThrow();
    await expect(run({ from: '2026-11-10', to: '2026-11-10', tz: "UTC'; DROP TABLE x" })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('outreach recipient download', () => {
  const row = (id: number, extra: Record<string, unknown> = {}) => ({ id, conversation_id: id, lead_id: id, lead_name: `Guest ${id}`, recipient: '919800000001',
    state: 'delivered', sent_at: '2026-11-10T08:05:00Z', delivered_at: '2026-11-10T20:06:00Z', read_at: null, failed_at: null, next_at: null,
    reason: null, provider_code: null, ...extra });

  it('streams in chunks from the last message of each chunk, in the reader’s timezone', async () => {
    const first = Array.from({ length: 2001 }, (_, index) => row(index + 1));
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: first })
      .mockResolvedValueOnce({ rows: [row(2001, { lead_name: '=HYPERLINK("x")', state: 'failed', reason: 'Message undeliverable', provider_code: '131026' })] });
    const chunks: string[] = [];
    let named = '';

    await scoped(() => tracking.exportOutreachRecipients(7, BATCH, { status: 'all', tz: 'Asia/Kolkata' },
      async chunk => { chunks.push(chunk); }, batch => { named = batch.name; }));

    expect(named).toBe('WhatsApp · spring_sale');
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe('﻿"Name","Sent to","Status","Sent at","Delivered at","Read at","Failed at","Next attempt","Reason","Provider code"\r\n');
    expect(chunks[1].split('\r\n').filter(Boolean)).toHaveLength(2000);
    // 20:06 UTC on the 10th is 01:36 on the 11th in India.
    expect(chunks[1].split('\r\n')[0]).toBe('"Guest 1","919800000001","Delivered","2026-11-10 13:35","2026-11-11 01:36","","","","",""');
    // A cell that starts like a formula is neutralised.
    expect(chunks[2]).toContain('"\'=HYPERLINK(""x"")","919800000001","Failed"');
    expect(chunks[2]).toContain('"Message undeliverable","131026"');
    expect(query(2).params).toEqual(expect.arrayContaining([2000, 2001]));
  });

  it('stops as soon as the reader goes away', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValue({ rows: Array.from({ length: 2001 }, (_, index) => row(index + 1)) });
    let writes = 0;
    await expect(scoped(() => tracking.exportOutreachRecipients(7, BATCH, {}, async () => { if (++writes === 2) throw new Error('closed'); })))
      .rejects.toThrow('closed');
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('sending estimate', () => {
  it('lets the daily limit through oldest first and rolls the rest over', () => {
    const projection = projectSends([{ dueDay: '2026-11-14', expiresDay: null, count: 2500 }, { dueDay: '2026-11-15', expiresDay: null, count: 300 }],
      { today: '2026-11-14', days: 4, dailyLimit: 1000, usedToday: 400 });
    expect(projection.days).toEqual([
      { day: '2026-11-14', due: 2500, expectedToSend: 600, held: 1900, willExpire: 0 },
      { day: '2026-11-15', due: 300, expectedToSend: 1000, held: 1200, willExpire: 0 },
      { day: '2026-11-16', due: 0, expectedToSend: 1000, held: 200, willExpire: 0 },
      { day: '2026-11-17', due: 0, expectedToSend: 200, held: 0, willExpire: 0 },
    ]);
    expect(projection.afterRange).toBe(0);
  });

  it('expires what the limit cannot reach in time and reports what is left after the range', () => {
    const projection = projectSends([
      { dueDay: '2026-11-10', expiresDay: '2026-11-15', count: 2500 },
      { dueDay: '2026-11-20', expiresDay: null, count: 50 },
    ], { today: '2026-11-14', days: 3, dailyLimit: 1000, usedToday: 0 });
    expect(projection.days).toEqual([
      { day: '2026-11-14', due: 2500, expectedToSend: 1000, held: 1500, willExpire: 0 },
      { day: '2026-11-15', due: 0, expectedToSend: 1000, held: 0, willExpire: 500 },
      { day: '2026-11-16', due: 0, expectedToSend: 0, held: 0, willExpire: 0 },
    ]);
    expect(projection.afterRange).toBe(50);
  });

  it('sends everything on its due day when no limit applies', () => {
    const projection = projectSends([{ dueDay: '2026-11-15', expiresDay: null, count: 400000 }], { today: '2026-11-14', days: 2, dailyLimit: null, usedToday: 0 });
    expect(projection.days.map(day => day.expectedToSend)).toEqual([0, 400000]);
  });
});

describe('coming up and template performance', () => {
  const NOW = Date.parse('2026-11-14T06:00:00Z');

  it('projects one outreach against the daily limit, labelled with the viewer’s local dates', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] })
      .mockResolvedValueOnce({ rows: [{ channel: 'whatsapp', due_day: '2026-11-15', expires_day: '2026-11-16', batch_id: BATCH, count: 2600 }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const schedule = await scoped(() => tracking.getUpcomingSchedule(7, { until: '2026-11-17', tz: 'Asia/Kolkata' }, BATCH, NOW));

    expect(schedule.limits).toEqual([{ channel: 'whatsapp', dailyLimit: 1000, usedToday: 0 }]);
    expect(schedule.days.map(day => [day.date, day.due, day.expectedToSend, day.held, day.willExpire])).toEqual([
      ['2026-11-14', 0, 0, 0, 0], ['2026-11-15', 2600, 1000, 1600, 0], ['2026-11-16', 0, 1000, 0, 600], ['2026-11-17', 0, 0, 0, 0],
    ]);
    expect(schedule).toMatchObject({ waiting: 2600, afterRange: 0, from: '2026-11-14', until: '2026-11-17', limitResetsAt: '2026-11-15T00:00:01.000Z' });
    const waiting = query(1);
    expect(waiting.sql).toContain("m.status='pending'");
    expect(waiting.sql).toContain('m.batch_id=');
    expect(waiting.sql).not.toContain('JOIN outreach_conversations');
  });

  it('names the outreaches due each day across the whole business and caps how far ahead it looks', async () => {
    execute.mockResolvedValueOnce({ rows: [
        { channel: 'whatsapp', due_day: '2026-11-14', expires_day: null, batch_id: BATCH, count: 30 },
        { channel: 'whatsapp', due_day: '2026-11-14', expires_day: null, batch_id: null, count: 5 },
      ] })
      .mockResolvedValueOnce({ rows: [{ count: 10 }] })
      .mockResolvedValueOnce({ rows: [{ id: BATCH, name: 'Diwali offer' }] });

    const schedule = await scoped(() => tracking.getUpcomingSchedule(7, { until: '2030-01-01' }, undefined, NOW));

    expect(schedule.days).toHaveLength(62);
    expect(schedule.days[0]).toMatchObject({ date: '2026-11-14', due: 35, expectedToSend: 35, outreaches: [{ batchId: BATCH, name: 'Diwali offer', due: 30 }] });
    expect(schedule.limits[0]).toMatchObject({ usedToday: 10 });
    expect(query(0).sql).toContain('JOIN outreach_conversations');
  });

  it('reports each template from the messages sent with it in the range, with failures counted separately', async () => {
    execute.mockResolvedValueOnce({ rows: [
        { template_name: 'welcome', template_language: 'en', outreaches: 2, sent: 900, delivered: 800, read: 300, last_sent_at: '2026-11-12T10:00:00Z' },
      ] })
      .mockResolvedValueOnce({ rows: [{ template_name: 'welcome', template_language: 'en', failed: 12 }, { template_name: 'old_offer', template_language: 'hi', failed: 4 }] });

    const report = await scoped(() => tracking.getTemplatePerformance(7, { from: '2026-11-01', to: '2026-11-14', tz: 'Asia/Kolkata' }));

    expect(report.templates).toEqual([
      { templateName: 'welcome', templateLanguage: 'en', outreaches: 2, sent: 900, delivered: 800, read: 300, failed: 12, lastSentAt: '2026-11-12T10:00:00Z' },
      { templateName: 'old_offer', templateLanguage: 'hi', outreaches: 0, sent: 0, delivered: 0, read: 0, failed: 4, lastSentAt: null },
    ]);
    expect(query(0).sql).toContain('m.template_name IS NOT NULL');
    expect(query(0).sql).toContain('m.sent_at>=');
    expect(query(1).sql).toContain('m.failed_at>=');
  });
});

describe('outreach tracking record', () => {
  it('names an outreach from the sender or from its channel and template', () => {
    expect(batches.outreachBatchName('  Diwali   offer ', 'whatsapp', 'spring_sale')).toBe('Diwali offer');
    expect(batches.outreachBatchName(undefined, 'whatsapp', 'spring_sale')).toBe('WhatsApp · spring_sale');
    expect(batches.outreachBatchName('', 'email')).toBe('Email · Message');
    expect(batches.outreachBatchName('x'.repeat(300), 'sms')).toHaveLength(200);
  });

  it('separates admitted recipients from those skipped before a message existed', () => {
    expect(batches.skippedTally([
      { status: 'queued', messageId: 5 }, { status: 'uncertain', messageId: 6 }, { status: 'error', messageId: 7, error: 'Held for setup' },
      { status: 'error', messageId: 0, error: 'Lead not found' }, { status: 'error', messageId: 0, error: 'Lead not found' },
      { status: 'error', messageId: 0 },
    ])).toEqual({ admitted: 3, skipped: 3, reasons: { 'Lead not found': 2, 'Could not be queued': 1 } });
  });

  it('renames an outreach in its own business and rejects an empty name', async () => {
    execute.mockResolvedValueOnce({ rows: [batchRow] }).mockResolvedValueOnce({ rows: [{ ...batchRow, name: 'Diwali offer' }] });
    await expect(scoped(() => tracking.renameOutreachBatch(7, BATCH, { name: '  Diwali   offer ' }))).resolves.toMatchObject({ id: BATCH, name: 'Diwali offer' });
    expect(query(1).params).toEqual(expect.arrayContaining(['Diwali offer', BATCH, 7, 11]));
    await expect(scoped(() => tracking.renameOutreachBatch(7, BATCH, { name: '   ' }))).rejects.toThrow();
    await expect(scoped(() => tracking.renameOutreachBatch(7, BATCH, { name: 'x', status: 'queued' }))).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reuses the record when the same reviewed launch is replayed', async () => {
    execute.mockResolvedValue({ rows: [{ id: BATCH }] });
    const id = await scoped(() => batches.openOutreachBatch({ fingerprint: 'f'.repeat(64), channel: 'gmail', source: 'new_outreach', requestedCount: 3 }));
    expect(id).toBe(BATCH);
    const insert = query(0);
    expect(insert.sql).toContain('ON CONFLICT(business_profile_id,user_id,request_fingerprint) DO UPDATE');
    expect(insert.params).toEqual(expect.arrayContaining([7, 11, 'email', 'Email · Message', 3]));

    await scoped(() => batches.closeOutreachBatch(BATCH, { admission: 'queued', admitted: 2, skipped: 1, reasons: { 'Lead not found': 1 } }));
    expect(query(1).params).toEqual(expect.arrayContaining(['queued', 2, 1, '{"Lead not found":1}', BATCH, 7, 11]));
    // Once queued, whether receipts come back is worked out from the mailboxes and numbers actually used.
    expect(query(1).sql).toContain('bool_and(c.channel IN(');
  });

  it('records which channels report delivery and read receipts', () => {
    expect(batches.receiptSupportFor('whatsapp')).toBe('full');
    expect(batches.receiptSupportFor('resend')).toBe('full');
    for (const channel of ['gmail', 'sms', 'linkedin', 'x']) expect(batches.receiptSupportFor(channel)).toBe('none');
  });
});
