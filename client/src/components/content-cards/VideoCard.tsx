import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useEffect, useState } from 'react';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusBadge } from "@/components/ui/status-badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Video, Edit, Trash2, Play, Maximize2, Share2, Megaphone, MessageSquare, Send, CheckCircle2, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getSourceColor } from "@/lib/content-utils";
import { ContentFullscreenModal } from "@/components/modals";
import { getSourceLabel } from "@/components/content-cards/cardValues";

function SavedVideoPreview({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); setAttempt(0); }, [url]);
  return <>
    <video key={`${url}:${attempt}`} aria-label={`${title} video preview`} src={url} controls preload="metadata"
      onError={() => setFailed(true)} onLoadedData={() => setFailed(false)} className="w-full h-full object-contain" />
    {failed && <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted p-3 text-center text-sm">
      <p>This saved video could not be loaded.</p>
      <Button size="sm" variant="outline" onClick={() => { setFailed(false); setAttempt(previous => previous + 1); }}>Retry loading video</Button>
    </div>}
  </>;
}

export function formatVideoDate(value: string | number): string {
  const timestamp = typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : value;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : 'Date unavailable';
}

export interface VideoCardProps {
  id?: number;
  title: string;
  content?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  prompt?: string;
  status?: string;
  channel?: string;
  createdAt?: string | number;
  sourceType?: string; // 'social_post' | 'ad_copy' | 'social_dm' | 'content_studio'
  sourceTitle?: string;
  sourceCaption?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onPublish?: () => void;
  publishedAt?: string;
  variant?: "preview" | "full";
  showActions?: boolean;
}

