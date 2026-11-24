"use client";

import { useState, useMemo } from "react";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { copyText } from "@/components/ui/copy-button";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Video,
  RefreshCw,
  Wand2,
  ChevronRight,
  Play,
  Download,
  Trash2,
  Copy,
  Check,
  Maximize2,
  Calendar,
  AlertCircle,
} from "lucide-react";
import { normalizeUploadUrl } from "@/lib/utils";
import { markdownToPreviewText } from "@/lib/markdownPreview";
import { usePaginatedContentAssets } from "@/hooks/use-paginated-content-assets";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import api from "@/lib/api";
import { SocialPublisher } from '@/components/social-publishing/SocialPublisher';
import { MediaGenerationPlaceholder, isMediaGenerating } from "@/components/content-studio/MediaGenerationPlaceholder";
import { extractPrompt, extractStyle } from "@/lib/saved-media-fields";

interface MediaAsset {
  id: number;
  type: string;
  title: string;
  content: string;
  channel: string;
  videoUrl?: string;
  videoUrls?: string[];
  status?: string;
  prompt?: string;
  createdAt: string;
  performance?: Record<string, unknown>;
  lastError?: string | null;
}

const STALE_FAILURE_MS = 15 * 60_000;

/** A failed media job can leave its placeholder asset "pending"; trust the job record. */
function videoFailure(asset: MediaAsset): string | null {
  if (asset.status?.toLowerCase() === "failed") return asset.lastError || "Video generation failed.";
  const generation = asset.performance?.mediaGeneration as { video?: { status?: string; error?: string; updatedAt?: string } } | undefined;
  const video = generation?.video;
  if (video?.status !== "failed") return null;
  // A retry rewrites this record within minutes; only a failure left alone this long is final.
  const failedAt = video.updatedAt ? new Date(video.updatedAt).getTime() : 0;
  return Date.now() - failedAt > STALE_FAILURE_MS ? video.error || "Video generation failed." : null;
}

function extractVideoUrl(asset: MediaAsset): string {
  if (asset.videoUrl) return normalizeUploadUrl(asset.videoUrl);
  if (asset.videoUrls && asset.videoUrls.length > 0) return normalizeUploadUrl(asset.videoUrls[0]);

  const content = asset.content || "";
  try {
    const parsed = JSON.parse(content);
    const parsedUrl = parsed && typeof parsed === "object"
      ? (parsed.videoUrl || parsed.url)
      : undefined;
    return typeof parsedUrl === "string" ? normalizeUploadUrl(parsedUrl) : "";
  } catch {
    // content might be a direct URL
  }
  if (content.startsWith("http") || content.startsWith("/")) {
    return normalizeUploadUrl(content);
  }
  return "";
}

function extractDuration(asset: MediaAsset): string {
  const perf = asset.performance || {};
  return typeof perf.duration === "string" || typeof perf.duration === "number"
    ? String(perf.duration)
    : "";
}

function extractResolution(asset: MediaAsset): string {
  const perf = asset.performance || {};
  return typeof perf.resolution === "string" ? perf.resolution : "";
}

