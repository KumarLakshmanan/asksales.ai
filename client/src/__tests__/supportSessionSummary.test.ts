import { describe, expect, it } from 'vitest';
import { supportSessionSummaryPreview } from '@/lib/support-session-summary';

describe('support session sidebar summaries', () => {
  it.each([{ references: [] }, { references: [{ sourceMessageId: 17, statement: 'Private historical statement' }] }])(
    'omits internal memory without extracting its references (%j)', ({ references }) => {
      expect(supportSessionSummaryPreview(JSON.stringify({
        schemaVersion: 1, kind: 'historical_user_statements',
        expiresAt: '2026-10-27T05:44:57.387Z', references,
      }))).toBeNull();
    },
  );

  it('also omits expired memory and differently formatted envelopes', () => {
    expect(supportSessionSummaryPreview(JSON.stringify({
      references: [], expiresAt: '2000-01-01T00:00:00Z',
      kind: 'historical_user_statements', schemaVersion: 1,
    }, null, 2))).toBeNull();
  });

  it.each([
    'Customer asks about a return.',
    '  Summary with deliberate spacing.  ',
    '{"refundDays":30,"message":"Please explain this JSON"}',
    '{"kind":"historical_user_statements","message":"An ordinary JSON example"}',
    '{"schemaVersion":1,"kind":"historical_user_statements","expiresAt":"not a date","references":[]}',
    '{"schemaVersion":1,"kind":"historical_user_statements","expiresAt":"2026-10-27T05:44:57.387Z","references":"ordinary text"}',
    '[{"kind":"historical_user_statements"}]',
    'null',
    '123',
    '"A JSON string"',
    '{"kind":"historical_user_statements", unfinished JSON',
  ])('preserves ordinary content verbatim: %s', summary => {
    expect(supportSessionSummaryPreview(summary)).toBe(summary);
  });

  it.each([null, undefined, ''])('has no preview for an empty summary (%s)', summary => {
    expect(supportSessionSummaryPreview(summary)).toBeNull();
  });
});
