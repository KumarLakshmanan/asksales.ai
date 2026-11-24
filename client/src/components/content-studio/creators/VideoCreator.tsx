"use client";

import { useContentLibraryRefresh } from "@/hooks/useContentLibraryRefresh";

import { useRefreshContentLibrary } from "@/hooks/use-content-counts";
import { useCreatorScope, creatorAssetUrl, creatorGenerationContext } from "../CreatorScope";
import { hasSavedMediaReceipt } from "@/lib/contentGenerationReceipt";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
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
import { useCreatorPrompt } from "@/hooks/use-creator-prompt";
import { downloadContentMedia, validateSourceImage } from "@/lib/contentMediaTools";
import { checkVideoSourceImageSize, readImageSize, VIDEO_IMAGE_ROLES, videoGenerationProgressLabel, type VideoImageRole } from "@/lib/videoSourceImage";
import { VideoCaptionTools } from "@/components/content-studio/VideoCaptionTools";
import { GenerationEstimate } from "@/components/content-studio/GenerationEstimate";
import { AttachMediaToDraft } from "@/components/content-studio/AttachMediaToDraft";
import { useWebSocket } from "@/contexts/WebSocketContext";
import api from "@/lib/api";
import { prependUniqueById } from "@/lib/uniqueById";
import { normalizeUploadUrl } from "@/lib/utils";
import { useContentBrandContext } from "@/hooks/use-content-brand-context";
import {
  Video,
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
  Play,
  Upload,
  Shuffle,
  Dice5,
  Users,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { VideoCard } from "@/components/content-cards";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { ContentCreatorBody, ContentCreatorComposer, ContentCreatorHeader, ContentCreatorShell, ContentCreatorStage, CreatorResultsPane } from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";
import { MediaGenerationPlaceholder } from "@/components/content-studio/MediaGenerationPlaceholder";

interface GeneratedVideo {
  id: string;
  title: string;
  videoUrl: string;
  prompt: string;
  createdAt: number;
  duration?: string;
  resolution?: string;
  aspectRatio?: string;
  style?: string;
  sourceType?: string;
  sourceTitle?: string;
  seed?: number;
  status: "pending" | "completed" | "failed";
  operationName?: string;
  error?: string;
  startFrameUrl?: string;
  stage?: string;
}

interface VideoGenerationResponse {
  success: boolean;
  videoData?: string;
  videoUrl?: string;
  mimeType?: string;
  assetId?: number | null;
  persisted?: boolean;
  persistenceWarning?: string;
  operationName?: string;
  jobId?: string;
  status?: "pending" | "completed" | "failed";
  error?: string;
}

const ASPECT_RATIOS = [
  { value: "16:9", label: "16:9", description: "Landscape" },
  { value: "9:16", label: "9:16", description: "Portrait" },
];

const DURATIONS = [
  { value: "4", label: "4s" },
  { value: "6", label: "6s" },
  { value: "8", label: "8s" },
];

const RESOLUTIONS = [
  { value: "480p", label: "480p", description: "Standard" },
  { value: "720p", label: "720p", description: "HD" },
];

const STYLES = [
  { value: "cinematic", label: "Cinematic" },
  { value: "promotional", label: "Promotional" },
  { value: "explainer", label: "Explainer" },
  { value: "social-media", label: "Social Media" },
  { value: "product-demo", label: "Product Demo" },
  { value: "animated", label: "Animated" },
];

export default function VideoCreator() {
  const scope = useCreatorScope();
  useContentLibraryRefresh(scope.refreshKey ?? 0, () => { void loadVideos(); });
  const refreshContent = useRefreshContentLibrary();
  const generationContext = creatorGenerationContext(scope);
  const router = useRouter();
  const { toast } = useToast();
  const { brandToolkitId, businessProfileId, missingMessage, toolkit } = useContentBrandContext();
  const { subscribe } = useWebSocket();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const pollingOperationsRef = useRef(new Set<string>());
  const loadInFlightRef = useRef(false);
  const previousVideoRef = useRef<GeneratedVideo | null>(null);

  // Generation settings
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt("video");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [includeBrandLogo, setIncludeBrandLogo] = useState(true);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [storyboard, setStoryboard] = useState("");
  const [storyboardApproved, setStoryboardApproved] = useState(false);
  const hasBrandLogo = includeBrandLogo && toolkit?.logoVisibility !== false && Boolean(toolkit?.logoUrl || toolkit?.logoUrls?.some((url) => url.trim()));
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [duration, setDuration] = useState("8");
  const [resolution, setResolution] = useState("720p");
  const [style, setStyle] = useState("cinematic");
  const [numberOfVideos, setNumberOfVideos] = useState(1);
  const [personGeneration, setPersonGeneration] = useState<"allow_adult" | "dont_allow">("allow_adult");
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [useRandomSeed, setUseRandomSeed] = useState(true);

  // Source image for image-to-video
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [sourceImagePreview, setSourceImagePreview] = useState<string | null>(null);
  const [sourceImageMimeType, setSourceImageMimeType] = useState("image/jpeg");
  const [sourceImageNotice, setSourceImageNotice] = useState<string | null>(null);
  const [imageRole, setImageRole] = useState<VideoImageRole>("reference");
  // Veo needs an 8-second clip when an image is used as a subject reference.
  const requiresEightSeconds = Boolean(sourceImage) && imageRole === "reference";

  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [videos, setVideos] = useState<GeneratedVideo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showSettings, setShowSettings] = useState(false);
  const [generationMode, setGenerationMode] = useState<GeneratorMode>("ai");
  const [manualDraft, setManualDraft] = useState<ManualDraft>({ title: "", subject: "", description: "", content: "" });
  const [loadError, setLoadError] = useState<string | undefined>();
  const [pausedOperations, setPausedOperations] = useState<string[]>([]);
  const [previewVideo, setPreviewVideo] = useState<GeneratedVideo | null>(null);
  const [currentVideo, setCurrentVideo] = useState<GeneratedVideo | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (requiresEightSeconds) setDuration("8");
  }, [requiresEightSeconds]);

  useEffect(() => {
    mountedRef.current = true;
    loadVideos();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const unsub = subscribe('content_asset_updated', (data) => {
      if (data.type === 'video') {
        loadVideos();
      }
    });
    return unsub;
  }, [subscribe]);

  const hasPendingVideos = videos.some((video) => video.status === "pending" && !video.operationName);
  const [, setProgressTick] = useState(0);
  const anyPendingVideo = videos.some((video) => video.status === "pending");
  useEffect(() => {
    // Keeps the elapsed-time label on pending videos current.
    if (!anyPendingVideo) return;
    const timer = window.setInterval(() => setProgressTick((tick) => tick + 1), 15000);
    return () => window.clearInterval(timer);
  }, [anyPendingVideo]);
  useEffect(() => {
    if (!hasPendingVideos) return;
    // Background refresh: skip hidden tabs and never overlap an in-flight load.
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (loadInFlightRef.current) return;
      void loadVideos(false);
    };
    const timer = window.setInterval(refresh, 10000);
    // Catch up as soon as the tab becomes visible again.
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [hasPendingVideos]);

  const loadVideos = async (showLoading = true) => {
    loadInFlightRef.current = true;
    if (showLoading) setIsLoading(true);
    setLoadError(undefined);
    try {
      const response = await api.get<Array<{
        id: number;
        type: string;
        title: string;
        content: string;
        videoUrl?: string | null;
        videoUrls?: string[] | null;
        channel: string;
        status?: string;
        createdAt: string;
        performance?: Record<string, unknown>;
      }>>(creatorAssetUrl("video", scope));

      if (!mountedRef.current) return;
      if (Array.isArray(response)) {
        const mapped: GeneratedVideo[] = response
          .filter((a) => a.type === "video")
          .map((asset) => {
            let videoUrl = asset.videoUrl || asset.videoUrls?.[0] || "";
            let parsed: Record<string, unknown> = {};
            try {
              const value = JSON.parse(asset.content);
              if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
              videoUrl ||= typeof parsed.videoUrl === "string" ? parsed.videoUrl : "";
              videoUrl ||= typeof parsed.url === "string" ? parsed.url : "";
            } catch {
              videoUrl ||= asset.content;
            }
            if (videoUrl && !videoUrl.startsWith("data:")) videoUrl = normalizeUploadUrl(videoUrl);
            const perf = asset.performance || {};
            const mediaGeneration = perf.mediaGeneration as { video?: { status?: string; error?: string } } | undefined;
            const job = mediaGeneration?.video;
            const operationName = typeof perf.operationName === "string" ? perf.operationName : undefined;
            const isActivelyGenerating = job?.status === "queued" || job?.status === "processing" || (!job && ["pending", "queued", "processing"].includes(asset.status || "") && !!operationName);
            return {
              id: `db-${asset.id}`,
              title: asset.title,
              videoUrl,
              prompt: (perf.prompt as string) || "",
              createdAt: new Date(asset.createdAt).getTime(),
              duration: perf.duration ? String(perf.duration) : undefined,
              resolution: (perf.resolution as string) || undefined,
              aspectRatio: (perf.aspectRatio as string) || undefined,
              style: (perf.style as string) || undefined,
              sourceType: (perf.sourceType as string) || undefined,
              sourceTitle: (perf.sourceTitle as string) || undefined,
              seed: (perf.seed as number) || undefined,
              status: videoUrl ? "completed" : isActivelyGenerating ? "pending" : "failed",
              operationName,
              error: job?.error || (typeof parsed.error === "string" ? parsed.error : undefined),
              stage: job?.status,
            };
          });
        setVideos(mapped);
        setPausedOperations((previous) => {
          const pending = previous.filter(operation => mapped.some(video => video.status === "pending" && video.operationName === operation));
          return pending.length === previous.length ? previous : pending;
        });
        setCurrentVideo((current) => {
          if (!current) return null;
          const refreshed = mapped.find((video) => video.id === current.id) || current;
          return refreshed.status === "failed" && previousVideoRef.current?.status === "completed"
            ? { ...previousVideoRef.current, error: refreshed.error || "The new video failed. Your previous result is still available." }
            : refreshed;
        });
        mapped.filter(video => video.status === "pending" && video.operationName).forEach(video => {
          void pollVideoOperation(video.operationName!, Number(video.id.slice(3)));
        });
      }
    } catch (error) {
      console.error("Error loading videos:", error);
      setLoadError("Your videos could not be loaded. Refresh to check saved jobs before starting another generation.");
    } finally {
      loadInFlightRef.current = false;
      setIsLoading(false);
    }
  };

  const pollVideoOperation = async (operationName: string, expectedAssetId: number) => {
    if (pollingOperationsRef.current.has(operationName)) return;
    pollingOperationsRef.current.add(operationName);
    setPausedOperations(previous => previous.includes(operationName) ? previous.filter(operation => operation !== operationName) : previous);
    let savingWarningShown = false;
    let lastStatusError: string | undefined;
    try {
      for (let attempt = 0; attempt < 120 && mountedRef.current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        if (!mountedRef.current) return;
        try {
          const status = await api.get<{
            success: boolean;
            done?: boolean;
            videoUrl?: string;
            error?: string;
            persisted?: boolean;
            assetId?: number;
          }>(`/api/content/studio/video/status/${encodeURIComponent(operationName)}`);
          if (!mountedRef.current) return;
          lastStatusError = undefined;
          if (!status.done) continue;
          if (status.videoUrl && (!hasSavedMediaReceipt(status) || status.assetId !== expectedAssetId)) {
            if (!savingWarningShown) {
              savingWarningShown = true;
              toast({ title: "Video save not confirmed", description: "The provider generated the video, but its library save is not confirmed. Continuing to check the same request.", variant: "destructive" });
            }
            continue;
          }
          if (status.success && status.videoUrl && hasSavedMediaReceipt(status) && status.assetId === expectedAssetId) {
            setCurrentVideo((current) => current?.operationName === operationName
              ? { ...current, id: `db-${status.assetId}`, videoUrl: status.videoUrl || "", status: "completed" }
              : current);
            refreshContent();
            await loadVideos();
            toast({ title: "Video ready", description: "The completed video was saved to your library." });
          } else {
            setCurrentVideo((current) => current?.operationName === operationName
              ? { ...current, status: "failed", error: status.error }
              : current);
            await loadVideos();
            toast({ title: "Video generation failed", description: status.error || "The provider did not return a video.", variant: "destructive" });
          }
          return;
        } catch (error) {
          lastStatusError = error instanceof Error ? error.message : "The saved operation could not be checked.";
        }
      }
      if (mountedRef.current) {
        setPausedOperations(previous => previous.includes(operationName) ? previous : [...previous, operationName]);
        toast({
          title: lastStatusError ? "Video status unavailable" : "Video status checks paused",
          description: `${lastStatusError ? `${lastStatusError} ` : ""}Refresh saved video status in Recent to check the same job. Starting generation again creates a new request.`,
          variant: lastStatusError ? "destructive" : "default",
        });
      }
    } finally {
      pollingOperationsRef.current.delete(operationName);
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
    reader.onload = async (event) => {
      const dataUrl = event.target?.result as string;
      const size = await readImageSize(dataUrl);
      const check = checkVideoSourceImageSize(size);
      if (check.error) {
        toast({ title: "Cannot use this image", description: check.error, variant: "destructive" });
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      setSourceImageNotice(check.notice ?? null);
      setSourceImagePreview(dataUrl);
      setSourceImage(dataUrl.split(",")[1] || null);
      setSourceImageMimeType(file.type);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveSourceImage = () => {
    setSourceImage(null);
    setSourceImagePreview(null);
    setSourceImageNotice(null);
    setSourceImageMimeType("image/jpeg");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleGenerate = async () => {
    if (isGenerating || (storyboard.trim() && !storyboardApproved)) return;
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
    if (currentVideo?.status === "completed") previousVideoRef.current = currentVideo;
    setIsGenerating(true);
    try {
      // Generate exactly the prompt the user reviewed. Enhancement is an explicit action.
      const enhancedPrompt = prompt;

      const effectiveSeed = useRandomSeed ? undefined : seed;

      const requestBody: Record<string, unknown> = {
        prompt: `${enhancedPrompt}${storyboard.trim() ? `\n\nApproved storyboard: ${storyboard.trim()}` : ""}${negativePrompt ? `\n\nNegative prompt: ${negativePrompt}` : ""}`,
        style,
        duration,
        resolution,
        aspectRatio,
        saveToAssets: true,
        background: true,
        personGeneration,
        channel: "video_generation",
        ...generationContext,
        brandToolkitId,
        businessProfileId,
        includeBrandLogo,
        generateAudio,
      };

      if (effectiveSeed !== undefined) {
        requestBody.seed = effectiveSeed;
      }

      if (sourceImage) {
        requestBody.image = { base64Data: sourceImage, mimeType: sourceImageMimeType };
        requestBody.imageRole = imageRole;
      }

      const generated: GeneratedVideo[] = [];
      const failures: string[] = [];
      const warnings: string[] = [];
      let queued = 0;

      for (let index = 0; index < numberOfVideos; index += 1) {
        try {
          const body = {
            ...requestBody,
            ...(effectiveSeed !== undefined ? { seed: effectiveSeed + index } : {}),
          };
          const response = await api.post<VideoGenerationResponse>("/api/content/studio/video", body);
          if (response.success && (response.operationName || response.jobId) && !response.videoUrl) {
            if (!hasSavedMediaReceipt(response)) {
              failures.push(response.persistenceWarning || 'Video generation started, but its tracking record was not saved. Check your library before generating again.');
              continue;
            }
            queued += 1;
            if (queued === 1 && generated.length === 0) {
              setCurrentVideo({
                id: response.assetId ? `db-${response.assetId}` : `queued-${response.operationName}`,
                title: "Generating Video",
                videoUrl: "",
                prompt,
                createdAt: Date.now(),
                duration,
                resolution,
                aspectRatio,
                style,
                sourceType: sourceImage ? "image-to-video" : "text-to-video",
                seed: effectiveSeed !== undefined ? effectiveSeed + index : undefined,
                status: "pending",
                stage: "queued",
                startFrameUrl: sourceImagePreview || undefined,
                operationName: response.operationName,
              });
            }
            if (response.operationName) void pollVideoOperation(response.operationName, response.assetId!);
            if (response.persistenceWarning) warnings.push(response.persistenceWarning);
            continue;
          }
          if (!response.success || !response.videoUrl) {
            failures.push(response.error || `Video ${index + 1} failed`);
            continue;
          }

          generated.push({
            id: hasSavedMediaReceipt(response) ? `db-${response.assetId}` : `gen-${Date.now()}-${index}`,
            title: numberOfVideos > 1 ? `Generated Video ${index + 1}` : "Generated Video",
            videoUrl: response.videoUrl,
            prompt,
            createdAt: Date.now(),
            duration,
            resolution,
            aspectRatio,
            style,
            sourceType: sourceImage ? "image-to-video" : "text-to-video",
            seed: effectiveSeed !== undefined ? effectiveSeed + index : undefined,
            status: "completed",
          });
          if (response.persistenceWarning || !hasSavedMediaReceipt(response)) warnings.push(response.persistenceWarning || 'Video generated for preview, but saving to your library was not confirmed.');
        } catch (error) {
          failures.push(error instanceof Error ? error.message : `Video ${index + 1} failed`);
        }
      }

      if (generated.length === 0 && queued === 0) {
        throw new Error(failures[0] || "Failed to generate video");
      }

      if (generated.length > 0) {
        refreshContent();
        setVideos((prev) => prependUniqueById(generated, prev));
        setCurrentVideo(generated[0]);
      }
      if (queued > 0) await loadVideos();
      toast({
        title: failures.length > 0 || warnings.length > 0
          ? "Generation partially completed"
          : queued > 0 ? "Video generation started" : "Videos generated",
        description: failures.length > 0
          ? `${generated.length} completed, ${queued} queued, ${failures.length} failed of ${numberOfVideos} requested. ${failures[0]}`
          : (warnings[0] || (queued > 0
              ? `${queued} ${queued === 1 ? "video is" : "videos are"} processing. This page will update when ready.`
              : `${generated.length} ${generated.length === 1 ? "video" : "videos"} generated and saved.`)),
        variant: failures.length > 0 || warnings.length > 0 ? "destructive" : "default",
      });
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Video generation failed. Check recent jobs before retrying.");
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate video",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleEnhancePrompt = async () => {
    setIsEnhancing(true);
    try {
      const response = await api.post<{
        success: boolean;
        enhancedPrompt: string;
      }>("/api/content/studio/magic-prompt", {
        currentPrompt: prompt,
        contentType: "video",
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
    setVideos((prev) => prev.filter((vid) => vid.id !== id));
    setCurrentVideo((current) => current?.id === id ? null : current);
    setPreviewVideo((current) => current?.id === id ? null : current);
    toast({ title: "Deleted", description: "Video removed" });
  };

  const handleCopyPrompt = async (video: GeneratedVideo) => {
    try {
      await copyText(video.prompt);
      setCopiedId(video.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the prompt manually.", variant: "destructive" });
    }
  };

  const handleDownload = async (video: GeneratedVideo) => {
    try { await downloadContentMedia(video.videoUrl, video.title, "mp4"); }
    catch { toast({ title: "Download failed", description: "The saved video could not be downloaded. Please retry.", variant: "destructive" }); }
  };

  const handleRandomSeed = () => {
    const randomSeed = Math.floor(Math.random() * 2147483647);
    setSeed(randomSeed);
    setUseRandomSeed(false);
  };

  const filteredVideos = videos.filter((video) => {
    const query = searchQuery.toLowerCase();
    return (
      video.title.toLowerCase().includes(query) ||
      video.prompt.toLowerCase().includes(query)
    );
  });

  const activeVideo = currentVideo;
  const previewDuration = activeVideo?.duration;
  const videoPreview: CreatorPreviewModel = {
    format: "video",
    status: isGenerating ? "generating" : generationError ? "failed" : activeVideo?.status === "pending" ? "generating" : activeVideo?.status === "failed" ? "failed" : activeVideo ? "ready" : "empty",
    submittedPrompt,
    error: generationError || activeVideo?.error,
    title: activeVideo?.title,
    prompt: activeVideo?.prompt || "",
    startFrameUrl: activeVideo?.startFrameUrl,
    videoUrl: activeVideo?.videoUrl,
    aspectRatio: activeVideo?.aspectRatio,
    duration: previewDuration ? previewDuration.endsWith("s") ? previewDuration : `${previewDuration}s` : undefined,
    resolution: activeVideo?.resolution,
    style: activeVideo?.style,
  };

  return (
    <ContentCreatorShell>
      {/* Header */}
      <ContentCreatorHeader>
        <div className="mb-3">
          <button onClick={() => router.push("/dashboard/saved-templates/video")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Videos
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
              <Video className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Video generation</h1>
              <p className="text-sm text-muted-foreground">Create videos with AI — describe your vision</p>
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <SearchInput
              size="sm"
              aria-label="Search videos"
              placeholder="Search videos..."
              value={searchQuery}
              onValueChange={setSearchQuery}
              wrapperClassName="flex-1 sm:w-[200px] sm:flex-none"
            />
            <div className="inline-flex items-center rounded-lg border border-border bg-background p-1">
              <button
                aria-label="Grid view"
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                <Grid3X3 className="h-4 w-4" />
              </button>
              <button
                aria-label="List view"
                onClick={() => setViewMode("list")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadVideos()} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </ContentCreatorHeader>

      {/* Main Content - Split Panel */}
      <ContentCreatorBody recentCount={filteredVideos.length}>
        {/* Left Panel - Generation Controls */}
        <ContentCreatorComposer>
          <div className="flex-1 space-y-5 p-4 sm:p-5">
            <GeneratorModeSwitch mode={generationMode} onChange={setGenerationMode} manualLabel="Upload a video" />
              <ManualContentComposer
                active={generationMode === "manual"}
                assetType="video"
                channel="video"
                returnHref="/dashboard/saved-templates/video"
                contentLabel="Caption or transcript"
                contentPlaceholder="Add a caption, transcript, or usage notes for this video…"
                uploadLabel="Video file"
                accept="video/*"
                requireFile
                requireContent={false}
                mediaKind="video"
                onDraftChange={setManualDraft}
                onCreated={() => void loadVideos()}
              />
            {generationMode === "ai" && (
            <div className="contents">
            {/* Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="video-prompt" className="text-sm font-medium">Video Prompt</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleEnhancePrompt}
                  loading={isEnhancing}
                  loadingText="Enhancing…"
                  disabled={!prompt.trim()}
                  className="h-7 text-xs text-primary hover:bg-primary/8 hover:text-primary"
                >
                  <Wand2 className="w-3.5 h-3.5 mr-1" /> Enhance
                </Button>
              </div>
              <Textarea
                id="video-prompt"
                placeholder="A smooth product reveal video with cinematic lighting and professional feel..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                className="resize-none text-sm"
              />
              {enhancementReview}
            </div>

            {/* Source Image (Image-to-Video) */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Reference image (optional)</Label>
              <p className="text-xs text-muted-foreground">Add a product, subject or style image. Your prompt still decides what happens in the video.</p>
              {sourceImagePreview ? (
                <div className="relative inline-block">
                  <img
                    src={sourceImagePreview}
                    alt="Source"
                    className="w-32 h-18 rounded-lg bg-muted object-contain border-2 border-primary/20"
                  />
                  <button
                    aria-label="Remove source image"
                    onClick={handleRemoveSourceImage}
                    className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs"
                  >
                    ×
                  </button>
                  <Badge className="absolute bottom-1 left-1 text-xs bg-black/60 text-white border-0">
                    {imageRole === "start_frame" ? "First frame" : "Reference"}
                  </Badge>
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
              {sourceImagePreview && (
                <fieldset className="space-y-1.5">
                  <legend className="text-xs font-medium">How should the video use this image?</legend>
                  {VIDEO_IMAGE_ROLES.map((option) => (
                    <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                      <input type="radio" name="video-image-role" value={option.value} checked={imageRole === option.value} onChange={() => setImageRole(option.value)} className="mt-0.5" />
                      <span><span className="font-medium text-foreground">{option.label}</span><span className="block text-muted-foreground">{option.description}</span></span>
                    </label>
                  ))}
                </fieldset>
              )}
              {sourceImageNotice && <p role="status" className="text-xs text-muted-foreground">{sourceImageNotice}</p>}
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
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm font-medium">Production choices</p>
              <label className="flex items-center justify-between gap-3 text-sm">Include brand logo<Switch checked={includeBrandLogo} onCheckedChange={setIncludeBrandLogo} /></label>
              <p className="text-xs text-muted-foreground">{hasBrandLogo ? "Your approved logo is placed in the corner of the finished video, so its shape and spelling stay exact. The AI is told not to draw logos." : "No logo will be added to the video."}</p>
              <label className="flex items-center justify-between gap-3 text-sm">Generate audio<Switch checked={generateAudio} onCheckedChange={setGenerateAudio} /></label>
              <p className="text-xs text-muted-foreground">Audio is generated by the selected provider. Review speech before use; captions are not added automatically.</p>
              <Label htmlFor="video-storyboard">Storyboard (optional)</Label>
              <Textarea id="video-storyboard" placeholder="Opening shot → product detail → closing frame" value={storyboard} onChange={(event) => { setStoryboard(event.target.value); setStoryboardApproved(false); }} rows={3} />
              {storyboard.trim() && <label className="flex items-center justify-between gap-3 text-sm">Approve this storyboard<Switch checked={storyboardApproved} onCheckedChange={setStoryboardApproved} /></label>}
            </div>
            <button
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
                  <div className="grid grid-cols-2 gap-1.5">
                    {ASPECT_RATIOS.map((ar) => (
                      <button
                        key={ar.value}
                        onClick={() => setAspectRatio(ar.value)}
                        className={`px-3 py-2 rounded-md text-xs font-medium transition-colors border disabled:cursor-not-allowed disabled:opacity-40 ${
                          aspectRatio === ar.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-muted"
                        }`}
                      >
                        <div>{ar.label}</div>
                        <div className="text-xs opacity-70">{ar.description}</div>
                      </button>
                    ))}
                  </div>
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

                {/* Duration */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Duration</Label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {DURATIONS.map((d) => (
                      <button
                        key={d.value}
                        onClick={() => setDuration(d.value)}
                        disabled={requiresEightSeconds && d.value !== "8"}
                        className={`px-3 py-2 rounded-md text-xs font-medium transition-colors border ${
                          duration === d.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-muted"
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {requiresEightSeconds
                      ? "Videos that use a reference image are 8 seconds long. Choose “Exact first frame” for 4 or 6 seconds."
                      : "Choose a 4, 6, or 8 second clip"}
                  </p>
                </div>

                {/* Resolution */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Resolution</Label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {RESOLUTIONS.map((r) => (
                      <button
                        key={r.value}
                        onClick={() => setResolution(r.value)}
                        className={`px-3 py-2 rounded-md text-xs font-medium transition-colors border ${
                          resolution === r.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-muted"
                        }`}
                      >
                        <div>{r.label}</div>
                        <div className="text-xs opacity-70">{r.description}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Number of Videos */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Number of Videos</Label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[1, 2, 3, 4].map((num) => (
                      <button
                        key={num}
                        onClick={() => setNumberOfVideos(num)}
                        className={`px-2 py-1.5 rounded-md text-xs font-medium transition-colors border ${
                          numberOfVideos === num
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-border hover:bg-muted"
                        }`}
                      >
                        {num}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Person Generation */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Person Generation</Label>
                    <Users className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => setPersonGeneration("allow_adult")}
                      className={`px-3 py-2 rounded-md text-xs font-medium transition-colors border ${
                        personGeneration === "allow_adult"
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background border-border hover:bg-muted"
                      }`}
                    >
                      Allow Adults
                    </button>
                    <button
                      onClick={() => setPersonGeneration("dont_allow")}
                      className={`px-3 py-2 rounded-md text-xs font-medium transition-colors border ${
                        personGeneration === "dont_allow"
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background border-border hover:bg-muted"
                      }`}
                    >
                      No People
                    </button>
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
            <GenerationEstimate includeText={false} video copies={numberOfVideos} duration={Number(duration)} resolution={resolution} />
            <Button
              data-creator-action
              onClick={handleGenerate}
              loading={isGenerating}
              loadingText={`Generating${numberOfVideos > 1 ? ` ${numberOfVideos} videos` : ""}...`}
              disabled={!prompt.trim() || Boolean(storyboard.trim() && !storyboardApproved)}
              className="h-11 w-full"
              size="lg"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Generate{numberOfVideos > 1 ? ` ${numberOfVideos} Videos` : " Video"}
            </Button>
            <p className="text-xs text-muted-foreground">Generation saves a draft. Saved pending jobs are recovered from Recent after navigation. Completion time depends on the provider; running provider jobs cannot currently be cancelled.</p>

            {/* Quick Prompt Suggestions */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium">Quick prompts</p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  "Product reveal with cinematic lighting",
                  "Social media promo with text overlays",
                  "Smooth transition slideshow of images",
                  "Animated explainer with modern graphics",
                  "Brand intro with logo animation",
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
        <ContentCreatorStage preview={<div className="space-y-4"><CreatorPreview model={generationMode === "manual" ? { format: "video", status: "draft", title: manualDraft.title, prompt: manualDraft.content, videoUrl: manualDraft.mediaUrl } : videoPreview} />{generationMode === "ai" && currentVideo?.videoUrl && <><AttachMediaToDraft mediaUrl={currentVideo.videoUrl} mediaType="video" /><VideoCaptionTools key={currentVideo.id} video={currentVideo} /></>}</div>} recentCount={filteredVideos.length}>
          <CreatorResultsPane>
          {pausedOperations.length > 0 && <div role="status" className="mb-3 rounded-lg border border-border p-3 text-sm text-muted-foreground">
            <p>Automatic status checks have paused for a saved video. Your pending jobs remain in Recent; refresh to check the same operations.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadVideos()}>Refresh saved video status</Button>
          </div>}
          {videos.some(video => video.status === "pending") && <p role="status" className="mb-3 text-sm text-muted-foreground">{videos.filter(video => video.status === "pending").length} video request{videos.filter(video => video.status === "pending").length === 1 ? " is" : "s are"} pending</p>}
          {loadError && <Callout tone="danger" className="mb-4" actions={<Button variant="outline" size="sm" onClick={() => void loadVideos()}>Retry loading videos</Button>}>{loadError}</Callout>}
          {isLoading ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-video rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : loadError ? null : filteredVideos.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="p-6 rounded-2xl bg-muted/50 mb-4">
                <Video className="w-12 h-12 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-1">{searchQuery ? "No matching videos" : "No videos yet"}</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Enter a prompt and click Generate to create your first AI video
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <MasonryGrid columns={2}>
              {filteredVideos.map((video) => (
                video.status === "completed" ? (
                  <VideoCard
                    key={video.id}
                    id={video.id.startsWith("db-") ? parseInt(video.id.replace("db-", ""), 10) : undefined}
                    title={video.title || "Generated Video"}
                    videoUrl={video.videoUrl}
                    prompt={video.prompt}
                    createdAt={new Date(video.createdAt).toISOString()}
                    sourceType={video.sourceType}
                    sourceTitle={video.sourceTitle}
                    onDelete={() => handleDelete(video.id)}
                    onEdit={() => setPreviewVideo(video)}
                  />
                ) : (
                  <Card key={video.id} className="overflow-hidden">
                    {video.status === "pending" ? (
                      <div><MediaGenerationPlaceholder kind="video" className="aspect-video min-h-0" /><p className="px-4 pb-4 text-xs text-muted-foreground">{video.stage === "queued" ? "Queued — waiting for a video worker." : videoGenerationProgressLabel(video.createdAt)} You can leave this page; the saved job continues.</p></div>
                    ) : (
                      <CardContent className="flex aspect-video flex-col items-center justify-center gap-2 p-5 text-center">
                        <Video className="h-7 w-7 text-destructive" />
                        <p className="text-sm font-medium">Video generation failed</p>
                        <p className="line-clamp-2 text-xs text-muted-foreground">{video.error || "Try generating the video again."}</p>
                        <Button variant="outline" size="sm" onClick={() => { setPrompt(video.prompt); setGenerationMode("ai"); }}>Reuse prompt to retry</Button>
                      </CardContent>
                    )}
                  </Card>
                )
              ))}
            </MasonryGrid>
          ) : (
            <div className="space-y-2">
              {filteredVideos.map((video) => (
                <Card
                  key={video.id}
                  className={`group transition-all ${video.status === "completed" ? "cursor-pointer hover:shadow-md" : ""}`}
                  onClick={() => video.status === "completed" && setPreviewVideo(video)}
                >
                  <CardContent className="p-3 flex items-center gap-4">
                    <div className="relative w-24 h-14 rounded-lg overflow-hidden flex-shrink-0 bg-muted">
                      {video.status === "completed" && <video src={video.videoUrl} className="w-full h-full bg-black object-contain" muted preload="metadata" />}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                        {video.status === "pending" ? <Spinner size="md" label="Video generating" /> : video.status === "failed" ? <Video className="h-5 w-5 text-destructive" /> : <Play className="h-4 w-4 text-white fill-white" />}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{video.title}</p>
                      <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{video.prompt}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {video.duration && <Badge variant="outline" className="text-xs py-0">{video.duration}s</Badge>}
                        {video.resolution && <Badge variant="outline" className="text-xs py-0">{video.resolution}</Badge>}
                        {video.aspectRatio && <Badge variant="outline" className="text-xs py-0">{video.aspectRatio}</Badge>}
                        {video.seed !== undefined && <Badge variant="outline" className="text-xs py-0">Seed: {video.seed}</Badge>}
                        <span className="text-xs text-muted-foreground">{new Date(video.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    {video.status === "completed" && <div className="flex items-center gap-1">
                      <Button aria-label="Copy video prompt" variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); handleCopyPrompt(video); }}>
                        {copiedId === video.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      <Button aria-label="Download video" variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); handleDownload(video); }}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <Button aria-label="Delete video" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this video? This cannot be undone.")) void handleDelete(video.id); }}>
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
      <Dialog open={!!previewVideo} onOpenChange={() => setPreviewVideo(null)}>
        <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto p-0">
          <DialogTitle className="sr-only">Video preview</DialogTitle>
          <DialogDescription className="sr-only">Review this saved video before using it.</DialogDescription>
          {previewVideo && (
            <div className="flex flex-col">
              <div className="relative bg-black flex items-center justify-center min-h-[400px] max-h-[70vh]">
                <video
                  src={previewVideo.videoUrl}
                  controls
                  preload="metadata"
                  className="max-w-full max-h-[70vh]"
                />
              </div>
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    {previewVideo.duration && <Badge variant="outline">{previewVideo.duration}s</Badge>}
                    {previewVideo.resolution && <Badge variant="outline">{previewVideo.resolution}</Badge>}
                    {previewVideo.aspectRatio && <Badge variant="outline">{previewVideo.aspectRatio}</Badge>}
                    {previewVideo.style && <Badge variant="outline">{previewVideo.style}</Badge>}
                    {previewVideo.sourceType && <Badge variant="outline">{previewVideo.sourceType}</Badge>}
                    {previewVideo.seed !== undefined && <Badge variant="outline">Seed: {previewVideo.seed}</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleCopyPrompt(previewVideo)}>
                      {copiedId === previewVideo.id ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                      Copy Prompt
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload(previewVideo)}>
                      <Download className="h-4 w-4 mr-1" />
                      Download
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setPrompt(previewVideo.prompt); setPreviewVideo(null); }}>
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Reuse Prompt
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{previewVideo.prompt}</p>
                <AttachMediaToDraft mediaUrl={previewVideo.videoUrl} mediaType="video" />
                <VideoCaptionTools key={previewVideo.id} video={previewVideo} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ContentCreatorShell>
  );
}