export default function VideoPage() {
  const router = useRouter();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [publishAssetId, setPublishAssetId] = useState<number | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [previewItem, setPreviewItem] = useState<{ url: string; prompt: string; title: string } | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [mediaErrors, setMediaErrors] = useState<Set<number>>(() => new Set());

  const {
    assets: videoAssets,
    total,
    isLoading: loadingVideos,
    isFetching: fetchingVideos,
    isError,
    refetch: refetchVideos,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = usePaginatedContentAssets<MediaAsset>({
    queryKey: "media-videos",
    type: "video",
    search: searchQuery,
  });

  const filteredVideos = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return videoAssets
      .map((a) => ({
        ...a,
        _url: extractVideoUrl(a),
        _prompt: extractPrompt(a),
        _style: extractStyle(a),
        _duration: extractDuration(a),
        _resolution: extractResolution(a),
        _failure: extractVideoUrl(a) ? null : videoFailure(a),
      }))
      .map((a) => ({ ...a, _generating: !a._url && !a._failure && isMediaGenerating(a.status) }))
      .filter((a) => (a._url || a._generating || a._failure) && (a.title.toLowerCase().includes(q) || a._prompt.toLowerCase().includes(q)));
  }, [videoAssets, searchQuery]);

  const handleDeleteAsset = async (id: number) => {
    setDeleting(true);
    try {
      await api.delete(`/api/content/assets/${id}`);
      queryClient.invalidateQueries({ queryKey: ["media-videos"] });
      toast({ title: "Asset deleted" });
    } catch {
      toast({ title: "Failed to delete asset", variant: "destructive" });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleCopyPrompt = async (id: number, prompt: string) => {
    try {
      await copyText(prompt);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
      toast({ title: "Copied", description: "Prompt copied to clipboard" });
    } catch {
      toast({ title: "Unable to copy prompt", variant: "destructive" });
    }
  };

  const handleDownload = (url: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `video-${Date.now()}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="px-4 py-4 sm:px-6">
          <div className="mb-3">
            <button onClick={() => router.push("/dashboard/saved-templates")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Content library
            </button>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
                <Video className="h-5 w-5 text-foreground" />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-semibold">Video gallery</h1>
                <p className="text-muted-foreground text-sm">
                  {total} {total === 1 ? "video" : "videos"} — AI-generated videos
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-end sm:self-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchVideos()}
                disabled={fetchingVideos}
                className="gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${fetchingVideos ? "animate-spin" : ""}`} /> Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => router.push("/dashboard/saved-templates/video/generate")}
                className="gap-2"
              >
                <Wand2 className="w-4 h-4" /> Generate Video
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="border-b px-4 py-3 sm:px-6">
        <SearchInput
          aria-label="Search videos"
          placeholder="Search by prompt or title..."
          value={searchQuery}
          onValueChange={setSearchQuery}
          wrapperClassName="w-full sm:max-w-sm"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {loadingVideos ? (
          <MasonryGrid columns={4}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-xl bg-muted animate-pulse overflow-hidden">
                <div className="aspect-video" />
                <div className="p-3 space-y-2">
                  <div className="h-3 bg-muted-foreground/20 rounded w-3/4" />
                  <div className="h-2 bg-muted-foreground/10 rounded w-1/2" />
                </div>
              </div>
            ))}
          </MasonryGrid>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-16 text-center">
            <AlertCircle className="mb-3 h-9 w-9 text-destructive" />
            <h3 className="font-semibold">Couldn&apos;t load your videos</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">Check your connection and try again. Your saved videos have not been changed.</p>
            <Button className="mt-4" variant="outline" onClick={() => refetchVideos()}>Try again</Button>
          </div>
        ) : filteredVideos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="p-5 rounded-2xl bg-muted/50 mb-4">
              <Video className="h-10 w-10 text-muted-foreground/50" />
            </div>
            <h3 className="font-semibold text-lg mb-1">
              {searchQuery ? "No videos match your search" : "No videos yet"}
            </h3>
            <p className="text-muted-foreground text-sm mb-4 max-w-sm">
              {searchQuery
                ? "Try adjusting your search terms"
                : "Generate your first AI video to get started"}
            </p>
            {!searchQuery && (
              <Button
                onClick={() => router.push("/dashboard/saved-templates/video/generate")}
                variant="outline"
                className="gap-2"
              >
                <Wand2 className="w-4 h-4" /> Generate Video
              </Button>
            )}
          </div>
        ) : (
          <>
            <MasonryGrid columns={4}>
              {filteredVideos.map((a) => (
              <div
                key={a.id}
                className="group flex h-full min-h-[290px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
              >
                <div className="h-1 w-full bg-primary" />
                {/* Video thumbnail */}
                <div className="relative aspect-video overflow-hidden border-b border-border bg-muted">
                  {a._generating ? (
                    <MediaGenerationPlaceholder kind="video" compact className="h-full min-h-0" />
                  ) : a._failure ? (
                    <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
                      <AlertCircle className="h-6 w-6 text-destructive" />
                      <span className="text-xs font-medium text-foreground">Video generation failed</span>
                      <span className="text-[11px]">The provider did not confirm this video. Delete this card and generate it again.</span>
                      <Button type="button" variant="outline" size="sm" className="mt-1 h-7 text-xs" onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: a.id, title: a.title }); }}>
                        <Trash2 className="mr-1 h-3 w-3" />Delete
                      </Button>
                    </div>
                  ) : mediaErrors.has(a.id) ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
                      <AlertCircle className="h-6 w-6" />
                      <span className="text-xs">Preview unavailable</span>
                    </div>
                  ) : (
                    <video
                      src={a._url}
                      aria-label={`Preview of ${a.title}`}
                      className="h-full w-full object-cover"
                      muted
                      preload="metadata"
                      onError={() => setMediaErrors((current) => new Set(current).add(a.id))}
                    />
                  )}
                  {/* Play button overlay */}
                  {a._url && <div className="absolute inset-0 flex items-center justify-center">
                    <div className="p-3 rounded-full bg-black/50 group-hover:bg-black/70 transition-colors group-hover:scale-110 transform">
                      <Play className="h-6 w-6 text-white fill-white" />
                    </div>
                  </div>}
                  {/* Hover overlay */}
                  {a._url && <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" />}
                  {a._url && <div className="absolute bottom-0 left-0 right-0 p-3 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCopyPrompt(a.id, a._prompt); }}
                        className="p-1.5 rounded-lg bg-white/90 hover:bg-white text-black transition-colors"
                        title="Copy prompt"
                        aria-label={`Copy prompt for ${a.title}`}
                      >
                        {copiedId === a.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDownload(a._url); }}
                        className="p-1.5 rounded-lg bg-white/90 hover:bg-white text-black transition-colors"
                        title="Download"
                        aria-label={`Download ${a.title}`}
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPreviewItem({ url: a._url, prompt: a._prompt, title: a.title }); }}
                        className="p-1.5 rounded-lg bg-white/90 hover:bg-white text-black transition-colors"
                        title="Preview"
                        aria-label={`Preview ${a.title}`}
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: a.id, title: a.title }); }}
                        className="p-1.5 rounded-lg bg-red-500/90 hover:bg-red-500 text-white transition-colors ml-auto"
                        title="Delete"
                        aria-label={`Delete ${a.title}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>}
                  {/* Badges */}
                  <div className="absolute top-2 right-2 flex gap-1.5">
                    {a._duration && (
                      <Badge className="text-xs bg-black/60 text-white border-0 backdrop-blur-sm">
                        {a._duration}s
                      </Badge>
                    )}
                    {a._resolution && (
                      <Badge className="text-xs bg-black/60 text-white border-0 backdrop-blur-sm">
                        {a._resolution}
                      </Badge>
                    )}
                    {a._style && (
                      <Badge className="text-xs bg-black/60 text-white border-0 backdrop-blur-sm">
                        {a._style}
                      </Badge>
                    )}
                  </div>
                </div>
                {/* Info */}
                <div className="flex flex-1 flex-col p-4">
                  <p className="mb-2 line-clamp-2 text-sm font-semibold leading-5">{a.title}</p>
                  {a._generating && <Badge variant="outline" className="mb-2 w-fit text-[10px]">Generating</Badge>}
                  {a._failure && <Badge variant="destructive" className="mb-2 w-fit text-[10px]">Failed</Badge>}
                  {a._prompt ? (
                    <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{markdownToPreviewText(a._prompt)}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground/50 italic">No prompt</p>
                  )}
                  <div className="mt-auto flex items-center gap-2 pt-3">
                    <Calendar className="w-3 h-3 text-muted-foreground/50" />
                    <span className="text-xs text-muted-foreground/60">
                      {new Date(a.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <Button variant="outline" size="sm" className="mt-3" disabled={!a._url || a._generating} onClick={() => setPublishAssetId(a.id)}>Publish / schedule on YouTube</Button>
                </div>
              </div>
              ))}
            </MasonryGrid>
            {hasNextPage && (
              <div className="flex justify-center pt-6">
                <Button variant="outline" onClick={() => fetchNextPage()} loading={isFetchingNextPage} loadingText="Loading videos…">
                  Load more videos
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {publishAssetId !== null && <SocialPublisher assetId={publishAssetId} initialPlatform="youtube" open onOpenChange={open => { if (!open) setPublishAssetId(null); }} onPublished={() => { void refetchVideos(); void queryClient.invalidateQueries({ queryKey: ['content-calendar'] }); }} />}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this video?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `“${deleteTarget.title}” will be removed from your content library and cannot be recovered.` : "This video will be permanently removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                if (deleteTarget) void handleDeleteAsset(deleteTarget.id);
              }}
            >
              {deleting && <Spinner label={null} className="mr-2" />}
              Delete video
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preview Dialog */}
      <Dialog open={!!previewItem} onOpenChange={() => setPreviewItem(null)}>
        <DialogContent className="max-h-[92svh] max-w-4xl overflow-auto p-0">
          {previewItem && (
            <div className="flex flex-col">
              <DialogTitle className="sr-only">Preview {previewItem.title}</DialogTitle>
              <DialogDescription className="sr-only">Preview the generated video and its prompt.</DialogDescription>
              <div className="relative flex min-h-[240px] items-center justify-center bg-black sm:min-h-[400px] max-h-[70vh]">
                <video
                  src={previewItem.url}
                  controls
                  autoPlay
                  className="max-w-full max-h-[70vh]"
                />
              </div>
              <div className="p-4 space-y-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="break-words font-medium">{previewItem.title}</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleCopyPrompt(0, previewItem.prompt)}>
                      <Copy className="h-4 w-4 mr-1" />
                      Copy Prompt
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload(previewItem.url)}>
                      <Download className="h-4 w-4 mr-1" />
                      Download
                    </Button>
                  </div>
                </div>
                {previewItem.prompt && (
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Generation Prompt:</p>
                    <p className="text-sm text-foreground">{previewItem.prompt}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
