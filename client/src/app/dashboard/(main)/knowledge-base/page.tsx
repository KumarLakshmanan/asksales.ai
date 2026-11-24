"use client";

import { selectedBusinessProfileId } from '@/lib/business-profile';
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useControlledDialogReturnFocus } from "@/hooks/use-controlled-dialog-return-focus";
import { BookOpen, Plus, Search, FileText, Trash2, Edit, HelpCircle, File, FileSpreadsheet, FileType, Presentation, FileCode, Globe, Eye, RefreshCw, Images } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import api from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/ui/page-header";
import { PageErrorState } from "@/components/ui/page-state";
import { KnowledgeReviewDialog, KnowledgeRetrievalTester } from "@/components/knowledge/KnowledgeReviewDialog";
import { KnowledgeReadinessDetails, readinessLabels, type KnowledgeReadiness } from '@/components/knowledge/KnowledgeReadiness';

interface KnowledgeEntry {
  readiness?: KnowledgeReadiness | null;
  id: number;
  title: string;
  description?: string;
  content: string;
  type: "document" | "file" | "qa" | "url";
  processingStatus?: "queued" | "processing" | "completed" | "failed";
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  question?: string;
  answer?: string;
  sourceUrl?: string;
  businessProfileId?: number | null;
  createdAt: string;
  updatedAt: string;
  knowledgeStatus?: "legacy_only" | "ready_for_review" | "published" | "published_degraded" | "quarantined" | "failed" | "ocr_required" | "retired";
  knowledgeVersionId?: number | null;
  knowledgeVersionNo?: number | null;
  vectorIndexStatus?: string | null;
  lexicalIndexStatus?: string | null;
  currentPublishedVersionId?: number | null;
  liveVersionNo?: number | null;
  liveStatus?: string | null;
  audience?: string | null;
  accessScope?: string | null;
  allowedChannels?: string[];
  usageScopes?: string[];
  locale?: string | null;
}

interface BusinessProfile {
  id: number;
  companyName: string;
}

