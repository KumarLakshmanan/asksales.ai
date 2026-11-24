"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ArrowLeft,
  BookOpen,
  FileText,
  HelpCircle,
  Globe,
  File,
  FileSpreadsheet,
  FileType,
  Presentation,
  FileCode,
  Eye,
  AlertCircle,
} from "lucide-react";
import { formatFileSize } from "@/lib/display-format";

interface KnowledgeEntry {
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
  createdAt: string;
  updatedAt?: string;
}

export default function UserKnowledgeBasePage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewEntryName, setViewEntryName] = useState("");
  const [extractedData, setExtractedData] = useState<{
    extractedText: string;
    chunks: { index: number; text: string; charStart: number; charEnd: number; tokenEstimate: number; hasEmbedding: boolean }[];
    embeddingsGenerated: boolean;
    embeddingModel?: string | null;
    extractionSource?: string | null;
    extractionWarnings?: string[];
  } | null>(null);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);

  const fetchEntries = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<{ success: boolean; entries: KnowledgeEntry[] }>(`/api/admin/users/${id}/knowledge-base`);
      setEntries(data.entries || []);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load knowledge base";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const openExtractedTextViewer = async (entry: KnowledgeEntry) => {
    try {
      setViewLoading(true);
      setViewEntryName(entry.title || entry.fileName || "Entry");
      setViewDialogOpen(true);

      // Parse content JSON to extract chunks/text for file and url types
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: { [key: string]: any } | null = null;
      if (typeof entry.content === "string") {
        try { parsed = JSON.parse(entry.content); } catch { parsed = null; }
      }

      if (parsed && (parsed.extractedText || Array.isArray(parsed.chunks))) {
        const chunks = Array.isArray(parsed.chunks)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? parsed.chunks.map((chunk: { [key: string]: any }, index: number) => ({
              index: typeof chunk.index === "number" ? chunk.index : index,
              text: String(chunk.text || ""),
              charStart: typeof chunk.charStart === "number" ? chunk.charStart : 0,
              charEnd: typeof chunk.charEnd === "number" ? chunk.charEnd : String(chunk.text || "").length,
              tokenEstimate: typeof chunk.tokenEstimate === "number" ? chunk.tokenEstimate : Math.ceil(String(chunk.text || "").length / 4),
              hasEmbedding: Array.isArray(chunk.embedding) && chunk.embedding.length > 0,
            }))
          : [];
        setExtractedData({
          extractedText: String(parsed.extractedText || ""),
          chunks,
          embeddingsGenerated: !!parsed.embeddingsGenerated,
          embeddingModel: parsed.embeddingModel ? String(parsed.embeddingModel) : null,
          extractionSource: parsed.extractionSource ? String(parsed.extractionSource) : null,
          extractionWarnings: Array.isArray(parsed.extractionWarnings) ? parsed.extractionWarnings : [],
        });
      } else {
        setExtractedData({
          extractedText: typeof entry.content === "string" ? entry.content : "",
          chunks: [],
          embeddingsGenerated: false,
        });
      }
      setSelectedChunkIndex(0);
    } catch {
      toast({ title: "Error", description: "Failed to load extracted text", variant: "destructive" });
      setViewDialogOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  const getTypeIcon = (type: string, fileType?: string) => {
    if (type === "qa") return <HelpCircle className="h-4 w-4 text-green-500" />;
    if (type === "url") return <Globe className="h-4 w-4 text-primary" />;
    if (type === "file" && fileType) {
      const ext = fileType.toLowerCase();
      if (ext.includes("pdf")) return <FileText className="h-4 w-4 text-red-500" />;
      if (ext.includes("word") || ext === "docx" || ext === "doc") return <FileType className="h-4 w-4 text-blue-500" />;
      if (ext.includes("presentation") || ext === "pptx") return <Presentation className="h-4 w-4 text-orange-500" />;
      if (ext.includes("spreadsheet") || ext.includes("excel") || ext === "xlsx" || ext === "csv") return <FileSpreadsheet className="h-4 w-4 text-emerald-500" />;
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
      if (ext.includes("word") || ext.includes("docx")) return { label: "DOCX", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" };
      if (ext.includes("presentation") || ext.includes("pptx")) return { label: "PPTX", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400" };
      if (ext.includes("spreadsheet") || ext.includes("excel") || ext.includes("xlsx") || ext.includes("csv")) return { label: "Excel", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" };
      if (ext.includes("txt") || ext.includes("text")) return { label: "TXT", color: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400" };
      return { label: "File", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400" };
    }
    return { label: entry.type, color: "bg-muted text-muted-foreground" };
  };

  const getProcessingBadge = (status?: KnowledgeEntry["processingStatus"]): { label: string; tone: StatusTone } => {
    switch (status) {
      case "queued": return { label: "Queued", tone: "warning" };
      case "processing": return { label: "Processing", tone: "progress" };
      case "failed": return { label: "Failed", tone: "danger" };
      default: return { label: "Ready", tone: "success" };
    }
  };

  const filteredEntries = entries.filter((entry) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      entry.title.toLowerCase().includes(q) ||
      (entry.content || "").toLowerCase().includes(q) ||
      (entry.question || "").toLowerCase().includes(q) ||
      (entry.sourceUrl || "").toLowerCase().includes(q);
    if (filterType === "all") return matchesSearch;
    if (filterType === "document" || filterType === "qa" || filterType === "url") return matchesSearch && entry.type === filterType;
    if (filterType === "file") return matchesSearch && entry.type === "file";
    return matchesSearch;
  });

  if (loading) {
    return <LoadingState size="page" label="Loading knowledge base…" />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-4">
        <Link href={`/admin/dashboard/users/${id}/view`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge base</h1>
          <p className="text-muted-foreground mt-1">
            Knowledge base entries for this user
          </p>
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Knowledge base could not be loaded</AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void fetchEntries()}>Try again</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Search & Filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          aria-label="Search knowledge base"
          placeholder="Search knowledge base..."
          value={searchQuery}
          onValueChange={setSearchQuery}
          wrapperClassName="flex-1 sm:max-w-md"
        />
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-full sm:w-[160px]">
            <SelectValue placeholder="Filter type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="document">Documents</SelectItem>
            <SelectItem value="qa">Q&A</SelectItem>
            <SelectItem value="url">URL</SelectItem>
            <SelectItem value="file">Files</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Entries Grid */}
      {!loadError && (filteredEntries.length === 0 ? (
        <div className="text-center py-12">
          <BookOpen className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">
            {searchQuery || filterType !== "all" ? "No entries match your search" : "No knowledge base entries found"}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredEntries.map((entry) => {
            const typeBadge = getFileTypeBadge(entry);
            return (
              <Card key={entry.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {getTypeIcon(entry.type, entry.fileType || entry.fileName)}
                      <CardTitle className="text-lg line-clamp-1">{entry.title}</CardTitle>
                    </div>
                    <Badge className={typeBadge.color}>{typeBadge.label}</Badge>
                  </div>
                  <CardDescription className="line-clamp-2">
                    {entry.description ||
                      (entry.type === "qa" && entry.question) ||
                      (entry.type === "url" && entry.sourceUrl) ||
                      (entry.type === "file" && `${entry.fileName || "File"} - ${formatFileSize(entry.fileSize)}`) ||
                      (entry.content || "").substring(0, 100)}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {entry.type === "file" && entry.fileName && (
                    <div className="text-xs text-muted-foreground mb-2 flex items-center gap-2">
                      <File className="h-3 w-3" />
                      <span className="truncate">{entry.fileName}</span>
                      {entry.fileSize ? <span>({formatFileSize(entry.fileSize)})</span> : null}
                      {(() => {
                        const badge = getProcessingBadge(entry.processingStatus);
                        return <StatusBadge tone={badge.tone} label={badge.label} />;
                      })()}
                    </div>
                  )}
                  {entry.type === "url" && entry.sourceUrl && (
                    <div className="text-xs text-muted-foreground mb-2 flex items-center gap-2">
                      <Globe className="h-3 w-3" />
                      <span className="truncate">{entry.sourceUrl}</span>
                      {(() => {
                        const badge = getProcessingBadge(entry.processingStatus);
                        return <StatusBadge tone={badge.tone} label={badge.label} />;
                      })()}
                    </div>
                  )}
                  {entry.type === "qa" && entry.question && (
                    <div className="text-sm text-muted-foreground mb-2 p-2 bg-muted rounded">
                      <strong>Q:</strong> {entry.question.substring(0, 80)}{entry.question.length > 80 ? "..." : ""}
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : ""}
                    </span>
                    {(entry.type === "file" || entry.type === "url") && entry.processingStatus === "completed" && (
                      <Button variant="ghost" size="sm" onClick={() => openExtractedTextViewer(entry)} title="View extracted text & chunks">
                        <Eye className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ))}

      {!loadError && <div className="text-sm text-muted-foreground">
        Showing {filteredEntries.length} of {entries.length} entries
      </div>}

      {/* Extracted Text Viewer Dialog */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="flex h-[90dvh] max-w-5xl flex-col sm:h-[80vh]">
          <DialogHeader>
            <DialogTitle>Extracted Text & Chunks</DialogTitle>
            <DialogDescription>{viewEntryName}</DialogDescription>
          </DialogHeader>

          {viewLoading ? (
            <LoadingState className="flex-1" label="Loading extracted text…" />
          ) : extractedData ? (
            <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Chunk list */}
              <div className="md:col-span-1 min-h-0 border rounded-lg flex flex-col">
                <div className="p-3 border-b">
                  <p className="text-sm font-medium">Chunks ({extractedData.chunks.length})</p>
                  <p className="text-xs text-muted-foreground">
                    {extractedData.embeddingsGenerated
                      ? `Embeddings generated${extractedData.embeddingModel ? ` (${extractedData.embeddingModel})` : ""}`
                      : extractedData.extractionSource === "web-crawler" ? "Web crawler content" : "Embeddings not generated"}
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
                            selectedChunkIndex === idx ? "border-primary bg-primary/5" : "hover:bg-muted/40"
                          }`}
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium">Chunk {chunk.index + 1}</span>
                            <Badge variant={chunk.hasEmbedding ? "default" : "secondary"} className="text-[10px]">
                              {chunk.hasEmbedding ? "Embedded" : "No Embedding"}
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
                      : "Full Text"}
                  </p>
                </div>
                <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
                  <ScrollArea className="flex-1 rounded-md border p-3 bg-muted/20">
                    <pre className="whitespace-pre-wrap text-xs leading-relaxed font-mono">
                      {extractedData.chunks[selectedChunkIndex]?.text || extractedData.extractedText || "No text found."}
                    </pre>
                  </ScrollArea>
                  {Array.isArray(extractedData.extractionWarnings) && extractedData.extractionWarnings.length > 0 && (
                    <Callout tone="warning" size="sm">
                      {extractedData.extractionWarnings.join(" ")}
                    </Callout>
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
