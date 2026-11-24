"use client";
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { TicketCheck, ChevronDown, AlertTriangle, ExternalLink, FileText } from 'lucide-react';
import { cn, formatNumericDateTimeIST } from '@/lib/utils';
import { TICKET_STATUS_COLORS, TICKET_PRIORITY_COLORS, SLA_STATUS_COLORS } from './presentation';
import type { SupportTicket } from '@/lib/crm-workspace';
import { TicketActions } from './TicketActions';
export function TicketSummary({ ticket, scope, canManage = false, onChanged = () => undefined }: { ticket: SupportTicket; scope:string; canManage?:boolean; onChanged?:()=>unknown }) {
  const [isOpen, setIsOpen] = useState(false);
  return <Card className="overflow-hidden rounded-xl shadow-none">
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" aria-label={`Ticket ${ticket.ticketNumber}: ${ticket.subject}`} className="w-full p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted"><TicketCheck className="h-5 w-5 text-muted-foreground" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted-foreground">#{ticket.ticketNumber}</span><Badge className={cn("border-none text-[11px] font-normal capitalize", TICKET_STATUS_COLORS[ticket.status] || "bg-muted text-muted-foreground")}>{ticket.status}</Badge><Badge className={cn("border-none text-[11px] font-normal capitalize", TICKET_PRIORITY_COLORS[ticket.priority] || "bg-muted text-muted-foreground")}>{ticket.priority} priority</Badge></div>
              <h3 className="mt-2 break-words text-sm font-semibold leading-6">{ticket.subject}</h3>
              {ticket.description && <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">{ticket.description}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{ticket.totalMessages ?? ticket.messages?.length ?? 0} messages</span>{ticket.category && <span className="capitalize">{ticket.category}</span>}<span>{ticket.assignee?.name || 'Unassigned'}</span><time dateTime={ticket.updatedAt}>{formatNumericDateTimeIST(ticket.updatedAt)}</time>{(ticket.unreadCount || 0) > 0 && <span className="font-medium text-primary">{ticket.unreadCount} unread</span>}</div>
              {ticket.latestReply && <p className="mt-2 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">Latest reply: {ticket.latestReply.content}</p>}
            </div>
            <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", isOpen && "rotate-180")} />
          </div>
        </button>
      </CollapsibleTrigger>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-4 py-3 sm:px-5">
        {ticket.slaStatus !== "no_sla" ? <Badge className={cn("gap-1.5 border-none text-[11px] font-normal", SLA_STATUS_COLORS[ticket.slaStatus] || "bg-muted text-muted-foreground")}>{ticket.slaStatus === "breached" && <AlertTriangle className="h-3 w-3" />}SLA: {ticket.slaStatus.replaceAll('_', ' ')}{ticket.hoursRemaining !== null && ticket.slaStatus !== "breached" && ` · ${ticket.hoursRemaining}h left`}</Badge> : <span className="text-xs text-muted-foreground">No SLA set</span>}
        <a href={`/dashboard/support/${ticket.id}`} className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open ticket <ExternalLink className="h-3.5 w-3.5" /></a>
      </div>
      <CollapsibleContent>
        <div className="border-t border-border p-4 sm:p-5">
          {ticket.slaDeadline && <p className="mb-3 text-xs text-muted-foreground">SLA deadline · {formatNumericDateTimeIST(ticket.slaDeadline)}</p>}
          {!ticket.messages?.length ? <p className="py-4 text-center text-sm text-muted-foreground">No messages on this ticket</p> : <div className="space-y-3">{ticket.messages.map(message => <article key={message.id} className={cn("rounded-lg border p-3 text-sm sm:p-4", message.isInternal ? "border-amber-500/20 bg-amber-500/5" : message.direction === "outbound" ? "ml-4 border-primary/15 bg-primary/5" : "mr-4 border-border bg-muted/30")}><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold">{message.isInternal ? "Internal note" : message.direction === "outbound" ? "Support" : "Contact"}</span><time dateTime={message.createdAt} className="text-[11px] text-muted-foreground">{formatNumericDateTimeIST(message.createdAt)}</time></div><p className="whitespace-pre-wrap break-words leading-6">{message.content}</p>{!!message.attachments?.length && <div className="mt-3 flex flex-wrap gap-2">{message.attachments.map((attachment, index) => {
            // Only render ordinary HTTP links returned by the ticket service.
            if (!/^https?:\/\//i.test(attachment.url)) return null;
            return <a key={index} href={attachment.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-primary hover:underline"><FileText className="h-3.5 w-3.5 shrink-0" /><span className="break-all">{attachment.name}</span></a>;
          })}</div>}</article>)}</div>}
          {(ticket.totalMessages || 0) > (ticket.messages?.length || 0) && <p className="mt-3 text-xs text-muted-foreground">Showing recent messages. Open the ticket to continue through its full history.</p>}
        </div>
        {canManage && <TicketActions key={`${scope}:${ticket.id}`} ticket={ticket} scope={scope} onChanged={onChanged} />}
      </CollapsibleContent>
    </Collapsible>
  </Card>;
}
