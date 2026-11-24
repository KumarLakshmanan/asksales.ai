"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import DOMPurify from "dompurify";
import { cn } from "@/lib/utils";
import { buildApiUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { ConversationMessageFrame } from "@/components/conversation/ConversationMessageFrame";
import { AttachmentTray } from "@/components/conversation/AttachmentTray";
import { SourceTray } from "@/components/conversation/SourceTray";
import { AttachmentExtractionNotices } from "./AttachmentExtractionNotices";
import { SupportMediaPreview } from "./SupportMediaPreview";
import { ResponseProvenance } from "./ResponseProvenance";
import { SupportAnswerFeedback, type SupportStaffFeedback } from "./SupportAnswerFeedback";
import { supportReplyStatus } from "@/lib/support-transcript";
import { fetchWithReadRetry } from "@/lib/api-client";

type SupportAttachment = {
  id?: string; fileId?: number; assetId?: number; fileName?: string; filename?: string; originalName?: string;
  path?: string; url?: string; contentType?: string; mimeType?: string; altText?: string; size?: number; extractionStatus?: string;
};
export interface SupportTranscriptMessage {
  id: number; role: string; content: string; createdAt: string; processingStatus?: string | null; sources?: unknown; confidence?: number | null;
  metadata?: {
    channel?: string;
    attachments?: SupportAttachment[] | null;
    provenance?: React.ComponentProps<typeof ResponseProvenance>["provenance"];
    staffFeedback?: SupportStaffFeedback;
  } | null;
}

export function parseSupportSources(value: unknown): { title?: string; excerpt?: string; similarity?: number; sourceUrl?: string; sourceId?: number }[] {
  if (typeof value === "string") {
    try { return parseSupportSources(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.filter((source) => source && typeof source === "object") : [];
}

const safeHref = (value?: string) => value && (/^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)) ? value : undefined;
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function MessageBody({ message }: { message: SupportTranscriptMessage }) {
  if (message.role !== "assistant") return <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>;
  switch (message.metadata?.channel) {
    case "whatsapp": {
      const html = escapeHtml(message.content).replace(/\*(.*?)\*/g, "<strong>$1</strong>").replace(/_(.*?)_/g, "<em>$1</em>").replace(/~(.*?)~/g, "<del>$1</del>").replace(/\n/g, "<br />");
      return <div className="whitespace-pre-wrap text-sm leading-6" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
    }
    case "instagram":
    case "facebook": return <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>;
    case "email": return <div className="prose prose-sm max-w-none dark:prose-invert prose-p:leading-7" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.content, { FORBID_TAGS: ["style", "form", "input", "iframe"], FORBID_ATTR: ["style"] }) }} />;
    default: return <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-2 prose-p:leading-7 prose-headings:font-semibold prose-h2:text-base prose-h3:text-sm"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{message.content}</ReactMarkdown></div>;
  }
}

function MessageAttachments({ attachments = [] }: { attachments?: SupportAttachment[] }) {
  if (!attachments.length) return null;
  const images = attachments.filter((file) => file.assetId && (file.mimeType || file.contentType || "").startsWith("image/"));
  return <div className="space-y-2">
    {!!images.length && <div className="mt-3 grid gap-3 sm:grid-cols-2">{images.map((file) => <figure key={file.assetId}><SupportMediaPreview assetId={file.assetId!} alt={file.altText || file.originalName || "Support image"} /><figcaption className="mt-1 text-xs text-muted-foreground">{file.originalName || "Support image"}</figcaption></figure>)}</div>}
    <AttachmentTray compact={false} className="mt-3 border-t border-border/50 pt-3" attachments={attachments.map((file, index) => ({ id: file.id || file.fileId || `attachment-${index}`, name: file.originalName || file.fileName || file.filename || "Attachment", mimeType: file.mimeType || file.contentType, size: file.size, href: file.assetId || (file.url || file.path)?.startsWith("/api/") ? undefined : safeHref(file.url || file.path), status: "ready" }))} />
    {attachments.filter(file => !file.assetId && (file.url || file.path)?.startsWith("/api/")).map((file, index) => <SupportAttachmentDownload key={file.id || file.fileId || index} file={file} />)}
    <AttachmentExtractionNotices attachments={attachments} />
  </div>;
}

