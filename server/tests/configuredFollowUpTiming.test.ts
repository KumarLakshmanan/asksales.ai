import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ChannelFollowUp } from '../models/outreachSettings/schema.js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../queues/index.js', () => ({ queueRegistry: {}, QUEUE_NAMES: {} }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: jest.fn() }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {} }));
jest.unstable_mockModule('../services/assistants/AssistantContext.js', () => ({ assistantsRuntimeEnabled: () => false }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { cronService } = await import('../services/cronService.js');
const { activateSocialFollowUpForAnchor, completeSocialFollowUpDelivery } = await import('../services/socialFollowUpService.js');
const reader = cronService as unknown as {
  getPendingFollowUpsForChannel: (userId: number, periods: ChannelFollowUp[], channel: 'email' | 'sms') => Promise<Array<{ messageId: number; nextStepIndex: number }>>;
};
const steps = [
  { id: '1', delayDays: 0, delayHours: 1, delayMinutes: 0, enabled: true },
  { id: '2', delayDays: 1, delayHours: 0, delayMinutes: 0, enabled: true },
];

describe('configured 1-hour and 1-day follow-ups', () => {
  beforeEach(() => { jest.useFakeTimers(); execute.mockReset(); });
  afterEach(() => { jest.useRealTimers(); });

  it.each(['email', 'sms'] as const)('%s sends step 1 at one hour and step 2 at 24 hours from the original UTC send', async channel => {
    const origin = { id: 41, lead_id: 7, sent_at: '2026-10-19 11:00:00.123456', updated_at: '2026-10-19 12:05:00', follow_up_step: null as number | null };
    execute.mockImplementation(async () => ({ rows: [origin] }));
    jest.setSystemTime(new Date('2026-10-19T12:00:00.122Z'));
    expect(await reader.getPendingFollowUpsForChannel(1, steps, channel)).toEqual([]);
    jest.setSystemTime(new Date('2026-10-19T12:00:00.123Z'));
    expect(await reader.getPendingFollowUpsForChannel(1, steps, channel)).toEqual([expect.objectContaining({ messageId: 41, nextStepIndex: 0 })]);
    origin.follow_up_step = 1;
    jest.setSystemTime(new Date('2026-10-20T11:00:00.122Z'));
    expect(await reader.getPendingFollowUpsForChannel(1, steps, channel)).toEqual([]);
    jest.setSystemTime(new Date('2026-10-20T11:00:00.123Z'));
    expect(await reader.getPendingFollowUpsForChannel(1, steps, channel)).toEqual([expect.objectContaining({ messageId: 41, nextStepIndex: 1 })]);
    origin.follow_up_step = 2;
    expect(await reader.getPendingFollowUpsForChannel(1, steps, channel)).toEqual([]);
  });

  it.each(['email', 'sms'] as const)('%s ignores an invalid origin timestamp', async channel => {
    execute.mockResolvedValue({ rows: [{ id: 41, lead_id: 7, sent_at: 'invalid', follow_up_step: null }] });
    expect(await reader.getPendingFollowUpsForChannel(1, steps, channel)).toEqual([]);
  });

  it.each(['email', 'sms'] as const)('%s preserves milliseconds when the database already returned a Date', async channel => {
    execute.mockResolvedValue({ rows: [{ id: 41, lead_id: 7, sent_at: new Date('2026-10-19T11:00:00.123Z'), follow_up_step: null }] });
    jest.setSystemTime(new Date('2026-10-19T12:00:00.122Z'));
    expect(await reader.getPendingFollowUpsForChannel(1, steps, channel)).toEqual([]);
    jest.setSystemTime(new Date('2026-10-19T12:00:00.123Z'));
    expect(await reader.getPendingFollowUpsForChannel(1, steps, channel)).toHaveLength(1);
  });

  it.each(['whatsapp', 'instagram', 'facebook'])('%s persists +1 hour then +24 hours from the same anchor after delayed delivery', async channel => {
    execute.mockResolvedValueOnce({ rows: [{ id: 41, user_id: 1, conversation_id: 7,
      sent_at: '2026-10-19 11:00:00', channel, automation_mode: 'ai_active',
      enable_auto_follow_up: true, channel_settings: { enabled: true, followUps: steps },
    }] }).mockResolvedValue({ rows: [] });
    expect(await activateSocialFollowUpForAnchor(41)).toBe(true);
    const dialect = new PgDialect();
    const activation = dialect.sqlToQuery(execute.mock.calls[1][0] as SQL);
    expect(activation.params).toContain(channel);
    expect(activation.params).toContainEqual(new Date('2026-10-19T12:00:00Z'));
    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ steps, next_step: 1, sent_at: '2026-10-19 11:00:00' }] }).mockResolvedValue({ rows: [] });
    jest.setSystemTime(new Date('2026-10-19T13:30:00Z'));
    await completeSocialFollowUpDelivery(3, 42, 'fixture-provider-message');
    const advance = dialect.sqlToQuery(execute.mock.calls[2][0] as SQL);
    expect(advance.params).toContainEqual(new Date('2026-10-20T11:00:00Z'));
  });
});
