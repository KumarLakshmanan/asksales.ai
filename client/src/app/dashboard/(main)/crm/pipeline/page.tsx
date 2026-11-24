"use client";

import {contactSavedToast,type CrmMutationResult} from '@/lib/crm-mutation-result';
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Brain, TrendingUp, ArrowRight, GripVertical, MessageSquare, Settings2, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Callout } from '@/components/ui/callout';
import { LoadingState } from '@/components/ui/loading-state';
import { Spinner } from '@/components/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { CrmNavigation } from '@/components/crm/CrmNavigation';
import { CrmCollectionFilters, useCrmCollectionScope, useCrmAssignees } from '@/components/crm/CrmCollectionFilters';
import { CreateConversationDialog } from '@/components/crm/CreateConversationDialog';
import { useCrmConfiguration } from '@/hooks/use-crm-configuration';
import { useCrmAutomationRefresh } from '@/hooks/use-crm-automation-refresh';
import { useCrmCollectionFilters } from '@/hooks/use-crm-collection-filters';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { crmContactQuery, crmContactParams, DEFAULT_CONTACT_FILTERS, type CrmContactFilters } from '@/lib/crmContactQuery';
import { crmDateRangeLabel, crmPlatformLabel, crmStagesForStatuses, type CrmStage, type CrmPreferences } from '@/lib/crm-configuration';
import { cn, formatCurrencyAmount, formatCurrencyBreakdown } from '@/lib/utils';
import { motion } from 'framer-motion';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDraggable, useDroppable, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';

interface CrmContact {
  id: number; leadId: number | null; firstName: string | null; lastName: string | null;
  email: string; phone: string | null; company: string | null; role: string | null; status: string;
  pipelineStatus: string; lastSentimentStatus: string | null; dealValue: string | null; currency: string;
  tags: string[]; createdAt: string; priority?: string; assignedTo?: number | null; nextFollowUpAt?: string | null;
}
interface PipelineAnalytics {
  stages: { key: string; label: string; count: number; dealValue: string }[];
  winRate: number; totalPipelineValueByCurrency: Record<string, string>; preferences?: CrmPreferences;
  flows?: { from: string; to: string; count: number }[]; stuckContacts?: number;
}
interface StageSummary { key: string; label: string; count: number; dealValueByCurrency: Record<string, string> }
// The server stops a slow board read at 12 s; the client gives up at 20 s and shows Retry.
const BOARD_REQUEST_TIMEOUT_MS = 20_000;
interface StagePage { contacts: CrmContact[]; total: number; totalPages: number; page: number; dealValueByCurrency: Record<string, string>; loading: boolean; error: string | null; errorPage?: number }
const STAGE_PAGE_SIZE = 20;

