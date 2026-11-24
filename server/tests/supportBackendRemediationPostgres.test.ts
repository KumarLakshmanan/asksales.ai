import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Client } from "pg";
import type { Request, Response } from "express";
import { setAiReplyEnabled } from "../controllers/supportHandoffController.js";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableColumns, getTableName, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import crypto from "node:crypto";
import { db } from "../models/db.js";
import { supportTicketsTable } from "../models/supportTickets/schema.js";
import { supportTeamsTable } from "../models/supportTeams/schema.js";
import { teamMembersTable } from "../models/teamMembers/schema.js";
import { supportTicketMessagesTable } from "../models/supportTicketMessages/schema.js";
import { supportChatSessionsTable } from "../models/supportChatSessions/schema.js";
import { supportChatMessagesTable } from "../models/supportChatMessages/schema.js";
import {
  supportAdminAuditLogsTable,
  supportDeliveryOutboxTable,
} from "../models/supportOrchestration/schema.js";
import { handoffQueueTable } from "../models/handoffQueue/schema.js";
import { supportService } from "../services/SupportService.js";
import { withLockedSupportTicket } from "../services/SupportTicketMutation.js";
import {
  supportSlaEventQuery,
  supportSlaBreachCountSql,
} from "../services/SupportSlaService.js";
import { recoverStaleSupportHandoffsQuery } from "../services/SupportTicketRecovery.js";
import { supportTicketOwnershipSql } from "../services/SupportTicketOwnership.js";
import { supportReplyDeliveryService } from "../services/SupportReplyDeliveryService.js";
import { deliveryOutboxService } from "../services/agents/orchestration/DeliveryOutboxService.js";
import { StorageService } from "../services/StorageService.js";
import { handoffService } from "../services/agents/pipeline/HandoffService.js";

// Opt-in only: never use an inherited DB URL, application database, or provider.
const socket = process.env.SUPPORT_REMEDIATION_PG_SOCKET;
const qa = socket ? describe : describe.skip;
const dialect = new PgDialect();
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

