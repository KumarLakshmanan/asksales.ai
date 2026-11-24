import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db.js';
import { conversationToolApprovalsTable } from '../conversationToolApprovals/schema.js';
import { readMessageApprovalReference } from '../../mastra/approvalActions.js';
import type { ActionButton } from '../../mastra/state.js';
import { asRecord as record } from '../../../shared/records.js';

type MessageWithMetadata = { metadata: unknown };

/** Project exact durable decisions onto every review surface, without guessing
 * from prose, a later run, or the most recent approval in the conversation. */
export async function projectMessageApprovalDecisions<T extends MessageWithMetadata>(userId: number, threadId: number, messages: T[]): Promise<T[]> {
  const references = messages.flatMap(message => {
    const metadata = record(message.metadata);
    return (Array.isArray(metadata.actionButtons) ? metadata.actionButtons : []).flatMap(value => {
      const button = record(value);
      if (typeof button.id !== 'string' || typeof button.action !== 'string') return [];
      const reference = readMessageApprovalReference(metadata, button as unknown as ActionButton);
      return reference ? [{ message, button, reference }] : [];
    });
  });
  if (!references.length) return messages;
  const receipts: Array<{ requestId: string; toolName: string; decision: string }> = await db.select({
    requestId: conversationToolApprovalsTable.requestId,
    toolName: conversationToolApprovalsTable.toolName,
    decision: conversationToolApprovalsTable.decision,
  }).from(conversationToolApprovalsTable).where(and(
    eq(conversationToolApprovalsTable.userId, userId),
    eq(conversationToolApprovalsTable.threadId, threadId),
    inArray(conversationToolApprovalsTable.requestId, [...new Set(references.map(item => item.reference.requestId))]),
  ));
  return messages.map(message => {
    const matching = references.filter(item => item.message === message);
    for (const item of matching) {
      const receipt = receipts.find(receipt => receipt.requestId === item.reference.requestId && receipt.toolName === item.reference.toolName);
      if (!receipt || !['approve', 'reject'].includes(receipt.decision)) continue;
      const action = receipt.decision === 'reject' ? 'reject_tool' : item.button.action === 'LEAD_AGENT_APPROVE' ? 'LEAD_AGENT_APPROVE' : 'approve_tool';
      const chosen = matching.find(candidate => candidate.reference.requestId === receipt.requestId
        && candidate.reference.toolName === receipt.toolName && candidate.button.action === action);
      return { ...message, metadata: { ...record(message.metadata), actionResolution: chosen ? {
        status: 'selected', selectedButtonId: chosen.button.id, action,
        outcome: receipt.decision === 'approve' ? 'approved' : 'rejected',
      } : { status: 'superseded' } } };
    }
    return message;
  });
}
