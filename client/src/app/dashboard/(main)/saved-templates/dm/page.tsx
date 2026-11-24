"use client";

import React, { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import {
  MessageCircle, Plus, Search, Sparkles,
  Facebook, Twitter, Linkedin, Instagram, ChevronRight,
} from "lucide-react";
import api from "@/lib/api";
import { readLibraryDraft, updateLibraryDraft } from "@/lib/libraryDraft";
import { LibraryLoadNotice } from "@/components/content-library/LibraryLoadNotice";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { LoadingState } from "@/components/ui/loading-state";
import { usePaginatedContentTemplates } from "@/hooks/use-paginated-content-templates";
import { TemplatePreviewCard } from "@/components/content-library/TemplatePreviewCard";
import { DraftLibraryCard } from '@/components/content-library/DraftLibraryCard';
import { useDmOutreach } from "@/components/content-studio/useDmOutreach";
import { type SavedTextTemplate as DmTemplate } from "../template-types";

interface ContentAsset {
  id: number;
  type: string;
  title: string;
  content: string;
  channel: string;
  imageUrls?: string[];
  videoUrls?: string[];
  status?: string;
  prompt?: string;
  createdAt: string;
}

type Platform = "instagram" | "facebook" | "twitter" | "linkedin";

const platformIcons: Record<Platform, React.ReactNode> = {
  instagram: <Instagram className="h-4 w-4" />,
  facebook: <Facebook className="h-4 w-4" />,
  twitter: <Twitter className="h-4 w-4" />,
  linkedin: <Linkedin className="h-4 w-4" />,
};

const platformLabels: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
};

function extractDmText(content: string): string {
  try {
    const p = JSON.parse(content);
    if (typeof p === 'string') return p;
    if (p.message) return p.message;
    if (p.body) {
      return [p.greeting, p.body, p.closing].filter(Boolean).join('\n\n');
    }
    if (p.text) return p.text;
    if (p.dm) return p.dm;
    if (p.content) return p.content;
    if (p.greeting || p.body || p.closing) {
      return [p.greeting, p.body, p.closing].filter(Boolean).join('\n\n');
    }
    const stringFields = Object.values(p).filter(v => typeof v === 'string' && v.length > 10);
    if (stringFields.length > 0) return stringFields[0] as string;
    return content;
  } catch { return content; }
}

