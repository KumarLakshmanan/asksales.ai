"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Image as ImageIcon,
  Mail,
  Megaphone,
  MessageCircle,
  Pencil,
  Play,
  Send,
  Smartphone,
  Trash2,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { copyText } from "@/components/ui/copy-button";
import { DEFAULT_BUSINESS_TIMEZONE } from "@/lib/timezoneDefaults";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { normalizeUploadUrl } from "@/lib/utils";
import { buildContentMedia } from "@/lib/contentMedia";
import { MediaGenerationPlaceholder, isMediaGenerating } from "@/components/content-studio/MediaGenerationPlaceholder";
import { TemplateVersionHistory } from "@/components/content-library/TemplateVersionHistory";
import { ReusableTemplateActions } from '@/components/content-library/ReusableTemplateActions';

export type TemplatePreviewKind = "ad" | "blog" | "dm" | "email" | "image" | "sms" | "social" | "video";

const KIND_META: Record<TemplatePreviewKind, { label: string; icon: LucideIcon }> = {
  ad: { label: "Ad copy", icon: Megaphone },
  blog: { label: "Blog post", icon: FileText },
  dm: { label: "Direct message", icon: MessageCircle },
  email: { label: "Email", icon: Mail },
  image: { label: "Image", icon: ImageIcon },
  sms: { label: "SMS", icon: Smartphone },
  social: { label: "Social post", icon: Send },
  video: { label: "Video", icon: Video },
};

