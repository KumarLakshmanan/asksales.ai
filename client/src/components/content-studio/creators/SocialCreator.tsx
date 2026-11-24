"use client";

import { useContentLibraryRefresh } from "@/hooks/useContentLibraryRefresh";

import { useRefreshContentLibrary } from "@/hooks/use-content-counts";
import { useCreatorScope, creatorAssetUrl, creatorGenerationContext, creatorDraftScope } from "../CreatorScope";
import { captionFromSocialAsset } from "@/lib/socialPublishing";
import { useCreatorPrompt } from "@/hooks/use-creator-prompt";
import { CompanionMediaOptions, type CompanionMedia } from "@/components/content-studio/CompanionMediaOptions";
import { creatorUploadError } from "@/lib/creator-upload";
import { creatorSessionScope } from '@/lib/creator-session';

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useWebSocket } from "@/contexts/WebSocketContext";
import api from "@/lib/api";
import { prependUniqueById } from "@/lib/uniqueById";
import { buildContentMedia } from "@/lib/contentMedia";
import { useContentBrandContext } from "@/hooks/use-content-brand-context";
import {
  Share2,
  Sparkles,
  Wand2,
  Download,
  Trash2,
  Check,
  Settings2,
  ChevronDown,
  ChevronRight,
  Facebook,
  Instagram,
  Linkedin,
  Twitter,
  Upload,
} from "lucide-react";
import { ContentFullscreenModal } from "@/components/modals";
import { SocialPostCard } from "@/components/content-cards";
import {
  ContentCreatorBody,
  ContentCreatorComposer,
  ContentCreatorHeader,
  ContentCreatorShell,
  ContentCreatorStage,
  CreatorResultsPane,
} from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";
import { SocialPublisher } from "@/components/social-publishing/SocialPublisher";

interface GeneratedPost {
  id: string;
  title: string;
  content: string;
  platform: string;
  hashtags?: string[];
  createdAt: number;
  category?: string;
  tone?: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoUrls?: string[];
  imagePrompt?: string;
  videoPrompt?: string;
  imageError?: boolean;
  videoError?: boolean;
  /** False when a saved prompt was never queued; undefined for fresh in-session requests. */
  imagePending?: boolean;
  videoPending?: boolean;
  mediaErrors?: { image?: string; video?: string };
}

type CompanionKind = "image" | "video";

/** Whether a post's companion image/video is still generating, failed, or neither. */
export function companionMediaState(post: GeneratedPost, kind: CompanionKind): "generating" | "failed" | undefined {
  const url = kind === "video" ? post.videoUrl || post.videoUrls?.[0] : post.imageUrl || post.imageUrls?.[0];
  const prompt = kind === "video" ? post.videoPrompt : post.imagePrompt;
  if (url || !prompt) return undefined;
  if (kind === "video" ? post.videoError : post.imageError) return "failed";
  if ((kind === "video" ? post.videoPending : post.imagePending) === false) return undefined;
  return "generating";
}

function savedMediaGeneration(performance: unknown, kind: CompanionKind): { pending: boolean; failed: boolean; error?: string } {
  const generation = performance && typeof performance === "object" ? (performance as { mediaGeneration?: Record<string, { status?: string; error?: string } | undefined> }).mediaGeneration : undefined;
  const state = generation?.[kind];
  return {
    pending: ["queued", "processing", "pending"].includes(state?.status || ""),
    failed: state?.status === "failed",
    error: state?.status === "failed" ? state.error : undefined,
  };
}

const PLATFORMS = [
  { value: "all", label: "All platforms · 4 separate variants", icon: Share2 },
  { value: "facebook", label: "Facebook", icon: Facebook },
  { value: "instagram", label: "Instagram", icon: Instagram },
  { value: "linkedin", label: "LinkedIn", icon: Linkedin },
  { value: "twitter", label: "Twitter/X", icon: Twitter },
];

const POST_TYPES = [
  { value: "promotional", label: "Promotional" },
  { value: "engagement", label: "Engagement" },
  { value: "educational", label: "Educational" },
  { value: "entertaining", label: "Entertaining" },
  { value: "inspirational", label: "Inspirational" },
  { value: "announcement", label: "Announcement" },
  { value: "behind-the-scenes", label: "Behind the Scenes" },
];

const TONES = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "friendly", label: "Friendly" },
  { value: "humorous", label: "Humorous" },
  { value: "inspirational", label: "Inspirational" },
  { value: "urgent", label: "Urgent" },
  { value: "formal", label: "Formal" },
];

