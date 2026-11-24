"use client";

import { useState } from 'react';
import { FileText, Images, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AssistantResource, AssistantSelection } from '@/lib/outreach-assistants';
import { AssistantResourceDrawer } from './AssistantResourceDrawer';

export function AssistantResourceSelection({ label, category, resources, unavailableResources = [], value, onChange }: {
  label: string; category: 'knowledge' | 'documents' | 'galleries'; resources: AssistantResource[]; unavailableResources?: AssistantResource[];
  value: AssistantSelection; onChange: (value: AssistantSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const Icon = category === 'galleries' ? Images : FileText;
  return <div className="space-y-4">
    <div className="ak-resource-summary"><div className="flex items-center gap-3"><Icon aria-hidden className="h-5 w-5 text-primary" /><div><p className="text-sm font-medium">{value.mode === 'selected' ? `${value.ids.length} selected` : value.mode === 'none' ? 'None selected' : 'Choose resources'}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{value.mode === 'unconfigured' ? 'Add approved resources or choose Use none.' : 'Only your selections are available to this assistant.'}</p></div></div><Button type="button" variant="outline" onClick={() => setOpen(true)}><Plus aria-hidden className="h-4 w-4" />{value.ids.length ? 'Change selection' : `Choose ${label.toLowerCase()}`}</Button></div>
    {value.ids.length > 0 && <ul className="ak-resource-list divide-y rounded-xl border">{value.ids.map(id => {
      const resource = resources.find(item => item.id === id);
      const unavailable = unavailableResources.find(item => item.id === id);
      return <li key={id} className="flex items-start justify-between gap-3 p-4 text-sm"><div><span className="font-medium">{resource?.name || names[id] || unavailable?.name || `Resource ${id}`}</span>{unavailable && <p role="alert" className="mt-1 text-xs text-destructive">{unavailable.availabilityReason || 'This resource is no longer available.'}</p>}</div><Button type="button" variant="ghost" aria-label={`Remove ${resource?.name || names[id] || `resource ${id}`}`} onClick={() => onChange({ mode: value.ids.length === 1 ? 'none' : 'selected', ids: value.ids.filter(item => item !== id) })}><X aria-hidden className="h-4 w-4" /></Button></li>;
    })}</ul>}
    {value.mode !== 'none' && <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => onChange({ mode: 'none', ids: [] })}>Use none</Button>}
    {open && <AssistantResourceDrawer open onOpenChange={setOpen} title={label} category={category} selectedIds={value.ids.map(String)} onApply={(ids, items) => { setNames(previous => ({ ...previous, ...Object.fromEntries(items.map(item => [item.id, item.name])) })); onChange({ mode: ids.length ? 'selected' : 'none', ids: ids.map(Number) }); }} />}
  </div>;
}
