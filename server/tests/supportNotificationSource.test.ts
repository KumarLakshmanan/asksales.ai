import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { resolveSupportNotificationSource } from '../services/SupportNotificationSource.js';

describe('support notification source labels', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it.each([
    ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['facebook', 'Facebook'],
    ['gmail', 'Email'], ['web', 'Web chat'], ['instagram_comment', 'Instagram comment'],
  ])('renders the governed label for %s', async (channel, expected) => {
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ conversation_channel: channel }] });
    expect(await resolveSupportNotificationSource(db, 9, 59)).toBe(expected);
  });

  it('uses tenant-scoped conversation and handoff joins, excluding deleted tickets', async () => {
    const execute = jest.spyOn(db, 'execute').mockResolvedValue({ rows: [] });
    expect(await resolveSupportNotificationSource(db, 9, 59)).toBeNull();
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.params).toEqual([59, 9]);
    expect(query.sql).toContain('conversation.user_id = ticket.user_id');
    expect(query.sql).toContain('queue.user_id = ticket.user_id');
    expect(query.sql).toContain('ticket.deleted_at IS NULL');
  });

  it('uses a governed handoff channel when there is no linked outreach conversation', async () => {
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ handoff_channel: 'web' }] });
    expect(await resolveSupportNotificationSource(db, 9, 59)).toBe('Web chat');
  });

  it.each(['customer@example.test', '+919999999999', '__proto__', 'constructor'])('never uses arbitrary source text %s', async (value) => {
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ conversation_channel: value, handoff_channel: value }] });
    expect(await resolveSupportNotificationSource(db, 9, 59)).toBeNull();
  });
});
