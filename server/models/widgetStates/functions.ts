/**
 * Widget States Functions
 * CRUD operations for interactive widget states
 */

import { db } from '../db';
import { widgetStatesTable, type InsertWidgetState, type WidgetState } from './schema';
import { eq, and, desc, inArray, isNull, lt, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { canCancelWidgetReview, canDeleteWidgetReview, canEditWidgetReview } from '../../../shared/toolExecutionReceipt.js';
import { creationMessageReconciliation } from './creationMessageReconciliation.js';

const WIDGET_EXECUTION_LEASE_MS = 15 * 60 * 1000;

async function lockOwnedWidget(tx: typeof db, id: number, userId: number): Promise<WidgetState | undefined> {
  return (await tx.select().from(widgetStatesTable).where(and(
    eq(widgetStatesTable.id, id), eq(widgetStatesTable.userId, userId),
  )).for('update').limit(1))[0];
}

async function updateReviewUnderLock(
  id: number, userId: number, allowed: (widget: WidgetState) => boolean, values: Partial<InsertWidgetState>,
): Promise<WidgetState | undefined> {
  return db.transaction(async (tx: typeof db) => {
    const current = await lockOwnedWidget(tx, id, userId);
    if (!current || !allowed(current)) return undefined;
    return (await tx.update(widgetStatesTable).set({ ...values, updatedAt: new Date() }).where(and(
      eq(widgetStatesTable.id, id), eq(widgetStatesTable.userId, userId), eq(widgetStatesTable.status, current.status),
    )).returning())[0];
  });
}

export const WidgetStateModel = {
  /** Atomically revoke unstarted reviews; a racing claimed execution is never reported cancelled. */
  async cancelPendingForThreadForUser(userId: number, threadId: number, widgetId?: number): Promise<WidgetState[]> {
    return db.transaction(async (tx: typeof db) => {
      const candidates: WidgetState[] = await tx.select().from(widgetStatesTable).where(and(
        eq(widgetStatesTable.userId, userId),
        eq(widgetStatesTable.threadId, threadId),
        ...(widgetId === undefined ? [] : [eq(widgetStatesTable.id, widgetId)]),
        inArray(widgetStatesTable.status, ['active', 'draft', 'failed']),
      )).orderBy(widgetStatesTable.id).for('update');
      const ids = candidates.filter(canCancelWidgetReview).map(widget => widget.id);
      if (!ids.length) return [];
      return tx.update(widgetStatesTable).set({ status: 'cancelled', updatedAt: new Date() }).where(and(
        eq(widgetStatesTable.userId, userId), eq(widgetStatesTable.threadId, threadId), inArray(widgetStatesTable.id, ids),
      )).returning();
    });
  },
  async findPendingCompletionNotifications(): Promise<WidgetState[]> {
    return db.select().from(widgetStatesTable).where(and(
      inArray(widgetStatesTable.status, ['succeeded', 'failed']),
      sql`${widgetStatesTable.executionResult}->'completionNotification'->>'status' = 'pending'`,
    )).orderBy(widgetStatesTable.updatedAt).limit(100);
  },

  async acknowledgeCompletionNotification(id: number, userId: number, eventId: string): Promise<void> {
    await db.update(widgetStatesTable).set({
      executionResult: sql`jsonb_set(${widgetStatesTable.executionResult}, '{completionNotification,status}', '"dispatched"'::jsonb)`,
    }).where(and(
      eq(widgetStatesTable.id, id), eq(widgetStatesTable.userId, userId),
      sql`${widgetStatesTable.executionResult}->'completionNotification'->>'eventId' = ${eventId}`,
      sql`${widgetStatesTable.executionResult}->'completionNotification'->>'status' = 'pending'`,
    ));
  },

  async create(data: InsertWidgetState): Promise<WidgetState> {
    const [result] = await db.insert(widgetStatesTable).values(data).returning();
    return result;
  },

  /** Replace one owned, unstarted review atomically. Never leave both versions
   * executable, and preserve the old review if saving the replacement fails. */
  async replacePendingReviewForUser(id: number, data: InsertWidgetState): Promise<WidgetState> {
    return db.transaction(async (tx: typeof db) => {
      const [previous] = await tx.select().from(widgetStatesTable).where(and(
        eq(widgetStatesTable.id, id), eq(widgetStatesTable.userId, data.userId),
        eq(widgetStatesTable.threadId, data.threadId), eq(widgetStatesTable.toolName, data.toolName),
      )).for('update').limit(1);
      if (!previous || !['active', 'draft'].includes(previous.status) || !canEditWidgetReview(previous)) {
        throw new Error('The selected review is no longer editable. Reload its current state before revising it.');
      }
      const [replacement] = await tx.insert(widgetStatesTable).values({ ...data, status: 'active' }).returning();
      if (!replacement) throw new Error('The revised review could not be saved.');
      await tx.update(widgetStatesTable).set({
        status: 'cancelled', updatedAt: new Date(),
        executionResult: { supersededByWidgetId: replacement.id, reason: 'review_revised', executed: false },
      }).where(eq(widgetStatesTable.id, previous.id));
      return replacement;
    });
  },

  async findByIdForUser(id: number, userId: number): Promise<WidgetState | undefined> {
    const [result] = await db.select().from(widgetStatesTable).where(and(
      eq(widgetStatesTable.id, id),
      eq(widgetStatesTable.userId, userId),
    ));
    return result;
  },

  async findByThreadForUser(userId: number, threadId: number): Promise<WidgetState[]> {
    return db.select().from(widgetStatesTable)
      .where(and(
        eq(widgetStatesTable.userId, userId),
        eq(widgetStatesTable.threadId, threadId),
      ))
      .orderBy(desc(widgetStatesTable.createdAt))
      .limit(200);
  },

  async bindRunActionForUser(
    id: number,
    userId: number,
    runId: string,
    actionId: string,
  ): Promise<WidgetState | undefined> {
    const [result] = await db.update(widgetStatesTable)
      .set({
        runId,
        actionId,
        idempotencyKey: `${runId}:${actionId}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(widgetStatesTable.id, id),
        eq(widgetStatesTable.userId, userId),
        isNull(widgetStatesTable.runId),
      ))
      .returning();
    return result || this.findByIdForUser(id, userId);
  },

  async updateFormValuesForUser(
    id: number,
    userId: number,
    formValues: Record<string, unknown>,
  ): Promise<WidgetState | undefined> {
    return updateReviewUnderLock(id, userId, canEditWidgetReview, { formValues });
  },

  async claimSubmissionForUser(
    id: number,
    userId: number,
    submittedValues: Record<string, unknown>,
  ): Promise<{ widget: WidgetState | undefined; claimed: boolean }> {
    return db.transaction(async (tx: typeof db) => {
      const [current] = await tx.select().from(widgetStatesTable).where(and(
        eq(widgetStatesTable.id, id), eq(widgetStatesTable.userId, userId),
      )).for('update').limit(1);
      // A retry hint cannot override accepted or ambiguous work. Keep the read
      // and claim under the same row lock so a receipt cannot change between them.
      if (!current || !canEditWidgetReview(current)) {
        return { widget: current, claimed: false };
      }
      const now = new Date();
      const [claimedWidget] = await tx.update(widgetStatesTable)
        .set({
          status: 'running',
          submittedValues,
          submittedAt: now,
          executionResult: null,
          executionError: null,
          executionStartedAt: now,
          executionCompletedAt: null,
          executionLeaseToken: crypto.randomUUID(),
          executionLeaseExpiresAt: new Date(now.getTime() + WIDGET_EXECUTION_LEASE_MS),
          executionAttemptCount: sql`${widgetStatesTable.executionAttemptCount} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(widgetStatesTable.id, id),
          eq(widgetStatesTable.userId, userId),
          eq(widgetStatesTable.status, current.status),
        ))
        .returning();
      if (claimedWidget) return { widget: claimedWidget, claimed: true };
      return { widget: current, claimed: false };
    });
  },

  async expireStaleRunning(now = new Date()): Promise<number> {
    const expired = await db.update(widgetStatesTable)
      .set({
        status: 'failed',
        executionResult: {
          ambiguous: true,
          retrySafe: false,
          reason: 'execution_lease_expired',
        },
        executionError: 'Execution lease expired. Reconcile the queued/provider operation before retrying.',
        executionCompletedAt: now,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(widgetStatesTable.status, 'running'),
        lt(widgetStatesTable.executionLeaseExpiresAt, now),
      ))
      .returning({ id: widgetStatesTable.id });
    return expired.length;
  },

  /**
   * Repair workflow actions whose widget reached a terminal state after the
   * request that originally executed it disappeared (for example, during a
   * deploy). Without this reconciliation the conversation remains locked on a
   * stale `running` action even though the widget lease has already expired.
   */
  async reconcileTerminalWorkflowActions(): Promise<number> {
    const reconciled = await db.execute(sql`
      UPDATE conversation_workflow_actions action
      SET
        status = widget.status,
        output = COALESCE(action.output, widget.execution_result),
        error = CASE
          WHEN widget.status = 'failed'
            THEN COALESCE(widget.execution_error, action.error, 'Widget execution failed')
          ELSE NULL
        END,
        completed_at = COALESCE(widget.execution_completed_at, NOW()),
        updated_at = NOW()
      FROM widget_states widget
      WHERE widget.action_id = action.id
        AND widget.run_id = action.run_id
        AND widget.user_id = action.user_id
        AND widget.thread_id = action.thread_id
        AND widget.status IN ('succeeded', 'failed')
        AND action.status IN ('running', 'queued')
      RETURNING action.id
    `);
    const reconciledThreads = await db.execute(sql`
      UPDATE chat_threads thread
      SET
        metadata = jsonb_set(
          jsonb_set(
            COALESCE(thread.metadata, '{}'::jsonb),
            '{workflowOutcome}',
            to_jsonb(action.status),
            true
          ),
          '{workflowRun,status}',
          to_jsonb(action.status),
          true
        ),
        updated_at = NOW()
      FROM conversation_workflow_actions action
      WHERE action.thread_id = thread.id
        AND action.user_id = thread.user_id
        AND action.status IN ('succeeded', 'failed')
        AND thread.metadata->'workflowRun'->>'actionId' = action.id
        AND thread.metadata->'workflowRun'->>'status' IN ('running', 'queued')
      RETURNING thread.id
    `);
    return reconciled.rows.length + reconciledThreads.rows.length;
  },

  async completeExecutionForUser(
    id: number,
    userId: number,
    executionLeaseToken: string,
    success: boolean,
    executionResult?: unknown,
    executionError?: string,
    terminalStatus?: 'succeeded' | 'failed' | 'queued' | 'provider_succeeded',
  ): Promise<WidgetState | undefined> {
    const [result] = await db.update(widgetStatesTable)
      .set({
        status: terminalStatus || (success ? 'succeeded' : 'failed'),
        executionResult: executionResult === undefined
          ? undefined
          : sql`COALESCE(${widgetStatesTable.executionResult}, '{}'::jsonb) || ${JSON.stringify(executionResult)}::jsonb`,
        executionError,
        executionCompletedAt: new Date(),
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(widgetStatesTable.id, id),
        eq(widgetStatesTable.userId, userId),
        eq(widgetStatesTable.status, 'running'),
        eq(widgetStatesTable.executionLeaseToken, executionLeaseToken),
      ))
      .returning();
    return result;
  },

  /** @deprecated Compatibility entry point. New worker outcomes must use
   * recordQueuedJobOutcomeForUser to retain per-job receipt aggregation. */
  async reconcileQueuedExecutionForUser(
    id: number,
    userId: number,
    success: boolean,
    executionResult?: unknown,
    executionError?: string,
  ): Promise<WidgetState | undefined> {
    const [result] = await db.update(widgetStatesTable)
      .set({
        status: success ? 'succeeded' : 'failed',
        executionResult,
        executionError,
        executionCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(widgetStatesTable.id, id),
        eq(widgetStatesTable.userId, userId),
        inArray(widgetStatesTable.status, ['queued', 'provider_succeeded']),
      ))
      .returning();
    return result;
  },

  async recordQueuedJobOutcomeForUser(
    id: number,
    userId: number,
    jobId: string,
    expectedJobCount: number,
    success: boolean,
    result: unknown,
  ): Promise<WidgetState | undefined> {
    return db.transaction(async (tx: typeof db) => {
      const locked = await tx.execute(sql`
        SELECT *
        FROM widget_states
        WHERE id = ${id} AND user_id = ${userId}
          AND status IN ('running', 'queued')
        FOR UPDATE
      `);
      const widget = locked.rows[0] as Record<string, unknown> | undefined;
      if (!widget) return undefined;
      const executionResult = (
        widget.execution_result &&
        typeof widget.execution_result === 'object' &&
        !Array.isArray(widget.execution_result)
      ) ? widget.execution_result as Record<string, unknown> : {};
      const existingOutcomes = (
        executionResult.reconciliationJobOutcomes &&
        typeof executionResult.reconciliationJobOutcomes === 'object' &&
        !Array.isArray(executionResult.reconciliationJobOutcomes)
      ) ? executionResult.reconciliationJobOutcomes as Record<string, unknown> : {};
      const outcomes = {
        ...existingOutcomes,
        [jobId]: { success, result, recordedAt: new Date().toISOString() },
      };
      const expected = Math.max(1, Math.min(expectedJobCount, 500));
      const allRecorded = Object.keys(outcomes).length >= expected;
      const allSucceeded = allRecorded && Object.values(outcomes).every((outcome) =>
        Boolean(
          outcome &&
          typeof outcome === 'object' &&
          !Array.isArray(outcome) &&
          (outcome as Record<string, unknown>).success === true
        )
      );
      const mayFinalize = widget.status === 'queued' && allRecorded;
      const updated = await tx.execute(sql`
        UPDATE widget_states
        SET
          status = CASE
            WHEN ${mayFinalize} THEN ${allSucceeded ? 'succeeded' : 'failed'}
            ELSE status
          END,
          execution_result = COALESCE(execution_result, '{}'::jsonb)
            || ${JSON.stringify({
              reconciliationJobOutcomes: outcomes,
              expectedReconciliationJobCount: expected,
            })}::jsonb,
          execution_error = CASE
            WHEN ${mayFinalize && !allSucceeded}
              THEN 'One or more queued outreach jobs failed'
            WHEN ${mayFinalize && allSucceeded} THEN NULL
            ELSE execution_error
          END,
          execution_completed_at = CASE WHEN ${mayFinalize} THEN NOW() ELSE execution_completed_at END,
          updated_at = NOW()
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING *
      `);
      return updated.rows[0] as WidgetState | undefined;
    });
  },

  /**
   * Reconcile durable provider/worker receipts without repeating side effects.
   * This intentionally reads only tenant-owned IDs persisted in executionResult.
   */
  async reconcileDurableExecutions(): Promise<number> {
    const relations = await db.execute(sql`
      SELECT
        to_regclass('public.social_publish_attempts') IS NOT NULL AS has_social,
        to_regclass('public.ad_action_queue') IS NOT NULL AS has_ads,
        to_regclass('public.outreach_jobs') IS NOT NULL AS has_outreach,
        to_regclass('public.outreach_messages') IS NOT NULL AND to_regclass('public.outreach_conversations') IS NOT NULL AS has_creation_messages
    `);
    const available = relations.rows[0] as {
      has_social?: boolean;
      has_ads?: boolean;
      has_outreach?: boolean;
      has_creation_messages?: boolean;
    } | undefined;
    let reconciled = 0;

    if (available?.has_social) {
      const social = await db.execute(sql`
      UPDATE widget_states widget
      SET
        status = CASE
          WHEN attempt.status = 'succeeded' THEN 'succeeded'
          ELSE 'failed'
        END,
        execution_result = COALESCE(widget.execution_result, '{}'::jsonb)
          || jsonb_build_object(
            'reconciliation',
            jsonb_build_object(
              'source', 'social_publish_attempts',
              'status', attempt.status,
              'attemptId', attempt.id,
              'providerPostId', attempt.provider_post_id,
              'providerPostUrl', attempt.provider_post_url
            )
          ),
        execution_error = CASE
          WHEN attempt.status = 'succeeded' THEN NULL
          ELSE COALESCE(attempt.error_message, 'Social publishing requires manual reconciliation')
        END,
        execution_completed_at = NOW(),
        updated_at = NOW()
      FROM social_publish_attempts attempt
      WHERE widget.user_id = attempt.user_id
        AND widget.tool_name = 'publish_social_post'
        AND widget.status IN ('queued', 'provider_succeeded')
        AND COALESCE(widget.execution_result->'output'->>'attemptId', '') ~ '^[0-9]+$'
        AND attempt.id = (widget.execution_result->'output'->>'attemptId')::bigint
        AND attempt.status IN ('succeeded', 'failed', 'ambiguous')
      RETURNING widget.id
      `);
      reconciled += social.rows.length;
    }

    if (available?.has_ads) {
      const { reconcileStopWidgets } = await import('./stopReconciliation.js');
      reconciled += await reconcileStopWidgets(db);
      const ads = await db.execute(sql`
      WITH matched_action AS (
        SELECT DISTINCT ON (widget.id)
          widget.id AS widget_id,
          action.id,
          action.status,
          action.provider_outcome,
          action.last_error
        FROM widget_states widget
        JOIN ad_action_queue action
          ON action.user_id = widget.user_id
         AND action.platform = CASE WHEN widget.tool_name = 'publish_google_ads' THEN 'google' ELSE 'meta' END
         AND action.action_type = 'publish'
         AND COALESCE(widget.execution_result->'output'->>'campaignId', '') ~ '^[0-9]+$'
         AND action.campaign_id = (widget.execution_result->'output'->>'campaignId')::integer
        WHERE widget.tool_name IN ('publish_meta_ads', 'publish_google_ads')
          AND widget.status = 'queued'
          AND action.status IN ('succeeded', 'failed')
        ORDER BY widget.id, action.id DESC
      )
      UPDATE widget_states widget
      SET
        status = CASE WHEN action.status = 'succeeded' THEN 'succeeded' ELSE 'failed' END,
        execution_result = COALESCE(widget.execution_result, '{}'::jsonb)
          || jsonb_build_object(
            'reconciliation',
            jsonb_build_object(
              'source', 'ad_action_queue',
              'status', action.status,
              'actionId', action.id,
              'providerOutcome', action.provider_outcome
            )
          ),
        execution_error = CASE
          WHEN action.status = 'succeeded' THEN NULL
          ELSE COALESCE(action.last_error, 'Ad campaign worker failed')
        END,
        execution_completed_at = NOW(),
        updated_at = NOW()
      FROM matched_action action
      WHERE widget.id = action.widget_id
      RETURNING widget.id
      `);
      reconciled += ads.rows.length;
    }

    if (available?.has_outreach) {
      const outreach = await db.execute(sql`
      WITH direct_jobs AS (
        SELECT
          widget.id AS widget_id,
          widget.user_id,
          COUNT(*) FILTER (WHERE job.status = 'sent') AS sent_count,
          COUNT(*) FILTER (WHERE job.status IN ('failed', 'cancelled')) AS failed_count,
          COUNT(*) FILTER (WHERE job.status IN ('pending', 'processing')) AS open_count
        FROM widget_states widget
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(widget.execution_result->'output'->'results', '[]'::jsonb)
        ) result
        JOIN outreach_jobs job
          ON result->>'jobId' ~ '^[0-9]+$'
         AND job.id = (result->>'jobId')::bigint
         AND job.user_id = widget.user_id
        WHERE widget.tool_name = 'send_outreach_messages'
          AND widget.status = 'queued'
        GROUP BY widget.id, widget.user_id
      )
      UPDATE widget_states widget
      SET
        status = CASE WHEN jobs.failed_count = 0 THEN 'succeeded' ELSE 'failed' END,
        execution_result = COALESCE(widget.execution_result, '{}'::jsonb)
          || jsonb_build_object(
            'reconciliation',
            jsonb_build_object(
              'source', 'outreach_jobs',
              'sentCount', jobs.sent_count,
              'failedCount', jobs.failed_count
            )
          ),
        execution_error = CASE
          WHEN jobs.failed_count = 0 THEN NULL
          ELSE 'One or more outreach jobs failed; review delivery details before retrying'
        END,
        execution_completed_at = NOW(),
        updated_at = NOW()
      FROM direct_jobs jobs
      WHERE widget.id = jobs.widget_id
        AND jobs.open_count = 0
        AND (jobs.sent_count + jobs.failed_count) > 0
      RETURNING widget.id
      `);
      reconciled += outreach.rows.length;
    }

    if (available?.has_creation_messages) {
      const creation = await db.execute(creationMessageReconciliation());
      reconciled += creation.rows.length;
    }

    const queuedCallbacks = await db.execute(sql`
      UPDATE widget_states widget
      SET
        status = CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM jsonb_each(COALESCE(widget.execution_result->'reconciliationJobOutcomes', '{}'::jsonb)) outcome
            WHERE COALESCE((outcome.value->>'success')::boolean, false) = false
          ) THEN 'succeeded'
          ELSE 'failed'
        END,
        execution_error = CASE
          WHEN EXISTS (
            SELECT 1
            FROM jsonb_each(COALESCE(widget.execution_result->'reconciliationJobOutcomes', '{}'::jsonb)) outcome
            WHERE COALESCE((outcome.value->>'success')::boolean, false) = false
          ) THEN 'One or more queued outreach jobs failed'
          ELSE NULL
        END,
        execution_completed_at = NOW(),
        updated_at = NOW()
      WHERE widget.tool_name = 'send_outreach_messages'
        AND widget.status = 'queued'
        AND COALESCE(widget.execution_result->>'expectedReconciliationJobCount', '') ~ '^[0-9]+$'
        AND (
          SELECT COUNT(*)
          FROM jsonb_object_keys(
            COALESCE(widget.execution_result->'reconciliationJobOutcomes', '{}'::jsonb)
          )
        ) >= (widget.execution_result->>'expectedReconciliationJobCount')::integer
      RETURNING widget.id
    `);
    reconciled += queuedCallbacks.rows.length;

    return reconciled;
  },

  async closeForUser(
    id: number,
    userId: number,
    status: 'draft' | 'cancelled' = 'draft',
  ): Promise<WidgetState | undefined> {
    return updateReviewUnderLock(id, userId, canEditWidgetReview, { status });
  },

  async reopenForUser(id: number, userId: number): Promise<WidgetState | undefined> {
    return updateReviewUnderLock(id, userId,
      widget => widget.status === 'draft' && canEditWidgetReview(widget), { status: 'active' });
  },

  async deleteForUser(id: number, userId: number): Promise<boolean> {
    return db.transaction(async (tx: typeof db) => {
      const current = await lockOwnedWidget(tx, id, userId);
      if (!current || !canDeleteWidgetReview(current)) return false;
      const deleted = await tx.delete(widgetStatesTable).where(and(
        eq(widgetStatesTable.id, id), eq(widgetStatesTable.userId, userId), eq(widgetStatesTable.status, current.status),
      )).returning({ id: widgetStatesTable.id });
      return deleted.length > 0;
    });
  },

  async updateMessageId(id: number, messageId: number): Promise<WidgetState | undefined> {
    const [result] = await db.update(widgetStatesTable)
      .set({
        messageId,
        updatedAt: new Date(),
      })
      .where(eq(widgetStatesTable.id, id))
      .returning();
    return result;
  },
};
