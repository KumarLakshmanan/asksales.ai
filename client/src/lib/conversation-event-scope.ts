const scopedEvents = new Set([
  'agent_status', 'orchestrator_progress', 'progress_step',
  'workflow_started', 'workflow_step', 'workflow_completed', 'workflow_error',
  'batch_progress', 'execution_summary', 'chat_response_chunk', 'chat_response',
  'chat_message', 'message_sent', 'thread_resolved', 'tool_execution', 'tool_status',
  'tool_approval_required', 'widget_created', 'widget_update', 'open_tab',
  'workflow_run_status', 'lead_saved', 'leads_batch_saved', 'content_generated',
  'lead_inputs_generated', 'icp_update', 'business_profile_created',
]);

export function conversationEventThreadId(data: Record<string, unknown>): number | undefined {
  const raw = data.thread_id ?? data.threadId
    ?? (data.message as { threadId?: unknown } | undefined)?.threadId
    ?? (data.__envelope as { threadId?: unknown } | undefined)?.threadId;
  if (raw == null) return undefined;
  return typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
}

export function conversationEventRequestId(data: Record<string, unknown>): string | undefined {
  const raw = data.requestMessageId ?? data.ackMessageId ?? data.requestId ?? data.request_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Unscoped workspace notifications may pass; campaign mutations need an owner. */
export function matchesConversationEventScope(type: string, data: Record<string, unknown>, currentThreadId: number | null, allowAdoption = false, pendingRequestId?: string | null) {
  const raw = conversationEventThreadId(data);
  if (raw == null) return !scopedEvents.has(type);
  const threadId = Number(raw);
  if (!Number.isSafeInteger(threadId) || threadId <= 0) return false;
  return currentThreadId === null
    ? allowAdoption && Boolean(pendingRequestId) && conversationEventRequestId(data) === pendingRequestId
    : currentThreadId === threadId;
}
