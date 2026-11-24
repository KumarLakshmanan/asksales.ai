export interface LeadReviewState {
  workflowExecuted: boolean;
  approved: boolean;
  loading: boolean;
  error: boolean;
}

/** Keep campaign outreach fail-closed until review state is known. */
export function isLeadOutreachLocked(threadId: number | undefined, state: LeadReviewState): boolean {
  return Boolean(threadId) && (
    state.loading
    || state.error
    || (state.workflowExecuted && !state.approved)
  );
}
