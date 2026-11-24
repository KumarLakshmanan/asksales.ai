import { EmailDesignPicker } from './EmailDesignPicker';
import type { EmailDesignId } from '../../../../shared/emailDesigns';
/**
 * OutreachComposeArea - Shared message compose area for outreach pages
 * Supports dark mode, channel-specific theming, subject field, templates
 */

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileText, ImageIcon, Heart, Sparkles } from "lucide-react";
import type { OutreachChannel } from "./types";
import type { EmailAttachment } from "./EmailComposeBuilder";
import { useRef, useCallback } from "react";
import { ConversationComposer } from "@/components/conversation/ConversationComposer";
import { AttachmentTray } from "@/components/conversation/AttachmentTray";
import { getChannelCapabilities } from "./channel-capabilities";
import { calculateSmsMetrics } from "@/lib/smsMetrics";
import { ChannelMessageEditor } from "./ChannelMessageEditor";

interface OutreachComposeAreaProps {
  channel: OutreachChannel;
  appearance?: 'channel' | 'neutral';
  message: string;
  onMessageChange?: (message: string) => void;
  emailDesignId?: EmailDesignId;
  onEmailDesignChange?: (id: EmailDesignId) => void;
  htmlContent?: string;
  onHtmlContentChange?: (html: string) => void;
  onSend: () => void;
  sending?: boolean;
  disabled?: boolean;
  placeholder?: string;
  inlineReply?: boolean;

  // Optional features
  showSubject?: boolean;
  subject?: string;
  onSubjectChange?: (subject: string) => void;

  showAttachment?: boolean;
  onAttachmentClick?: () => void;
  
  // Attachments
  attachments?: EmailAttachment[];
  uploadingAttachments?: boolean;
  onFilesSelected?: (files: FileList) => void;
  fileAccept?: string;
  onRemoveAttachment?: (id: number | string) => void;

  showTemplate?: boolean;
  onTemplateClick?: () => void;

  showImage?: boolean;
  onImageClick?: () => void;

  showLikeButton?: boolean;

  showAIGenerate?: boolean;
  onAIGenerateClick?: () => void;
  aiGenerating?: boolean;

  /** Extra actions to render in the left action area */
  extraLeftActions?: React.ReactNode;
  
  /** Children for extra footer elements (templates, signers, etc) */
  children?: React.ReactNode;
}

