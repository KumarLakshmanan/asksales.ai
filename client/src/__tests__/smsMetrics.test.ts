import { describe, expect, it } from 'vitest';
import { calculateSmsMetrics } from '@/lib/smsMetrics';
import { dmOutreachPath } from '@/lib/dmOutreach';

describe('SMS transport estimates', () => {
  it('handles empty, single and multipart GSM messages', () => {
    expect(calculateSmsMetrics('').segments).toBe(0);
    expect(calculateSmsMetrics('A'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(calculateSmsMetrics('A'.repeat(161))).toMatchObject({ segments: 2, perSegment: 153 });
    expect(calculateSmsMetrics('A'.repeat(320)).segments).toBe(3);
  });
  it('counts extension symbols twice without misclassifying GSM accents as Unicode', () => {
    expect(calculateSmsMetrics('£é€{}')).toMatchObject({ encoding: 'GSM-7', units: 8, characters: 5 });
    expect(calculateSmsMetrics('^'.repeat(81)).segments).toBe(2);
  });
  it('counts Unicode as UTF-16 units including surrogate pairs', () => {
    expect(calculateSmsMetrics('漢'.repeat(70))).toMatchObject({ encoding: 'UCS-2', segments: 1 });
    expect(calculateSmsMetrics('漢'.repeat(71))).toMatchObject({ segments: 2, perSegment: 67 });
    expect(calculateSmsMetrics('😀'.repeat(36))).toMatchObject({ characters: 36, units: 72, segments: 2 });
  });
});

describe('DM outreach destinations', () => {
  it.each(['instagram', 'facebook', 'linkedin', 'twitter', 'whatsapp'])('preserves the selected %s channel', channel => {
    expect(dmOutreachPath(channel, 'Hello & welcome')).toBe(`/dashboard/outreach/${channel}/create?message=Hello%20%26%20welcome`);
  });
  it.each(['all', 'unknown', 'multi-platform', '', undefined])('requires a choice for ambiguous destination %s', channel => {
    expect(dmOutreachPath(channel, 'hello')).toBeNull();
  });
});
