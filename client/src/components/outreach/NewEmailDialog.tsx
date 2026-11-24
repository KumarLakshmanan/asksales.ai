/**
 * NewEmailDialog - Modal for composing a brand-new email thread to a lead.
 * Prevents accidental replies to old conversations by providing a separate
 * compose experience that always creates a fresh outreach conversation.
 */

"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Send,
  LayoutTemplate,
  Mail,
  Sparkles,
} from "lucide-react";
import { TemplateSelector } from "./TemplateSelector";
import { EmailSenderPicker } from "./EmailSenderPicker";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import type { OutreachConversation } from "./types";

interface NewEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: number;
  leadName: string | null;
  leadEmail: string | null;
  /** Called after the email is sent successfully with the new conversation */
  onSent?: (conversation: OutreachConversation) => void;
  /** Optional AI generation handler */
  onAIGenerate?: (subject: string, message: string) => Promise<{ subject?: string; body?: string } | null>;
}

export function NewEmailDialog({
  open,
  onOpenChange,
  leadId,
  leadName,
  leadEmail,
  onSent,
  onAIGenerate,
}: NewEmailDialogProps) {
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedSenderId, setSelectedSenderId] = useState<number | undefined>();
  const [templateSelectorOpen, setTemplateSelectorOpen] = useState(false);
  const [generatingAI, setGeneratingAI] = useState(false);

  const resetForm = useCallback(() => {
    setSubject("");
    setMessage("");
    setSelectedSenderId(undefined);
  }, []);

  const handleSend = async () => {
    const content = message.trim();
    if (!content) {
      toast({ title: "Error", description: "Please enter a message", variant: "destructive" });
      return;
    }
    if (!subject.trim()) {
      toast({ title: "Error", description: "Please enter a subject", variant: "destructive" });
      return;
    }

    try {
      setSending(true);

      // Step 1: Create a brand-new conversation (forceNew ensures a fresh thread)
      const createRes = await api.post<{ conversation: OutreachConversation }>(
        "/api/outreach-conversations",
        {
          leadId,
          channel: "email",
          forceNew: true,
          subject: subject.trim(),
        }
      );

      if (!createRes.conversation) {
        toast({ title: "Error", description: "Failed to create conversation", variant: "destructive" });
        return;
      }

      const newConv = createRes.conversation;

      // Step 2: Send the message on the new conversation
      const body: Record<string, unknown> = { content };
      body.subject = subject.trim();
      if (selectedSenderId) body.senderId = selectedSenderId;

      await api.post(`/api/outreach-conversations/email/${newConv.id}/messages`, body);

      toast({ title: "Sent", description: "New email sent successfully" });
      resetForm();
      onOpenChange(false);
      onSent?.(newConv);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send email";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const handleAIGenerate = async () => {
    if (!onAIGenerate) return;
    try {
      setGeneratingAI(true);
      const result = await onAIGenerate(subject, message);
      if (result) {
        if (result.subject) setSubject(result.subject);
        if (result.body) setMessage(result.body);
      }
    } finally {
      setGeneratingAI(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!sending) { onOpenChange(v); if (!v) resetForm(); } }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Mail className="h-4 w-4 text-primary" />
            </div>
            New Email
          </DialogTitle>
          <DialogDescription>
            Compose a new email to{" "}
            <span className="font-semibold text-foreground">{leadName || "this lead"}</span>
            {leadEmail && (
              <>
                {" "}
                <Badge variant="outline" className="text-xs font-mono">
                  {leadEmail}
                </Badge>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Subject */}
          <div>
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1.5 block">
              Subject
            </label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Enter email subject..."
              className="font-medium"
              disabled={sending}
            />
          </div>

          {/* Message Body */}
          <div>
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1.5 block">
              Message
            </label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Type your message..."
              className="min-h-[200px] resize-y"
              disabled={sending}
            />
          </div>

          {/* Actions Row */}
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border/50">
            <EmailSenderPicker
              value={selectedSenderId}
              onChange={setSelectedSenderId}
            />
            <Button
              variant="ghost"
              size="sm"
              className="rounded-xl px-3 font-black text-[10px] uppercase tracking-widest hover:bg-background/80 transition-all"
              onClick={() => setTemplateSelectorOpen(true)}
              disabled={sending}
            >
              <LayoutTemplate className="w-3.5 h-3.5 mr-2 opacity-60" />
              Templates
            </Button>
            {onAIGenerate && (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "rounded-xl px-3 font-black text-[10px] uppercase tracking-widest hover:bg-background/80 transition-all",
                  generatingAI && "animate-pulse"
                )}
                onClick={handleAIGenerate}
                loading={generatingAI}
                disabled={sending}
              >
                <Sparkles className="w-3.5 h-3.5 mr-2 opacity-60" />
                AI Generate
              </Button>
            )}

            <div className="ml-auto">
              <Button
                onClick={handleSend}
                loading={sending}
                loadingText="Sending..."
                disabled={!message.trim() || !subject.trim()}
                className="rounded-xl gap-2 font-bold"
              >
                <Send className="w-4 h-4" />
                Send
              </Button>
            </div>
          </div>

          <TemplateSelector
            channel="email"
            open={templateSelectorOpen}
            onOpenChange={setTemplateSelectorOpen}
            leadId={leadId}
            onSelect={(template) => {
              setSubject(template.subject || template.name || "");
              setMessage(template.content);
              setTemplateSelectorOpen(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
