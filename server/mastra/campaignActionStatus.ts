import { isCurrentIcpRevisionApproved } from '../models/conversationWorkflow/stateMachine.js';
import { toUserFacingError } from '../../shared/userFacingError.js';
import type { OutreachDeliveryReport } from './campaignActionDeliveryState.js';

type ReviewRecord = {
  id: number;
  toolName: string;
  agentType: string | null;
  status: string;
  formValues?: Record<string, unknown> | null;
  submittedValues?: Record<string, unknown> | null;
  executionError?: string | null;
};

export type StoredOutreachCount = { channel: string; status: string; count: number };

/** Only supply metadata freshly read after ownership validation and locking. */
export type PendingExecutionApprovalLedger =
  | { status: 'available'; metadata: unknown }
  | { status: 'unavailable' };

function describePendingExecutionApproval(ledger?: PendingExecutionApprovalLedger): string {
  const unavailable = 'Pending execution approval ledger unavailable; absence of widget reviews does not establish that no approval is waiting.';
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (ledger?.status !== 'available' || !isRecord(ledger.metadata)) return unavailable;
  const metadata = ledger.metadata;
  const pending = metadata.pendingApproval;
  if (pending === undefined || pending === null) {
    if (metadata.requiresApproval !== undefined && metadata.requiresApproval !== false) return unavailable;
    return 'No pending execution approval is recorded in the freshly read conversation metadata (separate from widget reviews).';
  }
  if (!isRecord(pending)) return unavailable;
  // Reject malformed identifiers instead of stripping characters into a different
  // actionable identity. No messages, arguments, errors or arbitrary metadata leak.
  const safeIdentifier = (value: unknown, pattern: RegExp): string | undefined =>
    typeof value === 'string' && pattern.test(value.trim()) ? value.trim() : undefined;
  const tool = safeIdentifier(pending.toolName, /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/);
  const rawRequestId = pending.executionId || pending.toolCallId;
  const requestId = safeIdentifier(rawRequestId, /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,199}$/);
  if (!tool || !requestId) return unavailable;
  const savedOwner = metadata.pendingApprovalOwner;
  const owner = isRecord(savedOwner) && savedOwner.requestId === rawRequestId
    ? safeIdentifier(savedOwner.agentType, /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/) : undefined;
  return `Pending execution approval (separate from widget reviews): tool ${tool}, request ID ${requestId}, owner ${owner || 'unavailable'} — awaiting approval.`;
}

export function reviewedOutreachLeadIds(widgets: ReviewRecord[]): number[] {
  const ids = new Set<number>();
  for (const widget of widgets) {
    if (widget.toolName !== 'send_outreach_messages') continue;
    const values = widget.submittedValues || widget.formValues || {};
    if (!Array.isArray(values.lead_ids)) continue;
    for (const value of values.lead_ids) {
      const id = Number(value);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  }
  return [...ids];
}

/** A local review ledger, not a provider-delivery or publication claim. */
export function buildCampaignActionStatus(
  widgets: ReviewRecord[],
  storedOutreach?: OutreachDeliveryReport | StoredOutreachCount[],
  pendingExecutionApproval?: PendingExecutionApprovalLedger,
  icp?: { id?: number; revision?: number | null; approved?: boolean | null; approvedRevision?: number | null } | null,
): string {
  const open = widgets.filter(widget => widget.status === 'active' || widget.status === 'draft');
  const running = widgets.filter(widget => widget.status === 'running' || widget.status === 'queued');
  const recent = widgets.filter(widget => ['succeeded', 'failed', 'cancelled'].includes(widget.status)).slice(0, 8);
  const describe = (widget: ReviewRecord): string => {
    const values = widget.submittedValues || widget.formValues || {};
    const channel = typeof values.channel === 'string' ? `, channel ${values.channel.replace(/[^a-z0-9_-]/gi, '').slice(0, 40)}` : '';
    const owner = widget.agentType ? `, owner ${widget.agentType.replace(/[^a-z0-9_]/gi, '').slice(0, 40)}` : '';
    const error = widget.status === 'failed' && widget.executionError ? `; error: ${toUserFacingError(widget.executionError).replace(/[\r\n]+/g, ' ').slice(0, 180)}` : '';
    return `review #${widget.id}: ${widget.toolName.replace(/[^a-z0-9_]/gi, '').slice(0, 80)}${channel}${owner} — ${widget.status}${error}`;
  };
  const report = storedOutreach && !Array.isArray(storedOutreach) ? storedOutreach : undefined;
  const reviewIds = new Set(widgets.filter(widget => widget.toolName === 'send_outreach_messages').map(widget => widget.id));
  const deliveries = report?.reviews.filter(review => reviewIds.has(review.reviewId)) || [];
  const missingReviews = [...reviewIds].filter(id => !deliveries.some(review => review.reviewId === id));
  const deliveryText = deliveries.length ? deliveries.map(review => {
    const counts = Object.entries(review.counts).map(([state, count]) => `${state}: ${count}`).join('; ');
    const recipients = review.recipients.map(row => `lead #${row.leadId}: ${row.state} (${row.evidence})`).join('; ');
    return `Outreach review #${review.reviewId} (${review.channel.replace(/[^a-z0-9_-]/gi, '') || 'unknown channel'}): ${review.unavailableReason || counts}.${recipients ? `\n${recipients}` : ''}`;
  }).concat(missingReviews.map(id => `Outreach review #${id}: delivery counts unavailable; no correlated status was returned.`)).join('\n')
    : `Outreach delivery counts unavailable: ${report?.unavailableReason || 'no exact review/job/provider correlations were supplied'}.`;
  return [
    icp?.id ? `ICP #${icp.id}, revision ${icp.revision || 'unknown'}: ${isCurrentIcpRevisionApproved(icp) ? 'approved for this exact revision' : 'awaiting ICP approval'}. ICP approval is separate from execution reviews.` : 'No current ICP was available in the owned campaign state.',
    describePendingExecutionApproval(pendingExecutionApproval),
    open.length ? `Waiting for your review (${open.length}):\n${open.map(describe).join('\n')}` : 'No active or saved-draft review cards are recorded in this conversation.',
    running.length ? `In progress (${running.length}):\n${running.map(describe).join('\n')}` : 'No review execution is currently recorded as running or queued.',
    recent.length ? `Recent terminal review receipts:\n${recent.map(describe).join('\n')}` : 'No terminal review receipts are recorded in this conversation.',
    deliveryText,
    'These are last-persisted states, not live provider checks. Recipient counts are exclusive within each review; delivered recipients are not counted again as sent. Queued means queue acknowledgement or an in-progress job, not provider acceptance. Sent requires a provider receipt; delivered requires a correlated delivery record. Unavailable is not zero or proof that nothing was sent. An active or draft card has not run. A succeeded review does not by itself prove provider delivery, publication, ad activation, or spend.',
  ].join('\n\n');
}
