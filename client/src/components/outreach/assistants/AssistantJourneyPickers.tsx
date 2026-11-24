"use client";

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { resourceSupportsChannel, type AssistantChannel, type AssistantResource } from '@/lib/outreach-assistants';
import type { AssistantPanelProps } from './AssistantConfiguration';
import { AssistantResourceDrawer } from './AssistantResourceDrawer';

export function AssistantPlaybookPicker({ draft, catalog, onChange }: AssistantPanelProps) {
  const [open, setOpen] = useState(false);
  return <><Button type="button" variant="outline" disabled={!draft.bindings.length} onClick={() => setOpen(true)}><Plus aria-hidden className="h-4 w-4" />Add playbooks</Button>{open && <AssistantResourceDrawer open onOpenChange={setOpen} title="Published playbooks" category="playbooks" selectedIds={[]} required agentType={draft.agentType} bindings={draft.bindings} channels={draft.bindings.map(binding => binding.channel)} onApply={(ids, items) => {
    const playbooks = ids.flatMap(id => {
      const found = items.find(item => item.id === id);
      const playbook: AssistantResource | undefined = found ? { ...found, id: Number(found.id) } : catalog.playbooks.find(item => String(item.id) === id);
      return playbook ? [playbook] : [];
    });
    const added = playbookAssignments(playbooks, draft);
    if (!added.length) return;
    onChange({ ...draft, playbooks: { mode: 'selected', assignments: [...draft.playbooks.assignments, ...added] } });
  }} />}</>;
}

type PlaybookAssignment = AssistantPanelProps['draft']['playbooks']['assignments'][number];

/** One row per connected account and published default intent, so added
 * playbooks keep their own routing instead of all tying at any intent. */
export function playbookAssignments(playbooks: AssistantResource[], draft: AssistantPanelProps['draft']): PlaybookAssignment[] {
  const existing = new Set(draft.playbooks.assignments.map(a => `${a.playbookId}:${a.channel}:${a.surface}:${a.intent ?? ''}`));
  return playbooks.flatMap(playbook => {
    const routes = playbook.defaultAssignments?.length ? playbook.defaultAssignments : [{ intent: playbook.intent || null, priority: 100 }];
    return draft.bindings.filter(binding => resourceSupportsChannel(playbook, binding.channel, binding.surface))
      .filter((binding, index, all) => all.findIndex(other => other.channel === binding.channel && other.surface === binding.surface) === index)
      .flatMap(binding => routes.map(route => ({ playbookId: playbook.id, channel: binding.channel, surface: binding.surface, intent: route.intent, priority: route.priority })));
  }).filter(a => !existing.has(`${a.playbookId}:${a.channel}:${a.surface}:${a.intent ?? ''}`));
}

export function AssistantFollowUpTemplatePicker({ channel, template, onChange, label }: {
  channel: AssistantChannel; template?: AssistantResource; label: string; onChange: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return <div className="space-y-2"><p className="text-sm font-medium">{label}</p><Button type="button" variant="outline" className="h-auto min-h-11 w-full whitespace-normal text-left" aria-label={label} onClick={() => setOpen(true)}>{template?.name || 'Choose approved template'}</Button>{open && <AssistantResourceDrawer open onOpenChange={setOpen} title="Approved templates" category="templates" selectedIds={template ? [String(template.id)] : []} multiple={false} required channels={[channel]} onApply={ids => onChange(Number(ids[0]))} />}</div>;
}
