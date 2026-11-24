import { isDeepStrictEqual } from 'node:util';
import type { LeadInputRecord } from '../leadInputs/schema.js';

export type ReviewedLeadInput = Omit<LeadInputRecord, 'createdAt'>;

export function snapshotLeadInput(row: LeadInputRecord | ReviewedLeadInput): ReviewedLeadInput {
  return {
    id: row.id, userId: row.userId, businessProfileId: row.businessProfileId ?? null, threadId: row.threadId, messageId: row.messageId ?? null,
    platform: row.platform, inputs: structuredClone(row.inputs), schema: structuredClone(row.schema ?? null),
    actorId: row.actorId ?? null, actorName: row.actorName ?? null, workflowId: row.workflowId ?? null,
    category: row.category ?? null, recommendedSubWorkflows: structuredClone(row.recommendedSubWorkflows ?? null),
  };
}

export function readLeadInputSnapshot(input: {
  inputIds: number[]; userId: number; threadId: number; snapshot: Record<string, unknown>;
}): ReviewedLeadInput[] {
  const rows = input.snapshot.inputs;
  if (!Array.isArray(rows) || rows.length !== input.inputIds.length || rows.length === 0) {
    throw new Error('This lead input review has no immutable snapshot. Generate and review the inputs again.');
  }
  return input.inputIds.map(id => {
    const row = rows.find(candidate => candidate && typeof candidate === 'object' && candidate.id === id);
    if (!row || row.userId !== input.userId || row.threadId !== input.threadId
      || typeof row.platform !== 'string' || !row.inputs || typeof row.inputs !== 'object' || Array.isArray(row.inputs)) {
      throw new Error('The reviewed lead inputs are invalid for this conversation. Review the inputs again.');
    }
    return snapshotLeadInput(row);
  });
}

export function assertLeadInputsUnchanged(reviewed: ReviewedLeadInput[], current: LeadInputRecord[]): void {
  if (reviewed.length !== current.length || reviewed.some(row => {
    const currentRow = current.find(candidate => candidate.id === row.id);
    return !currentRow || !isDeepStrictEqual(row, snapshotLeadInput(currentRow));
  })) {
    throw new Error('The lead inputs changed after this review was created. Generate a fresh review before approving.');
  }
}
