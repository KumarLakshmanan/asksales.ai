import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SupportDeliveryOutboxRecord } from '../models/supportOrchestration/schema.js';

const dialect = new PgDialect();
const execute = jest.fn<(query: SQL) => Promise<{ rows: { id: number }[] }>>();
const returning = jest.fn<() => Promise<{ id: number }[]>>();
const set = jest.fn<(value: unknown) => { where: () => { returning: typeof returning } }>(() => ({ where: () => ({ returning }) }));
const database = { execute, update: () => ({ set }) };
const transaction = jest.fn<(work: (tx: typeof database) => Promise<void>) => Promise<void>>(work => work(database));
const reconcileSocialSend = jest.fn<(...args: unknown[]) => Promise<null>>().mockResolvedValue(null);
const activateSocialFollowUpForAnchor = jest.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../models/db.js', () => ({ db: { ...database, transaction } }));
jest.unstable_mockModule('../services/SocialMessagePersistence.js', () => ({ reconcileSocialSend }));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ activateSocialFollowUpForAnchor }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
const { deliveryOutboxService } = await import('../services/agents/orchestration/DeliveryOutboxService.js');

function action(channel: string, messageKind: string | undefined, isAiGenerated: boolean): SupportDeliveryOutboxRecord {
  return {
    id: 19, businessProfileId: 2, userId: 42, conversationId: 11, channel, decisionKey: 'local-synthetic-retry',
    inboundProviderMessageId: 'synthetic-inbound', playbookRunId: null, responseVersion: 1,
    status: 'sending', payload: { text: 'Synthetic reply', recipient: 'synthetic-recipient',
      metadata: { providerAccountId: 'receiving-account', ...(messageKind ? { messageKind } : {}), isAiGenerated, dispatchKind: 'pipeline_message',
        ...(messageKind === 'follow_up' ? { anchorMessageId: 73, followUpStep: 1 } : {}) } },
    attemptCount: 1, maxAttempts: 5, providerMessageId: null, lastError: null, availableAt: new Date(),
    nextAttemptAt: null, leaseExpiresAt: new Date(), sendingAt: new Date(), sentAt: null,
    reconciledBy: null, reconciledAt: null, reconciliationNote: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  returning.mockResolvedValue([{ id: 19 }]);
  execute.mockImplementation(async query => ({ rows: dialect.sqlToQuery(query).sql.includes('INSERT INTO outreach_messages') ? [{ id: 89 }] : [] }));
});

describe('Meta durable retry persistence', () => {
  it.each(['facebook', 'instagram'].flatMap(channel => [undefined, 'reply', 'proposal', 'follow_up'].flatMap(messageKind =>
    [true, false].map(isAiGenerated => ({ channel, messageKind, isAiGenerated })),
  )))('retains the receiving account and message classification: %j', async ({ channel, messageKind, isAiGenerated }) => {
    const claimed = action(channel, messageKind, isAiGenerated);
    await deliveryOutboxService.completeClaimedAction(claimed, 'synthetic-ack');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', providerMessageId: 'synthetic-ack' }));
    const query = execute.mock.calls.map(([sql]) => dialect.sqlToQuery(sql)).find(query => query.sql.includes('INSERT INTO outreach_messages'))!;
    const columns = query.sql.match(/INSERT INTO outreach_messages\s*\(([^)]+)\)/)![1].split(',').map(column => column.trim());
    const placeholders = query.sql.match(/VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/)![1].split(',').map(value => value.trim());
    const value = (column: string) => {
      const placeholder = placeholders[columns.indexOf(column)];
      return query.params[Number(placeholder.match(/^\$(\d+)/)![1]) - 1];
    };
    expect(value('provider_account_id')).toBe('receiving-account');
    expect(value('is_ai_generated')).toBe(isAiGenerated);
    expect(value('message_kind')).toBe(messageKind || 'reply');
    expect(value('follow_up_origin_message_id')).toBe(messageKind === 'follow_up' ? 73 : null);
    expect(value('follow_up_step')).toBe(messageKind === 'follow_up' ? 2 : 0);
    expect(JSON.parse(String(value('metadata')))).toMatchObject(claimed.payload.metadata!);
    expect(query.sql).toContain('message_kind = EXCLUDED.message_kind');
    expect(query.sql).toContain('provider_account_id = EXCLUDED.provider_account_id');
    expect(reconcileSocialSend).toHaveBeenCalledWith(database, { userId: 42, conversationId: 11, providerId: 'synthetic-ack', deliveryActionId: 19 });
    expect(activateSocialFollowUpForAnchor).toHaveBeenCalledTimes(messageKind === 'follow_up' ? 0 : 1);
  });

  it('does not persist a message if the delivery claim changed before commit', async () => {
    returning.mockResolvedValueOnce([]);
    await expect(deliveryOutboxService.completeClaimedAction(action('facebook', 'reply', true), 'synthetic-ack')).rejects.toThrow('Delivery action changed');
    expect(execute).not.toHaveBeenCalled();
    expect(activateSocialFollowUpForAnchor).not.toHaveBeenCalled();
  });
});
