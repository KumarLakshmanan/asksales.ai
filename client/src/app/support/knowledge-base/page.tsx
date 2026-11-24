"use client";

import { useState, useEffect, useCallback, useDeferredValue, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen, FileText, Globe, HelpCircle,
  File, FileSpreadsheet, FileType, Presentation, FileCode,
  Clock, Eye,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingState } from "@/components/ui/loading-state";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatFileSize } from "@/lib/display-format";

interface KBEntry {
  id: number; title: string; description: string | null; content?: string;
  type: string; processingStatus: string; fileName: string | null;
  fileType?: string | null; fileSize?: number | null; sourceUrl: string | null;
  question: string | null; answer: string | null; createdAt: string; updatedAt: string;
  versionNo?: number; audience?: string; vectorIndexStatus?: string; allowedChannels?: string[]; locale?: string;
}

interface ExtractedKnowledgeBaseData {
  extractedText: string;
  chunks: { index: number; text: string; charStart: number; charEnd: number; tokenEstimate: number; hasEmbedding: boolean }[];
  totalChunks?: number;
  truncated?: boolean;
  embeddingsGenerated: boolean;
  embeddingModel?: string | null;
  extractionSource?: string | null;
  extractionWarnings?: string[];
}

export default function SupportKnowledgeBasePage() {
  const router = useRouter();
  const { member, isLoading: authLoading } = useSupportAuth();
  const { toast } = useToast();

  const [entries, setEntries] = useState<KBEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadErrorText, setLoadErrorText] = useState("");
  const requestVersion = useRef(0);
  const [ticketInput, setTicketInput] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [resolvedScope, setResolvedScope] = useState<{ businessProfileId: number | null; ticketId: number | null } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewEntryName, setViewEntryName] = useState("");
  const [extractedData, setExtractedData] = useState<ExtractedKnowledgeBaseData | null>(null);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const deferredSearch = useDeferredValue(searchQuery.trim());

  const loadEntries = useCallback(async () => {
    const request = ++requestVersion.current;
    setLoading(true);
    setLoadError(false);
    setResolvedScope(null);
    try {
      const query = new URLSearchParams({
        page: String(page),
        limit: "24",
        type: filterType,
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(ticketId ? { ticketId } : {}),
      });
      const result = await supportApi.get<{
        entries: KBEntry[];
        total: number;
        page: number;
        totalPages: number;
        resolvedScope?: { businessProfileId: number | null; ticketId: number | null };
      }>(`/api/support-portal/knowledge-base?${query}`);
      if (request !== requestVersion.current) return;
      setEntries(result.entries || []);
      setTotal(result.total || 0);
      setResolvedScope(result.resolvedScope || null);
    } catch (error) {
      if (request !== requestVersion.current) return;
      setLoadError(true);
      setLoadErrorText(error instanceof Error ? error.message : "Published knowledge could not be loaded. Try again.");
      toast({ title: "Error", description: "Failed to load knowledge base", variant: "destructive" });
      setEntries([]);
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [deferredSearch, filterType, page, toast, ticketId]);

  useEffect(() => {
    if (!authLoading && !member) { router.push("/support/login"); return; }
    if (member) loadEntries();
  }, [member, authLoading, loadEntries, router]);

  const getTypeIcon = (type: string, fileType?: string | null) => {
    if (type === "qa") return <HelpCircle className="h-4 w-4 text-success" />;
    if (type === "url") return <Globe className="h-4 w-4 text-primary" />;
    if (type === "file" && fileType) {
      const ext = fileType.toLowerCase();
      if (ext.includes("pdf")) return <FileText className="h-4 w-4 text-destructive" />;
      if (ext.includes("word") || ext === "docx" || ext === "doc") return <FileType className="h-4 w-4 text-info" />;
      if (ext.includes("presentation") || ext === "pptx" || ext === "ppt") return <Presentation className="h-4 w-4 text-warning" />;
      if (ext.includes("spreadsheet") || ext.includes("excel") || ext === "xlsx" || ext === "csv") return <FileSpreadsheet className="h-4 w-4 text-success" />;
      if (ext === "txt" || ext.includes("text")) return <FileCode className="h-4 w-4 text-muted-foreground" />;
      return <File className="h-4 w-4 text-muted-foreground" />;
    }
    return <FileText className="h-4 w-4 text-info" />;
  };

  const getFileTypeBadge = (entry: KBEntry) => {
    if (entry.type === "qa") return { label: "Q&A", color: "bg-success/10 text-success" };
    if (entry.type === "url") return { label: "URL", color: "bg-primary/10 text-primary" };
    if (entry.type === "document") return { label: "Document", color: "bg-info/10 text-info" };
    if (entry.type === "file") {
      const ext = (entry.fileType || entry.fileName || "").toLowerCase();
      if (ext.includes("pdf")) return { label: "PDF", color: "bg-destructive/10 text-destructive" };
      if (ext.includes("word") || ext.includes("docx") || ext.includes("doc")) return { label: "DOCX", color: "bg-info/10 text-info" };
      if (ext.includes("presentation") || ext.includes("pptx")) return { label: "PPTX", color: "bg-warning/10 text-warning" };
      if (ext.includes("spreadsheet") || ext.includes("excel") || ext.includes("xlsx") || ext.includes("csv")) return { label: "Excel", color: "bg-success/10 text-success" };
      return { label: "File", color: "bg-warning/10 text-warning" };
    }
    return { label: entry.type, color: "bg-muted text-muted-foreground" };
  };

  const getProcessingBadge = (status?: string) => {
    switch (status) {
      case "queued": return { label: "Queued", color: "bg-warning/10 text-warning" };
      case "processing": return { label: "Processing", color: "bg-info/10 text-info" };
      case "failed": return { label: "Failed", color: "bg-destructive/10 text-destructive" };
      default: return { label: "Ready", color: "bg-success/10 text-success" };
    }
  };

  const openExtractedTextViewer = async (entry: KBEntry) => {
    try {
      setViewLoading(true);
      setViewEntryName(entry.title || entry.fileName || "Entry");
      setViewDialogOpen(true);
      const response = await supportApi.get<ExtractedKnowledgeBaseData>(`/api/support-portal/knowledge-base/${entry.id}/extracted-text${ticketId ? `?ticketId=${encodeURIComponent(ticketId)}` : ''}`);
      setExtractedData(response);
      setSelectedChunkIndex(0);
    } catch {
      toast({ title: "Error", description: "Failed to load extracted text", variant: "destructive" });
      setViewDialogOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  if (authLoading) return <LoadingState label="Loading knowledge base…" />;
  if (!member) return null;

  return (
    <div className="space-y-5 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <BookOpen className="h-4 w-4 text-primary" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Knowledge Base</h1>
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">Read only</Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">View published documents, FAQs, and extracted reference content</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <SearchInput aria-label="Search knowledge base" placeholder="Search knowledge base..." size="sm" wrapperClassName="flex-1" className="rounded-lg border-border/60 text-sm"
          value={searchQuery} onValueChange={(value) => { setSearchQuery(value); setPage(1); }} />
        <Select value={filterType} onValueChange={(value) => { setFilterType(value); setPage(1); }}>
          <SelectTrigger aria-label="Filter knowledge base by type" className="w-full sm:w-[160px] h-9 rounded-lg text-sm border-border/60">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent className="rounded-xl">
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="document">Documents</SelectItem>
            <SelectItem value="qa">Q&A</SelectItem>
            <SelectItem value="url">URL</SelectItem>
            <SelectItem value="file">Files</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Grid */}
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setPage(1); setTicketId(ticketInput.trim()); setViewDialogOpen(false); }}>
          <label className="space-y-1">Ticket context (optional)<Input inputMode="numeric" value={ticketInput} onChange={event => setTicketInput(event.target.value)} placeholder="Ticket ID" pattern="[1-9][0-9]*" /></label>
          <Button variant="outline" type="submit">Apply ticket context</Button>
          {ticketId && <Button variant="ghost" onClick={() => { setTicketInput(''); setTicketId(''); setPage(1); setViewDialogOpen(false); }}>Clear context</Button>}
        </form>
        <p className="text-muted-foreground">{resolvedScope?.businessProfileId ? `Showing organization knowledge and business profile ${resolvedScope.businessProfileId} for ticket ${resolvedScope.ticketId}.` : 'Showing organization-wide published knowledge. Apply a ticket assigned to you or your team to include its property knowledge.'}</p>
      </div>
      {loading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="border border-border/50 rounded-xl shadow-none">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : loadError ? (
        <div role="alert" className="space-y-3 rounded-xl border p-6 text-sm">
          <p>{loadErrorText || "Published knowledge could not be loaded. Try again to check your available documents."}</p>
          <Button variant="outline" onClick={() => void loadEntries()}>Retry loading knowledge</Button>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-border/40 rounded-xl">
          <BookOpen className="h-6 w-6 text-muted-foreground/30 mb-2" />
          <p className="text-sm font-medium mb-1">No Entries Found</p>
          <p className="text-xs text-muted-foreground">
            {searchQuery || filterType !== "all" ? "Try adjusting your filters." : "No published entries are available for your support access. Ask the owner to review publication status and staff/channel scopes."}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => {
            const typeBadge = getFileTypeBadge(entry);
            const processingBadge = getProcessingBadge(entry.processingStatus);
            return (
              <Card key={entry.id} className="group border border-border/50 rounded-xl shadow-none hover:border-border hover:shadow-sm transition-all">
                <div className="px-4 pt-3 text-xs text-muted-foreground">Live{entry.versionNo ? ` v${entry.versionNo}` : ''} · {entry.audience === 'internal' ? 'Staff only' : 'Customers and staff'}{entry.vectorIndexStatus === 'failed' ? ' · Keyword search only' : ''}{entry.locale ? ` · ${entry.locale}` : ''}</div>
                <CardHeader className="pb-3 px-4 pt-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="p-2 rounded-lg bg-muted/50">
                      {getTypeIcon(entry.type, entry.fileType || entry.fileName)}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className={cn("text-xs font-medium border-none px-2 py-0.5 h-auto", typeBadge.color)}>
                        {typeBadge.label}
                      </Badge>
                      {entry.processingStatus && entry.processingStatus !== "completed" && (
                        <Badge variant="secondary" className={cn("text-xs font-medium border-none px-2 py-0.5 h-auto", processingBadge.color)}>
                          {processingBadge.label}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <CardTitle className="text-base font-semibold line-clamp-1 group-hover:text-primary transition-colors">
                    {entry.title}
                  </CardTitle>
                  <CardDescription className="line-clamp-2 text-sm mt-1">
                    {entry.description ||
                      (entry.type === "qa" && entry.question) ||
                      (entry.type === "file" && `${entry.fileName || "File"} - Ready for AI reference`) ||
                      (entry.content || "").substring(0, 120) + ((entry.content?.length || 0) > 120 ? "..." : "")}
                  </CardDescription>
                </CardHeader>
                <Separator />
                <CardContent className="pt-3 px-4 pb-4 space-y-2">
                  {entry.type === "file" && entry.fileName && (
                    <div className="bg-muted/50 p-2 rounded-md text-sm text-muted-foreground flex items-center gap-2">
                      <File className="h-3 w-3 shrink-0" />
                      <span className="truncate">{entry.fileName}</span>
                      {entry.fileSize ? <span className="shrink-0 text-xs">({formatFileSize(entry.fileSize)})</span> : null}
                    </div>
                  )}
                  {entry.type === "url" && entry.sourceUrl && (
                    <div className="bg-muted/50 p-2 rounded-md text-sm text-muted-foreground flex items-center gap-2">
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="truncate">{entry.sourceUrl}</span>
                    </div>
                  )}
                  {entry.type === "qa" && entry.question && (
                    <div className="text-sm text-muted-foreground p-2 bg-muted/50 rounded-md line-clamp-2 italic">
                      Q: {entry.question.substring(0, 100)}{entry.question.length > 100 ? "..." : ""}
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {new Date(entry.updatedAt).toLocaleDateString()}
                    </div>
                    {(entry.type === "file" || entry.type === "url") && entry.processingStatus === "completed" && (
                      <button
                        type="button"
                        className="h-8 w-8 rounded-md hover:bg-muted transition-colors flex items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => openExtractedTextViewer(entry)}
                        title="View extracted text"
                        aria-label={`View extracted text for ${entry.title}`}
                      >
                        <Eye className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {!loading && total > 0 && (
        <Pagination
          page={page}
          pageSize={24}
          totalItems={total}
          onPageChange={setPage}
          itemLabel="entries"
          className="border-t border-border/50 pt-4"
        />
      )}

      {/* Extracted Text Dialog */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="max-w-5xl h-[80vh] flex flex-col rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">Extracted Text & Chunks</DialogTitle>
            <DialogDescription className="text-sm">{viewEntryName}</DialogDescription>
          </DialogHeader>

          {viewLoading ? (
            <LoadingState className="flex-1" label="Loading extracted content…" />
          ) : extractedData ? (
            <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-1 min-h-0 border rounded-xl flex flex-col">
                <div className="p-3 border-b">
                  <p className="text-sm font-semibold">
                    Chunks ({extractedData.chunks.length}
                    {extractedData.totalChunks && extractedData.totalChunks > extractedData.chunks.length
                      ? ` of ${extractedData.totalChunks}`
                      : ""})
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {extractedData.embeddingsGenerated ? `Embeddings: ${extractedData.embeddingModel || "Generated"}` : "No embeddings"}
                  </p>
                </div>
                <ScrollArea className="flex-1 p-2">
                  <div className="space-y-1.5">
                    {extractedData.chunks.length === 0 ? (
                      <p className="text-sm text-muted-foreground p-2">No chunks available.</p>
                    ) : (
                      extractedData.chunks.map((chunk, idx) => (
                        <button key={chunk.index} type="button" onClick={() => setSelectedChunkIndex(idx)}
                          className={cn("w-full text-left rounded-lg border p-2 transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selectedChunkIndex === idx ? "border-primary bg-primary/5" : "hover:bg-muted/40"
                          )}>
                          <div className="flex items-center justify-between">
                            <span className="font-medium">Chunk {chunk.index + 1}</span>
                            <Badge variant={chunk.hasEmbedding ? "default" : "secondary"} className="text-xs h-auto px-1.5 py-0.5">
                              {chunk.hasEmbedding ? "Embedded" : "No Embed"}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 truncate">{chunk.text.substring(0, 80)}...</p>
                          <p className="text-xs text-muted-foreground/70 mt-0.5">~{chunk.tokenEstimate} tokens</p>
                        </button>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </div>
              <div className="md:col-span-2 min-h-0 border rounded-xl flex flex-col">
                <div className="p-3 border-b">
                  <p className="text-sm font-semibold">
                    {extractedData.chunks[selectedChunkIndex] ? `Chunk ${extractedData.chunks[selectedChunkIndex].index + 1}` : "Full Text"}
                  </p>
                </div>
                <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
                  <ScrollArea className="flex-1 rounded-lg border p-3 bg-muted/20">
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-mono">
                      {extractedData.chunks[selectedChunkIndex]?.text || extractedData.extractedText || "No text found."}
                    </pre>
                  </ScrollArea>
                  {Array.isArray(extractedData.extractionWarnings) && extractedData.extractionWarnings.length > 0 && (
                    <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                      {extractedData.extractionWarnings.join(" ")}
                    </div>
                  )}
                  {extractedData.truncated && (
                    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                      This large entry is shown in a bounded preview. The complete content remains available to the retrieval pipeline.
                    </div>
                  )}
                </div>
              </div>
            </div>
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
