import { populateEmailMessageWindow } from '@/lib/email-message-window';
import { stripEmailOpenTracking } from '../../../../shared/emailFormatting';
import { EmailDeliveryActivity } from './EmailDeliveryActivity';
/**
 * EmailThreadMessage - Gmail-style email thread message component
 * Shows emails in expandable cards similar to Gmail's conversation view
 */

import { useState } from "react";
import {
  ChevronUp,
  Sparkles,
  Pencil,
  Send,
  MoreVertical,
  Trash2,
  Printer,
  ExternalLink,
  MoreHorizontal,
  Paperclip,
  Download,
  AlertCircle,
  ImageIcon,
  Film,
} from "lucide-react";
import { format } from "date-fns";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { OutreachMessage } from "./types";
import { parseMessageContent } from "./useOutreachPage";
import DOMPurify from "dompurify";

/**
 * Splits an email body into the main content and the quoted/replied thread.
 * Detects the typical Gmail/Outlook "On [date], [person] wrote:" separator.
 */
function splitEmailContent(content: string): { main: string; quoted: string | null } {
  // Match "On Mon, Jan 1, 2024 at 12:00 PM Name <email> wrote:" style headers
  const quotedHeaderPattern = /^On\s.+wrote:\s*$/m;
  const match = quotedHeaderPattern.exec(content);
  if (match && match.index !== undefined) {
    const main = content.slice(0, match.index).trimEnd();
    const quoted = content.slice(match.index).trim();
    return { main, quoted };
  }
  // Also detect lines that are purely ">" quoted lines at the end of the message
  const lines = content.split("\n");
  let firstQuotedLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimStart().startsWith(">")) {
      firstQuotedLine = i;
    } else if (firstQuotedLine !== -1) {
      break;
    }
  }
  if (firstQuotedLine !== -1 && firstQuotedLine < lines.length - 1) {
    const main = lines.slice(0, firstQuotedLine).join("\n").trimEnd();
    const quoted = lines.slice(firstQuotedLine).join("\n").trim();
    return { main: main || content, quoted };
  }
  return { main: content, quoted: null };
}

function AttachmentList({ attachments }: { attachments?: OutreachMessage["attachments"] }) {
  if (!attachments || attachments.length === 0) return null;
  
  return (
    <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-border/30">
      {attachments.map((att, i) => {
        const filename = att.fileName || att.filename || att.originalName || "Attachment";
        const downloadUrl = att.downloadUrl || att.url || att.path || "#";
        const inlineUrl = att.inlineUrl || (downloadUrl === "#" ? "#" : `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}inline=true`);
        const unavailable = !att.url || att.status === "quarantined" || att.status === "failed";
        if (unavailable) {
          return (
            <div key={att.id || i} className="flex items-center gap-2 p-2 pr-3 rounded-xl border border-destructive/30 bg-destructive/5">
              <AlertCircle className="w-3.5 h-3.5 text-destructive" />
              <span className="text-xs font-medium truncate max-w-[150px]">{filename}</span>
              <span className="text-[9px] text-destructive">Unavailable</span>
            </div>
          );
        }
        if (att.mimeType?.startsWith("image/")) {
          return (
            <a key={att.id || i} href={inlineUrl} target="_blank" rel="noopener noreferrer" className="overflow-hidden rounded-xl border border-border/50 bg-background/50 max-w-sm">
              <img src={inlineUrl} alt={filename} className="block max-h-56 w-full object-cover" />
              <span className="flex items-center gap-2 p-2 text-xs font-medium"><ImageIcon className="h-3.5 w-3.5" />{filename}</span>
            </a>
          );
        }
        if (att.mimeType?.startsWith("video/")) {
          return (
            <div key={att.id || i} className="overflow-hidden rounded-xl border border-border/50 bg-background/50 min-w-[280px] max-w-sm">
              <video controls preload="metadata" src={inlineUrl} className="block max-h-64 w-full bg-black" aria-label={filename} />
              <span className="flex items-center gap-2 p-2 text-xs font-medium"><Film className="h-3.5 w-3.5" />{filename}</span>
            </div>
          );
        }
        if (att.mimeType?.startsWith("audio/")) {
          return (
            <div key={att.id || i} className="p-2 rounded-xl border border-border/50 bg-background/50 min-w-[260px]">
              <span className="text-xs font-medium block mb-1">{att.mediaKind === "voice" ? "Voice message" : filename}</span>
              <audio controls preload="metadata" src={inlineUrl} className="w-full h-9" aria-label={filename} />
              <span className="text-[9px] text-muted-foreground">
                {att.extractionStatus === "success" ? "Transcribed for reply context; email response remains text" : "Transcription unavailable"}
              </span>
            </div>
          );
        }
        return (
          <a
            key={att.id || i}
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 p-2 pr-3 rounded-xl border border-border/50 bg-background/50 hover:bg-primary/5 hover:border-primary/20 transition-all group"
          >
            <div className="p-1.5 rounded-md bg-primary/10 text-primary flex-shrink-0">
              <Paperclip className="w-3.5 h-3.5" />
            </div>
            <span className="text-xs font-medium truncate max-w-[150px]">{filename}</span>
            {(att.deliveryStatus === "failed" || att.deliveryStatus === "unsupported") && (
              <span className="text-[9px] text-destructive">Delivery failed</span>
            )}
            <Download className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground ml-1 flex-shrink-0" />
          </a>
        );
      })}
    </div>
  );
}

