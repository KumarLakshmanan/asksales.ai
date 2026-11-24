"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useContentLibraryRefresh } from "@/hooks/useContentLibraryRefresh";

import { useRefreshContentLibrary } from "@/hooks/use-content-counts";
import { useCreatorScope, creatorAssetUrl, creatorGenerationContext } from "../CreatorScope";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Callout } from "@/components/ui/callout";
import { copyText } from "@/components/ui/copy-button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useCreatorPrompt } from "@/hooks/use-creator-prompt";
import { GenerationEstimate } from '@/components/content-studio/GenerationEstimate';
import { DeleteDraftAction } from "@/components/content-studio/DeleteDraftAction";
import { blogMarkdownExport, parseBlogLinks, type BlogEditorial } from "@/lib/blogEditorial";
import { BlogReviewPanel } from "@/components/content-studio/BlogReviewPanel";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { GeneratorModeSwitch, ManualContentComposer, type GeneratorMode, type ManualDraft } from "@/components/content-studio/GeneratorMode";
import { useWebSocket } from "@/contexts/WebSocketContext";
import api from "@/lib/api";
import { prependUniqueById } from "@/lib/uniqueById";
import { useContentBrandContext } from "@/hooks/use-content-brand-context";
import {
  Newspaper,
  Sparkles,
  Wand2,
  Download,
  Copy,
  Check,
  RefreshCw,
  Settings2,
  Grid3X3,
  List,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import MediaManager from "@/components/MediaManager";
import { BlogPostCard } from "@/components/content-cards";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import {
  ContentCreatorBody,
  ContentCreatorComposer,
  ContentCreatorHeader,
  ContentCreatorShell,
  ContentCreatorStage,
  CreatorResultsPane,
} from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, manualDraftPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";

interface GeneratedBlog {
  editorial?: BlogEditorial;
  id: string;
  title: string;
  content: string;
  excerpt?: string;
  createdAt: number;
  category?: string;
  wordCount?: number;
  readTime?: string;
  tags?: string[];
  imageUrls?: string[];
  videoUrls?: string[];
}

const BLOG_TYPES = [
  { value: "how-to", label: "How-to Guide" },
  { value: "listicle", label: "Listicle" },
  { value: "case-study", label: "Case Study" },
  { value: "thought-leadership", label: "Thought Leadership" },
  { value: "news", label: "Industry News" },
  { value: "tutorial", label: "Tutorial" },
  { value: "opinion", label: "Opinion Piece" },
  { value: "review", label: "Product Review" },
];

const TONES = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "educational", label: "Educational" },
  { value: "authoritative", label: "Authoritative" },
  { value: "conversational", label: "Conversational" },
  { value: "inspirational", label: "Inspirational" },
];

const WORD_COUNTS = [
  { value: "500", label: "~500 words", description: "Short post" },
  { value: "1000", label: "~1000 words", description: "Standard post" },
  { value: "2000", label: "~2000 words", description: "Long-form" },
  { value: "3000", label: "~3000 words", description: "Comprehensive" },
];

const countWords = (text: string): number => {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
};

const estimateReadTime = (wordCount: number): string => {
  const minutes = Math.ceil(wordCount / 200);
  return `${minutes} min read`;
};

