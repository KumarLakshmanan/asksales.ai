"use client";

import { useId } from 'react';
import { BedDouble, Headset, ListFilter, MessagesSquare, UserRoundCheck } from 'lucide-react';
import type { AssistantCatalog } from '@/lib/outreach-assistants';
import { cn } from '@/lib/utils';

const icons = { hotel_sales: BedDouble, technical_support: Headset, lead_qualification: ListFilter, customer_success: UserRoundCheck };

export function AssistantPresetPicker({ presets, value, onChange, hint, layout = 'cards' }: {
  presets: AssistantCatalog['presets']; value: string; onChange: (value: string) => void; hint?: string; layout?: 'cards' | 'list';
}) {
  const id = useId();
  return <fieldset className="min-w-0 space-y-3">
    <legend className="text-sm font-semibold">Choose a specialist preset</legend>
    <p id={`${id}-hint`} className="text-sm leading-6 text-muted-foreground">{hint || 'Start with instructions suited to your business. Assign resources after creating the draft.'}</p>
    <div className={cn("grid gap-3", layout === 'cards' && "sm:grid-cols-2 lg:grid-cols-3")}>
      {presets.map((preset, index) => {
        const Icon = icons[preset.agentType as keyof typeof icons] || MessagesSquare;
        return <label key={preset.agentType} className={cn('relative flex min-w-0 cursor-pointer gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/30 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2', layout === 'list' ? 'flex-row items-start' : 'flex-col', value === preset.agentType ? 'border-primary bg-primary/5' : 'border-border')}>
          <div className={cn("flex items-center justify-between gap-3", layout === 'list' && "flex-col-reverse")}>
            <Icon aria-hidden className={cn('h-5 w-5', value === preset.agentType ? 'text-primary' : 'text-muted-foreground')} />
            <input type="radio" name={id} value={preset.agentType} checked={value === preset.agentType} onChange={() => onChange(preset.agentType)} aria-label={preset.name} aria-describedby={`${id}-${index}-description ${id}-hint`} className="h-4 w-4 shrink-0 accent-primary" />
          </div>
          <span className="min-w-0"><span className="block text-sm font-semibold leading-5">{preset.name}</span>
          <span id={`${id}-${index}-description`} className="mt-1 block text-xs leading-5 text-muted-foreground">{preset.description}</span></span>
        </label>;
      })}
    </div>
    {!presets.length && <p role="status" className="text-sm text-muted-foreground">No specialist presets are available. Try reloading the page.</p>}
  </fieldset>;
}
