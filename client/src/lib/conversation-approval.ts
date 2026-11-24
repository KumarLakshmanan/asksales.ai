import type { ApprovalData } from '@/components/ToolApprovalDialog';
import { isRecord } from '../../../shared/records';

export function readDurableApproval(metadata: unknown): ApprovalData | null {
  if (!isRecord(metadata) || metadata.requiresApproval !== true || !isRecord(metadata.pendingApproval)) return null;
  const pending = metadata.pendingApproval;
  const requestId = pending.executionId || pending.toolCallId;
  if (typeof requestId !== 'string' || !requestId || typeof pending.toolName !== 'string' || !pending.toolName) return null;
  return {
    requestId,
    toolName: pending.toolName,
    parameters: isRecord(pending.args) ? pending.args : undefined,
    toolDescription: typeof pending.message === 'string' ? pending.message : undefined,
  };
}

/** Reviewed lead inputs already have inline and result-tab approval controls. */
export function shouldAutoOpenApproval(approval: Pick<ApprovalData, 'toolName' | 'parameters'>): boolean {
  return !(approval.toolName === 'execute_lead_workflow' && typeof approval.parameters?.leadInputSetId === 'string');
}
