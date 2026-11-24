import { forEachBusiness } from '../tenancy/businessScopeResolver.js';
/**
 * Phase 7.11 / MASTRA-002: approval expiry + admin escalation.
 *
 * Background: in Mastra, an agent can pause mid-workflow and ask the
 * user to approve an action (sending outreach, publishing ads, etc.).
 * The user can be AFK for hours. Before this change, a stale pending
 * approval would just sit there indefinitely, blocking the workflow.
 *
 * What this module does:
 *   1. `APPROVAL_TIMEOUT_MS` — env-driven, default 30 minutes. The
 *      constant is read once and exposed for tests.
 *   2. `isPendingApprovalExpired(approval)` — predicate. Approvals
 *      persisted before the `createdAt` field existed are treated as
 *      "never expires" for backward compatibility.
 *   3. `expireStaleApprovals(states)` — sweep a set of in-memory
 *      thread states, find expired ones, and emit `approval:expired`
 *      via EventBus. The state itself is left alone (the user can
 *      still approve later; the notification is the only thing
 *      that fires here).
 *
 * The actual workflow-pause-forever prevention is up to the consumer:
 * the reaper just *signals*. Consumers that want to auto-cancel
 * stale approvals should listen for `approval:expired` and clear
 * `pendingApproval` from the thread state.
 */

import { eventBus } from '../events/EventBus.js';
import { logger } from '../utils/logger.js';
import type { AgentState, PendingApproval } from './state.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Phase 7.11: env-driven approval timeout. `MASTRA_APPROVAL_TIMEOUT_MS`
 * is the env var. Falls back to 30 minutes if unset / unparseable.
 */
export const APPROVAL_TIMEOUT_MS: number = (() => {
  const raw = process.env.MASTRA_APPROVAL_TIMEOUT_MS;
  if (!raw) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { env: raw },
      '[ApprovalExpiry] MASTRA_APPROVAL_TIMEOUT_MS is invalid, falling back to default',
    );
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  return n;
})();

export function isPendingApprovalExpired(
  approval: PendingApproval,
  now: number = Date.now(),
): boolean {
  // Backward compat: approvals without a `createdAt` are never
  // considered expired (they pre-date the feature).
  if (typeof approval.createdAt !== 'number') return false;
  return now - approval.createdAt >= APPROVAL_TIMEOUT_MS;
}

export interface ExpireScanResult {
  expiredCount: number;
  expiredToolNames: string[];
}

/**
 * Sweep a map of `threadId → state` for expired pending approvals and
 * emit `approval:expired` for each. Designed to be called by a periodic
 * timer (every minute is a sensible cadence). Idempotent — calling
 * twice in a row emits nothing the second time.
 */
export function expireStaleApprovals(
  states: Map<number, AgentState>,
  now: number = Date.now(),
): ExpireScanResult {
  const expired: Array<{ threadId: number; state: AgentState; approval: PendingApproval }> = [];

  for (const [threadId, state] of states) {
    if (state.pendingApproval && isPendingApprovalExpired(state.pendingApproval, now)) {
      expired.push({ threadId, state, approval: state.pendingApproval });
    }
  }

  for (const { threadId, state, approval } of expired) {
    const userId = state.userId;
    logger.info(
      { threadId, userId, toolName: approval.toolName, ageMs: now - (approval.createdAt ?? now) },
      '[ApprovalExpiry] Pending approval expired — escalating to admin',
    );
    eventBus.publish({
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      channel: `approval:expired:${userId}:${threadId}`,
      userId,
      threadId,
      toolName: approval.toolName,
      timestamp: new Date(now).toISOString(),
      data: {
        threadId,
        userId,
        toolName: approval.toolName,
        args: approval.args,
        message: approval.message,
        createdAt: approval.createdAt,
        expiredAt: now,
      },
    }).catch((err) => {
      logger.error({ err }, '[ApprovalExpiry] Failed to emit approval:expired event');
    });
  }

  return {
    expiredCount: expired.length,
    expiredToolNames: expired.map((e) => e.approval.toolName),
  };
}

/**
 * Stamp a freshly-created pending approval with `createdAt = now`.
 * Use this everywhere a tool returns `requiresApproval: true` so the
 * reaper can decide when to escalate.
 */
