"use client";
import { calculateSmsMetrics } from "@/lib/smsMetrics";

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";


import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import {
  Phone,
  Plus,
  Sparkles,
  MessageSquare,
  ChevronRight,
} from "lucide-react";
import api from "@/lib/api";
import { LibraryLoadNotice } from "@/components/content-library/LibraryLoadNotice";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { TemplatePreviewCard } from "@/components/content-library/TemplatePreviewCard";
import { DraftLibraryCard } from "@/components/content-library/DraftLibraryCard";
import { libraryCampaignUrl } from "@/lib/libraryDraft";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePaginatedContentTemplates } from "@/hooks/use-paginated-content-templates";
import { type SavedContentAsset as ContentAsset } from "../template-types";

interface SmsTemplate {
  id: number;
  userId?: number | null;
  name: string;
  type: string;
  content: string;
  description?: string;
  category?: string;
  tags?: string[];
  variables?: string[];
  isPredefined?: boolean;
  usageCount?: number;
  createdAt: string;
  updatedAt: string;
}

// Types removed - showing all templates combined

/** Extract display text from SMS content (may be JSON from content executor) */
function extractSmsText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'string') return parsed;
    if (parsed.message) return parsed.message;
    if (parsed.body) {
      return [parsed.greeting, parsed.body, parsed.closing].filter(Boolean).join('\n\n');
    }
    if (parsed.text) return parsed.text;
    if (parsed.content) return parsed.content;
    if (parsed.greeting || parsed.body || parsed.closing) {
      return [parsed.greeting, parsed.body, parsed.closing].filter(Boolean).join('\n\n');
    }
    const stringFields = Object.values(parsed).filter(v => typeof v === 'string' && v.length > 5);
    if (stringFields.length > 0) return stringFields[0] as string;
    return content;
  } catch {
    return content;
  }
}

