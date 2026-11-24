'use client';

import { useState, useRef, useCallback, useLayoutEffect, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { normalizeUploadUrl } from '@/lib/utils';
import { creatorUploadError } from '@/lib/creator-upload';
import api from '@/lib/api';
import { savedContentAssetId, requireAttachedMediaReceipt, attachedVideoOutcome } from '@/lib/content-asset-identity';
import {
  X, Download, Upload, Wand2, ChevronLeft, ChevronRight, ImagePlus, VideoIcon, Plus, Sparkles,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface MediaManagerProps {
  images: string[];
  videos: string[];
  assetId: string; // e.g. "db-123" — we strip prefix for API calls
  onMediaChange: (images: string[], videos: string[]) => void;
  threadId?: number;
}

interface GenerateImageResponse {
  success: boolean;
  imageUrl?: string;
  assetId?: number;
  persisted?: boolean;
  error?: string;
}

interface GenerateVideoResponse {
  success: boolean;
  videoUrl?: string;
  assetId?: number;
  persisted?: boolean;
  operationName?: string;
  error?: string;
}

interface UploadResponse {
  success: boolean;
  url?: string;
  error?: string;
}

type MediaType = 'image' | 'video';
interface MediaItem { type: MediaType; url: string; key: string; number: number }
interface MediaSnapshot { assetId: string; images: string[]; videos: string[]; selectedKey: string | null }
interface MediaChange { action: 'add' | 'remove'; type: MediaType; url: string }

// ─── Helpers ────────────────────────────────────────────────────────────────────

function mediaItems(images: string[], videos: string[]): MediaItem[] {
  const items = (urls: string[], type: MediaType) => {
    const occurrences = new Map<string, number>();
    return urls.map((url, index) => {
      const occurrence = occurrences.get(url) || 0;
      occurrences.set(url, occurrence + 1);
      return { type, url, key: JSON.stringify([type, url, occurrence]), number: index + 1 };
    });
  };
  return [...items(images, 'image'), ...items(videos, 'video')];
}

function applyMediaChange(media: { images: string[]; videos: string[] }, change: MediaChange) {
  const field = change.type === 'image' ? 'images' : 'videos';
  const urls = media[field];
  const nextUrls = change.action === 'remove'
    ? urls.filter(url => url !== change.url)
    : urls.includes(change.url) ? urls : [...urls, change.url];
  return { ...media, [field]: nextUrls };
}

function reconcileSelection(assetId: string, images: string[], videos: string[], previous?: MediaSnapshot): MediaSnapshot {
  const items = mediaItems(images, videos);
  const oldIndex = previous ? mediaItems(previous.images, previous.videos).findIndex(item => item.key === previous.selectedKey) : 0;
  const selectedKey = items.find(item => item.key === previous?.selectedKey)?.key
    ?? items[Math.min(Math.max(oldIndex, 0), items.length - 1)]?.key ?? null;
  return { assetId, images, videos, selectedKey };
}

function getNumericAssetId(assetId: string): string {
  return String(savedContentAssetId(assetId));
}

function downloadMedia(url: string, filename?: string) {
  const a = document.createElement('a');
  a.href = normalizeUploadUrl(url);
  a.download = filename || url.split('/').pop() || 'media';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── Component ──────────────────────────────────────────────────────────────────

export default function MediaManager({ images, videos, assetId, onMediaChange, threadId }: MediaManagerProps) {
  const { toast } = useToast();

  const controlId = useId();
  const [media, setMedia] = useState(() => reconcileSelection(assetId, images, videos));
  // Update the ref before notifying the controlled parent, so responses in the
  // same batch merge with one another rather than a request's captured props.
  const mediaRef = useRef(media);
  const onMediaChangeRef = useRef(onMediaChange);
  const pendingChanges = useRef<MediaChange[]>([]);
  const commitMedia = useCallback((next: MediaSnapshot) => {
    mediaRef.current = next;
    setMedia(next);
  }, []);

  useLayoutEffect(() => {
    onMediaChangeRef.current = onMediaChange;
    const previous = mediaRef.current;
    if (previous.assetId !== assetId) pendingChanges.current = [];
    // Keep confirmed local changes until the parent reflects them. This also
    // tolerates delayed parent updates and unrelated refreshes while in flight.
    pendingChanges.current = pendingChanges.current.filter(change => {
      const present = (change.type === 'image' ? images : videos).includes(change.url);
      return change.action === 'add' ? !present : present;
    });
    const next = pendingChanges.current.reduce(applyMediaChange, { images, videos });
    commitMedia(reconcileSelection(assetId, next.images, next.videos, previous.assetId === assetId ? previous : undefined));
  }, [assetId, images, videos, onMediaChange, commitMedia]);

  const changeMedia = (change: MediaChange) => {
    const previous = mediaRef.current;
    pendingChanges.current = pendingChanges.current.filter(item => item.type !== change.type || item.url !== change.url);
    pendingChanges.current.push(change);
    const next = applyMediaChange(previous, change);
    const snapshot = reconcileSelection(previous.assetId, next.images, next.videos, previous);
    if (change.action === 'add') {
      snapshot.selectedKey = mediaItems(next.images, next.videos).find(item => item.type === change.type && item.url === change.url)!.key;
    }
    commitMedia(snapshot);
    onMediaChangeRef.current(next.images, next.videos);
  };

  const allMedia = mediaItems(media.images, media.videos);
  const carouselIdx = allMedia.findIndex(item => item.key === media.selectedKey);

  // Generate panel state
  const [showGenerate, setShowGenerate] = useState(false);
  const [genTab, setGenTab] = useState<'image' | 'video'>('image');
  const [genPrompt, setGenPrompt] = useState('');
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);
  const [genAspectRatio, setGenAspectRatio] = useState('1:1');
  const [genDuration, setGenDuration] = useState('5');
  const [genRefImages, setGenRefImages] = useState<{ base64Data: string; mimeType: string }[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const generationInFlight = useRef(false);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const uploadInFlight = useRef(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteInFlight = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refImageInputRef = useRef<HTMLInputElement>(null);
  const refImageButtonRef = useRef<HTMLButtonElement>(null);

  const requestEpoch = useRef(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    requestEpoch.current += 1;
    uploadInFlight.current = false;
    generationInFlight.current = false;
    deleteInFlight.current = false;
    setIsUploading(false);
    setIsGenerating(false);
    setIsDeleting(false);
    setIsEnhancingPrompt(false);
    return () => {
      mounted.current = false;
      requestEpoch.current += 1;
    };
  }, [assetId]);

  // An ID can be reused after close/reopen or A→B→A. Only the owning mount
  // and context epoch may publish a receipt, error, or loading continuation.
  const ownsRequest = (epoch: number) => mounted.current && requestEpoch.current === epoch;

  const removeReferenceImage = (index?: number) => {
    setGenRefImages(previous => index === undefined ? [] : previous.filter((_, idx) => idx !== index));
    refImageButtonRef.current?.focus();
  };

  // ─── Carousel Navigation ───────────────────────────────────────────────────

  const canPrev = carouselIdx > 0;
  const canNext = carouselIdx < allMedia.length - 1;

  const goTo = (idx: number) => {
    if (idx >= 0 && idx < allMedia.length) commitMedia({ ...mediaRef.current, selectedKey: allMedia[idx].key });
  };

  // ─── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async (type: MediaType, url: string) => {
    // The existing delete API replaces both arrays. Keep that write separate
    // from attachment requests so it cannot overwrite a just-saved attachment.
    if (deleteInFlight.current || uploadInFlight.current || generationInFlight.current) return;
    const epoch = requestEpoch.current;
    deleteInFlight.current = true;
    setIsDeleting(true);
    const { images: newImages, videos: newVideos } = applyMediaChange(mediaRef.current, { action: 'remove', type, url });

    try {
      const numId = getNumericAssetId(assetId);
      await api.put(`/api/content/assets/${numId}`, {
        imageUrl: newImages[0] || null,
        videoUrl: newVideos[0] || null,
        imageUrls: newImages.length ? newImages : null,
        videoUrls: newVideos.length ? newVideos : null,
      });
      if (!ownsRequest(epoch)) return;
      changeMedia({ action: 'remove', type, url });
      toast({ title: 'Deleted', description: 'Media removed successfully' });
    } catch {
      if (!ownsRequest(epoch)) return;
      toast({ title: 'Error', description: 'Failed to delete media', variant: 'destructive' });
    } finally {
      if (ownsRequest(epoch)) {
        deleteInFlight.current = false;
        setIsDeleting(false);
      }
    }
  };

  // ─── Download ───────────────────────────────────────────────────────────────

  const handleDownload = (url: string) => {
    downloadMedia(url);
  };

  // ─── Upload ─────────────────────────────────────────────────────────────────

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (uploadInFlight.current || deleteInFlight.current) return;
    const epoch = requestEpoch.current;
    const file = e.target.files?.[0];
    if (!file) return;
    const uploadError = creatorUploadError(file);
    if (uploadError) {
      toast({ title: 'Unsupported upload', description: uploadError, variant: 'destructive' });
      e.target.value = '';
      return;
    }

    const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
    uploadInFlight.current = true;
    setIsUploading(true);

    try {
      const numId = getNumericAssetId(assetId);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('assetId', numId);
      formData.append('mediaType', mediaType);

      const result = await api.postForm<UploadResponse>('/api/content/assets/upload', formData);
      if (!ownsRequest(epoch)) return;

      if (result.success && result.url) {
        changeMedia({ action: 'add', type: mediaType, url: result.url });
        toast({ title: 'Uploaded', description: `${mediaType === 'image' ? 'Image' : 'Video'} uploaded successfully` });
      } else {
        toast({ title: 'Error', description: 'Upload failed', variant: 'destructive' });
      }
    } catch {
      if (!ownsRequest(epoch)) return;
      toast({ title: 'Error', description: 'Failed to upload media', variant: 'destructive' });
    } finally {
      if (ownsRequest(epoch)) {
        uploadInFlight.current = false;
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  // ─── Magic Prompt Enhancement ──────────────────────────────────────────────

  const handleMagicPrompt = async () => {
    const epoch = requestEpoch.current;
    setIsEnhancingPrompt(true);
    try {
      const result = await api.post<{
        success: boolean;
        enhancedPrompt?: string;
        tips?: string;
      }>('/api/content/studio/magic-prompt', {
        currentPrompt: genPrompt,
        contentType: genTab,
        ...(threadId ? { threadId } : {}),
      });
      if (!ownsRequest(epoch)) return;
      if (result.success && result.enhancedPrompt) {
        setGenPrompt(result.enhancedPrompt);
        toast({ title: 'Prompt Enhanced!', description: result.tips || 'Your prompt has been improved with AI' });
      }
    } catch {
      if (!ownsRequest(epoch)) return;
      toast({ title: 'Error', description: 'Failed to enhance prompt', variant: 'destructive' });
    } finally {
      if (ownsRequest(epoch)) setIsEnhancingPrompt(false);
    }
  };

  // Auto-fill default prompt when generate panel opens
  const handleToggleGenerate = () => {
    const next = !showGenerate;
    setShowGenerate(next);
    if (next && !genPrompt.trim()) {
      setGenPrompt(
        genTab === 'image'
          ? 'A professional marketing image showcasing the product with clean, modern design'
          : 'A short promotional video with smooth transitions and professional feel'
      );
    }
  };

  // ─── Reference Image Upload (for Generate) ─────────────────────────────────

  const handleRefImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const epoch = requestEpoch.current;
    const files = e.target.files;
    if (!files) return;
    const selected = Array.from(files);
    if (genTab === 'image' && genRefImages.length + selected.length > 8) {
      toast({ title: 'Too many reference images', description: 'Use up to 8 reference images per generation.', variant: 'destructive' });
      e.target.value = '';
      return;
    }
    const invalid = selected.map(file => !file.type.startsWith('image/') ? 'Reference files must be images.' : creatorUploadError(file)).find(Boolean);
    if (invalid) {
      toast({ title: 'Unsupported reference image', description: invalid, variant: 'destructive' });
      e.target.value = '';
      return;
    }

    selected.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        if (!ownsRequest(epoch)) return;
        const base64 = (reader.result as string).split(',')[1];
        setGenRefImages(prev => genTab === 'video' ? [{ base64Data: base64, mimeType: file.type }] : [...prev, { base64Data: base64, mimeType: file.type }].slice(0, 8));
      };
      reader.onerror = () => {
        if (ownsRequest(epoch)) toast({ title: 'Could not read image', description: 'Choose another file and try again.', variant: 'destructive' });
      };
      reader.readAsDataURL(file);
    });

    if (refImageInputRef.current) refImageInputRef.current.value = '';
  };

  // ─── Generate ───────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (generationInFlight.current || deleteInFlight.current) return;
    const epoch = requestEpoch.current;
    if (!genPrompt.trim()) {
      toast({ title: 'Prompt required', description: 'Please enter a description for the media to generate', variant: 'destructive' });
      return;
    }

    generationInFlight.current = true;
    setIsGenerating(true);

    try {
      const parentId = savedContentAssetId(assetId);
      if (genTab === 'image') {
        const body: Record<string, unknown> = {
          prompt: genPrompt,
          threadId: threadId || undefined,
          assetId: parentId,
          saveToAssets: true,
          aspectRatio: genAspectRatio,
        };
        if (genRefImages.length > 0) {
          body.images = genRefImages;
        }

        const result = await api.post<GenerateImageResponse>('/api/content/studio/image', body);
        if (!ownsRequest(epoch)) return;

        if (result.success && result.imageUrl) {
          requireAttachedMediaReceipt(result, parentId);
          changeMedia({ action: 'add', type: 'image', url: result.imageUrl });
          toast({ title: 'Image attached', description: 'The image is saved on this content.' });
          setGenPrompt('');
          setGenRefImages([]);
          setShowGenerate(false);
        } else {
          toast({ title: 'Error', description: result.error || 'Image generation failed', variant: 'destructive' });
        }
      } else {
        const body: Record<string, unknown> = {
          prompt: genPrompt,
          threadId: threadId || undefined,
          assetId: parentId,
          saveToAssets: true,
          aspectRatio: genAspectRatio,
          duration: genDuration,
        };
        // If reference image is provided for video, use it
        if (genRefImages.length > 0) {
          body.image = genRefImages[0];
        }

        const result = await api.post<GenerateVideoResponse>('/api/content/studio/video', body);
        if (!ownsRequest(epoch)) return;

        const outcome = attachedVideoOutcome(result, parentId);
        if (outcome === 'saved') {
          changeMedia({ action: 'add', type: 'video', url: result.videoUrl! });
        }
        toast({ title: outcome === 'saved' ? 'Video attached' : 'Video generation queued', description: outcome === 'saved' ? 'The video is saved on this content.' : 'The request is saved on this content. The video is not ready yet.' });
        setGenPrompt('');
        setGenRefImages([]);
        setShowGenerate(false);
      }
    } catch (err: unknown) {
      if (!ownsRequest(epoch)) return;
      const msg = err instanceof Error ? err.message : 'Generation failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    } finally {
      if (ownsRequest(epoch)) {
        generationInFlight.current = false;
        setIsGenerating(false);
      }
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  const currentItem = allMedia[carouselIdx] || allMedia[0];

  return (
    <div className="space-y-3">
      {/* Carousel */}
      {allMedia.length > 0 ? (
        <div className="relative group">
          {/* Main Media Display */}
          <div className="relative w-full rounded-lg overflow-hidden bg-muted/30 border">
            {currentItem.type === 'image' ? (
              <img
                src={normalizeUploadUrl(currentItem.url)}
                alt={`Image ${currentItem.number}`}
                className="w-full max-h-80 object-contain"
              />
            ) : (
              <video
                key={currentItem.url}
                src={normalizeUploadUrl(currentItem.url)}
                controls
                aria-label={`Video ${currentItem.number}`}
                preload="metadata"
                className="w-full max-h-80"
              />
            )}

            {/* Overlay Controls */}
            <div className="absolute top-2 right-2 flex gap-1 z-20">
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="h-7 w-7 bg-white/90 text-gray-900 shadow-sm hover:bg-white"
                onClick={() => handleDownload(currentItem.url)}
                title="Download"
                aria-label="Download media"
              >
                <Download className="w-3.5 h-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="h-7 w-7 bg-red-100/90 hover:bg-red-200 shadow-sm text-red-600"
                onClick={() => handleDelete(currentItem.type, currentItem.url)}
                disabled={isDeleting || isUploading || isGenerating}
                title="Delete"
                aria-label="Delete media"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>

            {/* Nav Arrows */}
            {allMedia.length > 1 && (
              <div className="absolute inset-y-0 left-0 right-0 flex items-center justify-between pointer-events-none px-2 z-10">
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="pointer-events-auto h-8 w-8 bg-white/80 text-gray-900 shadow transition-opacity hover:bg-white disabled:opacity-0"
                  onClick={() => goTo(carouselIdx - 1)}
                  disabled={!canPrev}
                  aria-label="Previous media"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="pointer-events-auto h-8 w-8 bg-white/80 text-gray-900 shadow transition-opacity hover:bg-white disabled:opacity-0"
                  onClick={() => goTo(carouselIdx + 1)}
                  disabled={!canNext}
                  aria-label="Next media"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>

          {/* Dot Indicators / Thumbnail Strip */}
          {allMedia.length > 1 && (
            <div className="flex gap-1.5 justify-center mt-2 flex-wrap">
              {allMedia.map((item, idx) => (
                <button
                  key={item.key}
                  type="button"
                  aria-label={`Show ${item.type} ${item.number}`}
                  aria-pressed={idx === carouselIdx}
                  className={`w-12 h-12 rounded-md overflow-hidden border-2 transition-colors flex-shrink-0 ${
                    idx === carouselIdx ? 'border-primary' : 'border-transparent hover:border-muted-foreground/30'
                  }`}
                  onClick={() => goTo(idx)}
                >
                  {item.type === 'image' ? (
                    <img src={normalizeUploadUrl(item.url)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-muted flex items-center justify-center">
                      <VideoIcon className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-muted-foreground/30 p-6 text-center text-muted-foreground">
          <ImagePlus className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No media attached</p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2 flex-wrap">
        <input
          ref={fileInputRef}
          id={`${controlId}-upload`}
          aria-label="Upload image or video"
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={handleUpload}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          loading={isUploading}
          loadingText="Upload"
          disabled={isDeleting}
        >
          <Upload className="w-4 h-4 mr-1" />
          Upload
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleToggleGenerate}
        >
          <Wand2 className="w-4 h-4 mr-1" />
          Generate
        </Button>
      </div>

      {/* Generate Panel */}
      {showGenerate && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <Tabs value={genTab} onValueChange={(v) => {
            const tab = v as 'image' | 'video';
            setGenTab(tab);
            if (!genPrompt.trim() || genPrompt === 'A professional marketing image showcasing the product with clean, modern design' || genPrompt === 'A short promotional video with smooth transitions and professional feel') {
              setGenPrompt(
                tab === 'image'
                  ? 'A professional marketing image showcasing the product with clean, modern design'
                  : 'A short promotional video with smooth transitions and professional feel'
              );
            }
          }}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="image" className="text-xs"><ImagePlus className="w-3.5 h-3.5 mr-1" />Image</TabsTrigger>
              <TabsTrigger value="video" className="text-xs"><VideoIcon className="w-3.5 h-3.5 mr-1" />Video</TabsTrigger>
            </TabsList>

            <TabsContent value="image" className="space-y-3 mt-3">
              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor={`${controlId}-image-prompt`} className="text-xs">Prompt</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleMagicPrompt}
                    aria-label="Magic: enhance image prompt"
                    loading={isEnhancingPrompt}
                    loadingText="Magic"
                    className="h-6 text-xs text-purple-600 hover:text-purple-700 hover:bg-purple-50 px-2"
                  >
                    <Sparkles className="w-3 h-3 mr-1" />Magic
                  </Button>
                </div>
                <Textarea
                  id={`${controlId}-image-prompt`}
                  placeholder="Describe the image you want to generate..."
                  value={genPrompt}
                  onChange={(e) => setGenPrompt(e.target.value)}
                  rows={3}
                  className="mt-1 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor={`${controlId}-image-aspect`} className="text-xs">Aspect Ratio</Label>
                  <Select value={genAspectRatio} onValueChange={setGenAspectRatio}>
                    <SelectTrigger id={`${controlId}-image-aspect`} className="mt-1 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1:1">1:1 (Square)</SelectItem>
                      <SelectItem value="16:9">16:9 (Landscape)</SelectItem>
                      <SelectItem value="9:16">9:16 (Portrait)</SelectItem>
                      <SelectItem value="4:3">4:3 (Standard)</SelectItem>
                      <SelectItem value="3:4">3:4 (Tall)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`${controlId}-image-reference`} className="text-xs">Reference Images</Label>
                  <div className="mt-1">
                    <input
                      ref={refImageInputRef}
                      id={`${controlId}-image-reference`}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={handleRefImageUpload}
                    />
                    <Button
                      ref={refImageButtonRef}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs w-full"
                      onClick={() => refImageInputRef.current?.click()}
                      aria-label="Add reference images"
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add ({genRefImages.length})
                    </Button>
                  </div>
                </div>
              </div>
              {genRefImages.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  {genRefImages.map((img, i) => (
                    <div key={i} className="relative w-12 h-12 rounded overflow-hidden border">
                      <img src={`data:${img.mimeType};base64,${img.base64Data}`} alt="" className="w-full h-full object-cover" />
                      <button
                        type="button"
                        aria-label={`Remove reference image ${i + 1}`}
                        className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]"
                        onClick={() => removeReferenceImage(i)}
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="video" className="space-y-3 mt-3">
              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor={`${controlId}-video-prompt`} className="text-xs">Prompt</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleMagicPrompt}
                    aria-label="Magic: enhance video prompt"
                    loading={isEnhancingPrompt}
                    loadingText="Magic"
                    className="h-6 text-xs text-purple-600 hover:text-purple-700 hover:bg-purple-50 px-2"
                  >
                    <Sparkles className="w-3 h-3 mr-1" />Magic
                  </Button>
                </div>
                <Textarea
                  id={`${controlId}-video-prompt`}
                  placeholder="Describe the video you want to generate..."
                  value={genPrompt}
                  onChange={(e) => setGenPrompt(e.target.value)}
                  rows={3}
                  className="mt-1 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor={`${controlId}-video-duration`} className="text-xs">Duration (seconds)</Label>
                  <Select value={genDuration} onValueChange={setGenDuration}>
                    <SelectTrigger id={`${controlId}-video-duration`} className="mt-1 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5 seconds</SelectItem>
                      <SelectItem value="8">8 seconds</SelectItem>
                      <SelectItem value="10">10 seconds</SelectItem>
                      <SelectItem value="15">15 seconds</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`${controlId}-video-aspect`} className="text-xs">Aspect Ratio</Label>
                  <Select value={genAspectRatio} onValueChange={setGenAspectRatio}>
                    <SelectTrigger id={`${controlId}-video-aspect`} className="mt-1 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="16:9">16:9 (Landscape)</SelectItem>
                      <SelectItem value="9:16">9:16 (Portrait)</SelectItem>
                      <SelectItem value="1:1">1:1 (Square)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor={`${controlId}-video-reference`} className="text-xs">Reference Image (optional — for image-to-video)</Label>
                <div className="mt-1">
                  <input
                    ref={refImageInputRef}
                    id={`${controlId}-video-reference`}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleRefImageUpload}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    ref={refImageButtonRef}
                    onClick={() => refImageInputRef.current?.click()}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    {genRefImages.length > 0 ? 'Replace Reference' : 'Add Reference Image'}
                  </Button>
                </div>
                {genRefImages.length > 0 && (
                  <div className="flex gap-1.5 mt-2">
                    {genRefImages.slice(0, 1).map((img, i) => (
                      <div key={i} className="relative w-16 h-16 rounded overflow-hidden border">
                        <img src={`data:${img.mimeType};base64,${img.base64Data}`} alt="" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          aria-label="Remove video reference image"
                          className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]"
                          onClick={() => removeReferenceImage()}
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>

          <Button

            type="button"
            size="sm"
            onClick={handleGenerate}
            loading={isGenerating}
            loadingText={genTab === 'video' ? 'Generating Video (this may take a few minutes)...' : 'Generating Image...'}
            disabled={isDeleting || !genPrompt.trim()}
            className="w-full"
          >
            <Wand2 className="w-4 h-4 mr-1" />
            Generate {genTab === 'image' ? 'Image' : 'Video'}
          </Button>
        </div>
      )}
    </div>
  );
}