interface EmailThreadMessageProps {
  message: OutreachMessage;
  /** Sender name for outbound messages (your name/company) */
  senderName?: string;
  /** Sender email for outbound messages */
  senderEmail?: string;
  /** Recipient info from conversation */
  recipientName?: string;
  recipientEmail?: string;
  recipientAvatar?: string;
  /** Whether this message is expanded */
  isExpanded?: boolean;
  /** Whether this is the latest message (auto-expand) */
  isLatest?: boolean;
  /** Callback when user wants to edit a draft */
  onEditDraft?: (message: OutreachMessage) => void;
  /** Callback when user wants to send a draft */
  onSendDraft?: (message: OutreachMessage) => void;
  /** Callback when user wants to discard a draft */
  onDiscardDraft?: (message: OutreachMessage) => void;
  /** Callback for reply action */
  onReply?: (message: OutreachMessage) => void;
  /** Callback for forward action */
  onForward?: (message: OutreachMessage) => void;
  /** Callback for delete action */
  onDelete?: (message: OutreachMessage) => void;
}

export function EmailThreadMessage({
  message,
  senderName = "Me",
  senderEmail,
  recipientName,
  recipientEmail,
  recipientAvatar,
  isExpanded: controlledExpanded,
  isLatest = false,
  onEditDraft,
  onSendDraft,
  onDiscardDraft,
  onReply: _onReply,
  onForward: _onForward,
  onDelete,
}: EmailThreadMessageProps) {
  const [isExpandedState, setIsExpandedState] = useState(isLatest);
  const [showQuoted, setShowQuoted] = useState(false);
  const isExpanded = controlledExpanded ?? isExpandedState;
  const isOutbound = message.direction === "outbound";
  const isDraft = message.status === "draft";

  const rawContent = parseMessageContent(message.content);
  const { main: displayContent, quoted: quotedContent } = splitEmailContent(rawContent);

  // For outbound messages, use the sender email as the display, for inbound use recipient
  const displayName = isOutbound 
    ? (senderEmail || senderName) 
    : (recipientName || recipientEmail || "Unknown");
  const displayEmail = isOutbound ? senderEmail : recipientEmail || "";
  const avatar = isOutbound ? undefined : recipientAvatar;

  // Get initials for avatar
  const getInitials = (name: string | undefined | null) => {
    if (!name) return "?";
    // If it's an email, use first letter
    if (name.includes("@")) return name.charAt(0).toUpperCase();
    return name.split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase();
  };

  // Format date for display - Gmail style
  const formatMessageDate = () => {
    const date = message.sentAt ? new Date(message.sentAt) : new Date(message.createdAt);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return format(date, "h:mm a");
    } else if (diffDays === 1) {
      return "Yesterday, " + format(date, "h:mm a");
    } else if (diffDays < 7) {
      return format(date, "EEE, MMM d, h:mm a");
    } else if (date.getFullYear() === now.getFullYear()) {
      return format(date, "MMM d, h:mm a");
    }
    return format(date, "MMM d, yyyy, h:mm a");
  };

  const fullDate = () => {
    const date = message.sentAt ? new Date(message.sentAt) : new Date(message.createdAt);
    return format(date, "EEE, MMM d, yyyy 'at' h:mm a");
  };

  // Draft message card - special styling
  if (isDraft) {
    return (
      <div className="border border-amber-500/20 bg-amber-500/[0.03] dark:bg-amber-500/[0.05] rounded-2xl overflow-hidden backdrop-blur-sm animate-in fade-in zoom-in-95 duration-500 shadow-xl shadow-amber-500/5">
        {/* Draft Header */}
        <div className="flex items-center gap-4 px-6 py-4 border-b border-amber-500/10">
          <div className="relative">
            <Avatar className="h-12 w-12 rounded-2xl shadow-lg border border-amber-500/20">
              <AvatarFallback className="bg-gradient-to-br from-amber-400 to-orange-500 text-white">
                <Sparkles className="w-5 h-5" />
              </AvatarFallback>
            </Avatar>
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 border-2 border-white dark:border-slate-950 rounded-full animate-pulse" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-heading font-bold italic text-lg text-amber-700 dark:text-amber-300">
                Draft Suggestion
              </span>
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-black uppercase tracking-widest border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                AI GEN
              </Badge>
            </div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-600/60 dark:text-amber-400/60 mt-0.5">
              TO: {recipientName || recipientEmail || "RECIPIENT"}
            </p>
          </div>
          <div className="text-right">
             <span className="font-black text-[10px] uppercase tracking-widest text-amber-600/40">
               {formatMessageDate()}
             </span>
          </div>
        </div>

        {/* Draft Content */}
        <div className="px-6 py-6 space-y-4">
          {message.subject && (
            <div className="flex items-start gap-3">
               <span className="font-black text-[10px] uppercase tracking-widest text-amber-600/40 mt-1">SUB:</span>
               <p className="font-heading font-bold italic text-xl text-amber-900 dark:text-amber-100 leading-tight">
                 {message.subject}
               </p>
            </div>
          )}
          <div className="text-base text-foreground/80 dark:text-gray-200 leading-relaxed pl-0 bg-white/40 dark:bg-black/20 p-6 rounded-2xl border border-amber-500/5 shadow-inner italic overflow-hidden">
            {message.htmlContent ? (
              <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(stripEmailOpenTracking(message.htmlContent)) }} className="prose dark:prose-invert max-w-none text-base break-words [&_a]:text-primary [&_a]:underline" />
            ) : (
              <div className="whitespace-pre-wrap">{displayContent}</div>
            )}
          </div>
          <AttachmentList attachments={message.attachments} />
        </div>

        {/* Draft Actions */}
        <div className="flex items-center gap-3 px-6 py-4 bg-amber-500/[0.05] border-t border-amber-500/10">
          {onEditDraft && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onEditDraft(message)}
              className="rounded-xl border-amber-500/20 bg-white/50 dark:bg-black/20 hover:bg-amber-500/10 text-amber-700 dark:text-amber-300 font-heading font-bold italic h-10 px-4 transition-all active:scale-95"
            >
              <Pencil className="w-3.5 h-3.5 mr-2" />
              Edit Draft
            </Button>
          )}
          {onSendDraft && (
            <Button
              size="sm"
              onClick={() => onSendDraft(message)}
              className="rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white font-heading font-bold italic h-10 px-6 shadow-lg shadow-amber-500/20 transition-all active:scale-95"
            >
              <Send className="w-3.5 h-3.5 mr-2" />
              Approve & Send
            </Button>
          )}
          {onDiscardDraft && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDiscardDraft(message)}
              className="h-10 rounded-xl font-black text-[10px] uppercase tracking-widest text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 ml-auto transition-all"
            >
              <Trash2 className="w-3.5 h-3.5 mr-2" />
              Discard
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Collapsed state - Gmail-style single line preview
  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpandedState(true)}
        className="w-full text-left flex items-center gap-4 px-6 py-4 hover:bg-white/40 dark:hover:bg-white/5 transition-all duration-300 group rounded-2xl border border-transparent hover:border-border/50 hover:shadow-lg hover:shadow-black/5"
      >
        {/* Avatar */}
        <Avatar className="h-10 w-10 flex-shrink-0 rounded-xl shadow-sm border border-border/50">
          {avatar ? (
            <AvatarImage src={avatar} />
          ) : null}
          <AvatarFallback className={cn(
            "font-heading font-bold italic",
            isOutbound
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground"
          )}>
            {getInitials(displayName)}
          </AvatarFallback>
        </Avatar>

        {/* Sender name - bold for outbound */}
        <div className="w-40 flex-shrink-0">
          <p className={cn(
            "text-base font-heading font-bold italic truncate transition-colors",
            isOutbound ? "text-primary dark:text-white" : "text-foreground opacity-70 group-hover:opacity-100"
          )}>
            {displayName}
          </p>
          <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50 leading-none mt-0.5">
            {isOutbound ? "SENT BY ME" : "RECEIVED"}
          </p>
        </div>

        {/* Preview text - Gmail shows snippet */}
        <div className="flex-1 min-w-0">
           <p className="text-sm text-muted-foreground/70 truncate leading-relaxed group-hover:text-foreground transition-colors">
            {displayContent.slice(0, 120).replace(/\n/g, " ")}
          </p>
        </div>

        {/* Date and attachment - right aligned */}
        <div className="text-right flex-shrink-0 ml-4 flex items-center gap-2">
           {message.attachments && message.attachments.length > 0 && (
             <Paperclip className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-primary transition-colors" />
           )}
           <span className="font-black text-[10px] uppercase tracking-widest text-muted-foreground/40 group-hover:text-primary transition-colors">
            {formatMessageDate()}
          </span>
        </div>
      </button>
    );
  }

  // Expanded state - Full Gmail-style email view
  return (
    <div className="animate-in fade-in slide-in-from-top-2 duration-500">
      <div className="bg-white/20 dark:bg-white/5 backdrop-blur-md border border-border/50 rounded-3xl overflow-hidden shadow-2xl shadow-black/5">
        {/* Email Header - Gmail style */}
        <div className="flex items-start gap-4 px-6 py-6 border-b border-border/50">
          {/* Avatar */}
          <Avatar className="h-12 w-12 flex-shrink-0 rounded-2xl shadow-lg border border-border/50">
            {avatar ? (
              <AvatarImage src={avatar} />
            ) : null}
            <AvatarFallback className={cn(
              "font-heading font-bold italic text-lg",
              isOutbound
                ? "bg-primary text-white shadow-lg shadow-primary/20"
                : "bg-muted text-muted-foreground"
            )}>
              {getInitials(displayName)}
            </AvatarFallback>
          </Avatar>

          {/* Sender info - Gmail layout */}
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-heading font-bold italic text-xl text-foreground">
                {displayName}
              </span>
              {displayEmail && displayEmail !== displayName && (
                <Badge variant="outline" className="h-5 px-2 text-[10px] font-black uppercase tracking-widest border-border/50 bg-background/50 text-muted-foreground/80">
                  {displayEmail}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="font-black text-[10px] uppercase tracking-widest text-muted-foreground/40">TO:</span>
              <span className="font-bold text-xs text-muted-foreground/80 italic">
                {isOutbound 
                  ? (recipientName || recipientEmail || "recipient") 
                  : (senderEmail || "me")}
              </span>
              <button 
                onClick={() => setIsExpandedState(false)}
                className="ml-2 w-5 h-5 rounded-full bg-border/50 flex items-center justify-center hover:bg-primary/20 hover:text-primary transition-all active:scale-90"
                title="Collapse message"
              >
                <ChevronUp className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Date and actions - Gmail style */}
          <div className="flex items-center gap-3 flex-shrink-0 pt-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="font-black text-[10px] uppercase tracking-widest text-muted-foreground/40 hover:text-primary transition-colors cursor-default">
                    {formatMessageDate()}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="glass border-border/50 rounded-xl">
                  <p className="font-black text-[9px] uppercase tracking-widest">{fullDate()}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground hover:bg-background/80 transition-all">
                  <MoreVertical className="w-4 h-4 opacity-40 hover:opacity-100" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 glass border-border/50 rounded-2xl p-1.5 shadow-2xl">
                <DropdownMenuItem className="rounded-xl gap-2 h-10" onClick={() => {
                  const printWindow = window.open('', '_blank');
                  if (printWindow) {
                    populateEmailMessageWindow(printWindow, {
                      subject: message.subject,
                      sender: displayName,
                      email: displayEmail,
                      receivedAt: fullDate(),
                      content: displayContent,
                    });
                    printWindow.print();
                  }
                }}>
                  <Printer className="w-4 h-4 opacity-40" />
                  <span className="font-black text-[10px] uppercase tracking-widest">Print Message</span>
                </DropdownMenuItem>
                
                <DropdownMenuItem className="rounded-xl gap-2 h-10" onClick={() => {
                   // Open email content in new window
                  const newWindow = window.open('', '_blank', 'width=800,height=900');
                  if (newWindow) {
                    populateEmailMessageWindow(newWindow, {
                      subject: message.subject,
                      sender: displayName,
                      email: displayEmail,
                      receivedAt: fullDate(),
                      content: displayContent,
                    });
                  }
                }}>
                  <ExternalLink className="w-4 h-4 opacity-40" />
                  <span className="font-black text-[10px] uppercase tracking-widest">Open in Window</span>
                </DropdownMenuItem>
                
                <DropdownMenuSeparator className="bg-border/50 my-1.5" />
                
                <DropdownMenuItem 
                  className="rounded-xl gap-2 h-10 text-red-600 focus:text-red-600"
                  onClick={() => onDelete?.(message)}
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="font-black text-[10px] uppercase tracking-widest">Delete Message</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Email Body - Gmail style with left padding for alignment */}
        <div className="px-6 py-8 md:pl-[76px] md:pr-12 md:pb-12 space-y-6">
          <div className="text-base text-foreground/80 dark:text-gray-200 leading-relaxed font-normal overflow-hidden">
            {message.htmlContent ? (
              <div 
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(stripEmailOpenTracking(message.htmlContent)) }}
                className="prose dark:prose-invert max-w-none text-base break-words [&_a]:text-primary [&_a]:underline"
              />
            ) : (
              <div className="whitespace-pre-wrap">{displayContent}</div>
            )}
          </div>
          
          {!message.htmlContent && quotedContent && (
            <div className="pt-4 border-t border-border/30">
              <button
                onClick={() => setShowQuoted((v) => !v)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 hover:text-primary hover:bg-primary/5 transition-all border border-border/50"
                title={showQuoted ? "Hide quoted text" : "Show quoted text"}
              >
                <MoreHorizontal className="w-4 h-4" />
                {showQuoted ? "HIDE QUOTED MESSAGE" : "SHOW QUOTED MESSAGE"}
              </button>
              {showQuoted && (
                <div className="mt-6 pl-6 border-l-2 border-primary/20 text-sm text-muted-foreground/60 whitespace-pre-wrap leading-relaxed italic animate-in fade-in slide-in-from-left-2 duration-500">
                  {quotedContent}
                </div>
              )}
            </div>
          )}

          <AttachmentList attachments={message.attachments} />
        </div>

        {isOutbound && <div className="border-t px-6 py-3"><EmailDeliveryActivity message={message} /></div>}
      </div>
    </div>
  );
}
