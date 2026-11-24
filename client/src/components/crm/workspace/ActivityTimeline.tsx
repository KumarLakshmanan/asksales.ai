"use client";

import { Activity, CalendarClock, MessageSquare, TicketCheck, Workflow, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatNumericDateTimeIST } from '@/lib/utils';
import type { CrmActivity, CrmTimelineItem } from '@/lib/crm-workspace';
import { ACTIVITY_ICONS } from './presentation';

export function ActivityTimeline({items,combined=false}:{items:Array<CrmActivity|CrmTimelineItem>;combined?:boolean}) {
  return <Card className="rounded-xl shadow-none"><CardContent className="p-4 sm:p-6"><ol aria-label={combined ? 'Combined contact timeline' : 'Contact activity'} className="relative space-y-6 before:absolute before:bottom-4 before:left-[17px] before:top-4 before:w-px before:bg-border">{items.map(item => {
    const timeline = item as CrmTimelineItem;
    const Icon = timeline.kind === 'conversation' ? MessageSquare : timeline.kind === 'ticket' ? TicketCheck : timeline.kind === 'reminder' ? CalendarClock : timeline.kind === 'automation' ? Workflow : ACTIVITY_ICONS[item.type] || Activity;
    const related = timeline.related?.url;
    const safeRelated = related?.startsWith('/dashboard/') && !related.startsWith('//') ? related : null;
    return <li key={`${timeline.kind || 'activity'}:${item.id}`} className="relative flex gap-3 sm:gap-4"><div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card"><Icon className="h-4 w-4 text-muted-foreground" /></div><div className="min-w-0 flex-1 pt-0.5"><div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 space-y-1.5"><div className="flex flex-wrap items-center gap-2"><Badge variant="secondary" className="text-[11px] font-normal capitalize">{item.type.replaceAll('_',' ')}</Badge>{timeline.actor?.name && <span className="text-xs text-muted-foreground">{timeline.actor.name}</span>}</div><h3 className="break-words text-sm font-semibold leading-6">{item.subject || item.type.replaceAll('_',' ')}</h3></div><time dateTime={item.createdAt} className="shrink-0 text-xs leading-5 text-muted-foreground">{formatNumericDateTimeIST(item.createdAt)}</time></div>{item.body && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{item.body}</p>}{safeRelated && <a href={safeRelated} className="mt-2 inline-flex items-center gap-1.5 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{timeline.related!.label}<ExternalLink className="h-3 w-3" /></a>}</div></li>;
  })}</ol></CardContent></Card>;
}
