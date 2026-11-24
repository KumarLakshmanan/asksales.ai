"use client";

import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
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
import { Separator } from "@/components/ui/separator";

import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import {
  Mail,
  Plus,
  Search,
  Check,
  Sparkles,
  Code,
  Type,
  Wand2,
  GripVertical,
  ChevronRight,
} from "lucide-react";
import DnDEmailBuilder, {
  type EmailBlock,
  blocksToHtml,
  blocksToPlainText,
} from "@/components/email-builder/DnDEmailBuilder";
import { TemplatePreviewCard } from "@/components/content-library/TemplatePreviewCard";
import { DraftLibraryCard } from "@/components/content-library/DraftLibraryCard";
import { libraryCampaignUrl } from "@/lib/libraryDraft";
import RichTextEditor from "@/components/RichTextEditor";
import api from "@/lib/api";
import { emailGenerationErrorMessage } from "@/lib/emailGenerationRecovery";
import { LibraryLoadNotice } from "@/components/content-library/LibraryLoadNotice";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { LoadingState } from "@/components/ui/loading-state";
import { usePaginatedContentTemplates } from "@/hooks/use-paginated-content-templates";
import { readEmailDraft } from "@/lib/emailTemplateSections";
import { emailDraftHtml } from "@/lib/emailTemplateSections";
import { sanitizeEmailPreviewHtml } from "@/lib/contentTemplateRendering";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface EmailTemplate {
  id: number;
  userId?: number | null;
  name: string;
  type: string;
  subject?: string;
  content: string;
  htmlContent?: string;
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
  videoUrls?: string[];
  status?: string;
  prompt?: string;
  createdAt: string;
}

type BuilderTab = "drag-drop" | "html" | "rich-text" | "ai";

/** Parse AI-generated email content (stored as JSON) into displayable text + HTML */
function parseEmailContent(content: string): { text: string; html: string | null; subject?: string } {
  const email = readEmailDraft(content);
  return { text: email.body, html: email.html || emailDraftHtml(content), subject: email.subject };

}



// ─── Page Component ─────────────────────────────────────────────────────────────

