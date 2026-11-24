"use client";

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AssistantPanelProps } from './AssistantConfiguration';
import { AssistantResourceDrawer } from './AssistantResourceDrawer';

export function AssistantToolSelection({ draft, catalog, onChange }: AssistantPanelProps) {
  const [open, setOpen] = useState(false);
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4"><p className="text-sm text-muted-foreground">{draft.tools.mode === 'unconfigured' ? 'Choose permitted tools or leave this category unused.' : `${draft.tools.names.length} ${draft.tools.names.length === 1 ? 'tool' : 'tools'} selected`}</p><Button type="button" variant="outline" onClick={() => setOpen(true)}><Plus aria-hidden className="h-4 w-4" />Choose tools</Button></div>
    <ul className="divide-y rounded-xl border empty:hidden">{draft.tools.names.map(name => {
      const tool = catalog.tools.find(item => item.name === name);
      return <li key={name} className="space-y-2 p-4"><div className="flex items-start justify-between gap-3"><p className="text-sm font-medium">{tool?.label || name}{!tool && <span className="block text-xs text-destructive">Unavailable. Remove this tool before publishing.</span>}</p><Button type="button" variant="ghost" aria-label={`Remove ${tool?.label || name}`} onClick={() => onChange({ ...draft, tools: { ...draft.tools, mode: draft.tools.names.length === 1 ? 'none' : 'selected', names: draft.tools.names.filter(item => item !== name), approvalRequired: draft.tools.approvalRequired.filter(item => item !== name) } })}><X aria-hidden className="h-4 w-4" /></Button></div><label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={tool?.approvalRequired || draft.tools.approvalRequired.includes(name)} disabled={tool?.approvalRequired} onChange={event => onChange({ ...draft, tools: { ...draft.tools, approvalRequired: event.target.checked ? [...new Set([...draft.tools.approvalRequired, name])] : draft.tools.approvalRequired.filter(item => item !== name) } })} />{tool?.approvalRequired ? 'Approval mandatory' : 'Require approval'}</label></li>;
    })}</ul>
    {draft.tools.mode !== 'none' && <Button type="button" variant="ghost" onClick={() => onChange({ ...draft, tools: { mode: 'none', names: [], approvalRequired: [] } })}>Use none</Button>}
    {open && <AssistantResourceDrawer open onOpenChange={setOpen} title="Permitted tools" category="tools" agentType={draft.agentType} selectedIds={draft.tools.names} onApply={(names, items) => {
      const mandatory = names.filter(name => catalog.tools.some(tool => tool.name === name && tool.approvalRequired) || items.some(item => item.id === name && item.approvalRequired));
      onChange({ ...draft, tools: { mode: names.length ? 'selected' : 'none', names, approvalRequired: [...new Set([...draft.tools.approvalRequired.filter(name => names.includes(name)), ...mandatory])] } });
    }} />}
  </div>;
}
