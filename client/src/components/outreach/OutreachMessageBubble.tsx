import { EmailDeliveryActivity } from './EmailDeliveryActivity';
/**
 * OutreachMessageBubble - Shared message bubble for outreach pages
 * Supports dark mode and channel-specific theming
 */

import { outboundDeliveryDetail } from "@/lib/outreach-delivery-status";
import { 
  Clock, CheckCircle2, Circle, AlertCircle, Check, CheckCheck, Pencil, Paperclip, Download,
  FileText, FileSpreadsheet, ImageIcon, File, AudioLines, Film
} from "lucide-react";
import { normalizeUploadUrl, formatDateTimeIST, formatShortTimeIST, formatTimeIST } from "@/lib/utils";
import type { OutreachMessage, OutreachChannel, OutreachConversation } from "./types";
import { getChannelTheme, type ChannelTheme } from "./outreach-theme";
import { parseMessageContent } from "./useOutreachPage";
import { cleanEmailForDisplay } from "@/lib/emailUtils";
import DOMPurify from "dompurify";
import { DraftRecommendationCard } from "@/components/conversation/DraftRecommendationCard";
import { ConversationMessageFrame } from "@/components/conversation/ConversationMessageFrame";
import { EmailMessageContent } from "./EmailMessageContent";
import { messageOriginText } from "@/lib/outreach-message-origin";

interface OutreachMessageBubbleProps {
  message: OutreachMessage;
  channel: OutreachChannel;
  conversation?: OutreachConversation | null;
  /** Override theme (optional) */
  theme?: ChannelTheme;
  /** Show subject line (for email channels) */
  showSubject?: boolean;
  /** Whether to parse JSON content */
  parseContent?: boolean;
  /** Callback when user wants to edit a draft */
  onEditDraft?: (message: OutreachMessage) => void;
  /** Callback when user wants to send a draft */
  onSendDraft?: (message: OutreachMessage) => void;
  /** Callback when user wants to discard a draft */
  onDiscardDraft?: (message: OutreachMessage) => void;
}

type Attachment = NonNullable<OutreachMessage["attachments"]>[number];

function getFileType(filename: string = "", mimeType: string = ""): { type: string; color: string; bg: string; icon: React.ElementType } {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return { type: 'image', color: 'text-blue-500', bg: 'bg-blue-500/10', icon: ImageIcon };
  }
  if (mimeType.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) {
    return { type: 'video', color: 'text-purple-500', bg: 'bg-purple-500/10', icon: Film };
  }
  if (mimeType.startsWith('audio/')) {
    return { type: 'audio', color: 'text-violet-500', bg: 'bg-violet-500/10', icon: AudioLines };
  }
  if (ext === 'pdf') {
    return { type: 'pdf', color: 'text-rose-500', bg: 'bg-rose-500/10', icon: FileText };
  }
  if (['doc', 'docx'].includes(ext)) {
    return { type: 'word', color: 'text-indigo-500', bg: 'bg-indigo-500/10', icon: FileText };
  }
  if (['xls', 'xlsx'].includes(ext)) {
    return { type: 'excel', color: 'text-emerald-500', bg: 'bg-emerald-500/10', icon: FileSpreadsheet };
  }
  if (ext === 'csv') {
    return { type: 'csv', color: 'text-teal-500', bg: 'bg-teal-500/10', icon: FileSpreadsheet };
  }
  if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) {
    return { type: 'archive', color: 'text-amber-500', bg: 'bg-amber-500/10', icon: File };
  }
  return { type: 'file', color: 'text-primary', bg: 'bg-primary/10', icon: Paperclip };
}

