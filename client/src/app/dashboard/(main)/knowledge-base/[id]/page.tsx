"use client";

import { selectedBusinessProfileId } from '@/lib/business-profile';
/**
 * Knowledge Base Add/Edit Page
 * Modern redesigned form for managing knowledge base entries
 * Handles three types: Document, File Upload, Q&A
 */

import React, { useState, useRef, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageErrorState } from "@/components/ui/page-state";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import {
  ArrowLeft,
  Save,
  FileText,
  HelpCircle,
  Upload,
  X,
  FileIcon,
  Plus,
  BookOpen,
  Trash2,
  CheckCircle2,
  Eye,
  Globe,
  Search,
  ExternalLink,
} from "lucide-react";

interface KnowledgeBaseEntry {
  id?: number;
  title: string;
  description?: string;
  type: "document" | "file" | "qa" | "url";
  processingStatus?: "queued" | "processing" | "completed" | "failed";
  content?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  question?: string;
  answer?: string;
  sourceUrl?: string;
  updatedAt?: string;
}

interface QAItem {
  question: string;
  answer: string;
}

type ValidationField = "title" | "content" | "file" | "qa" | "url";

interface ExtractedTextChunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  hasEmbedding: boolean;
}

interface ExtractedTextResponse {
  success: boolean;
  entryId: number;
  fileName?: string;
  type: string;
  processingStatus?: "queued" | "processing" | "completed" | "failed";
  extractedText: string;
  chunks: ExtractedTextChunk[];
  embeddingsGenerated: boolean;
  embeddingModel?: string | null;
  extractionSource?: string | null;
  extractionWarnings?: string[];
}

const DEFAULT_ENTRY: KnowledgeBaseEntry = {
  title: "",
  description: "",
  type: "document",
  content: "",
};

const TYPE_OPTIONS = [
  {
    value: "document" as const,
    label: "Document",
    description: "Text document or knowledge article",
    icon: FileText,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10 dark:bg-blue-500/5",
    borderColor: "border-blue-500/20 dark:border-blue-500/10",
    selectedBg: "bg-blue-500/10 border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.15)] ring-2 ring-blue-500/20",
  },
  {
    value: "file" as const,
    label: "File Upload",
    description: "PDF, DOCX, TXT, or CSV",
    icon: Upload,
    color: "text-orange-500",
    bgColor: "bg-orange-500/10 dark:bg-orange-500/5",
    borderColor: "border-orange-500/20 dark:border-orange-500/10",
    selectedBg: "bg-orange-500/10 border-orange-500 shadow-[0_0_20px_rgba(249,115,22,0.15)] ring-2 ring-orange-500/20",
  },
  {
    value: "qa" as const,
    label: "Q&A Pairs",
    description: "Question and answer format",
    icon: HelpCircle,
    color: "text-emerald-500",
    bgColor: "bg-emerald-500/10 dark:bg-emerald-500/5",
    borderColor: "border-emerald-500/20 dark:border-emerald-500/10",
    selectedBg: "bg-emerald-500/10 border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.15)] ring-2 ring-emerald-500/20",
  },
  {
    value: "url" as const,
    label: "Website URL",
    description: "Crawl a website and extract content",
    icon: Globe,
    color: "text-primary",
    bgColor: "bg-primary/10",
    borderColor: "border-primary/20",
    selectedBg: "border-primary bg-primary/10 ring-1 ring-primary/20",
  },
];

