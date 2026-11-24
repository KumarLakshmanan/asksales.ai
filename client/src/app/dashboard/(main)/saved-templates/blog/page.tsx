"use client";

import { useState, useMemo, useRef, useEffect, useCallback, useId } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import {
  FileText, Plus, Search, Sparkles, ChevronRight,
} from "lucide-react";
import api from "@/lib/api";
import { readLibraryDraft, updateLibraryDraft } from "@/lib/libraryDraft";
import { creatorSessionScope } from "@/lib/creator-session";
import { subscribeBusinessProfile } from "@/lib/business-profile";
import { LibraryLoadNotice } from "@/components/content-library/LibraryLoadNotice";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { LoadingState } from "@/components/ui/loading-state";
import { copyText } from "@/components/ui/copy-button";
import { TemplatePreviewCard } from "@/components/content-library/TemplatePreviewCard";
import { DraftLibraryCard } from '@/components/content-library/DraftLibraryCard';
import { usePaginatedContentTemplates } from "@/hooks/use-paginated-content-templates";
import { type SavedTextTemplate as BlogTemplate, type SavedContentAsset as ContentAsset } from "../template-types";

interface EditorOwner {
  scope: string;
  open: boolean;
}

interface BlogPayload {
  name: string;
  type: string;
  content: string;
  description?: string;
  category?: string;
  tags?: string[];
}

function extractBlogText(content: string): { title: string; body: string } {
  const draft = readLibraryDraft(content);
  const fallbackTitle = typeof draft.fields.heading === 'string' ? draft.fields.heading
    : typeof draft.fields.name === 'string' ? draft.fields.name : '';
  return { title: draft.subject || fallbackTitle, body: draft.body };
}

