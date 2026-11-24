/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, getTableColumns, getTableName, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { toolApprovalsTable as approvals } from '../models/toolApprovals/schema.js';
import { supportToolExecutionsTable as executions } from '../models/supportOrchestration/schema.js';

// Opt in with a disposable local PostgreSQL Unix socket. Never use application
// DB settings, TCP hosts, public tables, production credentials or providers.
const socket = process.env.SUPPORT_APPROVAL_QA_SOCKET;
const postgresTests = socket ? describe : describe.skip;
const schema = `support_approval_qa_${randomBytes(8).toString('hex')}`;
const clients: Client[] = [];
let admin: Client;
let database: NodePgDatabase;
let controllerDatabase: NodePgDatabase;
let sqlErrors: string[];
type QueryHook = (text: string) => Promise<void>;

const dispatch = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, key) => {
    const value = (controllerDatabase as any)[key];
    return typeof value === 'function' ? value.bind(controllerDatabase) : value;
  },
}) }));
jest.unstable_mockModule('../services/agents/subagents/index.js', () => ({ subAgentRegistry: { dispatchAny: dispatch } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  decryptRestrictedPayload: (_user: number, _purpose: string, value: unknown) => value,
  isPrivacyVaultConfigured: () => true,
}));
jest.unstable_mockModule('../services/agents/orchestration/SafeToolExecutor.js', () => ({
  sanitizeSupportToolData: (value: unknown) => value, supportToolArgumentDigest: () => 'synthetic-digest',
}));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  assistantProvenanceCurrent: async () => true, assertAssistantFresh: async () => undefined,
  withPublishedAssistant: async (_value: unknown, work: () => unknown) => work(),
}));
jest.unstable_mockModule('../services/agents/orchestration/SupportAgentRuntime.js', () => ({ supportAgentRuntime: {
  recordToolOutcome: (_name: unknown, _args: unknown, result: any) => ({
    status: result.toolResults?.[0]?.result?.success ? 'success' : 'failed',
    success: result.toolResults?.[0]?.result?.success === true,
    confirmedSideEffect: result.toolResults?.[0]?.result?.confirmedSideEffect === true,
  }),
} }));
// Unrelated controller dependencies and provider entry points stay mocked. The
// reconciliation controller, resume service and their SQL run unchanged.
jest.unstable_mockModule('../services/agents/pipeline/ChannelGateway.js', () => ({ channelGateway: {} }));
jest.unstable_mockModule('../services/agents/orchestration/PlaybookEngine.js', () => ({ playbookChecksum: jest.fn(), validatePlaybookGraph: jest.fn() }));
jest.unstable_mockModule('../services/agents/orchestration/SupportAdminAuditService.js', () => ({ recordSupportAdminAudit: jest.fn() }));
jest.unstable_mockModule('../services/agents/orchestration/DefaultSupportConfiguration.js', () => ({ SUPPORT_AGENT_TYPES: [] }));
jest.unstable_mockModule('../services/agents/NLUService.js', () => ({ SUPPORT_INTENTS: [] }));
jest.unstable_mockModule('../services/agents/orchestration/DefaultSupportProvisioningService.js', () => ({ ensureDefaultSupportConfiguration: jest.fn() }));
jest.unstable_mockModule('../services/agents/orchestration/SupportPlaybookTemplateService.js', () => ({
  enforcePlaybookControlMetadata: jest.fn(), installTenantPlaybookTemplate: jest.fn(),
  listSupportTemplates: jest.fn(), resetTenantPlaybookToTemplate: jest.fn(),
}));
jest.unstable_mockModule('../services/agents/pipeline/stages/AgentConfigurationStage.js', () => ({ assignmentAgentAvailabilityError: jest.fn() }));
const { SupportToolResumeService } = await import('../services/agents/orchestration/SupportToolResumeService.js');
const { reconcileToolExecution, listApprovalRecovery } = await import('../controllers/supportOrchestrationController.js');
const result = { toolResults: [{ name: 'create_booking', result: { success: true, confirmedSideEffect: true } }] };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function connection(hooks: { before?: QueryHook; after?: QueryHook } = {}) {
  const client = new Client({ host: socket, database: 'agent_reliability_qa', user: 'postgres',
    options: `-c search_path=${schema},pg_catalog -c statement_timeout=8000 -c timezone=UTC`,
  });
  await client.connect();
  clients.push(client);
  const original = client.query.bind(client);
  // Observe/pause real SQL only; do not simulate row locks or replace results.
  client.query = (async (query: any, ...args: any[]) => {
    const text = typeof query === 'string' ? query : query.text;
    await hooks.before?.(text);
    try {
      const response = await (original as any)(query, ...args);
      await hooks.after?.(text);
      return response;
    } catch (error) {
      sqlErrors.push((error as { code?: string }).code || String(error));
      throw error;
    }
  }) as typeof client.query;
  return { client, database: drizzle(client) };
}

