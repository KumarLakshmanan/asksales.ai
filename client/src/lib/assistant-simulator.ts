import type { AssistantTestScenario } from '../../../shared/assistantOperations';

export interface SelectedPreviewConfiguration {
  assistantId: string;
  revision: 'draft' | 'published';
  version: number | null;
}
export interface AssistantTrace {
  reply?: string; replyText?: string; outcome?: string; error?: string | null;
  resolvedAssistant?: { assistantId?: string; revision?: string | number; replyModel?: unknown; knowledgeSources?: unknown; playbook?: unknown; [key: string]: unknown };
  model?: { provider?: string; model?: string } | null;
  stages?: { stage: string; status: string; durationMs: number | null }[];
  playbook?: unknown; tools?: unknown; privacyOutcome?: unknown; knowledgeSources?: unknown; pii?: unknown;
  sideEffectsSuppressed?: boolean; conversationId?: number; previewSessionToken?: string;
  /** Client request snapshot, not evidence of the server's resolved revision. */
  selectedConfiguration?: SelectedPreviewConfiguration;
}
export function selectedPreviewConfigurationLabel(selection: SelectedPreviewConfiguration): string {
  const version = Number.isSafeInteger(selection.version) && Number(selection.version) > 0 ? selection.version : null;
  return selection.revision === 'draft' ? `Saved draft${version ? ` v${version}` : ''}` : `Published${version ? ` r${version}` : ''}`;
}
const simulatedOutcomeLabels: Readonly<Record<string, string>> = Object.freeze({
  auto_sent: 'Reply generated', drafted: 'Draft proposed', human_handoff: 'Human handoff proposed',
  pending_approval: 'Approval proposed', ready_for_channel_delivery: 'Reply prepared',
  no_op: 'No reply proposed', error: 'Test failed', failed: 'Test failed', blocked: 'Test blocked',
});
export function simulatedOutcomeLabel(outcome?: string): string {
  if (!outcome) return 'No outcome supplied';
  return typeof simulatedOutcomeLabels[outcome] === 'string' ? simulatedOutcomeLabels[outcome] : outcome.replaceAll('_', ' ');
}
export function resolvedPreviewConfigurationLabel(trace: AssistantTrace): string {
  const revision = trace.resolvedAssistant?.revision;
  if (revision === 0 || revision === '0') return 'Saved draft';
  if ((typeof revision === 'number' || typeof revision === 'string') && /^\d+$/.test(String(revision))
    && Number.isSafeInteger(Number(revision)) && Number(revision) > 0) return `Published r${revision}`;
  return 'Not resolved';
}
export interface PreviewSession {
  conversationId: number | null; previewSessionToken: string | null;
  history: { role: 'user' | 'assistant'; content: string }[];
}
export const emptyPreviewSession = (): PreviewSession => ({ conversationId: null, previewSessionToken: null, history: [] });
export function requireIsolatedPreview(trace: AssistantTrace): void {
  if (trace.sideEffectsSuppressed !== true) throw new Error('The simulator did not confirm side-effect suppression. Do not use this result to verify live actions.');
  if (!Number.isSafeInteger(trace.conversationId) || Number(trace.conversationId) >= 0) throw new Error('The simulator did not return a valid isolated preview conversation. Start a new test and retry.');
  if (typeof trace.previewSessionToken !== 'string' || !trace.previewSessionToken) throw new Error('The simulator did not confirm ownership of the preview session. Start a new test and retry.');
}
export function advancePreviewSession(session: PreviewSession, message: string, trace: AssistantTrace): PreviewSession {
  requireIsolatedPreview(trace);
  const privacy = trace.privacyOutcome as { redactedInput?: unknown } | undefined;
  const safeMessage = typeof privacy?.redactedInput === 'string' ? privacy.redactedInput : message;
  const reply = trace.reply || trace.replyText;
  return { conversationId: trace.conversationId!, previewSessionToken: trace.previewSessionToken!, history: [...session.history,
    { role: 'user' as const, content: safeMessage.slice(0, 8000) },
    ...(reply ? [{ role: 'assistant' as const, content: reply.slice(0, 8000) }] : []),
  ].slice(-20) };
}
export function previewRequest(message: string, channel: string, revision: string, session: PreviewSession) {
  return { message, channel, revision, conversationHistory: session.history,
    ...(session.conversationId !== null ? { conversationId: session.conversationId, previewSessionToken: session.previewSessionToken } : {}),
  };
}
export interface ScenarioAssertion { label: string; passed: boolean; actual: string }
export function scenarioAssertions(expected: AssistantTestScenario['expected'], trace: AssistantTrace): ScenarioAssertion[] {
  const reply = trace.reply || trace.replyText || '';
  const results = expected.replyIncludes.map(text => ({ label: `Final reply includes “${text}”`, passed: reply.toLocaleLowerCase().includes(text.toLocaleLowerCase()), actual: reply || 'No reply' }));
  if (expected.outcome) results.push({ label: `Simulated final outcome is ${expected.outcome}`, passed: trace.outcome === expected.outcome, actual: trace.outcome || 'Not recorded' });
  if (expected.playbookId !== null) {
    const playbook = trace.playbook as { playbookId?: number; id?: number } | undefined;
    const actual = playbook?.playbookId ?? playbook?.id;
    results.push({ label: `Final playbook is ${expected.playbookId}`, passed: actual === expected.playbookId, actual: actual == null ? 'No playbook' : String(actual) });
  }
  return results;
}
export function traceResourceLabels(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap(resource => {
    if (typeof resource === 'string') return [resource];
    if (!resource || typeof resource !== 'object') return [];
    const record = resource as Record<string, unknown>;
    const label = record.title ?? record.name ?? record.toolName ?? record.tool ?? record.sourceName ?? record.documentTitle ?? record.sourceId ?? record.documentId ?? record.id;
    return typeof label === 'string' || typeof label === 'number' ? [String(label)] : [];
  });
}
