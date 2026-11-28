import type { ThreadReportingSummary } from '../../../shared/threadReporting';
import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "next-themes";
import { PageErrorState } from "@/components/ui/page-state";
import { InsightMetricCard } from "@/components/conversation/InsightMetricCard";
import { RecommendationCard } from "@/components/conversation/RecommendationCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart3,
  FileText,
  TrendingUp,
  Users,
  Target,
  Send,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Area,
  AreaChart,
  PieChart,
  Pie,
  Cell,
} from "recharts";

interface Lead {
  id: number;
  name: string;
  email: string;
  company: string;
  title: string;
  phone_no?: string;
  status: string;
  engagement: string;
  source: string;
  fit_score: number;
}

interface CampaignDashboardViewProps {
  threadId: number;
  campaignName?: string;
}

const _COLORS = ['#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#3b82f6'];

export function CampaignDashboardView({ threadId, campaignName: _campaignName }: CampaignDashboardViewProps) {
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stats, setStats] = useState({
    leadsEnriched: 0,
    leadsOutreached: 0,
    engagedLeads: 0,
    converted: null as number | null,
    totalLeads: 0,
    conversionRate: 0,
    contentAssetsCount: 0,
    outreachRate: 0,
  });
  const [distributions, setDistributions] = useState({ source: {} as Record<string, number>, status: {} as Record<string, number> });
  const [leads, setLeads] = useState<Lead[]>([]);
  const [channelPerformance, setChannelPerformance] = useState<{name: string; outreach: number; replied: number; [key: string]: string | number}[]>([]);
  const [performanceTimeline, setPerformanceTimeline] = useState<{week: string; outreached: number;  [key: string]: string | number}[]>([]);
  const [leadQuery, setLeadQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const isDarkMode = resolvedTheme === "dark";
  const hasData = leads.length > 0 || stats.totalLeads > 0;

  const sourceColors: Record<string, string> = { linkedin: '#0077B5', instagram: '#E4405F', facebook: '#1877F2', email: '#10b981', twitter: '#1DA1F2', google: '#f59e0b', justdial: '#f59e0b', google_maps: '#f59e0b', other: '#8b5cf6' };
  const statusColors: Record<string, string> = { new: '#3b82f6', contacted: '#f59e0b', qualified: '#10b981', converted: '#8b5cf6', lost: '#ef4444', nurturing: '#ec4899' };

  const leadsBySource = Object.entries(
    distributions.source
  ).map(([name, value]) => ({ name, value, color: sourceColors[name] || '#8b5cf6' }));

  const leadsByStatus = Object.entries(
    distributions.status
  ).map(([name, value]) => ({ name, value, color: statusColors[name] || '#3b82f6' }));

  const fetchCampaignData = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const response = await api.get<{
        summary: ThreadReportingSummary;
        leads: { total: number; items: Lead[] };
      }>(`/api/chat/threads/${threadId}/details`);
      if (!response?.summary) throw new Error('Campaign reporting is unavailable. Please refresh and try again.');
      const summary = response.summary;
      setStats({ leadsEnriched: summary.leads, leadsOutreached: summary.contactedLeads, engagedLeads: summary.engagedLeads,
        converted: summary.convertedContacts, totalLeads: summary.leads,
        conversionRate: summary.crmContacts && summary.convertedContacts !== null ? Math.round(100 * summary.convertedContacts / summary.crmContacts) : 0,
        contentAssetsCount: summary.contentAssets, outreachRate: summary.leads > 0 ? Math.round(100 * summary.contactedLeads / summary.leads) : 0 });
      setLeads(response.leads.items);
      setDistributions({ source: summary.bySource, status: summary.byStatus });
      setChannelPerformance(summary.channels);
      setPerformanceTimeline(summary.timeline);

    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load campaign data";
      setLoadError(message);
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [threadId, toast]);

  useEffect(() => {
    fetchCampaignData();
  }, [fetchCampaignData]);

  const getStatusBadge = (status: string) => {
    const known: Record<string, { label: string; tone: StatusTone }> = {
      engaged: { label: "Engaged", tone: "success" },
      contacted: { label: "Engaged", tone: "success" },
      new: { label: "New", tone: "info" },
      replied: { label: "Replied", tone: "progress" },
      "meeting booked": { label: "Meeting Booked", tone: "warning" },
      meeting_booked: { label: "Meeting Booked", tone: "warning" },
      closed: { label: "Closed", tone: "neutral" },
      converted: { label: "Closed", tone: "neutral" },
    };
    const match = known[status?.toLowerCase() ?? ""];
    return <StatusBadge tone={match?.tone ?? "warning"} label={match?.label ?? (status || "Unknown")} className="text-[10px]" />;
  };

  const getEngagementColor = (engagement: string) => {
    const level = engagement?.toLowerCase() || '';
    if (level.includes('high')) return 'text-green-600 dark:text-emerald-300';
    if (level.includes('medium')) return 'text-yellow-600 dark:text-amber-300';
    return 'text-muted-foreground';
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-green-600 dark:text-emerald-300";
    if (score >= 60) return "text-yellow-600 dark:text-amber-300";
    return "text-red-600 dark:text-rose-300";
  };

  const leadStatuses = useMemo(() => [...new Set(leads.map((lead) => lead.status).filter(Boolean))].sort(), [leads]);
  const leadSources = useMemo(() => [...new Set(leads.map((lead) => lead.source).filter(Boolean))].sort(), [leads]);
  const filteredLeads = useMemo(() => {
    const query = leadQuery.trim().toLowerCase();
    return leads.filter((lead) => {
      const matchesQuery = !query || [lead.name, lead.company, lead.title, lead.email].some((value) => value?.toLowerCase().includes(query));
      const matchesStatus = statusFilter === "all" || lead.status === statusFilter;
      const matchesSource = sourceFilter === "all" || lead.source === sourceFilter;
      return matchesQuery && matchesStatus && matchesSource;
    });
  }, [leadQuery, leads, sourceFilter, statusFilter]);

  const contentCount = stats.contentAssetsCount;
  const contentWord = contentCount === 1 ? "item" : "items";
  const recommendation = stats.totalLeads === 0 && contentCount > 0
    ? { title: "Put the new content to work", description: `${contentCount} content ${contentWord} are saved for this campaign. Review them in Content Studio, then ask Sarah to prepare an ad review or Marcus to find leads.` }
    : stats.totalLeads === 0
    ? { title: "Build the first lead cohort", description: "Ask Marcus to generate and enrich a focused lead list before launching outreach." }
    : stats.outreachRate < 60
      ? { title: "Activate the uncontacted lead pool", description: `${stats.totalLeads - stats.leadsOutreached} leads have not received outreach yet. Review fit and launch a targeted sequence.` }
      : stats.engagedLeads === 0
        ? { title: "Test a new outreach angle", description: "Coverage is healthy, but engagement is still low. Try a tighter value proposition or a different channel." }
        : { title: "Prioritize engaged leads", description: `${stats.engagedLeads} leads show engagement. Move the strongest-fit accounts into a focused follow-up sequence.` };

  if (isLoading) {
    return (
      <LoadingState className="h-full" label="Loading campaign data..." showLabel />
    );
  }

  if (loadError) {
    return (
      <PageErrorState
        title="Campaign dashboard could not be loaded"
        description={loadError}
        reset={() => void fetchCampaignData()}
      />
    );
  }

  const tooltipStyle = {
    backgroundColor: isDarkMode ? "hsl(var(--card))" : "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "0.75rem",
    color: "hsl(var(--foreground))",
  };

  return (
    <div className="space-y-5 bg-muted/20 p-4 sm:space-y-6 sm:p-6">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recorded campaign activity</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-foreground">Performance at a glance</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <InsightMetricCard label="Campaign leads" value={stats.leadsEnriched} detail="Found or selected for this campaign" icon={<Users className="h-4 w-4" />} />
        <InsightMetricCard label="Outreach coverage" value={`${stats.outreachRate}%`} detail={`${stats.leadsOutreached} contacted`} icon={<Send className="h-4 w-4" />} tone="primary" />
        <InsightMetricCard label="Engaged leads" value={stats.engagedLeads} detail="Contacts with recorded opens, reads, or replies" icon={<Target className="h-4 w-4" />} tone="warning" />
        <InsightMetricCard label="Content created" value={contentCount} detail="Ads, posts, blogs and media saved in this campaign" icon={<FileText className="h-4 w-4" />} />
        <InsightMetricCard label="Recorded CRM wins" value={stats.converted ?? "—"} detail={stats.converted === null ? "CRM reporting requires CRM access" : "First lifetime wins among linked CRM contacts"} icon={<TrendingUp className="h-4 w-4" />} tone="success" />
      </div>

      <p className="text-sm text-muted-foreground">Totals cover every lead in this campaign; the table shows the first 50. CRM wins are recorded deal-stage changes and do not prove the campaign caused them.</p>

      <RecommendationCard
        title={recommendation.title}
        description={recommendation.description}
        evidence={`${stats.leadsOutreached} outreached · ${stats.engagedLeads} engaged · ${stats.converted ?? "unavailable"} recorded CRM wins`}
      />

      {!hasData ? (
        /* Empty state */
        <Card className="bg-card">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <BarChart3 className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium text-muted-foreground">{contentCount > 0 ? "No lead or outreach results yet" : "No campaign data yet"}</h3>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {contentCount > 0
                ? `${contentCount} content ${contentWord} saved. Lead and outreach results appear here once you find leads or send messages.`
                : "Start by generating leads or sending outreach messages"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Leads by Source */}
            {leadsBySource.length > 0 && (
              <Card className="bg-card">
                <CardHeader>
                  <CardTitle className="text-base">Leads by Source</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
                  <div className="w-32 h-32">
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1, height: 1 }}>
                      <PieChart>
                        <Pie
                          data={leadsBySource}
                          innerRadius={30}
                          outerRadius={55}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {leadsBySource.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [`${value ?? 0} leads`, name ?? '']} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    {leadsBySource.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }}></span>
                        <span>{item.name}: <strong>{item.value}</strong></span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Leads by Status */}
            {leadsByStatus.length > 0 && (
              <Card className="bg-card">
                <CardHeader>
                  <CardTitle className="text-base">Leads by Status</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
                  <div className="w-32 h-32">
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1, height: 1 }}>
                      <PieChart>
                        <Pie
                          data={leadsByStatus}
                          innerRadius={30}
                          outerRadius={55}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {leadsByStatus.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [`${value ?? 0} leads`, name ?? '']} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    {leadsByStatus.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }}></span>
                        <span>{item.name}: <strong>{item.value}</strong></span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Channel Performance */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-base">Channel Performance</CardTitle>
          </CardHeader>
          <CardContent>
            {channelPerformance.length > 0 ? (
              <ResponsiveContainer width="100%" height={250} minWidth={0} initialDimension={{ width: 1, height: 1 }}>
                <BarChart data={channelPerformance} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke={isDarkMode ? "#314160" : "#e5e7eb"} />
                  <XAxis type="number" tick={{ fill: isDarkMode ? "#b7c6ea" : "#4b5563", fontSize: 12 }} stroke={isDarkMode ? "#6f85b7" : "#94a3b8"} />
                  <YAxis dataKey="name" type="category" width={80} tick={{ fontSize: 12, fill: isDarkMode ? "#b7c6ea" : "#4b5563" }} stroke={isDarkMode ? "#6f85b7" : "#94a3b8"} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Bar dataKey="outreach" fill="#8b5cf6" name="Sent receipts" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="replied" fill="#ec4899" name="Replied receipts" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center h-[250px] text-muted-foreground">
                <BarChart3 className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No outreach data yet</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Performance Timeline (from real outreach dates) */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-base">Recorded sends by UTC week</CardTitle>
          </CardHeader>
          <CardContent>
            {performanceTimeline.length > 0 ? (
              <ResponsiveContainer width="100%" height={250} minWidth={0} initialDimension={{ width: 1, height: 1 }}>
                <AreaChart data={performanceTimeline}>
                  <defs>
                    <linearGradient id="colorOutreached" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#314160" : "#e5e7eb"} />
                  <XAxis dataKey="week" tick={{ fontSize: 12, fill: isDarkMode ? "#b7c6ea" : "#4b5563" }} stroke={isDarkMode ? "#6f85b7" : "#94a3b8"} />
                  <YAxis tick={{ fontSize: 12, fill: isDarkMode ? "#b7c6ea" : "#4b5563" }} stroke={isDarkMode ? "#6f85b7" : "#94a3b8"} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Area type="monotone" dataKey="outreached" stroke="#f59e0b" fillOpacity={1} fill="url(#colorOutreached)" name="Outreached" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center h-[250px] text-muted-foreground">
                <TrendingUp className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">Timeline data will appear after outreach</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Leads Table */}
      <Card className="border-border bg-card">
        <CardHeader>
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Lead preview ({leads.length} of {stats.totalLeads})
            </CardTitle>
            <div className="flex flex-col gap-2 sm:flex-row" aria-label="Lead preview filters">
              <SearchInput aria-label="Search leads" size="sm" value={leadQuery} onValueChange={setLeadQuery} placeholder="Search displayed leads…" className="text-xs" wrapperClassName="sm:w-64" />
              <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-xs text-foreground">
                <option value="all">All statuses</option>
                {leadStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <select aria-label="Filter by source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-xs text-foreground">
                <option value="all">All sources</option>
                {leadSources.map((source) => <option key={source} value={source}>{source}</option>)}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border border-border">
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="text-xs font-semibold">Name</TableHead>
                  <TableHead className="text-xs font-semibold">Company</TableHead>
                  <TableHead className="text-xs font-semibold">Role</TableHead>
                  <TableHead className="text-xs font-semibold">Email ID</TableHead>
                  <TableHead className="text-xs font-semibold">Phone No.</TableHead>
                  <TableHead className="text-xs font-semibold">Status</TableHead>
                  <TableHead className="text-xs font-semibold">Engagement</TableHead>
                  <TableHead className="text-xs font-semibold">Source</TableHead>
                  <TableHead className="text-right text-xs font-semibold">QS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLeads.length > 0 ? (
                  filteredLeads.map((lead) => (
                    <TableRow key={lead.id} className="hover:bg-muted/40">
                      <TableCell className="text-sm font-medium">{lead.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{lead.company}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{lead.title}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{lead.email}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{lead.phone_no || '-'}</TableCell>
                      <TableCell>{getStatusBadge(lead.status)}</TableCell>
                      <TableCell className={`text-sm font-medium ${getEngagementColor(lead.engagement)}`}>
                        {lead.engagement || 'Low'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{lead.source}</TableCell>
                      <TableCell className="text-right">
                        <span className={`text-sm font-semibold ${getScoreColor(lead.fit_score)}`}>
                          {lead.fit_score}%
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      No displayed leads match the current filters
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