export default function DmPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { openOutreach, destinationDialog } = useDmOutreach();

  // previewPlatform controls which platform's UI style cards render in (not a filter)
  const [previewPlatform, setPreviewPlatform] = useState<Platform>("instagram");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedSearch = searchQuery.trim();
  const hasSearch = Boolean(normalizedSearch);
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<DmTemplate | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<DmTemplate | null>(null);

  const [formName, setFormName] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPlatform, setFormPlatform] = useState<Platform>("instagram");

  const {
    templates,
    isLoading: loadingTemplates,
    isError: templatesError,
    refetch: refetchTemplates,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    search: appliedSearch,
  } = usePaginatedContentTemplates<DmTemplate>({
    type: "social_message",
    search: searchQuery,
    queryKey: "dm-templates",
  });

  const { data: contentAssets = [], isLoading: loadingAssets, isError: assetsError, refetch: refetchAssets } = useQuery({
    queryKey: ["dm-content-assets"],
    queryFn: () => api.get<ContentAsset[]>("/api/content/assets?type=social_dm"),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; type: string; content: string; description?: string; category?: string }) =>
      api.post("/api/content/templates", data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] }); queryClient.invalidateQueries({ queryKey: ["dm-templates"] }); toast({ title: "Template created" }); resetForm(); },
    onError: (error: Error) => toast({ title: "Failed to create template", description: error.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; name: string; type: string; content: string; description?: string; category?: string }) =>
      api.put(`/api/content/templates/${id}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] }); queryClient.invalidateQueries({ queryKey: ["dm-templates"] }); toast({ title: "Template updated" }); resetForm(); },
    onError: (error: Error) => toast({ title: "Failed to update template", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/content/templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] }); queryClient.invalidateQueries({ queryKey: ["dm-templates"] }); toast({ title: "Template deleted" }); },
    onError: () => toast({ title: "Failed to delete template", variant: "destructive" }),
  });

  const [aiGenerating, setAiGenerating] = useState(false);
  const [_generatingMediaForId, setGeneratingMediaForId] = useState<number | null>(null);
  const [_uploadingMediaForId, setUploadingMediaForId] = useState<number | null>(null);

  const handleAIGenerate = async () => {
    setAiGenerating(true);
    try {
      const res = await api.post<{ message?: string; content?: string }>("/api/content/studio/social-message", {
        prompt: `Generate a professional ${platformLabels[formPlatform]} direct message template for outreach`,
        platform: formPlatform,
        persist: false,
      });
      const text = res.message || res.content || "";
      if (text) { setFormContent(text); toast({ title: "AI generated DM template" }); }
    } catch { toast({ title: "AI generation failed", variant: "destructive" }); }
    finally { setAiGenerating(false); }
  };

  const resetForm = () => {
    setShowEditor(false); setEditingTemplate(null);
    setFormName(""); setFormContent(""); setFormDescription(""); setFormPlatform("instagram");
  };

  const openCreate = () => { router.push("/dashboard/saved-templates/dm/generate"); };
  const openEdit = (t: DmTemplate) => {
    setEditingTemplate(t); setFormName(t.name); setFormContent(readLibraryDraft(t.content).body);
    setFormDescription(t.description || ""); setFormPlatform((t.category as Platform) || "instagram"); setShowEditor(true);
  };

  const handleSave = () => {
    if (!formName.trim() || !formContent.trim()) { toast({ title: "Name and content are required", variant: "destructive" }); return; }
    const original = editingTemplate ? readLibraryDraft(editingTemplate.content) : null;
    let content = original && Object.keys(original.fields).length
      ? updateLibraryDraft(editingTemplate!.content, 'dm', '', formContent, '')
      : formContent;
    if (original && 'platform' in original.fields) {
      content = JSON.stringify({ ...JSON.parse(content), platform: formPlatform });
    }
    const payload = { name: formName, type: "social_message" as const, content, description: formDescription, category: formPlatform };
    if (editingTemplate) { updateMutation.mutate({ id: editingTemplate.id, ...payload }); }
    else { createMutation.mutate(payload); }
  };

  // All templates combined — no platform filtering, previewPlatform only affects card rendering style
  const allTemplates = useMemo(() => {
    const combined = [
      ...templates.map(t => ({ ...t, source: t.isPredefined ? "predefined" as const : "my" as const })),
      ...contentAssets.map(a => ({ ...a, name: a.title, category: a.channel, source: "ai" as const })),
    ];
    const q = normalizedSearch.toLowerCase();
    if (!q) return combined;
    return combined.filter(t => {
      const name = t.name.toLowerCase();
      let searchContent = (t as { content?: string }).content || '';
      try {
        const p = JSON.parse(searchContent);
        if (typeof p === 'object' && p !== null) {
          searchContent = p.message || p.body || p.text || p.dm || p.content || searchContent;
        }
      } catch { /* plain text */ }
      return name.includes(q) || searchContent.toLowerCase().includes(q);
    });
  }, [templates, contentAssets, normalizedSearch]);

  const isLoading = (loadingTemplates || loadingAssets || appliedSearch !== normalizedSearch) && allTemplates.length === 0;
  const isError = (templatesError || assetsError) && allTemplates.length === 0;
  const clearSearch = () => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  };

  return (
    <div className="h-full min-w-0 overflow-x-hidden flex flex-col bg-background">
      <div className="px-4 pt-4">
        <button onClick={() => router.push("/dashboard/saved-templates")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Content library
        </button>
      </div>

      <div className="p-4 border-b bg-card">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
              <MessageCircle className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Social DM templates</h1>
              <p className="text-muted-foreground text-sm">Direct message templates for outreach on social platforms</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { resetForm(); setShowEditor(true); }}>Build reusable template</Button>
            <Button onClick={openCreate} className="w-full gap-2 sm:w-auto"><Plus className="w-4 h-4" /> New Template</Button>
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="relative w-full sm:max-w-sm sm:flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none z-10 text-muted-foreground" />
            <Input ref={searchInputRef} aria-label="Search DM templates" placeholder="Search templates..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
          </div>
          {/* Preview Platform Selector */}
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">Preview as:</span>
            {(["instagram", "facebook", "twitter", "linkedin"] as Platform[]).map(p => (
              <button
                key={p}
                onClick={() => setPreviewPlatform(p)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  previewPlatform === p
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30"
                }`}
              >
                {platformIcons[p]}
                <span>{platformLabels[p]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!isError && <LibraryLoadNotice templatesError={templatesError} assetsError={assetsError} onRetry={() => { void refetchTemplates(); void refetchAssets(); }} />}
        {isLoading ? (
          <LoadingState size="section" label="Loading DM templates…" />
        ) : isError ? (
          <div role="alert" className="flex flex-col items-center justify-center py-16 text-center">
            <MessageCircle className="mb-3 h-12 w-12 text-muted-foreground" />
            <h3 className="text-lg font-semibold">DM templates could not be loaded</h3>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
            <Button variant="outline" onClick={() => { void refetchTemplates(); void refetchAssets(); }}>Retry</Button>
          </div>
        ) : allTemplates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageCircle className="h-12 w-12 text-muted-foreground mb-3" />
            <h3 className="font-semibold text-lg mb-1">{hasSearch ? "No matching DM templates" : "No DM templates yet"}</h3>
            <p className="text-muted-foreground text-sm mb-4">{hasSearch ? "Try a different search or clear it to see all DM templates." : "Create templates or generate with AI to get started"}</p>
            {hasSearch ? <Button type="button" variant="outline" onClick={clearSearch}>Clear search</Button> : <Button onClick={openCreate} className="gap-2"><Plus className="w-4 h-4" /> Create Template</Button>}
          </div>
        ) : (
          <div className="space-y-6">
          <MasonryGrid columns={3}>
            {allTemplates.map((item) => {
              const isContentAsset = item.source === "ai";
              if (isContentAsset) {
                const asset = item as ContentAsset;
                return (
                  <DraftLibraryCard
                    key={`asset-${asset.id}`} asset={asset} kind="dm"
                    onPrimary={() => {
                      const text = extractDmText(asset.content);
                      openOutreach(text, asset.channel);
                    }}
                    primaryLabel="Use in outreach"
                  />
                );
              }
              const template = item as DmTemplate & { source: string };
              return (
                <TemplatePreviewCard
                  key={`template-${template.id}`}
                  reusableTemplateId={template.id}
                  kind="dm"
                  title={template.name}
                  content={template.content}
                  description={template.description}
                  category={`Reusable template · ${template.category || previewPlatform}`}
                  createdAt={template.createdAt}
                  onEdit={template.source === "my" ? () => openEdit(template) : undefined}
                  onDelete={template.source === "my" ? () => deleteMutation.mutate(template.id) : undefined}
                  onPrimary={() => {
                    const text = extractDmText(template.content);
                    openOutreach(text, template.category);
                  }}
                  primaryLabel="Use in outreach"
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
            <DialogTitle>{editingTemplate ? "Edit DM Template" : "Create DM Template"}</DialogTitle>
            <DialogDescription>{editingTemplate ? "Update your DM template" : "Create a reusable direct message template"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Template Name</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. LinkedIn intro message" />
            </div>
            <div>
              <Label>Platform</Label>
              <Select value={formPlatform} onValueChange={(v) => setFormPlatform(v as Platform)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="instagram"><div className="flex items-center gap-2"><Instagram className="h-4 w-4" /> Instagram</div></SelectItem>
                  <SelectItem value="facebook"><div className="flex items-center gap-2"><Facebook className="h-4 w-4" /> Facebook</div></SelectItem>
                  <SelectItem value="twitter"><div className="flex items-center gap-2"><Twitter className="h-4 w-4" /> Twitter / X</div></SelectItem>
                  <SelectItem value="linkedin"><div className="flex items-center gap-2"><Linkedin className="h-4 w-4" /> LinkedIn</div></SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>Message</Label>
                <Button variant="ghost" size="sm" onClick={handleAIGenerate} loading={aiGenerating} loadingText="AI Generate" className="gap-1 h-7 text-xs">
                  <Sparkles className="h-3 w-3" /> AI Generate
                </Button>
              </div>
              <Textarea value={formContent} onChange={(e) => setFormContent(e.target.value)}
                placeholder="Hi {{first_name}}, I noticed you..." rows={6} />
              <p className="text-xs text-muted-foreground mt-1">{formContent.length} characters</p>
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Brief description" />
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

      {/* Preview Dialog */}
      <Dialog open={!!previewTemplate} onOpenChange={() => setPreviewTemplate(null)}>
        <DialogContent className="sm:max-w-sm p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-cyan-600" />
              {previewTemplate?.name}
            </DialogTitle>
            <DialogDescription className="text-xs">DM Preview</DialogDescription>
          </DialogHeader>
          {previewTemplate && (() => {
            const content = extractDmText(previewTemplate.content);
            const platform = (previewTemplate.category as Platform) || previewPlatform;
            const gradients: Record<Platform, string> = {
              instagram: "from-purple-500 via-pink-500 to-orange-400",
              facebook: "from-blue-500 to-blue-700",
              twitter: "from-slate-700 to-slate-900",
              linkedin: "from-blue-700 to-blue-900",
            };
            return (
              <div className="px-4 py-4">
                <div className="mx-auto max-w-[280px]">
                  <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${gradients[platform]} flex items-center justify-center mx-auto mb-3`}>
                    {platformIcons[platform]}
                  </div>
                  <p className="text-xs font-semibold text-center mb-3 text-muted-foreground">{platformLabels[platform]} DM</p>
                  <div className="flex flex-col gap-2">
                    <div className="max-w-[85%] bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-2xl rounded-bl-sm px-4 py-2.5 ml-auto">
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
                    </div>
                    <p className="text-xs text-muted-foreground text-right">{new Date(previewTemplate.createdAt).toLocaleDateString()} · Sent</p>
                  </div>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
      {destinationDialog}
    </div>
  );
}