async function seed(overrides: Record<string, unknown> = {}) {
  await database.insert(approvals).values({ id: 1, userId: 7, threadId: 42, status: 'approved', resumeStatus: 'ready',
    resumeAvailableAt: new Date(Date.now() - 100), toolName: 'create_booking', resumeAttemptCount: 0,
    argumentDigest: 'synthetic-digest', expiresAt: new Date(Date.now() + 60_000), isExpired: false,
    resumePayload: { idempotencyKey: 'synthetic-operation', argumentDigest: 'synthetic-digest', toolName: 'create_booking',
      args: { room_type_id: 1 }, context: { userId: 7, conversationId: 42 } }, ...overrides,
  });
}

async function states() {
  return { approval: (await database.select().from(approvals))[0], execution: (await database.select().from(executions))[0] };
}

async function waitForBlocked(waiter: Client, blocker: Client) {
  const waiterPid = (waiter as any).processID;
  const blockerPid = (blocker as any).processID;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query('SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked', [waiterPid, blockerPid]);
    if (rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected PostgreSQL lock dependency was not observed.');
}

async function pausedDuplicate() {
  const locked = deferred();
  const release = deferred();
  const conn = await connection({ after: async text => {
    if (text.startsWith('select ') && text.includes('from "tool_approvals"') && text.includes('for update')) {
      locked.resolve(); await release.promise;
    }
  } });
  const pending = new SupportToolResumeService(conn.database).resumeApproval(7, 1);
  // Attach rejection observation immediately, before starting a possible cycle.
  const settled = Promise.allSettled([pending]);
  await locked.promise;
  return { ...conn, pending, settled, release };
}

async function reconcile(userId = 7, outcome = 'not_executed') {
  const response = { statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  await reconcileToolExecution({ user: { id: userId }, params: { id: '1' },
    body: { outcome, note: 'Synthetic operator verification', result },
  } as any, response as any);
  return response;
}

postgresTests('approval execution concurrency on disposable PostgreSQL', () => {
  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test' || !socket || !isAbsolute(socket)) throw new Error('A synthetic local PostgreSQL socket is required.');
    admin = new Client({ host: socket, database: 'agent_reliability_qa', user: 'postgres' });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}",pg_catalog;
      CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql AS 'SELECT 9'`);
    const dialect = new PgDialect();
    // Generate the two fixture tables from application column definitions;
    // preserve the real execution -> approval FK and idempotency uniqueness.
    for (const table of [approvals, executions]) {
      const definitions = Object.values(getTableColumns(table)).map(column => {
        let definition = `"${column.name}" ${column.getSQLType()}`;
        if (column.primary) definition += ' PRIMARY KEY';
        if (column.notNull) definition += ' NOT NULL';
        if (column.default instanceof SQL) definition += ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`;
        else if (column.default !== undefined) {
          const value = typeof column.default === 'object' ? JSON.stringify(column.default) : String(column.default);
          definition += ` DEFAULT '${value.replaceAll("'", "''")}'`;
        }
        return definition;
      });
      await admin.query(`CREATE TABLE "${getTableName(table)}" (${definitions.join(', ')})`);
    }
    await admin.query(`ALTER TABLE support_tool_executions ADD UNIQUE(idempotency_key);
      ALTER TABLE support_tool_executions ADD FOREIGN KEY(approval_id) REFERENCES tool_approvals(id) ON DELETE SET NULL`);
    database = (await connection()).database;
  });
  afterAll(async () => {
    await Promise.all(clients.map(client => client.end()));
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    sqlErrors = []; jest.clearAllMocks(); dispatch.mockResolvedValue(result);
    await admin.query('TRUNCATE support_tool_executions, tool_approvals RESTART IDENTITY');
  });

  it('completes successfully when a duplicate claim owns the approval lock', async () => {
    await seed();
    const started = deferred(); const effect = deferred<typeof result>();
    dispatch.mockImplementationOnce(() => { started.resolve(); return effect.promise; });
    const owner = await connection();
    const first = new SupportToolResumeService(owner.database).resumeApproval(7, 1);
    const firstSettled = Promise.allSettled([first]);
    await started.promise;
    const duplicate = await pausedDuplicate();
    try {
      effect.resolve(result);
      await waitForBlocked(owner.client, duplicate.client);
    } finally { duplicate.release.resolve(); }
    const outcomes = [...await firstSettled, ...await duplicate.settled];
    expect(sqlErrors).toEqual([]); // Before correction: PostgreSQL 40P01.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await first).toEqual(result); expect(await duplicate.pending).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const saved = await states();
    expect(saved.approval).toMatchObject({ status: 'consumed', resumeStatus: 'completed', consumedExecutionId: 1 });
    expect(saved.execution).toMatchObject({ status: 'success', result, attemptCount: 1 });
  }, 15000);

  it('serializes owner reconciliation with duplicate claims and fences an old completion after retry', async () => {
    await seed();
    const started = deferred(); const effect = deferred<typeof result>();
    dispatch.mockImplementationOnce(() => { started.resolve(); return effect.promise; });
    const owner = await connection();
    const first = new SupportToolResumeService(owner.database).resumeApproval(7, 1);
    await started.promise;
    const duplicate = await pausedDuplicate();
    const reviewer = await connection(); controllerDatabase = reviewer.database;
    const reviewed = reconcile(); const reviewedSettled = Promise.allSettled([reviewed]);
    try { await waitForBlocked(reviewer.client, duplicate.client); }
    finally { duplicate.release.resolve(); }
    const outcomes = [...await reviewedSettled, ...await duplicate.settled];
    // Always settle the mocked operation, even when the pre-fix witness fails.
    try {
      expect(sqlErrors).toEqual([]);
      expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await reviewed).statusCode).toBe(200);
      expect(await duplicate.pending).toBeNull();
      const retry = new SupportToolResumeService((await connection()).database);
      dispatch.mockResolvedValue({ ...result, replyText: 'Attempt two' });
      expect(await retry.resumeApproval(7, 1)).toMatchObject({ replyText: 'Attempt two' });
      effect.resolve(result); await first;
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect((await states()).execution).toMatchObject({ status: 'success', attemptCount: 2, result: { replyText: 'Attempt two' } });
      expect(await retry.resumeApproval(7, 1)).toBeNull();
      expect(dispatch).toHaveBeenCalledTimes(2);
    } finally { effect.resolve(result); await first; }
  }, 15000);

  it('claims simultaneous initial requests once and never replays consumed work', async () => {
    await seed();
    const services = await Promise.all([connection(), connection()]);
    await Promise.all(services.map(conn => new SupportToolResumeService(conn.database).resumeApproval(7, 1)));
    expect(dispatch).toHaveBeenCalledTimes(1); expect(sqlErrors).toEqual([]);
    expect((await states()).execution).toMatchObject({ status: 'success', attemptCount: 1 });
    expect(await new SupportToolResumeService(database).resumeApproval(7, 1)).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('observes cancellation committed while a claim waits for the approval lock', async () => {
    await seed();
    const cancel = await connection(); const claimant = await connection();
    await cancel.client.query('BEGIN');
    await cancel.database.update(approvals).set({ status: 'expired', isExpired: true, resumeStatus: 'cancelled' })
      .where(and(eq(approvals.id, 1), eq(approvals.userId, 7), eq(approvals.status, 'approved')));
    const pending = new SupportToolResumeService(claimant.database).resumeApproval(7, 1);
    try { await waitForBlocked(claimant.client, cancel.client); }
    finally { await cancel.client.query('COMMIT'); }
    expect(await pending).toBeNull(); expect(dispatch).not.toHaveBeenCalled();
    expect((await states()).execution).toBeUndefined(); expect(sqlErrors).toEqual([]);
    expect((await states()).approval).toMatchObject({ status: 'expired', resumeStatus: 'cancelled' });
  });

  it('retains failed outcomes for reconciliation instead of dispatching an automatic retry', async () => {
    await seed(); dispatch.mockRejectedValueOnce(new Error('Synthetic uncertain provider outcome'));
    const service = new SupportToolResumeService(database);
    expect(await service.resumeApproval(7, 1)).toBeNull();
    expect(await service.resumeApproval(7, 1)).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await states()).execution).toMatchObject({ status: 'failed', reconciliationStatus: 'pending', attemptCount: 1 });
    expect(sqlErrors).toEqual([]);
  });

  it('rejects expired approvals and foreign-owner reconciliation without effects', async () => {
    await seed({ expiresAt: new Date(Date.now() - 1) });
    expect(await new SupportToolResumeService(database).resumeApproval(7, 1)).toBeNull();
    expect(dispatch).not.toHaveBeenCalled(); expect((await states()).execution).toBeUndefined();
    controllerDatabase = database;
    expect((await reconcile(8)).statusCode).toBe(409); expect(sqlErrors).toEqual([]);
  });

  it('projects owner-scoped blocked approvals without protected payload, digest or raw error', async () => {
    await seed({ resumeError: 'synthetic-private-error-must-not-be-returned' });
    controllerDatabase = database;
    const response = { body: undefined as unknown, statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
    };
    await listApprovalRecovery({ user: { id: 7 } } as any, response as any);
    const rows = response.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, toolName: 'create_booking', resumeStatus: 'ready' });
    expect(Object.keys(rows[0]).sort()).toEqual(['expiresAt', 'id', 'message', 'resumeStatus', 'status', 'threadId', 'toolName', 'updatedAt']);
    expect(JSON.stringify(rows)).not.toContain('synthetic-private-error');
    expect(JSON.stringify(rows)).not.toContain('synthetic-digest');
    expect(JSON.stringify(rows)).not.toContain('room_type_id');
    await listApprovalRecovery({ user: { id: 8 } } as any, response as any);
    expect(response.body).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
