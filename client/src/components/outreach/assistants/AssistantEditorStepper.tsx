"use client";

import { Check } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export function AssistantEditorStepper({ steps, current, onChange }: {
  steps: { tab: string; label: string; issues: string[] }[]; current: string; onChange: (step: string) => void;
}) {
  const index = steps.findIndex(step => step.tab === current);
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 1023px)')?.matches) active.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [current]);
  return <nav aria-label="Assistant setup steps" className="ak-stepper">
    <p className="mb-3 px-2 text-xs font-medium text-muted-foreground">Assistant setup · {index + 1} of {steps.length}</p>
    <ol className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">{steps.map((step, position) => <li key={step.tab} className="shrink-0 lg:shrink">
      <button ref={step.tab === current ? active : undefined} type="button" data-assistant-tab={step.tab} aria-current={step.tab === current ? 'step' : undefined} aria-label={`Step ${position + 1}: ${step.label}`} onClick={() => onChange(step.tab)} className={cn('flex min-h-12 w-full items-center gap-3 rounded-lg border border-transparent p-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', step.tab === current ? 'border-primary/20 bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/40')}>
        <span aria-hidden className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs', !step.issues.length && 'border-primary/20 bg-primary/5 text-primary')}>{!step.issues.length ? <Check className="h-3.5 w-3.5" /> : position + 1}</span><span className="whitespace-nowrap font-medium lg:whitespace-normal">{step.label}</span>
      </button>
    </li>)}</ol>
  </nav>;
}
