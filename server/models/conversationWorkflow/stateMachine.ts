export const WORKFLOW_STATUSES = [
  'awaiting_input',
  'awaiting_approval',
  'running',
  'queued',
  'partial_success',
  'succeeded',
  'succeeded_empty',
  'failed',
  'cancelled',
  'gated',
  'timed_out',
] as const;

export type ConversationWorkflowStatus = typeof WORKFLOW_STATUSES[number];

export const WORKFLOW_STAGES = [
  'legacy_recovery',
  'icp_draft',
  'icp_awaiting_approval',
  'agent_selection',
  'agent_running',
  'lead_strategy_awaiting_approval',
  'lead_inputs_generating',
  'lead_inputs_awaiting_approval',
  'lead_executing',
  'leads_awaiting_review',
  'outreach_ready',
  'outreach_awaiting_approval',
  'outreach_running',
  'content_awaiting_review',
  'ad_draft',
  'ad_awaiting_approval',
  'ad_publishing',
  'completed',
  'needs_attention',
  'cancelled',
] as const;

export type ConversationWorkflowStage = typeof WORKFLOW_STAGES[number];

const transitions: Record<ConversationWorkflowStage, ReadonlySet<ConversationWorkflowStage>> = {
  legacy_recovery: new Set(['icp_draft', 'icp_awaiting_approval', 'agent_selection', 'lead_strategy_awaiting_approval', 'lead_inputs_awaiting_approval', 'outreach_ready', 'needs_attention', 'cancelled']),
  icp_draft: new Set(['icp_awaiting_approval', 'needs_attention', 'cancelled']),
  icp_awaiting_approval: new Set(['icp_draft', 'agent_selection', 'needs_attention', 'cancelled']),
  agent_selection: new Set(['agent_running', 'lead_strategy_awaiting_approval', 'lead_inputs_awaiting_approval', 'outreach_ready', 'content_awaiting_review', 'ad_draft', 'needs_attention', 'cancelled']),
  agent_running: new Set(['lead_strategy_awaiting_approval', 'lead_inputs_awaiting_approval', 'outreach_ready', 'content_awaiting_review', 'ad_draft', 'completed', 'needs_attention', 'cancelled']),
  lead_strategy_awaiting_approval: new Set(['agent_selection', 'lead_inputs_generating', 'needs_attention', 'cancelled']),
  lead_inputs_generating: new Set(['lead_strategy_awaiting_approval', 'lead_inputs_awaiting_approval', 'needs_attention', 'cancelled']),
  lead_inputs_awaiting_approval: new Set(['lead_strategy_awaiting_approval', 'lead_executing', 'needs_attention', 'cancelled']),
  lead_executing: new Set(['leads_awaiting_review', 'completed', 'needs_attention', 'cancelled']),
  leads_awaiting_review: new Set(['lead_strategy_awaiting_approval', 'lead_inputs_generating', 'lead_inputs_awaiting_approval', 'lead_executing', 'outreach_ready', 'agent_selection', 'needs_attention', 'cancelled']),
  outreach_ready: new Set(['outreach_awaiting_approval', 'agent_selection', 'needs_attention', 'cancelled']),
  outreach_awaiting_approval: new Set(['outreach_ready', 'outreach_running', 'needs_attention', 'cancelled']),
  outreach_running: new Set(['completed', 'needs_attention', 'cancelled']),
  content_awaiting_review: new Set(['agent_selection', 'ad_draft', 'outreach_awaiting_approval', 'completed', 'needs_attention', 'cancelled']),
  ad_draft: new Set(['ad_awaiting_approval', 'content_awaiting_review', 'needs_attention', 'cancelled']),
  ad_awaiting_approval: new Set(['ad_draft', 'ad_publishing', 'needs_attention', 'cancelled']),
  ad_publishing: new Set(['completed', 'needs_attention', 'cancelled']),
  completed: new Set(),
  needs_attention: new Set(['icp_draft', 'icp_awaiting_approval', 'agent_selection', 'lead_strategy_awaiting_approval', 'lead_inputs_generating', 'lead_inputs_awaiting_approval', 'lead_executing', 'leads_awaiting_review', 'outreach_ready', 'outreach_awaiting_approval', 'outreach_running', 'content_awaiting_review', 'ad_draft', 'ad_awaiting_approval', 'ad_publishing', 'cancelled']),
  cancelled: new Set(),
};

/**
 * What the user is told when a campaign step cannot change from `from`.
 * Steps that are sending, searching or publishing stay locked on purpose so a
 * change of direction can never cause duplicate sends or spend.
 */
export function campaignStepLockedMessage(from: ConversationWorkflowStage): string {
  switch (from) {
    case 'lead_executing':
      return 'The lead search is still running. Wait for it to finish, then you can change the next step.';
    case 'outreach_running':
      return 'Your messages are being sent. Wait for sending to finish before changing this campaign.';
    case 'ad_publishing':
      return 'Your ad is being published. Wait for publishing to finish before changing this campaign.';
    case 'completed':
    case 'cancelled':
      return 'This campaign is finished. Start a new campaign to keep going.';
    case 'outreach_awaiting_approval':
      return 'An outreach review is waiting for you. Approve or cancel it first, then you can change direction.';
    case 'ad_awaiting_approval':
    case 'ad_draft':
      return 'An ad review is open. Finish or cancel it first, then you can change direction.';
    default:
      return 'Finish or cancel the current campaign step, then try again.';
  }
}

/** Its message is written for the user; `detail` keeps the stage names for logs. */
export class InvalidWorkflowTransitionError extends Error {
  readonly from: ConversationWorkflowStage;
  readonly to: ConversationWorkflowStage;
  readonly detail: string;

  constructor(from: ConversationWorkflowStage, to: ConversationWorkflowStage) {
    super(campaignStepLockedMessage(from));
    this.name = 'InvalidWorkflowTransitionError';
    this.from = from;
    this.to = to;
    this.detail = `Invalid conversation workflow transition: ${from} -> ${to}`;
  }
}

export function canTransitionWorkflow(
  from: ConversationWorkflowStage,
  to: ConversationWorkflowStage,
): boolean {
  return from === to || transitions[from].has(to);
}

export function assertWorkflowTransition(
  from: ConversationWorkflowStage,
  to: ConversationWorkflowStage,
): void {
  if (!canTransitionWorkflow(from, to)) {
    throw new InvalidWorkflowTransitionError(from, to);
  }
}

/** Recipient review records intent; it never cancels another active action. */
export function workflowAfterRecipientSelection(
  stage: ConversationWorkflowStage,
  status: ConversationWorkflowStatus,
): { toStage: ConversationWorkflowStage; status: ConversationWorkflowStatus } {
  return canTransitionWorkflow(stage, 'outreach_ready')
    ? { toStage: 'outreach_ready', status: 'awaiting_input' }
    : { toStage: stage, status };
}

export function isTerminalWorkflowStatus(status: ConversationWorkflowStatus): boolean {
  return ['partial_success', 'succeeded', 'succeeded_empty', 'failed', 'cancelled', 'gated', 'timed_out'].includes(status);
}

export function isCurrentIcpRevisionApproved(icp: {
  approved?: boolean | null;
  revision?: number | null;
  approvedRevision?: number | null;
} | null | undefined): boolean {
  return Boolean(
    icp?.approved === true
    && Number.isInteger(icp.revision)
    && icp.revision === icp.approvedRevision,
  );
}