function AttachmentList({ attachments }: { attachments?: Attachment[] | null }) {
  if (!attachments || attachments.length === 0) return null;
  
  return (
    <div className="flex flex-col gap-2 mt-3 pt-3 border-t border-border/20">
      {attachments.map((att, i) => {
        const downloadUrl = att.downloadUrl || att.url || att.path || "#";
        const inlineUrl = att.inlineUrl || (downloadUrl === "#" ? "#" : `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}inline=true`);
        const filename = att.fileName || att.filename || att.originalName || "Attachment";
        const fileMeta = getFileType(filename, att.mimeType || att.contentType || "");
        const Icon = fileMeta.icon;
        const unavailable = !att.url || att.status === "quarantined" || att.status === "failed";

        if (unavailable) {
          return (
            <div key={att.id || i} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-destructive/30 bg-destructive/5 max-w-sm">
              <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
              <div className="min-w-0">
                <p className="text-[11px] font-bold truncate">{filename}</p>
                <p className="text-[9px] text-destructive">Attachment unavailable or blocked</p>
              </div>
            </div>
          );
        }

        if (fileMeta.type === 'image') {
          return (
            <div key={att.id || i} className="relative group rounded-lg overflow-hidden border border-border/40 max-w-sm bg-background/50 hover:shadow-md transition-all duration-300">
              <a href={inlineUrl} target="_blank" rel="noopener noreferrer" className="block overflow-hidden max-h-48">
                <img 
                  src={inlineUrl}
                  alt={filename} 
                  className="w-full h-auto object-cover group-hover:scale-105 transition-transform duration-300"
                />
              </a>
              <div className="p-2 flex items-center justify-between border-t border-border/20 bg-background/80 backdrop-blur-sm">
                <span className="text-[10px] font-bold truncate max-w-[200px] text-foreground/80">{filename}</span>
                <a href={downloadUrl} download={filename} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                  <Download className="w-3 h-3" />
                </a>
              </div>
            </div>
          );
        }

        if (fileMeta.type === 'video') {
          return (
            <div key={att.id || i} className="overflow-hidden rounded-lg border border-border/40 bg-background/50 max-w-sm">
              <video controls preload="metadata" src={inlineUrl} className="block max-h-64 w-full bg-black" aria-label={filename} />
              <div className="flex items-center justify-between border-t border-border/20 p-2">
                <span className="truncate text-[10px] font-bold text-foreground/80">{filename}</span>
                <a href={downloadUrl} download={filename} className="p-1 text-muted-foreground hover:text-foreground" aria-label={`Download ${filename}`}>
                  <Download className="h-3 w-3" />
                </a>
              </div>
            </div>
          );
        }

        if (fileMeta.type === 'audio') {
          return (
            <div key={att.id || i} className="p-2.5 rounded-lg border border-border/30 bg-background/40 max-w-sm">
              <div className="flex items-center gap-2 mb-2">
                <AudioLines className="w-4 h-4 text-violet-500" />
                <span className="text-[11px] font-bold truncate text-foreground/80">
                  {att.mediaKind === "voice" ? "Voice message" : filename}
                </span>
                {att.transcriptionLanguage && (
                  <span className="text-[9px] text-muted-foreground uppercase">{att.transcriptionLanguage}</span>
                )}
              </div>
              <audio controls preload="metadata" src={inlineUrl} className="w-full h-9" aria-label={filename} />
              <p className="text-[9px] text-muted-foreground mt-1">
                {att.extractionStatus === "success"
                  ? "Transcribed for grounded reply context"
                  : "Transcription unavailable — no audio details were inferred"}
                {att.deliveryStatus === "failed" || att.deliveryStatus === "unsupported" ? " · voice delivery fell back or failed" : ""}
              </p>
            </div>
          );
        }

        return (
          <a 
            key={att.id || i}
            href={downloadUrl}
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center justify-between p-2.5 rounded-lg border border-border/30 bg-background/40 hover:bg-muted/30 hover:border-border/60 transition-all group max-w-sm"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`p-2 rounded-lg ${fileMeta.bg} ${fileMeta.color} flex-shrink-0`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[11px] font-bold truncate text-foreground/80 leading-tight">
                  {filename}
                </span>
                <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider mt-0.5">
                  {fileMeta.type}
                  {att.deliveryStatus === "failed" || att.deliveryStatus === "unsupported" ? " · delivery failed" : ""}
                  {att.extractionStatus === "failed" || att.extractionStatus === "unsupported" ? " · AI extraction unavailable" : ""}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Download className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground" />
            </div>
          </a>
        );
      })}
    </div>
  );
}

