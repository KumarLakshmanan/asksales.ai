"use client";

import { CheckCircle2, CircleAlert, Clock3 } from 'lucide-react';
import { Callout } from '@/components/ui/callout';
import type { AssistantTrace, ScenarioAssertion } from '@/lib/assistant-simulator';
import { resolvedPreviewConfigurationLabel, selectedPreviewConfigurationLabel, simulatedOutcomeLabel, traceResourceLabels } from '@/lib/assistant-simulator';

const stageLabels: Record<string, string> = {
  intent_risk_classifier: 'Understand message', intent_classifier: 'Understand message',
  agent_configuration: 'Select assistant', conversation_context: 'Read conversation',
  active_playbook_selection: 'Select playbook', playbook: 'Run playbook',
  handoff_policy: 'Check handoff policy', pii_redaction: 'Protect personal data',
  post_processing: 'Check final reply', reply_generation: 'Generate reply',
};
const labelForStage = (stage: string) => stageLabels[stage] || stage.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/Stage$/, '').trim();
export function AssistantTraceView({ trace, assertions = [] }: { trace: AssistantTrace; assertions?: ScenarioAssertion[] }) {
  const sources = traceResourceLabels(trace.knowledgeSources ?? trace.resolvedAssistant?.knowledgeSources);
  const model = trace.model;
  const requestedModel = trace.resolvedAssistant?.replyModel as { provider?: string; model?: string } | undefined;
  const playbook = trace.playbook as { playbookId?: number; nodeId?: string; nodeType?: string } | undefined;
  const privacy = (trace.privacyOutcome ?? trace.pii) as { mandatory?: boolean; piiTypes?: string[] } | undefined;
  const tools = traceResourceLabels(trace.tools);
  return <div className="space-y-5 border-l-2 border-primary/50 pl-4">
    <p className="text-xs font-medium text-muted-foreground">Simulated outcome · {simulatedOutcomeLabel(trace.outcome)}{trace.sideEffectsSuppressed === true ? ' · No side effects' : ''}</p>
    <p className="whitespace-pre-wrap text-sm leading-6">{trace.reply || trace.replyText || 'No customer-facing reply was produced.'}</p>
    {trace.error && <Callout tone="warning" size="sm">Test stopped: {trace.error}</Callout>}
    <dl className="grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
      <div><dt className="text-muted-foreground">Resolved assistant</dt><dd className="mt-1 break-all font-mono">{trace.resolvedAssistant?.assistantId || 'Not resolved'}</dd></div>
      {trace.selectedConfiguration && <div><dt className="text-muted-foreground">Selected configuration</dt><dd className="mt-1">{selectedPreviewConfigurationLabel(trace.selectedConfiguration)}</dd></div>}
      <div><dt className="text-muted-foreground">Resolved configuration</dt><dd className="mt-1">{resolvedPreviewConfigurationLabel(trace)}</dd></div>
      <div><dt className="text-muted-foreground">Reply model</dt><dd className="mt-1 break-words">{model?.provider && model?.model ? `${model.provider} / ${model.model}` : 'Not recorded'}</dd></div>
      {requestedModel?.provider && requestedModel?.model && <div><dt className="text-muted-foreground">Requested primary model</dt><dd className="mt-1 break-words">{requestedModel.provider} / {requestedModel.model}</dd></div>}
      <div><dt className="text-muted-foreground">Knowledge used</dt><dd className="mt-1">{sources.length ? sources.join(' · ') : 'No named sources recorded'}</dd></div>
      <div><dt className="text-muted-foreground">Playbook</dt><dd className="mt-1">{playbook?.playbookId ? `Playbook ${playbook.playbookId}${playbook.nodeId ? ` · ${playbook.nodeId}` : ''}` : 'No playbook recorded'}</dd></div>
      <div><dt className="text-muted-foreground">Privacy</dt><dd className="mt-1">{privacy?.mandatory ? 'Mandatory protection applied' : 'No privacy outcome recorded'}{privacy?.piiTypes?.length ? ` · ${privacy.piiTypes.join(', ')} redacted` : ''}</dd></div>
    </dl>
    {trace.stages?.length ? <ol aria-label="Test execution steps" className="divide-y rounded-xl border">{trace.stages.map((step, index) => <li key={`${step.stage}-${index}`} className="flex items-start justify-between gap-3 px-4 py-3 text-sm"><div className="flex items-start gap-2">{['failed', 'error', 'blocked', 'halted'].includes(step.status) ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden /> : ['skipped', 'pending'].includes(step.status) ? <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />}<div><p className="font-medium">{labelForStage(step.stage)}</p><p className="mt-0.5 text-xs text-muted-foreground">{step.status}</p></div></div><span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{step.durationMs == null ? 'Time not recorded' : `${Math.round(step.durationMs)} ms`}</span></li>)}</ol> : <p className="text-xs text-muted-foreground">This run did not record individual execution timings.</p>}
    {tools.length > 0 && <p className="text-sm"><span className="text-muted-foreground">Tools considered · </span>{tools.join(' · ')}<span className="mt-1 block text-xs text-muted-foreground">Preview only. No delivery or proposal action was performed.</span></p>}
    {assertions.length > 0 && <ul aria-label="Scenario checks" className="space-y-2">{assertions.map(check => <li key={check.label} className="text-sm"><span className={check.passed ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>{check.passed ? 'Passed' : 'Failed'} · {check.label}</span>{!check.passed && <p className="mt-1 text-xs text-muted-foreground">Actual: {check.actual}</p>}</li>)}</ul>}
    <details><summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium text-muted-foreground">Advanced trace details</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-4 font-mono text-xs leading-5">{JSON.stringify({ outcome: trace.outcome, conversationId: trace.conversationId, assistant: trace.resolvedAssistant, model: trace.model, knowledgeSources: trace.knowledgeSources, playbook: trace.playbook, tools: trace.tools, privacy: trace.privacyOutcome ?? trace.pii }, null, 2)}</pre></details>
  </div>;
}
