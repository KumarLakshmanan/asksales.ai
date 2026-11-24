"use client";

import type { ReactNode } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export function SettingsTabs({ items, label }: { items: readonly { value: string; label: string }[]; label: string }) {
  return <div className="max-w-full overflow-x-auto border-b">
    <TabsList aria-label={label} className="h-auto justify-start gap-2 rounded-none border-0 bg-transparent p-0">
      {items.map(item => <TabsTrigger key={item.value} value={item.value} className="min-h-12 rounded-none border-b-2 border-transparent px-4 font-medium data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none data-[state=active]:ring-0">{item.label}</TabsTrigger>)}
    </TabsList>
  </div>;
}

export function SettingsPanel({ title, description, children, className, action }: { title: string; description?: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return <section className={cn('min-w-0 rounded-xl border bg-card p-5 sm:p-6', className)}>
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold tracking-tight">{title}</h2>{description && <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">{description}</p>}</div>{action}</div>
    {children}
  </section>;
}

export function SettingsSaveBar({ dirty, saving, onDiscard, onSave, label = 'Save changes', children, disabled = false }: { dirty: boolean; saving: boolean; onDiscard: () => void; onSave: () => void; label?: string; children?: ReactNode; disabled?: boolean }) {
  return <div className="sticky bottom-0 z-10 flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
    <p role="status" className="text-sm text-muted-foreground">{children || (dirty ? 'You have unsaved changes.' : 'No unsaved changes.')}</p>
    <div className="flex shrink-0 flex-wrap gap-2"><Button type="button" variant="outline" disabled={!dirty || saving} onClick={onDiscard}>Discard changes</Button><Button type="button" loading={saving} loadingText="Saving…" disabled={!dirty || disabled} onClick={onSave}><Save aria-hidden className="mr-2 h-4 w-4" />{label}</Button></div>
  </div>;
}
