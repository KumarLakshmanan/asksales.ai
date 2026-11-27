import { useState, useRef } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Share2, Download, Edit, Trash2, ChevronLeft, ChevronRight, Send, Maximize2, RefreshCw, Instagram, Facebook, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ContentFullscreenModal } from "@/components/modals";
import { normalizeUploadUrl } from "@/lib/utils";
import { buildContentMedia } from "@/lib/contentMedia";
import { captionFromSocialAsset } from "@/lib/socialPublishing";
import { getStringValue } from "@/components/content-cards/cardValues";
import { useCachedBrandName } from "@/hooks/use-cached-brand-name";

interface SocialPostContent {
  content?: string;
  caption?: string;
  callToAction?: string;
  body?: string;
  hashtags?: string[];
  imagePrompt?: string;
  videoPrompt?: string;
  platform?: string;
  imageUrls?: string[];  // Array of image URLs for multi-media support
  videoUrls?: string[];  // Array of video URLs for multi-media support
}

export interface SocialPostCardProps {
  id?: number;
  title: string;
  content: string;
  imageUrl?: string;
  videoUrl?: string;
  imageUrls?: string[];  // Array of image URLs for multi-media support
  videoUrls?: string[];  // Array of video URLs for multi-media support
  hashtags?: string[];
  platform?: string;
  status?: string;
  channel?: string;
  createdAt?: string | number;
  scheduledPublishAt?: string;
  prompt?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onDownload?: () => void;
  onGenerateImage?: (imagePrompt: string) => Promise<void>;
  onGenerateVideo?: (videoPrompt: string) => Promise<void>;
  onUploadImage?: (file: File) => Promise<void>;
  onUploadVideo?: (file: File) => Promise<void>;
  onPublish?: () => void;
  onPublishViaAgent?: () => void;
  isGeneratingImage?: boolean;
  isGeneratingVideo?: boolean;
  /** Companion media whose generation failed (shown instead of the in-progress row). */
  mediaFailed?: { image?: boolean; video?: boolean };
  isUploadingImage?: boolean;
  isUploadingVideo?: boolean;
  variant?: "preview" | "full";
  showActions?: boolean;
}

