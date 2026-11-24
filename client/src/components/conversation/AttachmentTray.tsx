import { AlertCircle, File, FileImage, FileText, Paperclip, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import type { ConversationAttachmentView } from "./types";

interface AttachmentTrayProps {
  attachments: ConversationAttachmentView[];
  onRemove?: (id: string | number) => void;
  className?: string;
  compact?: boolean;
}
function formatSize(size?: number) {
  if (size == null) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentIcon({ attachment }: { attachment: ConversationAttachmentView }) {
  if (attachment.status === "uploading") return <Spinner size="xs" label={null} className="text-info" />;
  if (attachment.status === "failed" || attachment.status === "blocked") return <AlertCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />;
  if (attachment.mimeType?.startsWith("image/")) return <FileImage className="h-3.5 w-3.5 text-info" aria-hidden="true" />;
  if (attachment.mimeType?.includes("pdf") || attachment.mimeType?.includes("document")) return <FileText className="h-3.5 w-3.5 text-primary" aria-hidden="true" />;
  return attachment.href ? <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> : <File className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
}

export function AttachmentTray({ attachments, onRemove, className, compact = true }: AttachmentTrayProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn("flex max-h-28 flex-wrap gap-1.5 overflow-y-auto", className)} aria-label="Attachments">
      {attachments.map((attachment) => {
        const content = (
          <>
            <AttachmentIcon attachment={attachment} />
            <span className={cn("min-w-0 truncate font-medium", compact ? "max-w-36" : "max-w-56")}>{attachment.name}</span>
            {formatSize(attachment.size) ? <span className="shrink-0 tabular-nums text-muted-foreground">{formatSize(attachment.size)}</span> : null}
            {attachment.detail ? <span className="hidden truncate text-muted-foreground sm:inline">{attachment.detail}</span> : null}
          </>
        );
        const itemClass = cn(
          "flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/35 px-2.5 py-1.5 text-[11px] text-foreground",
          (attachment.status === "failed" || attachment.status === "blocked") && "border-destructive/30 bg-destructive/5",
        );
        return (
          <div key={attachment.id} className={itemClass}>
            {attachment.href ? <a href={attachment.href} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 hover:underline">{content}</a> : content}
            {onRemove ? (
              <button type="button" onClick={() => onRemove(attachment.id)} className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remove ${attachment.name}`}>
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
