import { randomUUID } from 'node:crypto';
import type { AgentState } from './state.js';
import type { RouterOutput } from './routerSchema.js';

export interface ConversationClarification {
  id: string;
  status: 'awaiting_input';
  question: string;
  requiredField: string;
  owner: string;
  requestedAt: string;
  sourceMessageId: number;
  resumeTarget: { agent: string; runId?: string; actionId?: string };
}
export function createConversationClarification(state: Partial<AgentState>, intent: RouterOutput, sourceMessageId: number): ConversationClarification {
  const owner = state.currentAgent || 'orchestrator';
  return { id: randomUUID(), status: 'awaiting_input', question: intent.response,
    requiredField: intent.clarification?.requiredField || 'next_action', owner,
    requestedAt: new Date().toISOString(), sourceMessageId,
    resumeTarget: { agent: owner, runId: state.runContext?.runId, actionId: state.runContext?.actionId } };
}
export function readPendingClarification(value: unknown): ConversationClarification | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as ConversationClarification;
  return candidate.status === 'awaiting_input' && typeof candidate.id === 'string'
    && typeof candidate.question === 'string' && typeof candidate.resumeTarget?.agent === 'string' ? candidate : undefined;
}
export function answersPendingClarification(pending: ConversationClarification, intent: RouterOutput): boolean {
  return !intent.needsClarification && intent.clarification?.answersQuestionId === pending.id;
}