function cleanText(value: string) {
  return value
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*>`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCopy(content: string, explicitSubject?: string) {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(content);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  const read = (...keys: string[]) => {
    for (const key of keys) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  };

  const heading = explicitSubject || read("subject", "headline", "title", "heading");
  const body = read("body", "primaryText", "caption", "message", "content", "text") || content;
  return { heading: cleanText(heading), body: cleanText(body) };
}

interface TemplatePreviewCardProps {
  additionalActions?: ReactNode;
  reusableTemplateId?: number;
  kind: TemplatePreviewKind;
  title: string;
  content: string;
  subject?: string;
  description?: string;
  category?: string;
  status?: string;
  createdAt?: string | number;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoUrls?: string[];
  onPreview?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onPrimary?: () => void;
  primaryLabel?: string;
}

export function TemplatePreviewCard({
  additionalActions,
  reusableTemplateId,
  kind,
  title,
  content,
  subject,
  description,
  category,
  status,
  createdAt,
  imageUrl,
  imageUrls,
  videoUrl,
  videoUrls,
  onPreview,
  onEdit,
  onDelete,
  onCopy,
  onPrimary,
  primaryLabel = "Open",
}: TemplatePreviewCardProps) {
  const { toast } = useToast();
  const [mediaIndex, setMediaIndex] = useState(0);
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const extracted = extractCopy(content, subject);
  const displayBody = extracted.body || cleanText(description || "");
  const displayDate = createdAt
    ? new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: DEFAULT_BUSINESS_TIMEZONE }).format(new Date(createdAt))
    : null;
  const media = buildContentMedia({ imageUrl, imageUrls, videoUrl, videoUrls });
  const currentMedia = media.items[mediaIndex] || media.items[0];
  const generationInProgress = isMediaGenerating(status) && media.items.length === 0;

  useEffect(() => {
    if (mediaIndex >= media.items.length) setMediaIndex(0);
  }, [media.items.length, mediaIndex]);

  const copy = async () => {
    if (onCopy) return onCopy();
    await copyText([extracted.heading, displayBody].filter(Boolean).join("\n\n"));
    toast({ title: "Copied", description: `${meta.label} copied to the clipboard.` });
  };

  return (
    <article className="group flex h-full min-h-[330px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md">
      <div className="h-1 w-full bg-primary" />

      {generationInProgress ? (
        <MediaGenerationPlaceholder
          kind={kind === "image" || kind === "video" ? kind : "content"}
          compact
          className="aspect-[16/9] min-h-0 border-b border-border"
        />
      ) : currentMedia ? (
        <div className="relative aspect-[16/9] overflow-hidden border-b border-border bg-muted">
          {currentMedia.type === "image" ? (
            <img src={normalizeUploadUrl(currentMedia.url)} alt="" className="h-full w-full object-cover" />
          ) : (
            <video src={normalizeUploadUrl(currentMedia.url)} className="h-full w-full bg-black object-contain" muted preload="metadata" />
          )}
          {currentMedia.type === "video" && <span className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-background/90 shadow"><Play className="h-4 w-4 fill-current" /></span></span>}
          {media.items.length > 1 && (
            <>
              <button
                type="button"
                className="absolute left-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white transition-colors hover:bg-black/80"
                onClick={(event) => { event.stopPropagation(); setMediaIndex((current) => current === 0 ? media.items.length - 1 : current - 1); }}
                aria-label={`Previous media for ${title}`}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white transition-colors hover:bg-black/80"
                onClick={(event) => { event.stopPropagation(); setMediaIndex((current) => current === media.items.length - 1 ? 0 : current + 1); }}
                aria-label={`Next media for ${title}`}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="absolute right-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-semibold text-white">
                {mediaIndex + 1}/{media.items.length}
              </span>
              <span className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
                {media.items.map((item, index) => (
                  <button
                    type="button"
                    key={`${item.type}-${item.url}`}
                    onClick={(event) => { event.stopPropagation(); setMediaIndex(index); }}
                    className={`h-1.5 w-1.5 rounded-full ${index === mediaIndex ? "bg-white" : "bg-white/45"}`}
                    aria-label={`Show media ${index + 1} for ${title}`}
                  />
                ))}
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="relative min-h-[132px] border-b border-border bg-muted/20 p-5">
          <div className="absolute inset-y-5 left-0 w-0.5 bg-primary/40" />
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-primary">
            <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {meta.label}
          </div>
          {extracted.heading ? (
            <p className="mt-4 line-clamp-2 text-sm font-semibold leading-5">{extracted.heading}</p>
          ) : (
            <div className="mt-4 space-y-2" aria-hidden="true">
              <div className="h-2 w-5/6 rounded-full bg-foreground/15" />
              <div className="h-2 w-2/3 rounded-full bg-foreground/10" />
            </div>
          )}
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{displayBody || description || "Reusable content draft"}</p>
        </div>
      )}

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="line-clamp-2 text-sm font-semibold leading-5">{title}</p>
            {description && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {status && <Badge variant="outline" className="shrink-0 capitalize">{status}</Badge>}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>{meta.label}</span>
          {category && <><span aria-hidden="true">·</span><span className="capitalize">{category}</span></>}
          {displayDate && <><span aria-hidden="true">·</span><span>{displayDate}</span></>}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-border pt-3">
          {onPrimary && (
            <Button size="sm" variant="ghost" className="mr-auto h-8 gap-1.5 px-2 text-xs text-primary" onClick={onPrimary}>
              {primaryLabel}<ArrowUpRight className="h-3.5 w-3.5" />
            </Button>
          )}
          {onPreview && <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onPreview} aria-label={`Preview ${title}`} title="Preview"><ArrowUpRight className="h-3.5 w-3.5" /></Button>}
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void copy()} aria-label={`Copy ${title}`} title="Copy"><Copy className="h-3.5 w-3.5" /></Button>
          {onEdit && <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onEdit} aria-label={`Edit ${title}`} title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
          {reusableTemplateId && <TemplateVersionHistory templateId={reusableTemplateId} templateName={title} />}
          {onDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild><Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={`Delete ${title}`} title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>Delete this item?</AlertDialogTitle><AlertDialogDescription>“{title}” will be permanently removed from the content library.</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        {additionalActions}
        {reusableTemplateId && onEdit && <ReusableTemplateActions templateId={reusableTemplateId} kind={kind} />}
      </div>
    </article>
  );
}
