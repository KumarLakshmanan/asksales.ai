"use client";

import React, { useState, useMemo } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import {
  Share2,
  Plus,
  Sparkles,
  MessageCircle,
  Facebook,
  Twitter,
  Linkedin,
  Instagram,
  Youtube,
  Heart,
  Send,
  Bookmark,
  Repeat2,
  ThumbsUp,
  Globe,
  MoreHorizontal,
  ChevronRight,
} from "lucide-react";
import api from "@/lib/api";
import { LibraryLoadNotice } from "@/components/content-library/LibraryLoadNotice";
import { TemplatePreviewCard } from "@/components/content-library/TemplatePreviewCard";
import { DraftLibraryCard } from '@/components/content-library/DraftLibraryCard';
import { uniqueById } from "@/lib/uniqueById";
import { groupByDay } from "@/lib/libraryDateGroups";
import { SearchInput } from "@/components/ui/search-input";
import { usePaginatedContentTemplates } from "@/hooks/use-paginated-content-templates";
import { SocialPublisher } from "@/components/social-publishing/SocialPublisher";
import { readLibraryDraft, updateLibraryDraft } from "@/lib/libraryDraft";

interface SocialTemplate {
  id: number;
  userId?: number | null;
  name: string;
  type: string;
  content: string;
  subject?: string | null;
  description?: string;
  category?: string;
  tags?: string[];
  variables?: string[];
  isPredefined?: boolean;
  usageCount?: number;
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
  scheduledPublishAt?: string;
}

const platformIcons: Record<string, React.ReactNode> = {
  facebook: <Facebook className="h-4 w-4" />,
  twitter: <Twitter className="h-4 w-4" />,
  linkedin: <Linkedin className="h-4 w-4" />,
  instagram: <Instagram className="h-4 w-4" />,
  youtube: <Youtube className="h-4 w-4" />,
};

const platformLabels: Record<string, string> = {
  facebook: "Facebook",
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  youtube: "YouTube",
};

/** Extract display text from social content (may be JSON from content executor) */
function extractSocialText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'string') return parsed;
    if (parsed.message) return parsed.message;
    if (parsed.body) {
      return [parsed.greeting, parsed.body, parsed.closing].filter(Boolean).join('\n\n');
    }
    if (parsed.text) return parsed.text;
    if (parsed.caption) return parsed.caption;
    if (parsed.content) return parsed.content;
    if (parsed.post) return parsed.post;
    if (parsed.greeting || parsed.body || parsed.closing) {
      return [parsed.greeting, parsed.body, parsed.closing].filter(Boolean).join('\n\n');
    }
    // Last resort: try to find any string field that looks like content
    const stringFields = Object.values(parsed).filter(v => typeof v === 'string' && v.length > 10);
    if (stringFields.length > 0) return stringFields[0] as string;
    return content;
  } catch {
    return content;
  }
}

