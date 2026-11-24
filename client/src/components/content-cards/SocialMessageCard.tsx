import { useState, useRef } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { MessageSquare, Edit, Trash2, User, Send, CheckCheck, Rocket, ArrowRight, ChevronLeft, Maximize2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ContentFullscreenModal } from "@/components/modals";
import { normalizeUploadUrl } from "@/lib/utils";
import { getStringValue } from "@/components/content-cards/cardValues";

interface SocialMessageContent {
  message?: string;
  subject?: string;
  greeting?: string;
  body?: string;
  closing?: string;
  signature?: string;
  recipientName?: string;
  platform?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  imageUrl?: string;
  videoUrl?: string;
  imageUrls?: string[];  // Array of image URLs for multi-media support
  videoUrls?: string[];  // Array of video URLs for multi-media support
}

export interface SocialMessageCardProps {
  id?: number;
  title: string;
  content: string;
  recipientName?: string;
  platform?: string;
  status?: string;
  channel?: string;
  createdAt?: string;
  prompt?: string;
  imageUrls?: string[];  // Array of image URLs for multi-media support
  videoUrls?: string[];  // Array of video URLs for multi-media support
  onEdit?: () => void;
  onDelete?: () => void;
  onSend?: () => void;
  onHireAgent?: (agentType: string, prompt: string) => void;  // Callback to hire an agent
  onGenerateImage?: (imagePrompt: string) => Promise<void>;
  onGenerateVideo?: (videoPrompt: string) => Promise<void>;
  onUploadImage?: (file: File) => Promise<void>;
  onUploadVideo?: (file: File) => Promise<void>;
  isGeneratingImage?: boolean;
  isGeneratingVideo?: boolean;
  isUploadingImage?: boolean;
  isUploadingVideo?: boolean;
  variant?: "preview" | "full";
  showActions?: boolean;
}

