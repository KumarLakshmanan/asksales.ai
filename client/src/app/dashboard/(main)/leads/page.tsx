"use client";

import { Fragment, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import tableStyles from './leads-table.module.css';
import { leadColumnPreferenceKey, leadSourceLabel, optionalLeadColumns, parseLeadColumnPreferences, type OptionalLeadColumn } from '@/lib/lead-directory-display';
import { api } from '@/lib/api';
import { LEAD_EXPORT_LIMIT } from '../../../../../../shared/leadExport';
import { formatLeadStatus, getLeadStatus, getLeadStatusOptions } from '../../../../../../shared/leadStatus';
import {
  Filter,
  ChevronLeft,
  ChevronRight,
  Plus,
  Eye,
  Edit,
  Trash2,
  Users,
  Calculator,
  RefreshCw,
  ShieldCheck,
  MoreVertical,
  Megaphone,
  Send,
  UserPlus,
  Download,
  AlertCircle,
} from "lucide-react";
import { LeadTableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { Callout } from "@/components/ui/callout";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { PageEmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { CreateContactDialog } from "@/components/crm/CreateContactDialog";
import { PeopleDirectoryNav } from "@/components/crm/PeopleDirectoryNav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

interface Lead {
  id: number;
  name: string | null;
  company: string | null;
  role: string | null;
  email: string;
  phone: string | null;
  linkedin: string | null;
  score: number;
  source: string;
  status: string | null;
  leadStatus: string | null;
  createdAt: string;
  platformType?: string;
  fitScore?: number;
  relevanceScore?: number;
  repliedEmails?: number;
  messagesReceived?: number;
  firstContactedAt?: string | null;
  campaignData?: { campaignName?: string; threadId?: number } | null;
}

interface PaginatedResponse {
  data: Lead[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  statuses?: string[];
}

interface LeadStatsResponse {
  success: boolean;
  stats: {
    total: number;
    new: number;
    contacted: number;
    engaged: number;
    qualified: number;
    converted: number;
    unqualified: number;
    highQuality: number;
    avgScore: number;
    engagementRate: number;
    conversionRate: number;
    pipelineValue: number;
    sources: Record<string, number>;
    regions: Array<{ name: string; count: number }>;
    platforms: Record<string, number>;
  };
}

// Lead pipeline stages that the shared status map doesn't cover.
const LEAD_STATUS_TONES: Record<string, StatusTone> = {
  contacted: "warning",
  engaged: "progress",
  qualified: "success",
  converted: "success",
};

export default function LeadsPage() {
  const { toast } = useToast();
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [totalLeads, setTotalLeads] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [loadedFilterQuery, setLoadedFilterQuery] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [_isDeletingId, setIsDeletingId] = useState<number | null>(null);
  const [scoringLeadId, setScoringLeadId] = useState<number | null>(null);
  const [enrichingLeadId, setEnrichingLeadId] = useState<number | null>(null);
  const [validatingEmailId, setValidatingEmailId] = useState<number | null>(null);
  const [activeTimeFilter, setActiveTimeFilter] = useState("all");
  const [showCreateContactDialog, setShowCreateContactDialog] = useState(false);
  const createContactOpener = useRef<HTMLButtonElement | null>(null);

  const [processingLeadId, setProcessingLeadId] = useState<number | null>(null);
  const [editingLeadId, setEditingLeadId] = useState<number | null>(null);
  const [savingLeadId, setSavingLeadId] = useState<number | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [editLeadForm, setEditLeadForm] = useState<{ name: string; company: string; role: string }>({ name: "", company: "", role: "" });

  // Real analytics data from API
  const [leadStats, setLeadStats] = useState<LeadStatsResponse['stats'] | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);

  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    leadId: number | null;
    onConfirm: () => void;
    title: string;
    description: string;
  }>({
    open: false,
    leadId: null,
    onConfirm: () => { },
    title: '',
    description: ''
  });

  const [selectedLeads, setSelectedLeads] = useState<number[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [availableStatuses, setAvailableStatuses] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [scoreRangeFilter, setScoreRangeFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<string>("created_at_desc");

  const tableScrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [expandedLeadIds, setExpandedLeadIds] = useState<number[]>([]);
  const [optionalColumns, setOptionalColumns] = useState<OptionalLeadColumn[]>([]);
  useEffect(() => {
    try {
      setOptionalColumns(parseLeadColumnPreferences(window.localStorage.getItem(leadColumnPreferenceKey)));
    } catch { /* Storage may be unavailable. */ }
  }, []);
  const updateOptionalColumns = (columns: OptionalLeadColumn[]) => {
    setOptionalColumns(columns);
    try {
      window.localStorage.setItem(leadColumnPreferenceKey, JSON.stringify(columns));
    } catch { /* Keep in-memory preferences. */ }
  };
  const visibleOptionalColumns = optionalLeadColumns.filter(column => optionalColumns.includes(column.key));
  const toggleLeadDetails = (id: number) => {
    if (tableScrollRef.current && !expandedLeadIds.includes(id)) tableScrollRef.current.scrollLeft = 0;
    setExpandedLeadIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  };
  const engagementLabel = (lead: Lead) => (lead.repliedEmails || 0) > 0 || (lead.messagesReceived || 0) > 0
    ? 'Replied' : lead.firstContactedAt ? 'Contacted' : 'None';
  const secondaryValue = (lead: Lead, key: OptionalLeadColumn) => {
    if (key === 'source') return leadSourceLabel(lead.source);
    if (key === 'campaign') {
      const campaignName = lead.campaignData?.campaignName;
      return typeof campaignName === 'string' && campaignName ? campaignName : leadSourceLabel(lead.source);
    }
    return lead[key] || '—';
  };
  const renderLeadDetails = (lead: Lead, editable = false) => (
    <dl className="grid gap-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {([
        ['name', 'Name', lead.name || lead.email || `Lead #${lead.id}`],
        ['company', 'Company', lead.company || '—'],
        ['role', 'Role', lead.role || '—'],
        ['email', 'Email', lead.email || '—'],
        ['phone', 'Phone', lead.phone || '—'],
        ['campaign', 'Campaign', secondaryValue(lead, 'campaign')],
        ['source', 'Source', leadSourceLabel(lead.source)],
      ] as const).map(([key, label, value]) => (
        <div key={key} className="min-w-0">
          <dt className="mb-1 text-xs font-medium text-muted-foreground">{label}</dt>
          <dd className="break-words [overflow-wrap:anywhere]">
            {editable && editingLeadId === lead.id && (key === 'name' || key === 'company' || key === 'role') ? (
              <input
                autoFocus={key === 'name'}
                aria-label={`Edit ${label.toLowerCase()}`}
                placeholder={label}
                className="w-full rounded border border-input bg-background px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={editLeadForm[key]}
                onChange={e => setEditLeadForm(form => ({ ...form, [key]: e.target.value }))}
              />
            ) : value}
          </dd>
        </div>
      ))}
    </dl>
  );

  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (statusFilter) params.set('status', statusFilter);
    if (sourceFilter) params.set('source', sourceFilter);
    if (scoreRangeFilter) params.set('scoreRange', scoreRangeFilter);
    if (sortBy) params.set('sortBy', sortBy);
    if (activeTimeFilter !== 'all') params.set('timeFilter', activeTimeFilter);
    return params.toString();
  }, [debouncedSearch, statusFilter, sourceFilter, scoreRangeFilter, sortBy, activeTimeFilter]);
  const hasExportFilters = Boolean(debouncedSearch || statusFilter || sourceFilter || scoreRangeFilter || activeTimeFilter !== 'all');
  const exportCount = selectedLeads.length || totalLeads;
  const exportScope = selectedLeads.length ? 'selected' : hasExportFilters ? 'filtered' : 'all';
  // Before the first list response the count is unknown, not zero.
  const exportLabel = isLoading && !leads.length ? `Export ${exportScope}` : `Export ${exportScope} (${exportCount.toLocaleString()})`;
  const exportUnavailable = isLoading || Boolean(loadError) || loadedFilterQuery !== filterQuery
    || searchQuery.trim() !== debouncedSearch || exportCount === 0 || exportCount > LEAD_EXPORT_LIMIT;

  const leadRequestVersion = useRef(0);
  const fetchLeads = useCallback(async () => {
    const requestVersion = ++leadRequestVersion.current;
    try {
      setIsLoading(true);
      setLoadError(null);

      const data = await api.get<PaginatedResponse>(`/api/leads?page=${currentPage}&pageSize=${pageSize}&${filterQuery}`);
      if (requestVersion !== leadRequestVersion.current) return;
      if (!data || !Array.isArray(data.data)) throw new Error('The server returned an invalid lead list. Please retry.');
      if (currentPage > Math.max(1, data.totalPages)) {
        setCurrentPage(Math.max(1, data.totalPages));
        return;
      }
      setLeads(data.data);
      setAvailableStatuses(data.statuses || []);
      setTotalLeads(data.total);
      setLoadedFilterQuery(filterQuery);
      setTotalPages(data.totalPages);
    } catch (error) {
      if (requestVersion !== leadRequestVersion.current) return;
      setLoadError(error instanceof Error ? error.message : "Failed to fetch leads");
    } finally {
      if (requestVersion === leadRequestVersion.current) setIsLoading(false);
    }
  }, [currentPage, pageSize, filterQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    fetchLeads();
    return () => { leadRequestVersion.current += 1; };
  }, [fetchLeads]);

  // Fetch real analytics stats
  const fetchLeadStats = useCallback(async () => {
    try {
      setStatsLoading(true);
      setStatsError(false);
      const data = await api.get<LeadStatsResponse>("/api/leads/stats");
      if (data.success) {
        setLeadStats(data.stats);
      }
    } catch {
      setStatsError(true);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLeadStats();
  }, [fetchLeadStats]);

  const handleExport = async () => {
    if (isExporting || exportUnavailable) return;
    const scope = exportScope;
    try {
      setIsExporting(true);
      const csvText = selectedLeads.length
        ? await api.post<string>(`/api/leads/export?format=csv&sortBy=${encodeURIComponent(sortBy)}`, { ids: selectedLeads })
        : await api.get<string>(`/api/leads/export?format=csv&${filterQuery}`);
      const blob = new Blob([csvText], { type: "text/csv" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leads-${scope}-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Success",
        description: `Exported ${scope === 'selected' ? 'the selected leads' : scope === 'filtered' ? 'all matching leads across every page' : 'all leads in this business'}.`,
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Failed to export leads",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const showDeleteConfirm = (leadId: number, leadName: string) => {
    setConfirmDialog({
      open: true,
      leadId,
      onConfirm: () => handleDeleteLead(leadId),
      title: 'Delete Lead',
      description: `Are you sure you want to delete ${leadName}? This action cannot be undone.`
    });
  };

  const handleDeleteLead = async (leadId: number) => {
    try {
      setIsDeletingId(leadId);
      setProcessingLeadId(leadId);
      await api.delete(`/api/leads/${leadId}`);
      setSelectedLeads((previous) => previous.filter((id) => id !== leadId));
      await Promise.all([fetchLeads(), fetchLeadStats()]);
      toast({
        title: "Success",
        description: "Lead deleted successfully",
      });
    } catch (_error) {
      toast({
        title: "Error",
        description: "Failed to delete lead",
        variant: "destructive",
      });
    } finally {
      setIsDeletingId(null);
      setProcessingLeadId(null);
      setConfirmDialog({ open: false, leadId: null, onConfirm: () => { }, title: '', description: '' });
    }
  };

  const handleToggleLeadSelection = (leadId: number) => {
    setSelectedLeads(prev =>
      prev.includes(leadId)
        ? prev.filter(id => id !== leadId)
        : [...prev, leadId]
    );
  };

  const handleSelectAllLeads = () => {
    const visibleIds = leads.map((lead) => lead.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedLeads.includes(id));
    if (allVisibleSelected) {
      setSelectedLeads((previous) => previous.filter((id) => !visibleIds.includes(id)));
    } else {
      setSelectedLeads((previous) => Array.from(new Set([...previous, ...visibleIds])));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedLeads.length === 0 || bulkDeleting) return;
    try {
      setBulkDeleting(true);
      const result = await api.post<{ deletedCount: number }>("/api/leads/bulk-delete", { ids: selectedLeads });
      toast({ title: "Leads deleted", description: `Deleted ${result.deletedCount} lead${result.deletedCount === 1 ? "" : "s"}.` });
      setSelectedLeads([]);
      await Promise.all([fetchLeads(), fetchLeadStats()]);
    } catch {
      toast({ title: "Error", description: "Failed to delete selected leads", variant: "destructive" });
    } finally {
      setBulkDeleting(false);
    }
  };

  const showBulkDeleteConfirm = () => {
    setConfirmDialog({
      open: true,
      leadId: null,
      onConfirm: () => { void handleBulkDelete(); },
      title: 'Delete selected leads',
      description: `Delete ${selectedLeads.length} selected lead${selectedLeads.length === 1 ? '' : 's'}? This action cannot be undone.`,
    });
  };

  const handleStartLeadInlineEdit = (lead: Lead, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tableScrollRef.current) tableScrollRef.current.scrollLeft = 0;
    setEditingLeadId(lead.id);
    setExpandedLeadIds(ids => ids.includes(lead.id) ? ids : [...ids, lead.id]);
    setEditLeadForm({ name: lead.name || "", company: lead.company || "", role: lead.role || "" });
  };

  const handleLeadInlineUpdate = async (leadId: number) => {
    if (savingLeadId !== null) return;
    if (!editLeadForm.name.trim()) {
      toast({ title: "Name required", description: "Use the full edit page to change all identity fields.", variant: "destructive" });
      return;
    }
    try {
      setSavingLeadId(leadId);
      await api.put(`/api/leads/${leadId}`, {
        name: editLeadForm.name.trim(),
        company: editLeadForm.company || null,
        role: editLeadForm.role || null,
      });
      setLeads((prev) =>
        prev.map((l) =>
          l.id === leadId
            ? { ...l, name: editLeadForm.name.trim(), company: editLeadForm.company || null, role: editLeadForm.role || null }
            : l
        )
      );
      toast({ title: "Lead updated" });
      setEditingLeadId(null);
    } catch {
      toast({ title: "Error", description: "Failed to save changes", variant: "destructive" });
    } finally {
      setSavingLeadId(null);
    }
  };

  const handleAssignToOutreach = () => {
    if (selectedLeads.length === 0) {
      toast({ title: "No leads selected", description: "Select at least one lead to review outreach.", variant: "destructive" });
      return;
    }
    if (selectedLeads.length > 500) {
      toast({ title: "Too many leads", description: "Choose up to 500 leads for one outreach batch.", variant: "destructive" });
      return;
    }
    router.push(`/dashboard/outreach/create?channel=email&leadIds=${selectedLeads.join(",")}`);
  };

  const handleStartOutreach = (leadId: number) => {
    router.push(`/dashboard/outreach/create?channel=email&leadId=${leadId}`);
  };

  const handleScoreLead = async (leadId: number) => {
    try {
      setScoringLeadId(leadId);
      setProcessingLeadId(leadId);

      const data = await api.post<{ success: boolean; score: number; error?: string; warning?: string }>(`/api/leads/${leadId}/score`, {});
      if (data.success) {
        toast({
          title: data.warning ? `Rule-based score: ${data.score}/100` : "Score Generated",
          description: data.warning || `Lead scored: ${data.score}/100`,
        });
        setLeads(prev => prev.map(l => l.id === leadId ? { ...l, score: data.score } : l));
      } else {
        throw new Error(data.error || "Failed to generate score");
      }
    } catch (error) {
      toast({
        title: "Scoring Error",
        description: error instanceof Error ? error.message : "Failed to generate score",
        variant: "destructive",
      });
    } finally {
      setScoringLeadId(null);
      setProcessingLeadId(null);
    }
  };

  const handleEnrichLead = async (leadId: number) => {
    try {
      setEnrichingLeadId(leadId);
      setProcessingLeadId(leadId);

      const data = await api.post<{ success: boolean; message?: string; error?: string }>(`/api/leads/${leadId}/enrich`);
      if (data.success) {
        toast({
          title: "Enrichment Complete",
          description: data.message || "Lead data enriched successfully",
        });
        fetchLeads();
      } else {
        throw new Error(data.error || "Failed to enrich lead");
      }
    } catch (error) {
      toast({
        title: "Enrichment Error",
        description: error instanceof Error ? error.message : "Failed to enrich lead",
        variant: "destructive",
      });
    } finally {
      setEnrichingLeadId(null);
      setProcessingLeadId(null);
    }
  };

  const handleValidateEmail = async (leadId: number) => {
    try {
      setValidatingEmailId(leadId);
      setProcessingLeadId(leadId);

      const data = await api.post<{ success: boolean; verified?: boolean; email?: string; status?: string; error?: string }>(`/api/leads/${leadId}/validate-email`);
      if (data.success) {
        const statusLabel = data.verified ? "Valid" : data.status?.replace("_", " ") || "Invalid";
        toast({
          title: "Email Validated",
          description: `${data.email}: ${statusLabel}`,
          variant: data.verified ? "default" : "destructive",
        });
        fetchLeads();
      } else {
        throw new Error(data.error || "Failed to validate email");
      }
    } catch (error) {
      toast({
        title: "Validation Error",
        description: error instanceof Error ? error.message : "Failed to validate email",
        variant: "destructive",
      });
    } finally {
      setValidatingEmailId(null);
      setProcessingLeadId(null);
    }
  };

  const getSourceColor = (source: string) => {
    const s = source?.toLowerCase() || '';
    if (s === 'linkedin') return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
    if (s === 'twitter') return 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300';
    if (s === 'instagram' || s === 'instagram_webhook') return 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300';
    if (s === 'facebook' || s === 'facebook_webhook') return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300';
    if (s === 'email' || s === 'inbound_email') return 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300';
    if (s === 'google-maps') return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
    if (s === 'google search') return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300';
    if (s === 'whatsapp') return 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300';
    if (s === 'justdial') return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300';
    if (s === 'manual' || s === 'manual_entry') return 'bg-muted text-muted-foreground';
    return 'bg-secondary text-secondary-foreground';
  };

  // Analytics must represent the complete dataset; never substitute page-local
  // counts because that would make global KPI labels inaccurate.
  // The table has settled with no leads at all (no filters): every KPI is zero,
  // even if the stats request is still running. Shimmer only while nothing is known.
  const leadsSettledEmpty = !isLoading && !loadError && totalLeads === 0 && !searchQuery && !statusFilter && !sourceFilter && !scoreRangeFilter && activeTimeFilter === 'all';
  const stats = {
    total: leadStats?.total ?? totalLeads,
    new: leadStats?.new ?? 0,
    contacted: leadStats?.contacted ?? 0,
    engaged: leadStats?.engaged ?? 0,
    qualified: leadStats?.qualified ?? 0,
    converted: leadStats?.converted ?? 0,
    unqualified: leadStats?.unqualified ?? 0,
    highQuality: leadStats?.highQuality ?? 0,
    avgScore: leadStats?.avgScore ?? 0,
    engagementRate: leadStats?.engagementRate ?? 0,
    conversionRate: leadStats?.conversionRate ?? 0,
    pipelineValue: leadStats?.pipelineValue ?? 0,
  };

  // Channel performance data from real source distribution
  const channelData: Record<string, number> = leadStats?.sources ?? {};

  // Region data from real API
  const regionData = leadStats?.regions ?? [];

  // Format pipeline value for display
  const formatPipelineValue = (value: number) => {
    if (value >= 1000000) return `₹${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `₹${(value / 1000).toFixed(1)}k`;
    return `₹${value}`;
  };

  const timeFilters = [
    { id: 'all', label: 'All time' },
    { id: 'today', label: 'Today' },
    { id: 'yesterday', label: 'Yesterday' },
    { id: 'last7days', label: 'Last 7 Days' },
    { id: 'last30days', label: 'Last 30 Days' },
    { id: 'lastyear', label: 'Last Year' },
  ];

  return (
    <PageShell maxWidth="2xl" padding="md">
      <PageHeader
        icon={Users}
        title="Leads"
        subtitle="Find and qualify prospects before moving them into CRM."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={(event) => { createContactOpener.current = event.currentTarget; setShowCreateContactDialog(true); }}>
              <UserPlus className="mr-2 h-4 w-4" /> Add Contact
            </Button>
            <Button onClick={() => router.push('/dashboard/leads/new?returnTo=/dashboard/leads')}>
              <Plus className="mr-2 h-4 w-4" /> Add Lead
            </Button>
          </div>
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeopleDirectoryNav current="leads" />
        <div className="flex flex-wrap items-center gap-1 rounded-[10px] border border-border bg-muted/50 p-1" aria-label="Lead reporting period">
          {timeFilters.map((filter) => (
            <button
              type="button"
              key={filter.id}
              onClick={() => { setActiveTimeFilter(filter.id); setCurrentPage(1); }}
              className={`min-h-9 rounded-[7px] px-3 text-xs font-semibold transition-colors ${activeTimeFilter === filter.id
                  ? 'bg-card text-foreground shadow-sm ring-1 ring-border'
                  : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <section className="grid grid-cols-2 overflow-hidden rounded-[14px] border border-border bg-card lg:grid-cols-4" aria-label="Lead summary">
        {[
          { label: "Total leads", value: isLoading ? null : stats.total },
          { label: "Qualified", value: leadsSettledEmpty ? 0 : statsLoading && !leadStats ? null : leadStats ? stats.qualified : "—" },
          { label: "High quality", value: leadsSettledEmpty ? 0 : statsLoading && !leadStats ? null : leadStats ? stats.highQuality : "—" },
          { label: "Pipeline value", value: leadsSettledEmpty ? formatPipelineValue(0) : statsLoading && !leadStats ? null : leadStats ? formatPipelineValue(stats.pipelineValue) : "—" },
        ].map((metric) => (
          <div key={metric.label} className="border-b border-border px-4 py-4 odd:border-r [&:nth-child(n+3)]:border-b-0 sm:px-5 lg:border-b-0 lg:border-r lg:last:border-r-0">
            <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
            <div className="mt-2 font-mono text-2xl font-semibold tracking-[-0.04em] text-foreground">
              {metric.value === null ? <Skeleton className="h-7 w-14" /> : metric.value}
            </div>
          </div>
        ))}
      </section>

      {statsError && (
        <Callout
          tone="warning"
          icon={AlertCircle}
          title="Lead analytics are temporarily unavailable"
          actions={<Button size="sm" variant="outline" onClick={() => { void fetchLeadStats(); }}>Retry analytics</Button>}
        >
          The lead list remains accurate; global qualification and channel metrics are not being estimated from this page.
        </Callout>
      )}

      <details className="group rounded-[14px] border border-border bg-card">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          Lead breakdown
          <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <div className="grid border-t border-border md:grid-cols-2 xl:grid-cols-4">
          <div className="border-b border-border p-5 md:border-r xl:border-b-0">
            <h3 className="text-sm font-semibold">Status</h3>
            <dl className="mt-4 space-y-2.5 text-xs">
              {[["New", stats.new], ["Engaged", stats.engaged], ["Contacted", stats.contacted], ["Converted", stats.converted], ["Unqualified", stats.unqualified]].map(([label, value]) => (
                <div key={String(label)} className="flex items-center justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono font-semibold">{value}</dd></div>
              ))}
            </dl>
          </div>
          <div className="border-b border-border p-5 xl:border-b-0 xl:border-r">
            <h3 className="text-sm font-semibold">Top sources</h3>
            <dl className="mt-4 space-y-2.5 text-xs">
              {Object.entries(channelData).sort(([, a], [, b]) => b - a).slice(0, 5).map(([source, value]) => (
                <div key={source} className="flex items-center justify-between gap-4"><dt className="truncate capitalize text-muted-foreground">{source.replace(/[_-]/g, " ")}</dt><dd className="font-mono font-semibold">{value}</dd></div>
              ))}
              {Object.keys(channelData).length === 0 && <p className="leading-5 text-muted-foreground">Source data is not available for this period.</p>}
            </dl>
          </div>
          <div className="border-b border-border p-5 md:border-b-0 md:border-r">
            <h3 className="text-sm font-semibold">Top regions</h3>
            <dl className="mt-4 space-y-2.5 text-xs">
              {regionData.slice(0, 5).map((region) => (
                <div key={region.name} className="flex items-center justify-between gap-4"><dt className="truncate text-muted-foreground">{region.name}</dt><dd className="font-mono font-semibold">{region.count}</dd></div>
              ))}
              {regionData.length === 0 && <p className="leading-5 text-muted-foreground">Region data is not available for this period.</p>}
            </dl>
          </div>
          <div className="p-5">
            <h3 className="text-sm font-semibold">Rates</h3>
            <dl className="mt-4 space-y-3 text-xs">
              {[["Average score", stats.avgScore], ["Engagement", stats.engagementRate], ["Conversion", stats.conversionRate]].map(([label, value]) => (
                <div key={String(label)}>
                  <div className="mb-1.5 flex items-center justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono font-semibold">{value}%</dd></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${value}%` }} /></div>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </details>

      {/* Leads Table */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {/* Table Header */}
          <div className="p-5 border-b border-border">
            <p id="lead-export-scope" className="mb-3 text-xs text-muted-foreground">
              {selectedLeads.length ? 'Exports checked leads, including selections on other pages.' : hasExportFilters ? 'Exports all matching leads across every page.' : 'Exports the full lead directory for this business.'}
              {' '}Up to {LEAD_EXPORT_LIMIT.toLocaleString()} leads per export.{exportCount > LEAD_EXPORT_LIMIT ? ' Select fewer leads or narrow your filters.' : ''}
            </p>
            <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-foreground">{isLoading && !leads.length ? 'All Leads' : `All Leads (${totalLeads})`}</h2>
                <Button onClick={handleExport} loading={isExporting} loadingText="Exporting..." disabled={exportUnavailable} variant="outline" size="sm" className="h-8 px-3 text-xs" aria-describedby="lead-export-scope">
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {exportLabel}
                </Button>
              </div>
              <div className="flex items-center gap-3 w-full md:w-auto">
                <SearchInput
                  aria-label="Search leads"
                  ref={searchInputRef}
                  placeholder="Search Leads by name, company and roles..."
                  value={searchQuery}
                  onValueChange={(value) => {
                    setSearchQuery(value);
                    setCurrentPage(1);
                  }}
                  size="sm"
                  wrapperClassName="flex-1 md:w-72"
                  className="rounded-lg border-border bg-secondary"
                />
                <Button
                  variant="outline"
                  aria-label="Filter leads"
                  aria-expanded={showFilters}
                  onClick={() => setShowFilters(!showFilters)}
                  className="h-10 w-10 p-0 rounded-lg border-border"
                >
                  <Filter className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Filters Panel */}
            {showFilters && (
              <div className="mt-4 grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label htmlFor="lead-status-filter" className="mb-1.5 block text-xs font-medium text-muted-foreground">Status</label>
                  <select
                    id="lead-status-filter"
                    value={statusFilter}
                    onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">All Statuses</option>
                    {getLeadStatusOptions([...availableStatuses, ...leads.map(getLeadStatus), statusFilter]).map(status => (
                      <option key={status} value={status}>{formatLeadStatus(status)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="lead-source-filter" className="mb-1.5 block text-xs font-medium text-muted-foreground">Source</label>
                  <select
                    id="lead-source-filter"
                    value={sourceFilter}
                    onChange={(e) => { setSourceFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">All Sources</option>
                    <option value="linkedin">LinkedIn</option>
                    <option value="twitter">Twitter / X</option>
                    <option value="instagram">Instagram</option>
                    <option value="instagram_webhook">Instagram Webhook</option>
                    <option value="facebook">Facebook</option>
                    <option value="facebook_webhook">Facebook Webhook</option>
                    <option value="email">Email</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="justdial">JustDial</option>
                    <option value="google-maps">Google Maps</option>
                    <option value="workflow">Workflow</option>
                    <option value="Lead Generation">Lead Generation Agent</option>
                    <option value="manual">Manual</option>
                    <option value="manual_entry">Manual Entry</option>
                    <option value="csv_import">CSV Import</option>
                    <option value="crm_import">CRM Import</option>
                    <option value="crm_sync">CRM Sync</option>
                    <option value="support_widget">Support Widget</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="lead-score-filter" className="mb-1.5 block text-xs font-medium text-muted-foreground">Score range</label>
                  <select
                    id="lead-score-filter"
                    value={scoreRangeFilter}
                    onChange={(e) => { setScoreRangeFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">All Scores</option>
                    <option value="80-100">80-100 (Excellent)</option>
                    <option value="60-79">60-79 (Good)</option>
                    <option value="40-59">40-59 (Fair)</option>
                    <option value="0-39">0-39 (Low)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="lead-sort" className="mb-1.5 block text-xs font-medium text-muted-foreground">Sort by</label>
                  <select
                    id="lead-sort"
                    value={sortBy}
                    onChange={(e) => { setSortBy(e.target.value); setCurrentPage(1); }}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="created_at_desc">Newest First</option>
                    <option value="created_at_asc">Oldest First</option>
                    <option value="score_desc">Highest Score</option>
                    <option value="score_asc">Lowest Score</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <div className="hidden items-center justify-between gap-3 border-b px-5 py-2 md:flex">
            <p id="lead-table-scroll-help" className="text-xs text-muted-foreground">
              {optionalColumns.length ? 'Scroll horizontally for extra columns. Identity and actions stay visible.' : 'Expand for full contact details. Scroll horizontally on narrow screens; identity and actions stay visible.'}
            </p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 shrink-0 text-xs">Columns</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Optional columns</DropdownMenuLabel>
                {optionalLeadColumns.map(column => (
                  <DropdownMenuCheckboxItem
                    key={column.key}
                    checked={optionalColumns.includes(column.key)}
                    onSelect={event => event.preventDefault()}
                    onCheckedChange={checked => updateOptionalColumns(checked ? [...optionalColumns, column.key] : optionalColumns.filter(key => key !== column.key))}
                  >
                    {column.label}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => updateOptionalColumns([])}>Reset to compact view</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Bulk Actions */}
          {selectedLeads.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/20 bg-primary/5 px-4 py-3 sm:px-5">
              <span className="text-sm font-medium text-primary">
                {selectedLeads.length} lead{selectedLeads.length > 1 ? "s" : ""} selected
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={handleAssignToOutreach}
                  className="h-8 px-3 text-xs"
                  size="sm"
                >
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                  Review Outreach
                </Button>
                <Button
                  onClick={showBulkDeleteConfirm}
                  disabled={bulkDeleting}
                  variant="outline"
                  size="sm"
                  className="h-8 border-destructive/30 px-3 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  Delete Selected
                </Button>
                <Button onClick={() => setSelectedLeads([])} variant="ghost" size="sm" className="h-8 text-xs">Clear</Button>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="overflow-x-auto">
            {isLoading ? (
              <LeadTableSkeleton rows={pageSize} />
            ) : loadError ? (
              <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
                <AlertCircle className="mb-3 h-9 w-9 text-destructive" />
                <h3 className="font-semibold text-foreground">Leads unavailable</h3>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{loadError}</p>
                <Button className="mt-4" variant="outline" onClick={() => { void fetchLeads(); }}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Try again
                </Button>
              </div>
            ) : leads.length === 0 ? (
              <PageEmptyState
                icon={Users}
                title={searchQuery || statusFilter || sourceFilter || scoreRangeFilter || activeTimeFilter !== 'all' ? "No leads match your filters" : "No leads yet"}
                description={
                  searchQuery || statusFilter || sourceFilter || scoreRangeFilter || activeTimeFilter !== 'all'
                    ? "Try adjusting or clearing your filters to see more results."
                    : "Start by adding your first lead or running an agent campaign."
                }
                action={
                  searchQuery || statusFilter || sourceFilter || scoreRangeFilter || activeTimeFilter !== 'all'
                    ? { label: "Clear Filters", variant: "outline", onClick: () => { setSearchQuery(""); setStatusFilter(""); setSourceFilter(""); setScoreRangeFilter(""); setActiveTimeFilter('all'); setCurrentPage(1); searchInputRef.current?.focus({ preventScroll: true }); } }
                    : { label: "Add your first lead", onClick: () => router.push('/dashboard/leads/new') }
                }
              />
            ) : (
              <>
              {/* Mobile card view */}
              <div className="block divide-y md:hidden" role="group" aria-label="Lead cards">
                {leads.map((lead) => (
                  <Fragment key={lead.id}>
                  <div
                    className={`flex items-center gap-3 px-4 py-3 ${selectedLeads.includes(lead.id) ? 'bg-primary/5' : ''}`}
                  >
                    <Checkbox
                      checked={selectedLeads.includes(lead.id)}
                      onCheckedChange={() => handleToggleLeadSelection(lead.id)}
                      aria-label={`Select ${lead.name || lead.email || `lead ${lead.id}`}`}
                    />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => router.push(`/dashboard/leads/view/${lead.id}`)}>
                      <p title={lead.name || lead.email} className="truncate text-sm font-semibold text-primary">{lead.name || lead.email || `Lead #${lead.id}`}</p>
                      <p className="text-xs text-muted-foreground truncate">{lead.email}</p>
                      {lead.company && <p className="text-xs text-muted-foreground truncate">{lead.company}</p>}
                    </button>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <StatusBadge status={getLeadStatus(lead)} label={formatLeadStatus(getLeadStatus(lead))} toneOverrides={LEAD_STATUS_TONES} className="text-[10px] px-1.5 py-0" />
                      <span className="text-[10px] text-muted-foreground">{engagementLabel(lead)}</span>
                      <span className={`text-xs font-bold ${(lead.score || 0) >= 85 ? 'text-green-600' : (lead.score || 0) >= 60 ? 'text-yellow-600' : 'text-orange-600'}`}>{lead.score || 0}%</span>
                    </div>
                    <Button variant="ghost" size="icon" aria-label={`View ${lead.name || lead.email || `lead ${lead.id}`}`} className="h-8 w-8 shrink-0" onClick={() => router.push(`/dashboard/leads/view/${lead.id}`)}>
                      <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                  <details className="px-4 pb-3">
                    <summary className="w-fit cursor-pointer rounded text-xs text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Full identity and contact details</summary>
                    {renderLeadDetails(lead)}
                  </details>
                  </Fragment>
                ))}
              </div>
              {/* Desktop table */}
              <div ref={tableScrollRef} className={`${tableStyles.scrollRegion} hidden md:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`} role="region" aria-label="Scrollable leads table" aria-describedby="lead-table-scroll-help" tabIndex={0}>
              <table className={`${tableStyles.table} w-full`} style={{ minWidth: 760 + visibleOptionalColumns.length * 190 }} aria-label="Leads list">
                <colgroup>
                  {[44, 260, 112, 116, 120, ...visibleOptionalColumns.map(() => 190), 108].map((width, index) => <col key={index} style={{ width }} />)}
                </colgroup>
                <thead className="bg-muted/60">
                  <tr>
                    <th scope="col" className={`${tableStyles.selection} text-left`}>
                      <Checkbox checked={leads.length > 0 && leads.every((lead) => selectedLeads.includes(lead.id))} onCheckedChange={handleSelectAllLeads} aria-label="Select all leads on this page" />
                    </th>
                    <th scope="col" className={`${tableStyles.identity} text-left text-xs font-semibold text-muted-foreground`}>Name / Company</th>
                    {['Status', 'Engagement', 'Quality score', ...visibleOptionalColumns.map(column => column.label)].map((label) => (
                      <th key={label} scope="col" className="px-4 py-3 text-left text-sm font-semibold text-muted-foreground">{label}</th>
                    ))}
                    <th scope="col" className={`${tableStyles.actions} text-left text-xs font-semibold text-muted-foreground`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <Fragment key={lead.id}>
                    <tr data-selected={selectedLeads.includes(lead.id) || editingLeadId === lead.id} className={`border-b transition-colors hover:bg-muted/40 ${selectedLeads.includes(lead.id) ? 'bg-primary/5' : ''} ${processingLeadId === lead.id ? 'opacity-70' : ''} ${editingLeadId === lead.id ? 'bg-primary/5' : ''}`}>
                      <td className={tableStyles.selection}>
                        <Checkbox checked={selectedLeads.includes(lead.id)} onCheckedChange={() => handleToggleLeadSelection(lead.id)} aria-label={`Select lead ${lead.name || lead.email || `#${lead.id}`}`} />
                      </td>
                      <td className={tableStyles.identity}>
                        <button title={lead.name || lead.email} className="block max-w-full truncate rounded text-left text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => router.push(`/dashboard/leads/view/${lead.id}`)}>{lead.name || lead.email || `Lead #${lead.id}`}</button>
                        <p title={lead.company || undefined} className="truncate text-xs text-muted-foreground">{lead.company || '—'}</p>
                        <button type="button" className="mt-1 flex items-center gap-1 rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Contact details for ${lead.name || lead.email || `lead ${lead.id}`}`} aria-expanded={expandedLeadIds.includes(lead.id) || editingLeadId === lead.id} aria-controls={`lead-contact-${lead.id}`} onClick={() => toggleLeadDetails(lead.id)} disabled={editingLeadId === lead.id}>
                          <ChevronRight aria-hidden="true" className={`h-3 w-3 ${expandedLeadIds.includes(lead.id) || editingLeadId === lead.id ? 'rotate-90' : ''}`} /> Contact details
                        </button>
                      </td>
                      <td className="py-3 px-4">
                        <StatusBadge status={getLeadStatus(lead)} label={formatLeadStatus(getLeadStatus(lead))} toneOverrides={LEAD_STATUS_TONES} className="px-2.5" />
                      </td>
                      <td className="py-3 px-4">
                        {(lead.repliedEmails || 0) > 0 || (lead.messagesReceived || 0) > 0 ? (
                          <Badge className="bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 text-xs px-2.5 py-0.5 font-medium">Replied</Badge>
                        ) : lead.firstContactedAt ? (
                          <Badge className="bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 text-xs px-2.5 py-0.5 font-medium">Contacted</Badge>
                        ) : (
                          <Badge className="bg-gray-50 text-gray-500 dark:bg-gray-900/30 dark:text-gray-400 text-xs px-2.5 py-0.5 font-medium">None</Badge>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {scoringLeadId === lead.id ? (
                          <div className="flex items-center gap-1.5">
                            <Spinner size="xs" label={null} className="text-purple-500" />
                            <span className="text-xs text-muted-foreground">Scoring…</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="w-12 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${(lead.score || 0) >= 85 ? 'bg-green-500' : (lead.score || 0) >= 60 ? 'bg-yellow-500' : 'bg-orange-500'}`} style={{ width: `${lead.score || 0}%` }}></div>
                            </div>
                            <span className={`text-xs font-bold ${(lead.score || 0) >= 85 ? 'text-green-600' : (lead.score || 0) >= 60 ? 'text-yellow-600' : 'text-orange-600'}`}>{lead.score || 0}%</span>
                          </div>
                        )}
                      </td>
                      {visibleOptionalColumns.map(column => (
                        <td key={column.key} className="text-sm text-muted-foreground"><span title={secondaryValue(lead, column.key)} className="block truncate">{column.key === 'source' ? <Badge className={getSourceColor(lead.source)}>{leadSourceLabel(lead.source)}</Badge> : secondaryValue(lead, column.key)}</span></td>
                      ))}
                      <td className={tableStyles.actions}>
                        <div className="flex gap-1">
                          {editingLeadId === lead.id ? (
                            <>
                              <Button type="submit" form={`lead-edit-${lead.id}`} size="sm" disabled={savingLeadId === lead.id} className="h-7 px-2 text-xs">{savingLeadId === lead.id ? 'Saving…' : 'Save'}</Button>
                              <Button aria-label="Cancel lead edit" disabled={savingLeadId === lead.id} variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setEditingLeadId(null); }}>✕</Button>
                            </>
                          ) : (
                            <>
                              <Button aria-label="View lead details" title="View lead details" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => router.push(`/dashboard/leads/view/${lead.id}`)}>
                                <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                              <Button aria-label="Edit lead" title="Edit lead" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => handleStartLeadInlineEdit(lead, e)}>
                                <Edit className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button aria-label="More lead actions" title="More lead actions" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={processingLeadId === lead.id}>
                                    {processingLeadId === lead.id ? <Spinner size="xs" label={null} className="text-purple-600 dark:text-purple-400" /> : <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />}
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                  <DropdownMenuLabel>AI Actions</DropdownMenuLabel>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => handleScoreLead(lead.id)} disabled={scoringLeadId === lead.id}>
                                    {scoringLeadId === lead.id ? <Spinner size="sm" label={null} className="mr-2" /> : <Calculator className="w-4 h-4 mr-2 text-purple-500" />}
                                    Generate Score
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleEnrichLead(lead.id)} disabled={enrichingLeadId === lead.id}>
                                    {enrichingLeadId === lead.id ? <Spinner size="sm" label={null} className="mr-2" /> : <RefreshCw className="w-4 h-4 mr-2 text-blue-500" />}
                                    Enrich Lead
                                  </DropdownMenuItem>
                                  {lead.email && (
                                    <DropdownMenuItem onClick={() => handleValidateEmail(lead.id)} disabled={validatingEmailId === lead.id}>
                                      {validatingEmailId === lead.id ? <Spinner size="sm" label={null} className="mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2 text-green-500" />}
                                      Validate Email
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => handleStartOutreach(lead.id)} className="text-orange-600">
                                    <Megaphone className="w-4 h-4 mr-2" />Review Outreach
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => showDeleteConfirm(lead.id, lead.name || lead.email)} className="text-red-600">
                                    <Trash2 className="w-4 h-4 mr-2" />Delete Lead
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    <tr hidden={!expandedLeadIds.includes(lead.id) && editingLeadId !== lead.id} className="bg-muted/20">
                      <td colSpan={6 + visibleOptionalColumns.length}>
                        <div id={`lead-contact-${lead.id}`}>
                          <form id={`lead-edit-${lead.id}`} onSubmit={event => { event.preventDefault(); void handleLeadInlineUpdate(lead.id); }}>
                            {renderLeadDetails(lead, true)}
                          </form>
                        </div>
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
              </div>
              </>
            )}
          </div>

          {/* Pagination */}
          {leads.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4">
              <p className="text-xs text-muted-foreground">
                Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, totalLeads)} of {totalLeads}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="lead-page-size" className="text-xs text-muted-foreground">Rows per page:</label>
                <select id="lead-page-size" value={pageSize} onChange={(e) => { setPageSize(parseInt(e.target.value)); setCurrentPage(1); }} className="rounded-md border bg-background px-2 py-1 text-xs text-foreground">
                  <option value={10}>10</option>
                  <option value={15}>15</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <Button aria-label="Previous page" variant="outline" size="sm" onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1 || isLoading} className="h-9 w-9 p-0">
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                {(() => {
                  const startPage = Math.max(1, Math.min(currentPage - 2, totalPages - 4));
                  return Array.from({ length: Math.min(5, totalPages) }).map((_, i) => {
                    const pageNum = startPage + i;
                    if (pageNum < 1 || pageNum > totalPages) return null;
                    return (
                      <Button key={pageNum} aria-label={`Page ${pageNum}`} aria-current={currentPage === pageNum ? 'page' : undefined} disabled={isLoading} variant={currentPage === pageNum ? "default" : "outline"} size="sm" onClick={() => setCurrentPage(pageNum)} className="h-9 w-9 p-0 text-xs">
                        {pageNum}
                      </Button>
                    );
                  });
                })()}
                <Button aria-label="Next page" variant="outline" size="sm" onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage >= totalPages || isLoading} className="h-9 w-9 p-0">
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog(prev => ({ ...prev, open }))}
        onConfirm={confirmDialog.onConfirm}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />

      <CreateContactDialog open={showCreateContactDialog} onOpenChange={setShowCreateContactDialog} returnFocusRef={createContactOpener} />
    </PageShell>
  );
}
