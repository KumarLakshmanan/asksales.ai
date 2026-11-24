/**
 * EmailThread - Gmail-style email conversation thread
 * Renders a list of messages with expandable cards
 */

import { useMemo } from "react";
import { EmailThreadMessage } from "./EmailThreadMessage";
import type { OutreachMessage, OutreachConversation } from "./types";
import { AtSign } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";

interface EmailThreadProps {
  messages: OutreachMessage[];
  /** Current conversation for recipient info */
  conversation?: OutreachConversation | null;
  /** Sender name for outbound messages (your name/company) */
  senderName?: string;
  /** Sender email for outbound messages */
  senderEmail?: string;
  /** Callbacks */
  onEditDraft?: (message: OutreachMessage) => void;
  onSendDraft?: (message: OutreachMessage) => void;
  onDiscardDraft?: (message: OutreachMessage) => void;
  onReply?: (message: OutreachMessage) => void;
  onForward?: (message: OutreachMessage) => void;
  onDelete?: (message: OutreachMessage) => void;
}

export function EmailThread({
  messages,
  conversation,
  senderName = "Me",
  senderEmail,
  onEditDraft,
  onSendDraft,
  onDiscardDraft,
  onReply,
  onForward,
  onDelete,
}: EmailThreadProps) {
  // Group messages by subject thread (simplified - just show all messages)
  // Find the latest non-draft message index
  const latestMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].status !== "draft") {
        return i;
      }
    }
    return messages.length - 1;
  }, [messages]);

  // Get recipient info from conversation
  const recipientName = conversation?.leadName || undefined;
  const recipientEmail = conversation?.leadEmail || undefined;
  const recipientAvatar = conversation?.leadAvatar || undefined;

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-12">
        <div className="w-16 h-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4 opacity-20">
          <AtSign className="w-8 h-8" />
        </div>
        <p className="font-heading font-bold italic text-lg opacity-40">Empty Conversation</p>
        <p className="text-sm opacity-50 mt-1">No messages in this conversation yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col max-w-5xl mx-auto w-full py-6 px-4 md:px-8 space-y-6">
      {/* Thread header with subject */}
      {messages[0]?.subject && (
        <div className="mb-4 space-y-1 animate-in fade-in slide-in-from-top-4 duration-500">
          <div className="flex items-center gap-3 mb-2">
            <span className="font-black text-[10px] uppercase tracking-[0.2em] text-primary/60 bg-primary/5 px-2 py-0.5 rounded-md">Conversation</span>
            <div className="h-[1px] flex-1 bg-gradient-to-r from-border/50 to-transparent" />
          </div>
          <h2 className="text-3xl md:text-2xl font-heading font-bold tracking-tighter italic tracking-tight text-foreground leading-tight">
            {messages[0].subject}
          </h2>
          <div className="flex items-center gap-4 mt-3">
             <div className="flex items-center gap-1.5 opacity-40">
                <span className="font-black text-[9px] uppercase tracking-widest leading-none">Total Messages</span>
                <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-black border-border/50 bg-background/50">
                  {messages.length}
                </Badge>
             </div>
             <div className="w-1 h-1 rounded-full bg-border" />
             <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground opacity-60">
                Started {formatDistanceToNow(new Date(messages[0].createdAt || new Date()), { addSuffix: true })}
             </p>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex flex-col gap-4">
        {messages.map((message, index) => (
          <EmailThreadMessage
            key={message.id}
            message={message}
            senderName={senderName}
            senderEmail={senderEmail}
            recipientName={recipientName}
            recipientEmail={recipientEmail}
            recipientAvatar={recipientAvatar}
            isLatest={index === latestMessageIndex || message.status === "draft"}
            onEditDraft={onEditDraft}
            onSendDraft={onSendDraft}
            onDiscardDraft={onDiscardDraft}
            onReply={onReply}
            onForward={onForward}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}
