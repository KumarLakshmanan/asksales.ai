import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusBadge } from "@/components/ui/status-badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Image, Edit, Trash2, Download, Maximize2, Share2, Megaphone, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ContentFullscreenModal } from "@/components/modals";
import { normalizeUploadUrl } from "@/lib/utils";
import { getSourceColor } from "@/lib/content-utils";
import { getSourceLabel } from "@/components/content-cards/cardValues";
import { fetchWithReadRetry } from "@/lib/api-client";

export interface ImageCardProps {
  id?: number;
  title: string;
  content?: string;
  imageUrl?: string;
  prompt?: string;
  status?: string;
  channel?: string;
  createdAt?: string;
  sourceType?: string; // 'social_post' | 'ad_copy' | 'social_dm' | 'content_studio'
  sourceTitle?: string;
  sourceCaption?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  variant?: "preview" | "full";
  showActions?: boolean;
}

export function formatContentAssetDate(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString();
}

export default function ImageCard({
  title,
  content,
  imageUrl,
  prompt,
  status,
  channel,
  createdAt,
  sourceType,
  sourceTitle,
  sourceCaption,
  onEdit,
  onDelete,
  variant = "full",
  showActions = true,
}: ImageCardProps) {
  const { toast } = useToast();
  const [showFullscreen, setShowFullscreen] = useState(false);
  const createdDate = formatContentAssetDate(createdAt);

  const copyContent = () => prompt || content || "";

  const handleDownload = async () => {
    if (!imageUrl) return;

    try {
      const normalizedUrl = normalizeUploadUrl(imageUrl);
      const response = await fetchWithReadRetry(normalizedUrl);
      if (!response.ok) throw new Error(`Download failed with status ${response.status}`);

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const sourceExtension = normalizedUrl.split(/[?#]/, 1)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1];
      const mimeExtension = blob.type.split("/")[1]?.replace("jpeg", "jpg");
      const extension = sourceExtension || mimeExtension || "png";
      const safeTitle = title.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "generated-image";
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${safeTitle}.${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch {
      toast({
        title: "Download failed",
        description: "The image could not be downloaded. Please try again.",
        variant: "destructive",
      });
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
        return <Image className="w-3 h-3"
 />;
    }
  };

  if (variant === "preview") {
    return (
      <div className="border rounded-lg overflow-hidden hover:shadow-md transition-shadow">
        {imageUrl && (
          <div className="aspect-video bg-muted relative">
            <img
              src={normalizeUploadUrl(imageUrl)}
              alt={title}
              className="w-full h-full object-cover"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </div>
        )}
        <div className="p-2">
          <div className="flex items-start justify-between mb-1">
            <span className="font-medium text-sm truncate">{title}</span>
            {status && (
              <StatusBadge status={status} label={status} />
            )}
          </div>
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
            {createdDate && <span>{createdDate}</span>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card className="min-w-0 overflow-hidden transition-shadow hover:shadow-md">
      {imageUrl && (
        <div className="aspect-video bg-muted relative group">
          <img
            src={normalizeUploadUrl(imageUrl)}
            alt={title}
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
            <Button size="sm" variant="secondary" onClick={handleDownload}>
              <Download className="h-4 w-4 mr-1" />
              Download
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowFullscreen(true)}>
              <Maximize2 className="h-4 w-4 mr-1" />
              Preview
            </Button>
          </div>
        </div>
      )}
      <CardHeader className="space-y-2 pb-2">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="shrink-0 rounded-lg bg-primary/10 p-2">
              <Image className="h-5 w-5 text-primary" />
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
              </div>
            </div>
          </div>
        </div>
        {showActions && (
          <div className="flex items-center justify-end gap-1 border-t border-border/60 pt-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowFullscreen(true)} aria-label="Expand image" title="Expand image">
              <Maximize2 className="h-4 w-4" />
            </Button>
            <CopyButton variant="ghost" iconOnly className="h-8 w-8" value={copyContent} onCopied={() => toast({ title: "Copied", description: "Image prompt copied to clipboard" })} />
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
                    <AlertDialogTitle>Delete Image?</AlertDialogTitle>
                    <AlertDialogDescription>This action cannot be undone. The image will be permanently deleted.</AlertDialogDescription>
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
      {(sourceTitle || sourceCaption || createdDate) && (
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
          {createdDate && (
            <p className="text-xs text-muted-foreground/60 mt-3">
              Created {createdDate}
            </p>
          )}
        </CardContent>
      )}
      <ContentFullscreenModal
        open={showFullscreen}
        onOpenChange={setShowFullscreen}
        contentType="image"
        title={title}
        content={content || ""}
        status={status}
        channel={channel}
        createdAt={createdAt}
        imageUrl={imageUrl}
        prompt={prompt || content}
        customActions={imageUrl ? (
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="mr-1 h-4 w-4" />
            Download
          </Button>
        ) : undefined}
      />
    </Card>
  );
}
