"use client";

import Link from 'next/link';
import { cn } from '@/lib/utils';

const destinations = [
  ['contacts', 'Contacts'], ['pipeline', 'Pipeline'], ['work', 'My work'], ['reports', 'Reports'],
] as const;

export function CrmNavigation({ current, includeLeads = false }: { current: typeof destinations[number][0]; includeLeads?: boolean }) {
  return <nav aria-label="CRM workspace" className="flex w-full flex-wrap gap-1 rounded-xl border border-border bg-muted/35 p-1 sm:w-fit">
    {includeLeads && <Link href="/dashboard/leads" className="flex min-h-10 items-center rounded-lg px-4 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Leads</Link>}
    {destinations.map(([key, label]) => <Link key={key} href={`/dashboard/crm/${key}`} aria-current={current === key ? 'page' : undefined}
      className={cn('flex min-h-10 items-center rounded-lg px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', current === key ? 'bg-card text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground')}>{label}</Link>)}
  </nav>;
}
