"use client";

import {validContactAmount} from '@/lib/crm-contact-input';

import {contactSavedToast,type CrmMutationResult} from '@/lib/crm-mutation-result';
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Users, Eye, Trash2, Download, UserPlus, Calendar, MoreHorizontal, Edit, RefreshCw, MessageSquare, Settings2, Save, Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { PageShell } from '@/components/ui/page-shell';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Spinner } from '@/components/ui/spinner';
import { CreateContactDialog } from '@/components/crm/CreateContactDialog';
import { CreateConversationDialog } from '@/components/crm/CreateConversationDialog';
import { CrmNavigation } from '@/components/crm/CrmNavigation';
import { CrmCollectionFilters, crmSelectClass, useCrmAssignees, useCrmCollectionScope } from '@/components/crm/CrmCollectionFilters';
import api from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useCrmAutomationRefresh } from '@/hooks/use-crm-automation-refresh';
import { useCrmConfiguration } from '@/hooks/use-crm-configuration';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { useCrmCollectionFilters } from '@/hooks/use-crm-collection-filters';
import { crmStagesForStatuses, crmStageBadgeStyle } from '@/lib/crm-configuration';
import { crmContactQuery, crmContactParams, DEFAULT_CONTACT_FILTERS, readCrmContactFilters, type CrmContactFilters } from '@/lib/crmContactQuery';
import { crmSavedViewKey, parseCrmSavedViews, type CrmSavedView } from '@/lib/crmSavedViews';
import { formatCurrencyAmount, formatCurrencyBreakdown } from '@/lib/utils';