export default function EmailTemplatesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();

  // UI state
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [collection, setCollection] = useState('all');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [previewTemplate, setPreviewTemplate] = useState<EmailTemplate | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);

  // Builder state
  const [builderTab, setBuilderTab] = useState<BuilderTab>("drag-drop");
  const [blocks, setBlocks] = useState<EmailBlock[]>([]);
  const [formName, setFormName] = useState("");
  const [formSubject, setFormSubject] = useState("");
  const [formHtml, setFormHtml] = useState("");
  const [formRichText, setFormRichText] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);

  // Media generation state for AI-generated cards
  const [_generatingImageForId, setGeneratingImageForId] = useState<number | null>(null);
  const [_generatingVideoForId, setGeneratingVideoForId] = useState<number | null>(null);

  // ─── Queries ────────────────────────────────────────────────────────────

  const {
    templates: myTemplates,
    isLoading: loadingMy,
    isFetching: fetchingMy,
    search: settledSearch,
    isError: templatesError,
    refetch: refetchTemplates,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = usePaginatedContentTemplates<EmailTemplate>({ type: "email", search: searchQuery, queryKey: "email-templates", retainPreviousSearchResults: true });

  // Keep the collection total independent of the paginated search response.
  // With no search this shares the existing query cache and request.
  const {
    total: reusableTemplateTotal,
    isLoading: loadingTotal,
    isError: totalError,
    refetch: refetchTotal,
  } = usePaginatedContentTemplates<EmailTemplate>({ type: "email", search: "", queryKey: "email-templates" });

  // AI-generated emails from content studio
  const { data: aiAssets = [], isLoading: loadingAi, isError: aiAssetsError, refetch: refetchAiAssets } = useQuery({
    queryKey: ["email-templates", "ai-generated"],
    queryFn: () => api.get<ContentAsset[]>("/api/content/assets?type=email_template"),
  });

  // ─── Mutations ──────────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: (data: {
      id?: number;
      name: string;
      subject?: string;
      content: string;
      htmlContent?: string;
      category?: string;
    }) => {
      const body = {
        name: data.name,
        type: "email",
        subject: data.subject || null,
        content: data.content,
        htmlContent: data.htmlContent || null,
        category: data.category || null,
      };
      if (data.id) {
        return api.put<EmailTemplate>(`/api/content/templates/${data.id}`, body);
      }
      return api.post<EmailTemplate>("/api/content/templates", body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] });
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast({ title: "Saved", description: "Email template saved successfully" });
      closeBuilder();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      api.delete(`/api/content/templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] });
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast({ title: "Deleted", description: "Template removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: (id: number) =>
      api.post<EmailTemplate>(`/api/content/templates/${id}/import`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-template-counts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-assets-counts"] });
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast({ title: "Imported", description: "Template added to your collection" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });


  // ─── Handlers ───────────────────────────────────────────────────────────

  const closeBuilder = () => {
    setBuilderOpen(false);
    setEditingTemplate(null);
    setBlocks([]);
    setFormName("");
    setFormSubject("");
    setFormHtml("");
    setFormRichText("");
    setFormCategory("");
    setAiPrompt("");
    setBuilderTab("drag-drop");
  };

  const openCreate = () => {
    router.push("/dashboard/saved-templates/email/generate");
  };

  const openEdit = (template: EmailTemplate) => {
    setEditingTemplate(template);
    setFormName(template.name);
    setFormSubject(template.subject || "");
    setFormCategory(template.category || "");
    if (template.htmlContent) {
      setFormHtml(template.htmlContent);
      setBuilderTab("html");
    } else {
      setFormRichText(template.content);
      setBuilderTab("rich-text");
    }
    setBuilderOpen(true);
  };

  const handleSave = () => {
    if (!formName.trim()) {
      toast({ title: "Error", description: "Template name is required", variant: "destructive" });
      return;
    }

    let content = "";
    let htmlContent: string | undefined;

    if (builderTab === "drag-drop") {
      if (blocks.length === 0) {
        toast({ title: "Error", description: "Add at least one block", variant: "destructive" });
        return;
      }
      htmlContent = blocksToHtml(blocks, formSubject);
      content = blocksToPlainText(blocks);
    } else if (builderTab === "html") {
      if (!formHtml.trim()) {
        toast({ title: "Error", description: "HTML content is required", variant: "destructive" });
        return;
      }
      htmlContent = formHtml;
      // Extract text from HTML for plain text fallback
      content = formHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || formHtml;
    } else if (builderTab === "rich-text") {
      if (!formRichText.trim()) {
        toast({ title: "Error", description: "Content is required", variant: "destructive" });
        return;
      }
      htmlContent = formRichText;
      content = formRichText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || formRichText;
    } else if (builderTab === "ai") {
      if (!formHtml.trim() && !formRichText.trim()) {
        toast({ title: "Error", description: "Generate a template first", variant: "destructive" });
        return;
      }
      htmlContent = formHtml || undefined;
      content = formRichText || formHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }

    saveMutation.mutate({
      id: editingTemplate?.id,
      name: formName.trim(),
      subject: formSubject.trim() || undefined,
      content,
      htmlContent,
      category: formCategory || undefined,
    });
  };

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim()) {
      toast({ title: "Error", description: "Enter a prompt to generate", variant: "destructive" });
      return;
    }
    setAiGenerating(true);
    try {
      const result = await api.post<{ content: string; subject?: string }>(
        "/api/content/generate-email-template",
        { prompt: aiPrompt }
      );
      setFormHtml(result.content);
      if (result.subject && !formSubject) {
        setFormSubject(result.subject);
      }
      toast({ title: "Generated", description: "AI email template ready. Review and save." });
    } catch (err: unknown) {
      // Template generation saves nothing, so the compose wording ("your draft has been kept") applies.
      toast({
        title: "Generation failed",
        description: emailGenerationErrorMessage(err, "compose"),
        variant: "destructive",
      });
    } finally {
      setAiGenerating(false);
    }
  };

  // ─── Media generation handlers for AI-generated EmailCards ─────────────

  // ─── AI-generated assets mapped to template-like shape ─────────────────

  const aiGeneratedAsTemplates: EmailTemplate[] = useMemo(() => {
    return aiAssets.map((a) => {
      const parsed = parseEmailContent(a.content);
      return {
        id: a.id,
        userId: null,
        name: a.title || "AI Generated Email",
        type: "email",
        subject: parsed.subject,
        content: parsed.text,
        htmlContent: parsed.html || undefined,
        createdAt: a.createdAt,
        updatedAt: a.createdAt,
        isPredefined: false,
        category: "ai-generated",
      };
    });
  }, [aiAssets]);

  // ─── Filtered templates ───────────────────────────────────────────────

  const allTemplates = useMemo(() => {
    const combined = [
      ...myTemplates.map(t => ({ ...t, source: t.isPredefined ? "predefined" as const : "my" as const })),
      ...aiGeneratedAsTemplates.map(t => ({ ...t, source: "ai" as const })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const selected = combined.filter(t => collection === 'all' || (collection === 'drafts' ? t.source === 'ai' : t.source !== 'ai'));
    if (!searchQuery.trim()) return selected;
    const q = searchQuery.toLowerCase();
    return selected.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.subject || "").toLowerCase().includes(q) ||
        (t.content || "").toLowerCase().includes(q)
    );
  }, [myTemplates, aiGeneratedAsTemplates, searchQuery, collection]);

  const isLoading = (loadingMy || loadingAi) && allTemplates.length === 0;
  const isError = (templatesError || aiAssetsError) && allTemplates.length === 0;
  const libraryTotal = reusableTemplateTotal + aiGeneratedAsTemplates.length;
  const countsReady = !loadingMy && !loadingAi && !templatesError && !aiAssetsError && !loadingTotal && !totalError;
  const hasSearch = Boolean(searchQuery.trim());
  const isSearchPending = searchQuery.trim() !== settledSearch || (Boolean(settledSearch) && fetchingMy);
  const clearSearch = () => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden p-4 sm:p-6">
      <div className="mb-3">
        <button onClick={() => router.push("/dashboard/saved-templates")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Content library
        </button>
      </div>

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
            <Mail className="h-5 w-5 text-foreground" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Email templates</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Review saved email drafts or maintain reusable templates
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => { closeBuilder(); setBuilderOpen(true); }}>Build reusable template</Button>
        <Button onClick={openCreate} className="w-full gap-2 sm:w-auto">
          <Plus className="h-4 w-4" />
          Create email draft
        </Button>
        </div>
      </div>

      {/* List Tabs + Search */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div role="status" aria-live="polite" aria-busy={fetchingMy || isSearchPending} className="text-sm text-muted-foreground">
          {countsReady ? `Showing ${allTemplates.length} of ${libraryTotal} items` : (templatesError || aiAssetsError || totalError ? "Library counts unavailable" : "Loading library counts…")}
        </div>
        {totalError && <Button type="button" variant="outline" onClick={() => void refetchTotal()}>Retry counts</Button>}
        <div className="relative w-full sm:max-w-md sm:flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none z-10 text-muted-foreground" />
          <Input
            aria-label="Search email templates"
            ref={searchInputRef}
            placeholder="Search templates..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        {searchQuery && <Button type="button" variant="outline" onClick={clearSearch}>Clear search</Button>}
      </div>

      {/* Template Grid */}
      <Tabs value={collection} onValueChange={setCollection}>
        <TabsList aria-label="Email collection" className="h-auto flex-wrap justify-start">
          <TabsTrigger value="all">All content{countsReady && ` (${libraryTotal})`}</TabsTrigger>
          <TabsTrigger value="drafts">Saved drafts{countsReady && ` (${aiGeneratedAsTemplates.length})`}</TabsTrigger>
          <TabsTrigger value="templates">Reusable templates{countsReady && ` (${reusableTemplateTotal})`}</TabsTrigger>
        </TabsList>
      </Tabs>
      {!isError && <LibraryLoadNotice templatesError={templatesError} assetsError={aiAssetsError} onRetry={() => { void refetchTemplates(); void refetchAiAssets(); }} />}
      {isLoading ? (
        <LoadingState size="section" label="Loading email templates…" />
      ) : isError ? (
        <Card className="py-12">
          <CardContent className="text-center">
            <Mail className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Email templates could not be loaded</h2>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
            <Button variant="outline" onClick={() => { void refetchTemplates(); void refetchTotal(); void refetchAiAssets(); }}>Retry</Button>
          </CardContent>
        </Card>
      ) : allTemplates.length === 0 ? (
        <Card className="py-12">
          <CardContent className="text-center">
            <Mail className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground text-sm">
              {isSearchPending ? "Updating templates…" : hasSearch ? "No templates match your search" : countsReady && libraryTotal > 0 ? (collection === 'templates' ? "No reusable templates yet" : "No saved email drafts yet") : "No email templates yet"}
            </p>
            {searchQuery ? (
              <Button type="button" onClick={clearSearch} variant="outline" size="sm" className="mt-4">Clear search</Button>
            ) : countsReady && libraryTotal > 0 && collection === 'templates' ? (
              <Button onClick={() => { closeBuilder(); setBuilderOpen(true); }} variant="outline" size="sm" className="mt-4">Build reusable template</Button>
            ) : (
              <Button onClick={openCreate} variant="outline" size="sm" className="mt-4 gap-2">
                <Plus className="h-4 w-4" />
                {countsReady && libraryTotal > 0 ? "Create email draft" : "Create Your First Template"}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
        <MasonryGrid columns={4}>
          {allTemplates.map((template) => {
            const draft = template.source === 'ai' ? aiAssets.find(asset => asset.id === template.id) : undefined;
            if (draft) return <DraftLibraryCard key={`email-asset-${draft.id}`} asset={draft} kind="email" onPreview={() => setPreviewTemplate(template)} />;
            return (
              <TemplatePreviewCard
                key={`email-${template.source}-${template.id}`}
                reusableTemplateId={template.source !== "ai" ? template.id : undefined}
                kind="email"
                title={template.name || "AI Generated Email"}
                content={template.content}
                subject={template.subject}
                description={template.description}
                category="Reusable template"
                createdAt={template.createdAt}
                onPreview={() => setPreviewTemplate(template)}
                onPrimary={() => template.source === "predefined" ? importMutation.mutate(template.id) : router.push(libraryCampaignUrl('email', 'template', template.id))}
                primaryLabel={template.source === "predefined" ? "Import template" : "Use in campaign"}
                onEdit={template.source === "my" ? () => openEdit(template) : undefined}
                onDelete={template.source === "my" ? () => deleteMutation.mutate(template.id) : undefined}
              />
            );
          })}
        </MasonryGrid>
        </div>
      )}
      {hasNextPage && !isLoading && !isError && collection !== 'drafts' && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => void fetchNextPage()} loading={isFetchingNextPage}>
              Load more templates
            </Button>
          </div>
        )}

      {/* ─── Builder Dialog ──────────────────────────────────────────────── */}
      <Dialog open={builderOpen} onOpenChange={(open) => !open && closeBuilder()}>
        <DialogContent className="max-w-6xl max-h-[92vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle>
              {editingTemplate ? "Edit Template" : "Create Email Template"}
            </DialogTitle>
            <DialogDescription>
              Design your email using drag &amp; drop, HTML, rich text, or AI
            </DialogDescription>
          </DialogHeader>

          {/* Template meta fields */}
          <div className="px-6 pt-4 grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Template Name *</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Welcome Email"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Subject Line</Label>
              <Input
                value={formSubject}
                onChange={(e) => setFormSubject(e.target.value)}
                placeholder="e.g. Welcome to {{company_name}}!"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <Select value={formCategory} onValueChange={setFormCategory}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="welcome">Welcome</SelectItem>
                  <SelectItem value="follow-up">Follow-up</SelectItem>
                  <SelectItem value="promotional">Promotional</SelectItem>
                  <SelectItem value="newsletter">Newsletter</SelectItem>
                  <SelectItem value="cold-outreach">Cold Outreach</SelectItem>
                  <SelectItem value="re-engagement">Re-engagement</SelectItem>
                  <SelectItem value="event">Event</SelectItem>
                  <SelectItem value="announcement">Announcement</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator className="mt-4" />

          {/* Builder Tabs */}
          <Tabs
            value={builderTab}
            onValueChange={(v) => setBuilderTab(v as BuilderTab)}
            className="flex-1 flex flex-col min-h-0 px-6"
          >
            <TabsList className="w-fit mt-2">
              <TabsTrigger value="drag-drop" className="gap-1.5 text-xs">
                <GripVertical className="h-3.5 w-3.5" />
                Drag &amp; Drop
              </TabsTrigger>
              <TabsTrigger value="html" className="gap-1.5 text-xs">
                <Code className="h-3.5 w-3.5" />
                HTML Editor
              </TabsTrigger>
              <TabsTrigger value="rich-text" className="gap-1.5 text-xs">
                <Type className="h-3.5 w-3.5" />
                Rich Text
              </TabsTrigger>
              <TabsTrigger value="ai" className="gap-1.5 text-xs">
                <Sparkles className="h-3.5 w-3.5" />
                AI Generate
              </TabsTrigger>
            </TabsList>

            {/* Drag & Drop */}
            <TabsContent value="drag-drop" className="flex-1 min-h-0 mt-3">
              <div className="flex gap-4 h-[460px]">
                <div className="flex-1 overflow-auto">
                  <DnDEmailBuilder blocks={blocks} onChange={setBlocks} />
                </div>
                <div className="w-[320px] shrink-0 border rounded-lg overflow-hidden flex flex-col">
                  <div className="px-3 py-2 bg-muted text-xs font-medium">
                    Live Preview
                  </div>
                  <iframe
                    srcDoc={sanitizeEmailPreviewHtml(blocks.length > 0 ? blocksToHtml(blocks, formSubject) : "<html><body><p>Add blocks to see preview</p></body></html>")}
                    sandbox=""
                    className="flex-1 w-full bg-white"
                    title="Email Preview"
                  />
                </div>
              </div>
            </TabsContent>

            {/* HTML Editor */}
            <TabsContent value="html" className="flex-1 min-h-0 mt-3">
              <div className="flex gap-4 h-[460px]">
                <div className="flex-1 flex flex-col">
                  <Label className="text-xs mb-1 text-muted-foreground">
                    Write email-compatible HTML (inline styles, table layout)
                  </Label>
                  <Textarea
                    value={formHtml}
                    onChange={(e) => setFormHtml(e.target.value)}
                    placeholder={"<!DOCTYPE html>\n<html>\n<head>...</head>\n<body>\n  <!-- Your email HTML -->\n</body>\n</html>"}
                    className="flex-1 font-mono text-xs resize-none"
                  />
                </div>
                <div className="w-[320px] shrink-0 border rounded-lg overflow-hidden flex flex-col">
                  <div className="px-3 py-2 bg-muted text-xs font-medium">
                    Live Preview
                  </div>
                  <iframe
                    srcDoc={sanitizeEmailPreviewHtml(formHtml || "<html><body><p>Enter HTML to preview</p></body></html>")}
                    sandbox=""
                    className="flex-1 w-full bg-white"
                    title="HTML Preview"
                  />
                </div>
              </div>
            </TabsContent>

            {/* Rich Text */}
            <TabsContent value="rich-text" className="flex-1 min-h-0 mt-3">
              <div className="h-[460px] flex flex-col">
                <Label className="text-xs mb-1 text-muted-foreground">
                  Write your email content. Use {"{{first_name}}"}, {"{{last_name}}"}, {"{{company_name}}"} for variables.
                </Label>
                <RichTextEditor
                  value={formRichText}
                  onChange={setFormRichText}
                  placeholder={"Hi {{first_name}}, Thank you for your interest in our product..."}
                  className="flex-1"
                />
              </div>
            </TabsContent>

            {/* AI Generate */}
            <TabsContent value="ai" className="flex-1 min-h-0 mt-3">
              <div className="flex gap-4 h-[460px]">
                <div className="w-[300px] shrink-0 space-y-3">
                  <Label className="text-xs text-muted-foreground">
                    Describe the email template you want
                  </Label>
                  <Textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder={"Create a professional welcome email for a SaaS product. Include:\n- Friendly greeting\n- Product introduction\n- Getting started steps\n- CTA button\n- Footer with unsubscribe"}
                    rows={10}
                    className="text-sm"
                  />
                  <Button
                    onClick={handleAiGenerate}
                    loading={aiGenerating}
                    loadingText="Generating..."
                    disabled={!aiPrompt.trim()}
                    className="w-full gap-2"
                  >
                    <Wand2 className="h-4 w-4" />
                    Generate Template
                  </Button>
                  {formHtml && (
                    <p className="text-xs text-green-600 flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      Template generated. Review in preview panel.
                    </p>
                  )}
                </div>
                <div className="flex-1 border rounded-lg overflow-hidden flex flex-col">
                  <div className="px-3 py-2 bg-muted text-xs font-medium">
                    AI Generated Preview
                  </div>
                  <iframe
                    srcDoc={sanitizeEmailPreviewHtml(formHtml || "<html><body><p>Generated template will appear here</p></body></html>")}
                    sandbox=""
                    className="flex-1 w-full bg-white"
                    title="AI Preview"
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t">
            <Button variant="outline" onClick={closeBuilder}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              loading={saveMutation.isPending}
              className="gap-2"
            >
              {editingTemplate ? "Update" : "Save"} Template
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Preview Dialog ──────────────────────────────────────────────── */}
      <Dialog open={!!previewTemplate} onOpenChange={() => setPreviewTemplate(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-4 border-b bg-background">
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              {previewTemplate?.name}
            </DialogTitle>
            <DialogDescription className={previewTemplate?.subject ? "flex items-center gap-2 text-sm" : "sr-only"}>
              {previewTemplate?.subject ? (
                <><span className="font-medium text-foreground">Subject:</span> {previewTemplate.subject}</>
              ) : (
                "Email template preview"
              )}
            </DialogDescription>
            <div className="flex items-center gap-3 pt-1">
              {previewTemplate?.category && (
                <Badge variant="secondary" className="text-xs">{previewTemplate.category}</Badge>
              )}
              {previewTemplate?.tags?.map(tag => (
                <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
              ))}
              <span className="text-xs text-muted-foreground ml-auto">
                {previewTemplate?.createdAt && new Date(previewTemplate.createdAt).toLocaleDateString()}
              </span>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto bg-gray-100 dark:bg-slate-950 p-6">
            <div className="max-w-2xl mx-auto bg-white dark:bg-slate-900 rounded-lg shadow-sm border overflow-hidden">
              {previewTemplate?.htmlContent ? (
                <iframe
                  srcDoc={sanitizeEmailPreviewHtml(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;font-family:sans-serif;font-size:14px;line-height:1.6;color:#333;}</style></head><body>${previewTemplate.htmlContent}</body></html>`)}
                  sandbox=""
                  className="w-full border-0"
                  style={{ minHeight: "60vh" }}
                  title="Email Preview"
                />
              ) : (
                <div className="whitespace-pre-wrap p-6 text-sm leading-relaxed text-foreground">
                  {previewTemplate?.content}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