export default function SocialMessageCard({
  title,
  content,
  recipientName: propRecipientName,
  platform: propPlatform,
  status,
  channel,
  createdAt,
  prompt,
  imageUrls: propImageUrls,
  videoUrls: propVideoUrls,
  onEdit,
  onDelete,
  onSend,
  onHireAgent,
   
  onGenerateImage,
   
  onGenerateVideo,
  onUploadImage,
  onUploadVideo,
  isGeneratingImage = false,
  isGeneratingVideo = false,
  // eslint-disable-next-line unused-imports/no-unused-vars
  isUploadingImage = false,
  // eslint-disable-next-line unused-imports/no-unused-vars
  isUploadingVideo = false,
  variant = "full",
  showActions = true,
}: SocialMessageCardProps) {
  const { toast } = useToast();
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
  const parsedContent: SocialMessageContent = (() => {
    try {
      const parsed = JSON.parse(content);
      // Ensure imagePrompt and videoPrompt are strings
      return {
        message: parsed.message || parsed.body || parsed.content || content,
        subject: parsed.subject,
        greeting: parsed.greeting,
        body: parsed.body,
        closing: parsed.closing,
        signature: parsed.signature,
        recipientName: parsed.recipientName || propRecipientName,
        platform: parsed.platform || propPlatform,
        imagePrompt: getStringValue(parsed.imagePrompt),
        videoPrompt: getStringValue(parsed.videoPrompt),
        imageUrl: parsed.imageUrl,
        videoUrl: parsed.videoUrl,
      };
    } catch {
      return { message: content };
    }
  })();

  const message = parsedContent.message || parsedContent.body || '';
  const platform = parsedContent.platform || propPlatform || channel || 'linkedin';
  const recipientName = parsedContent.recipientName || propRecipientName || 'Recipient';

  const copyContent = () => [
    parsedContent.subject ? `Subject: ${parsedContent.subject}` : '',
    parsedContent.greeting,
    message,
    parsedContent.closing,
    parsedContent.signature,
  ].filter(Boolean).join("\n\n");

  const getPlatformColor = (p: string | undefined) => {
    switch (p?.toLowerCase()) {
      case "linkedin":
        return "bg-blue-600 text-white";
      case "twitter":
      case "x":
        return "bg-black text-white";
      case "instagram":
        return "bg-gradient-to-r from-purple-500 to-violet-500 text-white";
      case "facebook":
        return "bg-blue-500 text-white";
      default:
        return "bg-cyan-500 text-white";
    }
  };

  // Platform-specific DM header rendering
  const renderPlatformDMHeader = () => {
    const platformLower = platform?.toLowerCase();
    
    switch (platformLower) {
      case 'instagram':
        return (
          <div className="bg-gradient-to-r from-purple-500 via-violet-500 to-orange-400 p-3 flex items-center gap-3 text-white">
            <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
              <User className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-sm">{recipientName}</p>
              <p className="text-xs text-white/70">Instagram • Active now</p>
            </div>
            <div className="flex gap-2">
              <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 20.664a9.163 9.163 0 0 1-6.521-2.702.977.977 0 0 1 1.381-1.381 7.269 7.269 0 0 0 10.024.244.977.977 0 0 1 1.313 1.445A9.163 9.163 0 0 1 12 20.664z"/></svg>
              </div>
            </div>
          </div>
        );
      
      case 'twitter':
      case 'x':
        return (
          <div className="bg-black p-3 flex items-center gap-3 text-white">
            <div aria-hidden="true" className="p-1"><ChevronLeft className="w-5 h-5" /></div>
            <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center">
              <User className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <p className="font-bold text-sm">{recipientName}</p>
              <p className="text-xs text-gray-400">@{recipientName?.toLowerCase().replace(/\s/g, '')}</p>
            </div>
            <div className="w-8 h-8 rounded-full hover:bg-gray-800 flex items-center justify-center">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="17" r="1.5"/></svg>
            </div>
          </div>
        );
      
      case 'linkedin':
        return (
          <div className="bg-background p-3 flex items-center gap-3 border-b">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-700 rounded flex items-center justify-center text-white font-bold">
              {recipientName?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="flex-1">
              <p className="font-semibold text-sm text-foreground">{recipientName}</p>
              <p className="text-xs text-muted-foreground">LinkedIn Member</p>
            </div>
            <div className="flex gap-2">
              <div className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center">
                <svg className="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" /></svg>
              </div>
            </div>
          </div>
        );
      
      case 'facebook':
        return (
          <div className="bg-background p-3 flex items-center gap-3 border-b">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center text-white font-bold">
              {recipientName?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="flex-1">
              <p className="font-semibold text-sm">{recipientName}</p>
              <p className="text-xs text-green-500 flex items-center gap-1">
                <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                Active now
              </p>
            </div>
            <div className="flex gap-2">
              <div className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center text-blue-500">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z"/></svg>
              </div>
            </div>
          </div>
        );
      
      default:
        return (
          <div className="flex min-w-0 items-center gap-3 border-b bg-muted p-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-muted to-muted/80">
              <User className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{recipientName}</p>
              <p className="text-xs text-muted-foreground">Direct Message</p>
            </div>
          </div>
        );
    }
  };

  // Platform-specific message bubble colors
  const getMessageBubbleColor = () => {
    switch (platform?.toLowerCase()) {
      case 'instagram':
        return 'bg-gradient-to-br from-purple-500 to-violet-500 text-white';
      case 'twitter':
      case 'x':
        return 'bg-blue-400 text-white';
      case 'linkedin':
        return 'bg-[#0a66c2] text-white';
      case 'facebook':
        return 'bg-gradient-to-br from-blue-500 to-blue-600 text-white';
      default:
        return 'bg-blue-500 text-white';
    }
  };

  if (variant === "preview") {
    return (
      <div className="border rounded-lg p-4 hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-cyan-600" />
            <span className="font-medium text-sm">{title}</span>
          </div>
          {status && (
            <StatusBadge status={status} label={status} />
          )}
        </div>
        <div className="flex items-center gap-2 mb-2">
          {platform && (
            <Badge className={`text-xs ${getPlatformColor(platform)}`}>{platform}</Badge>
          )}
          <span className="text-xs text-muted-foreground">To: {recipientName}</span>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-3">{message}</p>
        {createdAt && (
          <p className="text-xs text-muted-foreground/60 mt-2">{new Date(createdAt).toLocaleDateString()}</p>
        )}
      </div>
    );
  }

  return (
    <Card className="min-w-0 overflow-hidden transition-shadow hover:shadow-md">
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
        <div className="mb-2 flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="shrink-0 rounded-lg bg-cyan-100 p-2">
              <MessageSquare className="h-5 w-5 text-cyan-600" />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge className="bg-cyan-100 text-cyan-700">DM</Badge>
              {platform && (
                <Badge className={`text-xs ${getPlatformColor(platform)}`}>{platform}</Badge>
              )}
              {status && (
                <StatusBadge status={status} label={status} />
              )}
            </div>
          </div>
          {showActions && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowFullscreen(true)} aria-label="View fullscreen" title="View Fullscreen">
                <Maximize2 className="h-4 w-4" />
              </Button>
              <CopyButton variant="ghost" iconOnly className="h-8 w-8" value={copyContent} onCopied={() => toast({ title: "Copied", description: "Social message copied to clipboard" })} />
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
                      <AlertDialogTitle>Delete Social Message?</AlertDialogTitle>
                      <AlertDialogDescription>This action cannot be undone. The social message will be permanently deleted.</AlertDialogDescription>
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
        {/* DM Chat Preview */}
        <div className="border rounded-xl overflow-hidden">
          {/* Platform-specific Chat Header */}
          {renderPlatformDMHeader()}
          
          {/* Chat Messages */}
          <div className={`p-4 min-h-[150px] space-y-3 ${platform?.toLowerCase() === 'twitter' || platform?.toLowerCase() === 'x' ? 'bg-black' : 'bg-muted/50'}`}>
            {/* Subject (if any) */}
            {parsedContent.subject && (
              <div className="text-center text-xs text-muted-foreground mb-2">
                <span className="bg-muted px-2 py-1 rounded">Subject: {parsedContent.subject}</span>
              </div>
            )}
            
            {/* Message bubble - outgoing */}
            <div className="flex justify-end">
              <div className={`max-w-[80%] ${getMessageBubbleColor()} rounded-2xl rounded-br-sm px-4 py-2`}>
                {parsedContent.greeting && (
                  <p className="text-sm mb-1">{parsedContent.greeting}</p>
                )}
                <p className="text-sm whitespace-pre-wrap">{message}</p>
                {parsedContent.closing && (
                  <p className="text-sm mt-2">{parsedContent.closing}</p>
                )}
                {parsedContent.signature && (
                  <p className="text-sm font-medium mt-1">{parsedContent.signature}</p>
                )}
              </div>
            </div>
            
            {/* Timestamp */}
            <div className={`flex justify-end items-center gap-1 text-xs ${platform?.toLowerCase() === 'twitter' || platform?.toLowerCase() === 'x' ? 'text-gray-500' : 'text-muted-foreground'}`}>
              <span>Now</span>
              <CheckCheck className="w-3 h-3" />
            </div>
          </div>
          
          {/* Input Bar */}
          <div className={`p-3 border-t flex items-center gap-2 ${platform?.toLowerCase() === 'twitter' || platform?.toLowerCase() === 'x' ? 'bg-black border-gray-800' : 'bg-background'}`}>
            <div className={`flex-1 rounded-full px-4 py-2 text-sm ${platform?.toLowerCase() === 'twitter' || platform?.toLowerCase() === 'x' ? 'bg-gray-800 text-gray-500' : 'bg-muted text-muted-foreground'}`}>
              Write a message...
            </div>
            <div aria-hidden="true" className={`flex h-9 w-9 items-center justify-center rounded-full ${platform?.toLowerCase() === 'twitter' || platform?.toLowerCase() === 'x' ? 'text-blue-400' : 'text-blue-500'}`}>
              <Send className="w-4 h-4" />
            </div>
          </div>
        </div>

        {createdAt && (
          <p className="text-xs text-muted-foreground/60 mt-3 text-center">
            Created {new Date(createdAt).toLocaleDateString()}
          </p>
        )}

        {/* Media Display & Auto-generating Indicator */}
        {showActions && (() => {
          // Show existing media
          const imageUrl = parsedContent.imageUrl || propImageUrls?.[0];
          const videoUrl = parsedContent.videoUrl || propVideoUrls?.[0];
          
          if (imageUrl || videoUrl) {
            return (
              <div className="pt-3 border-t mt-3 space-y-3">
                {imageUrl && (
                  <div className="aspect-video rounded-lg overflow-hidden border">
                    <img src={normalizeUploadUrl(imageUrl)} alt="Message Image" className="w-full h-full object-cover" />
                  </div>
                )}
                {videoUrl && (
                  <div className="aspect-video rounded-lg overflow-hidden border bg-black">
                    <video src={normalizeUploadUrl(videoUrl)} controls className="w-full h-full object-contain" />
                  </div>
                )}
              </div>
            );
          }
          
          // Show auto-generating indicator
          const showImageGenerating = isGeneratingImage && parsedContent.imagePrompt && !imageUrl;
          const showVideoGenerating = isGeneratingVideo && parsedContent.videoPrompt && !videoUrl;
          
          const showImageMissing = !isGeneratingImage && parsedContent.imagePrompt && !imageUrl;
          const showVideoMissing = !isGeneratingVideo && parsedContent.videoPrompt && !videoUrl;
          
          if (!showImageGenerating && !showVideoGenerating && !showImageMissing && !showVideoMissing) return null;
          
          return (
            <div className="pt-3 border-t mt-3 p-4 space-y-2">
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

        {onSend && (
          <Button 
            className="w-full mt-4 gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 text-white font-medium shadow-sm"
            onClick={onSend}
          >
            <Send className="w-4 h-4" />
            Send DM Message
          </Button>
        )}

        {/* Outreach Agent Recommendation */}
        {onHireAgent && showActions && (
          <div className="pt-3 border-t mt-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-2">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-primary p-1.5">
                  <Rocket className="w-3 h-3 text-white" />
                </div>
                <div>
                  <p className="text-xs font-medium">Ready to send?</p>
                  <p className="text-xs text-muted-foreground">Hire Emily for automated DM campaigns</p>
                </div>
              </div>
              <Button
                size="sm"
                className="h-7 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                onClick={() => onHireAgent('OutreachAgent', 'Start a social media DM outreach campaign with this message template')}
              >
                Launch Outreach <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {/* Fullscreen Modal */}
      <ContentFullscreenModal
        open={showFullscreen}
        onOpenChange={setShowFullscreen}
        contentType="social_message"
        title={title}
        content={content}
        status={status}
        channel={channel || platform}
        createdAt={createdAt}
        imageUrls={propImageUrls}
        videoUrls={propVideoUrls}
        prompt={prompt}
        imagePrompt={parsedContent.imagePrompt}
        videoPrompt={parsedContent.videoPrompt}
      />
    </Card>
  );
}
