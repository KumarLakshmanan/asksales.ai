import { describe, expect, it } from 'vitest';
import { updateEnrichmentProgress } from '@/lib/enrichment-progress';

describe('enrichment loader ownership', () => {
  it('keeps simultaneous runs independent', () => {
    const a = updateEnrichmentProgress({}, 'progress', { toolName: 'deep_enrichment', runId: 1, iteration: 2 });
    const b = updateEnrichmentProgress(a, 'progress', { toolName: 'handle_enrichment', runId: 2, iteration: 5 });
    const c = updateEnrichmentProgress(b, 'completed', { toolName: 'handle_enrichment', runId: 2 });
    expect(c[1]).toEqual(a[1]);
    expect(c[2].status).toBe('completed');
  });
  it.each(['completed', 'failed'] as const)('ignores late progress after %s', phase => {
    const terminal = updateEnrichmentProgress({}, phase, { toolName: 'handle_enrichment', runId: 4 });
    expect(updateEnrichmentProgress(terminal, 'progress', { toolName: 'handle_enrichment', runId: 4, iteration: 9 })).toBe(terminal);
  });
  it('does not apply unrelated or uncorrelated events to a selected run', () => {
    expect(updateEnrichmentProgress({}, 'progress', { toolName: 'deep_enrichment', iteration: 1 })).toEqual({});
    expect(updateEnrichmentProgress({}, 'progress', { toolName: 'other', runId: 1 })).toEqual({});
  });
});