export default function VideoCard({
  title,
  content,
  videoUrl,
  thumbnailUrl,
  prompt,
  status,
  channel,
  createdAt,
  sourceType,
  sourceTitle,
  sourceCaption,
  onEdit,
  onDelete,
  onPublish,
  publishedAt,
  variant = "full",
  showActions = true,
}: VideoCardProps) {
  const { toast } = useToast();
  const [showFullscreen, setShowFullscreen] = useState(false);

  const copyContent = () => prompt || content || "";

  const handleDownload = () => {
    if (videoUrl) {
      const a = document.createElement('a');
      a.href = videoUrl;
      a.download = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.mp4`;
      a.click();
      toast({ title: "Downloaded", description: "Video download started" });
    }
  };

  const getSourceIcon = (type: string | undefined) => {
    switch (type?.toLowerCase()) {
      case "social_post":
        return <Share2 className="w-3 h-3" />;
      case "ad_copy":
        return <Megaphone className="w-3 h-3" />;
      case "social_dm":
        return <MessageSquare className="w-3 h-3" />;
      default:
        return <Video className="w-3 h-3" />;
    }
  };

  if (variant === "preview") {
    return (
      <div className="border rounded-lg overflow-hidden hover:shadow-md transition-shadow">
        <div className="aspect-video bg-muted relative">
          {thumbnailUrl ? (
            <img src={thumbnailUrl} alt={title} className="w-full h-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-primary/5">
              <Video className="h-12 w-12 text-primary/45" />
            </div>
          )}
          {videoUrl && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="p-3 bg-white/90 rounded-full">
                <Play className="h-6 w-6 text-primary" />
              </div>
            </div>
          )}
        </div>
        <div className="p-3">
          <div className="flex items-start justify-between mb-1">
            <span className="font-medium text-sm truncate">{title}</span>
            {status && (
              <StatusBadge status={status} label={status} />
            )}
          </div>
          {/* Source Info */}
          {sourceType && (
            <div className="flex items-center gap-2 mb-2">
              <Badge className={`text-xs ${getSourceColor(sourceType)} flex items-center gap-1`}>
                {getSourceIcon(sourceType)}
                {getSourceLabel(sourceType)}
              </Badge>
            </div>
          )}
          {sourceTitle && (
            <p className="text-xs font-medium text-foreground mb-1">{sourceTitle}</p>
          )}
          {sourceCaption && (
            <p className="text-xs text-muted-foreground line-clamp-2 mb-1">{sourceCaption}</p>
          )}
          {(prompt || content) && !sourceCaption && (
            <p className="text-xs text-muted-foreground line-clamp-2">{prompt || content}</p>
          )}
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground/60">
            {channel && <Badge variant="outline" className="text-xs">{channel}</Badge>}
            {createdAt !== undefined && <span>{formatVideoDate(createdAt)}</span>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card className="min-w-0 overflow-hidden transition-shadow hover:shadow-md">
      <div className="aspect-video bg-muted relative group">
        {videoUrl ? (
          <SavedVideoPreview url={videoUrl} title={title} />
        ) : thumbnailUrl ? (
          <img src={thumbnailUrl} alt={title} className="w-full h-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-primary/5">
            <Video className="h-16 w-16 text-primary/45" />
          </div>
        )}
      </div>
        {videoUrl && (
          <div className="flex flex-wrap justify-end gap-2 border-b p-2">
            <Button size="sm" variant="secondary" onClick={handleDownload}>
              <Download className="h-4 w-4 mr-1" />
              Download
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowFullscreen(true)}>
              <Maximize2 className="h-4 w-4 mr-1" />
              Preview
            </Button>
          </div>
        )}
      <CardHeader className="space-y-2 pb-2">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="shrink-0 rounded-lg bg-primary/10 p-2">
              <Video className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="line-clamp-2 break-words font-medium leading-snug">{title}</h4>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {sourceType && (
                  <Badge className={`text-xs ${getSourceColor(sourceType)} flex items-center gap-1`}>
                    {getSourceIcon(sourceType)}
                    {getSourceLabel(sourceType)}
                  </Badge>
                )}
                {status && (
                  <StatusBadge status={status} label={status} />
                )}
                {channel && <Badge variant="outline" className="text-xs">{channel}</Badge>}
                {publishedAt && (
                  <Badge className="text-xs bg-green-500 text-white flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Published
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>
        {showActions && (
          <div className="flex items-center justify-end gap-1 border-t border-border/60 pt-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowFullscreen(true)} aria-label="Expand video" title="Expand video">
              <Maximize2 className="h-4 w-4" />
            </Button>
            <CopyButton variant="ghost" iconOnly className="h-8 w-8" value={copyContent} onCopied={() => toast({ title: "Copied", description: "Video prompt copied to clipboard" })} />
            {onPublish && (
              <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600" onClick={onPublish} aria-label="Publish" title="Publish to YouTube">
                <Send className="h-4 w-4" />
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
                    <AlertDialogTitle>Delete Video?</AlertDialogTitle>
                    <AlertDialogDescription>This action cannot be undone. The video will be permanently deleted.</AlertDialogDescription>
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
      </CardHeader>
      {(sourceTitle || sourceCaption || createdAt !== undefined) && (
        <CardContent>
          {/* Source Content Info */}
          {(sourceTitle || sourceCaption) && (
            <div className="bg-gradient-to-r from-muted/50 to-muted rounded-lg p-3 border mb-3">
              {sourceTitle && (
                <p className="text-sm font-medium text-foreground mb-1">{sourceTitle}</p>
              )}
              {sourceCaption && (
                <p className="text-xs text-muted-foreground line-clamp-3">{sourceCaption}</p>
              )}
            </div>
          )}
          {createdAt !== undefined && (
            <p className="text-xs text-muted-foreground/60 mt-3">
              Created {formatVideoDate(createdAt)}
            </p>
          )}
        </CardContent>
      )}
      <ContentFullscreenModal
        open={showFullscreen}
        onOpenChange={setShowFullscreen}
        contentType="video"
        title={title}
        content={content || ""}
        status={status}
        channel={channel}
        createdAt={createdAt}
        videoUrl={videoUrl}
        prompt={prompt || content}
        customActions={videoUrl ? (
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="mr-1 h-4 w-4" />
            Download
          </Button>
        ) : undefined}
      />
    </Card>
  );
}
