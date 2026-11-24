import type { ToolOutcome, ToolOutcomeStatus } from '../BaseOutreachAgent.js';
import type { SubAgentResult } from '../subagents/SubAgentBase.js';
import { asRecordOrNull as asRecord } from '../../../../shared/records.js';

const SUPPRESSED_CODES = new Set([
  'dry_run_suppressed',
  'duplicate_execution',
  'execution_in_progress',
  'tool_not_enabled',
]);

const RECONCILIATION_CODES = new Set([
  'execution_requires_reconciliation',
  'approval_consumed',
  'high_risk_effect_commit_disabled',
]);

function outcomeStatus(payload: Record<string, unknown> | null): ToolOutcomeStatus {
  const code = typeof payload?.code === 'string' ? payload.code : undefined;
  if (code === 'approval_required' || code === 'approval_execution_pending') return 'pending_approval';
  if (code && RECONCILIATION_CODES.has(code)) return 'requires_reconciliation';
  if (code && SUPPRESSED_CODES.has(code)) return 'suppressed';
  if (payload?.success === false || payload?.error || payload?.booked === false) return 'failed';
  // A missing error is not proof that a read or write completed. Every tool
  // adapter must affirm success in its typed payload.
  return payload?.success === true ? 'success' : 'failed';
}

function confirmedSideEffect(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  return payload.confirmedSideEffect === true
    || payload.booked === true
    || payload.ticket_created === true
    || payload.updated === true
    || payload.scheduled === true
    || payload.enrolled === true;
}

/** Shared normalization for every specialist's tool-calling loop. */
export class SupportAgentRuntime {
  recordToolOutcome(
    name: string,
    args: Record<string, unknown>,
    subAgentResult: SubAgentResult,
  ): ToolOutcome {
    const rawResult = subAgentResult.toolResults?.find((item) => item.name === name)?.result
      ?? subAgentResult.toolResults?.[0]?.result
      ?? { success: false, code: 'missing_tool_result' };
    const payload = asRecord(rawResult);
    const status = outcomeStatus(payload);
    const code = typeof payload?.code === 'string'
      ? payload.code
      : typeof payload?.error === 'string'
        ? 'tool_error'
        : status === 'failed'
          ? 'missing_success_confirmation'
          : undefined;

    return {
      name,
      args,
      result: rawResult,
      status,
      success: status === 'success',
      code,
      confirmedSideEffect: status === 'success' && confirmedSideEffect(payload),
      reconciliationStatus: status === 'requires_reconciliation' ? 'pending' : 'not_required',
    };
  }
}

export const supportAgentRuntime = new SupportAgentRuntime();
