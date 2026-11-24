"use client";

import { ArrowRight, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { draftResourceSummary, type AssistantCatalog, type AssistantDraft } from '@/lib/outreach-assistants';
import { assistantSetupSections } from './assistantEditorUtils';

/** Explicitly disable only undecided categories; keep existing allowlists intact. */
export function leaveUnconfiguredResourcesUnused(draft: AssistantDraft): AssistantDraft {
  return {
    ...draft,
    knowledge: draft.knowledge.mode === 'unconfigured' ? { mode: 'none', ids: [] } : draft.knowledge,
    playbooks: draft.playbooks.mode === 'unconfigured' ? { mode: 'none', assignments: [] } : draft.playbooks,
    followUps: draft.followUps.mode === 'unconfigured' ? { mode: 'none', sequences: [] } : draft.followUps,
    documents: draft.documents.mode === 'unconfigured' ? { mode: 'none', ids: [] } : draft.documents,
    galleries: draft.galleries.mode === 'unconfigured' ? { mode: 'none', ids: [] } : draft.galleries,
    // Selected knowledge needs the read-only knowledge tool to be used at all.
    tools: draft.tools.mode !== 'unconfigured' ? draft.tools
      : draft.knowledge.mode === 'selected' && draft.knowledge.ids.length
        ? { mode: 'selected', names: ['answer_from_knowledge_base'], approvalRequired: [] }
        : { mode: 'none', names: [], approvalRequired: [] },
  };
}

export function AssistantSetupGuide({ draft, catalog, disabled, onChange, onNavigate, onTest, history }: {
  draft: AssistantDraft; catalog: AssistantCatalog; disabled: boolean; onChange: (draft: AssistantDraft) => void;
  onNavigate: (tab: string) => void; onTest: () => void; history: ReactNode;
}) {
  const setup = assistantSetupSections(draft, catalog);
  const ready = setup.filter(section => !section.issues.length).length;
  const next = setup.find(section => section.issues.length);
  const undecided = draftResourceSummary(draft).filter(resource => resource.mode === 'unconfigured');
  return <section aria-label="Assistant setup checklist" className="ak-setup-guide space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">Setup checklist · {ready} of {setup.length} ready</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{next ? next.issues[0] : 'Configuration complete. Test the saved draft, then review account and delivery checks.'}</p></div><div className="flex flex-wrap gap-2">{history}<Button type="button" variant="outline" className="justify-between" onClick={() => next ? onNavigate(next.tab) : onTest()}>{next ? `Continue setup: ${next.label}` : 'Test assistant'}<ArrowRight aria-hidden className="h-4 w-4" /></Button></div></div>
    <div role="progressbar" aria-label="Assistant setup" aria-valuemin={0} aria-valuemax={setup.length} aria-valuenow={ready} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${ready / setup.length * 100}%` }} /></div>
    {undecided.length > 0 && <details className="rounded-lg border border-dashed px-3"><summary className="min-h-11 cursor-pointer py-3 text-sm">Leave optional resources unused</summary><div className="space-y-3 pb-3"><p className="text-xs leading-6 text-muted-foreground">Set these undecided categories to None: {undecided.map(resource => resource.label).join(', ')}. Your existing selections stay assigned. You can add resources later.</p><Button type="button" variant="outline" disabled={disabled} onClick={() => onChange(leaveUnconfiguredResourcesUnused(draft))}><CheckCircle2 aria-hidden className="h-4 w-4" />Leave these unused</Button></div></details>}
  </section>;
}
