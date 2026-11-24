"use client";

import { useContentLibraryRefresh } from "@/hooks/useContentLibraryRefresh";

import { useRefreshContentLibrary } from "@/hooks/use-content-counts";
import { useCreatorScope, creatorAssetUrl, creatorGenerationContext } from "../CreatorScope";
import { useCreatorPrompt } from "@/hooks/use-creator-prompt";
import { CompanionMediaOptions, type CompanionMedia } from "@/components/content-studio/CompanionMediaOptions";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Callout } from "@/components/ui/callout";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import { useContentBrandContext } from "@/hooks/use-content-brand-context";
import {
  Megaphone,
  Sparkles,
  Wand2,
  Settings2,
  Grid3X3,
  List,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  RotateCw,
} from "lucide-react";
import { adReviewHandoff } from "@/lib/ad-review-handoff";
import MediaManager from "@/components/MediaManager";
import { AdCopyCard } from "@/components/content-cards";
import EditAdModal from "@/components/modals/EditAdModal";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { ContentCreatorBody, ContentCreatorComposer, ContentCreatorHeader, ContentCreatorShell, ContentCreatorStage, CreatorResultsPane } from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, manualDraftPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";
import { AdReviewPanel } from "@/components/content-studio/AdReviewPanel";

interface GeneratedAd {
  version?: number;
  headlines?: string[];
  descriptions?: string[];
  id: string;
  title: string;
  headline: string;
  body: string;
  description?: string;
  cta: string;
  displayUrl?: string;
  platform: string;
  createdAt: number;
  category?: string;
  tone?: string;
  keywords?: string[];
  imagePrompt?: string;
  videoPrompt?: string;
  imageUrl?: string;
  videoUrl?: string;
}

const PLATFORMS = [
  { value: "all", label: "All ad platforms" },
  { value: "facebook", label: "Facebook Ads" },
  { value: "google", label: "Google Ads" },
  { value: "instagram", label: "Instagram Ads" },
  { value: "linkedin", label: "LinkedIn Ads" },
  { value: "twitter", label: "Twitter/X Ads" },
];

const AD_TYPES = [
  { value: "conversion", label: "Conversion" },
  { value: "awareness", label: "Brand Awareness" },
  { value: "traffic", label: "Traffic" },
  { value: "lead-gen", label: "Lead Generation" },
  { value: "app-install", label: "App Install" },
  { value: "engagement", label: "Engagement" },
];

const TONES = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "urgent", label: "Urgent" },
  { value: "inspirational", label: "Inspirational" },
  { value: "humorous", label: "Humorous" },
  { value: "formal", label: "Formal" },
];