interface CrmContact {
  id: number; leadId: number | null; firstName: string | null; lastName: string | null;
  email: string; phone: string | null; company: string | null; pipelineStatus: string;
  dealValue: string | null; currency: string; tags: string[]; priority?: string;
  assignedTo?: number | null; ownerName?: string | null; nextFollowUpAt?: string | null; updatedAt?: string;
}
interface BulkResult extends CrmMutationResult { updatedCount:number;contacts?:Array<{id:number;automationTransitionId?:number}&CrmMutationResult> }
interface CrmAnalytics { totalContacts: number; winRate: number; pipelineValueByCurrency: Record<string, string> }
const contactName = (contact: CrmContact) => [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || contact.phone || 'Unnamed contact';

export default function CRMContactsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { scope, userId } = useCrmCollectionScope();
  const { assignees, error: assigneeError, loading: assigneesLoading } = useCrmAssignees(scope);
  const { stages: configuredStages, error: configurationError, reload: reloadConfiguration } = useCrmConfiguration();
  const requestVersion = useRef(0);
  const analyticsVersion = useRef(0);
  const contactsInFlight = useRef(0);
  const analyticsInFlight = useRef(0);
  const scopeGeneration = useRef(0);
  const refreshCurrent = useRef<() => Promise<void>>(async () => {});
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [analytics, setAnalytics] = useState<CrmAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<CrmContactFilters>({ ...DEFAULT_CONTACT_FILTERS });
  const requestFilters = useCrmCollectionFilters(filters, scope);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [savedViews, setSavedViews] = useState<CrmSavedView[]>([]);
  const [selectedView, setSelectedView] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewDialog, setViewDialog] = useState(false);
  const [viewName, setViewName] = useState('');
  const [exporting, setExporting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStage, setBulkStage] = useState('unchanged');
  const [bulkOwner, setBulkOwner] = useState('unchanged');
  const [bulkTags, setBulkTags] = useState('');
  const [bulkRecovery,setBulkRecovery]=useState<NonNullable<BulkResult['contacts']>>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [syncingToOutreach, setSyncingToOutreach] = useState(false);
  const [editingContactId, setEditingContactId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ company: '', dealValue: '', pipelineStatus: 'new' });
  const [saving, setSaving] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [selectedContact, setSelectedContact] = useState<CrmContact | null>(null);
  const [showConversationDialog, setShowConversationDialog] = useState(false);
  const pipelineStages = crmStagesForStatuses(configuredStages, [...contacts.map(contact => contact.pipelineStatus), ...(filters.pipelineStatus && filters.pipelineStatus !== 'all' ? [filters.pipelineStatus] : [])]);
  const originalEdit = contacts.find(contact => contact.id === editingContactId);
  const editDirty = Boolean(originalEdit && (editForm.company !== (originalEdit.company || '') || editForm.dealValue !== (originalEdit.dealValue || '') || editForm.pipelineStatus !== (originalEdit.pipelineStatus || 'new')));
  const confirmDiscard = useUnsavedChanges(editDirty);

  useEffect(() => {
    ++requestVersion.current; ++analyticsVersion.current; ++scopeGeneration.current;
    setContacts([]); setAnalytics(null); setSelectedIds([]); setEditingContactId(null); setSelectedContact(null); setSaving(false); setBulkBusy(false); setExporting(false); setSyncingToOutreach(false);
    setBulkRecovery([]);setSelectedView(''); setPage(1); setBulkStage('unchanged'); setBulkOwner('unchanged'); setBulkTags('');
    setFilters(readCrmContactFilters(Object.fromEntries(new URLSearchParams(window.location.search))));
    try { setSavedViews(userId ? parseCrmSavedViews(localStorage.getItem(crmSavedViewKey(scope))) : []); } catch { setSavedViews([]); }
    return () => { ++requestVersion.current; ++analyticsVersion.current; ++scopeGeneration.current; };
  }, [scope, userId]);

  const fetchContacts = useCallback(async (background = false) => {
    const version = ++requestVersion.current; contactsInFlight.current = version;
    if (!background) setLoading(true);
    setContactsError(null);
    try {
      const response = await api.get<{ contacts: CrmContact[]; total: number; totalPages: number }>(crmContactQuery({ ...requestFilters, page, limit: pageSize }));
      if (version !== requestVersion.current) return;
      const pages = Math.max(response.totalPages || 1, 1);
      if (page > pages) { setPage(pages); return; }
      setContacts(response.contacts || []); setTotal(response.total || 0);
    } catch (cause) { if (version === requestVersion.current) setContactsError(cause instanceof Error ? cause.message : 'Contacts could not be loaded.'); }
    finally { if (version === requestVersion.current) setLoading(false); if (contactsInFlight.current === version) contactsInFlight.current = 0; }
  }, [requestFilters, page, pageSize, scope]);
  const fetchAnalytics = useCallback(async () => {
    const version = ++analyticsVersion.current; analyticsInFlight.current = version; setAnalyticsError(null);
    try { const result = await api.get<CrmAnalytics>('/api/crm/analytics'); if (version === analyticsVersion.current) setAnalytics(result); }
    catch (cause) { if (version === analyticsVersion.current) setAnalyticsError(cause instanceof Error ? cause.message : 'CRM analytics could not be loaded.'); }
    finally { if (analyticsInFlight.current === version) analyticsInFlight.current = 0; }
  }, [scope]);
  useEffect(() => { void fetchContacts(); }, [fetchContacts]);
  useEffect(() => { void fetchAnalytics(); }, [fetchAnalytics]);
  useEffect(() => { refreshCurrent.current = async () => { await Promise.all([fetchContacts(true), fetchAnalytics()]); }; }, [fetchContacts, fetchAnalytics]);
  useEffect(() => { setSelectedIds([]); }, [filters, page, pageSize]);
  // Automatic refreshes (30s poll, socket reconnect) skip while a load is still
  // running; slow CRM reads otherwise overlap and the page never settles.
  useCrmAutomationRefresh(async () => { await Promise.all([contactsInFlight.current ? undefined : fetchContacts(true), analyticsInFlight.current ? undefined : fetchAnalytics()]); });
  const changeFilters = (next: CrmContactFilters) => { if (!confirmDiscard()) return false; confirmDiscard.clearGuard(); setEditingContactId(null); setFilters(next); setPage(1); setSelectedView(''); return true; };
  const clearReportFilters = () => {
    if (!changeFilters({ ...filters, platforms: undefined, dateRange: undefined, from: undefined, to: undefined })) return;
    const url = new URL(window.location.href);
    for (const key of ['platforms', 'dateRange', 'from', 'to']) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };
  const navigate = (path: string) => { if (confirmDiscard()) { confirmDiscard.clearGuard(); router.push(path); } };
  const toggleContact = (id: number) => setSelectedIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : ids.length < 100 ? [...ids, id] : ids);

  const saveView = () => {
    const name = viewName.trim();
    if (!name || name.length > 80) return;
    if (savedViews.some(view => view.name.toLowerCase() === name.toLowerCase())) { toast({ title: 'Choose a different view name', description: 'A saved view already uses this name.', variant: 'destructive' }); return; }
    if (savedViews.length >= 20) { toast({ title: 'Saved-view limit reached', description: 'Remove a saved view before adding another.', variant: 'destructive' }); return; }
    const view = { id: crypto.randomUUID(), name, filters: { ...filters } };
    try { const next = [...savedViews, view]; localStorage.setItem(crmSavedViewKey(scope), JSON.stringify(next)); setSavedViews(next); setSelectedView(view.id); setViewDialog(false); setViewName(''); toast({ title: 'View saved' }); }
    catch { toast({ title: 'View could not be saved', description: 'Browser storage is unavailable.', variant: 'destructive' }); }
  };
  const removeView = () => {
    try { const next = savedViews.filter(view => view.id !== selectedView); localStorage.setItem(crmSavedViewKey(scope), JSON.stringify(next)); setSavedViews(next); setSelectedView(''); }
    catch { toast({ title: 'View could not be removed', variant: 'destructive' }); }
  };
  const exportContacts = async () => {
    const generation = scopeGeneration.current;
    setExporting(true);
    try {
      const result = await api.get<{ csv: string; filename: string; exported: number }>(`/api/crm/contacts/export?${crmContactParams(filters)}`);
      if (generation !== scopeGeneration.current) return;
      const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8;' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename || 'crm-contacts.csv'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
      toast({ title: 'Contacts exported', description: `${result.exported} matching contacts included.` });
    } catch (cause) { if (generation === scopeGeneration.current) toast({ title: 'Export could not be created', description: cause instanceof Error ? cause.message : 'Try a narrower filter and export again.', variant: 'destructive' }); }
    finally { if (generation === scopeGeneration.current) setExporting(false); }
  };
  const applyBulk = async () => {
    if (!selectedIds.length || bulkBusy) return;
    const addTags = [...new Set(bulkTags.split(',').map(tag => tag.trim()).filter(Boolean))];
    if (bulkStage === 'unchanged' && bulkOwner === 'unchanged' && !addTags.length) return;
    const generation = scopeGeneration.current;
    setBulkBusy(true);
    try {
      const response = await api.post<BulkResult | {data:BulkResult}>('/api/crm/contacts/bulk', {
        contactIds: selectedIds, ...(addTags.length ? { addTags } : {}), ...(bulkStage !== 'unchanged' ? { pipelineStatus: bulkStage } : {}), ...(bulkOwner !== 'unchanged' ? { ownerUserId: bulkOwner === 'unassigned' ? null : Number(bulkOwner) } : {}),
      });
      if (generation !== scopeGeneration.current) return;
      const result = 'data' in response ? response.data : response;
      setBulkRecovery((result.contacts||[]).filter(contact=>contact.automationReviewRequired||contact.refreshRequired));
      toast(result.automationReviewRequired ? contactSavedToast(result) : { title: 'Selected contacts updated', description: `${result.updatedCount} contacts updated.` });
      setSelectedIds([]); setBulkTags(''); setBulkStage('unchanged'); setBulkOwner('unchanged'); await refreshCurrent.current();
    } catch (cause) { if (generation === scopeGeneration.current) toast({ title: 'Contacts could not be updated', description: cause instanceof Error ? cause.message : 'Review your selection and try again.', variant: 'destructive' }); }
    finally { if (generation === scopeGeneration.current) setBulkBusy(false); }
  };
  const deleteContact = async (id: number) => {
    if (!window.confirm('Remove this contact from CRM? Linked lead and outreach history will be preserved.')) return;
    const generation = scopeGeneration.current;
    try { await api.delete(`/api/crm/contacts/${id}`); if (generation !== scopeGeneration.current) return; toast({ title: 'Contact deleted' }); await refreshCurrent.current(); }
    catch (cause) { if (generation === scopeGeneration.current) toast({ title: 'Contact could not be deleted', description: cause instanceof Error ? cause.message : undefined, variant: 'destructive' }); }
  };
  const syncToOutreach = async () => {
    if (!confirmDiscard()) return;
    const generation = scopeGeneration.current;
    setSyncingToOutreach(true);
    try { const result = await api.post<{ synced: number; message: string }>('/api/crm/contacts/sync-to-leads', {}); if (generation !== scopeGeneration.current) return; toast({ title: 'Sync complete', description: result.message }); if (result.synced > 0) { confirmDiscard.clearGuard(); router.push('/dashboard/outreach/create'); } }
    catch { if (generation === scopeGeneration.current) toast({ title: 'Contacts could not be prepared for outreach', variant: 'destructive' }); }
    finally { if (generation === scopeGeneration.current) setSyncingToOutreach(false); }
  };
  const startEdit = (contact: CrmContact) => {
    if (editingContactId !== null && editingContactId !== contact.id && !confirmDiscard()) return;
    setEditingContactId(contact.id); setInlineError(null); setEditForm({ company: contact.company || '', dealValue: contact.dealValue || '', pipelineStatus: contact.pipelineStatus || 'new' });
  };
  const cancelEdit = () => { if (confirmDiscard()) { confirmDiscard.clearGuard(); setEditingContactId(null); setInlineError(null); } };
  const saveInline = async (contact: CrmContact) => {
    if (saving) return;
    if (!validContactAmount(editForm.dealValue)) { setInlineError('Enter a non-negative deal value with at most two decimal places.'); return; }
    const generation = scopeGeneration.current;
    setSaving(true); setInlineError(null);
    try {
      const saved = await api.put<CrmMutationResult>(`/api/crm/contacts/${contact.id}`, { company: editForm.company.trim() || null, dealValue: editForm.dealValue || null, pipelineStatus: editForm.pipelineStatus, ...(contact.updatedAt ? { expectedUpdatedAt: contact.updatedAt } : {}) });
      if (generation !== scopeGeneration.current) return;
      confirmDiscard.clearGuard(); setEditingContactId(null); toast(contactSavedToast(saved)); await refreshCurrent.current();
    } catch (cause) { if (generation === scopeGeneration.current) setInlineError(cause instanceof Error ? cause.message : 'Changes could not be saved. Your edits are preserved.'); }
    finally { if (generation === scopeGeneration.current) setSaving(false); }
  };
  const selectAll = contacts.length > 0 && contacts.every(contact => selectedIds.includes(contact.id));
  const filtered = Object.entries(filters).some(([key, value]) => key in DEFAULT_CONTACT_FILTERS ? value !== DEFAULT_CONTACT_FILTERS[key as keyof CrmContactFilters] : Boolean(value));

  const activeFilters = [
    { key: 'pipelineStatus', label: 'Stage', value: pipelineStages.find(stage => stage.key === filters.pipelineStatus)?.label || filters.pipelineStatus },
    { key: 'priority', label: 'Priority', value: filters.priority },
    { key: 'ownerUserId', label: 'Assigned to', value: assignees.find(user => String(user.id) === filters.ownerUserId)?.name || (filters.ownerUserId === 'unassigned' ? 'Unassigned' : filters.ownerUserId) },
    { key: 'followup', label: 'Follow-up', value: filters.followup === 'none' ? 'No pending follow-up' : filters.followup },
    { key: 'tag', label: 'Tag', value: filters.tag },
    { key: 'sortBy', label: 'Sort', value: { lastActivityAt: 'Last activity', createdAt: 'Created date', name: 'Name', dealValue: 'Deal value', priority: 'Priority', nextFollowUpAt: 'Next follow-up' }[filters.sortBy || 'lastActivityAt'] },
    { key: 'sortOrder', label: 'Order', value: filters.sortOrder === 'asc' ? 'Ascending' : 'Descending' },
  ].filter(item => filters[item.key as keyof CrmContactFilters] !== DEFAULT_CONTACT_FILTERS[item.key as keyof CrmContactFilters] && item.value);

  return <PageShell maxWidth="2xl" padding="sm" className="space-y-3">
    <PageHeader icon={Users} title="Contacts" subtitle="Find the right person, decide the next step, and keep their history together." className="gap-3 pb-3" actions={<>
      <Button onClick={() => setShowCreateDialog(true)}><UserPlus className="mr-2 h-4 w-4" />Add Contact</Button>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline"><MoreHorizontal className="mr-2 h-4 w-4" />More actions</Button></DropdownMenuTrigger><DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => navigate('/dashboard/leads/new?returnTo=/dashboard/crm/contacts')}>Add Lead</DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate('/dashboard/crm/import/analyze')}>Import</DropdownMenuItem>
        <DropdownMenuItem disabled={exporting} onClick={() => void exportContacts()}>{exporting ? <Spinner size="sm" label={null} className="mr-2" /> : <Download className="mr-2 h-4 w-4" />}Export filtered CSV</DropdownMenuItem>
        <DropdownMenuItem disabled={syncingToOutreach} onClick={() => void syncToOutreach()}>{syncingToOutreach ? <Spinner size="sm" label={null} className="mr-2" /> : <RefreshCw className="mr-2 h-4 w-4" />}Sync to Email Outreach</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate('/dashboard/crm/configuration')}><Settings2 className="mr-2 h-4 w-4" />CRM Configuration</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
    </>} />
    <CrmNavigation current="contacts" includeLeads />
    {bulkRecovery.length>0&&<Alert><AlertTitle>Selected contacts saved; follow-up review needed</AlertTitle><AlertDescription><ul>{bulkRecovery.map(contact=><li key={contact.id}><Link className="underline" href={`/dashboard/crm/contacts/${contact.id}?tab=activity#${contact.automationTransitionId?`automation-transition-${contact.automationTransitionId}`:'automation-recovery'}`}>Review contact #{contact.id}{contact.automationTransitionId?` · transition #${contact.automationTransitionId}`:''}</Link></li>)}</ul><Button size="sm" variant="outline" onClick={()=>setBulkRecovery([])}>Dismiss saved result</Button></AlertDescription></Alert>}
    <details className="rounded-lg border border-border bg-card">
      <summary className="cursor-pointer rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">CRM metrics</summary>
      <dl className="grid gap-3 border-t border-border px-3 py-2 sm:grid-cols-3">{[{ label: 'Total contacts', value: analytics?.totalContacts ?? '—' }, { label: 'Win rate', value: analytics ? `${analytics.winRate.toFixed(1)}%` : '—' }, { label: 'Pipeline value', value: analytics ? formatCurrencyBreakdown(analytics.pipelineValueByCurrency, { compact: true }) : '—' }].map(stat => <div key={stat.label}><dt className="text-xs text-muted-foreground">{stat.label}</dt><dd className="mt-1 font-mono text-sm font-semibold">{stat.value}</dd></div>)}</dl>
    </details>
    {analyticsError && <Alert variant="destructive"><AlertTitle>CRM analytics could not be loaded</AlertTitle><AlertDescription>{analyticsError}<Button className="ml-3" size="sm" variant="outline" onClick={() => void fetchAnalytics()}>Try again</Button></AlertDescription></Alert>}
    {configurationError && <Alert variant="destructive"><AlertTitle>Saved stages could not be loaded</AlertTitle><AlertDescription>{configurationError}<Button className="ml-3" size="sm" variant="outline" onClick={reloadConfiguration}>Reload stages</Button></AlertDescription></Alert>}
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-64"><Label htmlFor="contacts-directory-search" className="text-xs">Search contacts</Label><SearchInput id="contacts-directory-search" aria-label="Search contacts" wrapperClassName="mt-1" value={filters.search || ''} placeholder="Name, email or company" onValueChange={value => changeFilters({ ...filters, search: value })} /></div>
        <div className="min-w-0 flex-1 basis-48"><Label htmlFor="saved-contact-view" className="text-xs">Saved view</Label><select id="saved-contact-view" className={`${crmSelectClass} mt-1`} value={selectedView} onChange={event => { const view = savedViews.find(item => item.id === event.target.value); if (!confirmDiscard()) return; confirmDiscard.clearGuard(); setEditingContactId(null); setSelectedView(event.target.value); if (view) { setFilters({ ...view.filters }); setPage(1); } }}><option value="">Current filters</option>{savedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select></div><Button variant="outline" size="sm" disabled={!userId} onClick={() => setViewDialog(true)}><Save className="mr-2 h-4 w-4" />Save view</Button>{selectedView && <Button variant="ghost" size="sm" onClick={removeView}>Remove view</Button>}<span className="text-xs text-muted-foreground">Saved for your account and this business.</span></div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-xs text-muted-foreground">{loading ? 'Loading contacts…' : `${total} matching contacts`} · {analytics ? `${analytics.totalContacts} total contacts` : 'Counting contacts…'}</p>
        <Button variant="outline" size="sm" aria-expanded={filtersOpen} aria-controls="advanced-contact-filters" onClick={() => setFiltersOpen(open => !open)}><Filter className="mr-2 h-3.5 w-3.5" />Advanced filters{activeFilters.length ? ` (${activeFilters.length})` : ''}</Button>
      </div>
      {activeFilters.length > 0 && <div aria-label="Active contact filters" className="flex flex-wrap gap-2">{activeFilters.map(item => <Button key={item.key} variant="outline" size="sm" className="h-auto min-h-8 max-w-full gap-2 py-1 text-xs" aria-label={`Remove ${item.label.toLowerCase()} filter`} aria-describedby={`active-contact-filter-${item.key}`} onClick={() => changeFilters({ ...filters, [item.key]: DEFAULT_CONTACT_FILTERS[item.key as keyof CrmContactFilters] })}><span id={`active-contact-filter-${item.key}`} className="min-w-0 break-all text-left">{item.label}: {item.value}</span><X aria-hidden="true" className="h-3 w-3 shrink-0" /></Button>)}</div>}
      <div id="advanced-contact-filters" hidden={!filtersOpen}><CrmCollectionFilters value={filters} onChange={changeFilters} stages={pipelineStages} assignees={assignees} ownerError={assigneeError} showSearch={false} /></div>
      {(filters.platforms?.length || filters.dateRange) && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-xs"><span>Report contacts · {filters.platforms?.join(', ') || 'All platforms'} · {filters.dateRange === 'custom' ? `${filters.from} to ${filters.to}` : filters.dateRange || 'All dates'} · based on contact creation date</span><Button size="sm" variant="ghost" onClick={clearReportFilters}>Clear report filters</Button></div>}
    </div>
    {selectedIds.length > 0 && <section aria-label="Update selected contacts" className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4"><div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">{selectedIds.length} selected on this page</p><Button variant="ghost" size="sm" disabled={bulkBusy} onClick={() => setSelectedIds([])}>Clear selection</Button></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div><Label htmlFor="bulk-contact-stage" className="text-xs">Move to stage</Label><select id="bulk-contact-stage" className={`${crmSelectClass} mt-1.5`} value={bulkStage} disabled={bulkBusy || Boolean(configurationError)} onChange={event => setBulkStage(event.target.value)}><option value="unchanged">Keep stage</option>{configuredStages.map(stage => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></div><div><Label htmlFor="bulk-contact-owner" className="text-xs">Assign to</Label><select id="bulk-contact-owner" className={`${crmSelectClass} mt-1.5`} value={bulkOwner} disabled={bulkBusy || assigneesLoading || Boolean(assigneeError)} onChange={event => setBulkOwner(event.target.value)}><option value="unchanged">Keep assignment</option><option value="unassigned">Unassigned</option>{assignees.map(user => <option key={user.id} value={user.id}>{user.name || user.email}</option>)}</select></div><div><Label htmlFor="bulk-contact-tags" className="text-xs">Add tags</Label><Input id="bulk-contact-tags" className="mt-1.5 h-10" value={bulkTags} disabled={bulkBusy} placeholder="customer, follow-up" maxLength={500} onChange={event => setBulkTags(event.target.value)} /></div><Button className="self-end" loading={bulkBusy} disabled={bulkStage === 'unchanged' && bulkOwner === 'unchanged' && !bulkTags.trim()} onClick={applyBulk}>Apply to selected</Button></div><p className="text-xs text-muted-foreground">Only the checked contacts will change. Selection clears when you change filters or pages.</p></section>}
    {contactsError ? <Alert variant="destructive"><AlertTitle>Contacts could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{contactsError}</span><Button size="sm" variant="outline" onClick={() => void fetchContacts()}>Try again</Button></AlertDescription></Alert> : loading ? <div aria-label="Loading contacts" className="space-y-3 rounded-xl border border-border p-4">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-14 w-full" />)}</div> : contacts.length === 0 ? <div className="rounded-xl border border-dashed border-border py-16 text-center"><Users className="mx-auto mb-3 h-6 w-6 text-muted-foreground" /><h2 className="text-sm font-semibold">No contacts found</h2><p className="mt-2 text-sm text-muted-foreground">{filtered ? 'No contacts match these filters.' : 'Add a contact or import a CSV to start building relationships.'}</p><Button className="mt-4" variant="outline" onClick={() => filtered ? changeFilters({ ...DEFAULT_CONTACT_FILTERS }) : setShowCreateDialog(true)}>{filtered ? 'Clear filters' : 'Add contact'}</Button></div> : <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3"><label className="flex min-h-8 cursor-pointer items-center gap-3 text-xs font-medium"><input type="checkbox" className="h-4 w-4 accent-primary" checked={selectAll} disabled={bulkBusy} onChange={event => setSelectedIds(event.target.checked ? contacts.map(contact => contact.id).slice(0, 100) : [])} />Select this page</label><p className="text-xs text-muted-foreground">{contacts.length} of {total} contacts</p></div>
      {contacts.map(contact => { const name = contactName(contact); const stage = pipelineStages.find(item => item.key === (contact.pipelineStatus || 'new')); const editing = editingContactId === contact.id; const assignee = assignees.find(user => user.id === contact.assignedTo); return <article key={contact.id} className="border-b border-border p-4 last:border-b-0 hover:bg-muted/20"><div className="flex items-start gap-3"><input type="checkbox" aria-label={`Select ${name}`} className="mt-2 h-4 w-4 shrink-0 accent-primary" checked={selectedIds.includes(contact.id)} disabled={bulkBusy} onChange={() => toggleContact(contact.id)} /><div className="grid min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(160px,1fr)_minmax(140px,180px)_140px_120px] lg:items-center"><div className="min-w-0"><Link className="block truncate text-sm font-semibold hover:text-primary focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={`/dashboard/crm/contacts/${contact.id}`}>{name}</Link><p className="mt-1 truncate text-xs text-muted-foreground">{contact.email || contact.phone || 'No contact address'}</p>{contact.tags?.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{contact.tags.slice(0, 4).map(tag => <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>)}</div>}</div>
      {editing ? <><Input aria-label="Company" value={editForm.company} onChange={event => setEditForm(form => ({ ...form, company: event.target.value }))} /><select aria-label="Pipeline stage" className={crmSelectClass} value={editForm.pipelineStatus} disabled={Boolean(configurationError)} onChange={event => setEditForm(form => ({ ...form, pipelineStatus: event.target.value }))}>{pipelineStages.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select><Input aria-label="Deal value" type="number" min="0" step="0.01" value={editForm.dealValue} onChange={event => setEditForm(form => ({ ...form, dealValue: event.target.value }))} /></> : <><div className="text-xs text-muted-foreground"><p className="truncate">{contact.company || 'No company'}</p><p className="mt-1 truncate">{assignee?.name || contact.ownerName || (contact.assignedTo ? 'Assigned team member' : 'Unassigned')}{contact.priority ? ` · ${contact.priority} priority` : ''}</p>{contact.nextFollowUpAt && <p className="mt-1">Follow up {new Date(contact.nextFollowUpAt).toLocaleDateString()}</p>}</div><Badge className="w-fit text-[11px]" style={crmStageBadgeStyle(stage)}>{stage?.label || contact.pipelineStatus}</Badge><span className="text-xs font-medium">{contact.dealValue ? formatCurrencyAmount(contact.dealValue, contact.currency || 'USD') : '—'}</span></>}</div>
      <div className="flex shrink-0 items-center gap-1">{editing ? <><Button size="sm" loading={saving} disabled={Boolean(configurationError)} onClick={() => void saveInline(contact)}>Save</Button><Button aria-label="Discard contact changes" variant="ghost" size="icon" disabled={saving} onClick={cancelEdit}><X className="h-4 w-4" /></Button></> : <><Button variant="ghost" size="icon" className="hidden sm:flex" aria-label={`Edit ${name}`} onClick={() => startEdit(contact)}><Edit className="h-4 w-4" /></Button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`More actions for ${name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => navigate(`/dashboard/crm/contacts/${contact.id}`)}><Eye className="mr-2 h-4 w-4" />View contact</DropdownMenuItem><DropdownMenuItem onClick={() => startEdit(contact)}><Edit className="mr-2 h-4 w-4" />Edit contact</DropdownMenuItem><DropdownMenuItem onClick={() => { setSelectedContact(contact); setShowConversationDialog(true); }}><MessageSquare className="mr-2 h-4 w-4" />Send outreach</DropdownMenuItem><DropdownMenuItem onClick={() => navigate(`/dashboard/crm/reminders?contactId=${contact.id}&contactName=${encodeURIComponent(name)}`)}><Calendar className="mr-2 h-4 w-4" />Add reminder</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onClick={() => void deleteContact(contact.id)}><Trash2 className="mr-2 h-4 w-4" />Delete contact</DropdownMenuItem></DropdownMenuContent></DropdownMenu></>}</div></div>{editing && inlineError && <p role="alert" className="mt-3 text-sm text-destructive">{inlineError}</p>}</article>; })}
      <Pagination className="border-t border-border px-4 py-3" page={page} pageSize={pageSize} totalItems={total} pageSizeOptions={[10, 20, 50, 100]} itemLabel="contacts" onPageChange={next => { if (!confirmDiscard()) return; confirmDiscard.clearGuard(); setEditingContactId(null); setPage(next); }} onPageSizeChange={size => { if (!confirmDiscard()) return; confirmDiscard.clearGuard(); setEditingContactId(null); setPageSize(size); setPage(1); }} />
    </div>}
    <Dialog open={viewDialog} onOpenChange={setViewDialog}><DialogContent><DialogHeader><DialogTitle>Save contact view</DialogTitle><DialogDescription>Keep these filters and sorting for this account and business.</DialogDescription></DialogHeader><Label htmlFor="contact-view-name">View name</Label><Input id="contact-view-name" value={viewName} maxLength={80} placeholder="My overdue follow-ups" onChange={event => setViewName(event.target.value)} /><DialogFooter><Button variant="outline" onClick={() => setViewDialog(false)}>Cancel</Button><Button disabled={!viewName.trim() || !userId} onClick={saveView}>Save view</Button></DialogFooter></DialogContent></Dialog>
    <CreateContactDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} onCreated={() => { void fetchContacts(); void fetchAnalytics(); }} />
    {selectedContact && <CreateConversationDialog open={showConversationDialog} onOpenChange={setShowConversationDialog} contactId={selectedContact.id} contactName={contactName(selectedContact)} leadId={selectedContact.leadId} />}
  </PageShell>;
}
