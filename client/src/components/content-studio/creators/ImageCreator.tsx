"use client";

import { useContentLibraryRefresh } from "@/hooks/useContentLibraryRefresh";

import { useRefreshContentLibrary } from "@/hooks/use-content-counts";
import { useCreatorScope, creatorAssetUrl, creatorGenerationContext } from "../CreatorScope";
import { hasSavedMediaReceipt } from "@/lib/contentGenerationReceipt";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  AUTO_IMAGE_SETTING,
  KNOWN_IMAGE_ASPECT_RATIOS,
  KNOWN_IMAGE_RESOLUTIONS,
  detectPromptAspectRatio,
  nearestAspectRatio,
  nearestResolution,
} from "../../../../../shared/imageSettings";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Callout } from "@/components/ui/callout";
import { copyText } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { GeneratorModeSwitch, ManualContentComposer, type GeneratorMode, type ManualDraft } from "@/components/content-studio/GeneratorMode";
import { useWebSocket } from "@/contexts/WebSocketContext";
import api from "@/lib/api";
import { prependUniqueById } from "@/lib/uniqueById";
import { normalizeUploadUrl } from "@/lib/utils";
import { useContentBrandContext } from "@/hooks/use-content-brand-context";
import { useCreatorPrompt } from "@/hooks/use-creator-prompt";
import { downloadContentMedia, validateSourceImage } from "@/lib/contentMediaTools";
import { ImageProofTools } from "@/components/content-studio/ImageProofTools";
import { GenerationEstimate } from "@/components/content-studio/GenerationEstimate";
import { AttachMediaToDraft } from "@/components/content-studio/AttachMediaToDraft";
import {
  Image as ImageIcon,
  Sparkles,
  Wand2,
  Download,
  Trash2,
  Copy,
  Check,
  RefreshCw,
  Settings2,
  Grid3X3,
  List,
  ChevronDown,
  ChevronRight,
  Upload,
  Shuffle,
  Dice5,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ImageCard } from "@/components/content-cards";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { ContentCreatorBody, ContentCreatorComposer, ContentCreatorHeader, ContentCreatorShell, ContentCreatorStage, CreatorResultsPane } from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, manualDraftPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";
import { MediaGenerationPlaceholder } from "@/components/content-studio/MediaGenerationPlaceholder";

interface GeneratedImage {
  id: string;
  title: string;
  imageUrl: string;
  prompt: string;
  createdAt: number;
  aspectRatio?: string;
  style?: string;
  size?: string;
  seed?: number;
  status: "pending" | "completed" | "failed";
  error?: string;
}

interface ImageGenerationResponse {
  success: boolean;
  imageData?: string;
  imageUrl?: string;
  mimeType?: string;
  assetId?: number | null;
  persisted?: boolean;
  persistenceWarning?: string;
  /** Ratio and size actually sent to the model. */
  aspectRatio?: string;
  imageSize?: string;
  /** Set when a requested setting was mapped to one the model supports. */
  settingsNote?: string;
  error?: string;
}

interface ImageModelOptions {
  provider: string;
  model: string;
  aspectRatios: string[] | null;
  resolutions: string[] | null;
}

const STYLES = [
  { value: AUTO_IMAGE_SETTING, label: "Match my prompt" },
  { value: "photorealistic", label: "Photorealistic" },
  { value: "digital-art", label: "Digital Art" },
  { value: "illustration", label: "Illustration" },
  { value: "3d-render", label: "3D Render" },
  { value: "watercolor", label: "Watercolor" },
  { value: "minimalist", label: "Minimalist" },
  { value: "cinematic", label: "Cinematic" },
  { value: "flat-design", label: "Flat Design" },
];

const IMAGE_SIZE_DESCRIPTIONS: Record<string, string> = {
  "512": "Draft",
  "1.5K": "Balanced",
  "1K": "Standard quality",
  "2K": "High quality",
  "4K": "Ultra high quality",
};

