import { describe, expect, it } from '@jest/globals';
import { deriveOutreachCampaignProgress, type OutreachJobTotals } from '../services/outreach/campaignProgress.js';

const totals = (patch: Partial<OutreachJobTotals> = {}): OutreachJobTotals => ({
  total: 0, pending: 0, processing: 0, sent: 0, delivered: 0, failed: 0,
  deliveryFailed: 0, cancelled: 0, uncertain: 0, ...patch,
});
const campaign = (settings: Record<string, unknown> = {}, status = 'queued') => ({
  status, scheduledInFuture: false, settings: { queueStatus: 'queued', ...settings },
});

describe('durable outreach campaign progress', () => {
  it('keeps held assistant-setup work separate from provider uncertainty and successful completion', () => {
    expect(deriveOutreachCampaignProgress(campaign({ queuedCount: 2 }), totals({ total: 2, sent: 1, setupRequired: 1 })))
      .toMatchObject({ status: 'needs_attention', isActive: false, setupRequired: 1, uncertain: 0, terminal: true });
  });
  it('does not claim sent or delivered for pending queue entries', () => {
    expect(deriveOutreachCampaignProgress(campaign({ queuedCount: 3 }), totals({ total: 3, pending: 3 })))
      .toMatchObject({ status: 'queued', isActive: true, sent: 0, delivered: 0, terminal: false });
  });

  it('keeps an explicit future schedule', () => {
    expect(deriveOutreachCampaignProgress({ ...campaign(), scheduledInFuture: true }, totals({ total: 1, pending: 1 })))
      .toMatchObject({ status: 'scheduled', terminal: false });
  });

  it('does not complete while another recipient is still being enqueued', () => {
    expect(deriveOutreachCampaignProgress(campaign({ queueStatus: 'preparing' }), totals({ total: 1, sent: 1 })))
      .toMatchObject({ status: 'running', terminal: false, enqueueComplete: false });
  });

  it('reconciles a fast worker after the last enqueue acknowledgement, without overwriting sent totals', () => {
    expect(deriveOutreachCampaignProgress(campaign({ queuedCount: 1 }, 'running'), totals({ total: 1, sent: 1 })))
      .toMatchObject({ status: 'completed', terminal: true, sent: 1, delivered: 0 });
  });

  it('retains failures before enqueue and reports mixed results as partial', () => {
    expect(deriveOutreachCampaignProgress(campaign({ queuedCount: 2, failedBeforeEnqueueCount: 1 }), totals({ total: 2, sent: 1, failed: 1 })))
      .toMatchObject({ status: 'partial_success', failed: 2, sent: 1, terminal: true });
  });

  it('reports all rejected recipients as failed even without persisted jobs', () => {
    expect(deriveOutreachCampaignProgress(campaign({ queuedCount: 0, failedBeforeEnqueueCount: 3 }), totals()))
      .toMatchObject({ status: 'failed', failed: 3, terminal: true });
  });

  it('does not claim completion when a queue receipt is missing durable jobs', () => {
    expect(deriveOutreachCampaignProgress(campaign({ queuedCount: 3 }), totals({ total: 2, sent: 2 })))
      .toMatchObject({ status: 'needs_attention', missingJobs: 1, terminal: true });
  });

  it('keeps a possible provider acceptance out of definitive failure/sent counts', () => {
    expect(deriveOutreachCampaignProgress(campaign(), totals({ total: 1, uncertain: 1 })))
      .toMatchObject({ status: 'needs_attention', sent: 0, failed: 0, uncertain: 1 });
  });

  it('requires a provider delivery milestone and does not infer delivery from acceptance', () => {
    const accepted = deriveOutreachCampaignProgress(campaign(), totals({ total: 2, sent: 2 }));
    const confirmed = deriveOutreachCampaignProgress(campaign({}, accepted.status), totals({ total: 2, sent: 2, delivered: 1 }));
    expect(accepted.delivered).toBe(0);
    expect(confirmed).toMatchObject({ status: 'completed', sent: 2, delivered: 1 });
    expect(deriveOutreachCampaignProgress(campaign({}, confirmed.status), totals({ total: 2, sent: 2, delivered: 1 }))).toEqual(confirmed);
  });

  it('a bounce after acceptance changes completion to failed or partial, not successful delivery', () => {
    expect(deriveOutreachCampaignProgress(campaign({}, 'completed'), totals({ total: 1, sent: 1, failed: 1, deliveryFailed: 1 })))
      .toMatchObject({ status: 'failed', sent: 1, delivered: 0, failed: 1 });
    expect(deriveOutreachCampaignProgress(campaign({}, 'completed'), totals({ total: 2, sent: 2, failed: 1, deliveryFailed: 1 })))
      .toMatchObject({ status: 'partial_success' });
  });

  it.each(['cancelled', 'paused'])('late receipts never reactivate a %s campaign', (status) => {
    expect(deriveOutreachCampaignProgress(campaign({}, status), totals({ total: 2, pending: 1, sent: 1 })))
      .toMatchObject({ status, isActive: false });
  });

  it('does not call a legacy empty campaign completed', () => {
    expect(deriveOutreachCampaignProgress(campaign({}, 'draft'), totals())).toMatchObject({ status: 'draft', terminal: false });
  });

  it('never erases a durable incomplete-closure warning on the next worker update', () => {
    expect(deriveOutreachCampaignProgress(campaign({ queueStatus: 'preparing', queueIssue: 'enqueue_closure_stalled' }, 'needs_attention'), totals({ total: 1, sent: 1 })))
      .toMatchObject({ status: 'needs_attention', terminal: true, queueIssue: 'enqueue_closure_stalled' });
  });
});
