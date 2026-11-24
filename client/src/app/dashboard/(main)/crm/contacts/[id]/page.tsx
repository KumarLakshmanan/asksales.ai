"use client";

import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, MessageSquare, Send, Activity, TicketCheck, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ContactHistoryTabs, CONTACT_HISTORY_SECTIONS as sections } from '@/components/crm/workspace/ContactHistoryTabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContactAutomationRecovery } from '@/components/crm/ContactAutomationRecovery';
import { ContactEditForm } from '@/components/crm/ContactEditForm';
import { ContactReminderDialog } from '@/components/crm/ContactReminders';
import { CreateConversationDialog } from '@/components/crm/CreateConversationDialog';
import { CrmNavigation } from '@/components/crm/CrmNavigation';
import { ContactHeader } from '@/components/crm/workspace/ContactHeader';
import { ContactOverview } from '@/components/crm/workspace/ContactOverview';
import { AddActivityDialog } from '@/components/crm/workspace/AddActivityDialog';
import { ConversationThread, SentMessageCard } from '@/components/crm/workspace/ConversationThread';
import { TicketSummary } from '@/components/crm/workspace/TicketSummary';
import { ActivityTimeline } from '@/components/crm/workspace/ActivityTimeline';
import { ContactHistoryToolbar, HistoryHeading, EmptyHistory, HistoryLoadError, HistoryLoading, HistoryPagination } from '@/components/crm/workspace/HistoryControls';
import { useContactWorkspace } from '@/hooks/use-contact-workspace';
import { useCrmConfiguration } from '@/hooks/use-crm-configuration';
import { usePlatformAccess } from '@/hooks/use-platform-access';
import { crmStagesForStatuses } from '@/lib/crm-configuration';
import { EMPTY_HISTORY_FILTERS, contactDisplayName, type CrmHistoryFilters, type CrmHistoryTab } from '@/lib/crm-workspace';

function readTab(value:string|null):CrmHistoryTab {return sections.some(section=>section.value===value) ? value as CrmHistoryTab : 'conversations';}
function subscribeDesktop(listener:()=>void) {const query=window.matchMedia('(min-width: 1024px)');query.addEventListener('change',listener);return ()=>query.removeEventListener('change',listener);}
const desktopSnapshot=()=>window.matchMedia('(min-width: 1024px)').matches;
function WorkspaceLoading() {return <div role="status" className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Spinner size="sm" label={null} />Loading contact…</div>;}

