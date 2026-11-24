import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { toolApprovalsTable } from '../../../models/toolApprovals/schema.js';
import { supportToolExecutionsTable, type SupportToolExecutionRecord } from '../../../models/supportOrchestration/schema.js';
import type { SubAgentContext, SubAgentResult } from '../subagents/SubAgentBase.js';
import { subAgentRegistry } from '../subagents/index.js';
import {
  decryptRestrictedPayload,
  type RestrictedPayload,
} from './PrivacyVaultService.js';
import {
  sanitizeSupportToolData,
  supportToolArgumentDigest,
} from './SafeToolExecutor.js';
import { logger } from '../../../utils/logger.js';
import { withPromiseTimeout } from '../../../utils/promiseTimeout.js';
import { supportAgentRuntime } from './SupportAgentRuntime.js';
import { assistantProvenanceCurrent, assertAssistantFresh, withPublishedAssistant } from '../../assistants/AssistantFreshness.js';
import { APPROVAL_RESUME_BLOCKED_MESSAGE } from '../../../../shared/supportApprovalRecovery.js';

interface ResumeEnvelope {
  idempotencyKey: string;
  argumentDigest: string;
  toolName: string;
  args: Record<string, unknown>;
  context: SubAgentContext;
  assistant?: unknown;
}

const COMMITTED_HIGH_RISK_TOOLS = new Set([
  'create_booking',
  'save_booking_details',
  'send_payment_link',
  'resolve_complaint',
]);

interface ResumeClaim {
  execution?: SupportToolExecutionRecord;
  replay?: SubAgentResult;
  expiresAt?: Date | null;
}
const STALE_APPROVAL_MS = 2 * 60_000;

export interface ApprovalRecoveryReport {
  selected: number;
  completed: number;
  blocked: number;
  inProgress: number;
  requiresReconciliation: number;
  expired: number;
  skipped: number;
}

export class SupportToolResumeService {
  constructor(private readonly database = db) {}

