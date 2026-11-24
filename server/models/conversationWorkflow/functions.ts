import crypto from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { icpProfilesTable } from '../icpData/schema';
import { leadInputsTable, type InsertLeadInput, type LeadInputRecord } from '../leadInputs/schema';
import { leadsTable } from '../leads/schema';
import { assertLeadInputsUnchanged, readLeadInputSnapshot, snapshotLeadInput } from './leadInputSnapshot';
import {
  conversationWorkflowActionsTable,
  conversationWorkflowRunsTable,
  leadInputSetsTable,
  leadSelectionSnapshotsTable,
  leadStrategySelectionsTable,
  type ConversationWorkflowActionRecord,
  type ConversationWorkflowRunRecord,
  type LeadInputSetRecord,
  type LeadSelectionSnapshotRecord,
  type LeadStrategySelectionRecord,
} from './schema';
import {
  assertWorkflowTransition,
  isTerminalWorkflowStatus,
  type ConversationWorkflowStage,
  type ConversationWorkflowStatus,
} from './stateMachine';

const ACTIVE_STATUSES: ConversationWorkflowStatus[] = [
  'awaiting_input', 'awaiting_approval', 'running', 'queued',
];

export async function getActiveConversationWorkflowRun(
  userId: number,
  threadId: number,
): Promise<ConversationWorkflowRunRecord | undefined> {
  const [run] = await db.select()
    .from(conversationWorkflowRunsTable)
    .where(and(
      eq(conversationWorkflowRunsTable.userId, userId),
      eq(conversationWorkflowRunsTable.threadId, threadId),
      inArray(conversationWorkflowRunsTable.status, ACTIVE_STATUSES),
    ))
    .orderBy(desc(conversationWorkflowRunsTable.updatedAt))
    .limit(1);
  return run;
}

export async function getLatestConversationWorkflowRun(
  userId: number,
  threadId: number,
): Promise<ConversationWorkflowRunRecord | undefined> {
  const [run] = await db.select()
    .from(conversationWorkflowRunsTable)
    .where(and(
      eq(conversationWorkflowRunsTable.userId, userId),
      eq(conversationWorkflowRunsTable.threadId, threadId),
    ))
    .orderBy(desc(conversationWorkflowRunsTable.updatedAt))
    .limit(1);
  return run;
}

export async function ensureConversationWorkflowRun(input: {
  userId: number;
  threadId: number;
  runId?: string;
  originalRequest?: string;
  stage?: ConversationWorkflowStage;
}): Promise<ConversationWorkflowRunRecord> {
  const existing = await getActiveConversationWorkflowRun(input.userId, input.threadId);
  if (existing) return existing;

  try {
    const [created] = await db.insert(conversationWorkflowRunsTable).values({
      id: input.runId ?? crypto.randomUUID(),
      userId: input.userId,
      threadId: input.threadId,
      originalRequest: input.originalRequest,
      stage: input.stage ?? 'icp_draft',
      status: 'running',
    }).returning();
    return created;
  } catch (error) {
    // A concurrent request can win the active-run partial unique index.
    const raced = await getActiveConversationWorkflowRun(input.userId, input.threadId);
    if (raced) return raced;
    throw error;
  }
}

