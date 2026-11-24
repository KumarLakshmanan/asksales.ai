import type { ActionButton, PendingApproval } from './state.js';

export interface ApprovalActionReference { requestId: string; toolName: string }

/** Recover legacy identities from their own durable message, not thread state. */
export function readMessageApprovalReference(metadata: Record<string, unknown>, button: ActionButton): ApprovalActionReference | undefined {
  if (!['approve_tool', 'reject_tool', 'LEAD_AGENT_APPROVE'].includes(button.action)) return undefined;
  const pending = metadata.pendingApproval && typeof metadata.pendingApproval === 'object'
    ? metadata.pendingApproval as Partial<PendingApproval>
    : undefined;
  const requestId = button.data?.requestId || pending?.executionId || pending?.toolCallId;
  const toolName = button.data?.toolName || pending?.toolName;
  return typeof requestId === 'string' && requestId.length > 0 && typeof toolName === 'string' && toolName.length > 0
    ? { requestId, toolName }
    : undefined;
}

/** Bind every approval surface to the same immutable request, never "latest". */
export function bindApprovalActions(buttons: ActionButton[], pending?: PendingApproval | null): ActionButton[] {
  return buttons.flatMap(button => {
    if (button.action !== 'approve_tool' && button.action !== 'reject_tool') return [button];
    const requestId = pending?.executionId || pending?.toolCallId;
    if (!requestId || !pending?.toolName) return [];
    return [{
      ...button,
      data: { ...button.data, requestId, toolName: pending.toolName },
    }];
  });
}
