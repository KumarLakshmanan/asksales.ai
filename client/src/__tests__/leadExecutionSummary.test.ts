import { describe, expect, it } from 'vitest';
import { leadEmptyState, normalizeLeadExecutionSummary } from '@/lib/lead-execution-summary';

describe('lead execution summary adapter', () => {
  it('reads the versioned array payload and preserves saved counts', () => {
    expect(normalizeLeadExecutionSummary({ metadata: { status: 'succeeded', total_leads: 3, results: [
      { platform: 'linkedin', success: true, leads_count: 3 },
    ] } })).toMatchObject({ status: 'succeeded', totalLeads: 3, successCount: 1 });
  });
  it('handles legacy result maps and mixed provider outcomes', () => {
    expect(normalizeLeadExecutionSummary({ status: 'succeeded', results: {
      linkedin: { success: false, leads_count: 0, error: 'Provider rejected' },
      google_maps: { success: true, leads_count: 2 },
    } })).toMatchObject({ status: 'partial_success', totalLeads: 2, successCount: 1, failedCount: 1 });
  });
  it.each([null, 3, 'not-json', { results: 'oops' }, { results: [null, [], 8] }, { results: [{ success: 'true', leads_count: -3 }] }])(
    'does not crash or invent success for malformed data: %j', value => {
      expect(normalizeLeadExecutionSummary(value).status).toBe('unknown');
    },
  );
  it('distinguishes all-failed from successful empty and cancellation', () => {
    expect(normalizeLeadExecutionSummary({ results: [{ success: false, leads_count: 0 }] }).status).toBe('failed');
    expect(normalizeLeadExecutionSummary({ results: [{ success: true, leads_count: 0 }] }).status).toBe('succeeded_empty');
    expect(normalizeLeadExecutionSummary({ status: 'cancelled', results: [{ success: false, leads_count: 0 }] }).status).toBe('cancelled');
  });
});

describe('lead results empty states', () => {
  it.each(['succeeded_empty', 'succeeded'])('recognizes canonical terminal status %s', status => {
    expect(leadEmptyState(status).badge).toBe('No matches');
  });
  it.each(['failed', 'partial_success'])('does not show readiness after %s', status => {
    expect(leadEmptyState(status).badge).toBe('Needs attention');
  });
  it('does not describe a completed search as not started', () => {
    expect(leadEmptyState('completed').badge).toBe('No matches');
    expect(leadEmptyState('completed').description).toContain('No leads were saved');
    expect(leadEmptyState('error').badge).toBe('Needs attention');
    expect(leadEmptyState('cancelled').badge).toBe('Cancelled');
    expect(leadEmptyState().badge).toBe('Ready to Generate');
  });
});