export async function transitionConversationWorkflowRun(input: {
  runId: string;
  userId: number;
  threadId: number;
  toStage: ConversationWorkflowStage;
  status: ConversationWorkflowStatus;
  contextPatch?: Record<string, unknown>;
  expectedVersion?: number;
  onlyFromStage?: ConversationWorkflowStage;
}): Promise<ConversationWorkflowRunRecord> {
  return db.transaction(async (tx: typeof db) => {
    const [current] = await tx.select()
      .from(conversationWorkflowRunsTable)
      .where(and(
        eq(conversationWorkflowRunsTable.id, input.runId),
        eq(conversationWorkflowRunsTable.userId, input.userId),
        eq(conversationWorkflowRunsTable.threadId, input.threadId),
      ))
      .for('update')
      .limit(1);
    if (!current) throw new Error('Conversation workflow run not found');
    // A tool may have advanced the run while the orchestration call was active.
    // Do not overwrite its more-specific durable stage during reconciliation.
    if (input.onlyFromStage && current.stage !== input.onlyFromStage) return current;
    if (input.expectedVersion != null && current.version !== input.expectedVersion) {
      throw new Error('Conversation workflow run changed; reload before retrying');
    }

    assertWorkflowTransition(current.stage as ConversationWorkflowStage, input.toStage);
    const context = { ...(current.context ?? {}), ...(input.contextPatch ?? {}) };
    const now = new Date();
    const [updated] = await tx.update(conversationWorkflowRunsTable).set({
      stage: input.toStage,
      status: input.status,
      context,
      version: sql`${conversationWorkflowRunsTable.version} + 1`,
      updatedAt: now,
      completedAt: isTerminalWorkflowStatus(input.status) ? now : null,
    }).where(and(
      eq(conversationWorkflowRunsTable.id, input.runId),
      eq(conversationWorkflowRunsTable.version, current.version),
    )).returning();
    if (!updated) throw new Error('Conversation workflow run changed; reload before retrying');
    return updated;
  });
}

