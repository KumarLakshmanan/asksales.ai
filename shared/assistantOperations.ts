import type { AssistantBindingInput, AssistantDraft, AssistantReadiness, AssistantState } from './outreachAssistants.js';

export interface AssistantPage<T> { items: T[]; nextCursor: string | null }
export interface AssistantAssignmentHealth extends AssistantBindingInput {
  label: string; connected: boolean; assistantId: string | null; assistantName: string | null;
  revision: number | null; state: AssistantState | 'unassigned'; runtimeEnabled: boolean;
  checks: AssistantReadiness['checks'];
}
export interface AssistantRevisionRecord {
  revision: number; publishedAt: string; configuration: AssistantDraft; current: boolean;
}
export interface AssistantActivity {
  key: string; id: number; kind: 'message' | 'schedule' | 'delivery' | 'playbook' | 'approval' | 'proposal' | 'session';
  conversationId: number; channel: string; accountId: string | null; status: string; createdAt: string;
  scheduledAt: string | null; content: string | null; reason: string | null; providerMessageId: string | null;
  assistantId: string | null; assistantRevision: number | null; step: number | null; resourceId?: number | null;
}
export interface AssistantKnowledgeGap {
  key: string; assistantId: string; assistantName: string; intent: string; count: number;
  latestAt: string; conversationIds: number[]; reason: string; review: 'open' | 'reviewed'; note: string | null;
  conversations?: { id: number; channel: string }[];
  dailyCounts?: { day: string; count: number }[];
  questionSamples?: string[];
}
export interface AssistantOperationalReport {
  days: number; assignments: AssistantAssignmentHealth[];
  metrics: { assistantId: string; name: string; channel: string; replies: number; failures: number; handoffs: number;
    accountId?: string | null; day?: string;
    averageDurationMs: number | null; averageConfidence: number | null }[];
  knowledgeGaps: AssistantKnowledgeGap[];
  usage: { assistantId: string; revision: number; provider: string; model: string; calls: number; totalTokens: number;
    cost: number | null; currency: string | null; source?: 'model_usage' | 'reply_audit'; costRecordedCalls?: number }[];
}
export interface AssistantTestScenario {
  id: string; name: string; channel: 'whatsapp' | 'instagram' | 'facebook' | 'email' | 'web';
  messages: string[]; expected: { replyIncludes: string[]; outcome: string | null; playbookId: number | null };
  updatedAt: string;
}
export interface AssistantConversationContext {
  assistantId: string | null; name: string | null; revision: number | null; channel: string; accountId: string | null;
  mode: string; sessionStatus: string;
  playbook: { id: number; name: string; nodeId: string | null; status: string } | null;
  followUp: { status: string; scheduledAt: string | null } | null;
}
