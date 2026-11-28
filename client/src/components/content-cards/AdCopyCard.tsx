import React, { useState, useRef } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Megaphone, Edit, Trash2, ExternalLink, ThumbsUp, MessageCircle, Share, Image, Video, Target, ArrowRight, ChevronLeft, ChevronRight, Maximize2, Send, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ContentFullscreenModal } from "@/components/modals";
import { normalizeUploadUrl } from "@/lib/utils";
import { buildContentMedia } from "@/lib/contentMedia";
import { getStringValue } from "@/components/content-cards/cardValues";

/** "https://www.example.com/page" → "example.com" for a feed ad's link bar. */
export function adDisplayHost(url: string | undefined | null): string {
  const raw = url?.trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

// Helper function to safely format dates
function formatDate(dateValue: string | number | undefined): string | null {
  if (!dateValue) return null;
  
  let date: Date;
  
  // If it's a string that looks like a timestamp number, parse as number
  if (typeof dateValue === 'string') {
    const numValue = Number(dateValue);
    if (!isNaN(numValue) && numValue > 1000000000000) {
      // It's a millisecond timestamp as string
      date = new Date(numValue);
    } else if (!isNaN(numValue) && numValue > 1000000000) {
      // It's a second timestamp as string
      date = new Date(numValue * 1000);
    } else {
      // It's an ISO date string or other format
      date = new Date(dateValue);
    }
  } else if (typeof dateValue === 'number') {
    // If it's a number, assume it's a timestamp
    date = dateValue > 1000000000000 ? new Date(dateValue) : new Date(dateValue * 1000);
  } else {
    return null;
  }
  
  // Check if date is valid
  if (isNaN(date.getTime())) {
    return null;
  }
  
  return date.toLocaleDateString();
}

interface AdCopyContent {
  headline?: string;
  description?: string;
  body?: string;
  primaryText?: string;
  callToAction?: string;
  displayUrl?: string;
  platform?: string;
  keywords?: string[];
  imagePrompt?: string;
  videoPrompt?: string;
  imageUrl?: string;
  videoUrl?: string;
  imageUrls?: string[];  // Array of image URLs for multi-media support
  videoUrls?: string[];  // Array of video URLs for multi-media support
  autoGenerateImageRequested?: boolean;
  autoGenerateVideoRequested?: boolean;
}

export interface AdCopyCardProps {
  id?: number;
  title: string;
  content: string;
  headline?: string;
  description?: string;
  callToAction?: string;
  status?: string;
  channel?: string;
  createdAt?: string;
  prompt?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onGenerateImage?: (prompt: string) => void;
  onGenerateVideo?: (prompt: string) => void;
  onUploadImage?: (file: File) => Promise<void>;
  onUploadVideo?: (file: File) => Promise<void>;
  onHireAgent?: (agentType: string, prompt: string) => void;  // Callback to hire an agent
  onPublish?: () => void;
  publishLabel?: string;
  isGeneratingImage?: boolean;
  isGeneratingVideo?: boolean;
  isUploadingImage?: boolean;
  isUploadingVideo?: boolean;
  variant?: "preview" | "full";
  showActions?: boolean;
  customActions?: React.ReactNode;
}

export default function AdCopyCard({
  title,
  content,
  headline: propHeadline,
  description: propDescription,
  callToAction: propCallToAction,
  status,
  channel,
  createdAt,
  prompt,
  onEdit,
  onDelete,
   
  onGenerateImage,
   
  onGenerateVideo,
  onUploadImage,
  onUploadVideo,
  onHireAgent,
  onPublish,
  publishLabel = 'Publish',
  isGeneratingImage = false,
  isGeneratingVideo = false,
  // eslint-disable-next-line unused-imports/no-unused-vars
  isUploadingImage = false,
  // eslint-disable-next-line unused-imports/no-unused-vars
  isUploadingVideo = false,
  variant = "full",
  showActions = true,
  customActions,
}: AdCopyCardProps) {
  const { toast } = useToast();
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [showFullscreen, setShowFullscreen] = useState(false);
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

  // Parse content if it's a JSON string
  const parsedContent: AdCopyContent = (() => {
    try {
      const parsed = JSON.parse(content);
      // Ensure imagePrompt and videoPrompt are strings
      return {
        headline: parsed.headline || propHeadline,
        description: parsed.description || propDescription,
        body: parsed.body || parsed.primaryText || parsed.content,
        primaryText: parsed.primaryText,
        callToAction: parsed.callToAction || parsed.cta || propCallToAction,
        displayUrl: parsed.displayUrl || 'yoursite.com',
        platform: parsed.platform || channel,
        keywords: parsed.keywords || [],
        imagePrompt: getStringValue(parsed.imagePrompt),
        videoPrompt: getStringValue(parsed.videoPrompt),
        autoGenerateImageRequested: parsed.autoGenerateImageRequested === true,
        autoGenerateVideoRequested: parsed.autoGenerateVideoRequested === true,
        imageUrl: parsed.imageUrl || 
                  (typeof parsed.generatedImage === 'string' ? parsed.generatedImage : 
                   parsed.generatedImage?.imageUrl ? parsed.generatedImage.imageUrl :
                   parsed.generatedImage?.imageData ? `data:${parsed.generatedImage.mimeType || 'image/png'};base64,${parsed.generatedImage.imageData}` :
                   undefined),
        videoUrl: parsed.videoUrl || 
                  (typeof parsed.generatedVideo === 'string' ? parsed.generatedVideo :
                   parsed.generatedVideo?.videoUrl ? parsed.generatedVideo.videoUrl :
                   parsed.generatedVideo?.videoData ? `data:${parsed.generatedVideo.mimeType || 'video/mp4'};base64,${parsed.generatedVideo.videoData}` :
                   undefined),
      };
    } catch {
      return {
        body: content,
        headline: propHeadline,
        description: propDescription,
        callToAction: propCallToAction,
      };
    }
  })();

  // Map CTA types to display-friendly labels
  const formatCta = (cta: string | undefined): string | undefined => {
    if (!cta) return undefined;
    const ctaMap: Record<string, string> = {
      'LEARN_MORE': 'Learn More',
      'SHOP_NOW': 'Shop Now',
      'SIGN_UP': 'Sign Up',
      'DOWNLOAD': 'Download',
      'CONTACT_US': 'Contact Us',
      'GET_QUOTE': 'Get Quote',
      'BOOK_TRAVEL': 'Book Now',
      'BOOK_NOW': 'Book Now',
      'SUBSCRIBE': 'Subscribe',
      'GET_OFFER': 'Get Offer',
      'APPLY_NOW': 'Apply Now',
      'BUY_NOW': 'Buy Now',
      'WATCH_MORE': 'Watch More',
    };
    return ctaMap[cta.toUpperCase()] || cta.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  const adHeadline = parsedContent.headline || propHeadline || title;
  const adDescription = parsedContent.description || propDescription;
  const adBody = parsedContent.body || parsedContent.primaryText || '';
  const adCta = formatCta(parsedContent.callToAction || propCallToAction);
  // Google ads read as search results; Meta, LinkedIn and other feeds show the
  // primary text above the media and a link bar with the headline below it.
  const isSearchAd = (channel || parsedContent.platform)?.toLowerCase() === 'google';
  const destinationHost = adDisplayHost(parsedContent.displayUrl);

  const copyContent = () => [adHeadline, adDescription, adBody, adCta]
    .filter(Boolean)
    .join("\n\n");

  if (variant === "preview") {
    // Build media items for carousel - combine single URL with array URLs
    const { items: mediaItems } = buildContentMedia({
      imageUrl: parsedContent.imageUrl,
      imageUrls: parsedContent.imageUrls,
      videoUrl: parsedContent.videoUrl,
      videoUrls: parsedContent.videoUrls,
    });
    const hasMultipleMedia = mediaItems.length > 1;
    
    return (
      <div className="border rounded-lg overflow-hidden hover:shadow-md transition-shadow">
        {/* Image/Video Preview with Carousel */}
        {mediaItems.length > 0 && (
          <div className="aspect-video bg-muted relative">
            {mediaItems[carouselIndex]?.type === 'image' ? (
              <img src={normalizeUploadUrl(mediaItems[carouselIndex].url)} alt={title} className="w-full h-full object-cover" />
            ) : mediaItems[carouselIndex]?.type === 'video' ? (
              <video src={normalizeUploadUrl(mediaItems[carouselIndex].url)} className="w-full h-full bg-black object-contain" controls />
            ) : null}
            
            {/* Carousel Navigation */}
            {hasMultipleMedia && (
              <>
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
                  {mediaItems.map((_, idx) => (
                    <button
                      key={idx}
                      onClick={(e) => { e.stopPropagation(); setCarouselIndex(idx); }}
                      className={`w-2 h-2 rounded-full transition-colors ${idx === carouselIndex ? 'bg-white' : 'bg-white/50'}`}
                      aria-label={`Go to slide ${idx + 1}`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {/* Placeholder for prompts without generated media */}
        {(
          (parsedContent.imagePrompt && !parsedContent.imageUrl && !(parsedContent.imageUrls?.length)) ||
          (parsedContent.videoPrompt && !parsedContent.videoUrl && !(parsedContent.videoUrls?.length))
        ) && (
          <div className="flex aspect-video items-center justify-center bg-primary/5">
            <div className="text-center p-2">
              {parsedContent.imagePrompt && !parsedContent.imageUrl && <Image className="mx-auto mb-1 h-8 w-8 text-primary/45"
 />}
              {(!parsedContent.imagePrompt || parsedContent.imageUrl) && parsedContent.videoPrompt && !parsedContent.videoUrl && <Video className="mx-auto mb-1 h-8 w-8 text-primary/45" />}
              <p className="text-xs text-muted-foreground">Click to generate</p>
            </div>
          </div>
        )}
        <div className="p-3">
          <div className="flex items-start justify-between mb-1">
            <div className="flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-primary" />
              <span className="font-medium text-sm">{title}</span>
            </div>
            {status && (
              <StatusBadge status={status} label={status} />
            )}
          </div>
          {adHeadline && (
            <p className="text-sm font-semibold text-foreground mb-1">{adHeadline}</p>
          )}
          <p className="text-sm text-muted-foreground line-clamp-3">{adBody}</p>
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground/60">
            {channel && <Badge variant="outline" className="text-xs capitalize">{channel}</Badge>}
            {createdAt && formatDate(createdAt) && <span>{formatDate(createdAt)}</span>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card className="min-w-0 gap-0 py-0 hover:shadow-md transition-shadow overflow-hidden [overflow-wrap:anywhere]">
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
      <CardHeader className="p-4 pb-3 sm:p-4 sm:pb-3">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            {status && (
              <StatusBadge status={status} label={status.charAt(0).toUpperCase() + status.slice(1)} />
            )}
          </div>
          {showActions && (
            <div className="flex items-center gap-1">
              {onPublish && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:bg-primary/10 hover:text-primary" onClick={onPublish} aria-label={publishLabel} title={publishLabel}>
                  <Send className="h-4 w-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowFullscreen(true)} aria-label="View fullscreen" title="View fullscreen">
                <Maximize2 className="h-4 w-4" />
              </Button>
              <CopyButton variant="ghost" iconOnly className="h-8 w-8" value={copyContent} onCopied={() => toast({ title: "Copied", description: "Ad copy copied to clipboard" })} />
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
                      <AlertDialogTitle>Delete Ad Copy?</AlertDialogTitle>
                      <AlertDialogDescription>This action cannot be undone. The ad copy will be permanently deleted.</AlertDialogDescription>
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
      <CardContent className="px-4 pb-4 sm:px-4 sm:pb-4">
        {/* Ad Preview - Google/Facebook Style */}
        <div className="border rounded-lg overflow-hidden">
          {/* Sponsored Label */}
          <div className="bg-muted/50 px-3 py-1 border-b flex items-center gap-1 text-xs text-muted-foreground">
            <span>Creative preview</span>
            {channel && <span className="capitalize">• {channel}</span>}
          </div>
          
          {!isSearchAd && adBody && (
            <p className="px-4 pt-3 pb-2 text-sm text-foreground line-clamp-4 whitespace-pre-line">{adBody}</p>
          )}

          {/* Media Carousel - at top for visual emphasis */}
          {(() => {
            // Build media items for carousel - combine single URL with array URLs
            const { items: fullMediaItems } = buildContentMedia({
              imageUrl: parsedContent.imageUrl,
              imageUrls: parsedContent.imageUrls,
              videoUrl: parsedContent.videoUrl,
              videoUrls: parsedContent.videoUrls,
            });
            
            if (fullMediaItems.length > 0) {
              return (
                <div className="aspect-video bg-muted relative overflow-hidden">
                  {fullMediaItems[carouselIndex]?.type === 'image' ? (
                    <img src={normalizeUploadUrl(fullMediaItems[carouselIndex].url)} alt="Ad Media" className="w-full h-full object-cover" />
                  ) : (
                    <video src={normalizeUploadUrl(fullMediaItems[carouselIndex].url)} controls className="w-full h-full bg-black object-contain" />
                  )}
                  
                  {/* Carousel Navigation - only show if multiple items */}
                  {fullMediaItems.length > 1 && (
                    <>
                      <button
                        onClick={() => setCarouselIndex(prev => prev === 0 ? fullMediaItems.length - 1 : prev - 1)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors"
                        aria-label="Previous"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setCarouselIndex(prev => prev === fullMediaItems.length - 1 ? 0 : prev + 1)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors"
                        aria-label="Next"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                      
                      {/* Dots indicator */}
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
                        {fullMediaItems.map((_, idx) => (
                          <button
                            key={idx}
                            onClick={() => setCarouselIndex(idx)}
                            className={`w-2 h-2 rounded-full transition-colors ${idx === carouselIndex ? 'bg-white' : 'bg-white/50'}`}
                            aria-label={`Go to slide ${idx + 1}`}
                          />
                        ))}
                      </div>
                      
                      {/* Counter */}
                      <div className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                        {carouselIndex + 1} / {fullMediaItems.length}
                      </div>
                    </>
                  )}
                </div>
              );
            }
            return null;
          })()}
          
          {/* Ad Content */}
          {!isSearchAd ? (
            <div className="flex items-center justify-between gap-3 bg-muted/40 px-4 py-3">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-muted-foreground truncate">
                  {destinationHost || 'Destination not set'}
                </div>
                <div className="text-sm font-semibold text-foreground line-clamp-2">{adHeadline}</div>
                {adDescription && adDescription !== adBody && (
                  <div className="text-xs text-muted-foreground line-clamp-1">{adDescription}</div>
                )}
              </div>
              {adCta && (
                <span className="shrink-0 rounded-md border bg-background px-3 py-1.5 text-sm font-medium">{adCta}</span>
              )}
            </div>
          ) : (
          <div className="p-4">
            {/* Headline */}
            <div className="text-primary text-lg font-medium mb-1 flex items-center gap-1">
              {adHeadline}
              <ExternalLink className="w-3 h-3" />
            </div>
            
            {/* Display URL */}
            <div className="text-xs text-green-600 mb-2 flex items-center gap-1">
              <span>Ad</span>
              <span>•</span>
              <span>{parsedContent.displayUrl || 'Destination not set'}</span>
            </div>
            
            {/* Description */}
            {adDescription && (
              <p className="text-sm text-muted-foreground mb-2">{adDescription}</p>
            )}
            
            {/* Body */}
            {adBody && adBody !== adDescription && (
              <p className="text-sm text-foreground line-clamp-3">{adBody}</p>
            )}
            
            {/* CTA Button */}
            {adCta && (
              <div className="mt-3">
                <span className="inline-block bg-primary/10 text-primary px-3 py-1.5 rounded text-sm font-medium">
                  {adCta}
                </span>
              </div>
            )}
          </div>
          )}
          
          {/* Auto-generating media indicator */}
          {(() => {
            const showImageGenerating = isGeneratingImage && parsedContent.imagePrompt && !parsedContent.imageUrl;
            const showVideoGenerating = isGeneratingVideo && parsedContent.videoPrompt && !parsedContent.videoUrl;
            
            const showImageMissing = !isGeneratingImage
              && parsedContent.autoGenerateImageRequested === true
              && parsedContent.imagePrompt
              && !parsedContent.imageUrl;
            const showVideoMissing = !isGeneratingVideo
              && parsedContent.autoGenerateVideoRequested === true
              && parsedContent.videoPrompt
              && !parsedContent.videoUrl;
            
            if (!showImageGenerating && !showVideoGenerating && !showImageMissing && !showVideoMissing) return null;
            
            return (
              <div className="border-t p-4 space-y-2">
                {showImageGenerating && (
                  <div className="flex items-center gap-2 text-sm text-blue-600">
                    <Spinner size="sm" label={null} />
                    <span>Generating image...</span>
                  </div>
                )}
                {showImageMissing && onGenerateImage && (
                  <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground bg-muted/50 p-2 rounded">
                  <span>No image attached yet.</span>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); onGenerateImage(parsedContent.imagePrompt!); }}>
                      <RefreshCw className="w-3 h-3 mr-1" /> Generate
                    </Button>
                  </div>
                )}
                
                {showVideoGenerating && (
                  <div className="flex items-center gap-2 text-sm text-purple-600">
                    <Spinner size="sm" label={null} />
                    <span>Generating video...</span>
                  </div>
                )}
                {showVideoMissing && onGenerateVideo && (
                  <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground bg-muted/50 p-2 rounded">
                  <span>No video attached yet.</span>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); onGenerateVideo(parsedContent.videoPrompt!); }}>
                      <RefreshCw className="w-3 h-3 mr-1" /> Generate
                    </Button>
                  </div>
                )}
              </div>
            );
          })()}
          
          {/* Social chrome is illustrative, not engagement data or live controls. */}
          {(channel || parsedContent.platform)?.toLowerCase() !== 'google' && (
          <div className="bg-muted/50 px-3 py-2 border-t flex flex-wrap items-center gap-3 text-muted-foreground text-xs" aria-label="Illustrative social preview">
            <div className="flex items-center gap-1">
              <ThumbsUp className="w-4 h-4" />
              <span>Like</span>
            </div>
            <div className="flex items-center gap-1">
              <MessageCircle className="w-4 h-4" />
              <span>Comment</span>
            </div>
            <div className="flex items-center gap-1">
              <Share className="w-4 h-4" />
              <span>Share</span>
            </div>
          </div>
          )}
        </div>

        {createdAt && formatDate(createdAt) && (
          <p className="text-xs text-muted-foreground/60 mt-3 text-center">
            Created {formatDate(createdAt)}
          </p>
        )}



        {/* Performance Marketing Agent Recommendation */}
        {onHireAgent && showActions && (
          <div className="pt-3 border-t mt-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-2">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-primary p-1.5">
                  <Target className="w-3 h-3 text-white" />
                </div>
                <div>
                  <p className="text-xs font-medium">Ready to launch?</p>
                  <p className="text-xs text-muted-foreground">Hire Sarah for ad campaigns</p>
                </div>
              </div>
              <Button
                size="sm"
                className="h-7 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                onClick={() => onHireAgent('PerformanceMarketingAgent', 'Launch a paid advertising campaign with this ad copy')}
              >
                Hire <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </div>
          </div>
        )}
        {customActions}
      </CardContent>

      {/* Fullscreen Modal */}
      <ContentFullscreenModal
        open={showFullscreen}
        onOpenChange={setShowFullscreen}
        contentType="ad_copy"
        title={title}
        content={content}
        status={status}
        channel={channel}
        platform={parsedContent.platform}
        createdAt={createdAt}
        imageUrl={parsedContent.imageUrl}
        videoUrl={parsedContent.videoUrl}
        imageUrls={parsedContent.imageUrls}
        videoUrls={parsedContent.videoUrls}
        prompt={prompt}
        imagePrompt={parsedContent.imagePrompt}
        videoPrompt={parsedContent.videoPrompt}
        customActions={
          <>
            {onPublish && (
              <Button size="sm" onClick={() => { setShowFullscreen(false); onPublish(); }}>
                <Send className="h-4 w-4 mr-1" />
                {publishLabel}
              </Button>
            )}
          </>
        }
      />
    </Card>
  );
}