export default function SocialCreator() {
  const scope = useCreatorScope();
  useContentLibraryRefresh(scope.refreshKey ?? 0, () => { void loadPosts(); });
  const refreshContent = useRefreshContentLibrary();
  const generationContext = creatorGenerationContext(scope);
  const router = useRouter();
  const [initialScheduledDate, setInitialScheduledDate] = useState<string | undefined>();
  useEffect(() => { const date = new URLSearchParams(window.location.search).get('date'); if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setInitialScheduledDate(date); }, []);
  const { toast } = useToast();
  const { brandToolkitId, businessProfileId, missingMessage } = useContentBrandContext();
  const { subscribe } = useWebSocket();

  // Generation settings
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt("social");
  const [mediaGeneration, setMediaGeneration] = useState<CompanionMedia>({ image: false, video: false });
  const [searchQuery, setSearchQuery] = useState("");
  const [platform, setPlatform] = useState("linkedin");
  const [submittedPlatform, setSubmittedPlatform] = useState("linkedin");
  const [postType, setPostType] = useState("engagement");
  const [tone, setTone] = useState("friendly");
  const [includeHashtags, setIncludeHashtags] = useState(true);
  const [includeEmojis, setIncludeEmojis] = useState(true);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [referenceImagePreview, setReferenceImagePreview] = useState<string | null>(null);
  const [referenceImageMimeType, setReferenceImageMimeType] = useState<"image/jpeg" | "image/png" | "image/webp">("image/jpeg");
  const referenceImageInputRef = useRef<HTMLInputElement>(null);

  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [posts, setPosts] = useState<GeneratedPost[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [previewPost, setPreviewPost] = useState<GeneratedPost | null>(null);
  const [currentPost, setCurrentPost] = useState<GeneratedPost | null>(null);
  const [publishAssetId, setPublishAssetId] = useState<number | null>(null);

  // Manual Creation States
  const [generationMode, setGenerationMode] = useState<"ai" | "manual">("ai");
  const [manualTitle, setManualTitle] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualContent, setManualContent] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [filePreviews, setFilePreviews] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const manualSavingRef = useRef(false);
  const manualDraftRef = useRef<{ id: number; payload: string; uploads: Map<File, string>; uncertainFile: File | null } | null>(null);
  const [manualDraftId, setManualDraftId] = useState<number | null>(null);
  const [manualSaveError, setManualSaveError] = useState<string | null>(null);
  const [manualCreateUnconfirmed, setManualCreateUnconfirmed] = useState(false);
  const [manualRecoveredKey, setManualRecoveredKey] = useState('');
  const manualStorageKey = `asksales:social-manual:${creatorSessionScope()}:${creatorDraftScope(scope)}`;
  useEffect(() => {
    setManualTitle(''); setManualDescription(''); setManualContent(''); setManualDraftId(null);
    setManualCreateUnconfirmed(false); manualDraftRef.current = null;
    setSelectedFiles([]); setFilePreviews([]);
    try {
      const stored = JSON.parse(sessionStorage.getItem(manualStorageKey) || 'null');
      if (stored) {
        setManualTitle(stored.title || ''); setManualDescription(stored.description || ''); setManualContent(stored.content || '');
        setManualCreateUnconfirmed(stored.unconfirmed === true);
        if (Number.isSafeInteger(stored.id) && stored.id > 0) { setManualDraftId(stored.id); manualDraftRef.current = { id: stored.id, payload: '', uploads: new Map(), uncertainFile: null }; }
      }
    } catch { /* session storage optional */ }
    setManualRecoveredKey(manualStorageKey);
  }, [manualStorageKey]);
  useEffect(() => {
    if (manualRecoveredKey !== manualStorageKey) return;
    try { sessionStorage.setItem(manualStorageKey, JSON.stringify({ title: manualTitle, description: manualDescription, content: manualContent, id: manualDraftId, unconfirmed: manualCreateUnconfirmed })); } catch { /* session storage optional */ }
  }, [manualRecoveredKey, manualStorageKey, manualTitle, manualDescription, manualContent, manualDraftId, manualCreateUnconfirmed]);

  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [libraryError, setLibraryError] = useState(false);
  const loadPosts = useCallback(async () => {
    setLoadingLibrary(true);
    setLibraryError(false);
    try {
      const assets = await api.get<Array<{
        id: number;
        title: string;
        content: string;
        channel?: string | null;
        imageUrl?: string | null;
        imageUrls?: string[] | null;
        videoUrl?: string | null;
        videoUrls?: string[] | null;
        performance?: unknown;
        createdAt: string;
      }>>(creatorAssetUrl("social_post", scope));
      setPosts(assets.map((asset) => {
        let content: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(asset.content);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed as Record<string, unknown>;
        } catch {
          content = { caption: asset.content };
        }
        const caption = captionFromSocialAsset({ id: asset.id, title: asset.title || "", content: asset.content });
        const hashtags = Array.isArray(content.hashtags)
          ? content.hashtags.filter((value): value is string => typeof value === "string").map((tag) => tag.replace(/^#/, ""))
          : (caption.match(/#\w+/g) || []).map((tag) => tag.substring(1));
        return {
          id: `db-${asset.id}`,
          title: asset.title || "Generated Post",
          content: caption,
          platform: String(content.platform || asset.channel || "all"),
          hashtags,
          createdAt: new Date(asset.createdAt).getTime(),
          imagePrompt: typeof content.imagePrompt === "string" ? content.imagePrompt : undefined,
          videoPrompt: typeof content.videoPrompt === "string" ? content.videoPrompt : undefined,
          imageUrl: asset.imageUrl || asset.imageUrls?.[0] || (typeof content.imageUrl === "string" ? content.imageUrl : undefined),
          imageUrls: asset.imageUrls || (Array.isArray(content.imageUrls) ? content.imageUrls.filter((url): url is string => typeof url === "string") : undefined),
          videoUrl: asset.videoUrl || asset.videoUrls?.[0] || (typeof content.videoUrl === "string" ? content.videoUrl : undefined),
          videoUrls: asset.videoUrls || (Array.isArray(content.videoUrls) ? content.videoUrls.filter((url): url is string => typeof url === "string") : undefined),
          ...(() => {
            const image = savedMediaGeneration(asset.performance, "image");
            const video = savedMediaGeneration(asset.performance, "video");
            return {
              imagePending: image.pending, videoPending: video.pending,
              imageError: image.failed, videoError: video.failed,
              mediaErrors: { image: image.error, video: video.error },
            };
          })(),
        };
      }));
    } catch (error) {
      setLibraryError(true);
      console.error("Error loading social posts:", error);
    } finally {
      setLoadingLibrary(false);
    }
  }, []);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  const filePreviewsRef = useRef(filePreviews);
  useEffect(() => { filePreviewsRef.current = filePreviews; }, [filePreviews]);
  useEffect(() => () => {
    filePreviewsRef.current.forEach((url) => {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    });
  }, []);
  const moveCarouselItem = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= selectedFiles.length) return;
    const files = [...selectedFiles]; const previews = [...filePreviews];
    [files[index], files[target]] = [files[target], files[index]];
    [previews[index], previews[target]] = [previews[target], previews[index]];
    setSelectedFiles(files); setFilePreviews(previews);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    const uploadError = files.map(creatorUploadError).find(Boolean);
    if (uploadError) { toast({ title: "Cannot upload file", description: uploadError, variant: "destructive" }); return; }
    const videos = files.filter((file) => file.type.startsWith("video/"));
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (videos.length > 0 && (videos.length > 1 || images.length > 0)) {
      toast({ title: "Choose one video or up to 10 images", description: "Videos and carousel images cannot be mixed in this creator.", variant: "destructive" });
      return;
    }
    const accepted = videos.length ? [videos[0]] : images.slice(0, 10);
    filePreviews.forEach((url) => URL.revokeObjectURL(url));
    setSelectedFiles(accepted);
    setFilePreviews(accepted.map((file) => URL.createObjectURL(file)));
  };

  const handleReferenceImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast({ title: "Unsupported reference image", description: "Upload a JPEG, PNG, or WebP image.", variant: "destructive" });
      event.target.value = "";
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "Reference image is too large", description: "Choose an image smaller than 10 MB.", variant: "destructive" });
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      setReferenceImagePreview(dataUrl);
      setReferenceImage(dataUrl.split(",")[1] || null);
      setReferenceImageMimeType(file.type as "image/jpeg" | "image/png" | "image/webp");
    };
    reader.readAsDataURL(file);
  };

  const removeReferenceImage = () => {
    setReferenceImage(null);
    setReferenceImagePreview(null);
    setReferenceImageMimeType("image/jpeg");
    if (referenceImageInputRef.current) referenceImageInputRef.current.value = "";
  };

  const handleSaveManualPost = async () => {
    if (manualSavingRef.current || manualCreateUnconfirmed) return;
    if (!manualContent.trim()) {
      toast({ title: "Content is required", variant: "destructive" });
      return;
    }
    manualSavingRef.current = true;
    setIsSubmitting(true);
    setManualSaveError(null);
    try {
      // Step 1: Create Content Asset
      const isVideo = selectedFiles.length === 1 && selectedFiles[0].type.startsWith("video/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assetPayload: Record<string, any> = {
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
        type: "social_post",
        title: manualTitle || `Custom social post`,
        content: JSON.stringify({ caption: manualContent, platform, origin: "manual" }),
        channel: platform,
        status: "draft",
        metadata: {
          origin: "manual",
          description: manualDescription.trim() || null,
          postType: selectedFiles.length > 1 ? "carousel" : isVideo ? "video" : "feed",
          tags: [],
          platforms: [platform]
        }
      };

      const fingerprint = JSON.stringify(assetPayload);
      if (!manualDraftRef.current) {
        try {
          const created = await api.post<{ id: number }>("/api/content/assets", assetPayload);
          if (!Number.isSafeInteger(created?.id) || created.id <= 0) throw new Error("A valid saved draft ID was not returned. Check the library before creating another post.");
          manualDraftRef.current = { id: created.id, payload: fingerprint, uploads: new Map(), uncertainFile: null };
          setManualDraftId(created.id);
        } catch (error) {
          const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
          if (status === 0 || status >= 500) setManualCreateUnconfirmed(true);
          throw error;
        }
      }
      const asset = manualDraftRef.current;
      if (asset.uncertainFile) {
        const persisted = await api.get<{ id: number; imageUrl?: string; imageUrls?: string[]; videoUrl?: string; videoUrls?: string[] }>(`/api/content/assets/${asset.id}`);
        if (persisted.id !== asset.id) throw new Error("The previous upload could not be checked. Review the saved draft in the library before retrying.");
        const urls = [...new Set([persisted.imageUrl, ...(persisted.imageUrls || []), persisted.videoUrl, ...(persisted.videoUrls || [])].filter((url): url is string => Boolean(url)))];
        const previous = new Set(asset.uploads.values());
        const recovered = urls.filter((url) => !previous.has(url));
        if (recovered.length > 1) throw new Error("The saved media changed. Review the existing draft in the library before retrying.");
        if (recovered[0]) asset.uploads.set(asset.uncertainFile, recovered[0]);
        asset.uncertainFile = null;
      }
      if ([...asset.uploads.keys()].some((uploaded) => !selectedFiles.includes(uploaded))) throw new Error("Previously uploaded media is already attached to this draft. Review it in the library before replacing the files.");
      if (asset.payload !== fingerprint) {
        const updated = await api.put<{ id: number }>(`/api/content/assets/${asset.id}`, assetPayload);
        if (updated?.id !== asset.id) throw new Error("The draft update was not confirmed. Retry to update the same draft.");
        asset.payload = fingerprint;
      }

      // Step 2: Upload file if selected
      const uploadedImageUrls: string[] = [];
      let uploadedVideoUrl: string | undefined;
      if (selectedFiles.length > 0 && asset.id) {
        try {
          for (const file of selectedFiles) {
            const formData = new FormData();
            const mediaType = file.type.startsWith("video/") ? "video" : "image";
            formData.append("file", file);
            formData.append("assetId", String(asset.id));
            formData.append("mediaType", mediaType);
            let url = asset.uploads.get(file);
            if (!url) {
              try {
                const uploadedMedia = await api.postForm<{ success?: boolean; url?: string; asset?: { id: number } }>("/api/content/assets/upload", formData);
                if (uploadedMedia.success === false || !uploadedMedia.url || (uploadedMedia.asset && uploadedMedia.asset.id !== asset.id)) throw new Error(`${mediaType} upload did not return a confirmed URL`);
                url = uploadedMedia.url;
                asset.uploads.set(file, url);
              } catch (error) {
                const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
                if (status === 0 || status >= 500) asset.uncertainFile = file;
                throw error;
              }
            }
            if (mediaType === "image") uploadedImageUrls.push(url);
            else uploadedVideoUrl = url;
          }
        } catch (uploadError) {
          throw uploadError;
        }
      }

      toast({ title: "Saved successfully", description: "Your post has been saved to templates!" });

      // Reset form and add new post to state
      setManualTitle("");
      setManualDescription("");
      setManualContent("");
      setSelectedFiles([]);
      setFilePreviews([]);
      manualDraftRef.current = null;
      setManualDraftId(null);

      const newPost: GeneratedPost = {
        id: `db-${asset.id}`,
        title: manualTitle || `Custom social post`,
        content: manualContent,
        platform,
        hashtags: (manualContent.match(/#\w+/g) || []).map((h: string) => h.substring(1)),
        createdAt: Date.now(),
        imageUrl: uploadedImageUrls[0],
        imageUrls: uploadedImageUrls,
        videoUrl: uploadedVideoUrl,
      };
      setPosts((prev) => [newPost, ...prev.filter((post) => post.id !== newPost.id)]);
      refreshContent();
      setCurrentPost(newPost);
    } catch (error) {
      setManualSaveError(error instanceof Error ? error.message : "Failed to save the manual post.");
      toast({
        title: manualDraftRef.current ? "Draft saved; completion needs attention" : "Draft save could not be confirmed",
        description: error instanceof Error ? error.message : "Failed to create manual post",
        variant: "destructive",
      });
    } finally {
      manualSavingRef.current = false;
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    const _unsub = subscribe('content_asset_updated', (data: { type?: string; assetId?: number; mediaType?: CompanionKind; imageUrl?: string; videoUrl?: string; error?: string }) => {
      if (data.type === 'social_post' && data.assetId) {
        if (data.error) {
          toast({ title: data.mediaType === "video" ? "Video generation failed" : data.mediaType === "image" ? "Image generation failed" : "Media generation failed", description: data.error, variant: "destructive" });
          // Only mark the media kind that failed; the other may still be generating.
          const markFailed = (p: GeneratedPost): GeneratedPost => ({
            ...p,
            ...(data.mediaType !== "video" ? { imageError: true } : {}),
            ...(data.mediaType !== "image" ? { videoError: true } : {}),
            mediaErrors: { ...p.mediaErrors, ...(data.mediaType ? { [data.mediaType]: data.error } : { image: data.error, video: data.error }) },
          });
          setPosts(prev => prev.map(p => p.id === `db-${data.assetId}` ? markFailed(p) : p));
          setCurrentPost((current) => current?.id === `db-${data.assetId}` ? markFailed(current) : current);
          return;
        }

        // Update existing posts with new media if they match
        setPosts(prev => prev.map(p => {
          if (p.id === `db-${data.assetId}` && (data.imageUrl || data.videoUrl)) {
            return { ...p, imageUrl: data.imageUrl || p.imageUrl, videoUrl: data.videoUrl || p.videoUrl };
          }
          return p;
        }));
        setCurrentPost((current) => current?.id === `db-${data.assetId}` && (data.imageUrl || data.videoUrl)
          ? { ...current, imageUrl: data.imageUrl || current.imageUrl, videoUrl: data.videoUrl || current.videoUrl }
          : current);
      }
    });
    return _unsub;
  }, [subscribe, loadPosts, toast]);

  // Keep previewPost in sync with updated posts list to show generated media
  useEffect(() => {
    if (previewPost) {
      const updated = posts.find((p) => p.id === previewPost.id);
      if (updated) {
        setPreviewPost(updated);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, previewPost?.id]);

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
    setSubmittedPlatform(platform);
    setGenerationError(undefined);
    setIsGenerating(true);
    try {
      // Generate exactly the prompt the user reviewed. Enhancement is an explicit action.
      const enhancedPrompt = prompt;

      const fullPrompt = `${enhancedPrompt}\n\nPost type: ${postType}\nTone: ${tone}${includeHashtags ? "\nInclude relevant hashtags" : ""}${includeEmojis ? "\nInclude emojis" : ""}`;

      const destinations = platform === "all" ? ["facebook", "instagram", "linkedin", "twitter"] : [platform];
      for (const destination of destinations) {
      const response = await api.post<{
        success: boolean;
        content?: string;
        assetId?: number;
        imagePrompt?: string;
        videoPrompt?: string;
        caption?: string;
        callToAction?: string;
        hashtags?: string[];
        error?: string;
        mediaGeneration?: { imageQueued: boolean; videoQueued: boolean; warnings: string[] };
      }>("/api/content/studio/social", {
        prompt: fullPrompt,
        platform: destination,
        postType,
        mediaGeneration,
        ...(referenceImage ? { referenceImage: { base64Data: referenceImage, mimeType: referenceImageMimeType } } : {}),
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      });

      if (response.success && response.content) {
        if (!Number.isSafeInteger(response.assetId) || Number(response.assetId) <= 0) {
          throw new Error("Generation returned without a confirmed saved draft. Check the library before generating again.");
        }
        const newPost: GeneratedPost = {
          id: response.assetId ? `db-${response.assetId}` : `gen-${Date.now()}`,
          title: `${destination} post`,
          content: captionFromSocialAsset({ id: Number(response.assetId), title: "Generated Post", content: JSON.stringify({ caption: response.caption || response.content, callToAction: response.callToAction, hashtags: response.hashtags }) }),
          platform: destination,
          hashtags: response.hashtags || (response.content.match(/#\w+/g) || []).map((h: string) => h.substring(1)),
          createdAt: Date.now(),
          imagePrompt: response.mediaGeneration?.imageQueued ? response.imagePrompt : undefined,
          videoPrompt: response.mediaGeneration?.videoQueued ? response.videoPrompt : undefined,
        };
        setPosts((prev) => prependUniqueById([newPost], prev));
        refreshContent();
      setCurrentPost(newPost);
        if (response.mediaGeneration?.warnings.length) toast({ title: "Draft saved; media needs attention", description: response.mediaGeneration.warnings.join(". "), variant: "destructive" });
        toast({ title: "Draft saved", description: `${destination} post generated.` });
      } else {
        throw new Error(response.error || `Could not generate ${destination}. Completed variants remain in Recent.`);
      }
      }
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Generation failed. Try again.");
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate post",
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
        contentType: "social",
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
    setPosts((prev) => prev.filter((p) => p.id !== id));
    setCurrentPost((current) => current?.id === id ? null : current);
    setPreviewPost((current) => current?.id === id ? null : current);
    toast({ title: "Deleted", description: "Social post removed" });
  };

  const handleDownload = (post: GeneratedPost) => {
    const blob = new Blob([post.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `social-post-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const filteredPosts = posts.filter((post) => `${post.title} ${post.content} ${post.platform}`.toLowerCase().includes(searchQuery.toLowerCase()));
  const activePost = currentPost;
  const activePostMedia = buildContentMedia({
    imageUrl: activePost?.imageUrl,
    imageUrls: activePost?.imageUrls,
    videoUrl: activePost?.videoUrl,
    videoUrls: activePost?.videoUrls,
  });
  const manualMediaItems = filePreviews.map((url, index) => ({
    url,
    type: selectedFiles[index]?.type.startsWith("video/") ? "video" as const : "image" as const,
  }));
  const socialPreview: CreatorPreviewModel = {
    format: "social",
    status: generationMode === "manual" ? "draft" : isGenerating ? "generating" : generationError ? "failed" : activePost ? "ready" : "empty",
    submittedPrompt,
    error: generationMode === "manual" ? undefined : generationError,
    title: generationMode === "manual" ? manualTitle : activePost?.title,
    caption: generationMode === "manual" ? manualContent : (activePost?.content || ""),
    hashtags: generationMode === "manual" ? [] : activePost?.hashtags,
    platform: generationMode === "manual" ? platform : (isGenerating || generationError) ? submittedPlatform : activePost?.platform,
    mediaItems: generationMode === "manual" ? manualMediaItems : activePostMedia.items,
    // The caption arrives first; show that the companion media is still on its way.
    pendingMedia: generationMode === "manual" || !activePost || isGenerating ? undefined : (["video", "image"] as const).flatMap((kind) => {
      const state = companionMediaState(activePost, kind);
      return state ? [{ kind, status: state, error: activePost.mediaErrors?.[kind], startedAt: new Date(activePost.createdAt).toISOString() }] : [];
    }),
  };

  return (
    <ContentCreatorShell>
      {/* Header */}
      <ContentCreatorHeader>
        <div className="mb-3">
          <button onClick={() => router.push("/dashboard/saved-templates/social")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Social media posts
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
              <Share2 className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Social post generation</h1>
              <p className="text-sm text-muted-foreground">Create engaging social media posts with AI</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input aria-label="Search recent social posts" placeholder="Search recent posts…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} className="h-9 min-w-0 rounded-md border border-border bg-background px-3 text-sm" />
            <Button type="button" variant="outline" size="sm" onClick={() => void loadPosts()}>Refresh</Button>
          </div>
        </div>
      </ContentCreatorHeader>

      {/* Main Content - Split Panel */}
      <ContentCreatorBody recentCount={posts.length}>
        {/* Left Panel - Generation Controls */}
        <ContentCreatorComposer>
          <div className="flex-1 space-y-5 p-4 sm:p-5">
            {/* Mode Switcher */}
            <div className="flex border-b pb-2">
              <button
                onClick={() => setGenerationMode("ai")}
                className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors ${
                  generationMode === "ai"
                    ? "border-primary text-primary font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                AI generator
              </button>
              <button
                onClick={() => setGenerationMode("manual")}
                className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors ${
                  generationMode === "manual"
                    ? "border-primary text-primary font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                Custom Post
              </button>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium">Destination platform</Label>
              <Select value={platform} onValueChange={setPlatform}>
                <SelectTrigger className="h-9" aria-label="Destination platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {generationMode === "manual" ? (
              <fieldset disabled={isSubmitting} className="space-y-4">
                {/* Title */}
                <div className="space-y-2">
                  <Label htmlFor="manual-social-title" className="text-xs font-medium">Post Title (Optional)</Label>
                  <input
                    id="manual-social-title"
                    type="text"
                    placeholder="Enter post title..."
                    value={manualTitle}
                    onChange={(e) => setManualTitle(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="manual-social-description" className="text-xs font-medium">Description (Optional)</Label>
                  <input
                    id="manual-social-description"
                    type="text"
                    placeholder="Add context for teammates..."
                    value={manualDescription}
                    onChange={(e) => setManualDescription(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>

                {/* Caption / Content */}
                <div className="space-y-2">
                  <Label htmlFor="manual-social-caption" className="text-xs font-medium">Post Content / Caption</Label>
                  <Textarea
                    id="manual-social-caption"
                    placeholder="Write your custom post caption here..."
                    value={manualContent}
                    onChange={(e) => setManualContent(e.target.value)}
                    rows={5}
                    className="resize-none text-sm"
                  />
                </div>

                {/* Upload Image/Video */}
                <div className="space-y-2">
                  <Label htmlFor="manual-media-upload" className="text-xs font-medium">Upload Media (Image or Video)</Label>
                  <div className="flex gap-2">
                    <input
                      type="file"
                      accept="image/*,video/*"
                      multiple
                      onChange={handleFileChange}
                      className="hidden"
                      id="manual-media-upload"
                    />
                    <label
                      htmlFor="manual-media-upload"
                      className="flex flex-1 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border/60 p-4 transition-all hover:border-primary/50 hover:bg-primary/5"
                    >
                      <Share2 className="h-6 w-6 text-muted-foreground mb-1" />
                      <span className="text-xs text-muted-foreground font-medium text-center">
                        {selectedFiles.length > 1 ? `${selectedFiles.length} carousel images selected` : selectedFiles[0]?.name || "Select up to 10 images or one video"}
                      </span>
                    </label>
                    {selectedFiles.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setSelectedFiles([]);
                          setFilePreviews([]);
                        }}
                        className="h-9 w-9 text-rose-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  {filePreviews.length > 0 && (
                    <div className={`mt-2 grid gap-2 ${filePreviews.length > 1 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1"}`}>
                      {filePreviews.map((preview, index) => (
                        <div key={preview} className="relative flex max-h-[140px] items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
                          {selectedFiles[index]?.type.startsWith("image/") ? (
                            <img src={preview} alt={`Preview ${index + 1}`} className="h-[140px] w-full object-cover" />
                          ) : (
                            <video src={preview} className="max-h-[140px] w-auto object-contain" controls />
                          )}
                          {filePreviews.length > 1 && <span className="absolute right-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white">{index + 1}</span>}
                          {filePreviews.length > 1 && <div className="absolute bottom-1 left-1 flex gap-1"><button type="button" disabled={index === 0} aria-label={`Move image ${index + 1} earlier`} onClick={() => moveCarouselItem(index, -1)} className="rounded bg-black/75 px-2 py-1 text-xs text-white disabled:opacity-40">Earlier</button><button type="button" disabled={index === filePreviews.length - 1} aria-label={`Move image ${index + 1} later`} onClick={() => moveCarouselItem(index, 1)} className="rounded bg-black/75 px-2 py-1 text-xs text-white disabled:opacity-40">Later</button></div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Submit button */}
                <Button
                  data-creator-action
                  onClick={handleSaveManualPost}
                  loading={isSubmitting}
                  loadingText="Saving Template..."
                  disabled={manualCreateUnconfirmed || !manualContent.trim()}
                  className="h-10 w-full"
                >
                  <Check className="w-4 h-4 mr-2" />
                  Save Template
                </Button>
                {manualDraftId && <p role="status" className="text-xs text-muted-foreground">Draft #{manualDraftId} already exists. Retry completes this same draft without creating another.</p>}
                {(manualSaveError || manualCreateUnconfirmed) && <p role="alert" className="text-xs text-destructive">{manualSaveError || "The previous post save could not be confirmed."}{manualCreateUnconfirmed && <> Your input is preserved. <a href="/dashboard/saved-templates/social" className="underline">Check the content library</a> before creating another post; the original request may have saved.</>}</p>}
                {manualCreateUnconfirmed && <Button type="button" variant="outline" onClick={() => { setManualCreateUnconfirmed(false); setManualSaveError(null); }}>I checked the library; try saving again</Button>}
              </fieldset>
            ) : (
              <>
                {/* Prompt */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="social-prompt" className="text-sm font-medium">Social Post Prompt</Label>
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
                    id="social-prompt"
                    placeholder="Enter a prompt for the social post you want to create. E.g., Write an Instagram launch post with a clear call-to-action..."
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    className="resize-none text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label htmlFor="social-reference-image" className="text-sm font-medium">Reference image (optional)</Label>
                      <p className="mt-1 text-xs text-muted-foreground">Used as visual guidance when AI creates the companion image.</p>
                    </div>
                    {referenceImagePreview && (
                      <Button type="button" variant="ghost" size="sm" onClick={removeReferenceImage} className="h-8 text-xs text-destructive">
                        <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
                      </Button>
                    )}
                  </div>
                  <input
                    ref={referenceImageInputRef}
                    id="social-reference-image"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleReferenceImageChange}
                    className="sr-only"
                  />
                  <label htmlFor="social-reference-image" className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-4 text-center transition-colors hover:border-primary/50 hover:bg-primary/5">
                    <Upload className="h-5 w-5 text-primary" />
                    <span className="text-xs font-medium">{referenceImagePreview ? "Replace reference image" : "Choose a reference image"}</span>
                    <span className="text-[11px] text-muted-foreground">JPEG, PNG, or WebP · up to 10 MB</span>
                  </label>
                  {referenceImagePreview && (
                    <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
                      <img src={referenceImagePreview} alt="Social post reference" className="max-h-44 w-full object-contain" />
                    </div>
                  )}
                </div>

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
                    {/* Post Type */}
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">Post Type</Label>
                      <Select value={postType} onValueChange={setPostType}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {POST_TYPES.map((type) => (
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

                {enhancementReview}
                <CompanionMediaOptions value={mediaGeneration} onChange={setMediaGeneration} copies={platform === "all" ? 4 : 1} />
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
                  Generate Post
                </Button>
              </>
            )}
          </div>
        </ContentCreatorComposer>

        {/* Right Panel - Gallery */}
        <ContentCreatorStage preview={<CreatorPreview model={socialPreview} />} recentCount={filteredPosts.length} searchQuery={searchQuery}>
          <CreatorResultsPane>
          {libraryError && <Callout tone="danger" actions={<Button onClick={loadPosts} variant="outline">Retry loading posts</Button>}>Social posts could not be loaded.</Callout>}
          {loadingLibrary ? <p role="status">Loading posts…</p> : libraryError ? null : posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="p-6 rounded-2xl bg-muted/50 mb-4">
                <Share2 className="w-12 h-12 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-1">No posts yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Enter a prompt and click Generate to create your first AI social post
              </p>
            </div>
          ) : (
            <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
              {filteredPosts.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No matching posts. Try another search.</p>}
              {filteredPosts.map((post) => (
                <div key={post.id} className="relative group">
                  <SocialPostCard
                    title={post.title}
                    content={JSON.stringify({ caption: post.content, hashtags: post.hashtags, imagePrompt: post.imagePrompt, videoPrompt: post.videoPrompt })}
                    platform={post.platform}
                    createdAt={post.createdAt}
                    imageUrl={post.imageUrl}
                    imageUrls={post.imageUrls}
                    videoUrl={post.videoUrl}
                    videoUrls={post.videoUrls}
                    isGeneratingImage={companionMediaState(post, "image") === "generating"}
                    isGeneratingVideo={companionMediaState(post, "video") === "generating"}
                    mediaFailed={{ image: companionMediaState(post, "image") === "failed", video: companionMediaState(post, "video") === "failed" }}
                    onPublish={() => {
                      const parsedId = Number(post.id.replace("db-", ""));
                      if (Number.isSafeInteger(parsedId) && parsedId > 0) setPublishAssetId(parsedId);
                    }}
                    onDelete={() => handleDelete(post.id)}
                    onDownload={() => handleDownload(post)}
                  />
                </div>
              ))}
            </div>
          )}
          </CreatorResultsPane>
        </ContentCreatorStage>
      </ContentCreatorBody>

      {/* Full-screen Preview Dialog */}
      <ContentFullscreenModal
        open={!!previewPost}
        onOpenChange={(open) => { if (!open) setPreviewPost(null); }}
        contentType="social_post"
        title={previewPost?.title || "Social Post"}
        content={previewPost ? JSON.stringify({
          caption: previewPost.content,
          hashtags: previewPost.hashtags,
          imageUrl: previewPost.imageUrl,
          imageUrls: previewPost.imageUrls,
        }) : ""}
        platform={previewPost?.platform || "all"}
        createdAt={previewPost?.createdAt}
        imageUrl={previewPost?.imageUrl}
        imageUrls={previewPost?.imageUrls}
        imagePrompt={previewPost?.imagePrompt}
        videoPrompt={previewPost?.videoPrompt}
        customActions={previewPost ? (
          <>
            <Button variant="outline" size="sm" onClick={() => handleDownload(previewPost)}>
              <Download className="h-4 w-4 mr-1" />
              Download
            </Button>
          </>
        ) : null}
      />
      {publishAssetId && <SocialPublisher initialScheduledDate={initialScheduledDate} assetId={publishAssetId} open={Boolean(publishAssetId)} onOpenChange={(nextOpen) => { if (!nextOpen) setPublishAssetId(null); }} onPublished={() => void loadPosts()} />}
    </ContentCreatorShell>
  );
}
