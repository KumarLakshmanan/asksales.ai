"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import {
  Megaphone, Plus, Sparkles, Facebook, Globe, ChevronRight, Twitter,
} from "lucide-react";
import api from "@/lib/api";
import { readLibraryDraft } from "@/lib/libraryDraft";
import { LibraryLoadNotice } from "@/components/content-library/LibraryLoadNotice";
import { TemplatePreviewCard } from "@/components/content-library/TemplatePreviewCard";
import { DraftLibraryCard } from '@/components/content-library/DraftLibraryCard';
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { usePaginatedContentTemplates } from "@/hooks/use-paginated-content-templates";

interface AdTemplate {
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
  version?: number;
  businessProfileId?: number;
  brandToolkitId?: number;
  createdAt: string;
  updatedAt: string;
}

interface ContentAsset {
  id: number;
  type: string;
  title: string;
  content: string;
  channel: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoUrls?: string[];
  status?: string;
  prompt?: string;
  createdAt: string;
}

export default function AdsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState("");
  // previewPlatform controls which ad platform's UI style the cards render in (not a filter)
  const [previewPlatform, setPreviewPlatform] = useState("meta");
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<AdTemplate | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<AdTemplate | null>(null);


  const [formName, setFormName] = useState("");
  const [formHeadline, setFormHeadline] = useState("");
  const [formBody, setFormBody] = useState("");
  const [formCta, setFormCta] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPlatform, setFormPlatform] = useState("facebook");

  const {
    templates,
    isLoading: loadingTemplates,
    isError: templatesError,
    refetch: refetchTemplates,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = usePaginatedContentTemplates<AdTemplate>({ type: "ad_copy", search: searchQuery, queryKey: "ad-templates" });

  const { data: contentAssets = [], isLoading: loadingAssets, isError: assetsError, refetch: refetchAssets } = useQuery({
    queryKey: ["ad-content-assets"],
    queryFn: () => api.get<ContentAsset[]>("/api/content/assets?type=ad_copy"),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; type: string; content: string; description?: string; category?: string }) =>
      api.post("/api/content/templates", data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] }); queryClient.invalidateQueries({ queryKey: ["ad-templates"] }); toast({ title: "Template created" }); resetForm(); },
    onError: (error: Error) => toast({ title: "Failed to create template", description: error.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; name: string; type: string; content: string; description?: string; category?: string }) =>
      api.put(`/api/content/templates/${id}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] }); queryClient.invalidateQueries({ queryKey: ["ad-templates"] }); toast({ title: "Template updated" }); resetForm(); },
    onError: (error: Error) => toast({ title: "Failed to update template", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/content/templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] }); queryClient.invalidateQueries({ queryKey: ["ad-templates"] }); toast({ title: "Template deleted" }); },
    onError: () => toast({ title: "Failed to delete template", variant: "destructive" }),
  });

  const [aiGenerating, setAiGenerating] = useState(false);
  const [_generatingMediaForId, setGeneratingMediaForId] = useState<number | null>(null);
  const handleAIGenerate = async () => {
    setAiGenerating(true);
    try {
      const res = await api.post<{ headline?: string; primaryText?: string; body?: string; content?: string }>("/api/content/studio/ad-copy-content", {
        prompt: formName || formDescription || `Create conversion-focused ad copy for ${formPlatform}`,
        platform: formPlatform,
        persist: false,
      });
      if (res.headline) setFormHeadline(res.headline);
      if (res.primaryText || res.body || res.content) setFormBody(res.primaryText || res.body || res.content || "");
      toast({ title: "AI generated ad copy" });
    } catch { toast({ title: "AI generation failed", variant: "destructive" }); }
    finally { setAiGenerating(false); }
  };

  const resetForm = () => {
    setShowEditor(false); setEditingTemplate(null);
    setFormName(""); setFormHeadline(""); setFormBody(""); setFormCta("");
    setFormDescription(""); setFormPlatform("facebook");
  };

  const openCreate = () => { router.push("/dashboard/saved-templates/ads/generate"); };

  const openEdit = (t: AdTemplate) => {
    const draft = readLibraryDraft(t.content);
    setFormHeadline(draft.subject); setFormBody(draft.body);
    setFormCta(typeof draft.fields.callToAction === 'string' ? draft.fields.callToAction : "");
    setFormPlatform(typeof draft.fields.platform === 'string' ? draft.fields.platform : t.category || "facebook");
    setEditingTemplate(t); setFormName(t.name); setFormDescription(t.description || ""); setShowEditor(true);
  };

  const handleSave = () => {
    if (!formName.trim() || !formBody.trim()) { toast({ title: "Name and ad body are required", variant: "destructive" }); return; }
    const original = editingTemplate ? readLibraryDraft(editingTemplate.content).fields : {};
    const content = JSON.stringify({ ...original, headline: formHeadline, body: formBody,
      ...('primaryText' in original ? { primaryText: formBody } : {}),
      ...('primary_text' in original ? { primary_text: formBody } : {}),
      callToAction: formCta, platform: formPlatform });
    const payload = { name: formName, type: "ad_copy" as const, content, description: formDescription, category: formPlatform };
    if (editingTemplate) { updateMutation.mutate({ id: editingTemplate.id, ...payload }); }
    else { createMutation.mutate(payload); }
  };

  // All templates combined — no platform filtering, previewPlatform only affects ad mockup rendering
  const allTemplates = useMemo(() => {
    const combined = [
      ...templates.map(t => ({ ...t, source: t.isPredefined ? "predefined" as const : "my" as const })),
      ...contentAssets.map(a => ({ ...a, name: a.title, category: a.channel, source: "ai" as const })),
    ];
    const q = searchQuery.toLowerCase();
    if (!q) return combined;
    return combined.filter(item => 
      item.name.toLowerCase().includes(q) || 
      (item as { content?: string }).content?.toLowerCase().includes(q)
    );
  }, [templates, contentAssets, searchQuery]);

  const isLoading = (loadingTemplates || loadingAssets) && allTemplates.length === 0;
  const isError = (templatesError || assetsError) && allTemplates.length === 0;

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
              <Megaphone className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Ad campaigns</h1>
              <p className="text-muted-foreground text-sm">Ad copy for Meta, Google, and other platforms</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { resetForm(); setShowEditor(true); }}>Build reusable template</Button>
            <Button onClick={openCreate} className="w-full gap-2 sm:w-auto"><Plus className="w-4 h-4" /> New Ad</Button>
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
          <SearchInput aria-label="Search ad templates" placeholder="Search ads..." value={searchQuery} onValueChange={setSearchQuery} wrapperClassName="w-full sm:max-w-sm sm:flex-1" />
          {/* Preview Platform Selector */}
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">Preview as:</span>
            {[
              { value: "meta", label: "Meta Ads", icon: <Facebook className="h-4 w-4" /> },
              { value: "google", label: "Google Ads", icon: <Globe className="h-4 w-4" /> },
            ].map(({ value, label, icon }) => (
              <button
                key={value}
                onClick={() => setPreviewPlatform(value)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  previewPlatform === value
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30"
                }`}
              >
                {icon}
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!isError && <LibraryLoadNotice templatesError={templatesError} assetsError={assetsError} onRetry={() => { void refetchTemplates(); void refetchAssets(); }} />}
        {isLoading ? (
          <LoadingState size="section" label="Loading ad templates…" />
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Megaphone className="mb-3 h-12 w-12 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Ad templates could not be loaded</h3>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
            <Button variant="outline" onClick={() => { void refetchTemplates(); void refetchAssets(); }}>Retry</Button>
          </div>
        ) : allTemplates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Megaphone className="h-12 w-12 text-muted-foreground mb-3" />
            <h3 className="font-semibold text-lg mb-1">No ad templates yet</h3>
            <p className="text-muted-foreground text-sm mb-4">Create templates or generate with AI to get started</p>
            <Button onClick={openCreate} className="gap-2"><Plus className="w-4 h-4" /> Create Ad</Button>
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
                    key={`asset-${asset.id}`} asset={asset} kind="ad"
                    onPrimary={() => router.push(`/dashboard/saved-templates/ads/publish?assetId=${asset.id}`)}
                    primaryLabel="Review campaign"
                  />
                );
              }
              const template = item as AdTemplate & { source: string };
              return (
                <TemplatePreviewCard
                  key={`template-${template.id}`}
                  reusableTemplateId={template.id}
                  kind="ad"
                  title={template.name}
                  content={template.content}
                  description={template.description}
                  category={`Reusable template · ${previewPlatform === "google" ? "google" : "meta"}`}
                  createdAt={template.createdAt}
                  onEdit={template.source === "my" ? () => openEdit(template) : undefined}
                  onDelete={template.source === "my" ? () => deleteMutation.mutate(template.id) : undefined}
                  onPrimary={() => router.push(`/dashboard/saved-templates/ads/publish?templateId=${template.id}&from=${encodeURIComponent("/dashboard/saved-templates/ads")}`)}
                  primaryLabel="Review campaign"
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
            <DialogTitle>{editingTemplate ? "Edit Ad" : "Create Ad"}</DialogTitle>
            <DialogDescription>{editingTemplate ? "Update your ad copy" : "Create a reusable ad template"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Template Name</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Summer Sale Facebook Ad" />
            </div>
            <div>
              <Label>Platform</Label>
              <Select value={formPlatform} onValueChange={setFormPlatform}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="facebook">Facebook</SelectItem>
                  <SelectItem value="instagram">Instagram</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="twitter">Twitter / X</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Headline</Label>
              <Input value={formHeadline} onChange={(e) => setFormHeadline(e.target.value)} placeholder="Attention-grabbing headline" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>Ad Body</Label>
                <Button variant="ghost" size="sm" onClick={handleAIGenerate} loading={aiGenerating} loadingText="AI Generate" className="gap-1 h-7 text-xs">
                  <Sparkles className="h-3 w-3" /> AI Generate
                </Button>
              </div>
              <Textarea value={formBody} onChange={(e) => setFormBody(e.target.value)} placeholder="Ad body copy..." rows={4} />
            </div>
            <div>
              <Label>Call to Action</Label>
              <Input value={formCta} onChange={(e) => setFormCta(e.target.value)} placeholder="e.g. Shop Now, Learn More, Sign Up" />
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
        <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="h-5 w-5 text-primary" />
              {previewTemplate?.name}
            </DialogTitle>
            <DialogDescription className="text-xs">Ad Preview</DialogDescription>
          </DialogHeader>
          {previewTemplate && (() => {
            let headline = "", body = "", cta = "", platform = "facebook";
            try {
              const p = JSON.parse(previewTemplate.content);
              headline = p.headline || ""; body = p.body || p.primaryText || "";
              cta = p.callToAction || ""; platform = p.platform || previewTemplate.category || "facebook";
            } catch { body = previewTemplate.content; }
            return (
              <div className="px-6 py-4">
                <div className="rounded-xl border overflow-hidden bg-background">
                  <div className="flex items-center gap-3 p-4 border-b">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      platform === 'google' ? 'bg-gradient-to-br from-blue-400 to-red-500' :
                      platform === 'twitter' ? 'bg-black' :
                      'bg-gradient-to-br from-blue-500 to-blue-700'
                    }`}>
                      {platform === 'google' ? <Globe className="h-5 w-5 text-white" /> :
                       platform === 'twitter' ? <Twitter className="h-5 w-5 text-white" /> :
                       <Facebook className="h-5 w-5 text-white" />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Your Brand</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">Sponsored · <Globe className="h-3 w-3" /></p>
                    </div>
                  </div>
                  <div className="p-4">
                    {headline && <p className="font-bold text-base mb-2">{headline}</p>}
                    {body && <p className="text-sm text-muted-foreground mb-3 leading-relaxed">{body}</p>}
                  </div>
                  {cta && (
                    <div className="px-4 pb-4">
                      <Button size="sm" className="w-full">{cta}</Button>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mt-3">
                  <Badge variant="outline" className="capitalize">{platform}</Badge>
                  <span>{new Date(previewTemplate.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>


    </div>
  );
}