export function stampPendingApproval<P extends PendingApproval>(approval: P): P {
  return { ...approval, createdAt: Date.now() };
}

/**
 * Phase 7.11 follow-up: start a daemon timer that sweeps a states
 * Map every `intervalMs` and emits `approval:expired` for stale
 * entries.
 *
 * The states Map is owned by the caller (it usually lives in the
 * orchestrator or the chatController), so this helper takes a getter
 * to avoid forcing a particular state-management pattern.
 *
 * Call this once at process startup. Returns a `stop()` function so
 * tests / hot reloads can tear it down.
 *
 * If the consumer doesn't have an in-memory states Map (e.g. mastra
 * orchestrator, where state is persisted in Postgres), wire a custom
 * `getStates` that reads from the DB. The default `getStates`
 * signature is `() => Map<number, AgentState>`.
 */
export function startApprovalReaper(
  getStates: () => Map<number, AgentState>,
  intervalMs: number = 60 * 1000,
): () => void {
  if (typeof setInterval === 'undefined') {
    // Non-Node environment (e.g. edge runtime) — no-op.
    return () => undefined;
  }
  const handle = setInterval(() => {
    try {
      const states = getStates();
      if (states && states.size > 0) {
        expireStaleApprovals(states);
      }
    } catch (err) {
      logger.error({ err }, '[ApprovalReaper] sweep failed');
    }
  }, intervalMs);
  // Don't block process exit if the reaper is the only thing left.
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  logger.info(
    { intervalMs },
    '[ApprovalReaper] started — sweeping pending approvals',
  );
  return () => clearInterval(handle);
}

export interface ExpiredApprovalRow {
  id: number;
  user_id: number;
  tool_name: string | null;
  request_id: string | null;
  agent_type: string | null;
}

/** What the person is told, in the conversation, when a review lapses. */
export function expiredApprovalMessage(toolName: string | null): string {
  const action = (toolName || 'action').replace(/_/g, ' ');
  return `This ${action} review expired after ${Math.round(APPROVAL_TIMEOUT_MS / 60_000)} minutes without a decision, so nothing ran. Ask me to prepare it again when you're ready.`;
}

/**
 * A cleared approval used to leave its Approve button live in the chat with no
 * explanation. Post a notice that names the exact review; the conversation UI
 * retires every control bound to a `cancelledApproval` identity.
 */
interface ExpiredApprovalNotice { userId: number; threadId: number; content: string; agentType: string; metadata: Record<string, unknown> }
export interface ExpiredApprovalDeps {
  save: (input: ExpiredApprovalNotice) => Promise<{ id: number; createdAt: Date | string }>;
  emit: (userId: number, threadId: number, message: Record<string, unknown>) => void;
}

export async function announceExpiredApprovals(rows: ExpiredApprovalRow[], deps?: ExpiredApprovalDeps): Promise<void> {
  if (!rows.length) return;
  const resolved: ExpiredApprovalDeps = deps ?? await (async () => {
    const [{ createChatMessage }, { webSocketEmitter }] = await Promise.all([
      import('../models/chatMessages/functions.js'), import('../services/agents/WebSocketEmitter.js'),
    ]);
    return {
      save: (input: ExpiredApprovalNotice) => createChatMessage({ ...input, role: 'assistant' }),
      emit: (userId: number, threadId: number, message: Record<string, unknown>) =>
        webSocketEmitter.emitChatMessage(userId, threadId, message as Parameters<typeof webSocketEmitter.emitChatMessage>[2]),
    };
  })();
  for (const row of rows) {
    const userId = Number(row.user_id), threadId = Number(row.id);
    const content = expiredApprovalMessage(row.tool_name);
    const agentType = row.agent_type || 'orchestrator';
    const metadata = {
      approvalExpired: true,
      ...(row.request_id && row.tool_name ? { cancelledApproval: { requestId: row.request_id, toolName: row.tool_name } } : {}),
    };
    try {
      const saved = await resolved.save({ userId, threadId, content, agentType, metadata });
      resolved.emit(userId, threadId, { id: saved.id, role: 'assistant', content, agentType, metadata,
        timestamp: new Date(saved.createdAt).getTime() });
    } catch (err) {
      logger.error({ err, threadId }, '[ApprovalReaper] Could not post the expired-approval notice');
    }
  }
}