export function OutreachComposeArea({
  channel,
  appearance = 'channel',
  message,
  onMessageChange,
  htmlContent,
  emailDesignId,
  onEmailDesignChange,
  onHtmlContentChange,
  onSend,
  sending = false,
  disabled = false,
  placeholder,
  inlineReply = false,
  showSubject = false,
  subject = "",
  onSubjectChange,
  showAttachment = false,
  onAttachmentClick,
  attachments,
  uploadingAttachments = false,
  onFilesSelected,
  fileAccept = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.gif,.webp',
  onRemoveAttachment,
  showTemplate = false,
  onTemplateClick,
  showImage = false,
  onImageClick,
  showLikeButton = false,
  showAIGenerate = false,
  onAIGenerateClick,
  aiGenerating = false,
  extraLeftActions,
  children,
}: OutreachComposeAreaProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const capabilities = getChannelCapabilities(channel);
  const smsMetrics = channel === "sms" ? calculateSmsMetrics(message) : null;
  const resolvedPlaceholder = placeholder || capabilities.placeholder;

  // Normalize handlers
  const handleMessageChange = onMessageChange || (() => {});
  const handleSubjectChange = onSubjectChange || (() => {});
  const isGeneratingAI = aiGenerating;
  
  // If attachments are passed but showAttachment isn't explicitly false, enable it
  const isAttachmentEnabled = showAttachment || !!onFilesSelected;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !disabled && !sending && (message.trim() || attachments?.length)) {
      e.preventDefault();
      onSend();
    }
  }, [attachments?.length, disabled, message, onSend, sending]);

  const aiAction = showAIGenerate && (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onAIGenerateClick}
      loading={isGeneratingAI}
      disabled={disabled || sending}
      className="h-9 shrink-0 gap-1 rounded-lg px-2 text-xs text-primary hover:bg-primary/5"
    >
      <Sparkles className={inlineReply ? "hidden size-3.5 sm:block" : "size-3.5"} aria-hidden="true" />
      AI
    </Button>
  );

  return (
    <div className={`border-t border-border/70 p-3 ${appearance === 'channel' && channel === "whatsapp" ? "bg-[#f0f2f5] dark:bg-slate-900" : "bg-background"}`}>
      <div className="mx-auto max-w-4xl">
        {onFilesSelected ? (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept={fileAccept}
            onChange={(event) => {
              if (event.target.files?.length) onFilesSelected(event.target.files);
              event.target.value = "";
            }}
          />
        ) : null}
        <ConversationComposer
          value={message}
          onValueChange={handleMessageChange}
          onSend={onSend}
          onKeyDown={handleKeyDown}
          inlineEditor={inlineReply}
          context={inlineReply ? <>{extraLeftActions}{aiAction}</> : undefined}
          editor={channel === "whatsapp" || (channel === "email" && onHtmlContentChange) ? (
            <ChannelMessageEditor channel={channel} value={message} onChange={handleMessageChange}
              htmlContent={htmlContent} onHtmlChange={onHtmlContentChange} compact inline={inlineReply}
              disabled={disabled || sending} placeholder={resolvedPlaceholder}
              maxLength={capabilities.characterLimit} onKeyDown={handleKeyDown} />
          ) : undefined}
          placeholder={resolvedPlaceholder}
          maxLength={capabilities.characterLimit}
          disabled={disabled || sending}
          busy={sending}
          sendDisabled={!message.trim() && (!attachments || attachments.length === 0)}
          shape={channel === "email" ? "panel" : "pill"}
          sendLabel="Send"
          sendButtonClassName={appearance === 'neutral' ? undefined : channel === "whatsapp" ? "bg-[#008069] text-white hover:bg-[#006c59]" : channel === "facebook" ? "bg-[#0866ff] text-white hover:bg-[#0756d7]" : channel === "instagram" ? "bg-gradient-to-r from-[#7257e9] via-[#a43df0] to-[#d83bb2] text-white hover:opacity-90" : undefined}
          onAttach={isAttachmentEnabled ? (onFilesSelected ? () => fileInputRef.current?.click() : onAttachmentClick) : undefined}
          attachmentDisabled={uploadingAttachments}
          subject={showSubject ? (
          <Input
            placeholder="Subject line..."
            value={subject}
            onChange={(e) => handleSubjectChange(e.target.value)}
            className="h-9 text-sm rounded-lg border-border/60"
            disabled={disabled || sending}
          />
          ) : undefined}
          attachments={attachments && attachments.length > 0 ? (
            <AttachmentTray
              attachments={attachments.map((attachment) => ({
                id: attachment.id || attachment.fileId || attachment.fileName,
                name: attachment.originalName || attachment.fileName || "Attachment",
                size: attachment.size,
                mimeType: attachment.mimeType,
                status: "ready",
              }))}
              onRemove={onRemoveAttachment}
            />
          ) : uploadingAttachments ? (
            <AttachmentTray attachments={[{ id: "uploading", name: "Uploading attachment…", status: "uploading" }]} />
          ) : undefined}
          footer={!inlineReply && (
            <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-0.5">
            {showImage && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={onImageClick}
                disabled={disabled || sending}
              >
                <ImageIcon className="w-3.5 h-3.5" />
              </Button>
            )}
            {showLikeButton && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                disabled={disabled || sending}
              >
                <Heart className="w-3.5 h-3.5" />
              </Button>
            )}

            {showTemplate && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onTemplateClick}
                disabled={disabled || sending}
                className="h-8 rounded-lg px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <FileText className="w-3.5 h-3.5" />
                Templates
              </Button>
            )}
            {aiAction}
            {channel === 'email' && onEmailDesignChange && <EmailDesignPicker value={emailDesignId} onChange={onEmailDesignChange} body={htmlContent} disabled={disabled || sending} />}
            {extraLeftActions}
          </div>
          <div className="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
            {smsMetrics ? (
              <span aria-label="SMS reply length">{smsMetrics.characters} characters · {smsMetrics.encoding} · {smsMetrics.segments || 1} {smsMetrics.segments > 1 ? "segments" : "segment"} (estimated)</span>
            ) : <span className="hidden sm:inline">{capabilities.sendHint}</span>}
            {capabilities.characterLimit ? <span aria-label={`${message.length} of ${capabilities.characterLimit} characters`}>{message.length}/{capabilities.characterLimit}</span> : null}
            {children}
          </div>
        </div>
          )}
        />
      </div>
    </div>
  );
}
