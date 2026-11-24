import { WidgetStateModel } from '../models/widgetStates/functions.js';
import { setConversationWorkflowActionStatus } from '../models/conversationWorkflow/functions.js';
import { webSocketEmitter } from '../services/agents/WebSocketEmitter.js';
import { logger } from '../utils/logger.js';
import { ConversationToolApprovalModel } from '../models/conversationToolApprovals/functions.js';
import type { PendingApproval } from './state.js';
import { clearPendingApprovalIfMatches } from '../models/chatThreads/functions.js';

/** Selecting another strategy cannot authorize the previous strategy's execution. */
export async function retireLeadStrategyApproval(userId: number, threadId: number, pending?: PendingApproval | null): Promise<{ requestId: string; toolName: string } | null> {
  if (pending?.toolName !== 'execute_lead_workflow') return null;
  const requestId = pending.executionId || pending.toolCallId;
  if (!requestId) throw new Error('The previous search review has no identity. Prepare a fresh campaign review.');
  const { approval } = await ConversationToolApprovalModel.claim({ userId, threadId, requestId, toolName: pending.toolName, toolArgs: pending.args || {}, approved: false });
  if (approval.status === 'running') throw new Error('The previous search has already been accepted and is running. Its strategy cannot be replaced.');
  await clearPendingApprovalIfMatches(threadId, userId, requestId, pending.toolName);
  return approval.decision === 'reject' && approval.status === 'rejected' ? { requestId, toolName: pending.toolName } : null;
}

/** Reject the exact pending request; never overwrite a concurrently accepted execution. */
export async function cancelPendingCampaignApproval(userId: number, threadId: number, pending?: PendingApproval | null): Promise<{ requestId: string; toolName: string } | null> {
  const requestId = pending?.executionId || pending?.toolCallId;
  if (!requestId || !pending?.toolName) return null;
  const { approval } = await ConversationToolApprovalModel.claim({
    userId, threadId, requestId, toolName: pending.toolName, toolArgs: pending.args || {}, approved: false,
  });
  return approval.decision === 'reject' && approval.status === 'rejected'
    ? { requestId, toolName: pending.toolName }
    : null;
}

/** Cancel only tenant/thread-owned, unstarted review actions, never provider operations. */
export async function cancelCampaignReviews(userId: number, threadId: number, widgetId?: number): Promise<number[]> {
  if (widgetId !== undefined && (!Number.isSafeInteger(widgetId) || widgetId <= 0)) throw new Error('Invalid review identity');
  const cancelled = widgetId === undefined
    ? await WidgetStateModel.cancelPendingForThreadForUser(userId, threadId)
    : await WidgetStateModel.cancelPendingForThreadForUser(userId, threadId, widgetId);
  for (const widget of cancelled) {
    // Notify as soon as execution authorization has been revoked durably.
    webSocketEmitter.emitWidgetUpdate(userId, threadId, { id: widget.id, status: 'cancelled' });
    if (widget.runId && widget.actionId) {
      try {
        await setConversationWorkflowActionStatus({
          userId, threadId, runId: widget.runId, actionId: widget.actionId,
          status: 'cancelled', output: { widgetId: widget.id, reason: widgetId === undefined ? 'campaign_cancelled' : 'review_cancelled' },
        });
      } catch (err) {
        // The widget CAS is authoritative for execution. Do not hide its
        // successful cancellation if an older action audit row is unavailable.
        logger.error({ err, widgetId: widget.id }, '[Campaign cancellation] Could not update action audit');
      }
    }
  }
  return cancelled.map(widget => widget.id);
}