export default function BlogPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedSearch = searchQuery.trim();
  const hasSearch = Boolean(normalizedSearch);
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<BlogTemplate | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<BlogTemplate | ContentAsset | null>(null);

  const [formName, setFormName] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formTags, setFormTags] = useState("");
  const editorId = useId();
  const mounted = useRef(false);
  // Object identity owns one draft revision. Only the current editor, save,
  // and generation are retained; no per-record request history is needed.
  const editorOwner = useRef<EditorOwner>({ scope: creatorSessionScope(), open: false });
  const pendingSave = useRef<EditorOwner | null>(null);
  const pendingGeneration = useRef<{ owner: EditorOwner } | null>(null);
  const [aiGenerating, setAiGenerating] = useState(false);

  const ownsEditor = (owner: EditorOwner) => mounted.current && owner.open &&
    editorOwner.current === owner && owner.scope === creatorSessionScope();

  const changeDraft = () => {
    editorOwner.current = { ...editorOwner.current };
    pendingGeneration.current = null;
    setAiGenerating(false);
  };

  const resetForm = useCallback(() => {
    editorOwner.current = { scope: creatorSessionScope(), open: false };
    pendingGeneration.current = null;
    setAiGenerating(false);
    setShowEditor(false); setEditingTemplate(null);
    setFormName(""); setFormTitle(""); setFormContent("");
    setFormDescription(""); setFormCategory(""); setFormTags("");
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onScopeChange = () => {
      if (editorOwner.current.scope !== creatorSessionScope()) resetForm();
    };
    const unsubscribe = subscribeBusinessProfile(onScopeChange);
    window.addEventListener("storage", onScopeChange);
    return () => {
      mounted.current = false;
      editorOwner.current = { scope: creatorSessionScope(), open: false };
      pendingGeneration.current = null;
      unsubscribe();
      window.removeEventListener("storage", onScopeChange);
    };
  }, [resetForm]);

  const {
    templates,
    isLoading: loadingTemplates,
    isError: templatesError,
    refetch: refetchTemplates,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    search: appliedSearch,
  } = usePaginatedContentTemplates<BlogTemplate>({ type: "blog", search: searchQuery, queryKey: "blog-templates" });

  const { data: contentAssets = [], isLoading: loadingAssets, isError: assetsError, refetch: refetchAssets } = useQuery({
    queryKey: ["blog-content-assets"],
    queryFn: () => api.get<ContentAsset[]>("/api/content/assets?type=blog_post"),
  });

  const onSaveSuccess = (owner: EditorOwner, title: string) => {
    // A persisted old draft still refreshes its library, only in its original
    // account/workspace. It cannot close, clear, or notify a newer editor.
    if (!mounted.current || owner.scope !== creatorSessionScope()) return;
    void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
    void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] });
    void queryClient.invalidateQueries({ queryKey: ["blog-templates"] });
    if (!ownsEditor(owner)) return;
    toast({ title });
    resetForm();
  };

  const onSaveSettled = (owner: EditorOwner) => {
    // This only releases this request's duplicate-save lock, never draft state.
    if (pendingSave.current === owner) pendingSave.current = null;
  };

  const createMutation = useMutation({
    mutationFn: ({ payload }: { owner: EditorOwner; payload: BlogPayload }) =>
      api.post("/api/content/templates", payload),
    onSuccess: (_, { owner }) => onSaveSuccess(owner, "Blog post created"),
    onError: (error: Error, { owner }) => {
      if (ownsEditor(owner)) toast({ title: "Failed to create post", description: error.message, variant: "destructive" });
    },
    onSettled: (_, __, { owner }) => onSaveSettled(owner),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; owner: EditorOwner; payload: BlogPayload }) =>
      api.put(`/api/content/templates/${id}`, payload),
    onSuccess: (_, { owner }) => onSaveSuccess(owner, "Blog post updated"),
    onError: (error: Error, { owner }) => {
      if (ownsEditor(owner)) toast({ title: "Failed to update post", description: error.message, variant: "destructive" });
    },
    onSettled: (_, __, { owner }) => onSaveSettled(owner),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/content/templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] }); queryClient.invalidateQueries({ queryKey: ["blog-templates"] }); toast({ title: "Post deleted" }); },
    onError: () => toast({ title: "Failed to delete post", variant: "destructive" }),
  });

  const handleAIGenerate = async () => {
    const owner = editorOwner.current;
    if (!ownsEditor(owner) || pendingGeneration.current || pendingSave.current) return;
    const request = { owner };
    pendingGeneration.current = request;
    setAiGenerating(true);
    try {
      const res = await api.post<{ title?: string; content?: string; body?: string }>("/api/content/studio/blog-post", {
        prompt: formTitle || formName || "General business blog post",
        persist: false,
      });
      if (!ownsEditor(owner) || pendingGeneration.current !== request) return;
      changeDraft();
      if (res.title) setFormTitle(res.title);
      if (res.content || res.body) setFormContent(res.content || res.body || "");
      toast({ title: "AI generated blog content" });
    } catch {
      if (ownsEditor(owner) && pendingGeneration.current === request) toast({ title: "AI generation failed", variant: "destructive" });
    } finally {
      if (ownsEditor(owner) && pendingGeneration.current === request) {
        pendingGeneration.current = null;
        setAiGenerating(false);
      }
    }
  };

  const openCreate = () => { router.push("/dashboard/saved-templates/blog/generate"); };

  const openEdit = (t: BlogTemplate) => {
    resetForm();
    editorOwner.current = { scope: creatorSessionScope(), open: true };
    const { title, body } = extractBlogText(t.content);
    setEditingTemplate(t); setFormName(t.name); setFormTitle(title); setFormContent(body);
    setFormDescription(t.description || ""); setFormCategory(t.category || "");
    setFormTags(t.tags?.join(", ") || ""); setShowEditor(true);
  };

  const handleSave = () => {
    const owner = editorOwner.current;
    if (!ownsEditor(owner) || pendingSave.current) return;
    if (!formName.trim() || !formContent.trim()) { toast({ title: "Name and content are required", variant: "destructive" }); return; }
    const original = editingTemplate ? readLibraryDraft(editingTemplate.content) : null;
    let content = formTitle ? JSON.stringify({ title: formTitle, body: formContent }) : formContent;
    if (original && Object.keys(original.fields).length) {
      const updated = JSON.parse(updateLibraryDraft(editingTemplate!.content, 'blog', formTitle, formContent, ''));
      if (formContent !== original.body) {
        delete updated.introduction; delete updated.sections; delete updated.conclusion;
      }
      content = JSON.stringify(updated);
    }
    const tags = formTags.split(",").map(t => t.trim()).filter(Boolean);
    const payload = { name: formName, type: "blog" as const, content, description: formDescription, category: formCategory, tags };
    pendingGeneration.current = null;
    setAiGenerating(false);
    pendingSave.current = owner;
    if (editingTemplate) { updateMutation.mutate({ id: editingTemplate.id, owner, payload }); }
    else { createMutation.mutate({ owner, payload }); }
  };

  // Combine all templates and filter by search
  const allTemplates = useMemo(() => {
    const combined = [
      ...templates.map(t => ({ ...t, source: t.isPredefined ? "predefined" as const : "my" as const })),
      ...contentAssets.map(a => ({ ...a, name: a.title, category: a.channel, source: "ai" as const })),
    ];
    const q = normalizedSearch.toLowerCase();
    if (!q) return combined;
    return combined.filter(item => 
      item.name.toLowerCase().includes(q) || 
      (item as { content?: string }).content?.toLowerCase().includes(q)
    );
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
              <FileText className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Blog posts</h1>
              <p className="text-muted-foreground text-sm">Long-form articles and content for your blog</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { resetForm(); editorOwner.current = { scope: creatorSessionScope(), open: true }; setShowEditor(true); }}>Build reusable template</Button>
            <Button onClick={openCreate} className="w-full gap-2 sm:w-auto"><Plus className="w-4 h-4" /> New Post</Button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative w-full sm:max-w-sm sm:flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none z-10 text-muted-foreground" />
            <Input ref={searchInputRef} aria-label="Search blog posts" placeholder="Search posts..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!isError && <LibraryLoadNotice templatesError={templatesError} assetsError={assetsError} onRetry={() => { void refetchTemplates(); void refetchAssets(); }} />}
        {isLoading ? (
          <LoadingState size="section" label="Loading blog posts…" />
        ) : isError ? (
          <div role="alert" className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="mb-3 h-12 w-12 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Blog templates could not be loaded</h3>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
            <Button variant="outline" onClick={() => { void refetchTemplates(); void refetchAssets(); }}>Retry</Button>
          </div>
        ) : allTemplates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="h-12 w-12 text-muted-foreground mb-3" />
            <h3 className="font-semibold text-lg mb-1">{hasSearch ? "No matching blog posts" : "No blog posts yet"}</h3>
            <p className="text-muted-foreground text-sm mb-4">
              {hasSearch ? "Try a different search or clear it to see all blog posts." : "Create posts or generate with AI to get started"}
            </p>
            {hasSearch ? (
              <Button type="button" variant="outline" onClick={clearSearch}>Clear search</Button>
            ) : (
              <Button onClick={openCreate} className="gap-2"><Plus className="w-4 h-4" /> Create Post</Button>
            )}
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
                    key={`asset-${asset.id}`} asset={asset} kind="blog"
                    onPreview={() => setPreviewTemplate(asset)}
                  />
                );
              }
              const template = item as BlogTemplate & { source: string };
              return (
                <TemplatePreviewCard
                  key={`template-${template.id}`}
                  reusableTemplateId={template.id}
                  kind="blog"
                  title={template.name}
                  content={template.content}
                  description={template.description}
                  category="Reusable template"
                  createdAt={template.createdAt}
                  onPreview={() => setPreviewTemplate(template)}
                  onEdit={template.source === "my" ? () => openEdit(template) : undefined}
                  onDelete={template.source === "my" ? () => deleteMutation.mutate(template.id) : undefined}
                  onCopy={() => { void copyText(template.content).then(() => toast({ title: "Copied" }), () => toast({ title: "Couldn’t copy", variant: "destructive" })); }}
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
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? "Edit Blog Post" : "Create Blog Post"}</DialogTitle>
            <DialogDescription>{editingTemplate ? "Update your blog post" : "Write a new blog post or template"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor={`${editorId}-name`}>Template Name</Label>
              <Input id={`${editorId}-name`} value={formName} onChange={(e) => { changeDraft(); setFormName(e.target.value); }} placeholder="e.g. Product Launch Announcement" />
            </div>
            <div>
              <Label htmlFor={`${editorId}-title`}>Post Title</Label>
              <Input id={`${editorId}-title`} value={formTitle} onChange={(e) => { changeDraft(); setFormTitle(e.target.value); }} placeholder="Blog post headline" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor={`${editorId}-content`}>Content</Label>
                <Button variant="ghost" size="sm" onClick={handleAIGenerate} loading={aiGenerating} loadingText="AI Generate" disabled={createMutation.isPending || updateMutation.isPending} className="gap-1 h-7 text-xs">
                  <Sparkles className="h-3 w-3" /> AI Generate
                </Button>
              </div>
              <Textarea id={`${editorId}-content`} value={formContent} onChange={(e) => { changeDraft(); setFormContent(e.target.value); }}
                placeholder="Write your blog post content here..." rows={10} className="font-mono text-sm" />
              <p className="text-xs text-muted-foreground mt-1">{formContent.length} characters · ~{Math.ceil(formContent.split(' ').length / 200)} min read</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor={`${editorId}-category`}>Category (optional)</Label>
                <Input id={`${editorId}-category`} value={formCategory} onChange={(e) => { changeDraft(); setFormCategory(e.target.value); }} placeholder="e.g. Marketing, Product" />
              </div>
              <div>
                <Label htmlFor={`${editorId}-tags`}>Tags (comma separated)</Label>
                <Input id={`${editorId}-tags`} value={formTags} onChange={(e) => { changeDraft(); setFormTags(e.target.value); }} placeholder="tag1, tag2, tag3" />
              </div>
            </div>
            <div>
              <Label htmlFor={`${editorId}-description`}>Description (optional)</Label>
              <Input id={`${editorId}-description`} value={formDescription} onChange={(e) => { changeDraft(); setFormDescription(e.target.value); }} placeholder="Brief description or meta description" />
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
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-3 border-b shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-teal-600" />
              {"name" in (previewTemplate || {}) ? (previewTemplate as BlogTemplate)?.name : (previewTemplate as ContentAsset)?.title}
            </DialogTitle>
            <DialogDescription className="text-xs">Blog Post Preview</DialogDescription>
          </DialogHeader>
          {previewTemplate && (() => {
            const rawContent = "content" in previewTemplate ? previewTemplate.content : "";
            const { title, body } = extractBlogText(rawContent);
            const tags = "tags" in previewTemplate ? (previewTemplate as BlogTemplate).tags : undefined;
            return (
              <div className="flex-1 overflow-auto px-6 py-6">
                <article className="prose prose-sm max-w-none dark:prose-invert">
                  {title && <h1 className="text-2xl font-bold mb-4 not-prose">{title}</h1>}
                  <div className="flex items-center gap-2 mb-6 text-xs text-muted-foreground not-prose">
                    <span>{new Date(previewTemplate.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
                    <span>·</span>
                    <span>~{Math.ceil(body.split(' ').length / 200)} min read</span>
                    {tags?.map(tag => <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>)}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-7 text-foreground">{body}</div>
                </article>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