export default function SocialTemplatesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [initialScheduledDate, setInitialScheduledDate] = useState<string | undefined>();
  React.useEffect(() => { const date = new URLSearchParams(window.location.search).get('date'); if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setInitialScheduledDate(date); }, []);

  // previewPlatform controls which platform's UI style the cards render in (not a filter)
  const [previewPlatform, setPreviewPlatform] = useState<string>("instagram");
  const [searchQuery, setSearchQuery] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SocialTemplate | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<SocialTemplate | ContentAsset | null>(null);
  const [publishAssetId, setPublishAssetId] = useState<number | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formVideoTitle, setFormVideoTitle] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPlatform, setFormPlatform] = useState<string>("facebook");

  const {
    templates,
    isLoading: loadingTemplates,
    isError: templatesError,
    refetch: refetchTemplates,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = usePaginatedContentTemplates<SocialTemplate>({ type: "social", search: searchQuery, queryKey: "social-templates" });

  // Fetch content studio social DM assets
  const { data: contentAssets = [], isLoading: loadingAssets, isError: assetsError, refetch: refetchAssets } = useQuery({
    queryKey: ["social-content-assets"],
    queryFn: () => api.get<ContentAsset[]>("/api/content/assets?type=social_post"),
  });

  // Create template
  const createMutation = useMutation({
    mutationFn: (data: { name: string; type: string; content: string; description?: string; category?: string }) =>
      api.post("/api/content/templates", data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] });
      queryClient.invalidateQueries({ queryKey: ["social-templates"] });
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
      queryClient.invalidateQueries({ queryKey: ["social-templates"] });
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
      queryClient.invalidateQueries({ queryKey: ["social-templates"] });
      toast({ title: "Template deleted" });
    },
    onError: () => toast({ title: "Failed to delete template", variant: "destructive" }),
  });

  // AI generate
  const [aiGenerating, setAiGenerating] = useState(false);
  const handleAIGenerate = async () => {
    setAiGenerating(true);
    try {
      const res = await api.post<{ caption?: string; message?: string; content?: string }>("/api/content/studio/social", {
        prompt: `Generate a professional ${platformLabels[formPlatform]} public social media post`,
        platform: formPlatform,
        persist: false,
      });
      const text = res.caption || res.message || res.content || "";
      if (text) {
        setFormContent(text);
        toast({ title: "AI generated social post" });
      }
    } catch {
      toast({ title: "AI generation failed", variant: "destructive" });
    } finally {
      setAiGenerating(false);
    }
  };

  // Media generation/upload state
  const [_generatingImageForId, setGeneratingImageForId] = useState<number | null>(null);
  const [_generatingVideoForId, setGeneratingVideoForId] = useState<number | null>(null);
  const [_uploadingImageForId, setUploadingImageForId] = useState<number | null>(null);
  const [_uploadingVideoForId, setUploadingVideoForId] = useState<number | null>(null);

  const resetForm = () => {
    setShowEditor(false);
    setEditingTemplate(null);
    setFormName("");
    setFormVideoTitle("");
    setFormContent("");
    setFormDescription("");
    setFormPlatform("facebook");
  };

  const openCreate = () => {
    router.push(`/dashboard/saved-templates/social/generate${initialScheduledDate ? `?date=${initialScheduledDate}` : ""}`);
  };

  const openEdit = (t: SocialTemplate) => {
    setEditingTemplate(t);
    setFormName(t.name);
    setFormVideoTitle(t.subject || "");
    setFormContent(readLibraryDraft(t.content).body);
    setFormDescription(t.description || "");
    setFormPlatform(t.category || "facebook");
    setShowEditor(true);
  };

  const handleSave = () => {
    if (!formName.trim() || !formContent.trim()) {
      toast({ title: "Name and content are required", variant: "destructive" });
      return;
    }
    const original = editingTemplate ? readLibraryDraft(editingTemplate.content) : null;
    let content = original && Object.keys(original.fields).length
      ? updateLibraryDraft(editingTemplate!.content, 'social', '', formContent, '')
      : formContent;
    if (original && 'platform' in original.fields) {
      content = JSON.stringify({ ...JSON.parse(content), platform: formPlatform });
    }
    const payload = {
      name: formName,
      type: "social" as const,
      content,
      description: formDescription,
      category: formPlatform,
      ...(formPlatform === 'youtube' ? { subject: formVideoTitle || null } : {}),
    };
    if (editingTemplate) {
      updateMutation.mutate({ id: editingTemplate.id, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  // All templates combined — no platform filtering, previewPlatform only affects rendering style
  const allTemplates = useMemo(() => {
    const q = searchQuery.toLowerCase();

    const matchesSearch = <T extends { name?: string; title?: string; content: string }>(item: T) => {
      if (!q) return true;
      const name = ('name' in item ? (item.name || '') : (item.title || '')).toLowerCase();
      let searchContent = item.content;
      try {
        const parsed = JSON.parse(item.content);
        if (typeof parsed === 'object' && parsed !== null) {
          searchContent = parsed.caption || parsed.text || parsed.message || parsed.content || parsed.post || item.content;
        }
      } catch { /* plain text */ }
      return name.includes(q) || searchContent.toLowerCase().includes(q);
    };

    // Offset pages can overlap after edits; each saved item renders once.
    const combined = [
      ...uniqueById(templates).filter(matchesSearch).map(t => ({ ...t, source: t.isPredefined ? "predefined" as const : "my" as const })),
      ...uniqueById(contentAssets).filter(matchesSearch).map(a => ({
        ...a,
        name: a.title,
        category: a.channel,
        source: "ai" as const
      })),
    ];
    return combined;
  }, [templates, contentAssets, searchQuery]);

  // Saved posts newest first, grouped by day; seeded starter templates last.
  const savedGroups = useMemo(
    () => groupByDay(allTemplates.filter((item) => item.source !== "predefined"), (item) => item.createdAt),
    [allTemplates],
  );
  const starterTemplates = useMemo(() => allTemplates.filter((item) => item.source === "predefined"), [allTemplates]);

  const isLoading = (loadingTemplates || loadingAssets) && allTemplates.length === 0;
  const isError = (templatesError || assetsError) && allTemplates.length === 0;

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
              <MessageCircle className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Social media posts</h1>
              <p className="text-muted-foreground text-sm">Reusable social copy and YouTube descriptions. Attach a video and review its title, audience, and visibility before publishing.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { resetForm(); setShowEditor(true); }}>Build reusable template</Button>
          <Button onClick={openCreate} className="w-full gap-2 sm:w-auto">
            <Plus className="w-4 h-4" /> New Template
          </Button>
          </div>
        </div>

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
          <SearchInput
            aria-label="Search social templates"
            placeholder="Search templates..."
            value={searchQuery}
            onValueChange={setSearchQuery}
            wrapperClassName="w-full sm:max-w-sm sm:flex-1"
          />

          {/* Preview Platform Selector */}
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">Preview as:</span>
            {(["instagram", "facebook", "twitter", "linkedin"] as string[]).map((p) => (
              <button
                key={p}
                onClick={() => setPreviewPlatform(p)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  previewPlatform === p
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30"
                }`}
              >
                {platformIcons[p as keyof typeof platformIcons]}
                <span className="capitalize">{platformLabels[p as keyof typeof platformLabels]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {!isError && <LibraryLoadNotice templatesError={templatesError} assetsError={assetsError} onRetry={() => { void refetchTemplates(); void refetchAssets(); }} />}
        {isLoading ? (
          <div role="status" aria-label="Loading saved posts" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex min-h-[330px] flex-col overflow-hidden rounded-xl border border-border bg-card">
                <div className="aspect-[16/9] animate-pulse bg-muted" />
                <div className="space-y-2 p-4">
                  <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageCircle className="mb-3 h-12 w-12 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Social templates could not be loaded</h3>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
            <Button variant="outline" onClick={() => { void refetchTemplates(); void refetchAssets(); }}>Retry</Button>
          </div>
        ) : allTemplates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageCircle className="h-12 w-12 text-muted-foreground mb-3" />
            <h3 className="font-semibold text-lg mb-1">{searchQuery ? "No posts match your search" : "No saved social posts yet"}</h3>
            <p className="text-muted-foreground text-sm mb-4">
              {searchQuery ? "Try a different word from the title or caption." : "Generate a post with AI or write your own. Saved posts appear here, newest first."}
            </p>
            {searchQuery
              ? <Button variant="outline" onClick={() => setSearchQuery("")}>Clear search</Button>
              : <Button onClick={openCreate} className="gap-2"><Plus className="w-4 h-4" /> Create post</Button>}
          </div>
        ) : (
          <div className="space-y-8">
          {[...savedGroups, ...(starterTemplates.length ? [{ key: "starter", label: "Starter templates", items: starterTemplates }] : [])].map((group) => (
            <section key={group.key} aria-labelledby={`social-group-${group.key}`}>
              <div className="mb-3 flex items-baseline gap-2 border-b border-border pb-2">
                <h2 id={`social-group-${group.key}`} className="text-sm font-semibold">{group.label}</h2>
                <span className="text-xs text-muted-foreground">{group.items.length} {group.items.length === 1 ? "post" : "posts"}</span>
              </div>
              {/* Even grid: every card in a row stretches to the same height. */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] items-stretch gap-4">
                {group.items.map((item) => {
                  if (item.source === "ai") {
                    const asset = item as ContentAsset;
                    return (
                      <div key={`asset-${asset.id}`} className="min-w-0 [&>article]:h-full">
                        <DraftLibraryCard
                          asset={asset} kind="social"
                          onPrimary={() => setPublishAssetId(asset.id)}
                          primaryLabel="Review and publish"
                        />
                      </div>
                    );
                  }
                  const template = item as SocialTemplate & { source: string };
                  return (
                    <div key={`template-${template.id}`} className="min-w-0 [&>article]:h-full">
                      <TemplatePreviewCard
                        reusableTemplateId={template.id}
                        kind="social"
                        title={template.name}
                        content={template.content}
                        description={template.description}
                        category={`Reusable template · ${template.category || previewPlatform}`}
                        createdAt={template.createdAt}
                        onEdit={template.source === "my" ? () => openEdit(template) : undefined}
                        onDelete={template.source === "my" ? () => deleteMutation.mutate(template.id) : undefined}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
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
            <DialogTitle>{editingTemplate ? "Edit Social Template" : "Create Social Template"}</DialogTitle>
            <DialogDescription>
              {editingTemplate ? "Update your social post template" : "Create a reusable social post template"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="social-name">Template Name</Label>
              <Input id="social-name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. LinkedIn intro message" />
            </div>
            <div>
              <Label>Platform</Label>
              <Select value={formPlatform} onValueChange={setFormPlatform}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="facebook"><div className="flex items-center gap-2"><Facebook className="h-4 w-4" /> Facebook</div></SelectItem>
                  <SelectItem value="twitter"><div className="flex items-center gap-2"><Twitter className="h-4 w-4" /> Twitter / X</div></SelectItem>
                  <SelectItem value="linkedin"><div className="flex items-center gap-2"><Linkedin className="h-4 w-4" /> LinkedIn</div></SelectItem>
                  <SelectItem value="instagram"><div className="flex items-center gap-2"><Instagram className="h-4 w-4" /> Instagram</div></SelectItem>
                  <SelectItem value="youtube"><div className="flex items-center gap-2"><Youtube className="h-4 w-4" /> YouTube description</div></SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor="social-content">{formPlatform === 'youtube' ? 'YouTube description template' : 'Message Content'}</Label>
                <Button variant="ghost" size="sm" onClick={handleAIGenerate} loading={aiGenerating} loadingText="AI Generate" className="gap-1 h-7 text-xs">
                  <Sparkles className="h-3 w-3" /> AI Generate
                </Button>
              </div>
              <Textarea id="social-content" value={formContent} onChange={(e) => setFormContent(e.target.value)}
                placeholder="Hi {{first_name}}, I noticed you..." rows={6} />
              <p className="text-xs text-muted-foreground mt-1">{formContent.length} characters</p>
            </div>
            <div>
              <Label htmlFor="social-desc">Description (optional)</Label>
              <Input id="social-desc" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Brief description" />
            </div>
            {formPlatform === 'youtube' && <div><Label htmlFor="youtube-template-title">Video title template (optional)</Label><Input id="youtube-template-title" value={formVideoTitle} onChange={event => setFormVideoTitle(event.target.value)} placeholder="{{product_name}} tutorial" /><p className="mt-1 text-xs text-muted-foreground">Variables are resolved when applying the approved template. Review the final title before upload.</p></div>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={resetForm}>Cancel</Button>
              <Button onClick={handleSave} loading={createMutation.isPending || updateMutation.isPending}>
                {editingTemplate ? "Update" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog - Platform-specific mockups */}
      <Dialog open={!!previewTemplate} onOpenChange={() => setPreviewTemplate(null)}>
        <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-5 w-5 text-primary" />
              {"name" in (previewTemplate || {}) ? (previewTemplate as SocialTemplate)?.name : (previewTemplate as ContentAsset)?.title}
            </DialogTitle>
            <DialogDescription className="text-xs">Social Post Preview</DialogDescription>
          </DialogHeader>
          {previewTemplate && (() => {
            const rawContent = "content" in previewTemplate ? previewTemplate.content : "";
            const content = extractSocialText(rawContent);
            const category = "category" in previewTemplate ? (previewTemplate as SocialTemplate).category : undefined;
            const channel = "channel" in previewTemplate ? (previewTemplate as ContentAsset).channel : undefined;
            const tags = "tags" in previewTemplate ? (previewTemplate as SocialTemplate).tags : undefined;
            const rawPlatform = (category || channel || "").toLowerCase();
            const platform = rawPlatform === "all" || !rawPlatform ? previewPlatform : rawPlatform;

            // Platform-specific mockup rendering
            const renderPlatformMockup = () => {
              switch (platform) {
                case "twitter":
                  return (
                    <div className="overflow-hidden rounded-xl border bg-white text-gray-900 [&_.text-muted-foreground]:text-gray-500">
                      <div className="flex gap-3 p-4">
                        <div className="w-10 h-10 rounded-full bg-slate-900 flex items-center justify-center text-white text-sm font-bold shrink-0">
                          <Twitter className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1 mb-1">
                            <span className="font-bold text-sm">Your Brand</span>
                            <span className="text-muted-foreground text-sm">@yourbrand · now</span>
                          </div>
                          <p className="text-sm whitespace-pre-wrap leading-relaxed">{content}</p>
                          <div className="flex items-center justify-between mt-3 text-muted-foreground text-xs">
                            <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> Reply</span>
                            <span className="flex items-center gap-1"><Repeat2 className="h-3.5 w-3.5" /> Repost</span>
                            <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" /> Like</span>
                            <span className="flex items-center gap-1"><Send className="h-3.5 w-3.5" /> Share</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );

                case "linkedin":
                  return (
                    <div className="overflow-hidden rounded-lg border bg-white text-gray-900 shadow-sm [&_.text-muted-foreground]:text-gray-500">
                      <div className="p-4">
                        <div className="flex items-start gap-3 mb-3">
                          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-700 to-blue-900 flex items-center justify-center text-white text-sm font-bold shrink-0">
                            <Linkedin className="h-6 w-6" />
                          </div>
                          <div>
                            <p className="font-semibold text-sm">Your Brand</p>
                            <p className="text-xs text-muted-foreground">Company · 1,234 followers</p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1">Just now · <Globe className="h-3 w-3" /></p>
                          </div>
                        </div>
                        <p className="text-sm whitespace-pre-wrap leading-relaxed mb-3">{content}</p>
                        <div className="flex items-center gap-4 pt-3 border-t text-xs text-muted-foreground">
                          <span className="flex items-center gap-1"><ThumbsUp className="h-3.5 w-3.5" /> Like</span>
                          <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> Comment</span>
                          <span className="flex items-center gap-1"><Repeat2 className="h-3.5 w-3.5" /> Repost</span>
                          <span className="flex items-center gap-1"><Send className="h-3.5 w-3.5" /> Send</span>
                        </div>
                      </div>
                    </div>
                  );

                case "instagram":
                  return (
                    <div className="overflow-hidden rounded-lg border bg-white text-gray-900 [&_.text-muted-foreground]:text-gray-500">
                      <div className="flex items-center gap-3 px-4 py-3 border-b">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 flex items-center justify-center">
                          <div className="w-7 h-7 rounded-full bg-white flex items-center justify-center">
                            <Instagram className="h-4 w-4 text-pink-500" />
                          </div>
                        </div>
                        <span className="font-semibold text-sm">yourbrand</span>
                        <MoreHorizontal className="h-4 w-4 text-muted-foreground ml-auto" />
                      </div>
                      <div className="aspect-square bg-gradient-to-br from-purple-100 to-pink-100 flex items-center justify-center">
                        <Instagram className="h-16 w-16 text-pink-400 opacity-50" />
                      </div>
                      <div className="px-4 py-3">
                        <div className="flex items-center gap-4 mb-2">
                          <Heart className="h-5 w-5" />
                          <MessageCircle className="h-5 w-5" />
                          <Send className="h-5 w-5" />
                          <Bookmark className="h-5 w-5 ml-auto" />
                        </div>
                        <p className="text-sm">
                          <span className="font-semibold">yourbrand</span>{" "}
                          <span className="whitespace-pre-wrap">{content}</span>
                        </p>
                        <p className="text-xs text-muted-foreground mt-2">View all comments</p>
                        <p className="text-xs text-muted-foreground uppercase mt-1">Just now</p>
                      </div>
                    </div>
                  );

                default: // facebook
                  return (
                    <div className="overflow-hidden rounded-xl border bg-white text-gray-900 shadow-sm [&_.text-muted-foreground]:text-gray-500">
                      <div className="flex items-center gap-3 px-4 pt-4 pb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-sm font-bold">
                          <Facebook className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold">Your Brand</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            Just now · <Globe className="h-3 w-3" />
                          </p>
                        </div>
                      </div>
                      <div className="px-4 py-3">
                        <p className="text-sm whitespace-pre-wrap leading-relaxed">{content}</p>
                      </div>
                      <div className="px-4 py-3 border-t flex items-center justify-around text-xs text-muted-foreground">
                        <span className="flex items-center gap-1"><ThumbsUp className="h-3.5 w-3.5" /> Like</span>
                        <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> Comment</span>
                        <span className="flex items-center gap-1"><Share2 className="h-3.5 w-3.5" /> Share</span>
                      </div>
                    </div>
                  );
              }
            };

            return (
              <div className="px-6 py-4 space-y-4">
                {renderPlatformMockup()}
                {/* Metadata */}
                <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {tags?.map(tag => (
                      <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                    ))}
                    {(!tags || tags.length === 0) && category && (
                      <Badge variant="outline" className="text-xs">{category}</Badge>
                    )}
                  </div>
                  <span>{new Date(previewTemplate.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
      {publishAssetId && <SocialPublisher initialScheduledDate={initialScheduledDate} assetId={publishAssetId} open={Boolean(publishAssetId)} onOpenChange={(nextOpen) => { if (!nextOpen) setPublishAssetId(null); }} onPublished={() => void refetchAssets()} />}
    </div>
  );
}
