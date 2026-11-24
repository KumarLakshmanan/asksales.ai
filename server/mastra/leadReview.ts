export interface LeadReviewState {
  leadWorkflowExecuted?: boolean;
  leadReviewApproved?: boolean;
  selectedLeadIds?: unknown;
}

export interface LeadOutreachGate {
  status: 'no_leads' | 'awaiting_lead_review';
  error: string;
}

export function normalizeReviewedLeadIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((id) => typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id.trim())))
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )];
}

export function hasReviewableLeadSelection(state: Pick<LeadReviewState, 'selectedLeadIds'>): boolean {
  return normalizeReviewedLeadIds(state.selectedLeadIds).length > 0;
}

export function getCompletedLeadOutreachGate(state: LeadReviewState): LeadOutreachGate | null {
  if (state.leadWorkflowExecuted !== true) return null;
  if (!hasReviewableLeadSelection(state)) {
    return {
      status: 'no_leads',
      error: 'No persisted lead IDs are available for outreach. Generate or import leads before continuing.',
    };
  }
  if (state.leadReviewApproved !== true) {
    return {
      status: 'awaiting_lead_review',
      error: 'Review and explicitly approve the persisted leads before outreach handoff.',
    };
  }
  return null;
}