export default function ContactDetailPage() {return <Suspense fallback={<WorkspaceLoading />}><ContactWorkspace /></Suspense>;}
function ContactWorkspace() {
  const {id}=useParams<{id:string}>();
  const router=useRouter();
  const params=useSearchParams();
  const [tab,setTab]=useState<CrmHistoryTab>(()=>readTab(params.get('tab')));
  const [filters,setFilters]=useState<Partial<Record<CrmHistoryTab,CrmHistoryFilters>>>({});
  const filter=filters[tab] || EMPTY_HISTORY_FILTERS;
  const [debouncedSearch,setDebouncedSearch]=useState(filter.search);
  useEffect(()=>{const timer=setTimeout(()=>setDebouncedSearch(filter.search),250);return ()=>clearTimeout(timer);},[filter.search]);
  useEffect(()=>setTab(readTab(params.get('tab'))),[params]);
  const workspace=useContactWorkspace(Number(id),tab,{...filter,search:debouncedSearch});
  const configuration=useCrmConfiguration();
  const access=usePlatformAccess();
  const canUse=(module:string)=>access.data?.modules?.some(item=>item.key===module && item.enabled)===true;
  const isDesktop=useSyncExternalStore(subscribeDesktop,desktopSnapshot,()=>false);
  const [overviewOpen,setOverviewOpen]=useState(false);
  const [editing,setEditing]=useState(false);
  const [editDirty,setEditDirty]=useState(false);
  const [editBusy,setEditBusy]=useState(false);
  const [activityOpen,setActivityOpen]=useState(false);
  const [reminderOpen,setReminderOpen]=useState(false);
  const [outreachOpen,setOutreachOpen]=useState(false);
  const contact=workspace.contact.data;
  const summary=workspace.summary.data?.counts ? workspace.summary.data : undefined;
  const result=workspace.result;
  const selectTab=(value:string)=>{
    const next=readTab(value);setTab(next);setDebouncedSearch(filters[next]?.search || '');
    const query=new URLSearchParams(params.toString());query.set('tab',next);
    window.history.replaceState(window.history.state,'',`${window.location.pathname}?${query}`);
  };
  const changeFilter=(value:CrmHistoryFilters)=>setFilters(current=>({...current,[tab]:value}));
  const closeEdit=(open:boolean)=>{if(editBusy)return;if(!open && editDirty && !window.confirm('You have unsaved contact changes. Discard them?'))return;setEditing(open);};
  const openEdit=()=>{setOverviewOpen(false);setEditDirty(false);setEditing(true);};
  useEffect(()=>{setEditing(false);setOverviewOpen(false);setActivityOpen(false);setReminderOpen(false);setOutreachOpen(false);setFilters({});},[workspace.scope]);

  // Pending + idle means the query is disabled (e.g. a malformed contact link)
  // and will never resolve; fall through to the not-found state instead.
  if(workspace.contact.isPending && workspace.contact.fetchStatus!=='idle')return <WorkspaceLoading />;
  if(workspace.contact.error || !contact)return <div className="space-y-4 p-6"><Link href="/dashboard/crm/contacts" className="text-sm text-primary hover:underline">Back to contacts</Link><Alert variant="destructive"><AlertTitle>Contact could not be loaded</AlertTitle><AlertDescription>{workspace.contact.error instanceof Error ? workspace.contact.error.message : 'Check the selected business profile and try again.'}<Button variant="outline" size="sm" className="ml-3" onClick={()=>void workspace.contact.refetch()}>Try again</Button></AlertDescription></Alert></div>;
  const name=contactDisplayName(contact);
  const stages=crmStagesForStatuses(configuration.stages,[contact.pipelineStatus || 'new']);
  const stage=stages.find(item=>item.key===(contact.pipelineStatus || 'new'));
  const current=sections.find(section=>section.value===tab)!;
  const count=(key:CrmHistoryTab):number|string=>{
    const counts=summary?.counts;
    if(key==='timeline')return tab==='timeline' ? workspace.pagination?.total ?? '—' : '—';
    const known=key==='conversations' ? counts?.conversations : key==='sent-messages' ? counts?.sentMessages : key==='activity' ? counts?.activities : counts?.tickets;
    if(known!==undefined)return known;
    if(key!==tab)return '—';
    return workspace.pagination?.total ?? (key==='conversations' ? result?.conversations?.length : key==='sent-messages' ? result?.sentMessages?.length : key==='activity' ? result?.data?.length : result?.tickets?.length) ?? '—';
  };
  const filtered=filter.search || filter.channel!=='all' || filter.unread || filter.type!=='all' || filter.status!=='all' || filter.from || filter.to;
  const overview=<ContactOverview contact={contact} stage={stage} summary={summary} summaryPending={workspace.summary.isPending} onEdit={openEdit} onChanged={workspace.refresh} canProposals={canUse('proposals')} />;
  let history:React.ReactNode;
  if(workspace.history.isPending)history=<HistoryLoading />;
  else if(workspace.history.error)history=<HistoryLoadError message={workspace.history.error instanceof Error ? workspace.history.error.message : 'History could not be loaded.'} onRetry={workspace.history.refetch} />;
  else if(tab==='conversations')history=result?.conversations?.length ? result.conversations.map((conversation,index)=><ConversationThread key={`${workspace.scope}:${conversation.id}:${conversation.providerAccountId ?? 'bound'}`} conversation={conversation} contactId={contact.id} scope={workspace.scope} canReply={canUse('outreach')} initiallyOpen={index===0} onReplySent={workspace.refresh} />) : <EmptyHistory icon={MessageSquare} title={filtered ? 'No matching conversations' : 'No conversations yet'} description={filtered ? 'Adjust the filters to find another conversation.' : 'Send outreach to start a conversation with this contact.'} action={!filtered && canUse('outreach') ? <Button variant="outline" onClick={()=>setOutreachOpen(true)}>Send outreach</Button> : undefined} />;
  else if(tab==='sent-messages')history=result?.sentMessages?.length ? result.sentMessages.map(message=><SentMessageCard key={message.id} message={message} />) : <EmptyHistory icon={Send} title={filtered ? 'No matching messages' : 'No sent messages'} description={filtered ? 'Adjust the filters to see other messages.' : 'Messages you send to this contact will appear here.'} />;
  else if(tab==='tickets')history=result?.tickets?.length ? result.tickets.map(ticket=><TicketSummary key={`${workspace.scope}:${ticket.id}`} ticket={ticket} scope={workspace.scope} canManage={canUse('support')} onChanged={workspace.refresh} />) : <EmptyHistory icon={TicketCheck} title={filtered ? 'No matching tickets' : 'No support tickets'} description={filtered ? 'Adjust the filters to see other tickets.' : 'Tickets linked to this contact will appear here.'} />;
  else history=result?.data?.length ? <ActivityTimeline items={result.data} combined={tab==='timeline'} /> : <EmptyHistory icon={Activity} title={filtered ? 'No matching activity' : tab==='timeline' ? 'No history yet' : 'No activities yet'} description={filtered ? 'Adjust the filters to see more of this relationship.' : 'Record a call, meeting, or note to keep the relationship up to date.'} />;

  return <div className="mx-auto max-w-[1440px] space-y-5 p-4 sm:p-6 lg:p-8">
    <CrmNavigation current="contacts" />
    <div className="flex items-center justify-between gap-3"><Link href="/dashboard/crm/contacts" className="inline-flex items-center gap-2 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft className="h-3.5 w-3.5" />All contacts</Link><Button variant="ghost" size="sm" disabled={workspace.history.isFetching} className="gap-1.5 text-xs text-muted-foreground" onClick={()=>void workspace.refresh()}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button></div>
    <ContactHeader contact={contact} stage={stage} summary={summary} summaryPending={workspace.summary.isPending} onEdit={openEdit} onAddActivity={()=>setActivityOpen(true)} onReminder={()=>setReminderOpen(true)} onOutreach={()=>setOutreachOpen(true)} onOverview={()=>setOverviewOpen(true)} canOutreach={canUse('outreach')} />
    {workspace.summary.error && <Alert><AlertTitle>Next-action summary could not be loaded</AlertTitle><AlertDescription>You can still use the contact and its history.<Button size="sm" variant="outline" className="ml-2" onClick={()=>void workspace.summary.refetch()}>Try again</Button></AlertDescription></Alert>}
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0 space-y-5" aria-label="Contact history"><ContactAutomationRecovery key={workspace.scope} contactId={contact.id} scope={workspace.scope} revision={contact.updatedAt} onChanged={workspace.refresh} /><Tabs value={tab} onValueChange={selectTab}><ContactHistoryTabs count={count} /><TabsContent value={tab} className="mt-5 space-y-4"><HistoryHeading title={current.title} description={current.description} badge={tab==='conversations' && (summary?.counts.unreadConversations || 0)>0 ? `${summary!.counts.unreadConversations} unread` : tab==='tickets' && (summary?.counts.openTickets || 0)>0 ? `${summary!.counts.openTickets} open` : undefined} action={(tab==='activity' || tab==='timeline') ? <Button variant="outline" size="sm" className="gap-1.5" onClick={()=>setActivityOpen(true)}><Plus className="h-4 w-4" />Add</Button> : undefined} /><ContactHistoryToolbar tab={tab} value={filter} onChange={changeFilter} />{history}<HistoryPagination pagination={workspace.pagination} pending={workspace.history.isFetching} onPage={page=>changeFilter({...filter,page})} /></TabsContent></Tabs></section>
      {isDesktop && <aside className="min-w-0" aria-label="Contact overview">{overview}</aside>}
    </div>
    <Dialog open={!isDesktop && overviewOpen} onOpenChange={setOverviewOpen}><DialogContent className="max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Contact overview</DialogTitle><DialogDescription>Details and next actions for {name}.</DialogDescription></DialogHeader>{overview}</DialogContent></Dialog>
    <Dialog open={editing} onOpenChange={closeEdit}><DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto p-0"><DialogHeader className="border-b border-border px-5 py-5 sm:px-6"><DialogTitle className="text-lg">Edit contact</DialogTitle><DialogDescription>Update {name}’s details and pipeline information. <Link href={`/dashboard/crm/contacts/${contact.id}/edit`} className="font-medium text-primary hover:underline">Open full editor</Link></DialogDescription></DialogHeader>{editing && <ContactEditForm key={workspace.scope} contact={contact} scope={workspace.scope} onDirtyChange={setEditDirty} onSavingChange={setEditBusy} onCancel={()=>setEditing(false)} onSaved={async updated=>{setEditing(false);if(updated.id && updated.id!==contact.id)router.replace(`/dashboard/crm/contacts/${updated.id}`);await workspace.refresh();}} />}</DialogContent></Dialog>
    <AddActivityDialog key={workspace.scope} contactId={contact.id} contactName={name} open={activityOpen} onOpenChange={setActivityOpen} onAdded={()=>{selectTab('activity');void workspace.refresh();}} />
    <ContactReminderDialog open={reminderOpen} onOpenChange={setReminderOpen} contactId={contact.id} contactName={name} onSaved={()=>void workspace.refresh()} />
    <CreateConversationDialog open={outreachOpen} onOpenChange={setOutreachOpen} contactId={contact.id} contactName={name} contactEmail={contact.email} contactPhone={contact.phone} leadId={contact.leadId ?? null} />
  </div>;
}