export async function createConversationWorkflowAction(input: {
  actionId?: string;
  runId: string;
  userId: number;
  threadId: number;
  actionType: string;
  status: ConversationWorkflowStatus;
  idempotencyKey?: string;
  resourceType?: string;
  resourceId?: string;
  resourceRevision?: number;
  payload?: Record<string, unknown>;
}): Promise<ConversationWorkflowActionRecord> {
  const [created] = await db.insert(conversationWorkflowActionsTable).values({
    id: input.actionId ?? crypto.randomUUID(),
    runId: input.runId,
    userId: input.userId,
    threadId: input.threadId,
    actionType: input.actionType,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceRevision: input.resourceRevision,
    input: input.payload ?? {},
  }).onConflictDoNothing().returning();
  if (created) return created;
  if (!input.idempotencyKey) throw new Error('Conversation workflow action could not be created');

  const [existing] = await db.select().from(conversationWorkflowActionsTable).where(and(
    eq(conversationWorkflowActionsTable.runId, input.runId),
    eq(conversationWorkflowActionsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (!existing) throw new Error('Conversation workflow action conflicted but could not be loaded');
  return existing;
}

export async function setConversationWorkflowActionStatus(input: {
  actionId: string;
  runId: string;
  userId: number;
  threadId: number;
  status: ConversationWorkflowStatus;
  output?: Record<string, unknown>;
  error?: string;
}): Promise<ConversationWorkflowActionRecord | undefined> {
  const now = new Date();
  const [updated] = await db.update(conversationWorkflowActionsTable).set({
    status: input.status,
    output: input.output,
    error: input.error,
    startedAt: input.status === 'running' ? now : undefined,
    completedAt: isTerminalWorkflowStatus(input.status) ? now : null,
    updatedAt: now,
  }).where(and(
    eq(conversationWorkflowActionsTable.id, input.actionId),
    eq(conversationWorkflowActionsTable.runId, input.runId),
    eq(conversationWorkflowActionsTable.userId, input.userId),
    eq(conversationWorkflowActionsTable.threadId, input.threadId),
  )).returning();
  return updated;
}

export async function approveIcpRevision(input: {
  userId: number;
  threadId: number;
  icpId: number;
  revision: number;
  runId?: string;
}): Promise<{ run: ConversationWorkflowRunRecord; icp: typeof icpProfilesTable.$inferSelect; replayed?: boolean }> {
  return db.transaction(async (tx: typeof db) => {
    const [icp] = await tx.select().from(icpProfilesTable).where(and(
      eq(icpProfilesTable.id, input.icpId),
      eq(icpProfilesTable.userId, input.userId),
      eq(icpProfilesTable.threadId, input.threadId),
    )).for('update').limit(1);
    if (!icp) throw new Error('ICP profile not found for this conversation');
    if (icp.revision !== input.revision) throw new Error('ICP profile changed; review the latest revision before approving');
    if ((icp.fitScore ?? 0) < 50) throw new Error('ICP profile is incomplete and cannot be approved yet');

    // Replays resolve the original receipt before mutating approval timestamps or
    // attempting to move an already-advanced workflow back to agent selection.
    const [receipt] = await tx.select().from(conversationWorkflowActionsTable).where(and(
      eq(conversationWorkflowActionsTable.userId, input.userId),
      eq(conversationWorkflowActionsTable.threadId, input.threadId),
      eq(conversationWorkflowActionsTable.actionType, 'approve_icp'),
      eq(conversationWorkflowActionsTable.idempotencyKey, `approve_icp:${input.icpId}:${input.revision}`),
      eq(conversationWorkflowActionsTable.status, 'succeeded'),
      ...(input.runId ? [eq(conversationWorkflowActionsTable.runId, input.runId)] : []),
    )).limit(1);
    if (receipt && icp.approved && icp.approvedRevision === input.revision) {
      const [recordedRun] = await tx.select().from(conversationWorkflowRunsTable).where(and(
        eq(conversationWorkflowRunsTable.id, receipt.runId),
        eq(conversationWorkflowRunsTable.userId, input.userId),
        eq(conversationWorkflowRunsTable.threadId, input.threadId),
      )).limit(1);
      if (!recordedRun) throw new Error('The recorded ICP approval workflow is unavailable');
      return { run: recordedRun, icp, replayed: true };
    }

    const [approvedIcp] = await tx.update(icpProfilesTable).set({
      approved: true,
      approvedBy: input.userId,
      approvedAt: new Date(),
      approvedRevision: input.revision,
      updatedAt: new Date(),
    }).where(and(
      eq(icpProfilesTable.id, input.icpId),
      eq(icpProfilesTable.revision, input.revision),
    )).returning();

    let run: ConversationWorkflowRunRecord | undefined;
    if (input.runId) {
      [run] = await tx.select().from(conversationWorkflowRunsTable).where(and(
        eq(conversationWorkflowRunsTable.id, input.runId),
        eq(conversationWorkflowRunsTable.userId, input.userId),
        eq(conversationWorkflowRunsTable.threadId, input.threadId),
      )).for('update').limit(1);
    } else {
      [run] = await tx.select().from(conversationWorkflowRunsTable).where(and(
        eq(conversationWorkflowRunsTable.userId, input.userId),
        eq(conversationWorkflowRunsTable.threadId, input.threadId),
        inArray(conversationWorkflowRunsTable.status, ACTIVE_STATUSES),
      )).orderBy(desc(conversationWorkflowRunsTable.updatedAt)).for('update').limit(1);
    }

    if (!run && input.runId) throw new Error('The requested ICP approval workflow is unavailable');
    if (!run) {
      [run] = await tx.insert(conversationWorkflowRunsTable).values({
        id: input.runId ?? crypto.randomUUID(),
        userId: input.userId,
        threadId: input.threadId,
        stage: 'agent_selection',
        status: 'awaiting_input',
        context: { icpId: input.icpId, icpRevision: input.revision },
      }).returning();
    } else {
      // Older conversations can have a saved, reviewable profile while their
      // durable run still says draft. Record readiness inside this transaction
      // only after the locked profile/revision/fit checks above. Do not loosen
      // the global state machine or let this path revive an advanced run.
      if (run.stage === 'icp_draft') {
        const context = run.context ?? {};
        if ((context.icpId != null && context.icpId !== input.icpId)
          || (context.icpRevision != null && context.icpRevision !== input.revision)) {
          throw new Error('Workflow ICP changed; review the current profile before approving');
        }
        assertWorkflowTransition('icp_draft', 'icp_awaiting_approval');
        [run] = await tx.update(conversationWorkflowRunsTable).set({
          stage: 'icp_awaiting_approval',
          status: 'awaiting_approval',
          context: { ...context, icpId: input.icpId, icpRevision: input.revision },
          version: sql`${conversationWorkflowRunsTable.version} + 1`,
          updatedAt: new Date(),
        }).where(eq(conversationWorkflowRunsTable.id, run.id)).returning();
        if (!run) throw new Error('Conversation workflow readiness could not be recorded');
      }
      assertWorkflowTransition(run.stage as ConversationWorkflowStage, 'agent_selection');
      [run] = await tx.update(conversationWorkflowRunsTable).set({
        stage: 'agent_selection',
        status: 'awaiting_input',
        context: { ...(run.context ?? {}), icpId: input.icpId, icpRevision: input.revision },
        version: sql`${conversationWorkflowRunsTable.version} + 1`,
        updatedAt: new Date(),
      }).where(eq(conversationWorkflowRunsTable.id, run.id)).returning();
    }
    if (!run) throw new Error('Conversation workflow run could not be advanced after ICP approval');
    await tx.insert(conversationWorkflowActionsTable).values({
      id: crypto.randomUUID(),
      runId: run.id,
      userId: input.userId,
      threadId: input.threadId,
      actionType: 'approve_icp',
      status: 'succeeded',
      idempotencyKey: `approve_icp:${input.icpId}:${input.revision}`,
      resourceType: 'icp_profile',
      resourceId: String(input.icpId),
      resourceRevision: input.revision,
      input: { approved: true },
      output: { approvedRevision: input.revision },
      startedAt: new Date(),
      completedAt: new Date(),
    }).onConflictDoNothing();
    return { run, icp: approvedIcp };
  });
}

export async function markIcpRevisionAwaitingApproval(input: {
  userId: number;
  threadId: number;
  icpId: number;
  revision: number;
  originalRequest?: string;
}): Promise<ConversationWorkflowRunRecord> {
  const run = await ensureConversationWorkflowRun({
    userId: input.userId,
    threadId: input.threadId,
    originalRequest: input.originalRequest,
    stage: 'icp_draft',
  });
  const [updated] = await db.update(conversationWorkflowRunsTable).set({
    stage: 'icp_awaiting_approval',
    status: 'awaiting_approval',
    context: { ...(run.context ?? {}), icpId: input.icpId, icpRevision: input.revision },
    version: sql`${conversationWorkflowRunsTable.version} + 1`,
    completedAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(conversationWorkflowRunsTable.id, run.id),
    eq(conversationWorkflowRunsTable.userId, input.userId),
    eq(conversationWorkflowRunsTable.threadId, input.threadId),
  )).returning();
  if (!updated) throw new Error('Conversation workflow run could not be updated for ICP approval');
  return updated;
}

export async function createLeadStrategySelection(input: {
  runId: string; userId: number; threadId: number;
  platforms: string[]; workflowIds: string[]; selection?: Record<string, unknown>;
}): Promise<LeadStrategySelectionRecord> {
  return db.transaction(async (tx: typeof db) => {
    const [run] = await tx.select({ id: conversationWorkflowRunsTable.id })
      .from(conversationWorkflowRunsTable).where(and(
        eq(conversationWorkflowRunsTable.id, input.runId),
        eq(conversationWorkflowRunsTable.userId, input.userId),
        eq(conversationWorkflowRunsTable.threadId, input.threadId),
      )).for('update').limit(1);
    if (!run) throw new Error('Conversation workflow run not found for lead strategy');
    const [latest] = await tx.select({ revision: leadStrategySelectionsTable.revision })
      .from(leadStrategySelectionsTable)
      .where(eq(leadStrategySelectionsTable.runId, input.runId))
      .orderBy(desc(leadStrategySelectionsTable.revision)).limit(1);
    const [created] = await tx.insert(leadStrategySelectionsTable).values({
      ...input,
      revision: (latest?.revision ?? 0) + 1,
      status: 'confirmed',
      confirmedAt: new Date(),
    }).returning();
    return created;
  });
}

export async function getLatestLeadStrategySelection(input: {
  runId: string; userId: number; threadId: number;
}): Promise<LeadStrategySelectionRecord | undefined> {
  const [selection] = await db.select().from(leadStrategySelectionsTable).where(and(
    eq(leadStrategySelectionsTable.runId, input.runId),
    eq(leadStrategySelectionsTable.userId, input.userId),
    eq(leadStrategySelectionsTable.threadId, input.threadId),
    eq(leadStrategySelectionsTable.status, 'confirmed'),
  )).orderBy(desc(leadStrategySelectionsTable.revision)).limit(1);
  return selection;
}

export async function createLeadInputSet(input: {
  runId: string; userId: number; threadId: number; strategySelectionId?: string;
  inputIds: number[]; platforms: string[]; workflowIds: string[]; snapshot: Record<string, unknown>;
}): Promise<LeadInputSetRecord> {
  return db.transaction(async (tx: typeof db) => {
    const [run] = await tx.select({ id: conversationWorkflowRunsTable.id })
      .from(conversationWorkflowRunsTable).where(and(
        eq(conversationWorkflowRunsTable.id, input.runId),
        eq(conversationWorkflowRunsTable.userId, input.userId),
        eq(conversationWorkflowRunsTable.threadId, input.threadId),
      )).for('update').limit(1);
    if (!run) throw new Error('Conversation workflow run not found for lead inputs');

    if (input.strategySelectionId) {
      const [strategy] = await tx.select({ id: leadStrategySelectionsTable.id })
        .from(leadStrategySelectionsTable).where(and(
          eq(leadStrategySelectionsTable.id, input.strategySelectionId),
          eq(leadStrategySelectionsTable.runId, input.runId),
          eq(leadStrategySelectionsTable.userId, input.userId),
          eq(leadStrategySelectionsTable.threadId, input.threadId),
        )).limit(1);
      if (!strategy) throw new Error('Lead strategy selection is not valid for this workflow run');
    }

    const inputIds = [...new Set(input.inputIds.filter(id => Number.isInteger(id) && id > 0))];
    if (inputIds.length === 0) throw new Error('At least one durable lead input is required');
    const ownedInputs = await tx.select().from(leadInputsTable).where(and(
      eq(leadInputsTable.userId, input.userId),
      eq(leadInputsTable.threadId, input.threadId),
      inArray(leadInputsTable.id, inputIds),
    )).for('update');
    if (ownedInputs.length !== inputIds.length) {
      throw new Error('One or more lead inputs are missing or belong to another conversation');
    }

    const [latest] = await tx.select({ revision: leadInputSetsTable.revision })
      .from(leadInputSetsTable).where(eq(leadInputSetsTable.runId, input.runId))
      .orderBy(desc(leadInputSetsTable.revision)).limit(1);
    await tx.update(leadInputSetsTable).set({
      status: 'superseded',
      updatedAt: new Date(),
    }).where(and(
      eq(leadInputSetsTable.runId, input.runId),
      eq(leadInputSetsTable.status, 'awaiting_approval'),
    ));
    const [created] = await tx.insert(leadInputSetsTable).values({
      ...input,
      inputIds,
      snapshot: { ...input.snapshot, inputs: inputIds.map(id => snapshotLeadInput(ownedInputs.find((row: LeadInputRecord) => row.id === id)!)) },
      strategySelectionId: input.strategySelectionId,
      revision: (latest?.revision ?? 0) + 1,
      status: 'awaiting_approval',
    }).returning();
    return created;
  });
}

/**
 * Persist a generated lead-input batch, its review snapshot, and the workflow
 * transition as one transaction. A failed/stale transition must never leave a
 * newer unapproved input batch behind for execution or reload recovery to find.
 */
export async function createReviewedLeadInputSet(input: {
  runId: string;
  userId: number;
  threadId: number;
  strategySelectionId: string;
  leadInputs: InsertLeadInput[];
  platforms: string[];
  workflowIds: string[];
  snapshot: Record<string, unknown>;
}): Promise<{
  inputs: LeadInputRecord[];
  inputSet: LeadInputSetRecord;
  run: ConversationWorkflowRunRecord;
}> {
  if (input.leadInputs.length === 0) {
    throw new Error('At least one generated lead input is required');
  }

  return db.transaction(async (tx: typeof db) => {
    const [currentRun] = await tx.select().from(conversationWorkflowRunsTable).where(and(
      eq(conversationWorkflowRunsTable.id, input.runId),
      eq(conversationWorkflowRunsTable.userId, input.userId),
      eq(conversationWorkflowRunsTable.threadId, input.threadId),
    )).for('update').limit(1);
    if (!currentRun) throw new Error('Conversation workflow run not found for lead inputs');
    assertWorkflowTransition(
      currentRun.stage as ConversationWorkflowStage,
      'lead_inputs_awaiting_approval',
    );

    const [strategy] = await tx.select({ id: leadStrategySelectionsTable.id })
      .from(leadStrategySelectionsTable).where(and(
        eq(leadStrategySelectionsTable.id, input.strategySelectionId),
        eq(leadStrategySelectionsTable.runId, input.runId),
        eq(leadStrategySelectionsTable.userId, input.userId),
        eq(leadStrategySelectionsTable.threadId, input.threadId),
        eq(leadStrategySelectionsTable.status, 'confirmed'),
      )).limit(1);
    if (!strategy) throw new Error('Lead strategy selection is not valid for this workflow run');

    const rows = input.leadInputs.map((leadInput) => ({
      ...leadInput,
      userId: input.userId,
      threadId: input.threadId,
    }));
    const savedInputs = await tx.insert(leadInputsTable).values(rows).returning();
    const inputIds = savedInputs.map((record: LeadInputRecord) => record.id);
    if (savedInputs.length !== rows.length
      || inputIds.some((id: number) => !Number.isInteger(id) || id <= 0)
      || new Set(inputIds).size !== inputIds.length) {
      throw new Error('The generated search parameters could not all be saved');
    }

    const [latest] = await tx.select({ revision: leadInputSetsTable.revision })
      .from(leadInputSetsTable)
      .where(eq(leadInputSetsTable.runId, input.runId))
      .orderBy(desc(leadInputSetsTable.revision))
      .limit(1);
    await tx.update(leadInputSetsTable).set({
      status: 'superseded',
      updatedAt: new Date(),
    }).where(and(
      eq(leadInputSetsTable.runId, input.runId),
      eq(leadInputSetsTable.status, 'awaiting_approval'),
    ));
    const [inputSet] = await tx.insert(leadInputSetsTable).values({
      runId: input.runId,
      userId: input.userId,
      threadId: input.threadId,
      strategySelectionId: input.strategySelectionId,
      revision: (latest?.revision ?? 0) + 1,
      status: 'awaiting_approval',
      inputIds,
      platforms: input.platforms,
      workflowIds: input.workflowIds,
      snapshot: {
        ...input.snapshot,
        inputs: savedInputs.map((record: LeadInputRecord) => snapshotLeadInput(record)),
      },
    }).returning();
    if (!inputSet) throw new Error('Lead input review could not be created');

    const now = new Date();
    const [run] = await tx.update(conversationWorkflowRunsTable).set({
      stage: 'lead_inputs_awaiting_approval',
      status: 'awaiting_approval',
      context: {
        ...(currentRun.context ?? {}),
        leadInputSetId: inputSet.id,
        leadInputSetRevision: inputSet.revision,
      },
      version: sql`${conversationWorkflowRunsTable.version} + 1`,
      completedAt: null,
      updatedAt: now,
    }).where(and(
      eq(conversationWorkflowRunsTable.id, input.runId),
      eq(conversationWorkflowRunsTable.version, currentRun.version),
    )).returning();
    if (!run) throw new Error('Conversation workflow run changed; reload before retrying');

    return { inputs: savedInputs, inputSet, run };
  });
}

export async function approveLeadInputSet(input: {
  id: string; runId: string; userId: number; threadId: number; revision: number;
}): Promise<LeadInputSetRecord> {
  return db.transaction(async (tx: typeof db) => {
    const [run] = await tx.select({ id: conversationWorkflowRunsTable.id }).from(conversationWorkflowRunsTable).where(and(
      eq(conversationWorkflowRunsTable.id, input.runId),
      eq(conversationWorkflowRunsTable.userId, input.userId),
      eq(conversationWorkflowRunsTable.threadId, input.threadId),
    )).for('update').limit(1);
    if (!run) throw new Error('Conversation workflow run not found');
    const [review] = await tx.select().from(leadInputSetsTable).where(and(
      eq(leadInputSetsTable.id, input.id), eq(leadInputSetsTable.runId, input.runId),
      eq(leadInputSetsTable.userId, input.userId), eq(leadInputSetsTable.threadId, input.threadId),
      eq(leadInputSetsTable.revision, input.revision),
    )).for('update').limit(1);
    if (!review || !['approved', 'awaiting_approval'].includes(review.status)) {
      throw new Error('Lead input set changed or was already handled');
    }
    if (review.status === 'approved') return review;
    const [latest] = await tx.select({ revision: leadInputSetsTable.revision }).from(leadInputSetsTable)
      .where(eq(leadInputSetsTable.runId, input.runId)).orderBy(desc(leadInputSetsTable.revision)).limit(1);
    if (latest?.revision !== input.revision) throw new Error('A newer lead input review is available. Review that revision before approving.');
    const reviewed = readLeadInputSnapshot(review);
    const current = await tx.select().from(leadInputsTable).where(and(
      eq(leadInputsTable.userId, input.userId), eq(leadInputsTable.threadId, input.threadId),
      inArray(leadInputsTable.id, review.inputIds),
    )).for('update');
    assertLeadInputsUnchanged(reviewed, current);
    const [approved] = await tx.update(leadInputSetsTable).set({
      status: 'approved', approvedBy: input.userId, approvedAt: new Date(), updatedAt: new Date(),
    }).where(eq(leadInputSetsTable.id, review.id)).returning();
    return approved;
  });
}

export async function getApprovedLeadInputRecords(input: {
  id: string; runId: string; userId: number; threadId: number; revision: number;
}) {
  const [review] = await db.select().from(leadInputSetsTable).where(and(
    eq(leadInputSetsTable.id, input.id), eq(leadInputSetsTable.runId, input.runId),
    eq(leadInputSetsTable.userId, input.userId), eq(leadInputSetsTable.threadId, input.threadId),
    eq(leadInputSetsTable.revision, input.revision), eq(leadInputSetsTable.status, 'approved'),
    )).limit(1);
  if (!review) throw new Error('Approve the exact lead input revision before running a search.');
  return readLeadInputSnapshot(review);
}

export async function getApprovedLeadInputSetForLeadInput(input: {
  leadInputId: number;
  userId: number;
  threadId: number;
}): Promise<LeadInputSetRecord | undefined> {
  const reviews = await db.select().from(leadInputSetsTable).where(and(
    eq(leadInputSetsTable.userId, input.userId),
    eq(leadInputSetsTable.threadId, input.threadId),
    eq(leadInputSetsTable.status, 'approved'),
  )).orderBy(desc(leadInputSetsTable.revision));
  return reviews.find((review: LeadInputSetRecord) => (
    Array.isArray(review.inputIds) && review.inputIds.includes(input.leadInputId)
  ));
}

export async function createLeadSelectionSnapshot(input: {
  runId: string; userId: number; threadId: number; leadIds: number[];
}): Promise<LeadSelectionSnapshotRecord> {
  const leadIds = [...new Set(input.leadIds.filter(id => Number.isInteger(id) && id > 0))];
  if (leadIds.length === 0) throw new Error('Select at least one stored lead before outreach');
  return db.transaction(async (tx: typeof db) => {
    const [run] = await tx.select({ id: conversationWorkflowRunsTable.id })
      .from(conversationWorkflowRunsTable).where(and(
        eq(conversationWorkflowRunsTable.id, input.runId),
        eq(conversationWorkflowRunsTable.userId, input.userId),
        eq(conversationWorkflowRunsTable.threadId, input.threadId),
      )).for('update').limit(1);
    if (!run) throw new Error('Conversation workflow run not found for lead selection');
    const ownedLeads = await tx.select({ id: leadsTable.id }).from(leadsTable).where(and(
      eq(leadsTable.userId, input.userId),
      inArray(leadsTable.id, leadIds),
      sql`${leadsTable.deletedAt} IS NULL`,
    ));
    if (ownedLeads.length !== leadIds.length) {
      throw new Error('One or more selected leads are missing or belong to another account');
    }
    const [latest] = await tx.select({ revision: leadSelectionSnapshotsTable.revision })
      .from(leadSelectionSnapshotsTable).where(eq(leadSelectionSnapshotsTable.runId, input.runId))
      .orderBy(desc(leadSelectionSnapshotsTable.revision)).limit(1);
    const [created] = await tx.insert(leadSelectionSnapshotsTable).values({
      ...input,
      leadIds,
      revision: (latest?.revision ?? 0) + 1,
      status: 'approved',
      approvedBy: input.userId,
      approvedAt: new Date(),
    }).returning();
    return created;
  });
}