export default function CRMPipelinePage() {
  const router = useRouter();
  const { toast } = useToast();
  const { scope } = useCrmCollectionScope();
  const { assignees, error: assigneeError } = useCrmAssignees(scope);
  const { stages: configuredStages, loading: configurationLoading, error: configurationError, reload: reloadConfiguration } = useCrmConfiguration();
  const [filters, setFilters] = useState<CrmContactFilters>({ ...DEFAULT_CONTACT_FILTERS });
  const requestFilters = useCrmCollectionFilters(filters, scope);
  const [stagePages, setStagePages] = useState<Record<string, StagePage>>({});
  const [summary, setSummary] = useState<StageSummary[]>([]);
  const [analytics, setAnalytics] = useState<PipelineAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [activeContactId, setActiveContactId] = useState<number | null>(null);
  const [selectedContact, setSelectedContact] = useState<CrmContact | null>(null);
  const [showConversationDialog, setShowConversationDialog] = useState(false);
  const boardVersion = useRef(0);
  const analyticsVersion = useRef(0);
  const analyticsInFlight = useRef(0);
  const scopeGeneration = useRef(0);
  const refreshCurrent = useRef<() => Promise<void>>(async () => {});
  const requests = useRef(new Set<string>());
  const boardRequest = useRef<AbortController | null>(null);
  const pipelineStages = crmStagesForStatuses(configuredStages, summary.map(stage => stage.key));
  const contacts = Object.values(stagePages).flatMap(stage => stage.contacts);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    ++boardVersion.current; ++analyticsVersion.current; ++scopeGeneration.current; requests.current.clear();
    setFilters({ ...DEFAULT_CONTACT_FILTERS }); setStagePages({}); setSummary([]); setAnalytics(null); setSelectedContact(null); setUpdatingId(null);
    return () => { boardRequest.current?.abort(); boardRequest.current = null; ++boardVersion.current; ++analyticsVersion.current; ++scopeGeneration.current; requests.current.clear(); };
  }, [scope]);

  const fetchBoard = useCallback(async (background = false) => {
    if (configurationLoading || configurationError) return;
    if (background && boardRequest.current) return;
    boardRequest.current?.abort();
    const controller = new AbortController(); boardRequest.current = controller;
    const options = { signal: controller.signal };
    const version = ++boardVersion.current;
    requests.current.clear(); if (!background) { setLoading(true); setStagePages({}); } setContactsError(null);
    try {
      const result = await api.get<{ stages: StageSummary[] }>(`/api/crm/pipeline/summary?${crmContactParams({ ...requestFilters, pipelineStatus: undefined })}`, { ...options, timeoutMs: BOARD_REQUEST_TIMEOUT_MS, retryTransient: false });
      if (version !== boardVersion.current) return;
      setSummary(result.stages);
      const stages = crmStagesForStatuses(configuredStages, result.stages.map(stage => stage.key));
      setStagePages(current => Object.fromEntries(stages.map(stage => { const info = result.stages.find(item => item.key === stage.key); const empty = !Number(info?.count); return [stage.key, { contacts: background && !empty ? current[stage.key]?.contacts || [] : [], total: info?.count || 0, totalPages: 1, page: empty ? 1 : 0, dealValueByCurrency: info?.dealValueByCurrency || {}, loading: !empty, error: null }]; })));
      setLoading(false);
      const populated = stages.filter(stage => Number(result.stages.find(info => info.key === stage.key)?.count) > 0);
      for (let offset = 0; offset < populated.length && version === boardVersion.current; offset += 3) {
        await Promise.all(populated.slice(offset, offset + 3).map(async stage => {
        try {
          const page = await api.get<Omit<StagePage, 'loading' | 'error'>>(crmContactQuery({ ...requestFilters, pipelineStatus: stage.key, page: 1, limit: STAGE_PAGE_SIZE }), { ...options, timeoutMs: BOARD_REQUEST_TIMEOUT_MS, retryTransient: false });
          if (version !== boardVersion.current) return;
          setStagePages(current => ({ ...current, [stage.key]: { ...page, page: 1, loading: false, error: null } }));
        } catch (cause) {
          if (version === boardVersion.current) setStagePages(current => ({ ...current, [stage.key]: { ...current[stage.key], loading: false, errorPage: 1, error: cause instanceof Error ? cause.message : 'This stage could not be loaded.' } }));
        }
        }));
      }
    } catch (cause) { if (version === boardVersion.current) { setSummary([]); setContactsError(cause instanceof Error ? cause.message : 'Pipeline contacts could not be loaded.'); } }
    finally { if (version === boardVersion.current) { setLoading(false); boardRequest.current = null; } }
  }, [requestFilters, scope, configuredStages, configurationLoading, configurationError]);
  const fetchAnalytics = useCallback(async () => {
    const version = ++analyticsVersion.current; analyticsInFlight.current = version; setAnalyticsError(null);
    try { const result = await api.get<PipelineAnalytics>('/api/crm/pipeline/analytics'); if (version === analyticsVersion.current) setAnalytics(result); }
    catch (cause) { if (version === analyticsVersion.current) setAnalyticsError(cause instanceof Error ? cause.message : 'Pipeline analytics could not be loaded.'); }
    finally { if (analyticsInFlight.current === version) analyticsInFlight.current = 0; }
  }, [scope]);
  useEffect(() => { void fetchBoard(); }, [fetchBoard]);
  useEffect(() => { void fetchAnalytics(); }, [fetchAnalytics]);
  useEffect(() => { refreshCurrent.current = async () => { await Promise.all([fetchBoard(), fetchAnalytics()]); }; }, [fetchBoard, fetchAnalytics]);
  // Automatic refreshes (30s poll, socket reconnect) skip while a load is still
  // running; slow CRM reads otherwise overlap and the page never settles.
  useCrmAutomationRefresh(async () => { await Promise.all([fetchBoard(true), analyticsInFlight.current ? undefined : fetchAnalytics()]); });

  const loadStage = async (key: string, retry = false) => {
    const current = stagePages[key];
    if (!current || current.loading || requests.current.has(key)) return;
    const page = retry ? current.errorPage || Math.max(current.page, 1) : current.page + 1;
    const version = boardVersion.current; requests.current.add(key);
    setStagePages(values => ({ ...values, [key]: { ...values[key], loading: true, error: null } }));
    try {
      const result = await api.get<Omit<StagePage, 'loading' | 'error'>>(crmContactQuery({ ...requestFilters, pipelineStatus: key, page, limit: STAGE_PAGE_SIZE }), { timeoutMs: BOARD_REQUEST_TIMEOUT_MS, retryTransient: false });
      if (version !== boardVersion.current) return;
      setStagePages(values => { const existing = page > values[key].page ? values[key].contacts : []; return { ...values, [key]: { ...result, page, contacts: [...existing, ...result.contacts.filter(contact => !existing.some(item => item.id === contact.id))], loading: false, error: null } }; });
    } catch (cause) { if (version === boardVersion.current) setStagePages(values => ({ ...values, [key]: { ...values[key], loading: false, errorPage: page, error: cause instanceof Error ? cause.message : 'Contacts could not be loaded.' } })); }
    finally { if (version === boardVersion.current) requests.current.delete(key); }
  };
  const moveContact = useCallback(async (id: number, pipelineStatus: string) => {
    if (updatingId !== null || configurationError) return;
    const generation = scopeGeneration.current; setUpdatingId(id);
    try { const saved = await api.patch<CrmMutationResult>(`/api/crm/contacts/${id}/pipeline-status`, { pipelineStatus }); if (generation !== scopeGeneration.current) return; toast(contactSavedToast(saved,'Status updated')); await refreshCurrent.current(); }
    catch (cause) { if (generation === scopeGeneration.current) toast({ title: 'Stage could not be updated', description: cause instanceof Error ? cause.message : 'Try again.', variant: 'destructive' }); }
    finally { if (generation === scopeGeneration.current) setUpdatingId(null); }
  }, [updatingId, configurationError, toast, fetchBoard, fetchAnalytics]);
  const dragEnd = (event: DragEndEvent) => { setActiveContactId(null); const contact = contacts.find(item => item.id === Number(event.active.id)); if (contact && event.over && (contact.pipelineStatus || 'new') !== String(event.over.id)) void moveContact(contact.id, String(event.over.id)); };
  const activeContact = contacts.find(contact => contact.id === activeContactId);

  return <div className="mx-auto flex w-full min-w-0 max-w-screen-2xl flex-col gap-5 p-4 sm:p-6">
    <PageHeader icon={TrendingUp} title="Sales pipeline" subtitle="Keep every stage moving. Filter the full board, then open a contact to take the next step." actions={<><Button variant="outline" onClick={() => void fetchBoard()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button><Button variant="outline" onClick={() => router.push('/dashboard/crm/configuration')}><Settings2 className="mr-2 h-4 w-4" />Configure CRM</Button></>} />
    <CrmNavigation current="pipeline" />
    <CrmCollectionFilters value={filters} onChange={setFilters} assignees={assignees} showStages={false} showSort={false} ownerError={assigneeError} />
    {configurationError && <Alert variant="destructive"><AlertTitle>Saved stages could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-2"><span>{configurationError}</span><Button variant="outline" size="sm" onClick={reloadConfiguration}>Reload stages</Button></AlertDescription></Alert>}
    {analyticsError && <Alert variant="destructive"><AlertTitle>Pipeline analytics could not be loaded</AlertTitle><AlertDescription>{analyticsError}<Button variant="outline" size="sm" className="ml-3" onClick={() => void fetchAnalytics()}>Try again</Button></AlertDescription></Alert>}
    {analytics && <details className="rounded-xl border border-border bg-card px-4 py-3 text-sm"><summary className="cursor-pointer font-medium">Reporting summary · {analytics.winRate}% win rate · {formatCurrencyBreakdown(analytics.totalPipelineValueByCurrency, { compact: true })}</summary><p className="mt-2 text-xs text-muted-foreground">{analytics.preferences ? `${crmDateRangeLabel(analytics.preferences)} · ${crmPlatformLabel(analytics.preferences)}. ` : ''}Metrics use contacts created during the reporting period. Board filters apply to all contact dates.</p><div className="mt-3 flex flex-wrap gap-2">{analytics.flows?.map(flow => <Link key={`${flow.from}:${flow.to}`} href={`/dashboard/crm/contacts?pipelineStatus=${encodeURIComponent(flow.to)}`} className="flex min-h-9 items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{pipelineStages.find(stage => stage.key === flow.from)?.label || flow.from}<ArrowRight className="h-3 w-3" />{pipelineStages.find(stage => stage.key === flow.to)?.label || flow.to}<Badge variant="secondary">{flow.count} moves</Badge></Link>)}<Link href="/dashboard/crm/reports" className="flex min-h-9 items-center rounded-lg px-3 text-xs font-medium text-primary hover:underline">Open detailed reports →</Link></div>{analytics.preferences && <p className="mt-2 text-xs text-muted-foreground">{analytics.stuckContacts ?? 0} contacts stuck for {analytics.preferences.stuckThreshold}+ days</p>}</details>}
    {contactsError ? <Alert variant="destructive"><AlertTitle>Pipeline contacts could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-2"><span>{contactsError}</span><Button variant="outline" size="sm" onClick={() => void fetchBoard()}>Try again</Button></AlertDescription></Alert> : loading || configurationLoading ? <LoadingState size="section" className="min-h-64" label="Loading pipeline stages…" showLabel /> : !configurationError && <DndContext sensors={sensors} onDragStart={(event: DragStartEvent) => setActiveContactId(Number(event.active.id))} onDragEnd={dragEnd} onDragCancel={() => setActiveContactId(null)}><div aria-label="Pipeline board" className="flex w-full min-w-0 max-w-full min-h-[440px] max-h-[700px] gap-3 overflow-x-auto overscroll-x-contain pb-4" style={{ scrollbarWidth: 'thin' }}>{pipelineStages.map((stage, index) => <PipelineColumn key={stage.key} stage={stage} stages={pipelineStages} page={stagePages[stage.key]} sIdx={index} updatingId={updatingId} moveContact={moveContact} router={router} loadMore={() => void loadStage(stage.key)} retry={() => void loadStage(stage.key, true)} filters={filters} onOpenConversation={contact => { setSelectedContact(contact); setShowConversationDialog(true); }} />)}</div><DragOverlay>{activeContact && <Card className="w-60 border-primary/40"><CardContent className="p-3 text-sm font-medium">{[activeContact.firstName, activeContact.lastName].filter(Boolean).join(' ') || activeContact.email || 'Unnamed contact'}</CardContent></Card>}</DragOverlay></DndContext>}
    {selectedContact && <CreateConversationDialog open={showConversationDialog} onOpenChange={setShowConversationDialog} contactId={selectedContact.id} contactName={[selectedContact.firstName, selectedContact.lastName].filter(Boolean).join(' ') || selectedContact.email || 'Contact'} leadId={selectedContact.leadId} />}
  </div>;
}

function PipelineColumn({ stage, stages, page, sIdx, updatingId, moveContact, router, onOpenConversation, loadMore, retry, filters }: {
  stage: CrmStage; stages: CrmStage[]; page?: StagePage; sIdx: number; updatingId: number | null;
  moveContact: (id: number, stage: string) => void; router: ReturnType<typeof useRouter>;
  onOpenConversation: (contact: CrmContact) => void; loadMore: () => void; retry: () => void; filters: CrmContactFilters;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  return <motion.section aria-label={`${stage.label} stage`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: sIdx * 0.015 }} className={cn('flex min-h-0 w-[260px] shrink-0 flex-col gap-2 rounded-xl', isOver && 'bg-primary/5')}>
    <div className="flex items-center justify-between gap-2 px-1"><Link href={`/dashboard/crm/contacts?${crmContactParams({ ...filters, pipelineStatus: stage.key })}`} className="flex min-h-10 min-w-0 items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: stage.color }} /><span className="truncate text-xs font-semibold">{stage.label}</span><Badge variant="secondary" className="text-[10px]">{page?.total ?? '—'}</Badge></Link>{page && Object.keys(page.dealValueByCurrency || {}).length > 0 && <span className="text-[10px] font-medium text-emerald-600">{formatCurrencyBreakdown(page.dealValueByCurrency, { compact: true })}</span>}</div>
    <div className="h-0.5 rounded-full" style={{ backgroundColor: stage.color }} />
    <div ref={setNodeRef} className="min-h-80 flex-1 space-y-2 overflow-y-auto pr-0.5" style={{ scrollbarWidth: 'thin' }}>
      {page?.error && <Callout tone="danger" size="sm" actions={<Button variant="outline" size="sm" onClick={retry}>Retry stage</Button>}>{page.error}</Callout>}
      {page?.contacts.map(contact => <DraggableContactCard key={contact.id} contact={contact} stage={stage} stages={stages} updatingId={updatingId} moveContact={moveContact} router={router} onOpenConversation={onOpenConversation} />)}
      {page?.loading && <div role="status" className="flex items-center justify-center py-5 text-xs text-muted-foreground"><Spinner size="sm" label={null} className="mr-2" />Loading contacts…</div>}
      {page && !page.loading && !page.error && page.total === 0 && <div className={cn('flex h-24 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground', isOver && 'border-primary bg-primary/5')}>{isOver ? 'Drop here' : 'No contacts in this stage'}</div>}
      {page && !page.loading && !page.error && page.total > 0 && page.contacts.length === 0 && <div role="alert" className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{page.total} contacts in this stage did not load.<Button variant="outline" size="sm" onClick={retry}>Retry stage</Button></div>}
      {page && !page.error && page.page < page.totalPages && <Button variant="outline" className="w-full text-xs" disabled={page.loading} onClick={loadMore}>Load more · {page.contacts.length} of {page.total}</Button>}
    </div>
  </motion.section>;
}

// ─── Draggable Contact Card ───────────────────────────────────────────────────
function DraggableContactCard({
  contact,
  stage,
  stages,
  updatingId,
  moveContact,
  router,
  onOpenConversation,
}: {
  contact: CrmContact;
  stage: CrmStage;
  stages: CrmStage[];
  updatingId: number | null;
  moveContact: (id: number, stage: string) => void;
  router: ReturnType<typeof useRouter>;
  onOpenConversation: (contact: CrmContact) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: contact.id,
    disabled: updatingId === contact.id,
  });

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: isDragging ? 0.3 : 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.15 }}
      ref={setNodeRef}
    >
      <Card
        className={cn(
          "group relative border border-border/50 bg-card hover:border-border hover:shadow-md transition-all cursor-pointer rounded-xl overflow-hidden",
          updatingId === contact.id && "opacity-50 pointer-events-none"
        )}
        onClick={() => router.push(`/dashboard/crm/contacts/${contact.id}`)}
      >
        <div className="absolute top-0 left-0 w-0.5 h-full opacity-0 group-hover:opacity-100 transition-opacity" style={{ backgroundColor: stage.color }} />
        <CardContent className="p-3 space-y-2.5">
          {/* Name */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold truncate group-hover:text-primary transition-colors">
                {[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unnamed"}
              </p>
              {contact.company && (
                <div className="flex items-center gap-1 mt-0.5 opacity-60">
                  <Building2 className="h-2.5 w-2.5 shrink-0" />
                  <p className="text-[10px] text-muted-foreground truncate">{contact.company}</p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {updatingId === contact.id && (
                <Spinner size="xs" label="Moving contact" className="text-muted-foreground" />
              )}
              {/* Drag handle */}
              <button
                type="button"
                {...attributes}
                {...listeners}
                aria-label="Drag contact to another stage"
                className="touch-none p-0.5 rounded opacity-40 group-hover:opacity-100 focus-visible:opacity-100 hover:!opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
                onClick={(e) => e.stopPropagation()}
              >
                <GripVertical className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          </div>

          {/* Badges */}
          {(contact.dealValue && Number(contact.dealValue) > 0 || contact.lastSentimentStatus) && (
            <div className="flex flex-wrap gap-1">
              {contact.dealValue && Number(contact.dealValue) > 0 && (
                <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0 rounded-md border-emerald-500/25 bg-emerald-500/6 text-emerald-600 h-4">
                  {formatCurrencyAmount(contact.dealValue, contact.currency || "USD")}
                </Badge>
              )}
              {contact.lastSentimentStatus && (
                <Badge variant="outline" className={cn(
                  "text-[9px] font-semibold px-1.5 py-0 rounded-md border-none h-4 flex items-center gap-1",
                  contact.lastSentimentStatus === "positive" ? "bg-emerald-500/10 text-emerald-500" :
                  contact.lastSentimentStatus === "negative" ? "bg-rose-500/10 text-rose-500" :
                  "bg-amber-500/10 text-amber-500"
                )}>
                  <Brain className="h-2.5 w-2.5" />
                  {contact.lastSentimentStatus}
                </Badge>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-1.5 border-t border-border/30">
            <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
                aria-label="Start conversation" title="Start Conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenConversation(contact);
                }}
              >
                <MessageSquare className="h-2.5 w-2.5" />
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <Select
                value={contact.pipelineStatus || "new"}
                onValueChange={(val) => moveContact(contact.id, val)}
              >
                <SelectTrigger
                  aria-label="Pipeline stage"
                  disabled={updatingId === contact.id}
                  className="h-6 w-[100px] text-[10px] font-medium border border-border/50 bg-background rounded-md px-2 gap-1 focus:ring-1 focus:ring-primary/20"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-border/60 p-1">
                  {stages.map((s) => (
                    <SelectItem key={s.key} value={s.key} className="text-[10px] rounded-lg px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                        {s.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
                onClick={(e) => {
                  e.stopPropagation();
                  router.push(`/dashboard/crm/contacts/${contact.id}`);
                }}
                aria-label="View contact"
              >
                <ArrowRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
