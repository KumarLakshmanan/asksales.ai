"use client";

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import api from '@/lib/api';
import { ASSISTANT_API, useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import { modelKey, sameModel, type AssistantCatalog, type AssistantModel } from '@/lib/outreach-assistants';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

export function AssistantModelDrawer({ selected, excluded, multiple = false, onClose, onApply }: {
  selected: AssistantModel[]; excluded?: AssistantModel | null; multiple?: boolean; onClose: () => void;
  onApply: (models: AssistantCatalog['models']) => void;
}) {
  const workspace = useAssistantWorkspace();
  const cache = useQueryClient();
  const [pending, setPending] = useState(selected);
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: [...workspace.scopeKey, 'model-picker'], queryFn: ({ signal }) => api.get<AssistantCatalog>(`${ASSISTANT_API}/catalog`, { ...workspace.requestOptions, signal }), enabled: !!workspace.profileId, staleTime: 0, retry: 1 });
  const models = (query.data?.models || []).filter(model => !sameModel(model, excluded || null));
  const filtered = models.filter(model => `${model.label} ${model.description || ''}`.toLowerCase().includes(search.toLowerCase()));
  const unavailable = pending.filter(model => !models.some(item => sameModel(model, item)));
  const apply = () => {
    if (query.isFetching || query.isError || unavailable.length || (!multiple && pending.length !== 1) || pending.length > 8 || !query.data?.permissions.canManage || !workspace.catalog.data?.permissions.canManage) return;
    const selectedModels = pending.map(model => models.find(item => sameModel(model, item))!);
    cache.setQueryData<AssistantCatalog>([...workspace.scopeKey, 'catalog'], current => current ? { ...current, models: query.data!.models } : current);
    onApply(selectedModels); onClose();
  };
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}><SheetContent side="right" className="ak-drawer flex h-dvh w-full flex-col gap-0 p-0 sm:max-w-xl">
    <SheetHeader className="border-b p-5 pr-12 text-left"><SheetTitle>{multiple ? 'Choose backup models' : 'Choose reply model'}</SheetTitle><SheetDescription>{multiple ? 'Choose up to eight alternatives. Their attempt order can be changed in the draft.' : 'Choose an available model for customer replies.'}</SheetDescription></SheetHeader>
    <div className="space-y-3 border-b p-5"><SearchInput aria-label="Search available models" placeholder="Search available models…" value={search} onValueChange={setSearch} className="min-h-11" />{multiple && <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{pending.length} of 8 selected</span><Button type="button" variant="ghost" onClick={() => setPending([])}>Clear selection</Button></div>}</div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5" aria-busy={query.isFetching}>{query.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading available models…</p>}{query.isError && <div role="alert"><p className="text-sm">Models could not be loaded. Your selections are retained.</p><Button type="button" variant="outline" onClick={() => void query.refetch()}>Try again</Button></div>}{!query.isError && filtered.map(model => {
      const checked = pending.some(item => sameModel(item, model));
      return <label key={modelKey(model)} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${checked ? 'border-primary bg-primary/5' : 'bg-card'}`}><input type={multiple ? 'checkbox' : 'radio'} name="drawer-model" className="mt-1 h-4 w-4 accent-primary" checked={checked} disabled={multiple && pending.length >= 8 && !checked} onChange={() => setPending(previous => multiple ? checked ? previous.filter(item => !sameModel(item, model)) : [...previous, { provider: model.provider, model: model.model }] : [{ provider: model.provider, model: model.model }])} /><Sparkles aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><span><span className="text-sm font-medium">{model.label}</span>{model.description && <span className="mt-1 block text-xs leading-6 text-muted-foreground">{model.description}</span>}</span></label>;
    })}{!query.isLoading && !query.isError && !filtered.length && <p role="status" className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">{query.data?.modelAvailabilityNotice || (search ? 'No models match this search.' : 'No other available models are configured.')}</p>}{unavailable.length > 0 && query.data && !query.data.modelAvailabilityNotice && <div role="alert" className="rounded-xl border border-amber-500/30 p-4 text-sm"><p>Remove unavailable models before applying.</p><Button type="button" variant="outline" className="mt-2" onClick={() => setPending(previous => previous.filter(model => models.some(item => sameModel(item, model))))}>Remove unavailable selections</Button></div>}</div>
    <div className="flex items-center justify-between gap-3 border-t bg-card p-5"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="button" onClick={apply} disabled={query.isFetching || query.isError || !!unavailable.length || (!multiple && pending.length !== 1) || !query.data?.permissions.canManage || !workspace.catalog.data?.permissions.canManage}>Apply models</Button></div>
  </SheetContent></Sheet>;
}