export default function KnowledgeBasePage() {
  const router = useRouter();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const clearSearch = () => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  };
  const [filterType, setFilterType] = useState<string>("all");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [entryToDelete, setEntryToDelete] = useState<number | null>(null);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const listRead = useRef(0);
  const listInFlight = useRef(0);
  const listScope = useRef<{ profileFilter: string; active: boolean } | null>(null);
  const pageLifetime = useRef({ active: false });
  const previewRead = useRef(0);
  const previewOpener = useRef<HTMLButtonElement | null>(null);
  const previewReturnFocus = useControlledDialogReturnFocus(viewDialogOpen, previewOpener);
  const changeViewDialogOpen = (open: boolean) => {
    if (!open) {
      // Dismissal ends this read's ownership, including during the exit animation.
      previewRead.current++;
      setViewLoading(false);
    }
    setViewDialogOpen(open);
  };
  const [reviewEntry, setReviewEntry] = useState<KnowledgeEntry | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewEntryName, setViewEntryName] = useState("");
  const [extractedData, setExtractedData] = useState<{
    extractedText: string;
    chunks: { index: number; text: string; charStart: number; charEnd: number; tokenEstimate: number; hasEmbedding: boolean | null }[];
    readiness?: KnowledgeReadiness | null;
    embeddingsGenerated: boolean;
    embeddingModel?: string | null;
    extractionSource?: string | null;
    extractionWarnings?: string[];
  } | null>(null);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);
  const { toast } = useToast();

  const { data: profiles = [] } = useQuery<BusinessProfile[]>({
    queryKey: ["business-profiles"],
    queryFn: () => api.get<BusinessProfile[]>("/api/settings/business-profiles"),
  });

  useEffect(() => {
    const lifetime = { active: true };
    pageLifetime.current = lifetime;
    return () => { lifetime.active = false; };
  }, []);

  const loadEntries = useCallback(async (showLoading = true) => {
    // Mutation callbacks can outlive the filter closure that started them.
    // Resolve the active scope when the read starts, then keep that ownership.
    const scope = listScope.current;
    if (!scope?.active) return;
    const request = ++listRead.current;
    listInFlight.current = request;
    const ownsRead = () => scope.active && scope === listScope.current && request === listRead.current;
    try {
      if (showLoading) setLoading(true);
      setLoadError(false);
      const queryParam = scope.profileFilter !== "all" ? `?businessProfileId=${encodeURIComponent(scope.profileFilter)}` : "";
      const response = await api.get<KnowledgeEntry[] | { success: boolean; data: KnowledgeEntry[]; entries?: KnowledgeEntry[] }>(`/api/knowledge-base${queryParam}`);
      if (!ownsRead()) return;
      if (Array.isArray(response)) {
        setEntries(response);
      } else if (response && typeof response === 'object') {
        if ('data' in response && Array.isArray(response.data)) {
          setEntries(response.data);
        } else if ('entries' in response && Array.isArray(response.entries)) {
          setEntries(response.entries);
        } else {
          setEntries([]);
        }
      } else {
        setEntries([]);
      }
    } catch (error) {
      if (!ownsRead()) return;
      console.error("Failed to load knowledge base entries:", error);
      setLoadError(true);
    } finally {
      if (ownsRead()) setLoading(false);
      if (listInFlight.current === request) listInFlight.current = 0;
    }
  }, []);

  useEffect(() => {
    const scope = { profileFilter, active: true };
    listScope.current = scope;
    void loadEntries();
    return () => { scope.active = false; };
  }, [profileFilter, loadEntries]);

  useEffect(() => () => { previewRead.current++; }, []);

  useEffect(() => {
    if (!entries.some((entry) => entry.processingStatus === "queued" || entry.processingStatus === "processing")) return;
    // Skip a poll while the previous read is still running; otherwise a read
    // slower than 5s is always superseded and the list never updates.
    // Hidden tabs skip polls too; the next tick after the tab is shown catches up.
    const interval = window.setInterval(() => { if (!listInFlight.current && document.visibilityState !== 'hidden') void loadEntries(false); }, 5000);
    return () => window.clearInterval(interval);
  }, [entries, loadEntries]);

  const openDeleteDialog = (id: number) => {
    setEntryToDelete(id);
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (entryToDelete === null) return;
    const lifetime = pageLifetime.current;
    if (!lifetime.active) return;

    try {
      setIsDeleting(true);
      await api.delete(`/api/knowledge-base/${entryToDelete}`);
      if (!lifetime.active) return;
      toast({
        title: "Deleted",
        description: "Entry deleted successfully",
      });
      void loadEntries();
    } catch (error: unknown) {
      if (!lifetime.active) return;
      toast({
        title: "Error",
        description: (error as Error).message || "Failed to delete entry",
        variant: "destructive",
      });
    } finally {
      if (lifetime.active) {
        setIsDeleting(false);
        setDeleteDialogOpen(false);
        setEntryToDelete(null);
      }
    }
  };

  const openExtractedTextViewer = async (entry: KnowledgeEntry, opener: HTMLButtonElement) => {
    const request = ++previewRead.current;
    previewOpener.current = opener;
    try {
      setViewLoading(true);
      setExtractedData(null);
      setViewEntryName(entry.title || entry.fileName || 'Entry');
      setViewDialogOpen(true);
      const response = await api.get<{
        success: boolean;
        extractedText: string;
        chunks: { index: number; text: string; charStart: number; charEnd: number; tokenEstimate: number; hasEmbedding: boolean | null }[];
        readiness?: KnowledgeReadiness | null;
        embeddingsGenerated: boolean;
        embeddingModel?: string | null;
        extractionSource?: string | null;
        extractionWarnings?: string[];
      }>(`/api/knowledge-base/${entry.id}/extracted-text`);
      if (request !== previewRead.current) return;
      setExtractedData(response);
      setSelectedChunkIndex(0);
    } catch {
      if (request !== previewRead.current) return;
      toast({ title: "Error", description: "Failed to load extracted text", variant: "destructive" });
      changeViewDialogOpen(false);
    } finally {
      if (request === previewRead.current) setViewLoading(false);
    }
  };

  const handleReloadConversion = async (entry: KnowledgeEntry) => {
    const lifetime = pageLifetime.current;
    if (!lifetime.active) return;
    try {
      const result = await api.post<{ processingStatus?: string; message?: string }>(`/api/knowledge-base/${entry.id}/reprocess`, {});
      if (!lifetime.active) return;
      toast({
        title: result.processingStatus === 'completed' ? 'Reindexed' : 'Reprocessing queued',
        description: result.message || `${entry.title} has been queued for conversion again.`,
      });
      void loadEntries();
    } catch {
      if (!lifetime.active) return;
      toast({
        title: "Error",
        description: "Failed to queue reprocessing.",
        variant: "destructive",
      });
    }
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getTypeIcon = (type: string, fileType?: string) => {
    if (type === "qa") return <HelpCircle className="h-4 w-4 text-green-500" />;
    if (type === "url") return <Globe className="h-4 w-4 text-primary" />;
    if (type === "file" && fileType) {
      const ext = fileType.toLowerCase();
      if (ext.includes("pdf")) return <FileText className="h-4 w-4 text-red-500" />;
      if (ext.includes("word") || ext === "docx" || ext === "doc") return <FileType className="h-4 w-4 text-blue-500" />;
      if (ext.includes("presentation") || ext === "pptx" || ext === "ppt") return <Presentation className="h-4 w-4 text-orange-500" />;
      if (ext.includes("spreadsheet") || ext.includes("excel") || ext === "xlsx" || ext === "xls" || ext === "csv") return <FileSpreadsheet className="h-4 w-4 text-emerald-500" />;
      if (ext === "txt" || ext.includes("text")) return <FileCode className="h-4 w-4 text-muted-foreground" />;
      return <File className="h-4 w-4 text-muted-foreground" />;
    }
    return <FileText className="h-4 w-4 text-blue-500" />;
  };

  const getFileTypeBadge = (entry: KnowledgeEntry) => {
    if (entry.type === "qa") return { label: "Q&A", color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" };
    if (entry.type === "url") return { label: "URL", color: "bg-primary/10 text-primary" };
    if (entry.type === "document") return { label: "Document", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" };
    if (entry.type === "file") {
      const ext = (entry.fileType || entry.fileName || "").toLowerCase();
      if (ext.includes("pdf")) return { label: "PDF", color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" };
      if (ext.includes("word") || ext.includes("docx") || ext.includes("doc")) return { label: "DOCX", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" };
      if (ext.includes("presentation") || ext.includes("pptx") || ext.includes("ppt")) return { label: "PPTX", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400" };
      if (ext.includes("spreadsheet") || ext.includes("excel") || ext.includes("xlsx") || ext.includes("xls")) return { label: "Excel", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" };
      if (ext.includes("csv")) return { label: "CSV", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" };
      if (ext.includes("txt") || ext.includes("text")) return { label: "TXT", color: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400" };
      return { label: "File", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400" };
    }
    return { label: entry.type, color: "bg-gray-100 text-gray-800" };
  };

  const getProcessingBadge = (status?: KnowledgeEntry["processingStatus"]) => {
    switch (status) {
      case 'queued':
        return { label: 'Queued', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400' };
      case 'processing':
        return { label: 'Processing', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' };
      case 'failed':
        return { label: 'Failed', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' };
      case 'completed':
        return { label: 'Extraction complete', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' };
      default:
        return { label: 'Extraction status unknown', color: 'bg-muted text-muted-foreground' };
    }
  };

  const getKnowledgeBadge = (status?: KnowledgeEntry['knowledgeStatus']) => {
    switch (status) {
      case 'published': return { label: 'Published evidence', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' };
      case 'published_degraded': return { label: 'Published · lexical only', color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' };
      case 'ready_for_review': return { label: 'Review required', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' };
      case 'quarantined': return { label: 'Quarantined', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' };
      case 'failed': return { label: 'Index failed', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' };
      case 'ocr_required': return { label: 'OCR required', color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' };
      case 'retired': return { label: 'Retired', color: 'bg-muted text-muted-foreground' };
      default: return { label: 'Legacy · not governed', color: 'bg-muted text-muted-foreground' };
    }
  };

  const getEntryPreview = (entry: KnowledgeEntry) => {
    if (entry.description) return entry.description;
    if (entry.type === 'qa' && entry.question) return entry.question;
    if (entry.type === 'file') return entry.fileName || 'Uploaded file';

    let content = (entry.content || '').trim();
    if (content.startsWith('{')) {
      try {
        const parsed = JSON.parse(content) as { extractedText?: unknown; text?: unknown };
        if (typeof parsed.extractedText === 'string') content = parsed.extractedText;
        else if (typeof parsed.text === 'string') content = parsed.text;
      } catch {
        // Keep the original text when this is ordinary prose that begins with a brace.
      }
    }
    const normalized = content
      .replace(/^#+\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized ? `${normalized.slice(0, 140)}${normalized.length > 140 ? '…' : ''}` : 'No preview available';
  };

  const filteredEntries = entries.filter(entry => {
    const matchesSearch = entry.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (entry.content || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (entry.question || '').toLowerCase().includes(searchQuery.toLowerCase());

    if (filterType === "all") return matchesSearch;
    if (filterType === "document" || filterType === "qa" || filterType === "url") return matchesSearch && entry.type === filterType;

    // File type filters
    if (filterType === "file") return matchesSearch && entry.type === "file";
    if (filterType === "pdf") return matchesSearch && entry.type === "file" && (entry.fileType || entry.fileName || "").toLowerCase().includes("pdf");
    if (filterType === "docx") return matchesSearch && entry.type === "file" && /(word|docx|doc)/.test((entry.fileType || entry.fileName || "").toLowerCase());
    if (filterType === "pptx") return matchesSearch && entry.type === "file" && /(presentation|pptx|ppt)/.test((entry.fileType || entry.fileName || "").toLowerCase());
    if (filterType === "excel") return matchesSearch && entry.type === "file" && /(spreadsheet|excel|xlsx|xls|csv)/.test((entry.fileType || entry.fileName || "").toLowerCase());
    if (filterType === "txt") return matchesSearch && entry.type === "file" && /(text|txt)/.test((entry.fileType || entry.fileName || "").toLowerCase());

    return matchesSearch;
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      {/* Header */}
      <PageHeader
        icon={BookOpen}
        title="Knowledge base"
        subtitle="Manage the trusted business context used by AI replies, proposals, and support"
        actions={
          <div className="flex flex-wrap gap-2">
            <KnowledgeRetrievalTester profiles={profiles} />
            <Button variant="outline" size="sm" onClick={() => router.push('/dashboard/knowledge-base/documents')}>
              <FileText className="mr-2 h-4 w-4" />Documents
            </Button>
            <Button variant="outline" size="sm" onClick={() => router.push('/dashboard/knowledge-base/media')}>
              <Images className="mr-2 h-4 w-4" />
              Media galleries
            </Button>
            <Button variant="outline" size="sm" onClick={() => void loadEntries(false)} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => router.push('/dashboard/knowledge-base/new')}>
              <Plus className="mr-2 h-4 w-4" />
              Add entry
            </Button>
          </div>
        }
      />

      {/* Search and Filter */}
      <div className="flex flex-col sm:flex-row gap-3 rounded-xl border border-border/50 p-3 shadow-sm">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none z-10 text-muted-foreground/60" />
          <Input
            ref={searchInputRef}
            placeholder="Search knowledge base..."
            aria-label="Search knowledge base"
            className="pl-10 h-9 rounded-lg border-border/60 text-sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {searchQuery && <Button type="button" variant="outline" size="sm" className="h-9 rounded-lg" onClick={clearSearch}>Clear search</Button>}
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger aria-label="Entry type filter" className="w-full sm:w-[180px] h-9 rounded-lg border-border/60 text-sm">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent className="rounded-xl">
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="document">Documents</SelectItem>
            <SelectItem value="qa">Q&A</SelectItem>
            <SelectItem value="url">URL</SelectItem>
            <SelectItem value="file">All Files</SelectItem>
            <SelectItem value="pdf">PDF</SelectItem>
            <SelectItem value="docx">Word (DOCX)</SelectItem>
            <SelectItem value="pptx">PowerPoint (PPTX)</SelectItem>
            <SelectItem value="excel">Excel / CSV</SelectItem>
            <SelectItem value="txt">Text (TXT)</SelectItem>
          </SelectContent>
        </Select>
        {profiles.length > 0 && (
          <Select value={profileFilter} onValueChange={setProfileFilter}>
            <SelectTrigger aria-label="Business profile filter" className="w-full sm:w-[180px] h-9 rounded-lg border-border/60 text-sm">
              <SelectValue placeholder="Business profile" />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectItem value="all">Current business</SelectItem>
              <SelectItem value="none">Unassigned</SelectItem>
              {profiles.filter(profile => profile.id === selectedBusinessProfileId()).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.companyName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Entries Grid */}
      {loadError && entries.length === 0 ? (
        <PageErrorState
          reset={() => void loadEntries()}
          title="Knowledge base could not be loaded"
          description="Your entries are safe. Check the connection and try again."
        />
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <Skeleton className="h-5 w-32" />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <div className="flex justify-end gap-2 mt-4">
                  <Skeleton className="h-8 w-20 rounded-lg" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredEntries.length === 0 ? (
        <Card className="rounded-xl border-dashed border-2 border-border/40 bg-transparent overflow-hidden">
          <CardContent className="flex flex-col items-center justify-center p-12 text-center">
            <div className="w-10 h-10 rounded-lg bg-muted/40 flex items-center justify-center mb-4">
              <BookOpen className="h-7 w-7 text-muted-foreground/40" />
            </div>
            <h3 className="text-sm font-semibold mb-2">No entries found</h3>
            <p className="text-sm text-muted-foreground max-w-xs mb-6 leading-relaxed">
              {searchQuery || filterType !== "all"
                ? "No entries match your search criteria"
                : "Start building your knowledge base by adding documents, FAQs, or URLs"}
            </p>
            {!searchQuery && filterType === "all" && (
              <Button className="h-8 text-xs rounded-lg px-4 gap-1.5" onClick={() => router.push('/dashboard/knowledge-base/new')}>
                 <Plus className="h-3.5 w-3.5 mr-2" />
                 Add First Entry
               </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredEntries.map((entry) => (
            <Card key={entry.id} className="group hover:border-primary/40 shadow-sm hover:shadow transition-all rounded-xl overflow-hidden bg-card border border-border/40">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between mb-3">
                  <div className="p-2.5 rounded-lg bg-muted/40 transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                    {getTypeIcon(entry.type, entry.fileType || entry.fileName)}
                  </div>
                  {(() => {
                    const badge = getFileTypeBadge(entry);
                    return <Badge className={`text-xs border-none px-2 py-0.5 rounded-md ${badge.color}`}>{badge.label}</Badge>;
                  })()}
                </div>
                <CardTitle className="text-sm font-semibold line-clamp-1 mb-1.5 group-hover:text-primary transition-colors">{entry.title}</CardTitle>
                <CardDescription className="line-clamp-2 text-xs font-medium leading-relaxed">
                  {getEntryPreview(entry)}
                </CardDescription>
              </CardHeader>
              <Separator className="bg-border/30 mx-6 w-auto" />
              <CardContent className="pt-4 flex flex-col gap-4">
                {(() => {
                  const badge = getKnowledgeBadge(entry.knowledgeStatus);
                  return (
                    <div className="flex items-center justify-between gap-2">
                      <Badge className={`border-none text-[11px] ${entry.readiness?.status.endsWith('_blocked') ? 'bg-destructive/10 text-destructive' : badge.color}`}>{entry.readiness ? readinessLabels[entry.readiness.status] || badge.label : ['published', 'published_degraded'].includes(entry.knowledgeStatus || '') ? 'Publication recorded · readiness unknown' : badge.label}</Badge>
                      {entry.knowledgeVersionNo ? <span className="text-[11px] text-muted-foreground">v{entry.knowledgeVersionNo}</span> : null}
                    </div>
                  );
                })()}
                {entry.readiness ? <KnowledgeReadinessDetails readiness={entry.readiness} /> : <div className="space-y-1 text-xs text-muted-foreground">
                  <p>{entry.currentPublishedVersionId ? `${entry.liveStatus === 'expired' ? 'Expired' : entry.liveStatus === 'scheduled' ? 'Scheduled' : 'Live'}: v${entry.liveVersionNo || "?"}${entry.liveStatus === "published_degraded" ? " · keyword search only" : ""}` : "Not available to agents yet"}</p>
                  {entry.knowledgeStatus === 'ready_for_review' && <p>Draft v{entry.knowledgeVersionNo} awaiting review</p>}
                  <p>{entry.audience === 'internal' || entry.accessScope === 'staff_only' ? 'Staff only' : 'Customers and staff'} · {entry.allowedChannels?.length ? entry.allowedChannels.join(', ') : 'All channels'}{entry.locale ? ` · ${entry.locale}` : ''}</p>
                  <p>Keyword index: {entry.lexicalIndexStatus || 'pending'} · Semantic index: {entry.vectorIndexStatus || 'pending'}</p>
                  <p>Current retrieval readiness unavailable.</p>
                </div>}
                {entry.readiness && <p className="text-xs text-muted-foreground">Configured audience: {entry.audience === 'internal' || entry.accessScope === 'staff_only' ? 'Staff only' : 'Customers and staff'} · {entry.allowedChannels?.length ? entry.allowedChannels.join(', ') : 'All channels'}{entry.locale ? ` · ${entry.locale}` : ''}</p>}
                {entry.readiness?.isLive && entry.knowledgeVersionId !== entry.readiness.versionId && <p className="text-xs text-muted-foreground">Latest version: v{entry.knowledgeVersionNo} · {entry.knowledgeStatus?.replaceAll('_', ' ')}</p>}
                {/* File info */}
                {entry.type === 'file' && entry.fileName && (
                  <div className="bg-muted/20 p-2.5 rounded-lg border border-border/40">
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mb-1">
                      <File className="h-3 w-3 shrink-0" />
                      <span className="truncate">{entry.fileName}</span>
                      {entry.fileSize && <span className="shrink-0">({formatFileSize(entry.fileSize)})</span>}
                    </div>
                    {(() => {
                      const badge = getProcessingBadge(entry.processingStatus);
                      return <Badge className={`text-xs px-1.5 py-0 rounded-md bg-transparent border-none ${badge.color.split(' ')[1]}`}>{badge.label}</Badge>;
                    })()}
                  </div>
                )}
                {/* URL info */}
                {entry.type === 'url' && entry.sourceUrl && (
                  <div className="bg-muted/20 p-2.5 rounded-lg border border-border/40">
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mb-1">
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="truncate">{entry.sourceUrl}</span>
                    </div>
                    {(() => {
                      const badge = getProcessingBadge(entry.processingStatus);
                      return <Badge className={`text-xs px-1.5 py-0 rounded-md bg-transparent border-none ${badge.color.split(' ')[1]}`}>{badge.label}</Badge>;
                    })()}
                  </div>
                )}
                {/* Q&A info */}
                {entry.type === 'qa' && entry.question && (
                  <div className="text-xs font-normal text-muted-foreground p-3 bg-muted/30 rounded-xl border border-border/30 line-clamp-2">
                    Q: {entry.question.substring(0, 80)}{entry.question.length > 80 ? '...' : ''}
                  </div>
                )}
                
                <div className="flex flex-wrap justify-end gap-1 pt-2">
                   {entry.knowledgeVersionId ? (
                     <Button
                       variant="outline"
                       size="sm"
                       className="h-9 rounded-lg text-xs"
                       onClick={() => setReviewEntry(entry)}
                     >
                       Review versions
                     </Button>
                   ) : null}
                   {(entry.type === 'file' || entry.type === 'url') && entry.processingStatus === 'completed' && (
                     <Button variant="ghost" size="icon" aria-label={`View extracted text for ${entry.title}`} className="h-9 w-9 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors" onClick={(event) => void openExtractedTextViewer(entry, event.currentTarget)} title="View extracted text & chunks">
                       <Eye className="h-4 w-4" />
                     </Button>
                   )}
                   {(
                     <Button
                       variant="ghost"
                       size="icon"
                       className="h-9 w-9 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
                       onClick={() => handleReloadConversion(entry)}
                       title="Rebuild index"
                       aria-label={`Rebuild index for ${entry.title}`}
                       disabled={entry.processingStatus === 'processing' || entry.processingStatus === 'queued'}
                     >
                       <RefreshCw className="h-4 w-4" />
                     </Button>
                   )}
                   <Button variant="ghost" size="icon" aria-label={`Edit ${entry.title}`} className="h-9 w-9 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors" onClick={() => router.push(`/dashboard/knowledge-base/${entry.id}`)}>
                     <Edit className="h-4 w-4" />
                   </Button>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${entry.title}`} className="h-9 w-9 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors" onClick={() => openDeleteDialog(entry.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {reviewEntry && <KnowledgeReviewDialog entry={reviewEntry} profiles={profiles} onClose={() => setReviewEntry(null)} onChanged={() => void loadEntries(false)} />}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Entry</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this knowledge base entry? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setEntryToDelete(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {isDeleting && <Spinner size="sm" label={null} className="mr-2" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Extracted Text Viewer Dialog */}
      <Dialog open={viewDialogOpen} onOpenChange={changeViewDialogOpen}>
        <DialogContent className="max-w-5xl h-[80vh] flex flex-col"
          onOpenAutoFocus={previewReturnFocus.onOpenAutoFocus}
          onCloseAutoFocus={previewReturnFocus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>Extracted Text & Chunks</DialogTitle>
            <DialogDescription>{viewEntryName}</DialogDescription>
          </DialogHeader>

          {viewLoading ? (
            <LoadingState className="flex-1" label="Loading extracted text…" />
          ) : extractedData ? (
            <>
            {extractedData.readiness && <KnowledgeReadinessDetails readiness={extractedData.readiness} />}
            {extractedData.extractionWarnings?.map(warning => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
            <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Chunk list */}
              <div className="md:col-span-1 min-h-0 border rounded-lg flex flex-col">
                <div className="p-3 border-b">
                  <p className="text-sm font-medium">Chunks ({extractedData.chunks.length})</p>
                  <p className="text-xs text-muted-foreground">
                    {extractedData.embeddingsGenerated
                      ? `Embeddings generated${extractedData.embeddingModel ? ` (${extractedData.embeddingModel})` : ''}`
                      : extractedData.extractionSource === 'legacy_preview' ? 'Current embedding status unknown' : 'Active index embeddings incomplete or unavailable'}
                  </p>
                </div>
                <ScrollArea className="flex-1 p-2">
                  <div className="space-y-2">
                    {extractedData.chunks.length === 0 ? (
                      <p className="text-xs text-muted-foreground p-2">No chunks available.</p>
                    ) : (
                      extractedData.chunks.map((chunk, idx) => (
                        <button
                          key={chunk.index}
                          type="button"
                          onClick={() => setSelectedChunkIndex(idx)}
                          className={`w-full text-left rounded-md border p-2 transition-colors ${
                            selectedChunkIndex === idx
                              ? 'border-primary bg-primary/5'
                              : 'hover:bg-muted/40'
                          }`}
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium">Chunk {chunk.index + 1}</span>
                            <Badge variant={chunk.hasEmbedding ? 'default' : 'secondary'} className="text-[10px]">
                              {chunk.hasEmbedding === null ? 'Unknown' : chunk.hasEmbedding ? 'Embedded' : 'No active embedding'}
                            </Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1 truncate">
                            {chunk.text.substring(0, 80)}...
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            ~{chunk.tokenEstimate} tokens
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </div>

              {/* Chunk preview */}
              <div className="md:col-span-2 min-h-0 border rounded-lg flex flex-col">
                <div className="p-3 border-b">
                  <p className="text-sm font-medium">
                    {extractedData.chunks[selectedChunkIndex]
                      ? `Chunk ${extractedData.chunks[selectedChunkIndex].index + 1} Preview`
                      : 'Full Text'}
                  </p>
                </div>
                <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
                  <ScrollArea className="flex-1 rounded-md border p-3 bg-muted/20">
                    <pre className="whitespace-pre-wrap text-xs leading-relaxed font-mono">
                      {extractedData.chunks[selectedChunkIndex]?.text || extractedData.extractedText || 'No text found.'}
                    </pre>
                  </ScrollArea>
                </div>
              </div>
            </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              No extracted data available.
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