export default function BlogCreator() {
  const scope = useCreatorScope();
  useContentLibraryRefresh(scope.refreshKey ?? 0, () => { void loadPosts(); });
  const refreshContent = useRefreshContentLibrary();
  const generationContext = creatorGenerationContext(scope);
  const router = useRouter();
  const { toast } = useToast();
  const { brandToolkitId, businessProfileId, missingMessage } = useContentBrandContext();
  const { subscribe } = useWebSocket();

  // Generation settings
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt("blog");
  const [blogType, setBlogType] = useState("how-to");
  const [tone, setTone] = useState("professional");
  const [targetWordCount, setTargetWordCount] = useState("1000");
  const [targetAudience, setTargetAudience] = useState("");
  const [includeIntroduction, setIncludeIntroduction] = useState(true);
  const [includeConclusion, setIncludeConclusion] = useState(true);
  const [includeHashtags, setIncludeHashtags] = useState(false);
  const [includeEmojis, setIncludeEmojis] = useState(false);
  const [reviewOutline, setReviewOutline] = useState(false);
  const [outline, setOutline] = useState("");
  const [outlineApproved, setOutlineApproved] = useState(false);
  const [isOutlining, setIsOutlining] = useState(false);
  const [editorial, setEditorial] = useState<BlogEditorial>({});
  const [sourceUrls, setSourceUrls] = useState("");
  const [internalLinks, setInternalLinks] = useState("");
  const [editorialError, setEditorialError] = useState("");

  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [posts, setPosts] = useState<GeneratedBlog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showSettings, setShowSettings] = useState(false);
  const [generationMode, setGenerationMode] = useState<GeneratorMode>("ai");
  const [manualDraft, setManualDraft] = useState<ManualDraft>({ title: "", subject: "", description: "", content: "" });
  const [previewPost, setPreviewPost] = useState<GeneratedBlog | null>(null);
  const [currentPost, setCurrentPost] = useState<GeneratedBlog | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    loadPosts();
  }, []);

  useEffect(() => { setOutlineApproved(false); }, [prompt, outline, sourceUrls, internalLinks]);

  useEffect(() => {
    const unsub = subscribe('content_asset_updated', (data) => {
      if (data.type === 'blog_post') {
        loadPosts();
      }
    });
    return unsub;
  }, [subscribe]);

  const loadPosts = async () => {
    setIsLoading(true);
    setLoadError(false);
    try {
      const response = await api.get<Array<{
        id: number;
        type: string;
        title: string;
        content: string;
        createdAt: string;
        performance?: Record<string, unknown>;
        imageUrls?: string[];
        videoUrls?: string[];
      }>>(creatorAssetUrl("blog_post", scope));

      if (Array.isArray(response)) {
        const mapped: GeneratedBlog[] = response
          .filter((a) => a.type === "blog_post")
          .map((asset) => {
            const perf = asset.performance || {};
            let title = asset.title;
            let content = asset.content;
            let storedTags: string[] = [];
            let storedEditorial: BlogEditorial | undefined;

            for (let depth = 0; depth < 3; depth += 1) {
              try {
                const parsed = JSON.parse(content) as Record<string, unknown>;
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) break;
                if (parsed.editorial && typeof parsed.editorial === "object") storedEditorial = parsed.editorial as BlogEditorial;
                title = typeof parsed.title === "string" ? parsed.title : title;
                if (Array.isArray(parsed.tags)) {
                  storedTags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
                }
                const nestedContent = typeof parsed.content === "string"
                  ? parsed.content
                  : typeof parsed.body === "string"
                    ? parsed.body
                    : "";
                if (nestedContent && nestedContent !== content) {
                  content = nestedContent;
                  continue;
                }

                const structuredParts: string[] = [];
                if (typeof parsed.introduction === "string") structuredParts.push(parsed.introduction);
                if (Array.isArray(parsed.sections)) {
                  parsed.sections.forEach((section) => {
                    if (!section || typeof section !== "object" || Array.isArray(section)) return;
                    const sectionRecord = section as Record<string, unknown>;
                    const heading = typeof sectionRecord.heading === "string" ? sectionRecord.heading : "";
                    const body = typeof sectionRecord.content === "string" ? sectionRecord.content : "";
                    if (heading || body) structuredParts.push([heading ? `## ${heading}` : "", body].filter(Boolean).join("\n\n"));
                  });
                }
                if (typeof parsed.conclusion === "string") structuredParts.push(`## Conclusion\n\n${parsed.conclusion}`);
                if (structuredParts.length > 0) content = structuredParts.join("\n\n");
                break;
              } catch {
                break;
              }
            }

            const wordCount = countWords(content);
            return {
              id: `db-${asset.id}`,
              editorial: storedEditorial,
              imageUrls: asset.imageUrls || [],
              videoUrls: asset.videoUrls || [],
              title,
              content,
              excerpt: content.substring(0, 150) + "...",
              createdAt: new Date(asset.createdAt).getTime(),
              category: (perf.category as string) || undefined,
              wordCount,
              readTime: estimateReadTime(wordCount),
              tags: storedTags.length > 0 ? storedTags : (perf.tags as string[]) || [],
            };
          });
        setPosts(mapped);
        setCurrentPost(current => current ? mapped.find(item => item.id === current.id) || current : null);
        setPreviewPost(current => current ? mapped.find(item => item.id === current.id) || current : null);
      }
    } catch (error) {
      setLoadError(true);
      console.error("Error loading blog posts:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const reviewedBrief = (): BlogEditorial => {
    if (editorial.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(editorial.slug)) throw new Error('Use lowercase letters, numbers and hyphens for the URL slug.');
    return { ...editorial, sourceUrls: parseBlogLinks(sourceUrls), internalLinks: parseBlogLinks(internalLinks), ...(reviewOutline ? { outline, outlineApproved } : {}) };
  };

  const handleOutline = async () => {
    if (!prompt.trim() || isOutlining || !brandToolkitId || !businessProfileId) return;
    setEditorialError("");
    setIsOutlining(true);
    try {
      const brief = reviewedBrief();
      const result = await api.post<{ success: boolean; outline?: string; error?: string }>("/api/content/studio/blog-post", {
        ...generationContext, prompt, tone, wordCount: Number(targetWordCount), brandToolkitId, businessProfileId, stage: "outline", persist: false, editorial: brief,
      });
      if (!result.success || !result.outline) throw new Error(result.error || "The outline could not be generated. Try again.");
      setOutline(result.outline);
      setOutlineApproved(false);
    } catch (error) { setEditorialError(error instanceof Error ? error.message : "Outline generation failed."); }
    finally { setIsOutlining(false); }
  };

  const handleGenerate = async () => {
    if (!brandToolkitId || !businessProfileId) {
      toast({ title: "Brand context required", description: missingMessage || "Complete your business profile and Brand Toolkit.", variant: "destructive" });
      return;
    }
    if (!prompt.trim()) {
      toast({ title: "Error", description: "Please enter a prompt", variant: "destructive" });
      return;
    }
    if (reviewOutline && (!outline.trim() || !outlineApproved)) {
      setEditorialError("Review and approve an outline before generating the article.");
      return;
    }
    let brief: BlogEditorial;
    try { brief = reviewedBrief(); setEditorialError(""); }
    catch (error) { setEditorialError(error instanceof Error ? error.message : "Check the editorial brief."); return; }

    setSubmittedPrompt(prompt.trim());
    setGenerationError(undefined);
    setIsGenerating(true);
    try {
      // Generate exactly the prompt the user reviewed. Enhancement is an explicit action.
      const enhancedPrompt = prompt;

      let fullPrompt = `${enhancedPrompt}\n\nBlog type: ${blogType}\nTone: ${tone}\nTarget word count: ${targetWordCount} words`;
      if (targetAudience) fullPrompt += `\nTarget audience: ${targetAudience}`;
      if (includeIntroduction) fullPrompt += "\nInclude an engaging introduction";
      if (includeConclusion) fullPrompt += "\nInclude a conclusion with call-to-action";
      if (includeHashtags) fullPrompt += "\nInclude relevant hashtags";
      if (includeEmojis) fullPrompt += "\nInclude emojis";

      const response = await api.post<{
        success: boolean;
        title?: string;
        content?: string;
        body?: string;
        assetId?: number;
        error?: string;
        editorial?: BlogEditorial;
      }>("/api/content/studio/blog-post", {
        prompt: fullPrompt,
        stage: "article",
        editorial: brief,
        tone,
        wordCount: Number(targetWordCount),
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      });

      if (response.success) {
        if (!Number.isSafeInteger(response.assetId) || Number(response.assetId) <= 0) {
          throw new Error("Generation returned without a confirmed saved draft. Check the library before generating again.");
        }
        const content = response.content || response.body || "";
        let title = response.title || prompt.substring(0, 50);

        // Try to extract title from content
        if (!response.title) {
          const firstLine = content.split("\n")[0];
          if (firstLine && firstLine.startsWith("#")) {
            title = firstLine.replace(/^#+\s*/, "");
          }
        }

        const wordCount = countWords(content);
        const newPost: GeneratedBlog = {
          id: response.assetId ? `db-${response.assetId}` : `gen-${Date.now()}`,
          title,
          content,
          excerpt: content.substring(0, 150) + "...",
          createdAt: Date.now(),
          category: blogType,
          wordCount,
          readTime: estimateReadTime(wordCount),
          editorial: response.editorial || brief,
        };
        refreshContent();
        setPosts((prev) => prependUniqueById([newPost], prev));
        setCurrentPost(newPost);
        toast({ title: "Success", description: "Blog post generated successfully" });
      } else {
        setGenerationError(response.error || "Generation failed. Try again.");
        toast({
          title: "Generation Failed",
          description: response.error || "Failed to generate blog post",
          variant: "destructive",
        });
      }
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Generation failed. Try again.");
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate blog post",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleEnhancePrompt = async () => {
    if (!prompt.trim() || isEnhancing || isGenerating) return;
    setIsEnhancing(true);
    try {
      const response = await api.post<{
        success: boolean;
        enhancedPrompt: string;
      }>("/api/content/studio/magic-prompt", {
        currentPrompt: prompt,
        contentType: "blog_post",
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      });
      if (response.success && response.enhancedPrompt) {
        proposeEnhancement(response.enhancedPrompt);
        toast({ title: "Enhancement ready", description: "Compare the suggestion and apply it when ready." });
      }
    } catch {
      toast({ title: "Error", description: "Failed to enhance prompt", variant: "destructive" });
    } finally {
      setIsEnhancing(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (id.startsWith("db-")) {
      const dbId = parseInt(id.replace("db-", ""), 10);
      if (!isNaN(dbId)) {
        try {
          await api.delete(`/api/content/assets/${dbId}`);
        } catch {
          toast({ title: "Error", description: "Failed to delete", variant: "destructive" });
          return;
        }
      }
    }
    refreshContent();
    setPosts((prev) => prev.filter((p) => p.id !== id));
    setCurrentPost(previous => previous?.id === id ? null : previous);
    setPreviewPost(previous => previous?.id === id ? null : previous);
    toast({ title: "Deleted", description: "Blog post removed" });
  };

  const handleCopyContent = async (post: GeneratedBlog) => {
    try {
      await copyText(/^#\s/.test(post.content) ? post.content : `# ${post.title}\n\n${post.content}`);
      setCopiedId(post.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" });
    }
  };

  const handleDownload = (post: GeneratedBlog) => {
    const blob = new Blob([blogMarkdownExport(post)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `blog-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const filteredPosts = posts.filter((post) => {
    const query = searchQuery.toLowerCase();
    return (
      post.title.toLowerCase().includes(query) ||
      post.content.toLowerCase().includes(query) ||
      (post.category && post.category.toLowerCase().includes(query))
    );
  });

  const activePost = currentPost;
  const blogPreview: CreatorPreviewModel = {
    format: "blog",
    status: isGenerating ? "generating" : generationError ? "failed" : activePost ? "ready" : "empty",
    submittedPrompt,
    error: generationError,
    title: activePost?.title,
    body: activePost?.content || "",
    category: activePost?.category,
  };

  return (
    <ContentCreatorShell>
      {/* Header */}
      <ContentCreatorHeader>
        <div className="mb-3">
          <button onClick={() => router.push("/dashboard/saved-templates/blog")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Blog posts
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
              <Newspaper className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Blog generation</h1>
              <p className="text-sm text-muted-foreground">Create engaging blog posts with AI</p>
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <SearchInput
              size="sm"
              aria-label="Search blog posts"
              placeholder="Search blogs..."
              value={searchQuery}
              onValueChange={setSearchQuery}
              wrapperClassName="flex-1 sm:w-[200px] sm:flex-none"
            />
            <div className="inline-flex items-center rounded-lg border border-border bg-background p-1">
              <button
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                <Grid3X3 className="h-4 w-4" />
              </button>
              <button
                aria-label="List view"
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={loadPosts} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </ContentCreatorHeader>

      {/* Main Content - Split Panel */}
      <ContentCreatorBody recentCount={filteredPosts.length}>
        {/* Left Panel - Generation Controls */}
        <ContentCreatorComposer>
          <div className="flex-1 space-y-5 p-4 sm:p-5">
            <GeneratorModeSwitch mode={generationMode} onChange={setGenerationMode} manualLabel="Write a post" />
              <ManualContentComposer
                active={generationMode === "manual"}
                onDraftChange={setManualDraft}
                assetType="blog_post"
                channel="blog"
                returnHref="/dashboard/saved-templates/blog"
                contentLabel="Article content"
                contentPlaceholder="Write or paste the article. Markdown headings and lists are supported…"
                uploadLabel="Cover image"
                accept="image/*"
                onCreated={() => void loadPosts()}
              />
            {generationMode === "ai" && (
            <div className="contents">
            {/* Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="blog-prompt" className="text-sm font-medium">Blog Prompt</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleEnhancePrompt}
                  loading={isEnhancing}
                  loadingText="Enhancing…"
                  disabled={isGenerating || !prompt.trim()}
                  className="h-7 text-xs text-primary hover:bg-primary/8 hover:text-primary"
                >
                  <Wand2 className="w-3.5 h-3.5 mr-1" /> Enhance
                </Button>
              </div>
              <Textarea
                    id="blog-prompt"
                placeholder="Enter a prompt for the blog post you want to create. E.g., Write a how-to guide on improving team productivity with project management tools..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="resize-none text-sm"
              />
            </div>
            {enhancementReview}

            {/* Blog Type */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Blog Type</Label>
              <Select value={blogType} onValueChange={setBlogType}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BLOG_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <section className="space-y-3 rounded-lg border p-3" aria-label="Outline review">
              <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={reviewOutline} onChange={event => setReviewOutline(event.target.checked)} />Review an outline first</label>
              {reviewOutline && <>
                <p className="text-xs text-muted-foreground">Generate or write an outline, edit it, then approve it. AI outline generation is a separate generation request; it does not save an article.</p>
                <Button type="button" variant="outline" size="sm" onClick={handleOutline} disabled={!prompt.trim() || isOutlining || isGenerating || !brandToolkitId || !businessProfileId}>{isOutlining ? "Generating outline…" : outline ? "Regenerate outline" : "Generate outline"}</Button>
                <Label htmlFor="blog-outline">Outline to review</Label>
                <Textarea id="blog-outline" value={outline} onChange={event => setOutline(event.target.value)} maxLength={15000} rows={7} placeholder="## Introduction\n## Main sections\n## Next steps" />
                <Button type="button" size="sm" variant={outlineApproved ? "secondary" : "default"} disabled={!outline.trim() || isOutlining || outlineApproved} onClick={() => { setOutlineApproved(true); setEditorialError(""); }}>{outlineApproved ? "Outline approved" : "Approve outline"}</Button>
              </>}
            </section>
            <details className="space-y-3 rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">SEO, sources and internal links</summary>
              {([
                ["seoTitle", "SEO title", 70], ["metaDescription", "Meta description", 170], ["slug", "URL slug", 120], ["focusKeyword", "Focus keyword", 120],
              ] as const).map(([key, label, maxLength]) => <div key={key} className="space-y-1"><Label htmlFor={`blog-${key}`}>{label}</Label><Input id={`blog-${key}`} value={editorial[key] || ""} maxLength={maxLength} onChange={event => setEditorial(current => ({ ...current, [key]: event.target.value }))} /><p className="text-xs text-muted-foreground">{(editorial[key] || "").length}/{maxLength}</p></div>)}
              <Label htmlFor="blog-sources">Source URLs (one HTTPS URL per line)</Label>
              <Textarea id="blog-sources" rows={3} value={sourceUrls} onChange={event => setSourceUrls(event.target.value)} placeholder="https://example.com/research" />
              <p className="text-xs text-muted-foreground">URLs are reference candidates, not fetched evidence. Include supporting facts in your prompt and review citations before publication.</p>
              <Label htmlFor="blog-internal-links">Internal links (one HTTPS URL per line)</Label>
              <Textarea id="blog-internal-links" rows={3} value={internalLinks} onChange={event => setInternalLinks(event.target.value)} placeholder="https://your-website.com/related-guide" />
            </details>
            {editorialError && <p role="alert" className="text-sm text-destructive">{editorialError}</p>}

            {/* Settings Toggle */}
            <button
              aria-expanded={showSettings}
                onClick={() => setShowSettings(!showSettings)}
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
            >
              <Settings2 className="w-4 h-4" />
              Additional Settings
              <ChevronDown className={`w-4 h-4 ml-auto transition-transform ${showSettings ? "rotate-180" : ""}`} />
            </button>

            {showSettings && (
              <div className="space-y-4 bg-muted/30 rounded-lg p-4">
                {/* Tone */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Tone</Label>
                  <Select value={tone} onValueChange={setTone}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TONES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Target Word Count */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Target Length</Label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {WORD_COUNTS.map((wc) => (
                      <button
                        key={wc.value}
                        onClick={() => setTargetWordCount(wc.value)}
                        className={`px-3 py-2 rounded-md text-xs font-medium transition-colors border ${
                          targetWordCount === wc.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-muted"
                        }`}
                      >
                        <div>{wc.label}</div>
                        <div className="text-xs opacity-70">{wc.description}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Target Audience */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Target Audience (optional)</Label>
                  <Input
                    placeholder="e.g., Marketing professionals, small business owners"
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    className="text-sm"
                  />
                </div>

                {/* Include Introduction */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="includeIntroduction"
                    checked={includeIntroduction}
                    onCheckedChange={(checked) => setIncludeIntroduction(checked === true)}
                  />
                  <Label htmlFor="includeIntroduction" className="text-xs font-medium cursor-pointer">
                    Include Introduction
                  </Label>
                </div>

                {/* Include Conclusion */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="includeConclusion"
                    checked={includeConclusion}
                    onCheckedChange={(checked) => setIncludeConclusion(checked === true)}
                  />
                  <Label htmlFor="includeConclusion" className="text-xs font-medium cursor-pointer">
                    Include Conclusion
                  </Label>
                </div>

                {/* Include Hashtags */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="includeHashtags"
                    checked={includeHashtags}
                    onCheckedChange={(checked) => setIncludeHashtags(checked === true)}
                  />
                  <Label htmlFor="includeHashtags" className="text-xs font-medium cursor-pointer">
                    Include Hashtags
                  </Label>
                </div>

                {/* Include Emojis */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="includeEmojis"
                    checked={includeEmojis}
                    onCheckedChange={(checked) => setIncludeEmojis(checked === true)}
                  />
                  <Label htmlFor="includeEmojis" className="text-xs font-medium cursor-pointer">
                    Include Emojis
                  </Label>
                </div>
              </div>
            )}

            {/* Generate Button */}
            <GenerationEstimate />
            <Button
              data-creator-action
              onClick={handleGenerate}
              loading={isGenerating}
              loadingText="Generating..."
              disabled={isEnhancing || isOutlining || !prompt.trim() || (reviewOutline && !outlineApproved)}
              className="h-11 w-full"
              size="lg"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Generate Blog Post
            </Button>
            </div>
            )}
          </div>
        </ContentCreatorComposer>

        {/* Right Panel - Gallery */}
        <ContentCreatorStage preview={<><CreatorPreview model={generationMode === "manual" ? manualDraftPreview("blog", manualDraft) : blogPreview} />{generationMode === "ai" && currentPost && <BlogReviewPanel title={currentPost.title} content={currentPost.content} editorial={currentPost.editorial} assetId={currentPost.id.startsWith('db-') ? Number(currentPost.id.slice(3)) : undefined} onExport={() => handleDownload(currentPost)} />}</>} recentCount={filteredPosts.length} searchQuery={searchQuery}>
          <CreatorResultsPane>
          {loadError && <Callout tone="danger" className="mb-4" actions={<Button variant="outline" size="sm" onClick={loadPosts}>Retry loading blog posts</Button>}>Blog posts could not be loaded.</Callout>}
          {isLoading ? (
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-48 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : loadError ? null : filteredPosts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="p-6 rounded-2xl bg-muted/50 mb-4">
                <Newspaper className="w-12 h-12 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-1">{searchQuery ? "No matching blog posts" : "No blog posts yet"}</h3>
              {searchQuery && <Button variant="outline" onClick={() => setSearchQuery("")}>Clear search</Button>}
              <p className="text-sm text-muted-foreground max-w-sm">
                Enter a prompt and click Generate to create your first AI blog post
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <MasonryGrid columns={2}>
              {filteredPosts.map((post) => (
                <BlogPostCard
                  key={post.id}
                  id={post.id.startsWith("db-") ? parseInt(post.id.replace("db-", ""), 10) : undefined}
                  name={post.title}
                  blogTitle={post.title}
                  content={post.content}
                  category={post.category}
                  tags={post.tags}
                  createdAt={new Date(post.createdAt).toISOString()}
                  onPreview={() => setPreviewPost(post)}
                  onDelete={() => handleDelete(post.id)}
                  onCopy={() => handleCopyContent(post)}
                />
              ))}
            </MasonryGrid>
          ) : (
            <div className="space-y-2">
              {filteredPosts.map((post) => (
                <Card
                  key={post.id}
                  className="group hover:shadow-md transition-all cursor-pointer"
                  onClick={() => setPreviewPost(post)}
                >
                  <CardContent className="p-3 flex items-start gap-4">
                    <div className="p-2 bg-teal-100 dark:bg-teal-900/30 rounded-lg flex-shrink-0">
                      <Newspaper className="w-5 h-5 text-teal-600 dark:text-teal-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{post.title}</p>
                      <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{post.excerpt}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {post.category && <Badge variant="outline" className="text-xs py-0">{post.category}</Badge>}
                        {post.wordCount && <Badge variant="outline" className="text-xs py-0">{post.wordCount} words</Badge>}
                        {post.readTime && <Badge variant="outline" className="text-xs py-0">{post.readTime}</Badge>}
                        <span className="text-xs text-muted-foreground">{new Date(post.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Copy text" onClick={(e) => { e.stopPropagation(); handleCopyContent(post); }}>
                        {copiedId === post.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Download draft" onClick={(e) => { e.stopPropagation(); handleDownload(post); }}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <DeleteDraftAction onDelete={() => handleDelete(post.id)} />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}


          </CreatorResultsPane>
        </ContentCreatorStage>
      </ContentCreatorBody>

      {/* Full-screen Preview Dialog */}
      <Dialog open={!!previewPost} onOpenChange={() => setPreviewPost(null)}>
        <DialogContent className="max-w-3xl p-0 overflow-hidden">
          {previewPost && (
            <div className="flex flex-col">
              <DialogDescription className="sr-only">
                Preview the generated blog post, then copy or download it.
              </DialogDescription>
              <div className="bg-card border-b px-6 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {previewPost.category && <Badge variant="outline">{previewPost.category}</Badge>}
                    {previewPost.wordCount && (
                      <Badge variant="outline">
                        <FileText className="w-3 h-3 mr-1" />
                        {previewPost.wordCount} words
                      </Badge>
                    )}
                    {previewPost.readTime && (
                      <Badge variant="outline">
                        <Clock className="w-3 h-3 mr-1" />
                        {previewPost.readTime}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleCopyContent(previewPost)}>
                      {copiedId === previewPost.id ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                      Copy
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload(previewPost)}>
                      <Download className="h-4 w-4 mr-1" />
                      Export Markdown + SEO
                    </Button>
                  </div>
                </div>
              </div>
              <div className="p-6 bg-background max-h-[60vh] overflow-y-auto">
                <DialogTitle className="mb-4 text-2xl font-bold">{previewPost.title}</DialogTitle>
                <div className="prose prose-sm max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{previewPost.content}</ReactMarkdown></div>

                {/* Media Manager */}
                {previewPost.id.startsWith("db-") && (
                  <div className="mt-4 pt-4 border-t">
                    <MediaManager
                      threadId={scope.threadId}
                      images={previewPost.imageUrls || []}
                      videos={previewPost.videoUrls || []}
                      assetId={previewPost.id}
                      onMediaChange={(imageUrls, videoUrls) => {
                        const update = (item: GeneratedBlog) => item.id === previewPost.id ? { ...item, imageUrls, videoUrls } : item;
                        setPosts(items => items.map(update));
                        setPreviewPost(item => item ? update(item) : item);
                        setCurrentPost(item => item ? update(item) : item);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ContentCreatorShell>
  );
}
