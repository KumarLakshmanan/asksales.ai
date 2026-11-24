export const CONVERSATION_PROCESSING_STALE_AFTER_MS = 150_000;

interface DurableWorkflowRun {
  status?: unknown;
  updatedAt?: unknown;
}

/** Rehydrate a spinner only when a running workflow has a recent durable heartbeat. */
export function shouldResumeConversationProcessing(
  workflowRun: DurableWorkflowRun | null | undefined,
  now = Date.now(),
  staleAfterMs = CONVERSATION_PROCESSING_STALE_AFTER_MS,
): boolean {
  if (workflowRun?.status !== 'running') return false;
  const updatedAt = typeof workflowRun.updatedAt === 'number'
    ? workflowRun.updatedAt
    : typeof workflowRun.updatedAt === 'string'
      ? Date.parse(workflowRun.updatedAt)
      : NaN;
  if (!Number.isFinite(updatedAt)) return false;
  const age = now - updatedAt;
  return age >= -30_000 && age <= staleAfterMs;
}
