"use client";
import Link from 'next/link';
import type {DashboardOperationResult} from '../../../../shared/dashboardOperations';
import {Button} from '@/components/ui/button';
import {Progress} from '@/components/ui/progress';

export function OperationResultCard({result}:{result:DashboardOperationResult}) {
  return <section aria-label={result.title} className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{result.title}</h2>{result.description && <p className="mt-1 text-sm text-muted-foreground">{result.description}</p>}</div><span className="rounded-md bg-muted px-2 py-1 text-xs capitalize">{result.status}</span></div>
    {result.checkedAt && <p className="text-xs text-muted-foreground">Checked {new Date(result.checkedAt).toLocaleString()}</p>}
    {!!result.metrics?.length && <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{result.metrics.map(m=><div key={m.label}><dt className="text-xs text-muted-foreground">{m.label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{typeof m.value==='number' ? m.value.toLocaleString() : m.value}</dd></div>)}</dl>}
    {result.progress && <div role="status" aria-live="polite"><p className="mb-2 text-xs">{result.progress.completed.toLocaleString()} / {result.progress.total.toLocaleString()} processed</p><Progress aria-label="Operation progress" value={result.progress.total ? result.progress.completed/result.progress.total*100 : 0}/></div>}
    {!!result.actions?.length && <div className="flex flex-wrap gap-2">{result.actions.filter(a=>a.href.startsWith('/dashboard/')).map(a=><Button key={`${a.label}:${a.href}`} variant="outline" size="sm" asChild><Link href={a.href}>{a.label}</Link></Button>)}</div>}
  </section>;
}
