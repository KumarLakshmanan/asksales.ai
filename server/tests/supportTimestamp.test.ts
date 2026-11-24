import { describe, expect, it } from '@jest/globals';
import { serializeSupportTimestamp, serializeUtcTimestamp } from '../utils/supportTimestamp.js';
import { readFileSync } from 'node:fs';

describe('support UTC timestamp serialization', () => {
  it('gives raw SQL values an explicit UTC zone before they reach browsers', () => {
    expect(serializeSupportTimestamp('2026-09-04 21:52:33.123456')).toBe('2026-09-04T21:52:33.123Z');
    expect(serializeSupportTimestamp('2026-09-04T21:52:33')).toBe('2026-09-04T21:52:33.000Z');
  });
  it('preserves offset-bearing values and Date objects', () => {
    expect(serializeSupportTimestamp('2026-09-05T03:22:33+05:30')).toBe('2026-09-04T21:52:33.000Z');
    expect(serializeSupportTimestamp(new Date('2026-09-04T21:52:33Z'))).toBe('2026-09-04T21:52:33.000Z');
  });
  it('provides a domain-neutral serializer for chat and outreach APIs', () => {
    expect(serializeUtcTimestamp('2026-09-18 11:42:16.913')).toBe('2026-09-18T11:42:16.913Z');
  });
  it('does not return invalid dates or fabricate missing timestamps', () => {
    for (const value of [null, undefined, '', 'invalid', new Date(NaN)]) {
      expect(serializeSupportTimestamp(value)).toBeNull();
    }
  });
  it('uses canonical dates in the workspace and excludes earlier tickets’ automation history', () => {
    const source = readFileSync('services/SupportService.ts', 'utf8');
    expect(source).toContain('handoffSlaDeadline: serializeSupportTimestamp(row.handoff_sla_deadline)');
    expect(source).toContain('AND audit.created_at >= ticket.created_at');
  });
});
