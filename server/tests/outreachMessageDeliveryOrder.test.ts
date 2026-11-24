import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { deliveryStatusesProtectedFrom } from '../models/outreachConversations/deliveryStatus.js';

const set = jest.fn<(data: Record<string, SQL>) => unknown>();
const where = jest.fn<(query: SQL) => unknown>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { update: () => ({ set }) } }));
const { updateMessageStatusByExternalId } = await import('../models/outreachConversations/functions.js');
const dialect = new PgDialect();

describe('outreach message delivery callback order', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    set.mockReturnValue({ where });
    where.mockReturnValue({ returning: async () => [] });
  });
  it.each(['delivered', 'read', 'bounced', 'complained', 'failed'])('does not let a late sent callback overwrite %s', (existing) => {
    expect(deliveryStatusesProtectedFrom('sent')).toContain(existing);
  });
  it('preserves read over delivered, and permits progression to confirmed delivery or bounce', () => {
    expect(deliveryStatusesProtectedFrom('delivered')).toContain('read');
    expect(deliveryStatusesProtectedFrom('delivered')).not.toContain('sent');
    expect(deliveryStatusesProtectedFrom('bounced')).not.toContain('sent');
    expect(deliveryStatusesProtectedFrom('bounced')).not.toContain('delivered');
  });
  it('compares the persisted status atomically and scopes receipts to outbound messages', async () => {
    await updateMessageStatusByExternalId('verified-receipt', 'sent');
    const status = dialect.sqlToQuery(set.mock.calls[0][0].status);
    expect(status.sql).toContain('CASE WHEN');
    expect(status.params).toEqual([...deliveryStatusesProtectedFrom('sent'), 'sent']);
    const filter = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(filter.params).toEqual(['outbound', 'verified-receipt', 'verified-receipt', 'verified-receipt']);
  });
  it('keeps first delivery/read timestamps when a callback is replayed', async () => {
    await updateMessageStatusByExternalId('verified-receipt', 'read');
    const data = set.mock.calls[0][0];
    expect(dialect.sqlToQuery(data.deliveredAt).sql).toContain('COALESCE');
    expect(dialect.sqlToQuery(data.readAt).sql).toContain('COALESCE');
  });

  it.each(['sent', 'delivered', 'read'])('atomically resolves uncertainty after a verified %s receipt while preserving failure details', async (status) => {
    await updateMessageStatusByExternalId('verified-receipt', status);
    const data = set.mock.calls[0][0];
    const failureStatuses = ['failed', 'bounced', 'complained'];

    // All outcomes that block the positive status must also block clearing its
    // review/error fields. No preliminary read can race a concurrent bounce.
    expect(deliveryStatusesProtectedFrom(status)).toEqual(expect.arrayContaining(failureStatuses));
    expect(deliveryStatusesProtectedFrom(status)).not.toContain('manual_review');
    for (const [field, column, resolved] of [
      ['providerCallState', 'provider_call_state', 'confirmed'],
      ['manualReviewRequired', 'manual_review_required', false],
      ['errorMessage', 'error_message', null],
    ] as const) {
      const query = dialect.sqlToQuery(data[field]);
      expect(query.sql).toMatch(/CASE WHEN "outreach_messages"\."status" in \(\$1, \$2, \$3\)/);
      expect(query.sql).toContain(`THEN "outreach_messages"."${column}" ELSE`);
      expect(query.params).toEqual(resolved === null ? failureStatuses : [...failureStatuses, resolved]);
      if (resolved === null) expect(query.sql).toMatch(/ELSE NULL END$/);
    }

    expect(data).not.toHaveProperty('externalMessageId');
    expect(data).not.toHaveProperty('providerMessageId');
    expect(data).not.toHaveProperty('rfcMessageId');
    expect(data).not.toHaveProperty('providerAccountId');
    expect(dialect.sqlToQuery(where.mock.calls[0][0]).params)
      .toEqual(['outbound', 'verified-receipt', 'verified-receipt', 'verified-receipt']);
  });

  it.each(['pending', 'queued', 'manual_review', 'failed', 'bounced', 'complained'])('does not resolve uncertainty for a %s update', async (status) => {
    await updateMessageStatusByExternalId('verified-receipt', status);
    const data = set.mock.calls[0][0];
    expect(data).not.toHaveProperty('providerCallState');
    expect(data).not.toHaveProperty('manualReviewRequired');
    expect(data).not.toHaveProperty('errorMessage');
  });
});