export default function ImageCreator() {
  const scope = useCreatorScope();
  useContentLibraryRefresh(scope.refreshKey ?? 0, () => { void loadImages(); });
  const refreshContent = useRefreshContentLibrary();
  const generationContext = creatorGenerationContext(scope);
  const router = useRouter();
  const { toast } = useToast();
  const { brandToolkitId, businessProfileId, missingMessage } = useContentBrandContext();
  const { subscribe } = useWebSocket();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Generation settings
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt("image");
  const [negativePrompt, setNegativePrompt] = useState("");
  // "auto" sends no override: the server follows a ratio or style written in the prompt.
  const [aspectRatio, setAspectRatio] = useState(AUTO_IMAGE_SETTING);
  const [style, setStyle] = useState(AUTO_IMAGE_SETTING);
  const [imageSize, setImageSize] = useState("1K");
  const imageOptionsQuery = useQuery({
    queryKey: ["content-image-model-options"],
    queryFn: () => api.get<ImageModelOptions>("/api/content/studio/image-options"),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const modelOptions = imageOptionsQuery.data;
  const supportedAspectRatios = modelOptions?.aspectRatios?.length
    ? KNOWN_IMAGE_ASPECT_RATIOS.filter((ratio) => modelOptions.aspectRatios?.includes(ratio))
    : KNOWN_IMAGE_ASPECT_RATIOS;
  // null = the model takes no resolution setting; hide the picker instead of offering sizes it ignores.
  const supportedResolutions = modelOptions
    ? modelOptions.resolutions?.length ? KNOWN_IMAGE_RESOLUTIONS.filter((size) => modelOptions.resolutions?.includes(size)) : []
    : ["1K", "2K"];
  const promptAspectRatio = detectPromptAspectRatio(prompt);
  const autoAspectLabel = promptAspectRatio
    ? `Auto (${nearestAspectRatio(promptAspectRatio, modelOptions?.aspectRatios ?? undefined)} from prompt)`
    : "Auto";

  // Keep selections inside what the configured model supports.
  useEffect(() => {
    if (!modelOptions) return;
    if (aspectRatio !== AUTO_IMAGE_SETTING && modelOptions.aspectRatios?.length && !modelOptions.aspectRatios.includes(aspectRatio)) {
      setAspectRatio(nearestAspectRatio(aspectRatio, modelOptions.aspectRatios));
    }
    const size = nearestResolution(imageSize, modelOptions.resolutions ?? undefined);
    if (size && size !== imageSize) setImageSize(size);
  }, [modelOptions, aspectRatio, imageSize]);
  const [numberOfImages, setNumberOfImages] = useState(1);
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [useRandomSeed, setUseRandomSeed] = useState(true);

  // Source image for image-to-image
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [sourceImagePreview, setSourceImagePreview] = useState<string | null>(null);
  const [sourceImageMimeType, setSourceImageMimeType] = useState("image/jpeg");

  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showSettings, setShowSettings] = useState(false);
  const [generationMode, setGenerationMode] = useState<GeneratorMode>("ai");
  const [manualDraft, setManualDraft] = useState<ManualDraft>({ title: "", subject: "", description: "", content: "" });
  const [previewImage, setPreviewImage] = useState<GeneratedImage | null>(null);
  const [currentImage, setCurrentImage] = useState<GeneratedImage | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    loadImages();
  }, []);

  useEffect(() => {
    const unsub = subscribe('content_asset_updated', (data) => {
      if (data.type === 'image') {
        loadImages();
      }
    });
    return unsub;
  }, [subscribe]);

  const loadImages = async () => {
    setIsLoading(true);
    setLoadError(undefined);
    try {
      const response = await api.get<Array<{
        id: number;
        type: string;
        title: string;
        content: string;
        imageUrl?: string | null;
        imageUrls?: string[] | null;
        status?: string;
        createdAt: string;
        performance?: Record<string, unknown>;
      }>>(creatorAssetUrl("image", scope));

      if (Array.isArray(response)) {
        const mapped: GeneratedImage[] = response
          .filter((a) => a.type === "image")
          .map((asset) => {
            let imageUrl = asset.imageUrl || asset.imageUrls?.[0] || "";
            try {
              const parsed = JSON.parse(asset.content) as Record<string, unknown>;
              imageUrl ||= typeof parsed.imageUrl === "string" ? parsed.imageUrl : "";
              imageUrl ||= typeof parsed.generatedImage === "string" ? parsed.generatedImage : "";
            } catch {
              if (asset.content.startsWith("data:")) {
                imageUrl ||= asset.content;
              } else if (
                asset.content.startsWith("/uploads/") ||
                asset.content.startsWith("/api/uploads/") ||
                asset.content.startsWith("http")
              ) {
                imageUrl ||= asset.content;
              } else if (
                asset.content.length > 100 &&
                /^[A-Za-z0-9+/=]+$/.test(asset.content.substring(0, 100))
              ) {
                imageUrl ||= `data:image/png;base64,${asset.content}`;
              }
            }
            if (imageUrl && !imageUrl.startsWith("data:")) imageUrl = normalizeUploadUrl(imageUrl);
            const perf = asset.performance || {};
            const isActivelyGenerating = ["pending", "queued", "processing"].includes(asset.status || "");
            return {
              id: `db-${asset.id}`,
              title: asset.title,
              imageUrl,
              prompt: (perf.prompt as string) || "",
              createdAt: new Date(asset.createdAt).getTime(),
              aspectRatio: (perf.aspectRatio as string) || undefined,
              style: (perf.style as string) || undefined,
              size: (perf.size as string) || undefined,
              seed: (perf.seed as number) || undefined,
              status: imageUrl ? "completed" : isActivelyGenerating ? "pending" : "failed",
            };
          });
        setImages(mapped);
      }
    } catch (error) {
      console.error("Error loading images:", error);
      setLoadError("Images could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSourceImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = validateSourceImage(file);
    if (validationError) {
      toast({ title: "Cannot use this image", description: validationError, variant: "destructive" });
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => toast({ title: "Could not read image", description: "Select the image again.", variant: "destructive" });
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setSourceImagePreview(dataUrl);
      setSourceImage(dataUrl.split(",")[1] || null);
      setSourceImageMimeType(file.type);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveSourceImage = () => {
    setSourceImage(null);
    setSourceImagePreview(null);
    setSourceImageMimeType("image/jpeg");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
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

    setSubmittedPrompt(prompt.trim());
    setGenerationError(undefined);
    setIsGenerating(true);
    try {
      // Generate exactly the prompt the user reviewed. Enhancement is an explicit action.
      const enhancedPrompt = prompt;

      const effectiveSeed = useRandomSeed ? undefined : seed;

      const requestBody: Record<string, unknown> = {
        prompt: `${enhancedPrompt}${negativePrompt ? `\n\nNegative prompt: ${negativePrompt}` : ""}`,
        style,
        aspectRatio,
        ...(supportedResolutions.length ? { imageSize } : {}),
        saveToAssets: true,
        channel: "image_generation",
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      };

      if (effectiveSeed !== undefined) {
        requestBody.seed = effectiveSeed;
      }

      if (sourceImage) {
        requestBody.images = [{ base64Data: sourceImage, mimeType: sourceImageMimeType }];
      }

      const generated: GeneratedImage[] = [];
      const failures: string[] = [];
      const warnings: string[] = [];
      // Informational: a requested setting was mapped to one the model supports.
      const settingsNotes: string[] = [];

      for (let index = 0; index < numberOfImages; index += 1) {
        try {
          const body = {
            ...requestBody,
            ...(effectiveSeed !== undefined ? { seed: effectiveSeed + index } : {}),
          };
          const response = await api.post<ImageGenerationResponse>("/api/content/studio/image", body);
          if (!response.success || (!response.imageUrl && !response.imageData)) {
            failures.push(response.error || `Image ${index + 1} failed`);
            continue;
          }

          const rawUrl = response.imageUrl || `data:${response.mimeType || "image/png"};base64,${response.imageData}`;
          const imageUrl = rawUrl.startsWith("/uploads/") ? `${rawUrl}?t=${Date.now()}` : rawUrl;
          generated.push({
            id: hasSavedMediaReceipt(response) ? `db-${response.assetId}` : `gen-${Date.now()}-${index}`,
            title: numberOfImages > 1 ? `Generated Image ${index + 1}` : "Generated Image",
            imageUrl,
            prompt,
            createdAt: Date.now(),
            aspectRatio: response.aspectRatio || (aspectRatio === AUTO_IMAGE_SETTING ? undefined : aspectRatio),
            style: style === AUTO_IMAGE_SETTING ? undefined : style,
            size: response.imageSize ?? (supportedResolutions.length ? imageSize : undefined),
            seed: effectiveSeed !== undefined ? effectiveSeed + index : undefined,
            status: "completed",
          });
          if (response.settingsNote && !settingsNotes.includes(response.settingsNote)) settingsNotes.push(response.settingsNote);
          if (response.persistenceWarning || !hasSavedMediaReceipt(response)) warnings.push(response.persistenceWarning || 'Image generated for preview, but saving to your library was not confirmed.');
        } catch (error) {
          failures.push(error instanceof Error ? error.message : `Image ${index + 1} failed`);
        }
      }

      if (generated.length === 0) {
        throw new Error(failures[0] || "Failed to generate image");
      }

      refreshContent();

      setImages((prev) => prependUniqueById(generated, prev));
      setCurrentImage(generated[0]);
      toast({
        title: failures.length > 0 || warnings.length > 0 ? "Generation partially completed" : "Images generated",
        description: failures.length > 0
          ? `${generated.length} of ${numberOfImages} images were generated. ${failures[0]}`
          : warnings[0] || [`${generated.length} ${generated.length === 1 ? "image" : "images"} generated and saved.`, ...settingsNotes].join(" "),
        variant: failures.length > 0 || warnings.length > 0 ? "destructive" : "default",
      });
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Generation failed. Try again.");
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate image",
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
        contentType: "image",
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      });
      if (response.success && response.enhancedPrompt) {
        proposeEnhancement(response.enhancedPrompt);
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
    setImages((prev) => prev.filter((img) => img.id !== id));
    setCurrentImage((current) => current?.id === id ? null : current);
    setPreviewImage((current) => current?.id === id ? null : current);
    toast({ title: "Deleted", description: "Image removed" });
  };

  const handleCopyPrompt = async (image: GeneratedImage) => {
    try {
      await copyText(image.prompt);
      setCopiedId(image.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" });
    }
  };

  const handleDownload = async (image: GeneratedImage) => {
    try { await downloadContentMedia(image.imageUrl, image.title, "png"); }
    catch { toast({ title: "Download failed", description: "The saved image could not be downloaded. Please retry.", variant: "destructive" }); }
  };

  const handleRandomSeed = () => {
    const randomSeed = Math.floor(Math.random() * 2147483647);
    setSeed(randomSeed);
    setUseRandomSeed(false);
  };

  const filteredImages = images.filter((image) => {
    const query = searchQuery.toLowerCase();
    return (
      image.title.toLowerCase().includes(query) ||
      image.prompt.toLowerCase().includes(query)
    );
  });

  const activeImage = currentImage;
  const imagePreview: CreatorPreviewModel = {
    format: "image",
    status: isGenerating ? "generating" : generationError || activeImage?.status === "failed" ? "failed" : activeImage ? "ready" : "empty",
    submittedPrompt,
    error: generationError,
    title: activeImage?.title,
    prompt: activeImage?.prompt || "",
    sourceUrl: activeImage?.imageUrl,
    aspectRatio: activeImage?.aspectRatio,
    style: activeImage?.style,
    size: activeImage?.size,
  };

  return (
    <ContentCreatorShell>
      {/* Header */}
      <ContentCreatorHeader>
        <div className="mb-3">
          <button onClick={() => router.push("/dashboard/saved-templates/image")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Images
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
              <ImageIcon className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Image generation</h1>
              <p className="text-sm text-muted-foreground">Create images with AI — describe what you want to see</p>
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <SearchInput
              size="sm"
              aria-label="Search images"
              placeholder="Search images..."
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
            <Button variant="outline" size="sm" onClick={loadImages} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </ContentCreatorHeader>

      {/* Main Content - Split Panel */}
      <ContentCreatorBody recentCount={filteredImages.length}>
        {/* Left Panel - Generation Controls */}
        <ContentCreatorComposer>
          <div className="flex-1 space-y-5 p-4 sm:p-5">
            <GeneratorModeSwitch mode={generationMode} onChange={setGenerationMode} manualLabel="Upload an image" />
              <ManualContentComposer
                active={generationMode === "manual"}
                onDraftChange={setManualDraft}
                assetType="image"
                channel="image"
                returnHref="/dashboard/saved-templates/image"
                contentLabel="Caption or alt text"
                contentPlaceholder="Describe the image for teammates, accessibility, or future reuse…"
                uploadLabel="Image file"
                accept="image/*"
                requireFile
                requireContent={false}
                mediaKind="image"
                onCreated={() => void loadImages()}
              />
            {generationMode === "ai" && (
            <div className="contents">
            {/* Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="image-prompt" className="text-sm font-medium">Image Prompt</Label>
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
                    id="image-prompt"
                placeholder="A professional marketing image showcasing the product with clean, modern design..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                className="resize-none text-sm"
              />
              {enhancementReview}
            </div>

            {/* Source Image (Image-to-Image) */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Source Image (optional)</Label>
              <p className="text-xs text-muted-foreground">Upload a reference image to transform or combine with your prompt</p>
              {sourceImagePreview ? (
                <div className="relative inline-block">
                  <img
                    src={sourceImagePreview}
                    alt="Source"
                    className="w-24 h-24 rounded-lg object-cover border-2 border-primary/20"
                  />
                  <button
                    aria-label="Remove source image"
                    onClick={handleRemoveSourceImage}
                    className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-border rounded-lg p-4 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-muted/50 transition-colors"
                >
                  <Upload className="w-6 h-6 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Click to upload an image</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleSourceImageUpload}
                className="hidden"
              />
            </div>

            {/* Negative Prompt */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Negative Prompt (optional)</Label>
              <Input
                placeholder="blurry, low quality, distorted, watermark..."
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                className="text-sm"
              />
            </div>

            {/* Settings Toggle */}
            <button
              aria-expanded={showSettings}
                onClick={() => setShowSettings(!showSettings)}
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
            >
              <Settings2 className="w-4 h-4" />
              Generation Settings
              <ChevronDown className={`w-4 h-4 ml-auto transition-transform ${showSettings ? "rotate-180" : ""}`} />
            </button>

            {showSettings && (
              <div className="space-y-4 bg-muted/30 rounded-lg p-4">
                {/* Aspect Ratio */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Aspect Ratio</Label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[AUTO_IMAGE_SETTING, ...supportedAspectRatios].map((ratio) => (
                      <button
                        key={ratio}
                        aria-pressed={aspectRatio === ratio}
                        onClick={() => setAspectRatio(ratio)}
                        className={`px-2 py-1.5 rounded-md text-xs font-medium transition-colors border ${
                          ratio === AUTO_IMAGE_SETTING ? "col-span-2" : ""
                        } ${
                          aspectRatio === ratio
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-muted"
                        }`}
                      >
                        {ratio === AUTO_IMAGE_SETTING ? autoAspectLabel : ratio}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Auto uses a ratio written in your prompt (for example 4:5), otherwise 1:1.
                  </p>
                </div>

                {/* Style */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Style</Label>
                  <Select value={style} onValueChange={setStyle}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STYLES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Image Size */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Image Size</Label>
                  {supportedResolutions.length > 0 ? (
                    <div className="grid grid-cols-3 gap-1.5">
                      {supportedResolutions.map((size) => (
                        <button
                          key={size}
                          aria-pressed={imageSize === size}
                          onClick={() => setImageSize(size)}
                          className={`px-2 py-1.5 rounded-md text-xs font-medium transition-colors border ${
                            imageSize === size
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background border-border hover:bg-muted"
                          }`}
                        >
                          <div>{size}</div>
                          <div className="text-xs opacity-70">{IMAGE_SIZE_DESCRIPTIONS[size] || ""}</div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">This image model sets its own resolution.</p>
                  )}
                  {modelOptions && (
                    <p className="text-xs text-muted-foreground">Options shown are the ones {modelOptions.model} supports.</p>
                  )}
                </div>

                {/* Number of Images */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Number of Images</Label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[1, 2, 3, 4].map((num) => (
                      <button
                        key={num}
                        onClick={() => setNumberOfImages(num)}
                        className={`px-2 py-1.5 rounded-md text-xs font-medium transition-colors border ${
                          numberOfImages === num
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-muted"
                        }`}
                      >
                        {num}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Seed */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Seed</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Random</span>
                      <Switch
                        checked={useRandomSeed}
                        onCheckedChange={(checked) => {
                          setUseRandomSeed(checked);
                          if (checked) setSeed(undefined);
                        }}
                      />
                    </div>
                  </div>
                  {useRandomSeed ? (
                    <div className="flex items-center gap-2">
                      <Input
                        disabled
                        placeholder="Random seed will be used"
                        className="text-sm bg-muted"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-9 w-9 flex-shrink-0"
                        onClick={handleRandomSeed}
                      >
                        <Dice5 className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        placeholder="Enter seed value"
                        value={seed ?? ""}
                        onChange={(e) => setSeed(e.target.value ? parseInt(e.target.value) : undefined)}
                        className="text-sm"
                        min={0}
                        max={2147483647}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-9 w-9 flex-shrink-0"
                        onClick={handleRandomSeed}
                      >
                        <Shuffle className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Use the same seed to reproduce similar results
                  </p>
                </div>
              </div>
            )}

            {/* Generate Button */}
            <GenerationEstimate includeText={false} image copies={numberOfImages} imageSize={supportedResolutions.length ? imageSize : "1K"} />
            <Button
              data-creator-action
              onClick={handleGenerate}
              loading={isGenerating}
              loadingText={`Generating${numberOfImages > 1 ? ` ${numberOfImages} images` : ""}...`}
              disabled={isEnhancing || !prompt.trim()}
              className="h-11 w-full"
              size="lg"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Generate{numberOfImages > 1 ? ` ${numberOfImages} Images` : " Image"}
            </Button>

            {/* Quick Prompt Suggestions */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium">Quick prompts</p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  "Professional product photo on white background",
                  "Modern abstract business banner",
                  "Social media post with vibrant colors",
                  "Clean minimalist logo concept",
                  "Marketing email hero image",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setPrompt(suggestion)}
                    className="px-2.5 py-1 rounded-full text-xs bg-muted hover:bg-muted/80 text-muted-foreground transition-colors border border-border/50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
            </div>
            )}
          </div>
        </ContentCreatorComposer>

        {/* Right Panel - Gallery */}
        <ContentCreatorStage preview={<div className="space-y-4"><CreatorPreview model={generationMode === "manual" ? manualDraftPreview("image", manualDraft) : imagePreview} />{generationMode === "ai" && currentImage?.imageUrl && <><AttachMediaToDraft mediaUrl={currentImage.imageUrl} mediaType="image" /><ImageProofTools key={currentImage.id} image={currentImage} alternatives={images.filter((image) => image.id !== currentImage.id && image.status === "completed")} /></>}</div>} recentCount={filteredImages.length}>
          <CreatorResultsPane>
          {loadError && <Callout tone="danger" className="mb-4" actions={<Button variant="outline" size="sm" onClick={() => void loadImages()}>Retry loading images</Button>}>{loadError}</Callout>}
          {isLoading ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-square rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : loadError ? null : filteredImages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="p-6 rounded-2xl bg-muted/50 mb-4">
                <ImageIcon className="w-12 h-12 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-1">{searchQuery ? "No matching images" : "No images yet"}</h3>
              {searchQuery && <Button variant="outline" onClick={() => setSearchQuery("")}>Clear search</Button>}
              <p className="text-sm text-muted-foreground max-w-sm">
                Enter a prompt and click Generate to create your first AI image
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <MasonryGrid columns={3}>
              {filteredImages.map((image) => (
                image.status === "completed" ? (
                  <ImageCard
                    key={image.id}
                    id={image.id.startsWith("db-") ? parseInt(image.id.replace("db-", ""), 10) : undefined}
                    title={image.title || "Generated Image"}
                    imageUrl={image.imageUrl}
                    prompt={image.prompt}
                    createdAt={new Date(image.createdAt).toISOString()}
                    onDelete={() => handleDelete(image.id)}
                    onEdit={() => setPreviewImage(image)}
                  />
                ) : (
                  <Card key={image.id} className="overflow-hidden">
                    {image.status === "pending" ? (
                      <MediaGenerationPlaceholder kind="image" className="aspect-square min-h-0" />
                    ) : (
                      <CardContent className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                        <ImageIcon className="h-8 w-8 text-destructive" />
                        <p className="text-sm font-medium">Image generation failed</p>
                      </CardContent>
                    )}
                  </Card>
                )
              ))}
            </MasonryGrid>
          ) : (
            <div className="space-y-2">
              {filteredImages.map((image) => (
                <Card
                  key={image.id}
                  className={`group transition-all ${image.status === "completed" ? "cursor-pointer hover:shadow-md" : ""}`}
                  onClick={() => image.status === "completed" && setPreviewImage(image)}
                >
                  <CardContent className="p-3 flex items-center gap-4">
                    {image.status === "completed" ? <img src={image.imageUrl} alt={image.title} className="w-16 h-16 rounded-lg object-cover flex-shrink-0" /> : (
                      <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg bg-muted"><Spinner size="md" label={null} /></div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{image.title}</p>
                      <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{image.prompt}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {image.style && <Badge variant="outline" className="text-xs py-0">{image.style}</Badge>}
                        {image.aspectRatio && <Badge variant="outline" className="text-xs py-0">{image.aspectRatio}</Badge>}
                        {image.size && <Badge variant="outline" className="text-xs py-0">{image.size}</Badge>}
                        {image.seed !== undefined && <Badge variant="outline" className="text-xs py-0">Seed: {image.seed}</Badge>}
                        <span className="text-xs text-muted-foreground">{new Date(image.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    {image.status === "completed" && <div className="flex items-center gap-1">
                      <Button aria-label="Copy image prompt" variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); handleCopyPrompt(image); }}>
                        {copiedId === image.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      <Button aria-label="Download image" variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); handleDownload(image); }}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <Button aria-label="Delete image" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this image? This cannot be undone.")) void handleDelete(image.id); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}


          </CreatorResultsPane>
        </ContentCreatorStage>
      </ContentCreatorBody>

      {/* Full-screen Preview Dialog */}
      <Dialog open={!!previewImage} onOpenChange={() => setPreviewImage(null)}>
        <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto p-0">
          <DialogTitle className="sr-only">Image preview</DialogTitle>
          <DialogDescription className="sr-only">Review saved content before using it.</DialogDescription>
          {previewImage && (
            <div className="flex flex-col">
              <div className="relative bg-black flex items-center justify-center min-h-[400px] max-h-[70vh]">
                <img
                  src={previewImage.imageUrl}
                  alt={previewImage.title}
                  className="max-w-full max-h-[70vh] object-contain"
                />
              </div>
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    {previewImage.style && <Badge variant="outline">{previewImage.style}</Badge>}
                    {previewImage.aspectRatio && <Badge variant="outline">{previewImage.aspectRatio}</Badge>}
                    {previewImage.size && <Badge variant="outline">{previewImage.size}</Badge>}
                    {previewImage.seed !== undefined && <Badge variant="outline">Seed: {previewImage.seed}</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleCopyPrompt(previewImage)}>
                      {copiedId === previewImage.id ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                      Copy Prompt
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload(previewImage)}>
                      <Download className="h-4 w-4 mr-1" />
                      Download
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setPrompt(previewImage.prompt); setPreviewImage(null); }}>
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Reuse Prompt
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{previewImage.prompt}</p>
                <AttachMediaToDraft mediaUrl={previewImage.imageUrl} mediaType="image" />
                <ImageProofTools key={previewImage.id} image={previewImage} alternatives={images.filter((image) => image.id !== previewImage.id && image.status === "completed")} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ContentCreatorShell>
  );
}