export default function KnowledgeBaseFormPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFocusId = useRef<string | null>(null);
  const batchRequestId = useRef<string | null>(null);
  const saveInFlight = useRef(false);

  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [entry, setEntry] = useState<KnowledgeBaseEntry>(DEFAULT_ENTRY);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [qaItems, setQaItems] = useState<QAItem[]>([{ question: "", answer: "" }]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [extractedViewerOpen, setExtractedViewerOpen] = useState(false);
  const [loadingExtracted, setLoadingExtracted] = useState(false);
  const [extractedData, setExtractedData] = useState<ExtractedTextResponse | null>(null);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);
  const [businessProfileId, setBusinessProfileId] = useState<string>("none");
  const [formError, setFormError] = useState<{ field: ValidationField; message: string } | null>(null);

  useEffect(() => {
    if (pendingFocusId.current) {
      document.getElementById(pendingFocusId.current)?.focus();
      pendingFocusId.current = null;
    }
  }, [uploadedFile, entry.fileName, qaItems.length]);

  const clearFieldError = (field: ValidationField) => {
    setFormError((error) => error?.field === field ? null : error);
  };
  const renderFieldError = (field: ValidationField) => formError?.field === field ? (
    <p id={`knowledge-${field}-error`} role="alert" className="text-sm text-destructive">{formError.message}</p>
  ) : null;

  // URL type state
  const [urlInput, setUrlInput] = useState("");
  const [_crawlLoading, setCrawlLoading] = useState(false);
  const [_crawledLinks, setCrawledLinks] = useState<{ url: string; title: string; category: string; priority?: number }[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());


  const { data: businessProfiles = [], error: businessProfilesError, refetch: refetchBusinessProfiles } = useQuery<{ id: number; companyName: string }[]>({
    queryKey: ["business-profiles"],
    queryFn: () => api.get<{ id: number; companyName: string }[]>("/api/settings/business-profiles"),
  });

  const isEditMode = params?.id && params.id !== "new";
  const entryId = isEditMode ? parseInt(params.id) : null;

  const loadEntry = async (id: number) => {
    try {
      setIsFetching(true);
      setFetchError(null);
      const response = await api.get<{
        success: boolean;
        entry: {
          id: number;
          title?: string;
          description?: string;
          type?: string;
          processingStatus?: "queued" | "processing" | "completed" | "failed";
          content?: string;
          fileName?: string;
          file_name?: string;
          fileType?: string;
          file_type?: string;
          fileSize?: number;
          file_size?: number;
          question?: string;
          answer?: string;
          updatedAt?: string;
        };
      }>(`/api/knowledge-base/${id}`);

      const data = response.entry;

      setEntry({
        id: data.id,
        updatedAt: data.updatedAt,
        title: data.title || "",
        description: data.description || "",
        type: (data.type as "document" | "file" | "qa" | "url") || "document",
        processingStatus: data.processingStatus || 'completed',
        content: data.content || "",
        fileName: data.fileName || data.file_name || "",
        fileType: data.fileType || data.file_type || "",
        fileSize: data.fileSize || data.file_size || 0,
        question: data.question || "",
        answer: data.answer || "",
        sourceUrl:
          typeof (data as Record<string, unknown>).sourceUrl === "string"
            ? (data as Record<string, unknown>).sourceUrl as string
            : typeof (data as Record<string, unknown>).source_url === "string"
              ? (data as Record<string, unknown>).source_url as string
              : "",
      });

      // Set business profile from loaded entry
      const loadedProfileId = (data as Record<string, unknown>).businessProfileId || (data as Record<string, unknown>).business_profile_id;
      if (loadedProfileId) {
        setBusinessProfileId(String(loadedProfileId));
      }

      if (data.type === "url") {
        setUrlInput((data as Record<string, unknown>).sourceUrl as string || (data as Record<string, unknown>).source_url as string || "");
      }

      if (data.type === "qa" && data.question) {
        setQaItems([{ question: data.question, answer: data.answer || "" }]);
      }
    } catch (error) {
      console.error("Failed to load knowledge base entry:", error);
      const message = error instanceof Error ? error.message : "Failed to load knowledge base entry";
      setFetchError(message);
      toast({
         title: "Error",
         description: message,
         variant: "destructive",
       });
    } finally {
      setIsFetching(false);
    }
  };

  // Load existing entry if editing
  useEffect(() => {
    if (entryId) {
      loadEntry(entryId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId]);

  const updateField = <K extends keyof KnowledgeBaseEntry>(field: K, value: KnowledgeBaseEntry[K]) => {
    setEntry((prev) => ({ ...prev, [field]: value }));
    if (field === "type") setFormError(null);
    if (field === "title" || field === "content") clearFieldError(field);
    if (field === "fileName") clearFieldError("file");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      pendingFocusId.current = "knowledge-remove-file";
      setUploadedFile(file);
      updateField("fileName", file.name);
      updateField("fileType", file.type);
      updateField("fileSize", file.size);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setUploadedFile(file);
      updateField("fileName", file.name);
      updateField("fileType", file.type);
      updateField("fileSize", file.size);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const removeFile = () => {
    pendingFocusId.current = "knowledge-choose-file";
    setUploadedFile(null);
    updateField("fileName", "");
    updateField("fileType", "");
    updateField("fileSize", 0);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Q&A Items Management
  const addQAItem = () => {
    setQaItems([...qaItems, { question: "", answer: "" }]);
  };

  const removeQAItem = (index: number) => {
    if (qaItems.length > 1) {
      pendingFocusId.current = `knowledge-question-${Math.min(index, qaItems.length - 2)}`;
      setQaItems(qaItems.filter((_, i) => i !== index));
      clearFieldError("qa");
    }
  };

  const updateQAItem = (index: number, field: "question" | "answer", value: string) => {
    const newItems = [...qaItems];
    newItems[index][field] = value;
    setQaItems(newItems);
    clearFieldError("qa");
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const loadExtractedText = async () => {
    if (!entry.id) return;
    try {
      setLoadingExtracted(true);
      const response = await api.get<ExtractedTextResponse>(`/api/knowledge-base/${entry.id}/extracted-text`);
      setExtractedData(response);
      setSelectedChunkIndex(0);
      setExtractedViewerOpen(true);
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to load extracted text and chunks',
        variant: 'destructive',
      });
    } finally {
      setLoadingExtracted(false);
    }
  };



  const validateForm = (): boolean => {
    const fail = (field: ValidationField, message: string, controlId: string) => {
      setFormError({ field, message });
      // The inline alert reports validation without a toast covering Save.
      document.getElementById(controlId)?.focus();
      return false;
    };
    if (!entry.title?.trim()) {
      return fail("title", "Title is required", "knowledge-title");
    }

    if (entry.type === "file" && !uploadedFile && !entry.fileName) {
      return fail("file", "Please upload a file", "knowledge-choose-file");
    }

    if (entry.type === "qa") {
      const validQAs = qaItems.filter((item) => item.question?.trim() && item.answer?.trim());
      if (validQAs.length === 0) {
        return fail("qa", "At least one Q&A pair with both question and answer is required", qaItems[0].question.trim() ? "knowledge-answer-0" : "knowledge-question-0");
      }
    }

    if (entry.type === "document" && !entry.content?.trim()) {
      return fail("content", "Content is required for document entries", "knowledge-content");
    }

    if (entry.type === "url" && !isEditMode) {
      if (!urlInput.trim()) {
        return fail("url", "URL is required", "knowledge-url");
      }
    }

    setFormError(null);
    return true;
  };

  const handleSave = async () => {
    if (saveInFlight.current || !validateForm()) return;
    saveInFlight.current = true;

    const profileIdValue = businessProfileId !== "none" ? Number(businessProfileId) : null;

    setIsLoading(true);
    try {
      if (entry.type === "file" && uploadedFile) {
        const formData = new FormData();
        formData.append("file", uploadedFile);
        formData.append("title", entry.title);
        formData.append("description", entry.description || "");
        if (profileIdValue) formData.append("businessProfileId", String(profileIdValue));

        const result = await api.postForm<{ success: boolean; error?: string; message?: string }>("/api/knowledge-base/upload", formData);

        if (!result.success) {
          throw new Error(result.error || result.message || "Failed to upload file");
        }

        toast({ title: "Success", description: "File uploaded successfully" });
      } else if (entry.type === "qa") {
        const validQAs = qaItems.filter((item) => item.question?.trim() && item.answer?.trim());

        if (validQAs.length === 0) {
          toast({ title: "Validation Error", description: "Please add at least one Q&A pair", variant: "destructive" });
          return;
        }

        if (entry.id && validQAs.length === 1) {
          const qa = validQAs[0];
          await api.put(`/api/knowledge-base/${entry.id}`, {
            title: entry.title,
            description: entry.description,
            question: qa.question,
            answer: qa.answer,
            type: "qa",
            expectedUpdatedAt:entry.updatedAt,
            businessProfileId: profileIdValue,
          });
          toast({ title: "Success", description: "Q&A updated successfully" });
        } else {
          batchRequestId.current ||= crypto.randomUUID();
          const result = await api.post<{success?:boolean;error?:string;results?:{entryId:number;status:string}[]}>("/api/knowledge-base/qa", {
            requestId:batchRequestId.current,
            qas: validQAs.map((q) => ({ ...q, title: entry.title, description: entry.description })),
            businessProfileId: profileIdValue,
          });
          if (result.success === false) {
            toast({title:'Saved; indexing retry needed',variant:'destructive',
              description:`${result.error || 'Some sources need indexing retry.'} Saved entry IDs: ${(result.results || []).map(item => item.entryId).join(', ')}.`,
            });
            return;
          }
          toast({ title: "Success", description: `${validQAs.length} Q&A entries saved successfully` });
        }
      } else {
        const data = {
          title: entry.title,
          description: entry.description,
          type: entry.type,
          content: entry.content,
          expectedUpdatedAt:entry.updatedAt,
          businessProfileId: profileIdValue,
        };

        if (entry.type === "url" && !entry.id) {
          // If user hasn't analyzed yet, auto-crawl before saving
          let urlsToSave = Array.from(selectedUrls);
          if (urlsToSave.length === 0) {
            // Auto-crawl: call the crawl endpoint and use all discovered pages
            const crawlRes = await api.post<{
              success: boolean;
              links?: { url: string }[];
              mainPage?: { url: string; title: string };
              error?: string;
            }>("/api/knowledge-base/crawl-url", { url: urlInput.trim() });
            if (!crawlRes.success || !crawlRes.links?.length) {
              toast({ title: "Error", description: crawlRes.error || "Failed to crawl website", variant: "destructive" });
              return;
            }
            urlsToSave = crawlRes.links.map(l => l.url);
          }
          await api.post("/api/knowledge-base/url", {
            title: entry.title,
            description: entry.description,
            sourceUrl: urlInput.trim(),
            selectedUrls: urlsToSave,
            businessProfileId: profileIdValue,
          });
        } else if (entry.id) {
          await api.put(`/api/knowledge-base/${entry.id}`, data);
        } else {
          await api.post("/api/knowledge-base", data);
        }

        toast({
          title: "Success",
           description: entry.id ? "Entry updated successfully" : "Entry created successfully",
         });
       }
 
       router.push("/dashboard/knowledge-base");
    } catch (error: unknown) {
      console.error("Failed to save knowledge base entry:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save entry",
        variant: "destructive",
      });
    } finally {
      saveInFlight.current = false;
      setIsLoading(false);
    }
  };

  // Character/word count for document content
  const wordCount = entry.content?.trim().split(/\s+/).filter(Boolean).length || 0;
  const charCount = entry.content?.length || 0;

  // Fetching skeleton
  if (isFetching) {
    return (
      <LoadingState className="h-[calc(100vh-200px)]" label="Loading entry..." showLabel />
    );
  }

  if (fetchError && entryId) {
    return <PageErrorState title="Knowledge base entry could not be loaded" description={fetchError} reset={() => void loadEntry(entryId)} />;
  }

  return (
    <div className="container max-w-full mx-auto p-4 space-y-8">
      {businessProfilesError && <Alert variant="destructive"><AlertTitle>Business profiles could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{businessProfilesError instanceof Error ? businessProfilesError.message : "Profile assignment is temporarily unavailable."}</span><Button variant="outline" size="sm" onClick={() => void refetchBusinessProfiles()}>Try again</Button></AlertDescription></Alert>}
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to Knowledge Base"
            onClick={() => router.push("/dashboard/knowledge-base")}
            className="h-8 w-8 rounded-lg hover:bg-secondary/80 shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Knowledge Base</p>
              <h1 className="text-base font-semibold">
                {isEditMode ? "Edit Entry" : "New Entry"}
              </h1>
            </div>
          </div>
        </div>
        <Button onClick={handleSave} loading={isLoading} className="h-8 px-4 rounded-lg text-xs gap-1.5 bg-primary hover:bg-primary/90">
          {isLoading ? null : <Save className="w-4 h-4" />}
          {isEditMode ? "Update" : "Save"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      {/* MAIN COLUMN */}
      <div className="space-y-6 min-w-0">

      {/* Type Selector + Basic Info — unified card */}
      <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
        <CardContent className="p-5 space-y-5">

          {/* Entry type as compact pills (only in create mode) */}
          {!isEditMode && (
            <div className="space-y-2">
              <p id="knowledge-type-label" className="text-xs font-medium text-muted-foreground">Entry Type</p>
              <div role="group" aria-labelledby="knowledge-type-label" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {TYPE_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const isSelected = entry.type === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => updateField("type", opt.value)}
                      className={`group relative px-2 sm:px-3 py-2.5 rounded-lg border text-left transition-all duration-200 flex items-center gap-1.5 sm:gap-2 ${
                        isSelected
                          ? `${opt.bgColor} border-current ${opt.color}`
                          : "bg-background/40 border-border/40 hover:border-border/80 text-muted-foreground"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="text-xs">{opt.label}</span>
                      {isSelected && <CheckCircle2 className="h-3 w-3 ml-auto shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Type chip in edit mode */}
          {isEditMode && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Type</span>
              <Badge variant="secondary" className="capitalize text-xs px-2 py-0.5 rounded-md">
                {entry.type === "qa" ? "Q&A" : entry.type}
              </Badge>
            </div>
          )}

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="knowledge-title" className="text-xs font-medium text-muted-foreground">
              Title <span aria-hidden="true" className="text-primary">*</span>
            </Label>
            <Input
              id="knowledge-title"
              required
              aria-invalid={formError?.field === "title" || undefined}
              aria-describedby={formError?.field === "title" ? "knowledge-title-error" : undefined}
              value={entry.title}
              onChange={(e) => updateField("title", e.target.value)}
              placeholder="E.g., Product FAQ, Company Overview, Sales Playbook"
              className="h-9 rounded-lg border-border/60 text-sm"
            />
            {renderFieldError("title")}
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="knowledge-description" className="text-xs font-medium text-muted-foreground">Description</Label>
            <Textarea
              id="knowledge-description"
              aria-describedby="knowledge-description-help"
              value={entry.description || ""}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Brief description (optional)"
              rows={2}
              className="rounded-lg border-border/60 text-sm p-3 focus-visible:ring-primary/20 transition-all resize-none leading-relaxed"
            />
            <p id="knowledge-description-help" className="text-xs text-muted-foreground">Optional brief description.</p>
          </div>
        </CardContent>
      </Card>

      {/* Step 3: Content (type-specific) */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-1 w-6 rounded-full bg-primary/40" />
          <h2 id="knowledge-content-heading" className="text-xs font-medium text-muted-foreground">
            {entry.type === "document" && <Label htmlFor="knowledge-content" className="text-xs">Document Content <span aria-hidden="true">*</span></Label>}
            {entry.type === "file" && <Label htmlFor="knowledge-file" className="text-xs">File Upload <span aria-hidden="true">{!entry.fileName && "*"}</span></Label>}
            {entry.type === "qa" && "Questions & Answers"}
            {entry.type === "url" && "Website URL"}
          </h2>
        </div>

        {/* Document Content */}
        {entry.type === "document" && (
          <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden group">
            <CardContent className="p-4">
              <div className="relative">
                <Textarea
                  id="knowledge-content"
                  required
                  aria-invalid={formError?.field === "content" || undefined}
                  aria-describedby={`knowledge-content-count${formError?.field === "content" ? " knowledge-content-error" : ""}`}
                  value={entry.content || ""}
                  onChange={(e) => updateField("content", e.target.value)}
                  placeholder="Enter your knowledge base content here…"
                  className="rounded-lg border-border/60 bg-background/30 font-mono text-[13px] leading-6 p-4 focus-visible:ring-primary/20 transition-all min-h-[320px]"
                />
                <div id="knowledge-content-count" className="absolute bottom-3 right-3 flex items-center gap-2 bg-background/80  px-2.5 py-1 rounded-md border border-border/40 shadow-sm opacity-60 group-hover:opacity-100 transition-opacity">
                  <span className="sr-only">{wordCount} words, {charCount} characters.</span>
                  <span aria-hidden="true" className="text-xs font-medium text-muted-foreground"><span className="text-primary">{wordCount}</span> w</span>
                  <Separator orientation="vertical" className="h-2.5 bg-border/40" />
                  <span aria-hidden="true" className="text-xs font-medium text-muted-foreground"><span className="text-primary">{charCount}</span> c</span>
                </div>
              </div>
              {renderFieldError("content")}
            </CardContent>
          </Card>
        )}

        {/* File Upload */}
        {entry.type === "file" && (
          <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
            <CardContent className="p-6 space-y-6">
              <input
                id="knowledge-file"
                type="file"
                tabIndex={-1}
                required={!entry.fileName}
                aria-invalid={formError?.field === "file" || undefined}
                aria-describedby={`knowledge-file-help${formError?.field === "file" ? " knowledge-file-error" : ""}`}
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".pdf,.docx,.txt,.md,.csv,.xls,.xlsx"
                className="sr-only"
              />
              <p id="knowledge-file-help" className="text-xs text-muted-foreground">Choose PDF, DOCX, TXT, CSV, XLS, XLSX or MD (max 10MB), or drop a file below.</p>
              {renderFieldError("file")}

              {uploadedFile || entry.fileName ? (
                <div className="flex items-center gap-3 p-3 sm:gap-6 sm:p-6 rounded-xl border border-orange-500/20 bg-orange-500/5 animate-in zoom-in duration-300">
                  <div className="w-10 h-10 sm:w-12 sm:h-12 shrink-0 rounded-xl bg-orange-500/10 flex items-center justify-center">
                    <FileIcon className="w-8 h-8 text-orange-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate mb-1">{uploadedFile?.name || entry.fileName}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {entry.fileType && (
                        <Badge variant="outline" className="max-w-full break-all whitespace-normal text-xs px-2 py-0.5 border-orange-500/20 text-orange-600 bg-transparent">
                          {entry.fileType.split("/").pop()?.toUpperCase()}
                        </Badge>
                      )}
                      <span className="text-xs font-bold text-muted-foreground/60">{entry.fileSize ? formatFileSize(entry.fileSize) : null}</span>
                    </div>
                  </div>
                  <Button id="knowledge-remove-file" variant="ghost" size="icon" aria-label="Remove file" onClick={removeFile} className="h-8 w-8 rounded-lg hover:bg-destructive/10 hover:text-destructive shrink-0 transition-colors">
                    <X className="w-5 h-5" />
                  </Button>
                </div>
              ) : (
                <button
                  id="knowledge-choose-file"
                  type="button"
                  aria-label="Choose file"
                  aria-invalid={formError?.field === "file" || undefined}
                  aria-describedby={`knowledge-file-help${formError?.field === "file" ? " knowledge-file-error" : ""}`}
                  className={`group w-full border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all duration-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isDragOver
                      ? "border-primary bg-primary/5 ring-4 ring-primary/10"
                      : "border-border/60 hover:border-primary/40 hover:bg-muted/30"
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                >
                  <div className="space-y-6">
                    <div className="mx-auto w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center transition-transform duration-300">
                      <Upload className="w-8 h-8 text-primary" />
                    </div>
                    <div>
                      <span className="block text-sm font-semibold mb-2">File Upload</span>
                      <p className="text-sm font-medium text-muted-foreground/60 max-w-[320px] mx-auto leading-relaxed">
                        Drop your file here, or <span className="text-primary font-bold">browse</span> PDF, DOCX, TXT, CSV, XLSX, MD (max 10MB)
                      </p>
                    </div>
                  </div>
                </button>
              )}

              {/* Existing file info for edit mode */}
              {isEditMode && entry.fileName && !uploadedFile && (
                <Callout tone="warning" size="sm" title="File Upload Warning" className="animate-in slide-in-from-bottom-2 duration-500">
                  Upload a new file above to replace the existing one.
                </Callout>
              )}

              {isEditMode && entry.id && (
                <div className="flex items-center justify-between p-6 rounded-lg border border-border/40 bg-muted/20  group">
                  <div className="flex items-center gap-5">
                    <div className="w-10 h-10 rounded-lg bg-muted/30 flex items-center justify-center">
                      <Search className="h-5 w-5 text-primary/60" />
                    </div>
                    <div>
                      <p className="text-xs font-medium mb-1">Extracted Text & Chunks</p>
                      <div className="flex items-center gap-3">
                        <p className="text-xs text-muted-foreground">Status:</p>
                        <StatusBadge status={entry.processingStatus || 'completed'} />
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={loadExtractedText}
                    loading={loadingExtracted}
                    disabled={entry.processingStatus !== 'completed' && entry.processingStatus !== 'failed'}
                    className="h-11 rounded-xl px-5 border-border/60 hover:bg-primary/5 hover:border-primary/40 font-bold transition-all gap-2"
                  >
                    <Eye className="w-4 h-4" />
                    View Extracted Text
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Q&A Pairs */}
        {entry.type === "qa" && (
          <div role="group" aria-labelledby="knowledge-content-heading" aria-describedby={`knowledge-qa-help${formError?.field === "qa" ? " knowledge-qa-error" : ""}`} className="space-y-6">
            <p id="knowledge-qa-help" className="text-xs text-muted-foreground">At least one complete question and answer pair is required. Only complete pairs will be saved.</p>
            {renderFieldError("qa")}
            {qaItems.map((qa, index) => (
              <Card key={index} className="overflow-hidden rounded-xl border-border bg-card shadow-none">
                <CardHeader className="p-6 pb-3 bg-muted/20 border-b border-border/30">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                        <HelpCircle className="w-4 h-4 text-emerald-500" />
                      </div>
                      <CardTitle className="text-xs font-medium text-muted-foreground">
                        Q&A Pair #{index + 1}
                      </CardTitle>
                    </div>
                    {qaItems.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive text-xs px-2 transition-colors"
                        onClick={() => removeQAItem(index)}
                        aria-label={`Remove Q&A pair ${index + 1}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-2" />
                        Remove
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-6 space-y-6">
                  <div className="space-y-3">
                    <Label htmlFor={`knowledge-question-${index}`} className="text-xs font-medium ml-1">
                      Question <span className="sr-only">{index + 1}</span> {qaItems.length === 1 && <span aria-hidden="true" className="text-primary font-semibold">*</span>}
                    </Label>
                    <Textarea
                      id={`knowledge-question-${index}`}
                      required={qaItems.length === 1}
                      aria-invalid={formError?.field === "qa" && !qa.question.trim() || undefined}
                      aria-describedby={`knowledge-qa-help${formError?.field === "qa" ? " knowledge-qa-error" : ""}`}
                      value={qa.question}
                      onChange={(e) => updateQAItem(index, "question", e.target.value)}
                      placeholder="E.g., What are your pricing plans?"
                      rows={2}
                      className="rounded-lg border-border/60 text-sm p-3 focus-visible:ring-primary/20 transition-all resize-none"
                    />
                  </div>
                  <div className="space-y-3">
                    <Label htmlFor={`knowledge-answer-${index}`} className="text-xs font-medium ml-1">
                      Answer <span className="sr-only">{index + 1}</span> {qaItems.length === 1 && <span aria-hidden="true" className="text-primary font-semibold">*</span>}
                    </Label>
                    <Textarea
                      id={`knowledge-answer-${index}`}
                      required={qaItems.length === 1}
                      aria-invalid={formError?.field === "qa" && !qa.answer.trim() || undefined}
                      aria-describedby={`knowledge-qa-help${formError?.field === "qa" ? " knowledge-qa-error" : ""}`}
                      value={qa.answer}
                      onChange={(e) => updateQAItem(index, "answer", e.target.value)}
                      placeholder="Provide a detailed answer that the AI can use..."
                      rows={5}
                      className="rounded-lg border-border/60 text-sm p-3 focus-visible:ring-primary/20 transition-all resize-none"
                    />
                  </div>
                </CardContent>
              </Card>
            ))}

            {qaItems.length < 10 && (
              <Button
                type="button"
                variant="outline"
                className="w-full border-dashed h-9 rounded-xl bg-transparent hover:bg-muted/30 hover:border-primary/40 text-xs transition-all text-muted-foreground/60 hover:text-primary"
                onClick={addQAItem}
              >
                <Plus className="w-5 h-5 mr-3" />
                Add Another Q&A Pair
                <span className="ml-3 px-2 py-0.5 rounded-md bg-muted text-[10px]">({qaItems.length}/10)</span>
              </Button>
            )}
          </div>
        )}

        {/* URL Content */}
        {entry.type === "url" && (
          <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
            <CardHeader className="p-6 pb-3">
              <CardDescription id="knowledge-url-help" className="text-xs font-bold leading-relaxed">
                Enter a website URL. All pages will be automatically crawled and indexed.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0 space-y-6">
              {/* URL Input */}
              <div className="space-y-4">
                <Label htmlFor="knowledge-url" className="text-xs font-medium ml-1">
                  Website URL {!isEditMode && <span aria-hidden="true" className="text-primary font-semibold">*</span>}
                </Label>
                <div className="relative">
                  <Globe className="absolute left-5 top-1/2 -translate-y-1/2 h-5 w-5 pointer-events-none z-10 text-primary/40 group-focus-within:text-primary transition-colors" />
                  <Input
                    id="knowledge-url"
                    required={!isEditMode}
                    aria-invalid={formError?.field === "url" || undefined}
                    aria-describedby={`knowledge-url-help${formError?.field === "url" ? " knowledge-url-error" : ""}`}
                    value={urlInput}
                    onChange={(e) => { setUrlInput(e.target.value); clearFieldError("url"); }}
                    placeholder="https://example.com"
                    className="pl-10 h-10 rounded-lg border-border/60 text-sm focus-visible:ring-primary/20 transition-all"
                    disabled={isEditMode as boolean}
                  />
                </div>
                {renderFieldError("url")}
                {isEditMode && entry.sourceUrl && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/5 border border-primary/10 w-fit">
                    <ExternalLink className="h-3 w-3 text-primary/60" />
                    <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-primary/60">Source: {entry.sourceUrl}</span>
                  </div>
                )}
                {!isEditMode && (
                  <p className="text-[10px] font-bold text-muted-foreground/40 ml-1 italic">
                    The website will be crawled automatically when you save the entry.
                  </p>
                )}
              </div>

              {/* Edit mode: show existing content + extracted text viewer */}
              {isEditMode && entry.content && (
                <div className="flex items-center justify-between p-6 rounded-lg border border-border/40 bg-muted/20  group animate-in zoom-in duration-500">
                  <div className="flex items-center gap-5">
                    <div className="w-10 h-10 rounded-lg bg-muted/30 flex items-center justify-center">
                      <Search className="h-5 w-5 text-primary/60" />
                    </div>
                    <div>
                      <p className="text-xs font-medium mb-1">Extracted Text & Chunks</p>
                      <div className="flex items-center gap-3">
                        <p className="text-xs text-muted-foreground">Status:</p>
                        <StatusBadge status={entry.processingStatus || 'completed'} />
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={loadExtractedText}
                    loading={loadingExtracted}
                    disabled={entry.processingStatus !== 'completed' && entry.processingStatus !== 'failed'}
                    className="h-11 rounded-xl px-5 border-border/60 hover:bg-primary/5 hover:border-primary/40 font-bold transition-all gap-2"
                  >
                    <Eye className="w-4 h-4" />
                    View Extracted Text
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      </div>
      {/* SIDEBAR COLUMN */}
      <aside className="space-y-4 lg:sticky lg:top-4 self-start">
        {businessProfiles.length > 0 && (
          <Card className="rounded-xl border border-border/40 bg-card shadow-sm">
            <CardContent className="p-4 space-y-2">
              <Label htmlFor="knowledge-profile" className="text-xs font-medium text-muted-foreground">Business Profile</Label>
              <Select disabled value={businessProfileId} onValueChange={setBusinessProfileId}>
                <SelectTrigger id="knowledge-profile" aria-describedby="knowledge-profile-help" className="h-10 rounded-lg border-border/60 text-sm px-3 focus-visible:ring-primary/20">
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent className="rounded-xl">
                  <SelectItem value="none">Current business</SelectItem>
                  {businessProfiles.filter(profile => profile.id === selectedBusinessProfileId()).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.companyName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="knowledge-profile-help" className="text-[10px] text-muted-foreground/60 leading-relaxed">
                This entry belongs to the current business workspace.
              </p>
            </CardContent>
          </Card>
        )}

        <Card className="rounded-xl border border-border/40 bg-card shadow-sm">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <BookOpen className="h-3.5 w-3.5 text-primary" />
              </div>
              <p className="text-xs font-medium text-muted-foreground">Tips</p>
            </div>
            <ul className="text-[11px] leading-relaxed text-muted-foreground space-y-1.5">
              <li>• Use clear, descriptive titles so the AI can match user queries.</li>
              <li>• Add a description for better contextual retrieval.</li>
              <li>• Files larger than 10MB are not supported.</li>
              <li>• Q&A pairs work best for FAQ content.</li>
            </ul>
          </CardContent>
        </Card>
      </aside>
      </div>

      {/* Bottom Actions */}
       <div className="flex items-center justify-between pb-12 pt-6">
         <Button
           variant="ghost"
           onClick={() => router.push("/dashboard/knowledge-base")}
           className="h-8 text-xs rounded-lg px-3 gap-1.5 text-muted-foreground"
         >
           <ArrowLeft className="h-3.5 w-3.5" />
           Back to List
         </Button>
        <Button onClick={handleSave} loading={isLoading} className="h-8 text-xs rounded-lg px-4 gap-1.5">
          {isLoading ? null : <Save className="w-5 h-5 mr-3" />}
          {isEditMode ? "Update Entry" : "Save Entry"}
        </Button>
      </div>

      <Dialog open={extractedViewerOpen} onOpenChange={setExtractedViewerOpen}>
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col rounded-xl shadow-lg p-0 overflow-hidden">
          <div className="p-4 border-b border-border/40 bg-card">
            <DialogHeader>
              <div className="flex items-center gap-4 mb-2">
                <div className="p-2.5 rounded-xl bg-background shadow-inner">
                  <Search className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <DialogTitle className="text-lg font-semibold tracking-tighter">Extracted Text and Chunks</DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">{extractedData?.fileName || entry.fileName || 'Uploaded document'}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
          </div>

          {extractedData ? (
            <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3 gap-6 p-6 bg-muted/10">
              <div className="md:col-span-1 min-h-0 flex flex-col gap-4">
                <div className="flex items-center justify-between px-1">
                  <h4 className="text-xs text-muted-foreground">Chunks ({extractedData.chunks.length})</h4>
                </div>
                <div className="flex-1 rounded-lg border border-border/40 bg-card/60  shadow-inner overflow-hidden flex flex-col">
                  <ScrollArea className="flex-1 p-4">
                    <div className="space-y-3">
                      {extractedData.chunks.length === 0 ? (
                        <div className="p-6 text-center opacity-40">
                          <p className="text-xs">No Chunks Indexed</p>
                        </div>
                      ) : (
                        extractedData.chunks.map((chunk, idx) => (
                          <button
                            key={chunk.index}
                            type="button"
                            onClick={() => setSelectedChunkIndex(idx)}
                            className={`w-full text-left rounded-xl border p-4 transition-all duration-300 group ${
                              selectedChunkIndex === idx
                                ? 'border-primary bg-primary/10 shadow-lg translate-x-1'
                                : 'border-border/40 bg-background/40 hover:bg-background hover:border-primary/20'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs group-hover:text-primary transition-colors">Chunk {chunk.index + 1}</span>
                              <Badge variant={chunk.hasEmbedding ? 'default' : 'secondary'} className={`text-[8px] font-semibold tracking-tighter border-none px-1.5 py-0 ${chunk.hasEmbedding ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
                                {chunk.hasEmbedding ? 'EMBEDDED' : 'PENDING'}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-3 text-[9px] font-bold text-muted-foreground/60">
                              <span>S:{chunk.charStart}</span>
                              <span>E:{chunk.charEnd}</span>
                              <Separator orientation="vertical" className="h-2 bg-border/40" />
                              <span className="text-primary/60">~{chunk.tokenEstimate} TOKENS</span>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>

              <div className="md:col-span-2 min-h-0 flex flex-col gap-4">
                <div className="flex items-center justify-between px-1">
                  <h4 className="text-xs text-muted-foreground">Chunk Preview</h4>
                  <Badge className="bg-primary/5 text-primary border-none text-xs">
                    {extractedData.chunks[selectedChunkIndex] ? `Chunk ${extractedData.chunks[selectedChunkIndex].index + 1}` : 'Full extracted text'}
                  </Badge>
                </div>
                <div className="flex-1 space-y-4 min-h-0">
                  <ScrollArea className="h-2/3 rounded-xl border border-border/40 bg-background shadow-inner p-6">
                    <pre className="whitespace-pre-wrap text-[13px] leading-8 font-mono text-foreground/80">
                      {extractedData.chunks[selectedChunkIndex]?.text || extractedData.extractedText || 'No extracted text found.'}
                    </pre>
                  </ScrollArea>
                  <div className="h-1/3 flex flex-col gap-3">
                    <div className="flex items-center gap-2 px-1">
                      <FileText className="h-3 w-3 text-primary/40" />
                      <span className="text-xs text-muted-foreground/60">Full Extracted Text</span>
                    </div>
                    <ScrollArea className="flex-1 rounded-lg border border-border/40 bg-muted/30 p-6">
                      <pre className="whitespace-pre-wrap text-[11px] leading-relaxed font-mono text-muted-foreground/60">
                        {extractedData.extractedText || 'No extracted text found.'}
                      </pre>
                    </ScrollArea>
                  </div>
                </div>
                {Array.isArray(extractedData.extractionWarnings) && extractedData.extractionWarnings.length > 0 && (
                  <Callout tone="warning" size="sm" className="animate-in fade-in slide-in-from-bottom-2">
                    {extractedData.extractionWarnings.join(' ')}
                  </Callout>
                )}
              </div>
            </div>
          ) : (
            <LoadingState className="flex-1 p-20 opacity-40" label="Loading extracted data..." showLabel />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
