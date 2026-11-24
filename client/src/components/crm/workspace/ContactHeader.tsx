"use client";

import Link from 'next/link';
import { Building2, Edit, Plus, Send, CalendarClock, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { contactDisplayName, type Contact, type CrmWorkspaceSummary } from '@/lib/crm-workspace';
import { crmStageBadgeStyle, type CrmStage } from '@/lib/crm-configuration';
import { formatNumericDateTimeIST } from '@/lib/utils';

export function ContactHeader({contact,stage,summary,summaryPending=false,onEdit,onAddActivity,onOutreach,onReminder,onOverview,canOutreach}:{
  contact:Contact;stage?:CrmStage;summary?:CrmWorkspaceSummary;summaryPending?:boolean;onEdit:()=>void;onAddActivity:()=>void;onOutreach:()=>void;onReminder:()=>void;onOverview:()=>void;canOutreach:boolean;
}) {
  const name = contactDisplayName(contact);
  const next = summary?.nextReminder;
  return <header className="space-y-4 border-b border-border pb-5">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between"><div className="flex min-w-0 items-start gap-3 sm:gap-4"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/5 text-lg font-semibold text-primary sm:h-14 sm:w-14" aria-hidden="true">{[contact.firstName,contact.lastName].filter(Boolean).map(value => value!.charAt(0)).join('').slice(0,2).toUpperCase() || name.charAt(0).toUpperCase()}</div><div className="min-w-0"><div className="mb-1.5 flex flex-wrap items-center gap-2"><p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground sm:text-xs">Contact workspace</p><Badge variant="outline" className="max-w-full whitespace-normal break-words text-[10px] font-medium" style={crmStageBadgeStyle(stage)}>{stage?.label || contact.pipelineStatus || 'new'}</Badge></div><h1 className="break-words text-xl font-semibold tracking-tight sm:text-3xl" style={{fontFamily:'var(--font-heading)'}}>{name}</h1><div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:text-sm">{contact.role && <span className="break-words">{contact.role}</span>}{contact.company && <span className="inline-flex min-w-0 items-center gap-1.5"><Building2 className="h-3.5 w-3.5 shrink-0" /><span className="break-words">{contact.company}</span></span>}{!contact.role && !contact.company && <span className="break-all">{contact.email || contact.phone || 'Contact details not added'}</span>}</div></div></div>
      <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" className="gap-1.5" onClick={onEdit}><Edit className="h-3.5 w-3.5" />Edit contact</Button><Button variant="outline" size="sm" className="gap-1.5" onClick={onAddActivity}><Plus className="h-3.5 w-3.5" />Add activity</Button><Button variant="outline" size="sm" className="gap-1.5" onClick={onReminder}><CalendarClock className="h-3.5 w-3.5" />Follow up</Button>{canOutreach && <Button size="sm" className="gap-1.5" onClick={onOutreach}><Send className="h-3.5 w-3.5" />Send outreach</Button>}<Button variant="ghost" size="sm" className="gap-1.5 lg:hidden" onClick={onOverview}><PanelRightOpen className="h-3.5 w-3.5" />Contact details</Button></div>
    </div>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border-l-4 border-primary bg-primary/5 px-3 py-2.5 text-xs">
      <span><span className="text-muted-foreground">Owner </span><span className="font-medium">{summary ? summary.owner?.name || 'Unassigned' : summaryPending ? 'Loading…' : 'Unavailable'}</span></span>
      {next ? <button type="button" onClick={onReminder} className="text-left hover:underline"><span className="text-muted-foreground">Next follow-up </span><span className="font-medium">{next.title} · {formatNumericDateTimeIST(next.dueDate)}</span></button> : summary && <button type="button" onClick={onReminder} className="font-medium text-primary hover:underline">Schedule the next follow-up</button>}
      {summary && summary.counts.unreadConversations > 0 && <Badge variant="secondary" className="font-normal">{summary.counts.unreadConversations} unread conversations</Badge>}
      {summary && summary.ticketsDue.length > 0 && <Link href={`/dashboard/support/${summary.ticketsDue[0].id}`} className="font-medium text-amber-700 hover:underline dark:text-amber-300">Ticket deadline · {formatNumericDateTimeIST(summary.ticketsDue[0].slaDeadline)}</Link>}
    </div>
  </header>;
}