  async resumeApproval(userId: number, approvalId: number): Promise<SubAgentResult | null> {
    const [approval] = await this.database.select().from(toolApprovalsTable).where(and(
      eq(toolApprovalsTable.id, approvalId), eq(toolApprovalsTable.userId, userId),
      inArray(toolApprovalsTable.status, ['approved', 'executing']),
    )).limit(1);
    if (!approval) return null;
    let payload: ResumeEnvelope;
    try {
      if (!approval.resumePayload || !approval.argumentDigest) throw new Error('Missing protected approval data');
      payload = decryptRestrictedPayload<ResumeEnvelope>(userId, 'support-tool-resume', approval.resumePayload as RestrictedPayload);
      if (payload.toolName !== approval.toolName || payload.argumentDigest !== approval.argumentDigest
        || supportToolArgumentDigest(userId, payload.args) !== approval.argumentDigest
        || payload.context.userId !== userId || payload.context.conversationId !== approval.threadId) {
        throw new Error('Invalid protected approval identity');
      }
    } catch {
      // Never persist the decryptor/provider error, payload or key. Compare the
      // loaded attempt/state so a racing completion/review keeps its outcome.
      await this.database.update(toolApprovalsTable).set({ resumeError: APPROVAL_RESUME_BLOCKED_MESSAGE,
        ...(approval.resumeStatus === 'ready' ? { updatedAt: new Date() } : {}),
      }).where(and(eq(toolApprovalsTable.id, approvalId), eq(toolApprovalsTable.userId, userId),
        eq(toolApprovalsTable.status, approval.status), eq(toolApprovalsTable.resumeStatus, approval.resumeStatus),
        eq(toolApprovalsTable.resumeAttemptCount, approval.resumeAttemptCount),
      ));
      throw new Error(APPROVAL_RESUME_BLOCKED_MESSAGE);
    }
    if (!await assistantProvenanceCurrent(payload.assistant) && approval.status === 'approved') {
      // An already-started execution remains reconcilable; configuration changes
      // must not erase the evidence that an external operation may have started.
      await this.database.update(toolApprovalsTable).set({ status: 'expired', resumeStatus: 'cancelled', isExpired: true, updatedAt: new Date() })
        .where(and(eq(toolApprovalsTable.id, approvalId), eq(toolApprovalsTable.userId, userId), eq(toolApprovalsTable.status, 'approved')));
      return null;
    }

    // Keep the claim, execution identity and link in ONE transaction. A crash
    // cannot leave a claimed approval without an operator-visible execution.
    const claim: ResumeClaim = await this.database.transaction(async (tx: typeof db): Promise<ResumeClaim> => {
      const [current] = await tx.select().from(toolApprovalsTable).where(and(
        eq(toolApprovalsTable.id, approvalId), eq(toolApprovalsTable.userId, userId),
      )).for('update').limit(1);
      if (!current || !['approved', 'executing'].includes(current.status)
        || current.argumentDigest !== payload.argumentDigest || current.toolName !== payload.toolName) return {};
      let execution: SupportToolExecutionRecord | undefined = (await tx.select().from(supportToolExecutionsTable).where(and(
        eq(supportToolExecutionsTable.userId, userId), eq(supportToolExecutionsTable.idempotencyKey, payload.idempotencyKey),
      )).for('update').limit(1))[0];
      if (execution?.status === 'success') {
        await tx.update(toolApprovalsTable).set({ status: 'consumed', resumeStatus: 'completed', resumedAt: new Date(),
          executionResult: execution.result, consumedExecutionId: execution.id, resumeError: null, updatedAt: new Date(),
        }).where(eq(toolApprovalsTable.id, approvalId));
        return { replay: execution.result as SubAgentResult };
      }
      const values = {
        userId, conversationId: payload.context.conversationId,
        insightsConversationKind: payload.context.widgetSession?.id ? 'widget' : payload.context.conversationId > 0 ? 'outreach' : null,
        insightsConversationId: payload.context.widgetSession?.id || (payload.context.conversationId > 0 ? payload.context.conversationId : null),
        toolName: payload.toolName, idempotencyKey: payload.idempotencyKey, riskLevel: 'high',
        args: sanitizeSupportToolData(payload.args) as Record<string, unknown>, argumentDigest: payload.argumentDigest,
        approvalId, attemptCount: 1, lastAttemptAt: new Date(),
      };
      if (current.resumeStatus === 'running') {
        if (new Date(current.updatedAt).getTime() > Date.now() - STALE_APPROVAL_MS) return {};
        const reason = 'Approval execution was interrupted. Verify the original operation before retrying.';
        if (!execution) {
          [execution] = await tx.insert(supportToolExecutionsTable).values({ ...values, status: 'failed',
            error: reason, reconciliationStatus: 'pending', reconciliationNote: reason, completedAt: new Date(),
          }).onConflictDoNothing({ target: supportToolExecutionsTable.idempotencyKey }).returning();
        } else if (execution.status === 'running' && !execution.reconciledAt) {
          await tx.update(supportToolExecutionsTable).set({ status: 'failed', error: reason,
            reconciliationStatus: 'pending', reconciliationNote: reason, completedAt: new Date(),
          }).where(and(eq(supportToolExecutionsTable.id, execution.id), eq(supportToolExecutionsTable.status, 'running')));
        }
        if (!execution) throw new Error('Interrupted approval execution could not be recorded.');
        await tx.update(toolApprovalsTable).set({ resumeStatus: 'failed', resumeError: reason,
          consumedExecutionId: execution.id, updatedAt: new Date(),
        }).where(eq(toolApprovalsTable.id, approvalId));
        return {};
      }
      // Only unstarted approved work can acquire a new execution attempt.
      if (current.status !== 'approved' || current.resumeStatus !== 'ready') return {};
      if (current.isExpired || (current.expiresAt && current.expiresAt.getTime() <= Date.now())) {
        await tx.update(toolApprovalsTable).set({ status: 'expired', isExpired: true,
          resumeStatus: 'cancelled', resumeError: 'Approval expired before execution.', updatedAt: new Date(),
        }).where(eq(toolApprovalsTable.id, approvalId));
        return {};
      }
      if (execution && execution.reconciliationStatus !== 'confirmed_not_executed') {
        await tx.update(toolApprovalsTable).set({ status: 'executing', resumeStatus: 'failed',
          resumeError: 'Existing execution requires reconciliation before retry.', consumedExecutionId: execution.id, updatedAt: new Date(),
        }).where(eq(toolApprovalsTable.id, approvalId));
        return {};
      }
      [execution] = execution
        ? await tx.update(supportToolExecutionsTable).set({ status: 'running', error: null, result: null,
            argumentDigest: payload.argumentDigest, approvalId, attemptCount: sql`${supportToolExecutionsTable.attemptCount} + 1`,
            lastAttemptAt: new Date(), completedAt: null, reconciliationStatus: null, reconciliationNote: null,
            reconciledAt: null, reconciledBy: null,
          }).where(and(eq(supportToolExecutionsTable.id, execution.id),
            eq(supportToolExecutionsTable.reconciliationStatus, 'confirmed_not_executed'))).returning()
        : await tx.insert(supportToolExecutionsTable).values({ ...values, status: 'running' })
            .onConflictDoNothing({ target: supportToolExecutionsTable.idempotencyKey }).returning();
      if (!execution) throw new Error('Durable tool execution could not be claimed.');
      await tx.update(toolApprovalsTable).set({ status: 'executing', resumeStatus: 'running',
        resumeAttemptCount: sql`${toolApprovalsTable.resumeAttemptCount} + 1`, resumeError: null,
        consumedExecutionId: execution.id, updatedAt: new Date(),
      }).where(eq(toolApprovalsTable.id, approvalId));
      return { execution, expiresAt: current.expiresAt };
    });
    if (!claim.execution) return claim.replay || null;
    const execution = claim.execution;
    const finish = async (result: SubAgentResult | null, error?: string): Promise<SubAgentResult | null> => {
      const sanitized = result ? sanitizeSupportToolData(result) as SubAgentResult : null;
      const outcome = sanitized ? supportAgentRuntime.recordToolOutcome(payload.toolName, payload.args, sanitized) : undefined;
      const succeeded = outcome?.status === 'success' && outcome.success === true
        && (!COMMITTED_HIGH_RISK_TOOLS.has(payload.toolName) || outcome.confirmedSideEffect === true);
      const message = succeeded ? null : String(sanitizeSupportToolData(error || 'The approved action did not confirm its outcome. Verify the operation before retrying.')).slice(0, 2000);
      await this.database.transaction(async (tx: typeof db) => {
        // Claims and owner reconciliation also lock approval -> execution.
        // Lock the approval before the execution UPDATE, even when a duplicate
        // claim or cancellation means the approval itself will not be changed.
        await tx.select({ id: toolApprovalsTable.id }).from(toolApprovalsTable).where(and(
          eq(toolApprovalsTable.id, approvalId), eq(toolApprovalsTable.userId, userId),
        )).for('update').limit(1);
        // Attempt + operator reconciliation fences late results. A timed-out
        // operation may finish this attempt, but cannot overwrite a reviewed or
        // newer attempt, nor can its timeout overwrite a completed success.
        const [saved] = await tx.update(supportToolExecutionsTable).set({ status: succeeded ? 'success' : 'failed',
          ...(sanitized ? { result: sanitized } : {}), error: message, completedAt: new Date(),
          reconciliationStatus: succeeded ? null : 'pending', reconciliationNote: message,
        }).where(and(eq(supportToolExecutionsTable.id, execution.id), eq(supportToolExecutionsTable.userId, userId),
          eq(supportToolExecutionsTable.attemptCount, execution.attemptCount), isNull(supportToolExecutionsTable.reconciledAt),
          inArray(supportToolExecutionsTable.status, ['running', 'failed']),
          or(isNull(supportToolExecutionsTable.reconciliationStatus), eq(supportToolExecutionsTable.reconciliationStatus, 'pending')),
        )).returning();
        if (!saved) return;
        await tx.update(toolApprovalsTable).set({ status: succeeded ? 'consumed' : 'executing',
          resumeStatus: succeeded ? 'completed' : 'failed', resumedAt: new Date(),
          ...(sanitized ? { executionResult: sanitized } : {}), consumedAt: new Date(), consumedExecutionId: execution.id,
          resumeError: message, resumeAvailableAt: null, updatedAt: new Date(),
        }).where(and(eq(toolApprovalsTable.id, approvalId), eq(toolApprovalsTable.userId, userId),
          eq(toolApprovalsTable.consumedExecutionId, execution.id), eq(toolApprovalsTable.status, 'executing')));
      });
      return sanitized;
    };
    const operation = withPublishedAssistant(payload.assistant, async () => {
      await assertAssistantFresh();
      if (claim.expiresAt && claim.expiresAt.getTime() <= Date.now()) {
        throw new Error('Approval expired before dispatch. Prepare a new review.');
      }
      return subAgentRegistry.dispatchAny(payload.toolName, payload.args, payload.context);
    });
    // Attach persistence to the operation itself, not just the timeout race.
    // A late completion is observed even after the HTTP caller has returned.
    const completion = operation.then(result => finish(result), error => finish(null,
      error instanceof Error ? error.message : String(error)));
    try {
      return await withPromiseTimeout(completion, 15_000, 'Approved tool execution timed out; its outcome requires reconciliation.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finish(null, message);
      logger.error({ approvalId, executionId: execution.id }, '[SupportToolResume] Approved execution needs reconciliation');
      // Promise.race observes the losing promise, including persistence errors.
      return null;
    }
  }

  async processReady(limit = 25): Promise<number> {
    const report = await this.processReadyReport(limit);
    if (report.selected) {
      if (report.blocked) logger.warn(report, '[SupportToolResume] Approval recovery needs attention');
      else logger.info(report, '[SupportToolResume] Approval recovery checked');
    }
    // Preserve the numeric worker API; this is completed approvals, not the
    // number merely selected, blocked or requiring reconciliation.
    return report.completed;
  }

  async processReadyReport(limit = 25): Promise<ApprovalRecoveryReport> {
    const ready = await this.database.select({ id: toolApprovalsTable.id, userId: toolApprovalsTable.userId })
      .from(toolApprovalsTable).where(or(
        and(eq(toolApprovalsTable.status, 'approved'), eq(toolApprovalsTable.resumeStatus, 'ready'),
          lt(toolApprovalsTable.resumeAvailableAt, new Date(Date.now() + 1000))),
        and(eq(toolApprovalsTable.status, 'executing'), eq(toolApprovalsTable.resumeStatus, 'running'),
          lt(toolApprovalsTable.updatedAt, new Date(Date.now() - STALE_APPROVAL_MS))),
      )).limit(Math.max(1, Math.min(100, Math.floor(limit) || 25)));
    const report: ApprovalRecoveryReport = { selected: ready.length, completed: 0, blocked: 0,
      inProgress: 0, requiresReconciliation: 0, expired: 0, skipped: 0 };
    for (const item of ready) {
      try {
        await this.resumeApproval(item.userId, item.id);
        const [current] = await this.database.select({ status: toolApprovalsTable.status,
          resumeStatus: toolApprovalsTable.resumeStatus, resumeError: toolApprovalsTable.resumeError,
        }).from(toolApprovalsTable).where(and(eq(toolApprovalsTable.id, item.id), eq(toolApprovalsTable.userId, item.userId))).limit(1);
        if (current?.status === 'consumed' && current.resumeStatus === 'completed') report.completed++;
        else if (current?.status === 'expired') report.expired++;
        else if (current?.resumeStatus === 'failed') report.requiresReconciliation++;
        else if (current?.resumeError) report.blocked++;
        else if (current?.resumeStatus === 'running') report.inProgress++;
        else report.skipped++;
      } catch {
        report.blocked++;
        logger.error({ approvalId: item.id }, '[SupportToolResume] Approval recovery blocked');
      }
    }
    return report;
  }
}

export const supportToolResumeService = new SupportToolResumeService();
