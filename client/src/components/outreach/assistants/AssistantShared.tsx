"use client";

import './assistant-workspace.css';

import { cloneElement, isValidElement, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CheckCircle2, CircleAlert, Mail, MessageCircle, Monitor, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { PageLoadingState, PageErrorState } from '@/components/ui/page-state';
import { cn } from '@/lib/utils';
import type { AssistantChannel, AssistantReadiness, AssistantResource, AssistantSelection, AssistantState } from '@/lib/outreach-assistants';
import { assistantChannelLabels, assistantStateLabels } from '@/lib/outreach-assistants';
import type { useAssistantWorkspace } from '@/hooks/use-outreach-assistants';

export const nativeSelectClass = 'min-h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';
export const fieldClass = 'space-y-2';

export function WorkspaceGate({ workspace, children }: { workspace: ReturnType<typeof useAssistantWorkspace>; children: ReactNode }) {
  if (workspace.profiles.isLoading || (workspace.profileId && workspace.catalog.isLoading)) return <PageLoadingState label="Loading assistant workspace…" />;
  if (workspace.profiles.isError || workspace.catalog.isError) return <PageErrorState title="Assistant workspace could not be loaded" description={(workspace.catalog.error || workspace.profiles.error)?.message} reset={() => { void workspace.profiles.refetch(); void workspace.catalog.refetch(); }} />;
  if (!workspace.profileId) return <div className="p-8"><h1 className="text-xl font-semibold">Choose a business profile first</h1><p className="mt-3 text-sm text-muted-foreground">Assistants and their resources belong to one business profile.</p><Button asChild className="mt-5"><Link href="/dashboard/select-profile">Choose business profile</Link></Button></div>;
  return children;
}
export function RuntimeNotice({ enabled }: { enabled: boolean }) {
  if (enabled) return null;
  return <Callout tone="warning" announce className="ak-runtime" title="Customer delivery is blocked: assistant runtime is disabled.">Prepare drafts or simulations, then review assistant readiness.{' '}<Link className="font-medium text-primary underline" href="/documentation/assistants#delivery-block">Documentation</Link></Callout>;
}
export function ChannelBadge({ channel, publicComment = false }: { channel: AssistantChannel; publicComment?: boolean }) {
  const Icon = channel === 'email' ? Mail : channel === 'web' ? Monitor : MessageCircle;
  return <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/30 px-2 py-1 text-xs"><Icon aria-hidden className="h-3.5 w-3.5" />{assistantChannelLabels[channel]}{publicComment && ' · Comments'}</span>;
}
export function StateBadge({ state }: { state: AssistantState }) {
  return <Badge variant="outline" className={cn('gap-1.5 text-xs', state === 'live' && 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400', state === 'needs_attention' && 'border-amber-500/30 text-amber-700 dark:text-amber-400')}><span className={cn('h-1.5 w-1.5 rounded-full bg-current', state === 'draft' && 'opacity-40')} aria-hidden />{assistantStateLabels[state]}</Badge>;
}
export function ConfigurationSection({ title, description, children, action, className }: { title: string; description?: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return <section className={cn("ak-configuration border bg-card p-5 sm:p-6", className)}><header className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold tracking-tight">{title}</h2>{description && <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>}</div>{action}</header>{children}</section>;
}
export function ErrorNotice({ message }: { message: string }) { return message ? <Callout tone="danger">{message}</Callout> : null; }
export function BaselinePrivacy() {
  return <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4"><ShieldCheck aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><p className="text-sm font-medium">Privacy protection is always on</p><p className="mt-1 text-sm leading-6 text-muted-foreground">Personal data is redacted before AI processing. Protected values stay in the encrypted vault. Existing approval and staff access checks cannot be disabled by selecting an assistant.</p></div></div>;
}
export function SelectionMode({ label, mode, onChange }: { label: string; mode: AssistantSelection['mode']; onChange: (mode: AssistantSelection['mode']) => void }) {
  return <fieldset className="mb-4 flex flex-wrap gap-x-5 gap-y-3"><legend className="sr-only">{label} selection</legend>{([['unconfigured', 'Not decided'], ['none', 'None'], ['selected', 'Select resources']] as const).map(([value, text]) => <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="radio" name={`mode-${label}`} value={value} checked={mode === value} onChange={() => onChange(value)} className="h-4 w-4 accent-primary" />{text}</label>)}</fieldset>;
}
export function ResourceSelection({ label, resources, unavailableResources = [], value, onChange }: { label: string; resources: AssistantResource[]; unavailableResources?: AssistantResource[]; value: AssistantSelection; onChange: (value: AssistantSelection) => void }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const unavailable = value.ids.filter(id => !resources.some(resource => resource.id === id));
  const filtered = resources.filter(resource => `${resource.name} ${resource.channels.join(' ')} ${resource.preview || ''}`.toLowerCase().includes(search.toLowerCase()));
  const unavailableMatches = unavailableResources.filter(resource => `${resource.name} ${resource.availabilityReason || ''}`.toLowerCase().includes(search.toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(Math.max(filtered.length, unavailableMatches.length) / 25));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * 25;
  return <div><SelectionMode label={label} mode={value.mode} onChange={mode => { setPage(1); onChange({ mode, ids: [] }); }} />{value.mode === 'none' && <p className="text-sm text-muted-foreground">No {label.toLowerCase()} will be available to this assistant.</p>}{value.mode === 'unconfigured' && <p className="text-sm text-amber-700 dark:text-amber-400">Choose resources or deliberately choose None before publishing.</p>}{value.mode === 'selected' && <div className="space-y-3"><Input aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}`} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /><p className="text-xs text-muted-foreground">{value.ids.length} selected · {filtered.length} available matches</p><div className="max-h-[480px] divide-y overflow-y-auto rounded-xl border">{!resources.length && <p className="p-4 text-sm text-muted-foreground">No published, permitted {label.toLowerCase()} are available in this business. Publish a source first, or choose None.</p>}{resources.length > 0 && !filtered.length && <p className="p-4 text-sm text-muted-foreground">No resources match this search. Your selected resources are retained.</p>}{filtered.slice(start, start + 25).map(resource => <div key={resource.id} className="p-4"><label className="flex cursor-pointer items-start gap-3"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={value.ids.includes(resource.id)} onChange={event => onChange({ mode: 'selected', ids: event.target.checked ? [...new Set([...value.ids, resource.id])] : value.ids.filter(id => id !== resource.id) })} /><span className="min-w-0 text-sm"><span className="font-medium">{resource.name}</span>{resource.channels.length > 0 && <span className="mt-1 block text-xs text-muted-foreground">{resource.channels.join(' · ')}{resource.sourceVersion ? ` · Version ${resource.sourceVersion}` : ''}{resource.status ? ` · ${resource.status}` : ''}</span>}</span></label><details className="ml-7 mt-2 text-xs"><summary className="min-h-9 cursor-pointer text-primary">Preview resource</summary><p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 leading-6">{resource.preview || 'No text preview is available. Selection remains limited to the approved published resource.'}</p></details></div>)}</div>{unavailableMatches.slice(start, start + 25).map(resource => <div key={resource.id} className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground"><p className="font-medium">{resource.name} · Unavailable</p><p className="mt-1 text-xs leading-5">{resource.availabilityReason || 'This resource is not published, approved or permitted for this assistant.'}</p></div>)}{pageCount > 1 && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">Resource page {currentPage} of {pageCount}. Selections on other pages are retained.</p><div className="flex gap-2"><Button type="button" variant="outline" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous resources</Button><Button type="button" variant="outline" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Next resources</Button></div></div>}</div>}{unavailable.length > 0 && <div role="alert" className="mt-3 text-sm text-destructive">{unavailable.map(id => <p key={id}>{unavailableResources.find(resource => resource.id === id)?.name || `Resource ${id}`} is no longer available. {unavailableResources.find(resource => resource.id === id)?.availabilityReason} <button type="button" className="underline" onClick={() => onChange({ ...value, ids: value.ids.filter(selected => selected !== id) })}>Remove selection</button></p>)}</div>}</div>;
}
export function ReadinessChecks({ readiness }: { readiness: AssistantReadiness }) {
  return <ul className="divide-y rounded-xl border">{readiness.checks.map(check => <li key={check.key} aria-label={`${check.label} — ${check.ok ? 'Passed' : 'Needs attention'}`} className="flex items-start gap-3 p-3 text-sm">{check.ok ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}<span><span className="font-medium">{check.label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{check.detail}</span></span></li>)}</ul>;
}
export function Field({ label, htmlFor, children, hint, error }: { label: string; htmlFor: string; children: ReactNode; hint?: string; error?: string }) {
  const [touched, setTouched] = useState(false);
  const field = isValidElement<{ value?: unknown; type?: string; min?: number; max?: number; step?: number | string; onBlur?: (event: unknown) => void; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>(children) ? children : null;
  const props = field?.props;
  const numeric = props?.type === 'number' && props.value !== '' && props.value !== undefined;
  const derived = numeric && Number(props.step) === 1 && !Number.isInteger(Number(props.value)) ? `${label} must be a whole number.`
    : numeric && (!Number.isFinite(Number(props.value)) || (props.min !== undefined && Number(props.value) < props.min) || (props.max !== undefined && Number(props.value) > props.max)) ? `${label} must be between ${props.min ?? 0} and ${props.max ?? 'the supported maximum'}.`
    : touched && ['assistant-name', 'new-assistant-name'].includes(htmlFor) && !String(props?.value || '').trim() ? 'Enter an assistant name.' : '';
  const message = error || derived;
  const rendered = field ? cloneElement(field, { 'aria-invalid': message ? true : props?.['aria-invalid'], 'aria-describedby': message ? `${htmlFor}-error` : props?.['aria-describedby'], onBlur: event => { setTouched(true); props?.onBlur?.(event); } }) : children;
  return <div className={fieldClass}><Label htmlFor={htmlFor}>{label}</Label>{rendered}{hint && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}{message && <p id={`${htmlFor}-error`} role="alert" className="text-xs leading-5 text-destructive">{message}</p>}</div>;
}