qa("support backend remediation on disposable PostgreSQL", () => {
  let client: Client;
  let database: NodePgDatabase;
  let schema: string;
  const connections: Client[] = [];

  async function connect() {
    if (socket !== "/workspace/support-remediation-2026-10-23/pgsocket")
      throw new Error("Only the disposable remediation socket is permitted.");
    const connection = new Client({
      host: socket,
      user: "postgres",
      database: "postgres",
      connectionTimeoutMillis: 5000,
    });
    await connection.connect();
    await connection.query(`SET search_path=${schema}`);
    connections.push(connection);
    return connection;
  }

  beforeEach(async () => {
    schema = `support_fixture_${crypto.randomBytes(6).toString("hex")}`;
    client = await connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path=${schema}`);
    database = drizzle(client);
    for (const table of [
      supportTicketsTable,
      supportTeamsTable,
      teamMembersTable,
      supportTicketMessagesTable,
      supportChatSessionsTable,
      supportChatMessagesTable,
      supportDeliveryOutboxTable,
      handoffQueueTable,
      supportAdminAuditLogsTable,
    ]) {
      const columns = Object.values(getTableColumns(table)).map((column) => {
        let definition = `"${column.name}" ${column.getSQLType()}`;
        if (column.primary) definition += " PRIMARY KEY";
        if (column.notNull) definition += " NOT NULL";
        if (column.name === "business_profile_id") definition += " DEFAULT 1";
        else if (column.default !== undefined) {
          const value = column.default;
          if (value instanceof SQL)
            definition += ` DEFAULT ${dialect.sqlToQuery(value).sql}`;
          else if (column.getSQLType() === "jsonb")
            definition += ` DEFAULT ${quote(typeof value === "string" ? value : JSON.stringify(value))}::jsonb`;
          else
            definition += ` DEFAULT ${typeof value === "string" ? quote(value) : String(value)}`;
        }
        return definition;
      });
      await client.query(
        `CREATE TABLE "${getTableName(table)}" (${columns.join(",")})`,
      );
    }
    await client.query(`CREATE UNIQUE INDEX message_delivery_unique ON support_ticket_messages(delivery_action_id) WHERE delivery_action_id IS NOT NULL;
      CREATE UNIQUE INDEX chat_request_unique ON support_chat_messages(session_id,request_id) WHERE request_id IS NOT NULL;
      CREATE TABLE outreach_conversations(id int PRIMARY KEY,user_id int,status text,automation_mode text,metadata jsonb,updated_at timestamp);
      CREATE TABLE support_notification_events(id serial PRIMARY KEY,business_profile_id int,user_id int,ticket_id int,event_type text,event_key text,
        assigned_member_id int,team_id int,payload jsonb,severity text,safe_summary text,required_action text,sla_deadline timestamp,processing_status text,
        UNIQUE(business_profile_id,user_id,event_key));
      INSERT INTO support_teams(id,user_id,name) VALUES(2,9,'Synthetic Team'),(3,9,'Other Team');
      INSERT INTO team_members(id,user_id,team_id,role,is_active) VALUES(5,9,2,'member',TRUE),(6,9,3,'member',TRUE),(7,9,2,'lead',TRUE);
      INSERT INTO support_tickets(id,user_id,ticket_number,subject,team_id,assigned_member_id,status,version)
        VALUES(59,9,'TKT-SYNTHETIC','Synthetic request',2,5,'in_progress',4);`);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const connection of connections.splice(1)) await connection.end();
    if (client) {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
    connections.length = 0;
  });

  const mutate = (
    changes: Parameters<typeof supportService.updateTicket>[2],
    extra = {},
  ) =>
    database.transaction((tx) =>
      supportService.updateTicket(9, 59, changes, {
        database: tx,
        actorMemberId: 5,
        ...extra,
      }),
    );

  it("HD-01 denies the old member after reassignment, without version input or side effects", async () => {
    await client.query(
      "UPDATE support_tickets SET assigned_member_id=6,team_id=3,version=5 WHERE id=59",
    );
    await expect(mutate({ priority: "urgent" })).rejects.toMatchObject({
      code: "TICKET_ACCESS_REVOKED",
    });
    expect(
      (await client.query("SELECT priority FROM support_tickets")).rows[0]
        .priority,
    ).toBe("medium");
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_ticket_messages",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("rejects a foreign tenant before invoking any mutation effect", async () => {
    const effect = jest.fn(async () => undefined);
    await expect(
      database.transaction((tx) =>
        withLockedSupportTicket(
          10,
          59,
          { database: tx, actorMemberId: 5 },
          effect,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(effect).not.toHaveBeenCalled();
  });

  it.each([
    "deleted",
    "disabled member",
    "disabled team",
    "downgraded supervisor",
  ])("HD-01 rejects %s at the locked mutation", async (condition) => {
    if (condition === "deleted")
      await client.query("UPDATE support_tickets SET deleted_at=NOW()");
    if (condition === "disabled member")
      await client.query("UPDATE team_members SET is_active=FALSE WHERE id=5");
    if (condition === "disabled team")
      await client.query("UPDATE support_teams SET is_active=FALSE WHERE id=2");
    const attempt = () =>
      mutate(
        { priority: "urgent" },
        condition === "downgraded supervisor" ? { requireManage: true } : {},
      );
    if (condition === "deleted") await expect(attempt()).resolves.toBeNull();
    else await expect(attempt()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("HD-01 blocks reassignment while the authorized mutation holds its ticket lock", async () => {
    const competitor = await connect();
    await database.transaction(async (tx) => {
      await withLockedSupportTicket(
        9,
        59,
        { database: tx, actorMemberId: 5 },
        async () => {
          await competitor.query("SET lock_timeout='100ms'");
          await expect(
            competitor.query(
              "UPDATE support_tickets SET assigned_member_id=6,team_id=3 WHERE id=59",
            ),
          ).rejects.toMatchObject({ code: "55P03" });
        },
      );
    });
    await competitor.query(
      "UPDATE support_tickets SET assigned_member_id=6,team_id=3 WHERE id=59",
    );
    await expect(mutate({ status: "closed" })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("HD-03/05/10 resolves priority atomically, then closes retained-human ownership and normalizes timestamps", async () => {
    await client.query(`INSERT INTO outreach_conversations VALUES(68,9,'needs_human','human_owned','{}',NOW());
      UPDATE support_tickets SET outreach_conversation_id=68;
      INSERT INTO handoff_queue(id,user_id,conversation_id,channel,support_ticket_id,team_id,assigned_member_id,status)
        VALUES(12,9,68,'email',59,2,5,'in_progress')`);
    const resolved = await mutate(
      { status: "resolved", priority: "urgent" },
      { expectedVersion: 4, resumeAi: false },
    );
    expect(resolved).toMatchObject({
      status: "resolved",
      priority: "urgent",
      version: 5,
    });
    expect(
      (await client.query("SELECT automation_mode FROM outreach_conversations"))
        .rows[0].automation_mode,
    ).toBe("human_owned");
    const closed = await mutate({ status: "closed" }, { expectedVersion: 5 });
    expect(closed?.resolvedAt).toBeTruthy();
    expect(closed?.closedAt).toBeTruthy();
    expect(
      (
        await client.query(
          "SELECT automation_mode,metadata FROM outreach_conversations",
        )
      ).rows[0],
    ).toMatchObject({
      automation_mode: "ai_active",
      metadata: { ownershipResolution: { resumeAi: true } },
    });
    expect(
      (await client.query("SELECT status FROM handoff_queue")).rows[0].status,
    ).toBe("resolved");
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_ticket_messages WHERE member_id=5 AND is_internal=TRUE",
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("HD-03 closes widget ownership while preserving customer opt-outs", async () => {
    await client.query(
      `INSERT INTO support_chat_sessions(id,member_id,ticket_id,automation_mode) VALUES(20,5,59,'human_owned');`,
    );
    await mutate({ status: "closed" });
    expect(
      (await client.query("SELECT automation_mode FROM support_chat_sessions"))
        .rows[0].automation_mode,
    ).toBe("ai_active");
    await client.query(
      `UPDATE support_chat_sessions SET automation_mode='opted_out'`,
    );
    await mutate({ status: "closed" });
    expect(
      (await client.query("SELECT automation_mode FROM support_chat_sessions"))
        .rows[0].automation_mode,
    ).toBe("opted_out");
    expect(
      (await client.query("SELECT metadata FROM support_tickets")).rows[0]
        .metadata.ownershipResolution,
    ).toBeUndefined();
  });

  it("HD-05 rolls back priority, lifecycle and history on an ownership reconciliation failure", async () => {
    await expect(
      mutate(
        { status: "resolved", priority: "urgent" },
        { expectedHandoffId: 999 },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (
        await client.query(
          "SELECT status,priority,version FROM support_tickets",
        )
      ).rows[0],
    ).toEqual({ status: "in_progress", priority: "medium", version: 4 });
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_ticket_messages",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("HD-04 closes a reopened previously reviewed ticket without claiming a duplicate review", async () => {
    await client.query(
      "UPDATE support_tickets SET review_request_sent_at=NOW()-INTERVAL '1 day',review_request_delivery_status='sent'",
    );
    const result = await database.transaction((tx) =>
      supportService.claimReviewRequest(9, 59, {
        database: tx,
        actorMemberId: 5,
        expectedVersion: 4,
      }),
    );
    expect(result?.state).toBe("already_sent");
    expect(result?.ticket.status).toBe("closed");
    expect(result?.ticket.resolvedAt).toBeTruthy();
    expect(result?.ticket.closedAt).toBeTruthy();
  });

  it("HD-02 releases both owners and permits a replacement to claim the same work once", async () => {
    await client.query(`INSERT INTO handoff_queue(id,user_id,conversation_id,channel,support_ticket_id,team_id,assigned_member_id,status,accepted_at)
      VALUES(12,9,68,'email',59,2,5,'in_progress',NOW()-INTERVAL '40 minutes')`);
    const recovered = await database.execute(
      recoverStaleSupportHandoffsQuery(),
    );
    expect(recovered.rows[0].recovered).toBe(1);
    expect(
      (await client.query("SELECT assigned_member_id FROM support_tickets"))
        .rows[0].assigned_member_id,
    ).toBeNull();
    jest
      .spyOn(db, "transaction")
      .mockImplementation((...args: unknown[]) =>
        database.transaction(args[0] as (tx: unknown) => Promise<unknown>),
      );
    const claimed = await supportService.claimTicket(9, 59, 7, 5);
    expect(claimed.assignedMemberId).toBe(7);
    expect(
      (
        await client.query(
          "SELECT assigned_member_id,status FROM handoff_queue",
        )
      ).rows[0],
    ).toEqual({ assigned_member_id: 7, status: "in_progress" });
    expect(
      (await database.execute(recoverStaleSupportHandoffsQuery())).rows[0]
        .recovered,
    ).toBe(0);
  });

  it("preserves stale-claim recovery for legacy handoffs without changing unrelated tickets", async () => {
    await client.query(`INSERT INTO handoff_queue(id,user_id,conversation_id,channel,assigned_member_id,status,accepted_at)
      VALUES(12,9,68,'email',5,'in_progress',NOW()-INTERVAL '40 minutes')`);
    expect(
      (await database.execute(recoverStaleSupportHandoffsQuery())).rows[0]
        .recovered,
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT status,assigned_member_id FROM handoff_queue",
        )
      ).rows[0],
    ).toEqual({ status: "waiting", assigned_member_id: null });
    expect(
      (
        await client.query(
          "SELECT assigned_member_id,version FROM support_tickets",
        )
      ).rows[0],
    ).toEqual({ assigned_member_id: 5, version: 4 });
  });

  it("locks the ticket before toggling linked AI controls and preserves customer opt-outs", async () => {
    await client.query(`INSERT INTO outreach_conversations VALUES(68,9,'active','opted_out','{}',NOW());
      UPDATE support_tickets SET outreach_conversation_id=68;
      INSERT INTO handoff_queue(id,user_id,conversation_id,channel,support_ticket_id,team_id,assigned_member_id,status)
      VALUES(12,9,68,'email',59,2,5,'in_progress')`);
    const competitor = await connect();
    await competitor.query("SET lock_timeout='100ms'");
    let checked = false;
    jest.spyOn(db, "transaction").mockImplementation((...args: unknown[]) =>
      database.transaction(async (tx) => {
        const execute = tx.execute.bind(tx);
        jest
          .spyOn(tx, "execute")
          .mockImplementation((query: Parameters<typeof tx.execute>[0]) => {
            const pending = execute(query);
            if (
              dialect
                .sqlToQuery(query as SQL)
                .sql.includes("UPDATE handoff_queue")
            ) {
              const perform = pending.execute.bind(pending);
              jest.spyOn(pending, "execute").mockImplementation(async () => {
                await expect(
                  competitor.query(
                    "UPDATE support_tickets SET assigned_member_id=7 WHERE id=59",
                  ),
                ).rejects.toMatchObject({ code: "55P03" });
                checked = true;
                return perform();
              });
            }
            return pending;
          });
        return (args[0] as (tx: unknown) => Promise<unknown>)(tx);
      }),
    );
    jest.spyOn(db, "select").mockImplementation(database.select.bind(database));
    const req = {
      params: { id: "12" },
      body: { enabled: false },
      supportMember: { id: 5, userId: 9, teamId: 2, role: "member" },
    } as unknown as Request;
    const json = jest.fn();
    const status = jest.fn().mockReturnThis();
    await setAiReplyEnabled(req, { json, status } as unknown as Response);
    expect(checked).toBe(true);
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(
      (await client.query("SELECT automation_mode FROM outreach_conversations"))
        .rows[0].automation_mode,
    ).toBe("opted_out");
    expect(
      (await client.query("SELECT ai_reply_enabled FROM handoff_queue")).rows[0]
        .ai_reply_enabled,
    ).toBe(false);
    expect(
      (await client.query("SELECT version FROM support_tickets")).rows[0]
        .version,
    ).toBe(5);
  });

  it("HD-06/07 ignores display tags, covers waiting deadlines, excludes deleted records, and emits once per generation", async () => {
    await client.query(`UPDATE support_tickets SET status='waiting_on_customer',sla_deadline=NOW()-INTERVAL '1 minute',tags='["sla_breached"]';
      INSERT INTO support_tickets(id,user_id,ticket_number,subject,status,sla_deadline,deleted_at) VALUES(60,9,'DELETED','Synthetic deleted','open',NOW()-INTERVAL '1 minute',NOW());`);
    expect(
      (await database.execute(supportSlaEventQuery("breached"))).rows[0]
        .created,
    ).toBe(1);
    expect(
      (await database.execute(supportSlaEventQuery("breached"))).rows[0]
        .created,
    ).toBe(0);
    await client.query(
      "DELETE FROM support_notification_events WHERE ticket_id=59",
    );
    expect(
      (await database.execute(supportSlaEventQuery("breached"))).rows[0]
        .created,
    ).toBe(0);
    await client.query(
      `UPDATE support_tickets SET metadata='{"slaGeneration":"second"}' WHERE id=59`,
    );
    expect(
      (await database.execute(supportSlaEventQuery("breached"))).rows[0]
        .created,
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_notification_events WHERE ticket_id=60",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("HD-06 event insertion failure rolls back the event/tag and retry heals it", async () => {
    await client.query(`UPDATE support_tickets SET sla_deadline=NOW()+INTERVAL '5 minutes';
      ALTER TABLE support_notification_events ADD CONSTRAINT injected_failure CHECK (ticket_id<>59)`);
    await expect(
      database.execute(supportSlaEventQuery("at_risk")),
    ).rejects.toThrow();
    expect(
      (await client.query("SELECT tags FROM support_tickets")).rows[0].tags,
    ).toEqual([]);
    await client.query(
      "ALTER TABLE support_notification_events DROP CONSTRAINT injected_failure",
    );
    expect(
      (await database.execute(supportSlaEventQuery("at_risk"))).rows[0].created,
    ).toBe(1);
    expect(
      (await database.execute(supportSlaEventQuery("at_risk"))).rows[0].created,
    ).toBe(0);
  });

  it("HD-06 preserves legacy event deduplication and a changed deadline creates a new generation", async () => {
    await client.query(`UPDATE support_tickets SET sla_deadline=NOW()-INTERVAL '1 minute';
      INSERT INTO support_notification_events(business_profile_id,user_id,ticket_id,event_type,event_key,sla_deadline)
        SELECT 1,9,59,'sla_breached','legacy-event-key',sla_deadline FROM support_tickets`);
    expect(
      (await database.execute(supportSlaEventQuery("breached"))).rows[0]
        .created,
    ).toBe(0);
    const changed = await mutate({
      slaDeadline: new Date(Date.now() - 120000),
    });
    expect(changed?.metadata?.slaGeneration).toBeTruthy();
    expect(
      (await database.execute(supportSlaEventQuery("breached"))).rows[0]
        .created,
    ).toBe(1);
  });

  it("HD-06 drains more than one batch without starvation and concurrent jobs deduplicate", async () => {
    await client.query(`INSERT INTO support_tickets(id,user_id,ticket_number,subject,status,sla_deadline)
      SELECT id,9,'TKT-'||id,'Synthetic','open',NOW()-INTERVAL '1 minute' FROM generate_series(1000,1200) id`);
    expect(
      (await database.execute(supportSlaEventQuery("breached"))).rows[0]
        .created,
    ).toBe(200);
    const competitor = drizzle(await connect());
    const results = await Promise.all([
      database.execute(supportSlaEventQuery("breached")),
      competitor.execute(supportSlaEventQuery("breached")),
    ]);
    expect(
      results.reduce((sum, result) => sum + Number(result.rows[0].created), 0),
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_notification_events",
        )
      ).rows[0].n,
    ).toBe(201);
  });

  it("HD-10 does not retroactively breach a legacy ticket closed before its deadline", async () => {
    await client.query(
      `UPDATE support_tickets SET status='closed',resolved_at=NULL,closed_at=NOW()-INTERVAL '1 hour',sla_deadline=NOW()-INTERVAL '30 minutes'`,
    );
    const result = await database
      .select({ breaches: supportSlaBreachCountSql() })
      .from(supportTicketsTable);
    expect(Number(result[0].breaches)).toBe(0);
  });

  it("HD-08 rejects an inactive queue before creating or moving a ticket", async () => {
    await client.query("UPDATE support_teams SET is_active=FALSE WHERE id=3");
    await expect(mutate({ teamId: 3 }, { actorMemberId: 7 })).rejects.toThrow(
      "inactive support team",
    );
    await expect(
      database.transaction((tx) =>
        supportService.createTicket(
          9,
          { subject: "Synthetic", teamId: 3, category: "ai_handoff" },
          { database: tx },
        ),
      ),
    ).rejects.toThrow("inactive support team");
    expect(
      (await client.query("SELECT count(*)::int n FROM support_tickets"))
        .rows[0].n,
    ).toBe(1);
  });

  it("HD-09 shares AI-active and retained-human ownership predicates", async () => {
    await client.query(
      `INSERT INTO handoff_queue(user_id,conversation_id,channel,support_ticket_id,ai_reply_enabled) VALUES(9,68,'email',59,TRUE)`,
    );
    let result = await database
      .select({ ownership: supportTicketOwnershipSql() })
      .from(supportTicketsTable);
    expect(result[0].ownership).toBe("ai_active");
    await client.query("UPDATE handoff_queue SET ai_reply_enabled=FALSE");
    result = await database
      .select({ ownership: supportTicketOwnershipSql() })
      .from(supportTicketsTable);
    expect(result[0].ownership).toBe("human_owned");
    await client.query(`INSERT INTO outreach_conversations VALUES(68,9,'needs_human','human_owned','{}',NOW());
      UPDATE support_tickets SET outreach_conversation_id=68;
      UPDATE handoff_queue SET status='resolved'`);
    result = await database
      .select({ ownership: supportTicketOwnershipSql() })
      .from(supportTicketsTable);
    expect(result[0].ownership).toBe("human_owned");
    await client.query(
      "UPDATE outreach_conversations SET automation_mode='ai_active'",
    );
    result = await database
      .select({ ownership: supportTicketOwnershipSql() })
      .from(supportTicketsTable);
    expect(result[0].ownership).toBe("ai_active");
  });

  it("keeps private notes local, does not reopen closed tickets, and rejects stale-member replies before claiming delivery", async () => {
    await client.query(
      "UPDATE support_tickets SET status='closed',closed_at=NOW(),resolved_at=NOW()",
    );
    jest
      .spyOn(db, "transaction")
      .mockImplementation((...args: unknown[]) =>
        database.transaction(args[0] as (tx: unknown) => Promise<unknown>),
      );
    const claim = jest.spyOn(deliveryOutboxService, "claim");
    const [ticket] = await database.select().from(supportTicketsTable);
    const note = await supportReplyDeliveryService.deliver({
      ticket,
      actorMemberId: 5,
      content: "Synthetic private note",
      isInternal: true,
    });
    expect(note.message.isInternal).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(
      (await client.query("SELECT status FROM support_tickets")).rows[0].status,
    ).toBe("closed");
    await client.query(
      "UPDATE support_tickets SET team_id=3,assigned_member_id=6",
    );
    await expect(
      supportReplyDeliveryService.deliver({
        ticket,
        actorMemberId: 5,
        content: "Must not send",
        isInternal: false,
        idempotencyKey: "synthetic-request",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(claim).not.toHaveBeenCalled();
  });

  it("revalidates attachment scope on service/recovery entry before persisting or claiming delivery", async () => {
    jest
      .spyOn(db, "transaction")
      .mockImplementation((...args: unknown[]) =>
        database.transaction(args[0] as (tx: unknown) => Promise<unknown>),
      );
    jest.spyOn(StorageService, "getInstance").mockReturnValue({
      getFile: async () => ({
        id: 99,
        referenceType: "support_ticket",
        referenceId: "60",
      }),
    } as never);
    const claim = jest.spyOn(deliveryOutboxService, "claim");
    const [ticket] = await database.select().from(supportTicketsTable);
    await expect(
      supportReplyDeliveryService.deliver({
        ticket,
        actorMemberId: 5,
        content: "Synthetic note",
        isInternal: true,
        attachments: [
          {
            fileId: 99,
            name: "synthetic.txt",
            url: "private",
            type: "text/plain",
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(claim).not.toHaveBeenCalled();
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_ticket_messages",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("persists one web reply on replay and rejects content changes before claiming the same identity", async () => {
    jest
      .spyOn(db, "transaction")
      .mockImplementation((...args: unknown[]) =>
        database.transaction(args[0] as (tx: unknown) => Promise<unknown>),
      );
    const payload = {
      text: "Synthetic answer",
      recipient: "synthetic-token",
      metadata: { ticketId: 59, attachments: [] },
    };
    await client.query(
      `INSERT INTO support_chat_sessions(id,member_id,ticket_id,public_token,session_expires_at) VALUES(20,5,59,'synthetic-token',NOW()+INTERVAL '1 hour')`,
    );
    await database.insert(supportDeliveryOutboxTable).values({
      id: 55,
      userId: 9,
      conversationId: -20,
      channel: "web",
      decisionKey: "synthetic",
      status: "sending",
      payload,
    });
    const claim = jest
      .spyOn(deliveryOutboxService, "claim")
      .mockResolvedValueOnce({
        state: "claimed",
        action: { id: 55, payload },
      } as never)
      .mockResolvedValueOnce({
        state: "already_sent",
        action: { id: 55, payload },
      } as never)
      .mockResolvedValueOnce({
        state: "already_sent",
        action: { id: 55, payload },
      } as never);
    const [ticket] = await database.select().from(supportTicketsTable);
    const input = {
      ticket,
      actorMemberId: 5,
      content: "Synthetic answer",
      isInternal: false,
      idempotencyKey: "synthetic-web-request",
    };
    expect((await supportReplyDeliveryService.deliver(input)).replayed).toBe(
      false,
    );
    expect((await supportReplyDeliveryService.deliver(input)).replayed).toBe(
      true,
    );
    expect(
      (await client.query("SELECT count(*)::int n FROM support_chat_messages"))
        .rows[0].n,
    ).toBe(1);
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_ticket_messages",
        )
      ).rows[0].n,
    ).toBe(1);
    // Persist the real decision key to exercise the pre-claim immutable-payload guard.
    const { createDeliveryDecisionKey } =
      await import("../services/agents/orchestration/DeliveryOutboxService.js");
    const key = createDeliveryDecisionKey({
      userId: 9,
      conversationId: -20,
      channel: "web",
      inboundProviderMessageId: "manual:synthetic-web-request",
    });
    await client.query("UPDATE support_delivery_outbox SET decision_key=$1", [
      key,
    ]);
    await expect(
      supportReplyDeliveryService.deliver({
        ...input,
        content: "Different answer",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("replays persisted email attachments regardless of JSONB key ordering and rejects changed attachment values", async () => {
    jest
      .spyOn(db, "transaction")
      .mockImplementation((...args: unknown[]) =>
        database.transaction(args[0] as (tx: unknown) => Promise<unknown>),
      );
    const attachments = [
      {
        fileId: 70,
        name: "synthetic.txt",
        url: "/api/support-media/70",
        type: "text/plain",
      },
    ];
    jest.spyOn(StorageService.getInstance(), "getFile").mockResolvedValue({
      id: 70,
      referenceType: "support_ticket",
      referenceId: "59",
      userId: 9,
    } as never);
    const { createDeliveryDecisionKey } =
      await import("../services/agents/orchestration/DeliveryOutboxService.js");
    const decisionKey = createDeliveryDecisionKey({
      userId: 9,
      conversationId: 59,
      channel: "email",
      inboundProviderMessageId: "manual:synthetic-attachments",
    });
    const [action] = await database
      .insert(supportDeliveryOutboxTable)
      .values({
        id: 55,
        userId: 9,
        conversationId: 59,
        channel: "email",
        decisionKey,
        status: "sent",
        providerMessageId: "synthetic-provider-ack",
        payload: {
          text: "Synthetic answer",
          recipient: "customer@synthetic.invalid",
          metadata: { ticketId: 59, attachments },
        },
      })
      .returning();
    const claim = jest
      .spyOn(deliveryOutboxService, "claim")
      .mockResolvedValue({ state: "already_sent", action });
    const [ticket] = await database.select().from(supportTicketsTable);
    const input = {
      ticket,
      actorMemberId: 5,
      content: "Synthetic answer",
      isInternal: false,
      idempotencyKey: "synthetic-attachments",
      attachments,
    };
    expect((await supportReplyDeliveryService.deliver(input)).replayed).toBe(
      true,
    );
    await expect(
      supportReplyDeliveryService.deliver({
        ...input,
        attachments: [{ ...attachments[0], name: "changed.txt" }],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM support_ticket_messages",
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("uses the same locked lifecycle when the handoff API resolves a linked ticket", async () => {
    jest
      .spyOn(db, "transaction")
      .mockImplementation((...args: unknown[]) =>
        database.transaction(args[0] as (tx: unknown) => Promise<unknown>),
      );
    jest.spyOn(db, "select").mockImplementation(database.select.bind(database));
    await client.query(`INSERT INTO outreach_conversations VALUES(68,9,'needs_human','human_owned','{}',NOW());
      UPDATE support_tickets SET outreach_conversation_id=68;
      INSERT INTO handoff_queue(id,user_id,conversation_id,channel,support_ticket_id,team_id,assigned_member_id,status)
      VALUES(12,9,68,'email',59,2,5,'in_progress')`);
    await handoffService.resolve(9, 12, "closed", 5);
    expect(
      (await client.query("SELECT status FROM support_tickets")).rows[0].status,
    ).toBe("closed");
    expect(
      (await client.query("SELECT automation_mode FROM outreach_conversations"))
        .rows[0].automation_mode,
    ).toBe("ai_active");
  });
});