/**
 * Sweep the durable Postgres state used by production Conversation Builder.
 * Expired pending approvals are cleared so they cannot block a thread forever;
 * running approval/widget receipts are moved to an explicit ambiguous failure
 * for reconciliation instead of remaining "running" indefinitely.
 */
export function startPersistentApprovalReaper(
  intervalMs: number = 60 * 1000,
): () => void {
  if (typeof setInterval === 'undefined') return () => undefined;

  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await forEachBusiness(async () => {
      try {
      const [{ db }, { sql }, { ConversationToolApprovalModel }, { WidgetStateModel }] =
        await Promise.all([
          import('../models/db.js'),
          import('drizzle-orm'),
          import('../models/conversationToolApprovals/functions.js'),
          import('../models/widgetStates/functions.js'),
        ]);
      const cutoff = Date.now() - APPROVAL_TIMEOUT_MS;
      const expiredThreads = await db.execute(sql`
        WITH expired AS (
          SELECT
            id,
            user_id,
            metadata->'pendingApproval'->>'toolName' AS tool_name,
            COALESCE(metadata->'pendingApproval'->>'executionId', metadata->'pendingApproval'->>'toolCallId') AS request_id,
            metadata->'pendingApprovalOwner'->>'agentType' AS agent_type
          FROM chat_threads
          WHERE deleted_at IS NULL
            AND metadata ? 'pendingApproval'
            AND COALESCE(metadata->'pendingApproval'->>'createdAt', '') ~ '^[0-9]+$'
            AND (metadata->'pendingApproval'->>'createdAt')::bigint < ${cutoff}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE chat_threads AS threads
        SET
          metadata = threads.metadata - 'pendingApproval',
          updated_at = NOW()
        FROM expired
        WHERE threads.id = expired.id
        RETURNING threads.id, threads.user_id, expired.tool_name, expired.request_id, expired.agent_type
      `);
      await announceExpiredApprovals(expiredThreads.rows as ExpiredApprovalRow[]);
      const expiredReceipts = await ConversationToolApprovalModel.expireStaleRunning();
      const expiredWidgets = await WidgetStateModel.expireStaleRunning();
      const reconciledWidgets = await WidgetStateModel.reconcileDurableExecutions();
      const reconciledWorkflowActions = await WidgetStateModel.reconcileTerminalWorkflowActions();
      const [{ dispatchWidgetCompletionNotifications }, { webSocketEmitter }] = await Promise.all([
        import('./widgetCompletionNotifications.js'), import('../services/agents/WebSocketEmitter.js'),
      ]);
      await dispatchWidgetCompletionNotifications({
        pending: () => WidgetStateModel.findPendingCompletionNotifications(),
        emit: (userId, threadId, widget, eventId) => webSocketEmitter.emitPersistedWidgetUpdate(userId, threadId, { ...widget }, eventId),
        resume: async widget => {
          const { resumeDurableWidgetCompletion } = await import('./chatController.js');
          return resumeDurableWidgetCompletion({ widgetId: widget.id, userId: widget.userId,
            threadId: widget.threadId, runId: widget.runId, toolName: widget.toolName,
            success: widget.status === 'succeeded', result: widget.executionResult });
        },
        acknowledge: (id, userId, eventId) => WidgetStateModel.acknowledgeCompletionNotification(id, userId, eventId),
        onError: (err, widgetId) => logger.error({ err, widgetId }, '[ApprovalReaper] Widget completion notification failed'),
      });
      if (expiredThreads.rows.length || expiredReceipts || expiredWidgets || reconciledWidgets || reconciledWorkflowActions) {
        logger.warn({
          pendingApprovals: expiredThreads.rows.length,
          approvalReceipts: expiredReceipts,
          widgets: expiredWidgets,
          reconciledWidgets,
          reconciledWorkflowActions,
        }, '[ApprovalReaper] Expired durable Conversation Builder work');
      }
    } catch (err) {
      logger.error({ err }, '[ApprovalReaper] durable sweep failed');
      }
      });
    } finally {
      sweeping = false;
    }
  };

  const handle = setInterval(() => {
    void sweep();
  }, intervalMs);
  handle.unref?.();
  void sweep();
  return () => clearInterval(handle);
}