export function OutreachMessageBubble({
  message,
  channel,
  conversation,
  theme: themeOverride,
  showSubject = false,
  parseContent = false,
  onEditDraft,
  onSendDraft,
  onDiscardDraft,
}: OutreachMessageBubbleProps) {
  const theme = themeOverride || getChannelTheme(channel);
  const isOutbound = message.direction === "outbound";
  const isDraft = message.status === "draft";
  // Plain wording for failed and unconfirmed sends; never the internal reason text.
  const deliveryError = isOutbound ? outboundDeliveryDetail(message.status, message.errorMessage) || "" : "";

  // WhatsApp-style status icons (single/double check)
  const getWhatsAppStatusIcon = () => {
    if (!isOutbound) return null;
    switch (message.status) {
      case "sent":
        return <Check className="h-3 w-3 text-muted-foreground" />;
      case "delivered":
        return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
      case "read":
        return <CheckCheck className="h-3 w-3 text-blue-500" />;
      case "failed":
        return <AlertCircle className="h-3 w-3 text-red-500" />;
      case "manual_review":
        return <Clock className="h-3 w-3 text-amber-500" aria-label="Pending confirmation" />;
      case "draft":
        return <Pencil className="h-3 w-3 text-amber-500" />;
      default:
        return <Clock className="h-3 w-3 text-muted-foreground" />;
    }
  };

  // Standard status icons (for email, instagram)
  const getStandardStatusIcon = () => {
    switch (message.status) {
      case "sent":
        return <CheckCircle2 className="w-3 h-3 text-green-500" />;
      case "delivered":
        return <CheckCircle2 className="w-3 h-3 text-blue-500" />;
      case "read":
      case "seen":
        return <CheckCircle2 className="w-3 h-3 text-purple-500" />;
      case "pending":
        return <Clock className="w-3 h-3 text-yellow-500" />;
      case "failed":
        return <AlertCircle className="w-3 h-3 text-red-500" />;
      case "manual_review":
        return <Clock className="w-3 h-3 text-amber-500" aria-label="Pending confirmation" />;
      case "draft":
        return <Pencil className="w-3 h-3 text-amber-500" />;
      default:
        return <Circle className="w-3 h-3 text-muted-foreground" />;
    }
  };

  const displayContent = parseContent
    ? parseMessageContent(message.content)
    : message.content;
  const originLabel = isOutbound ? messageOriginText(message, channel) : null;
  const scheduledAt = typeof message.metadata?.scheduledAt === 'string' && ['pending', 'queued'].includes(message.status) ? new Date(message.metadata.scheduledAt) : null;
  const followUpLabel = <>
    {message.messageKind === 'follow_up' && !message.origin ? <span className="mb-1 block text-[10px] font-semibold opacity-80">Follow-up{message.followUpStep ? ` ${message.followUpStep}` : ''}</span> : null}
    {scheduledAt && Number.isFinite(scheduledAt.getTime()) ? <span className="mb-2 block text-xs text-muted-foreground">Scheduled for {scheduledAt.toLocaleString()}</span> : null}
  </>;

  // For inbound email messages, clean quoted reply content
  const cleanedDisplayContent = (!isOutbound && channel === 'email')
    ? cleanEmailForDisplay(displayContent)
    : displayContent;

  // Draft message bubble — special rendering with actions
  if (isDraft) {
    return (
      <DraftRecommendationCard
        channel={message.metadata?.replySurface === "comment" ? `${channel} comment` : channel}
        subject={showSubject ? message.subject : undefined}
        timestamp={formatDateTimeIST(message.createdAt)}
        onEdit={onEditDraft ? () => onEditDraft(message) : undefined}
        onSend={onSendDraft ? () => onSendDraft(message) : undefined}
        onDiscard={onDiscardDraft ? () => onDiscardDraft(message) : undefined}
      >
        {message.htmlContent && channel !== "email" ? (
          <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.htmlContent) }} className="prose max-w-none break-words text-sm dark:prose-invert [&_a]:text-primary [&_a]:underline" />
        ) : channel === "email" ? (
          <EmailMessageContent content={cleanedDisplayContent} htmlContent={message.htmlContent} />
        ) : (
          <p className="whitespace-pre-wrap">{cleanedDisplayContent}</p>
        )}
        <AttachmentList attachments={message.attachments} />
      </DraftRecommendationCard>
    );
  }

  if (channel === "email") {
    const timestamp = message.sentAt || message.createdAt;
    const leadName = conversation?.leadName || conversation?.leadEmail || "Contact";
    const address = conversation?.leadEmail;
    const subject = message.subject || conversation?.subject;

    return (
      <article role="listitem" aria-label={`${isOutbound ? "Sent" : "Received"} email`} className="overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm">
        <header className="flex flex-wrap items-start gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${isOutbound ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200" : "bg-muted text-foreground"}`} aria-hidden="true">
            {isOutbound ? "Y" : leadName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="truncate text-sm font-semibold text-foreground">{isOutbound ? "You" : leadName}</span>
              <time dateTime={timestamp} className="text-xs tabular-nums text-muted-foreground" title={formatDateTimeIST(timestamp)}>{formatDateTimeIST(timestamp)} IST</time>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {isOutbound ? "To: " : "From: "}{address || leadName}
            </p>
          </div>
        </header>
        <div className="px-4 py-4 sm:px-5">
          {showSubject && subject ? <h3 className="mb-3 text-sm font-semibold text-foreground">{subject}</h3> : null}
          {originLabel ? <span className="mb-1 block text-[10px] opacity-70">{originLabel}</span> : null}{message.metadata?.replySurface === "comment" ? <span className="mb-1 block text-[10px] opacity-70">Public comment</span> : null}{followUpLabel}
          <EmailMessageContent content={cleanedDisplayContent} htmlContent={message.htmlContent} />
          <AttachmentList attachments={message.attachments} />
        </div>
        {isOutbound && <footer className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground sm:px-5">
          <EmailDeliveryActivity message={message} />
          {deliveryError && <p role="alert" className="mt-1 break-words text-destructive">{deliveryError}</p>}
        </footer>}
      </article>
    );
  }

  // WhatsApp keeps its time and delivery marks inside each message.
  if (channel === "whatsapp") {
    const messageTime = message.sentAt
      ? formatShortTimeIST(message.sentAt)
      : formatShortTimeIST(message.createdAt);

    return (
      <article role="listitem" aria-label={`${isOutbound ? "Outbound" : "Inbound"} WhatsApp message`} className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
        <div className={`min-w-0 max-w-[88%] rounded-lg px-3 py-2 text-sm shadow-sm sm:max-w-[72%] ${isOutbound ? "rounded-tr-sm bg-[#d9fdd3] text-[#172b24] dark:bg-[#175c4b] dark:text-white" : "rounded-tl-sm bg-white text-[#172b24] dark:bg-slate-800 dark:text-white"}`}>
          {originLabel ? <span className="mb-1 block text-[10px] opacity-70">{originLabel}</span> : null}{message.metadata?.replySurface === "comment" ? <span className="mb-1 block text-[10px] opacity-70">Public comment</span> : null}{followUpLabel}
          <p className="text-sm whitespace-pre-wrap break-words">{cleanedDisplayContent}</p>
          <AttachmentList attachments={message.attachments} />
          {deliveryError ? <p role="alert" className="mt-2 max-w-80 break-words border-t border-current/20 pt-2 text-xs font-medium text-red-700 dark:text-red-200">{deliveryError}</p> : null}
          <div className="flex items-center gap-1 justify-end mt-1">
            <time dateTime={message.sentAt || message.createdAt} className="text-[10px] tabular-nums opacity-65" title={formatDateTimeIST(message.sentAt || message.createdAt)}>{messageTime}</time>
            {getWhatsAppStatusIcon()}
          </div>
        </div>
      </article>
    );
  }

  if (channel === "facebook" || channel === "instagram") {
    const timestamp = message.sentAt || message.createdAt;
    const isInstagram = channel === "instagram";
    const leadInitial = (conversation?.leadName || "C").charAt(0).toUpperCase();

    return (
      <article role="listitem" aria-label={`${isOutbound ? "Outbound" : "Inbound"} ${channel} message`} className={`flex items-end gap-2 ${isOutbound ? "justify-end" : "justify-start"}`}>
        {!isOutbound ? (
          <div className={`flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-semibold text-white ${isInstagram ? "bg-gradient-to-br from-fuchsia-500 via-violet-500 to-orange-400" : "bg-[#0866ff]"}`} aria-hidden="true">
            {conversation?.leadAvatar ? <img src={conversation.leadAvatar} alt="" className="h-full w-full object-cover" /> : leadInitial}
          </div>
        ) : null}
        <div className={`min-w-0 max-w-[85%] sm:max-w-[70%] ${isOutbound ? "items-end" : "items-start"} flex flex-col`}>
          <div className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${isOutbound
            ? isInstagram
              ? "rounded-br-md bg-gradient-to-br from-[#7257e9] via-[#a43df0] to-[#d83bb2] text-white"
              : "rounded-br-md bg-[#0866ff] text-white"
            : "rounded-bl-md bg-[#f0f2f5] text-[#1c1e21] dark:bg-slate-700 dark:text-white"}`}>
            {originLabel ? <span className="mb-1 block text-[10px] opacity-70">{originLabel}</span> : null}{message.metadata?.replySurface === "comment" ? <span className="mb-1 block text-[10px] opacity-70">Public comment</span> : null}{followUpLabel}
            {message.imageUrl ? <img src={normalizeUploadUrl(message.imageUrl)} alt="Shared image" className="mb-2 max-h-72 max-w-full rounded-lg object-contain" /> : null}
            <p className="whitespace-pre-wrap break-words">{cleanedDisplayContent}</p>
            <AttachmentList attachments={message.attachments} />
            {deliveryError ? <p role="alert" className="mt-2 max-w-80 break-words border-t border-current/20 pt-2 text-xs font-medium">{deliveryError}</p> : null}
          </div>
          <div className="mt-1 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
            <time dateTime={timestamp} title={formatDateTimeIST(timestamp)} className="tabular-nums">{formatTimeIST(timestamp)}</time>
            {isOutbound && message.status === "read" ? <span>· Seen</span> : null}
            {isOutbound && message.status === "failed" ? <span className="text-destructive">· Failed</span> : null}
            {isOutbound && message.status === "manual_review" ? <span className="text-amber-700 dark:text-amber-300">· Pending confirmation</span> : null}
          </div>
        </div>
      </article>
    );
  }

  // SMS-style compact bubble (iMessage-like)
  if (channel === "sms") {
    return (
      <ConversationMessageFrame
        role={isOutbound ? "user" : "assistant"}
        surface="outreach"
        showAvatar={false}
        contentClassName={`!rounded-2xl !border-0 !px-4 !py-2 !shadow-none ${isOutbound ? theme.outboundBubble : theme.inboundBubble}`}
        ariaLabel={`${isOutbound ? "Outbound" : "Inbound"} SMS message`}
      >
          {originLabel ? <span className="mb-1 block text-[10px] opacity-70">{originLabel}</span> : null}{message.metadata?.replySurface === "comment" ? <span className="mb-1 block text-[10px] opacity-70">Public comment</span> : null}{followUpLabel}
          <p className={`text-sm whitespace-pre-wrap ${isOutbound ? theme.outboundText : theme.inboundText}`}>
            {cleanedDisplayContent}
          </p>
          <div className={`flex items-center gap-1 mt-1 text-xs ${isOutbound ? theme.outboundTimestamp : theme.inboundTimestamp}`}>
            <span>
              {message.sentAt
                ? formatTimeIST(message.sentAt)
                : ""}
            </span>
            {isOutbound && (
              <>
                {message.status === "delivered" && <CheckCircle2 className="h-3 w-3" />}
                {message.status === "sent" && <Circle className="h-3 w-3" />}
                {message.status === "failed" && <AlertCircle className="h-3 w-3 text-red-300" />}
              </>
            )}
          </div>
      </ConversationMessageFrame>
    );
  }

  // Standard bubble (email, instagram, facebook, linkedin, twitter)
  return (
    <ConversationMessageFrame
      role={isOutbound ? "user" : "assistant"}
      surface="outreach"
      showAvatar={false}
      contentClassName={`!rounded-xl !border-0 !p-3 !shadow-none ${isOutbound ? theme.outboundBubble : theme.inboundBubble}`}
      ariaLabel={`${isOutbound ? "Outbound" : "Inbound"} ${channel} message`}
    >
        {originLabel ? <span className="mb-1 block text-[10px] opacity-70">{originLabel}</span> : null}{message.metadata?.replySurface === "comment" ? <span className="mb-1 block text-[10px] opacity-70">Public comment</span> : null}{followUpLabel}
        {/* Subject line (for email channels) */}
        {showSubject && message.subject && (
          <p className={`font-medium text-sm mb-2 ${isOutbound ? "text-white/90" : "text-muted-foreground"}`}>
            Subject: {message.subject}
          </p>
        )}

        {/* Image (for Instagram) */}
        {message.imageUrl && (
          <img
            src={normalizeUploadUrl(message.imageUrl)}
            alt="Shared image"
            className="rounded-lg mb-2 max-w-full"
          />
        )}

        {/* Message content */}
        <div className={`text-sm overflow-hidden ${isOutbound ? theme.outboundText : theme.inboundText}`}>
          {message.htmlContent ? (
            <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.htmlContent) }} className={`prose max-w-none text-sm break-words [&_a]:underline ${isOutbound ? 'prose-invert' : 'dark:prose-invert'}`} />
          ) : (
            <p className="whitespace-pre-wrap">{cleanedDisplayContent}</p>
          )}
        </div>

        <AttachmentList attachments={message.attachments} />

        {/* Timestamp and status */}
        <div className={`flex items-center gap-2 mt-2 text-xs ${isOutbound ? theme.outboundTimestamp : theme.inboundTimestamp}`}>
          <Clock className="w-3 h-3" />
          {formatDateTimeIST(message.sentAt || message.createdAt)}
          {isOutbound && (
            <span className="ml-1">{getStandardStatusIcon()}</span>
          )}
        </div>
    </ConversationMessageFrame>
  );
}
