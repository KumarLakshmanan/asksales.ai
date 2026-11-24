import { describe, expect, it, jest } from '@jest/globals';
import {
  emailFollowUpJobId,
  getConfiguredDelayMinutes,
  getEmailFollowUpDueAt,
  isEmailFollowUpOriginEligible,
} from '../services/emailFollowUpService.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up } from '../migrations/153_repair_email_follow_up_invariants.js';

describe('email follow-up behavior', () => {
  it('uses configured periods as deterministic absolute offsets from the original email', () => {
    const sentAt = new Date('2026-07-01T10:00:00.000Z');
    const first = { id: 1, delayDays: 0, delayHours: 2, delayMinutes: 15 };
    const second = { id: 2, delayDays: 1, delayHours: 0, delayMinutes: 30 };

    expect(getConfiguredDelayMinutes(first)).toBe(135);
    expect(getEmailFollowUpDueAt(sentAt, first).toISOString()).toBe('2026-07-01T12:15:00.000Z');
    expect(getEmailFollowUpDueAt(sentAt, second).toISOString()).toBe('2026-07-02T10:30:00.000Z');
    expect(getEmailFollowUpDueAt(sentAt, second)).toEqual(getEmailFollowUpDueAt(sentAt, second));
  });

  it('only allows an uncancelled original outbound message with no reply', () => {
    const original = {
      direction: 'outbound',
      messageKind: 'outreach',
      followUpOriginMessageId: null,
      followUpCancelledAt: null,
      hasReply: false,
    };
    expect(isEmailFollowUpOriginEligible(original)).toBe(true);
    expect(isEmailFollowUpOriginEligible({ ...original, hasReply: true })).toBe(false);
    expect(isEmailFollowUpOriginEligible({ ...original, messageKind: 'follow_up', followUpOriginMessageId: 41 })).toBe(false);
    expect(isEmailFollowUpOriginEligible({ ...original, messageKind: 'reply' })).toBe(false);
    expect(isEmailFollowUpOriginEligible({ ...original, followUpCancelledAt: new Date() })).toBe(false);
  });

  it('uses a stable queue identity for retries and duplicate scheduler attempts', () => {
    expect(emailFollowUpJobId(41, 2)).toBe('email-follow-up-41-2');
    expect(emailFollowUpJobId(41, 2)).toBe(emailFollowUpJobId(41, 2));
    expect(emailFollowUpJobId(41, 2)).not.toBe(emailFollowUpJobId(41, 3));
  });

  it('installs database barriers for origin typing and one delivery per step', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    });

    await up({ query } as never);
    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain('message_kind');
    expect(migrationSql).toContain('follow_up_origin_message_id');
    expect(migrationSql).toContain('follow_up_cancelled_at');
    expect(migrationSql).toContain('outreach_messages_follow_up_origin_step_uq');
    expect(migrationSql).toContain("message_kind = 'follow_up'");
    expect(migrationSql).toContain('follow_up_step > 0');
    expect(migrationSql).toContain("legacy.is_reply = true");
    expect(migrationSql).toContain('legacy.follow_up_step BETWEEN 1 AND 9998');
    expect(migrationSql).toContain('follow_up_cancelled_at = COALESCE');
  });
});
