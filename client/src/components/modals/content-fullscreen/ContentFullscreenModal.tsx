import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Image as ImageIcon,
  Video,
  Mail,
  Smartphone,
  MessageSquare,
  Share2,
  Megaphone,
  Calendar,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uniqueMediaUrls } from "@/lib/contentMedia";
import { hashtagsMissingFromCaption } from "../../../../../shared/socialCaption";
import type { ContentFullscreenModalProps, MediaItem, ParsedContent, ContentType } from "./types";
import { formatDate, getPlatformColor, stripHtml } from "./utils";
import EmailContentRenderer from "./EmailContentRenderer";
import SmsContentRenderer from "./SmsContentRenderer";
import SocialMessageContentRenderer from "./SocialMessageContentRenderer";
import SocialPostContentRenderer from "./SocialPostContentRenderer";
import AdCopyContentRenderer from "./AdCopyContentRenderer";
import MediaCarousel from "./MediaCarousel";
import { readEmailDraft, emailDraftHtml } from "@/lib/emailTemplateSections";

// Get icon and colors based on content type
const getTypeConfig = (contentType: ContentType) => {
  switch (contentType) {
    case "image":
      return {
        icon: <ImageIcon className="h-5 w-5" />,
        bgColor: "bg-blue-100 dark:bg-blue-950/60",
        textColor: "text-blue-700 dark:text-blue-300",
        label: "Image",
      };
    case "video":
      return {
        icon: <Video className="h-5 w-5" />,
        bgColor: "bg-violet-100 dark:bg-violet-950/60",
        textColor: "text-violet-700 dark:text-violet-300",
        label: "Video",
      };
    case "email":
      return {
        icon: <Mail className="h-5 w-5" />,
        bgColor: "bg-green-100",
        textColor: "text-green-600",
        label: "Email Template",
      };
    case "sms":
      return {
        icon: <Smartphone className="h-5 w-5" />,
        bgColor: "bg-yellow-100",
        textColor: "text-yellow-600",
        label: "SMS Template",
      };
    case "social_message":
      return {
        icon: <MessageSquare className="h-5 w-5" />,
        bgColor: "bg-cyan-100",
        textColor: "text-cyan-600",
        label: "Social Message",
      };
    case "social_post":
      return {
        icon: <Share2 className="h-5 w-5" />,
        bgColor: "bg-violet-100",
        textColor: "text-violet-600",
        label: "Social Post",
      };
    case "ad_copy":
      return {
        icon: <Megaphone className="h-5 w-5" />,
        bgColor: "bg-orange-100",
        textColor: "text-orange-600",
        label: "Ad Copy",
      };
    default:
      return {
        icon: <Share2 className="h-5 w-5" />,
        bgColor: "bg-gray-100",
        textColor: "text-gray-600",
        label: "Content",
      };
  }
};

