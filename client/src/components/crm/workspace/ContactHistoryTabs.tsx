import { Activity, Clock3, MessageSquare, Send, TicketCheck } from 'lucide-react';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CrmHistoryTab } from '@/lib/crm-workspace';

export const CONTACT_HISTORY_SECTIONS = [
  {value:'conversations',label:'Conversations',icon:MessageSquare,title:'Conversations',description:'Messages across every channel, together in one place.'},
  {value:'sent-messages',label:'Sent',icon:Send,title:'Sent outreach',description:'Review delivered messages, follow-ups, and replies.'},
  {value:'timeline',label:'Timeline',icon:Clock3,title:'Relationship timeline',description:'Activity, messages, tickets, reminders, and automation runs in one chronological view.'},
  {value:'activity',label:'Activity',icon:Activity,title:'Activity timeline',description:'Calls, notes, meetings, and changes to the pipeline.'},
  {value:'tickets',label:'Tickets',icon:TicketCheck,title:'Support tickets',description:'See ownership, deadlines, and the latest support conversation.'},
] as const;

export function ContactHistoryTabs({ count }: { count: (tab: CrmHistoryTab) => number | string }) {
  return (
    <TabsList
      aria-label="Contact history sections"
      className="flex h-auto w-full flex-wrap justify-start gap-1 rounded-none border-0 border-b border-border bg-transparent p-0 pb-2"
    >
      {CONTACT_HISTORY_SECTIONS.map(({ value, label, icon: Icon }) => (
        <TabsTrigger
          key={value}
          value={value}
          className="min-h-11 shrink-0 gap-2 rounded-md border border-transparent px-3 text-xs data-[state=active]:border-primary/20 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none data-[state=active]:ring-0"
        >
          <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span>{label}</span>
          {value !== 'timeline' && (
            <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded bg-muted px-1.5 py-0.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
              {count(value)}
            </span>
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
