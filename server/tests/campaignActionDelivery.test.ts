import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  projectReviewDelivery, type DeliveryJob, type OutreachReview, type ProviderReceipt,
} from '../mastra/campaignActionDeliveryState.js';
import { buildCampaignActionStatus } from '../mastra/campaignActionStatus.js';

const execute = jest.fn<(query: SQL) => Promise<{ rows: unknown[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { storedOutreachStatusForReviews, storedOutreachCountsForRecipients } = await import('../mastra/campaignActionDelivery.js');

const review = (overrides: Partial<OutreachReview> = {}): OutreachReview => ({
  id: 62, userId: 12, threadId: 42, toolName: 'send_outreach_messages', status: 'queued',
  submittedValues: { lead_ids: [81], channel: 'email' },
  executionResult: { output: { campaignId: 7, results: [{ leadId: 81, jobId: 281, success: true }] } }, ...overrides,
});
const job = (overrides: Partial<DeliveryJob> = {}): DeliveryJob => ({
  id: 281, userId: 12, leadId: 81, campaignId: 7, channel: 'email', sequenceStepId: 1,
  status: 'sent', externalMessageId: 'provider-1', ...overrides,
});
const receipt = (overrides: Partial<ProviderReceipt> = {}): ProviderReceipt => ({
  userId: 12, leadId: 81, campaignId: 7, channel: 'email', messageId: 'provider-1', status: 'delivered', ...overrides,
});
const social = (outcomes: unknown = {}): OutreachReview => review({
  submittedValues: { lead_ids: [81], channel: 'whatsapp' },
  executionResult: { output: { campaignId: 7, results: [{ leadId: 81, jobId: 'outreach-7-81-1', success: true }] }, reconciliationJobOutcomes: outcomes },
});

describe('exact review recipient lifecycle', () => {
  it('projects shared-composer receipts using their exact review, chat, internal message and recipient IDs', () => {
    const created = review({ submittedValues: { lead_ids: [81,82,83,84], channel: 'whatsapp', outreach_review: { creationVersion: 1 } },
      executionResult: { output: { results: [81,82,83,84].map(id => ({ leadId: id, messageId: id+100, status: 'queued' })) } } });
    const rows = [81,82,83,84].map((leadId, i) => receipt({ leadId, reviewId: 62, threadId: 42, internalMessageId: leadId+100,
      channel: 'whatsapp', campaignId: null, status: ['delivered','failed','sent','manual_review'][i], providerCallState: i===3 ? 'unknown' : 'confirmed' }));
    expect(projectReviewDelivery(created, [], rows).counts).toEqual({ queued: 0, sent: 1, delivered: 1, failed: 1, cancelled: 0, unavailable: 1 });
    for (const wrong of [{ reviewId: 63 },{ threadId: 43 },{ userId: 99 },{ internalMessageId: 999 },{ leadId: 99 },{ channel: 'email' }]) {
      expect(projectReviewDelivery(created, [], [{ ...rows[0], ...wrong }]).counts.delivered).toBe(0);
    }
    expect(projectReviewDelivery(created, [], [rows[0],rows[0]]).counts.delivered).toBe(0);
  });

  it('excludes other accounts, campaigns, recipients, channels and sequence steps even with the same job ID', () => {
    const result = projectReviewDelivery(review(), [
      job({ userId: 99 }), job({ campaignId: 8 }), job({ leadId: 82 }), job({ channel: 'sms' }), job({ sequenceStepId: 2 }),
    ], [receipt()]);
    expect(result.counts).toMatchObject({ unavailable: 1, sent: 0, delivered: 0 });
  });

  it('requires exact account/campaign/channel/recipient/provider receipt correlation', () => {
    const result = projectReviewDelivery(review(), [job()], [
      receipt({ userId: 99 }), receipt({ campaignId: 8 }), receipt({ campaignId: null }),
      receipt({ leadId: 82 }), receipt({ channel: 'sms' }), receipt({ messageId: 'other-campaign-message' }),
    ]);
    expect(result.counts).toMatchObject({ sent: 1, delivered: 0 });
  });

  it('counts one exclusive state per recipient, not duplicate rows or cumulative sent/delivered counts', () => {
    const result = projectReviewDelivery(review({ submittedValues: { lead_ids: [81, 81, 82, 83, 84, 85, 86], channel: 'email' } }), [
      job(), job({ id: 282, leadId: 82, status: 'pending', externalMessageId: null }),
      job({ id: 283, leadId: 83, status: 'failed', externalMessageId: null }),
      job({ id: 284, leadId: 84 }), job({ id: 285, leadId: 85, status: 'cancelled', externalMessageId: null }),
    ], [receipt(), receipt()]);
    expect(result.counts).toEqual({ queued: 1, sent: 1, delivered: 1, failed: 1, cancelled: 1, unavailable: 1 });
    expect(result.recipients).toHaveLength(6);
  });

  it('counts a bounce as failed even if an older delivered receipt exists', () => {
    expect(projectReviewDelivery(review(), [job()], [receipt(), receipt({ status: 'sent', deliveryStatus: 'bounced' })]).counts)
      .toMatchObject({ delivered: 0, sent: 0, failed: 1 });
  });

  it.each(['pending', 'processing'])('does not turn a %s job into a provider send', status => {
    expect(projectReviewDelivery(review(), [job({ status, externalMessageId: null })], []).counts)
      .toMatchObject({ queued: 1, sent: 0, delivered: 0 });
  });

  it('does not interpret worker success without a provider ID or uncertain failures as confirmed delivery', () => {
    expect(projectReviewDelivery(review({ status: 'succeeded' }), [job({ externalMessageId: null })], []).counts.unavailable).toBe(1);
    expect(projectReviewDelivery(review(), [job({ status: 'failed', metadata: { manualReviewRequired: true } })], []).counts)
      .toMatchObject({ unavailable: 1, failed: 0 });
    expect(projectReviewDelivery(review(), [job({ status: 'failed', metadata: { manualReviewRequired: true } })], [receipt()]).counts.delivered).toBe(1);
  });

  it('supports legacy exact numeric job IDs without a campaign receipt and excludes unrelated jobs', () => {
    const legacy = review({ executionResult: { output: { results: [{ leadId: 81, jobId: '281', success: true }] } } });
    expect(projectReviewDelivery(legacy, [job({ campaignId: null }), job({ id: 282 })], [receipt({ campaignId: null })]).counts.delivered).toBe(1);
    expect(projectReviewDelivery(legacy, [job({ id: 282 })], [receipt()]).counts.unavailable).toBe(1);
  });

  it('recovers campaign step-1 jobs when the enqueue acknowledgement was lost', () => {
    const lost = review({ executionResult: { output: { campaignId: 7, status: 'needs_attention' } } });
    expect(projectReviewDelivery(lost, [job()], []).counts.sent).toBe(1);
  });

  it('keeps uncorrelated legacy and unsubmitted reviews unavailable', () => {
    expect(projectReviewDelivery(review({ status: 'active', executionResult: null }), [job()], [receipt()]).counts.unavailable).toBe(1);
    expect(projectReviewDelivery(review({ submittedValues: { lead_ids: [true], channel: 'email' } }), [], []).unavailableReason).toBeDefined();
  });

  it('distinguishes a social queue acknowledgement, provider acceptance and provider delivery', () => {
    expect(projectReviewDelivery(social(), [], []).counts).toMatchObject({ queued: 1, sent: 0, delivered: 0 });
    const accepted = social({ 'outreach-7-81-1': { success: true, result: { success: true, messageId: 'wamid-1' } } });
    expect(projectReviewDelivery(accepted, [], []).counts).toMatchObject({ queued: 0, sent: 1, delivered: 0 });
    expect(projectReviewDelivery(accepted, [], [receipt({ channel: 'whatsapp', campaignId: null, messageId: 'wamid-1' })]).counts)
      .toMatchObject({ sent: 0, delivered: 1 });
    expect(projectReviewDelivery(accepted, [], [receipt({ channel: 'whatsapp', campaignId: 8, messageId: 'wamid-1' })]).counts.delivered).toBe(0);
  });

  it('ignores social outcomes from another job and treats suppression/retry failure as unavailable', () => {
    const outcome = { success: true, result: { success: true, messageId: 'other-campaign-message' } };
    expect(projectReviewDelivery(social({ 'other-job': outcome }), [], [receipt()]).counts.sent).toBe(0);
    expect(projectReviewDelivery(social({ 'outreach-7-81-1': { success: true, result: { success: true, note: 'duplicate_prevention' } } }), [], []).counts.unavailable).toBe(1);
    expect(projectReviewDelivery(social({ 'outreach-7-81-1': { success: false, result: { error: 'Retry pending' } } }), [], []).counts.failed).toBe(0);
    expect(projectReviewDelivery(social({ 'outreach-7-81-1': { success: false, result: { success: false, error: 'Provider rejected' } } }), [], []).counts.failed).toBe(1);
  });

  it('fails closed on ambiguous jobs and retains a 575-recipient selection', () => {
    expect(projectReviewDelivery(review(), [job(), job({ id: 282 })], [receipt()]).counts.unavailable).toBe(1);
    const oversized = review({ submittedValues: { lead_ids: Array.from({ length: 575 }, (_, i) => i + 1), channel: 'email' } });
    expect(projectReviewDelivery(oversized, [], []).counts.unavailable).toBe(575);
    expect(projectReviewDelivery(oversized, [], []).unavailableReason).toBeUndefined();
  });

  it('does not label an ambiguous enqueue exception as a definite send failure', () => {
    const failed = review({ executionResult: { output: { results: [{ leadId: 81, success: false }] } } });
    expect(projectReviewDelivery(failed, [], []).counts).toMatchObject({ unavailable: 1, failed: 0 });
    failed.executionResult = { output: { status: 'failed_before_side_effect', retrySafe: true, results: [{ leadId: 81, success: false }] } };
    expect(projectReviewDelivery(failed, [], []).counts.failed).toBe(1);
  });

  it('renders recipient counts and evidence without exposing other reviews', () => {
    const own = review();
    const text = buildCampaignActionStatus([{ ...own, agentType: 'outreach' }], { source: 'review_correlations', reviews: [
      projectReviewDelivery(own, [job()], []), projectReviewDelivery(review({ id: 63 }), [job()], []),
    ] });
    expect(text).toContain('sent: 1; delivered: 0');
    expect(text).toContain('lead #81: sent');
    expect(text).not.toContain('review #63');
    expect(text).toContain('not live provider checks');
  });
});

describe('bounded read-only owned review query', () => {
  beforeEach(() => { execute.mockReset(); });
  const queries = () => execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query));

  it('reads shared composer messages through exact owned review bindings for all supported channels', async () => {
    for (const channel of ['whatsapp','email','sms','instagram','facebook']) {
      execute.mockReset().mockResolvedValueOnce({ rows: [review({ submittedValues: { lead_ids: [81], channel, outreach_review: { creationVersion: 1 } },
        executionResult: { output: { results: [{ leadId: 81, messageId: 181, status: 'queued' }] } } })] })
        .mockResolvedValueOnce({ rows: [receipt({ channel, campaignId: null, reviewId: 62, threadId: 42, internalMessageId: 181, providerCallState: 'confirmed' })] });
      expect((await storedOutreachStatusForReviews(12,42,[62])).reviews[0].counts.delivered).toBe(1);
      const query = queries()[1];
      expect(query.sql).toContain('m.business_profile_id=w.business_profile_id');
      expect(query.sql).toContain("m.metadata#>>'{outreachCreation,delivery,widgetId}'=w.id::text");
      expect(query.sql).toContain("m.direction='outbound' AND m.message_kind='outreach'");
      expect(query.sql).toContain('c.lead_id=scope."leadId" AND c.channel=scope.channel');
      expect(execute).toHaveBeenCalledTimes(2);
    }
  });

  it('binds account/conversation/exact IDs and projects only their correlated rows', async () => {
    execute.mockResolvedValueOnce({ rows: [review(), review({ userId: 99 }), review({ threadId: 43 }), review({ id: 63 })] })
      .mockResolvedValueOnce({ rows: [job(), job({ campaignId: 8 })] })
      .mockResolvedValueOnce({ rows: [receipt(), receipt({ userId: 99 })] });
    const report = await storedOutreachStatusForReviews(12, 42, [62]);
    expect(report.reviews).toHaveLength(1);
    expect(report.reviews[0].counts.delivered).toBe(1);
    const [widgets, jobs, receipts] = queries();
    expect(widgets.sql).toMatch(/WHERE user_id = \$1 AND thread_id = \$2\s+AND id IN \(\$3\)/);
    expect(widgets.params).toEqual([12, 42, 62, 100]);
    expect(jobs.sql).toContain('j.campaign_id = scope."campaignId" AND j.sequence_step_id = 1');
    expect(jobs.sql).toContain('WHERE j.user_id =');
    expect(receipts.sql).toContain('sm.message_id = t."messageId"');
    expect(receipts.sql).toContain('WHERE sm.user_id =');
    expect(receipts.sql).toContain('WHERE om.user_id =');
    expect(receipts.sql).toContain("om.direction = 'outbound' AND om.message_kind = 'outreach'");
    expect(receipts.sql).toContain('COALESCE(sm.is_reply, false) = false');
    expect(queries().every(query => !/\b(?:UPDATE|INSERT|DELETE)\b/.test(query.sql))).toBe(true);
  });

  it('does no broad query for absent, excessive, invalid or legacy recipient-only scope', async () => {
    expect((await storedOutreachStatusForReviews(12, 42, [])).reviews).toEqual([]);
    expect((await storedOutreachStatusForReviews(12, 42, Array.from({ length: 101 }, (_, i) => i + 1))).unavailableReason).toBeDefined();
    expect((await storedOutreachStatusForReviews(12, 42, [0])).unavailableReason).toBeDefined();
    expect((await storedOutreachCountsForRecipients(12, [81])).unavailableReason).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it('queries social delivery only through provider IDs from the requested widget job outcomes', async () => {
    execute.mockResolvedValueOnce({ rows: [social({ 'outreach-7-81-1': { success: true, result: { success: true, messageId: 'wamid-1' } } })] })
      .mockResolvedValueOnce({ rows: [receipt({ channel: 'whatsapp', campaignId: null, messageId: 'wamid-1' })] });
    const report = await storedOutreachStatusForReviews(12, 42, [62]);
    expect(report.reviews[0].counts.delivered).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
    const query = queries()[1];
    expect(JSON.parse(String(query.params[0]))).toEqual([{
      leadId: 81, channel: 'whatsapp', campaignId: 7, messageId: 'wamid-1', allowUnassignedCampaign: true,
    }]);
    expect(query.sql).toContain('oc.user_id =');
  });

  it('does not query recipient history for uncorrelated reviews or wrong conversations', async () => {
    execute.mockResolvedValueOnce({ rows: [review({ executionResult: null })] });
    expect((await storedOutreachStatusForReviews(12, 42, [62])).reviews[0].counts.unavailable).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockReset().mockResolvedValueOnce({ rows: [review({ threadId: 43 })] });
    expect((await storedOutreachStatusForReviews(12, 42, [62])).unavailableReason).toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reports read failures as unavailable, never as zero sends or raw DB errors', async () => {
    execute.mockRejectedValueOnce(new Error('private database failure'));
    const result = await storedOutreachStatusForReviews(12, 42, [62]);
    expect(result.unavailableReason).toContain('unavailable');
    expect(JSON.stringify(result)).not.toContain('private database');
  });
});