function SupportAttachmentDownload({ file }: { file: SupportAttachment }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const name = file.originalName || file.fileName || file.filename || "Attachment";
  return <div><Button variant="outline" className="min-h-11 text-xs" disabled={busy} onClick={async () => {
    const request = new AbortController(); controller.current = request; setBusy(true); setError("");
    try {
      const response = await fetchWithReadRetry(buildApiUrl(file.url || file.path!), { headers: getAuthHeaders(), credentials: "include", signal: request.signal });
      if (!response.ok) throw new Error(response.status === 404 || response.status === 410 ? "This file is unavailable or expired. Upload it again to use it." : "The attachment could not be downloaded. Try again.");
      const blob = await response.blob();
      if (request.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = objectUrl; link.download = name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "The attachment could not be downloaded. Try again."); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }}>{busy ? "Downloading…" : `Download ${name}`}</Button>{error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}</div>;
}

function SupportTranscriptEntry({ message, userLabel, feedbackEnabled, onFeedbackSaved }: { message: SupportTranscriptMessage; userLabel: string; feedbackEnabled: boolean; onFeedbackSaved?: () => void }) {
  const [copyError, setCopyError] = useState("");
  const sources = parseSupportSources(message.sources);
  const assistant = message.role === "assistant";
  const replyStatus = supportReplyStatus(message);
  const date = new Date(message.createdAt);
  return <ConversationMessageFrame role={assistant ? "assistant" : "user"} surface="support" showAvatar={false} name={assistant ? "Support assistant" : userLabel} timestamp={Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} contentClassName={cn("[overflow-wrap:anywhere]", !assistant && "border-border bg-muted/60 text-foreground shadow-none")} ariaLabel={`${assistant ? "Support Assistant" : userLabel}: ${message.content.slice(0, 120)}`}>
    <div className="flex min-w-0 flex-col [overflow-wrap:anywhere] [&_img]:max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
      {replyStatus && <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">{replyStatus}</p>}
      <MessageBody message={message} />
      <MessageAttachments attachments={message.metadata?.attachments || []} />
      {assistant && <>
        <SourceTray className="mt-4 [&_button]:min-h-11" sources={sources.map((source, index) => ({ id: `${message.id}-${index}`, title: source.title || `Source ${index + 1}`, excerpt: source.excerpt, similarity: source.similarity, href: Number.isSafeInteger(source.sourceId) && Number(source.sourceId) > 0 ? `/dashboard/knowledge-base/${source.sourceId}` : safeHref(source.sourceUrl) }))} confidence={message.confidence} label="knowledge sources" />
        <ResponseProvenance provenance={message.metadata?.provenance} />
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border/40 pt-1">
          <CopyButton variant="ghost" size="sm" className="min-h-11 gap-1.5 px-2 text-xs text-muted-foreground" value={message.content} label="Copy reply" onCopied={() => setCopyError("")} onError={() => setCopyError("Reply could not be copied. Select the text and copy it manually.")} />
          {feedbackEnabled && message.id > 0 && !replyStatus && <SupportAnswerFeedback messageId={message.id} feedback={message.metadata?.staffFeedback} onSaved={onFeedbackSaved} />}
        </div>
        {copyError && <p role="alert" className="text-xs text-destructive">{copyError}</p>}
      </>}
    </div>
  </ConversationMessageFrame>;
}

/** Shared display for the working chat and the read-only reporting transcript. */
export function SupportConversationTranscript({ messages, userLabel = "You", feedbackEnabled = true, onFeedbackSaved, className }: { messages: readonly SupportTranscriptMessage[]; userLabel?: string; feedbackEnabled?: boolean; onFeedbackSaved?: () => void; className?: string }) {
  return <div role="list" aria-label="Conversation messages" className={cn("mx-auto w-full min-w-0 max-w-3xl space-y-7", className)}>{messages.map((message) => <SupportTranscriptEntry key={message.id} message={message} userLabel={userLabel} feedbackEnabled={feedbackEnabled} onFeedbackSaved={onFeedbackSaved} />)}</div>;
}
