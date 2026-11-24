import { isRetrySafeExecutionResult } from '../../../shared/toolExecutionReceipt.js';
export { isRetrySafeExecutionResult } from '../../../shared/toolExecutionReceipt.js';
import { and, eq, lt, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../db';
import {
  conversationToolApprovalsTable,
  type ConversationToolApproval,
} from './schema';

export interface ClaimConversationApprovalInput {
  userId: number;
  threadId: number;
  requestId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  approved: boolean;
  runId?: string;
  actionId?: string;
  resourceType?: string;
  resourceId?: string;
  resourceRevision?: number;
}

const APPROVAL_LEASE_MS = 10 * 60 * 1000;

export const ConversationToolApprovalModel = {
  async findByRequest(
    userId: number,
    threadId: number,
    requestId: string,
    toolName: string,
  ): Promise<ConversationToolApproval | undefined> {
    const [approval] = await db.select()
      .from(conversationToolApprovalsTable)
      .where(and(
        eq(conversationToolApprovalsTable.userId, userId),
        eq(conversationToolApprovalsTable.threadId, threadId),
        eq(conversationToolApprovalsTable.requestId, requestId),
        eq(conversationToolApprovalsTable.toolName, toolName),
      ))
      .limit(1);
    return approval;
  },

  async claim(input: ClaimConversationApprovalInput): Promise<{
    approval: ConversationToolApproval;
    claimed: boolean;
  }> {
    const status = input.approved ? 'running' : 'rejected';
    const now = new Date();
    const leaseToken = input.approved ? crypto.randomUUID() : null;
    const leaseExpiresAt = input.approved
      ? new Date(now.getTime() + APPROVAL_LEASE_MS)
      : null;
    const [created] = await db.insert(conversationToolApprovalsTable)
      .values({
        userId: input.userId,
        threadId: input.threadId,
        requestId: input.requestId,
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        runId: input.runId,
        actionId: input.actionId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        resourceRevision: input.resourceRevision,
        overrides: input.overrides,
        decision: input.approved ? 'approve' : 'reject',
        status,
        startedAt: input.approved ? now : null,
        completedAt: input.approved ? null : now,
        leaseToken,
        leaseExpiresAt,
        attemptCount: 1,
      })
      .onConflictDoNothing({
        target: [conversationToolApprovalsTable.businessProfileId,
          conversationToolApprovalsTable.userId,
          conversationToolApprovalsTable.threadId,
          conversationToolApprovalsTable.requestId,
          conversationToolApprovalsTable.toolName,
        ],
      })
      .returning();

    if (created) return { approval: created, claimed: true };

    const [existing] = await db.select()
      .from(conversationToolApprovalsTable)
      .where(and(
        eq(conversationToolApprovalsTable.userId, input.userId),
        eq(conversationToolApprovalsTable.threadId, input.threadId),
        eq(conversationToolApprovalsTable.requestId, input.requestId),
        eq(conversationToolApprovalsTable.toolName, input.toolName),
      ))
      .limit(1);

    if (!existing) {
      throw new Error('Approval claim conflicted but no receipt could be loaded');
    }
    if (
      input.approved &&
      existing.status === 'failed' &&
      isRetrySafeExecutionResult(existing.executionResult)
    ) {
      const retryNow = new Date();
      const [retried] = await db.update(conversationToolApprovalsTable)
        .set({
          status: 'running',
          toolArgs: input.toolArgs,
          runId: input.runId,
          actionId: input.actionId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          resourceRevision: input.resourceRevision,
          overrides: input.overrides,
          executionResult: null,
          executionError: null,
          startedAt: retryNow,
          completedAt: null,
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(retryNow.getTime() + APPROVAL_LEASE_MS),
          attemptCount: sql`${conversationToolApprovalsTable.attemptCount} + 1`,
          updatedAt: retryNow,
        })
        .where(and(
          eq(conversationToolApprovalsTable.id, existing.id),
          eq(conversationToolApprovalsTable.userId, input.userId),
          eq(conversationToolApprovalsTable.status, 'failed'),
        ))
        .returning();
      if (retried) return { approval: retried, claimed: true };
    }
    return { approval: existing, claimed: false };
  },

  async expireStaleRunning(now = new Date()): Promise<number> {
    const expired = await db.update(conversationToolApprovalsTable)
      .set({
        status: 'failed',
        executionResult: {
          ambiguous: true,
          retrySafe: false,
          reason: 'execution_lease_expired',
        },
        executionError: 'Execution lease expired before a terminal result was recorded. Provider state must be reconciled before retrying.',
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(conversationToolApprovalsTable.status, 'running'),
        lt(conversationToolApprovalsTable.leaseExpiresAt, now),
      ))
      .returning({ id: conversationToolApprovalsTable.id });
    return expired.length;
  },

  async complete(
    id: number,
    leaseToken: string,
    success: boolean,
    result?: unknown,
    error?: string,
  ): Promise<ConversationToolApproval | undefined> {
    const [updated] = await db.update(conversationToolApprovalsTable)
      .set({
        status: success ? 'succeeded' : 'failed',
        executionResult: result,
        executionError: error,
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(conversationToolApprovalsTable.id, id),
        eq(conversationToolApprovalsTable.status, 'running'),
        eq(conversationToolApprovalsTable.leaseToken, leaseToken),
      ))
      .returning();
    return updated;
  },
};