export default function SmsTemplatesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState("");
  const [collection, setCollection] = useState('all');
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SmsTemplate | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<SmsTemplate | ContentAsset | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategory, setFormCategory] = useState("");

  // Fetch user templates
  const {
    templates,
    isLoading: loadingTemplates,
    isError: templatesError,
    refetch: refetchTemplates,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = usePaginatedContentTemplates<SmsTemplate>({
    type: "sms",
    search: searchQuery,
    queryKey: "sms-templates",
  });

  // Fetch content studio SMS assets
  const { data: contentAssets = [], isLoading: loadingAssets, isError: assetsError, refetch: refetchAssets } = useQuery({
    queryKey: ["sms-content-assets"],
    queryFn: () => api.get<ContentAsset[]>("/api/content/assets?type=sms_template"),
  });

  // Create template
  const createMutation = useMutation({
    mutationFn: (data: { name: string; type: string; content: string; description?: string; category?: string }) =>
      api.post("/api/content/templates", data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] });
      queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
      toast({ title: "Template created" });
      resetForm();
    },
    onError: (error: Error) => toast({ title: "Failed to create template", description: error.message, variant: "destructive" }),
  });

  // Update template
  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; name: string; type: string; content: string; description?: string; category?: string }) =>
      api.put(`/api/content/templates/${id}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] });
      queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
      toast({ title: "Template updated" });
      resetForm();
    },
    onError: (error: Error) => toast({ title: "Failed to update template", description: error.message, variant: "destructive" }),
  });

  // Delete template
  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/content/templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] });
      queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
      toast({ title: "Template deleted" });
    },
    onError: () => toast({ title: "Failed to delete template", variant: "destructive" }),
  });

  // AI generate

  const [aiGenerating, setAiGenerating] = useState(false);
  const [_generatingImageForId, setGeneratingImageForId] = useState<number | null>(null);
  const handleAIGenerate = async () => {
    setAiGenerating(true);
    try {
      const res = await api.post<{ content?: string; body?: string }>("/api/content/studio/sms", {
        prompt: formName || formDescription || "Create a professional marketing follow-up SMS",
        persist: false,
      });
      const text = res.content || res.body || "";
      if (text) {
        setFormContent(text);
        toast({ title: "AI generated SMS content" });
      }
    } catch {
      toast({ title: "AI generation failed", variant: "destructive" });
    } finally {
      setAiGenerating(false);
    }
  };

  const resetForm = () => {
    setShowEditor(false);
    setEditingTemplate(null);
    setFormName("");
    setFormContent("");
    setFormDescription("");
    setFormCategory("");
  };

  const openCreate = () => {
    router.push("/dashboard/saved-templates/sms/generate");
  };

  const openEdit = (t: SmsTemplate) => {
    setEditingTemplate(t);
    setFormName(t.name);
    setFormContent(t.content);
    setFormDescription(t.description || "");
    setFormCategory(t.category || "");
    setShowEditor(true);
  };

  const handleSave = () => {
    if (!formName.trim() || !formContent.trim()) {
      toast({ title: "Name and content are required", variant: "destructive" });
      return;
    }
    const payload = { name: formName, type: "sms" as const, content: formContent, description: formDescription, category: formCategory };
    if (editingTemplate) {
      updateMutation.mutate({ id: editingTemplate.id, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  // Combine all templates and filter by search
  const allTemplates = useMemo(() => {
    const combined = [
      ...templates.map(t => ({ ...t, source: t.isPredefined ? "predefined" as const : "my" as const })),
      ...contentAssets.map(a => ({ ...a, name: a.title, category: a.channel, source: "ai" as const })),
    ];
    const q = searchQuery.toLowerCase();
    const selected = combined.filter(t => collection === 'all' || (collection === 'drafts' ? t.source === 'ai' : t.source !== 'ai'));
    if (!q) return selected;
    return selected.filter((item) =>
      item.name.toLowerCase().includes(q) || 
      (item as { content?: string }).content?.toLowerCase().includes(q)
    );
  }, [templates, contentAssets, searchQuery, collection]);

  const isLoading = (loadingTemplates || loadingAssets) && allTemplates.length === 0;
  const isError = (templatesError || assetsError) && allTemplates.length === 0;

  // Detect variables in content
  const detectedVars = useMemo(() => {
    const matches = formContent.match(/\{\{(\w+)\}\}/g);
    return matches ? [...new Set(matches)] : [];
  }, [formContent]);

  const charCount = formContent.length;
  const smsMetrics = calculateSmsMetrics(formContent);
  const smsSegments = smsMetrics.segments;

  return (
    <div className="h-full min-w-0 overflow-x-hidden flex flex-col bg-background">
      <div className="px-4 pt-4">
        <button onClick={() => router.push("/dashboard/saved-templates")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Content library
        </button>
      </div>

      {/* Header */}
      <div className="p-4 border-b bg-card">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
              <Phone className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">SMS templates</h1>
              <p className="text-muted-foreground text-sm">Review saved SMS drafts or maintain reusable templates</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { resetForm(); setShowEditor(true); }}>Build reusable template</Button>
          <Button onClick={openCreate} className="w-full gap-2 sm:w-auto">
            <Plus className="w-4 h-4" /> Create SMS draft
          </Button>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <SearchInput
            aria-label="Search SMS templates"
            placeholder="Search templates..."
            value={searchQuery}
            onValueChange={setSearchQuery}
            wrapperClassName="w-full sm:max-w-sm sm:flex-1"
          />
        </div>
        <Tabs value={collection} onValueChange={setCollection} className="mt-4"><TabsList aria-label="SMS collection"><TabsTrigger value="all">All content</TabsTrigger><TabsTrigger value="drafts">Saved drafts</TabsTrigger><TabsTrigger value="templates">Reusable templates</TabsTrigger></TabsList></Tabs>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {!isError && <LibraryLoadNotice templatesError={templatesError} assetsError={assetsError} onRetry={() => { void refetchTemplates(); void refetchAssets(); }} />}
        {isLoading ? (
          <LoadingState size="section" label="Loading SMS templates…" />
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageSquare className="mb-3 h-12 w-12 text-muted-foreground" />
            <h3 className="text-lg font-semibold">SMS templates could not be loaded</h3>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
            <Button variant="outline" onClick={() => { void refetchTemplates(); void refetchAssets(); }}>Retry</Button>
          </div>
        ) : allTemplates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageSquare className="h-12 w-12 text-muted-foreground mb-3" />
            <h3 className="font-semibold text-lg mb-1">{searchQuery ? 'No matching SMS content' : 'No SMS content in this collection'}</h3>
            <p className="text-muted-foreground text-sm mb-4">{searchQuery ? 'Try another search or choose a different collection.' : 'Create a draft or build a reusable template to get started.'}</p>
            <Button onClick={openCreate} className="gap-2"><Plus className="w-4 h-4" /> Create Template</Button>
          </div>
        ) : (
          <div className="space-y-6">
          <MasonryGrid columns={3}>
            {allTemplates.map((item) => {
              const isContentAsset = item.source === "ai";
              if (isContentAsset) {
                const asset = item as ContentAsset;
                return (
                  <DraftLibraryCard key={`asset-${asset.id}`} asset={asset} kind="sms" onPreview={() => setPreviewTemplate(asset)} />
                );
              }
              const template = item as SmsTemplate & { source: string };
              return (
                <TemplatePreviewCard
                  key={`template-${template.id}`}
                  reusableTemplateId={template.id}
                  kind="sms"
                  title={template.name}
                  content={template.content}
                  description={template.description}
                  category="Reusable template"
                  createdAt={template.createdAt}
                  onPreview={() => setPreviewTemplate(template)}
                  onPrimary={() => router.push(libraryCampaignUrl('sms', 'template', template.id))}
                  primaryLabel="Use in campaign"
                  onEdit={template.source === "my" ? () => openEdit(template) : undefined}
                  onDelete={template.source === "my" ? () => deleteMutation.mutate(template.id) : undefined}
                />
              );
            })}
          </MasonryGrid>
          {hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void fetchNextPage()} loading={isFetchingNextPage}>
                Load more templates
              </Button>
            </div>
          )}
          </div>
        )}
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={showEditor} onOpenChange={(open) => { if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? "Edit SMS Template" : "Create SMS Template"}</DialogTitle>
            <DialogDescription>
              {editingTemplate ? "Update your SMS template" : "Create a reusable SMS message template"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="sms-name">Template Name</Label>
              <Input id="sms-name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Follow-up reminder" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor="sms-content">Message Content</Label>
                <Button variant="ghost" size="sm" onClick={handleAIGenerate} loading={aiGenerating} loadingText="AI Generate" className="gap-1 h-7 text-xs">
                  <Sparkles className="h-3 w-3" /> AI Generate
                </Button>
              </div>
              <Textarea id="sms-content" value={formContent} onChange={(e) => setFormContent(e.target.value)}
                placeholder="Hi {{first_name}}, just following up on..." rows={5} />
              <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
                <span>{charCount} chars · {smsMetrics.encoding} · {smsSegments} segment{smsSegments !== 1 ? "s" : ""}</span>
                {detectedVars.length > 0 && (
                  <span className="flex items-center gap-1">Variables: {detectedVars.map((v) => <Badge key={v} variant="secondary" className="text-xs">{v}</Badge>)}</span>
                )}
              </div>
            </div>
            <div>
              <Label htmlFor="sms-desc">Description (optional)</Label>
              <Input id="sms-desc" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Brief description" />
            </div>
            <div>
              <Label htmlFor="sms-cat">Category (optional)</Label>
              <Input id="sms-cat" value={formCategory} onChange={(e) => setFormCategory(e.target.value)} placeholder="e.g. Follow-up, Promo" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={resetForm}>Cancel</Button>
              <Button onClick={handleSave} loading={createMutation.isPending || updateMutation.isPending}>
                {editingTemplate ? "Update" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog - Phone Mockup */}
      <Dialog open={!!previewTemplate} onOpenChange={() => setPreviewTemplate(null)}>
        <DialogContent className="sm:max-w-sm p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-sky-600" />
              {"name" in (previewTemplate || {}) ? (previewTemplate as SmsTemplate)?.name : (previewTemplate as ContentAsset)?.title}
            </DialogTitle>
            <DialogDescription className="text-xs">SMS Template Preview</DialogDescription>
          </DialogHeader>
          {previewTemplate && (() => {
            const rawContent = "content" in previewTemplate ? previewTemplate.content : "";
            const content = extractSmsText(rawContent);
            const charCount = content.length;
            const metrics = calculateSmsMetrics(content);
            const segments = metrics.segments;
            const variables = content.match(/\{\{[^}]+\}\}/g) || [];
            return (
              <div className="px-4 py-4">
                {/* iPhone-style phone mockup */}
                <div className="mx-auto w-[280px] bg-gray-900 rounded-[2.5rem] p-3 shadow-xl">
                  {/* Phone notch */}
                  <div className="w-24 h-6 bg-gray-900 rounded-full mx-auto mb-2 flex items-center justify-center">
                    <div className="w-12 h-3 bg-gray-800 rounded-full" />
                  </div>
                  {/* Phone screen */}
                  <div className="bg-white dark:bg-slate-900 rounded-[1.5rem] overflow-hidden">
                    {/* Messages header */}
                    <div className="bg-gray-100 dark:bg-slate-800 px-4 py-3 flex items-center gap-3 border-b">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center">
                        <MessageSquare className="h-4 w-4 text-white" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold">Your Business</p>
                        <p className="text-xs text-muted-foreground">SMS</p>
                      </div>
                    </div>
                    {/* Messages area */}
                    <div className="p-4 min-h-[200px] bg-gradient-to-b from-gray-50 to-white dark:from-slate-950 dark:to-slate-900">
                      {/* Received message bubble (from business) */}
                      <div className="flex justify-start mb-2">
                        <div className="max-w-[85%] bg-gray-200 dark:bg-slate-700 rounded-2xl rounded-bl-sm px-4 py-2.5 shadow-sm">
                          <p className="text-sm whitespace-pre-wrap leading-relaxed">{content}</p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground text-left ml-1">
                        {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · Delivered ✓
                      </p>
                    </div>
                    {/* Input area */}
                    <div className="p-3 bg-gray-100 dark:bg-slate-800 border-t flex items-center gap-2">
                      <div className="flex-1 bg-white dark:bg-slate-700 rounded-full px-4 py-2 text-xs text-muted-foreground">
                        iMessage
                      </div>
                      <div className="w-7 h-7 rounded-full bg-green-500 flex items-center justify-center">
                        <span className="text-white text-xs">↑</span>
                      </div>
                    </div>
                  </div>
                  {/* Home indicator */}
                  <div className="w-32 h-1 bg-gray-600 rounded-full mx-auto mt-3" />
                </div>
                {/* Metadata below phone */}
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <div className="flex items-center gap-3">
                      <span>{charCount} chars · {metrics.encoding}</span>
                      <span className="text-muted-foreground">·</span>
                      <span>{segments} segment{segments > 1 ? "s" : ""}</span>
                    </div>
                    <span>{new Date(previewTemplate.createdAt).toLocaleDateString()}</span>
                  </div>
                  {variables.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-xs text-muted-foreground mr-1">Variables:</span>
                      {variables.map((v, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">{v}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