export default function SocialPostCard({
  id,
  title,
  content,
  imageUrl,
  videoUrl,
  imageUrls,
  videoUrls,
  hashtags: propHashtags,
  platform: propPlatform,
  status,
  channel,
  createdAt,
  scheduledPublishAt,
  prompt,
  onEdit,
  onDelete,
  onDownload,
   
  onGenerateImage,
   
  onGenerateVideo,
  onUploadImage,
  onUploadVideo,
  onPublish,
  onPublishViaAgent,
  isGeneratingImage = false,
  isGeneratingVideo = false,
  mediaFailed,
  // eslint-disable-next-line unused-imports/no-unused-vars
  isUploadingImage = false,
  // eslint-disable-next-line unused-imports/no-unused-vars
  isUploadingVideo = false,
  variant = "full",
  showActions = true,
}: SocialPostCardProps) {
  const { toast } = useToast();
  const [showFullscreen, setShowFullscreen] = useState(false);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  // Handle image file upload
  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Invalid File Type',
        description: 'Please upload an image file (jpg, png, gif, etc.)',
        variant: 'destructive',
      });
      return;
    }
    
    if (onUploadImage) {
      await onUploadImage(file);
    }
    // Reset input
    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
  };

  // Handle video file upload
  const handleVideoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('video/')) {
      toast({
        title: 'Invalid File Type',
        description: 'Please upload a video file (mp4, webm, mov, etc.)',
        variant: 'destructive',
      });
      return;
    }
    
    if (onUploadVideo) {
      await onUploadVideo(file);
    }
    // Reset input
    if (videoInputRef.current) {
      videoInputRef.current.value = '';
    }
  };

  const brandName = useCachedBrandName();

  // Parse content if it's a JSON string
  const parsedContent: SocialPostContent = (() => {
    try {
      const parsed = JSON.parse(content);
      // Ensure imagePrompt and videoPrompt are strings
      return {
        content: parsed.content || parsed.caption || parsed.body || content,
        callToAction: getStringValue(parsed.callToAction || parsed.cta),
        hashtags: parsed.hashtags || propHashtags,
        imagePrompt: getStringValue(parsed.imagePrompt),
        videoPrompt: getStringValue(parsed.videoPrompt),
        platform: parsed.platform || propPlatform,
      };
    } catch {
      return { content, hashtags: propHashtags };
    }
  })();

  const postContent = captionFromSocialAsset({ id: id || 0, title, content: JSON.stringify({ caption: parsedContent.content || '', callToAction: parsedContent.callToAction }) });
  // Strip leading # from hashtags to prevent double ## when rendering
  const hashtags = (parsedContent.hashtags || propHashtags || []).map(h => 
    typeof h === 'string' ? h.replace(/^#+/, '') : h
  ).filter(tag => !postContent.split(/\s+/).some(word => word.replace(/[.,!?;:]+$/, '').toLowerCase() === `#${tag}`.toLowerCase()));
  const platform = parsedContent.platform || propPlatform || channel;

  const copyContent = () => captionFromSocialAsset({ id: id || 0, title, content: JSON.stringify({ caption: postContent, hashtags }) });

  const getPlatformLabel = (p: string | undefined) => {
    if (p?.toLowerCase() === 'all') return 'All Platforms';
    const names: Record<string, string> = { linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', twitter: 'X', x: 'X', tiktok: 'TikTok', youtube: 'YouTube' };
    return p ? names[p.toLowerCase()] || p : p;
  };

  // Platform-specific engagement bar rendering
  const renderPlatformEngagementBar = () => {
    return (
      <div className="flex items-center justify-between gap-3 border-t bg-muted/15 px-4 py-3 text-[11px] leading-5 text-muted-foreground">
        <span>Provider engagement appears after publishing</span>
        <span className="inline-flex items-center gap-1 font-medium text-foreground"><ShieldCheck className="h-3.5 w-3.5 text-primary" /> Draft proof</span>
      </div>
    );


  };

  // Platform-specific post header rendering
  const renderPlatformPostHeader = () => {
    const platformLabel = getPlatformLabel(platform) || "Social post";
    const platformKey = platform?.toLowerCase();
    const Icon = platformKey === "instagram" ? Instagram : platformKey === "facebook" ? Facebook : Share2;
    const iconClass = platformKey === "instagram"
      ? "bg-gradient-to-br from-fuchsia-600 via-pink-500 to-orange-400 text-white"
      : platformKey === "facebook"
        ? "bg-[#1877F2] text-white"
        : "bg-primary/10 text-primary";
    return (
      <div className="flex items-center gap-3 border-b bg-card/95 p-3.5">
        <div className={`flex h-10 w-10 items-center justify-center rounded-2xl shadow-sm ${iconClass}`}><Icon className="h-[18px] w-[18px]" /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{brandName}</p>
          <p className="text-xs text-muted-foreground">{platformLabel} · Ready for review</p>
        </div>
        <Badge variant="outline" className="rounded-full bg-background text-[10px]">Draft</Badge>
      </div>
    );


  };

  const { imageUrls: allImages, videoUrls: allVideos, items: mediaItems } = buildContentMedia({
    imageUrl,
    imageUrls,
    videoUrl,
    videoUrls,
  });

  if (variant === "preview") {
    return (
      <div className="border rounded-lg overflow-hidden hover:shadow-md transition-shadow">
        {/* Carousel when multiple media items exist */}
        {mediaItems.length > 1 && (
          <div className="aspect-square bg-muted relative">
            {mediaItems[carouselIndex]?.type === 'image' ? (
              <img src={normalizeUploadUrl(mediaItems[carouselIndex].url)} alt={title} className="w-full h-full object-cover" />
            ) : (
              <video src={normalizeUploadUrl(mediaItems[carouselIndex].url)} className="w-full h-full bg-black object-contain" controls />
            )}
            
            {/* Carousel Navigation */}
            <button
              onClick={(e) => { e.stopPropagation(); setCarouselIndex(prev => prev === 0 ? mediaItems.length - 1 : prev - 1); }}
              className="absolute left-1 top-1/2 -translate-y-1/2 p-1 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors"
              aria-label="Previous"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setCarouselIndex(prev => prev === mediaItems.length - 1 ? 0 : prev + 1); }}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors"
              aria-label="Next"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            
            {/* Dots indicator */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
              {mediaItems.map((item, idx) => (
                <button
                  key={idx}
                  onClick={(e) => { e.stopPropagation(); setCarouselIndex(idx); }}
                  className={`w-2 h-2 rounded-full transition-colors ${idx === carouselIndex ? 'bg-white' : 'bg-white/50'}`}
                  aria-label={`Go to slide ${idx + 1}`}
                />
              ))}
            </div>
            
            {/* Counter */}
            <div className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
              {carouselIndex + 1} / {mediaItems.length}
            </div>
          </div>
        )}
        
        {/* Single image display */}
        {mediaItems.length === 1 && allImages.length === 1 && (
          <div className="aspect-square bg-muted relative">
            <img src={normalizeUploadUrl(allImages[0])} alt={title} className="w-full h-full object-cover" />
          </div>
        )}
        
        {/* Single video display */}
        {mediaItems.length === 1 && allVideos.length === 1 && allImages.length === 0 && (
          <div className="aspect-square bg-muted relative flex items-center justify-center">
            <video src={normalizeUploadUrl(allVideos[0])} className="w-full h-full bg-black object-contain" controls />
          </div>
        )}
        <div className="p-3">
          <div className="flex items-start justify-between mb-1">
            <div className="flex items-center gap-2">
            </div>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-3 break-words whitespace-pre-wrap">{postContent}</p>
          {hashtags && hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {hashtags.slice(0, 3).map((tag, i) => (
                <span key={i} className="text-xs text-blue-500">#{tag}</span>
              ))}
              {hashtags.length > 3 && (
                <span className="text-xs text-muted-foreground/60">+{hashtags.length - 3} more</span>
              )}
            </div>
          )}
          {createdAt && (
            <p className="text-xs text-muted-foreground/60 mt-2">{new Date(createdAt).toLocaleDateString()}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card className="hover:shadow-md transition-shadow overflow-hidden">
      {/* Hidden file inputs for upload */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageUpload}
        className="hidden"
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        onChange={handleVideoUpload}
        className="hidden"
      />
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            {status && (
              <StatusBadge status={status} label={status.charAt(0).toUpperCase() + status.slice(1)} />
            )}
            {status === "scheduled" && scheduledPublishAt && (
              <Badge variant="outline" className="flex items-center gap-1 text-xs text-muted-foreground">
                📅 {new Date(scheduledPublishAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </Badge>
            )}
          </div>
          {showActions && (
            <div className="flex items-center gap-1">
              {onPublish && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:bg-primary/10 hover:text-primary" onClick={onPublish} aria-label="Publish" title="Publish">
                  <Send className="h-4 w-4" />
                </Button>
              )}
              {onPublishViaAgent && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:bg-primary/10 hover:text-primary" onClick={onPublishViaAgent} aria-label="Agent publish" title="Agent publish">
                  <Share2 className="h-4 w-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowFullscreen(true)} aria-label="View fullscreen" title="View Fullscreen">
                <Maximize2 className="h-4 w-4" />
              </Button>
              <CopyButton variant="ghost" iconOnly className="h-8 w-8" value={copyContent} onCopied={() => toast({ title: "Copied", description: "Social post copied to clipboard" })} onError={() => toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" })} />
              {onDownload && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onDownload} aria-label="Download">
                  <Download className="h-4 w-4" />
                </Button>
              )}
              {onEdit && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label="Edit">
                  <Edit className="h-4 w-4" />
                </Button>
              )}
              {onDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label="Delete">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Social Post?</AlertDialogTitle>
                      <AlertDialogDescription>This action cannot be undone. The social post will be permanently deleted.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}
        </div>
        <h4 className="font-medium text-base leading-tight line-clamp-2">{title}</h4>
      </CardHeader>
      <CardContent>
        {/* Social Post Preview */}
        <div className="border rounded-xl overflow-hidden">
          {/* Post Header - Platform Adaptive */}
          {renderPlatformPostHeader()}
          
          {/* Combined Media/Prompt Carousel - shows generated media or auto-generating indicator */}
          {(() => {
            // Build media items for carousel - only items with actual URLs
            const mediaItems: { type: 'image' | 'video'; url: string }[] = [];
            allImages.forEach(url => mediaItems.push({ type: 'image', url }));
            allVideos.forEach(url => mediaItems.push({ type: 'video', url }));
            
            // Show existing media carousel
            if (mediaItems.length > 0) {
              const currentItem = mediaItems[carouselIndex % mediaItems.length] || mediaItems[0];
              const hasMultipleItems = mediaItems.length > 1;
              
              return (
                <div className="relative">
                  <div className="aspect-video relative">
                    {currentItem.type === 'image' ? (
                      <img src={normalizeUploadUrl(currentItem.url)} alt="Post Media" className="w-full h-full object-cover" />
                    ) : (
                      <video src={normalizeUploadUrl(currentItem.url)} controls className="w-full h-full bg-black object-contain" />
                    )}
                  </div>
                  
                  {hasMultipleItems && (
                    <>
                      <button
                        onClick={() => setCarouselIndex(prev => prev === 0 ? mediaItems.length - 1 : prev - 1)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors z-10"
                        aria-label="Previous"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setCarouselIndex(prev => prev === mediaItems.length - 1 ? 0 : prev + 1)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors z-10"
                        aria-label="Next"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5 z-10">
                        {mediaItems.map((_, idx) => (
                          <button
                            key={idx}
                            onClick={() => setCarouselIndex(idx)}
                            className={`w-2.5 h-2.5 rounded-full transition-colors border ${idx === (carouselIndex % mediaItems.length) ? 'bg-white border-white' : 'bg-white/30 border-white/50'}`}
                            aria-label={`Go to slide ${idx + 1}`}
                          />
                        ))}
                      </div>
                      <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded z-10">
                        {(carouselIndex % mediaItems.length) + 1} / {mediaItems.length}
                      </div>
                    </>
                  )}
                </div>
              );
            }
            
            // Show auto-generating indicator when no media exists but generation is in progress
            const showImageGenerating = isGeneratingImage && parsedContent.imagePrompt && allImages.length === 0;
            const showVideoGenerating = isGeneratingVideo && parsedContent.videoPrompt && allVideos.length === 0;
            
            // Show retry button if not generating, prompt exists, but no media exists
            const showImageMissing = !isGeneratingImage && parsedContent.imagePrompt && allImages.length === 0;
            const showVideoMissing = !isGeneratingVideo && parsedContent.videoPrompt && allVideos.length === 0;
            const showImageFailed = !isGeneratingImage && mediaFailed?.image && allImages.length === 0;
            const showVideoFailed = !isGeneratingVideo && mediaFailed?.video && allVideos.length === 0;
            
            if (!showImageGenerating && !showVideoGenerating && !showImageMissing && !showVideoMissing && !showImageFailed && !showVideoFailed) return null;
            
            return (
              <div className="p-4 space-y-2">
                {showImageGenerating && (
                  <div className="flex items-center gap-2 text-sm text-purple-600">
                    <Spinner size="sm" label={null} />
                    <span>Generating image...</span>
                  </div>
                )}
                {showImageMissing && onGenerateImage && (
                  <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground bg-muted/50 p-2 rounded">
                  <span>No image attached yet.</span>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onGenerateImage(parsedContent.imagePrompt!)}>
                      <RefreshCw className="w-3 h-3 mr-1" /> Generate
                    </Button>
                  </div>
                )}
                
                {showVideoGenerating && (
                  <div role="status" className="flex items-start gap-2 text-sm text-violet-600">
                    <Spinner size="sm" label={null} className="mt-0.5" />
                    <span>Generating video… usually 1–3 minutes. The video will appear here when it is ready; you can leave this page.</span>
                  </div>
                )}
                {showImageFailed && <p role="alert" className="text-sm text-destructive">Image generation failed. Your caption is saved.</p>}
                {showVideoFailed && <p role="alert" className="text-sm text-destructive">Video generation failed. Your caption is saved; generate the video again from the Video creator.</p>}
                {showVideoMissing && onGenerateVideo && (
                  <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground bg-muted/50 p-2 rounded">
                  <span>No video attached yet.</span>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onGenerateVideo(parsedContent.videoPrompt!)}>
                      <RefreshCw className="w-3 h-3 mr-1" /> Generate
                    </Button>
                  </div>
                )}
              </div>
            );
          })()}
          
          {/* Post Content */}
          <div className="p-4">
            <p className="text-sm whitespace-pre-wrap break-words">{postContent}</p>
            
            {/* Hashtags */}
            {hashtags && hashtags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {hashtags.map((tag, i) => (
                  <span key={i} className="text-sm text-blue-500">#{tag}</span>
                ))}
              </div>
            )}
          </div>
          
          {/* Engagement Bar - Platform Adaptive */}
          {renderPlatformEngagementBar()}
        </div>

        {createdAt && (
          <p className="text-xs text-muted-foreground/60 mt-3 text-center">
            Created {new Date(createdAt).toLocaleDateString()}
          </p>
        )}
      </CardContent>

      {/* Fullscreen Modal */}
      <ContentFullscreenModal
        open={showFullscreen}
        onOpenChange={setShowFullscreen}
        contentType="social_post"
        title={title}
        content={content}
        status={status}
        channel={channel || platform}
        createdAt={typeof createdAt === 'number' ? new Date(createdAt).toISOString() : createdAt}
        imageUrls={allImages}
        videoUrls={allVideos}
        prompt={prompt}
        imagePrompt={parsedContent.imagePrompt}
        videoPrompt={parsedContent.videoPrompt}
        customActions={
          onPublish ? (
            <Button size="sm" onClick={() => { setShowFullscreen(false); onPublish(); }}>
              <Send className="h-4 w-4 mr-1" />
              Publish Post
            </Button>
          ) : undefined
        }
      />
    </Card>
  );
}