export default function ContentFullscreenModal({
  open,
  onOpenChange,
  contentType,
  title,
  content,
  status,
  channel,
  platform,
  createdAt,
  imageUrl,
  videoUrl,
  imageUrls,
  videoUrls,
  prompt,
  imagePrompt,
  videoPrompt,
  customActions,
}: ContentFullscreenModalProps) {
  const { toast } = useToast();

  // Parse content based on type
  const rawParsedContent: ParsedContent = (() => {
    try {
      return JSON.parse(content);
    } catch {
      return { body: content, message: content, content };
    }
  })();
  const parsedContent: ParsedContent = contentType === "email"
    ? readEmailDraft(content).sections as ParsedContent
    : rawParsedContent;

  // Build media items for carousel - only include valid URLs, not prompts or placeholders
  const isRenderableMediaUrl = (url: string) => url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http') || url.startsWith('/');
  const allImages = uniqueMediaUrls(
    imageUrls,
    imageUrl,
    parsedContent.imageUrls,
    parsedContent.imageUrl,
  ).filter(isRenderableMediaUrl);
  const allVideos = uniqueMediaUrls(
    videoUrls,
    videoUrl,
    parsedContent.videoUrls,
    parsedContent.videoUrl,
  ).filter(isRenderableMediaUrl);
  const mediaItems: MediaItem[] = [
    ...allImages.map((url) => ({ type: "image" as const, url })),
    ...allVideos.map((url) => ({ type: "video" as const, url })),
  ];

  // Add placeholders if no actual media is generated yet, but prompts exist
  if (allImages.length === 0) {
    const prompts = parsedContent.imagePrompts?.length 
      ? parsedContent.imagePrompts 
      : (imagePrompt ? [imagePrompt] : []);
    
    prompts.forEach(prompt => {
      mediaItems.push({ type: "image_placeholder", prompt });
    });
  }

  if (allVideos.length === 0) {
    const prompts = parsedContent.videoPrompts?.length 
      ? parsedContent.videoPrompts 
      : (videoPrompt ? [videoPrompt] : []);
      
    prompts.forEach(prompt => {
      mediaItems.push({ type: "video_placeholder", prompt });
    });
  }

  const typeConfig = getTypeConfig(contentType);

  const copyContent = () => {
    let textToCopy = "";
    switch (contentType) {
      case "image":
      case "video":
        textToCopy = prompt || content;
        break;
      case "email":
        textToCopy = `Subject: ${readEmailDraft(content).subject || title}\n\n${stripHtml(readEmailDraft(content).body)}`;
        break;
      case "sms":
        textToCopy = parsedContent.message || content;
        break;
      case "social_message":
        textToCopy = [
          parsedContent.subject ? `Subject: ${parsedContent.subject}` : "",
          parsedContent.greeting,
          parsedContent.message || parsedContent.body,
          parsedContent.closing,
          parsedContent.signature,
        ]
          .filter(Boolean)
          .join("\n\n");
        break;
      case "social_post": {
        const caption = String(parsedContent.content || parsedContent.caption || parsedContent.body || "");
        textToCopy = [caption, hashtagsMissingFromCaption(caption, parsedContent.hashtags).join(" ")]
          .filter(Boolean)
          .join("\n\n");
        break;
      }
      case "ad_copy":
        textToCopy = [
          parsedContent.headline,
          parsedContent.description,
          parsedContent.body || parsedContent.primaryText,
          parsedContent.callToAction,
        ]
          .filter(Boolean)
          .join("\n\n");
        break;
    }
    return textToCopy.trim();
  };

  const generateHtml = () => {
    return emailDraftHtml(content);
  };

  const downloadHtml = () => {
    const html = generateHtml();
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
     
    const timestamp = Date.now();
    link.download = `${contentType}-template-${timestamp}.html`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderContentByType = () => {
    const commonProps = {
      parsedContent,
      content,
      title,
      platform,
      channel,
    };

    switch (contentType) {
      case "image":
      case "video":
        return null;
      case "email":
        return (
          <EmailContentRenderer
            {...commonProps}
            generateHtml={generateHtml}
            downloadHtml={downloadHtml}
          />
        );
      case "sms":
        return <SmsContentRenderer {...commonProps} />;
      case "social_message":
        return <SocialMessageContentRenderer {...commonProps} />;
      case "social_post":
        return <SocialPostContentRenderer {...commonProps} />;
      case "ad_copy":
        return <AdCopyContentRenderer {...commonProps} />;
      default:
        return (
          <div className="p-4 bg-muted rounded-lg">
            <p className="whitespace-pre-wrap">{content}</p>
          </div>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(90dvh,900px)] w-[calc(100vw-2rem)] max-w-5xl flex-col overflow-hidden p-0">
        <DialogHeader className="flex-shrink-0 border-b border-border px-5 py-4 pr-12 sm:px-6">
          <DialogDescription className="sr-only">Content preview for {typeConfig.label}</DialogDescription>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className={`p-2 rounded-lg ${typeConfig.bgColor}`}>
                <span className={typeConfig.textColor}>{typeConfig.icon}</span>
              </div>
              <div className="min-w-0">
                <DialogTitle className="truncate text-lg sm:text-xl">{title}</DialogTitle>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Badge className={`${typeConfig.bgColor} ${typeConfig.textColor}`}>
                    {typeConfig.label}
                  </Badge>
                  {status && (
                    <StatusBadge status={status} label={status} />
                  )}
                  {(platform || channel) && (
                    <Badge className={`text-xs ${getPlatformColor(platform || channel)}`}>
                      {platform || channel}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <CopyButton
                value={copyContent}
                onCopied={() => toast({ title: "Copied", description: "Content copied to clipboard" })}
                onError={() => toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" })}
              />
              {customActions}
            </div>
          </div>
        </DialogHeader>

        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName="overscroll-contain"
        >
          <div className="space-y-6 p-5 sm:p-6">
            {/* Media Carousel */}
            {mediaItems.length > 0 && <MediaCarousel mediaItems={mediaItems} />}

            {/* Content Preview */}
            {renderContentByType()}

            <Separator />

            {/* Metadata */}
            <div className="space-y-3">
              <h4 className="font-semibold text-sm text-muted-foreground">Details</h4>
              <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                {createdAt && (
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Created:</span>
                    <span>{formatDate(createdAt)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Prompt Used */}
            {prompt && (
              <>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-sm text-muted-foreground">Prompt Used</h4>
                  <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-sm leading-relaxed">{prompt}</p>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