export default function AdCreator() {
  const scope = useCreatorScope();
  useContentLibraryRefresh(scope.refreshKey ?? 0, () => { void loadAds(); });
  const refreshContent = useRefreshContentLibrary();
  const generationContext = creatorGenerationContext(scope);
  const router = useRouter();
  const { toast } = useToast();
  const { brandToolkitId, businessProfileId, businessProfile, toolkit, missingMessage } = useContentBrandContext();
  const { subscribe } = useWebSocket();

  // Generation settings
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt("ads");
  const [mediaGeneration, setMediaGeneration] = useState<CompanionMedia>({ image: false, video: false });
  const [platform, setPlatform] = useState("all");
  const [adType, setAdType] = useState("conversion");
  const [tone, setTone] = useState("professional");
  const [productUrl, setProductUrl] = useState("");
  const [brandName, setBrandName] = useState("");
  const [includeHashtags, setIncludeHashtags] = useState(false);
  const [includeEmojis, setIncludeEmojis] = useState(false);

  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [ads, setAds] = useState<GeneratedAd[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showSettings, setShowSettings] = useState(false);
  const [generationMode, setGenerationMode] = useState<GeneratorMode>("ai");
  const [manualDraft, setManualDraft] = useState<ManualDraft>({ title: "", subject: "", description: "", content: "" });
  const [searchQuery, setSearchQuery] = useState("");
  const [editingAd, setEditingAd] = useState<GeneratedAd | null>(null);
  const [currentAd, setCurrentAd] = useState<GeneratedAd | null>(null);

  const loadAds = useCallback(async () => {
    setIsLoading(true);
    setLoadError(false);
    try {
      const assets = await api.get<Array<{
        id: number;
        version?: number;
        title: string;
        content: string;
        channel?: string | null;
        imageUrl?: string | null;
        imageUrls?: string[] | null;
        videoUrl?: string | null;
        videoUrls?: string[] | null;
        createdAt: string;
      }>>(creatorAssetUrl("ad_copy", scope));
      setAds(assets.map((asset) => {
        let content: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(asset.content);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed as Record<string, unknown>;
        } catch {
          content = { primaryText: asset.content };
        }
        const keywords = Array.isArray(content.keywords) ? content.keywords.filter((value): value is string => typeof value === "string") : [];
        return {
          id: `db-${asset.id}`,
          version: asset.version,
          title: asset.title,
          headline: String(content.headline || asset.title || "Generated Ad"),
          body: String(content.primaryText || content.body || ""),
          description: String(content.description || ""),
          cta: String(content.callToAction || content.cta || "Learn More"),
          displayUrl: String(content.displayUrl || ""),
          platform: String(content.platform || asset.channel || "all"),
          createdAt: new Date(asset.createdAt).getTime(),
          keywords,
          headlines: Array.isArray(content.headlines) ? content.headlines.filter((value): value is string => typeof value === 'string') : [],
          descriptions: Array.isArray(content.descriptions) ? content.descriptions.filter((value): value is string => typeof value === 'string') : [],
          imagePrompt: typeof content.imagePrompt === "string" ? content.imagePrompt : undefined,
          videoPrompt: typeof content.videoPrompt === "string" ? content.videoPrompt : undefined,
          imageUrl: asset.imageUrl || asset.imageUrls?.[0] || (typeof content.imageUrl === "string" ? content.imageUrl : undefined),
          videoUrl: asset.videoUrl || asset.videoUrls?.[0] || (typeof content.videoUrl === "string" ? content.videoUrl : undefined),
        };
      }));
    } catch (error) {
      console.error("Error loading ads:", error);
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAds();
  }, [loadAds]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribe('content_asset_updated', (data: any) => {
      if (data.type === 'ad_copy') {
        setAds(prev => prev.map(a => {
          if (a.id === `db-${data.assetId}` && (data.imageUrl || data.videoUrl)) {
            return { ...a, imageUrl: data.imageUrl || a.imageUrl, videoUrl: data.videoUrl || a.videoUrl };
          }
          return a;
        }));
        setCurrentAd((current) => current?.id === `db-${data.assetId}` && (data.imageUrl || data.videoUrl)
          ? { ...current, imageUrl: data.imageUrl || current.imageUrl, videoUrl: data.videoUrl || current.videoUrl }
          : current);
        void loadAds();
      }
    });
    return unsub;
  }, [subscribe, loadAds]);

  const filteredAds = ads.filter(ad =>
    !searchQuery ||
    ad.headline?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    ad.body?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    ad.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );



  const prepareCampaignReview = (selection: GeneratedAd[]) => {
    if (isLoading || loadError) return;
    try {
      if (scope.onSendMessage) scope.onSendMessage(adReviewHandoff(selection));
      else router.push(`/dashboard/conversations?campaignAssetId=${selection[0].id.replace(/^db-/, '')}`);
    } catch (error) {
      toast({ title: 'Cannot prepare campaign review', description: error instanceof Error ? error.message : 'Select saved creatives.', variant: 'destructive' });
    }
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
    if (productUrl.trim() && !/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(productUrl.trim())) {
      toast({ title: "Check the landing page", description: "Enter a complete HTTPS URL.", variant: "destructive" });
      return;
    }

    setSubmittedPrompt(prompt.trim());
    setGenerationError(undefined);
    setIsGenerating(true);
    try {
      // Generate exactly the prompt the user reviewed. Enhancement is an explicit action.
      const enhancedPrompt = prompt;

      let fullPrompt = `${enhancedPrompt}\n\nPlatform: ${platform}\nAd type: ${adType}\nTone: ${tone}`;
      if (productUrl) fullPrompt += `\nProduct URL: ${productUrl}`;
      if (brandName) fullPrompt += `\nBrand name: ${brandName}`;
      if (includeHashtags) fullPrompt += "\nInclude relevant hashtags";
      if (includeEmojis) fullPrompt += "\nInclude emojis";

      const response = await api.post<{
        success: boolean;
        headline?: string;
        headlines?: string[];
        descriptions?: string[];
        primaryText?: string;
        body?: string;
        description?: string;
        cta?: string;
        callToAction?: string;
        content?: string;
        displayUrl?: string;
        keywords?: string[];
        imagePrompt?: string;
        videoPrompt?: string;
        generatedImageData?: string;
        assetId?: number;
        error?: string;
        mediaGeneration?: { imageQueued: boolean; videoQueued: boolean; warnings: string[] };
      }>("/api/content/studio/ad-copy-content", {
        prompt: fullPrompt,
        platform,
        mediaGeneration,
        ...(productUrl.trim() ? { landingPageUrl: productUrl.trim() } : {}),
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      });

      if (response.success) {
        if (!Number.isSafeInteger(response.assetId) || Number(response.assetId) <= 0) {
          throw new Error("Generation returned without a confirmed saved draft. Check the library before generating again.");
        }
        let headline = response.headline || "";
        let body = response.primaryText || response.body || "";
        let description = response.description || "";
        let cta = response.callToAction || response.cta || "";
        let displayUrl = response.displayUrl || "";
        let keywords = response.keywords || [];
        let imagePrompt = response.imagePrompt || "";
        let videoPrompt = response.videoPrompt || "";
        const imageUrl = response.generatedImageData || "";

        // Try to parse from content if individual fields not provided
        if (!headline && response.content) {
          try {
            const parsed = JSON.parse(response.content);
            headline = parsed.headline || "";
            body = parsed.primaryText || parsed.body || parsed.description || "";
            description = parsed.description || "";
            cta = parsed.callToAction || parsed.cta || "";
            displayUrl = parsed.displayUrl || "";
            keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
            imagePrompt = parsed.imagePrompt || "";
            videoPrompt = parsed.videoPrompt || "";
          } catch {
            body = response.content;
          }
        }

        const newAd: GeneratedAd = {
          id: response.assetId ? `db-${response.assetId}` : `gen-${Date.now()}`,
          title: headline || "Generated Ad",
          headline,
          headlines: response.headlines || [],
          descriptions: response.descriptions || [],
          body,
          description,
          cta,
          displayUrl,
          platform,
          createdAt: Date.now(),
          category: adType,
          tone,
          keywords,
          imagePrompt: response.mediaGeneration?.imageQueued ? imagePrompt : undefined,
          videoPrompt: response.mediaGeneration?.videoQueued ? videoPrompt : undefined,
          imageUrl,
        };
        refreshContent();
        setAds((prev) => [newAd, ...prev]);
        setCurrentAd(newAd);

        // Generate follow-up suggestions
        if (response.mediaGeneration?.warnings.length) toast({ title: "Draft saved; media needs attention", description: response.mediaGeneration.warnings.join(". "), variant: "destructive" });

        toast({ title: "Success", description: "Ad copy generated successfully" });
      } else {
        setGenerationError(response.error || "Generation failed. Try again.");
        toast({
          title: "Generation Failed",
          description: response.error || "Failed to generate ad",
          variant: "destructive",
        });
      }
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Generation failed. Try again.");
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate ad",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const generateFollowUpSuggestions = (headline: string, body: string, platform: string): string[] => {
    const suggestions: string[] = [];
    if (!headline) {
      suggestions.push("Add a compelling headline");
    }
    if (body.length < 50) {
      suggestions.push("Make the body copy longer and more detailed");
    }
    if (platform === "facebook" || platform === "instagram") {
      suggestions.push("Add emojis to make it more engaging");
      suggestions.push("Create a sense of urgency");
    }
    if (platform === "linkedin") {
      suggestions.push("Make it more professional and B2B focused");
    }
    if (platform === "google") {
      suggestions.push("Add more keywords for better targeting");
    }
    suggestions.push("Make it more conversational");
    suggestions.push("Add a stronger call to action");
    return suggestions.slice(0, 3);
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
        contentType: "ad_copy",
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      });
      if (response.success && response.enhancedPrompt) {
        proposeEnhancement(response.enhancedPrompt);
        toast({ title: "Enhancement ready", description: "Compare and apply it before generating." });
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
    setAds((prev) => prev.filter((a) => a.id !== id));
    setCurrentAd((current) => current?.id === id ? null : current);
    toast({ title: "Deleted", description: "Ad copy removed" });
  };

  const _handleDownload = (ad: GeneratedAd) => {
    const parts = [
      ad.headline && `Headline: ${ad.headline}`,
      ad.description && `Description: ${ad.description}`,
      ad.body && `Body: ${ad.body}`,
      ad.cta && `CTA: ${ad.cta}`,
      ad.displayUrl && `URL: ${ad.displayUrl}`,
      `Platform: ${ad.platform}`,
      ad.keywords?.length && `Keywords: ${ad.keywords.join(", ")}`,
    ].filter(Boolean);
    const content = parts.join("\n\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ad-${ad.headline?.replace(/\s+/g, "-").toLowerCase() || Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const activeAd = currentAd;
  const adPreview: CreatorPreviewModel = {
    format: "ad",
    status: isGenerating ? "generating" : generationError ? "failed" : activeAd ? "ready" : "empty",
    submittedPrompt,
    error: generationError,
    title: activeAd?.title,
    body: activeAd?.body || "",
    headline: activeAd?.headline,
    cta: activeAd?.cta,
    productUrl: activeAd?.displayUrl,
    mediaUrl: activeAd?.imageUrl,
  };

  return (
    <ContentCreatorShell>
      {/* Header */}
      <ContentCreatorHeader>
        <div className="mb-3">
          <button onClick={() => router.push("/dashboard/saved-templates/ads")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Ad campaigns
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
              <Megaphone className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Ad copy generation</h1>
              <p className="text-sm text-muted-foreground">Create compelling ad copy with AI</p>
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <SearchInput
              size="sm"
              aria-label="Search ad copy"
              placeholder="Search ads..."
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

          </div>
        </div>
      </ContentCreatorHeader>

      {/* Main Content - Split Panel */}
      <ContentCreatorBody recentCount={filteredAds.length}>
        {/* Left Panel - Generation Controls */}
        <ContentCreatorComposer>
          <div className="flex-1 space-y-5 p-4 sm:p-5">
            <GeneratorModeSwitch mode={generationMode} onChange={setGenerationMode} manualLabel="Build an ad" />
            <div className="space-y-2">
              <Label className="text-xs font-medium">Ad platform</Label>
              <Select value={platform} onValueChange={setPlatform}>
                <SelectTrigger className="h-9" aria-label="Ad platform"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
              <ManualContentComposer
                active={generationMode === "manual"}
                onDraftChange={setManualDraft}
                assetType="ad_copy"
                channel={platform}
                returnHref="/dashboard/saved-templates/ads"
                contentLabel="Ad copy"
                contentPlaceholder="Add the headline, primary text, call to action, and any destination notes…"
                uploadLabel="Creative image or video"
                onCreated={() => void loadAds()}
                buildStoredContent={({ title, description, content }) => ({
                  title,
                  headline: title,
                  primaryText: content,
                  description,
                  callToAction: "Learn More",
                  displayUrl: productUrl.trim() || businessProfile?.website || toolkit?.website || "",
                  platform,
                  origin: "manual",
                })}
              />
            {generationMode === "ai" && (
            <div className="contents">
            {/* Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="ads-prompt" className="text-sm font-medium">Ad Prompt</Label>
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
                    id="ads-prompt"
                placeholder="Enter a prompt for the ad you want to create. E.g., Write a Facebook conversion ad for a project management tool targeting small business owners..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="resize-none text-sm"
              />
            </div>



            {enhancementReview}
            <div className="space-y-2">
              <Label htmlFor="ad-landing-page">Landing page URL</Label>
              <Input id="ad-landing-page" type="url" placeholder="https://your-business.com/product" value={productUrl} onChange={(event) => setProductUrl(event.target.value)} />
              <p className="text-xs text-muted-foreground">Leave blank to use the approved business website. Review the destination before launching an ad.</p>
            </div>
            <CompanionMediaOptions value={mediaGeneration} onChange={setMediaGeneration} />
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
                {/* Ad Type */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Campaign Objective</Label>
                  <Select value={adType} onValueChange={setAdType}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AD_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

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

                {/* Brand Name */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Brand Name (optional)</Label>
                  <Input
                    placeholder="e.g., Acme Inc"
                    value={brandName}
                    onChange={(e) => setBrandName(e.target.value)}
                    className="text-sm"
                  />
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
            <Button
              data-creator-action
              onClick={handleGenerate}
              loading={isGenerating}
              loadingText="Generating..."
              disabled={isEnhancing || !prompt.trim()}
              className="h-11 w-full"
              size="lg"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Generate Ad Copy
            </Button>
            </div>
            )}
          </div>
        </ContentCreatorComposer>

        {/* Right Panel - Gallery */}
        <ContentCreatorStage preview={<><CreatorPreview model={generationMode === "manual" ? manualDraftPreview("ad", manualDraft, platform) : adPreview} />{generationMode === "ai" && currentAd && <AdReviewPanel key={currentAd.id} ad={currentAd} onCampaign={() => prepareCampaignReview([currentAd])} />}</>} recentCount={filteredAds.length} searchQuery={searchQuery}>
          <CreatorResultsPane>
          {loadError && <Callout tone="danger" className="mb-4" actions={<Button variant="outline" size="sm" onClick={loadAds}>Retry loading ad copy</Button>}>Ad copy could not be loaded.</Callout>}
          {scope.onSendMessage && ads.length > 0 && !loadError && <Button variant="outline" size="sm" disabled={isLoading || filteredAds.length === 0} onClick={() => prepareCampaignReview(filteredAds)}>Prepare campaign review</Button>}
          {isLoading ? (
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-48 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : loadError ? null : ads.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="p-6 rounded-2xl bg-muted/50 mb-4">
                <Megaphone className="w-12 h-12 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-1">No ads yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Enter a prompt and click Generate to create your first AI ad copy
              </p>
            </div>
          ) : filteredAds.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No matching creatives <Button variant="outline" onClick={() => setSearchQuery("")}>Clear filters</Button></p>
          ) : viewMode === "grid" ? (
            <MasonryGrid columns={2}>
              {filteredAds.map((ad) => (
                <AdCopyCard
                  onHireAgent={scope.onHireAgent}
                  key={ad.id}
                  id={ad.id.startsWith("db-") ? parseInt(ad.id.replace("db-", ""), 10) : undefined}
                  title={ad.headline || ad.title || "Untitled Ad"}
                  content={JSON.stringify({
                    headline: ad.headline,
                    primaryText: ad.body,
                    description: ad.description,
                    callToAction: ad.cta,
                    displayUrl: ad.displayUrl,
                    platform: ad.platform,
                    keywords: ad.keywords,
                    imagePrompt: ad.imagePrompt,
                    videoPrompt: ad.videoPrompt,
                    imageUrl: ad.imageUrl,
                    videoUrl: ad.videoUrl,
                  })}
                  channel={ad.platform}
                  createdAt={new Date(ad.createdAt).toISOString()}
                  onDelete={() => handleDelete(ad.id)}
                  onEdit={() => setEditingAd(ad)}
                  onPublish={() => prepareCampaignReview([ad])}
                  publishLabel="Review this creative"
                  customActions={
                    generateFollowUpSuggestions(ad.headline, ad.body, ad.platform).length > 0 ? (
                      <div className="mt-4 rounded-lg border border-border bg-muted/35 p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <Lightbulb className="h-4 w-4 text-primary" />
                          <span className="text-sm font-medium">Suggestions to improve</span>
                        </div>
                        <div className="space-y-1.5">
                          {generateFollowUpSuggestions(ad.headline, ad.body, ad.platform).map((suggestion, i) => (
                            <button
                              key={i}
                              onClick={() => {
                                setPrompt((prev) => prev ? `${prev}. ${suggestion}` : suggestion);
                              }}
                              className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                            >
                              <RotateCw className="w-3 h-3 flex-shrink-0" />
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : undefined
                  }
                />
              ))}
            </MasonryGrid>
          ) : (
            <div className="space-y-2">
              {filteredAds.map((ad) => (
                <AdCopyCard
                  onHireAgent={scope.onHireAgent}
                  key={ad.id}
                  id={ad.id.startsWith("db-") ? parseInt(ad.id.replace("db-", ""), 10) : undefined}
                  title={ad.headline || ad.title || "Untitled Ad"}
                  content={JSON.stringify({
                    headline: ad.headline,
                    primaryText: ad.body,
                    description: ad.description,
                    callToAction: ad.cta,
                    displayUrl: ad.displayUrl,
                    platform: ad.platform,
                    keywords: ad.keywords,
                    imagePrompt: ad.imagePrompt,
                    videoPrompt: ad.videoPrompt,
                    imageUrl: ad.imageUrl,
                    videoUrl: ad.videoUrl,
                  })}
                  channel={ad.platform}
                  createdAt={new Date(ad.createdAt).toISOString()}
                  onDelete={() => handleDelete(ad.id)}
                  onEdit={() => setEditingAd(ad)}
                  onPublish={() => prepareCampaignReview([ad])}
                  publishLabel="Review this creative"
                />
              ))}
            </div>
          )}


          </CreatorResultsPane>
        </ContentCreatorStage>
      </ContentCreatorBody>

      {/* Edit Ad Modal */}
      <EditAdModal
        open={!!editingAd}
        onOpenChange={(open) => { if (!open) setEditingAd(null); }}
        ad={editingAd ? {
          id: editingAd.id,
          title: editingAd.headline || editingAd.title || "Untitled",
          content: JSON.stringify({
            headline: editingAd.headline,
            primaryText: editingAd.body,
            description: editingAd.description,
            callToAction: editingAd.cta,
            displayUrl: editingAd.displayUrl,
          }),
          platform: editingAd.platform,
        } : null}
        onSaveSuccess={(updated) => {
          refreshContent();
          void loadAds();
          setAds(prev => prev.map(ad => {
            if (ad.id === updated.id) {
              try {
                const parsed = JSON.parse(updated.content);
                return {
                  ...ad,
                  headline: parsed.headline || ad.headline,
                  body: parsed.primaryText || ad.body,
                  description: parsed.description || ad.description,
                  cta: parsed.callToAction || ad.cta,
                  displayUrl: parsed.displayUrl || ad.displayUrl,
                };
              } catch {
                return ad;
              }
            }
            return ad;
          }));
          toast({ title: "Updated", description: "Ad copy updated successfully" });
        }}
      >
        {editingAd && <MediaManager assetId={editingAd.id} threadId={scope.threadId} images={editingAd.imageUrl ? [editingAd.imageUrl] : []} videos={editingAd.videoUrl ? [editingAd.videoUrl] : []} onMediaChange={(images, videos) => {
          const update = (ad: GeneratedAd) => ad.id === editingAd.id ? { ...ad, imageUrl: images[0], videoUrl: videos[0] } : ad;
          setAds(previous => previous.map(update));
          setEditingAd(previous => previous ? update(previous) : previous);
          refreshContent();
          void loadAds();
        }} />}
      </EditAdModal>
    </ContentCreatorShell>
  );
}
