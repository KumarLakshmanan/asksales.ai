"use client";

import { useId, useState } from 'react';
import { SearchInput } from '@/components/ui/search-input';
import { modelKey, sameModel, type AssistantCatalog, type AssistantModel } from '@/lib/outreach-assistants';
import { cn } from '@/lib/utils';

export function AssistantModelPicker({ models, value, onChange, label = 'Reply model', hideLabel = false, availabilityNotice }: {
  models: AssistantCatalog['models']; value: AssistantModel | null; onChange: (value: AssistantModel) => void; label?: string; hideLabel?: boolean; availabilityNotice?: string;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const filtered = models.filter(model => `${model.label} ${model.description || ''}`.toLowerCase().includes(search.toLowerCase()));
  const selected = models.find(model => sameModel(model, value));
  return <fieldset className="min-w-0 space-y-4">
    <legend className={hideLabel ? 'sr-only' : 'text-sm font-semibold'}>{label}</legend>
    <p className="text-sm leading-6 text-muted-foreground">Choose a model made available by your admin.</p>
    {models.length > 5 && <SearchInput aria-label={`Search ${label.toLowerCase()}s`} value={search} onValueChange={setSearch} placeholder="Search models" className="min-h-11" />}
    <div className="max-h-80 space-y-2 overflow-y-auto p-1">
      {filtered.map((model, index) => <label key={modelKey(model)} className={cn('flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/30 focus-within:ring-2 focus-within:ring-ring', sameModel(model, value) ? 'border-primary bg-primary/5' : 'border-border')}>
        <input type="radio" name={id} value={modelKey(model)} aria-label={model.label} aria-describedby={model.description ? `${id}-${index}` : undefined} checked={sameModel(model, value)} onChange={() => onChange({ provider: model.provider, model: model.model })} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
        <span className="min-w-0"><span className="block break-words text-sm font-medium">{model.label}</span>{model.description && <span id={`${id}-${index}`} className="mt-1 block text-xs leading-5 text-muted-foreground">{model.description}</span>}</span>
      </label>)}
    </div>
    {!models.length ? <p role="status" className="text-sm leading-6 text-muted-foreground">{availabilityNotice || 'No reply models are available. Ask an administrator to enable a model.'}</p>
      : !filtered.length && <p role="status" className="text-sm text-muted-foreground">No models match your search.</p>}
    {value && !selected && !availabilityNotice && <p role="alert" className="text-sm text-destructive">The selected model is unavailable. Choose an available model before publishing.</p>}
    {selected && <p className="text-xs text-muted-foreground">Selected: {selected.label}</p>}
  </fieldset>;
}
