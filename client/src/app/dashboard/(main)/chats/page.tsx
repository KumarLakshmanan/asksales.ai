"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { 
  MessageSquare, 
  Clock,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Building2,
  Target,
  Users,
  Image,
  Video,
  Send,
  Megaphone,
  BarChart3,
  FileText,
  LayoutGrid,
  Info,
  List
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { campaignHistoryFailureReason } from "./campaign-history-error";
import { businessProfileName, useBusinessProfiles } from "@/hooks/use-business-profiles";
import { ChatHistorySkeleton } from "@/components/skeletons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ChatThreadStats {
  leadsCount: number;
  contentCount: number;
  outreachCount: number;
  adCopyCount: number;
  imageCount: number;
  videoCount: number;
}

interface ChatThread {
  id: number;
  title: string;
  selectedAgent: string | null;
  businessId: number | null;
  createdAt: string;
  updatedAt: string;
  // Business info
  business: {
    id: number;
    name: string;
    industry: string | null;
  } | null;
  // ICP info  
  icp: {
    id: number;
    campaignName: string | null;
    targetAudience: string | null;
    industry: string | null;
    fitScore: number | null;
  } | null;
  // Stats
  stats: ChatThreadStats;
}

interface ThreadsResponse {
  threads: ChatThread[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];

const campaignName = (thread: ChatThread) =>
  thread.icp?.campaignName?.trim() || thread.title?.trim() || `Campaign ${thread.id}`;

// Include the stable record ID even when a duplicate title is on another page.
const campaignTarget = (thread: ChatThread) =>
  thread.icp?.campaignName?.trim() || thread.title?.trim()
    ? `${campaignName(thread)} (ID ${thread.id})`
    : campaignName(thread);

export default function ChatsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { activeProfile, isLoading: loadingProfiles, isError: profilesError, refetch: refetchProfiles } = useBusinessProfiles();
  const activeProfileId = activeProfile?.id;
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [filteredThreads, setFilteredThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalThreads, setTotalThreads] = useState(0);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [itemsPerPage, setItemsPerPage] = useState(10);

   
  useEffect(() => {
    // Filter threads based on search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      setFilteredThreads(
        threads.filter(thread => 
          campaignName(thread).toLowerCase().includes(query) ||
          thread.title?.toLowerCase().includes(query) ||
          `campaign ${thread.id}`.toLowerCase().includes(query)
        )
      );
    } else {
      setFilteredThreads(threads);
    }
  }, [searchQuery, threads]);

  const loadThreads = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const offset = (currentPage - 1) * itemsPerPage;
      const scope = `&businessProfileId=${activeProfileId}`;
      const response = await api.get<ThreadsResponse>(`/api/chat/threads?limit=${itemsPerPage}&offset=${offset}${scope}`);
      setThreads(response.threads);
      setFilteredThreads(response.threads);
      setTotalThreads(response.total);
    } catch (error) {
      const reason = campaignHistoryFailureReason(error);
      setLoadError(reason);
      toast({
        title: "Campaign history did not load",
        description: reason,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [activeProfileId, currentPage, itemsPerPage, toast]);

  useEffect(() => {
    if (activeProfileId) void loadThreads();
  }, [activeProfileId, loadThreads]);

  const handleDelete = async (threadId: number) => {
    try {
      await api.delete(`/api/chat/threads/${threadId}`);
      const nextTotal = Math.max(0, totalThreads - 1);
      const nextLastPage = Math.max(1, Math.ceil(nextTotal / itemsPerPage));
      setTotalThreads(nextTotal);
      if (currentPage > nextLastPage) {
        setCurrentPage(nextLastPage);
      } else {
        await loadThreads();
      }
      toast({
        title: "Deleted",
        description: "Campaign deleted successfully",
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to delete campaign",
        variant: "destructive",
      });
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    if (Number.isNaN(date.getTime())) return "Unknown date";
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((todayStart.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
      return `Today at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    } else if (diffDays === 1) {
      return `Yesterday at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    } else if (diffDays > 1 && diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
  };

  // Pagination - use totalThreads from server for pagination
  const handleThreadClick = (threadId: number) => {
    router.push(`/dashboard/conversations/${threadId}`);
  };

  const totalPages = Math.ceil(totalThreads / itemsPerPage);

  // Generate pagination page numbers with ellipsis
  const getPaginationPages = (): (number | "ellipsis")[] => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages: (number | "ellipsis")[] = [1];
    if (currentPage > 3) pages.push("ellipsis");
    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (currentPage < totalPages - 2) pages.push("ellipsis");
    pages.push(totalPages);
    return pages;
  };

  // Helper to get agent badge color
  const getAgentBadgeColor = (agent: string | null) => {
    if (!agent) return "secondary";
    switch (agent.toLowerCase()) {
      case "lead_generation":
      case "lead-generation":
        return "default";
      case "content_studio":
      case "content-studio":
        return "secondary";
      case "performance_marketing":
      case "performance-marketing":
        return "outline";
      case "outreach":
        return "destructive";
      default:
        return "secondary";
    }
  };

  // Helper to format agent name
  const formatAgentName = (agent: string | null) => {
    if (!agent) return null;
    return agent.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  if (profilesError || (!loadingProfiles && !activeProfileId)) {
    return <div className="page-shell"><p className="text-sm text-muted-foreground">Business profiles could not be loaded.</p><Button variant="outline" className="mt-3" onClick={() => void refetchProfiles()}>Try again</Button></div>;
  }

  if (loadingProfiles || loading) {
    // Keep the real header and its action while the list loads, so a slow
    // response still leaves the page usable and clearly named.
    return (
      <div className="outreach-workspace campaign-history page-shell">
        <PageHeader
          className="workspace-heading"
          icon={MessageSquare}
          title="Campaign History"
          subtitle="View and manage all your previous campaigns"
          actions={
            <Button onClick={() => router.push("/dashboard/conversations")}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              New Campaign
            </Button>
          }
        />
        <span role="status" className="sr-only">Loading campaigns…</span>
        <ChatHistorySkeleton count={5} />
      </div>
    );
  }

  return (
    <div className="outreach-workspace campaign-history page-shell">
      {/* Header */}
      <PageHeader
        className="workspace-heading"
        icon={MessageSquare}
        title="Campaign History"
        subtitle={`Campaigns for ${businessProfileName(activeProfile!)}`}
        actions={
          <Button onClick={() => router.push("/dashboard/conversations")}>
            <Plus className="mr-2 h-4 w-4" />
            New Campaign
          </Button>
        }
      />

      {/* Search & View Toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex-1 max-w-md">
          <SearchInput
            placeholder="Filter this page by campaign title..."
            aria-label="Filter campaigns on this page"
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">Filters the campaigns on this page</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center rounded-lg border border-border bg-background p-1">
            <button
              onClick={() => setViewMode("grid")}
              aria-label="Grid view"
              aria-pressed={viewMode === "grid"}
              className={`p-1.5 rounded-md transition-colors ${viewMode === "grid" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
              title="Grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode("list")}
              aria-label="List view"
              aria-pressed={viewMode === "list"}
              className={`p-1.5 rounded-md transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
              title="List view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
          <p className="text-sm text-muted-foreground">
            {totalThreads} {totalThreads === 1 ? 'campaign' : 'campaigns'} total
          </p>
        </div>
      </div>

      {/* Chats List - Grid or List View */}
      {loadError ? (
        <Card role="alert">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm font-medium">Campaign history could not be loaded.</p>
            <p className="max-w-md text-sm text-muted-foreground">{loadError}</p>
            <Button variant="outline" size="sm" onClick={loadThreads}>Try again</Button>
          </CardContent>
        </Card>
      ) : filteredThreads.length > 0 ? (
        viewMode === "list" ? (
        /* LIST VIEW */
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="min-w-[960px] w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Campaign</th>
                <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Agent</th>
                <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Business</th>
                <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">ICP</th>
                <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Assets</th>
                <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Updated</th>
                <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
              {filteredThreads.map((thread) => (
                <tr
                  key={thread.id}
                  className="border-t hover:bg-muted/30 transition-colors cursor-pointer group"
                  onClick={(event) => {
                    // Nested links/buttons own their activation, including new-tab clicks.
                    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
                      (event.target as Element).closest("a, button")) return;
                    handleThreadClick(thread.id);
                  }}
                >
                  <td className="py-3 px-4">
                    <a
                      href={`/dashboard/conversations/${thread.id}`}
                      aria-label={`Open campaign ${campaignTarget(thread)}`}
                      className="inline-flex items-center gap-2 min-w-0 rounded-md text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <MessageSquare aria-hidden="true" className="h-4 w-4 text-primary" />
                      </div>
                      <span className="text-sm font-medium truncate max-w-[200px]">
                        {campaignName(thread)}
                      </span>
                    </a>
                  </td>
                  <td className="py-3 px-4">
                    {thread.selectedAgent ? (
                      <Badge variant={getAgentBadgeColor(thread.selectedAgent)} className="text-[10px] py-0">
                        {formatAgentName(thread.selectedAgent)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm text-muted-foreground truncate max-w-[150px]">
                    {thread.business?.name || "—"}
                  </td>
                  <td className="py-3 px-4 text-sm text-muted-foreground truncate max-w-[150px]">
                    {thread.icp?.targetAudience || "—"}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-0.5 text-xs text-muted-foreground" title="Leads"><Users className="h-3 w-3" />{thread.stats?.leadsCount || 0}</span>
                      <span className="flex items-center gap-0.5 text-xs text-muted-foreground" title="Content"><FileText className="h-3 w-3" />{thread.stats?.contentCount || 0}</span>
                      <span className="flex items-center gap-0.5 text-xs text-muted-foreground" title="Outreach"><Send className="h-3 w-3" />{thread.stats?.outreachCount || 0}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className="text-xs text-muted-foreground">{formatDate(thread.updatedAt || thread.createdAt)}</span>
                  </td>
                  <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" aria-label={`Delete campaign ${campaignTarget(thread)}`} variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Campaign</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete {campaignTarget(thread)}? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDelete(thread.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        ) : (
        /* GRID VIEW */
        <div className="grid md:grid-cols-2 gap-4">
          {filteredThreads.map((thread) => (
            <Card 
              key={thread.id}
              className="campaign-history-card transition-colors group relative overflow-hidden"
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <MessageSquare className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-lg truncate">
                          {campaignName(thread)}
                        </CardTitle>
                        <div className="flex items-center gap-2 mt-0.5">
                          {thread.selectedAgent && (
                            <Badge variant={getAgentBadgeColor(thread.selectedAgent)} className="text-[10px] py-0">
                              {formatAgentName(thread.selectedAgent)}
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatDate(thread.updatedAt || thread.createdAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" aria-label={`Delete campaign ${campaignTarget(thread)}`} variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Campaign</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to delete {campaignTarget(thread)}? This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction 
                          onClick={() => handleDelete(thread.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                {/* Business & ICP Preview */}
                <div className="grid grid-cols-2 gap-2">
                  {/* Business Card */}
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Building2 className="h-3.5 w-3.5 text-blue-600" />
                      <span className="text-[10px] font-medium text-muted-foreground">Business</span>
                    </div>
                    {thread.business ? (
                      <>
                        <p className="text-xs font-medium truncate">{thread.business.name}</p>
                        {thread.business.industry && (
                          <p className="text-[10px] text-muted-foreground truncate">{thread.business.industry}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">Not configured</p>
                    )}
                  </div>

                  {/* ICP Card */}
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <Target className="h-3.5 w-3.5 text-green-600" />
                        <span className="text-[10px] font-medium text-muted-foreground">ICP</span>
                      </div>
                      {thread.icp?.fitScore && (
                        <Badge 
                          variant="secondary" 
                          className={`text-[9px] py-0 px-1 ${
                            thread.icp.fitScore >= 70 
                              ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' 
                              : thread.icp.fitScore >= 50
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                              : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                          }`}
                        >
                          {thread.icp.fitScore}%
                        </Badge>
                      )}
                    </div>
                    {thread.icp ? (
                      <>
                        <p className="text-xs font-medium truncate">{thread.icp.targetAudience || 'Target defined'}</p>
                        {thread.icp.industry && (
                          <p className="text-[10px] text-muted-foreground truncate">{thread.icp.industry}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">Not defined</p>
                    )}
                  </div>
                </div>

                {/* Stats Row */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-3">
                    <div className="flex flex-wrap items-center gap-1" title="Leads"><span className="w-full text-[11px] text-muted-foreground">Leads</span>
                      <Users className="h-3.5 w-3.5 text-purple-600" />
                      <span className="text-xs font-medium">{thread.stats?.leadsCount || 0}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1" title="Content"><span className="w-full text-[11px] text-muted-foreground">Content</span>
                      <FileText className="h-3.5 w-3.5 text-blue-600" />
                      <span className="text-xs font-medium">{thread.stats?.contentCount || 0}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1" title="Ad Copies"><span className="w-full text-[11px] text-muted-foreground">Ads</span>
                      <Megaphone className="h-3.5 w-3.5 text-orange-600" />
                      <span className="text-xs font-medium">{thread.stats?.adCopyCount || 0}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1" title="Outreach"><span className="w-full text-[11px] text-muted-foreground">Outreach</span>
                      <Send className="h-3.5 w-3.5 text-green-600" />
                      <span className="text-xs font-medium">{thread.stats?.outreachCount || 0}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(thread.stats?.imageCount || 0) > 0 && (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                        <Image className="h-3 w-3 mr-0.5"
 />
                        {thread.stats.imageCount}
                      </Badge>
                    )}
                    {(thread.stats?.videoCount || 0) > 0 && (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                        <Video className="h-3 w-3 mr-0.5" />
                        {thread.stats.videoCount}
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2 pt-2 border-t">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-8 text-xs"
                    onClick={() => handleThreadClick(thread.id)}
                  >
                    <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
                    View Details
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 h-8 text-xs bg-primary hover:bg-primary/90"
                    onClick={() => handleThreadClick(thread.id)}
                  >
                    <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                    Open Chat
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        )
      ) : (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground">
            <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="font-medium">{searchQuery ? "No matches on this page" : "No campaigns found"}</p>
            <p className="text-sm mt-1">
              {searchQuery
                ? totalPages > 1 ? "Clear the filter or check another page." : "Clear the filter or try a different search term."
                : "Start a new campaign to get started"}
            </p>
          </CardContent>
        </Card>
      )}

      <p className="workspace-scope-notice"><Info className="h-4 w-4 shrink-0 text-primary" />Open Chat opens the campaign coordinator workspace. Customer messages are read and answered in Outreach Inbox.</p>
      {/* Pagination */}
      {totalPages > 1 && (
        <nav aria-label="Campaign history pagination" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Showing {((currentPage - 1) * itemsPerPage) + 1}-{Math.min(currentPage * itemsPerPage, totalThreads)} of {totalThreads}
            </p>
            <div className="flex items-center gap-2">
              <label htmlFor="campaign-history-page-size" className="text-sm text-muted-foreground">Campaigns per page</label>
              <Select value={String(itemsPerPage)} onValueChange={(v) => { setItemsPerPage(Number(v)); setCurrentPage(1); }}>
                <SelectTrigger id="campaign-history-page-size" className="h-8 w-[68px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage(currentPage - 1)}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <div className="hidden items-center gap-1 sm:flex">
              {getPaginationPages().map((page, idx) =>
                page === "ellipsis" ? (
                  <span key={`ellipsis-${idx}`} className="w-8 h-8 flex items-center justify-center text-muted-foreground">
                    ...
                  </span>
                ) : (
                  <Button
                    key={page}
                    aria-label={`Page ${page}`}
                    aria-current={currentPage === page ? "page" : undefined}
                    variant={currentPage === page ? "default" : "outline"}
                    size="sm"
                    className="w-8 h-8 p-0"
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </Button>
                )
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage(currentPage + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
