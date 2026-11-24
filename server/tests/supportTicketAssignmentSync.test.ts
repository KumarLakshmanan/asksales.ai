import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { Client } from 'pg';
import { db } from '../models/db.js';
import { supportService } from '../services/SupportService.js';
import { supportMemberNotificationService } from '../services/SupportMemberNotificationService.js';

describe('owner ticket assignment synchronization', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  function setup(assignedMemberId: number | null = 5, available = true) {
    const before = { id: 59, userId: 9, teamId: 2, assignedMemberId, status: 'open', version: 4 };
    jest.spyOn(supportService, 'getTicketById').mockResolvedValue(before as never);
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ id: 5 }] });
    const execute = jest.fn<(query: SQL) => Promise<{ rows: unknown[] }>>()
      .mockImplementation(async query => ({ rows: new PgDialect().sqlToQuery(query).sql.includes('SELECT') ? [{ id: 5 }] : [] }));
    let stored: Record<string, unknown> = {};
    let condition: SQL | undefined;
    const tx = {
      execute,
      select: () => ({ from: () => ({ where: () => ({ for: async () => [before] }) }) }),
      update: () => ({ set: (patch: Record<string, unknown>) => {
        stored = { ...before, ...patch };
        return { where: (query: SQL) => { condition = query; return { returning: async () => available ? [stored] : [] }; } };
      } }),
    };
    jest.spyOn(db, 'transaction').mockImplementation(async (callback) =>
      (callback as (transaction: typeof db) => Promise<unknown>)(tx as never));
    const notify = jest.spyOn(supportMemberNotificationService, 'queueTicketCreated').mockResolvedValue(undefined as never);
    return { execute, notify, stored: () => stored, condition: () => new PgDialect().sqlToQuery(condition!) };
  }

  it('repairs linked active handoff assignment without duplicate notification for the same member', async () => {
    const { execute, notify } = setup();
    await supportService.updateTicket(9, 59, { assignedMemberId: 5 });
    const query = new PgDialect().sqlToQuery(execute.mock.calls.find(([query]) => new PgDialect().sqlToQuery(query).sql.includes('UPDATE handoff_queue'))![0]);
    expect(query.sql).toContain('UPDATE handoff_queue');
    expect(query.sql).toContain("status IN ('waiting', 'assigned', 'in_progress')");
    expect(query.sql).toContain('IS NOT DISTINCT FROM');
    expect(query.sql).not.toContain('ai_reply_enabled');
    expect(query.sql).not.toContain('ai_paused');
    expect(query.params.slice(-2)).toEqual([9, 59]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('clears handoff assignment when changing teams without a selected member', async () => {
    const { execute, stored, notify } = setup();
    await supportService.updateTicket(9, 59, { teamId: 3 });
    expect(stored().assignedMemberId).toBeNull();
    const query = new PgDialect().sqlToQuery(execute.mock.calls.find(([query]) => new PgDialect().sqlToQuery(query).sql.includes('UPDATE handoff_queue'))![0]);
    expect(query.params).toContain(null);
    expect(query.sql).toContain("THEN 'waiting'");
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not modify handoffs for unrelated ticket edits', async () => {
    const { execute } = setup();
    await supportService.updateTicket(9, 59, { subject: 'Revised QA subject' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('compares the authorized ticket version and team before member reassignment', async () => {
    const { condition, stored } = setup();
    await supportService.updateTicket(9, 59, { assignedMemberId: 5 }, { expectedVersion: 4, expectedTeamId: 2 });
    expect(condition().params).toEqual([59, 9, 4]);
    expect(condition().sql).toContain('"deleted_at" is null');
    expect(new PgDialect().sqlToQuery(stored().version as SQL).sql).toContain('"version" + 1');
  });

  it('does not change handoff ownership or notify when optimistic assignment loses a race', async () => {
    const { execute, notify } = setup(null, false);
    await expect(supportService.updateTicket(9, 59, { assignedMemberId: 5 }, { expectedVersion: 4, expectedTeamId: 2 })).rejects.toMatchObject({ code: 'TICKET_VERSION_CONFLICT' });
    expect(execute.mock.calls.every(([query]) => !new PgDialect().sqlToQuery(query).sql.includes('UPDATE handoff_queue'))).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails the transaction before notification if handoff synchronization fails', async () => {
    const { execute, notify } = setup(null);
    execute.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(supportService.updateTicket(9, 59, { assignedMemberId: 5 }))
      .rejects.toThrow('database unavailable');
    expect(notify).not.toHaveBeenCalled();
  });

  const postgresTest = process.env.SUPPORT_TEMPLATE_QA_DATABASE_URL ? it : it.skip;
  postgresTest('executes the exact synchronization SQL without changing foreign, historical, or paused records', async () => {
    const connectionString = process.env.SUPPORT_TEMPLATE_QA_DATABASE_URL!;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('Assignment QA requires a local PostgreSQL connection.');
    }
    const { execute } = setup();
    await supportService.updateTicket(9, 59, { assignedMemberId: 5 });
    const query = new PgDialect().sqlToQuery(execute.mock.calls.find(([query]) => new PgDialect().sqlToQuery(query).sql.includes('UPDATE handoff_queue'))![0]);
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE handoff_queue (
        id integer PRIMARY KEY, user_id integer, support_ticket_id integer,
        team_id integer, assigned_member_id integer, status text,
        accepted_at timestamp, version integer DEFAULT 1, updated_at timestamp,
        ai_reply_enabled boolean DEFAULT false
      )`);
      await client.query(`INSERT INTO pg_temp.handoff_queue
        (id,user_id,support_ticket_id,team_id,assigned_member_id,status,accepted_at) VALUES
        (1,9,59,2,NULL,'waiting',NULL),
        (2,10,59,2,NULL,'waiting',NULL),
        (3,9,59,2,4,'resolved',NULL),
        (4,9,59,2,5,'in_progress','2026-09-01'),
        (5,9,60,2,NULL,'waiting',NULL)`);
      await client.query(query.sql, query.params);
      const rows = (await client.query('SELECT id,status,assigned_member_id,version,ai_reply_enabled,accepted_at FROM pg_temp.handoff_queue ORDER BY id')).rows;
      expect(rows[0]).toMatchObject({ status: 'assigned', assigned_member_id: 5, version: 2, ai_reply_enabled: false });
      expect(rows[1]).toMatchObject({ status: 'waiting', assigned_member_id: null, version: 1 });
      expect(rows[2]).toMatchObject({ status: 'resolved', assigned_member_id: 4, version: 1 });
      expect(rows[3]).toMatchObject({ status: 'in_progress', assigned_member_id: 5 });
      expect(rows[3].accepted_at).not.toBeNull();
      expect(rows[4]).toMatchObject({ status: 'waiting', assigned_member_id: null, version: 1 });
    } finally {
      await client.end();
    }
  });
});
