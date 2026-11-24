"use client";

/**
 * EmailComposeBuilder - Rich email compose component for outreach
 * Provides Rich Text (WYSIWYG), HTML code, and DnD email builder tabs
 * with AI Generate capability and file attachments
 */

import { useState, useCallback, useRef } from "react";
import DOMPurify from "dompurify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Send,
  Loader2,
  Sparkles,
  Code,
  Type,
  LayoutTemplate,
  FileText,
  Paperclip,
  Eye,
  EyeOff,
  X,
  Wand2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import DefaultEditor from "react-simple-wysiwyg";
import { emailHtmlToText } from "@/lib/messageFormatting";
import DnDEmailBuilder, {
  blocksToHtml,
  blocksToPlainText,
  type EmailBlock,
} from "@/components/email-builder/DnDEmailBuilder";

export interface EmailAttachment {
  id: string;
  fileId?: number | null;
  url: string;
  inlineUrl?: string;
  downloadUrl?: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  size: number;
  status?: string;
  extractionStatus?: string;
  extractionError?: string | null;
  deliveryStatus?: string;
  deliveryError?: string | null;
  mediaKind?: string | null;
}

interface EmailComposeBuilderProps {
  /** Current plain-text / rich-text message content */
  message: string;
  onMessageChange: (message: string) => void;
  /** HTML content (synced with rich text / code tabs) */
  htmlContent: string;
  onHtmlContentChange: (html: string) => void;
  /** Subject line */
  subject: string;
  onSubjectChange: (subject: string) => void;
  /** Whether to show the subject field (default true) */
  showSubject?: boolean;
  /** Send handler */
  onSend: () => void;
  sending?: boolean;
  disabled?: boolean;
  /** Template selector */
  showTemplate?: boolean;
  onTemplateClick?: () => void;
  /** Attachment */
  showAttachment?: boolean;
  attachments?: EmailAttachment[];
  onAttachmentsChange?: (attachments: EmailAttachment[]) => void;
  uploading?: boolean;
  onFilesSelected?: (files: FileList) => void;
  /** AI Generate handler - receives optional prompt string */
  onAIGenerate?: (prompt?: string) => void;
  aiGenerating?: boolean;
}

export function EmailComposeBuilder({
  message,
  onMessageChange,
  htmlContent,
  onHtmlContentChange,
  subject,
  onSubjectChange,
  showSubject = true,
  onSend,
  sending = false,
  disabled = false,
  showTemplate = false,
  onTemplateClick,
  showAttachment = false,
  attachments = [],
  onAttachmentsChange,
  uploading = false,
  onFilesSelected,
  onAIGenerate,
  aiGenerating = false,
}: EmailComposeBuilderProps) {
  const [activeTab, setActiveTab] = useState<string>("richtext");
  const [blocks, setBlocks] = useState<EmailBlock[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleEnhancePrompt = useCallback(async () => {
    if (!aiPrompt.trim()) return;
    setEnhancingPrompt(true);
    try {
      const result = await api.post<{
        success: boolean;
        enhancedPrompt?: string;
        tips?: string;
      }>("/api/content/studio/magic-prompt", {
        currentPrompt: aiPrompt,
        contentType: "email",
      });
      if (result.success && result.enhancedPrompt) {
        setAiPrompt(result.enhancedPrompt);
        toast({ title: "Prompt Enhanced!", description: result.tips || "Your prompt has been improved with AI" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to enhance prompt", variant: "destructive" });
    } finally {
      setEnhancingPrompt(false);
    }
  }, [aiPrompt, toast]);

  // Sync rich text content to parent
  const handleRichTextChange = useCallback(
    (e: { target: { value: string } }) => {
      const html = e.target.value;
      onHtmlContentChange(html);
      onMessageChange(emailHtmlToText(html));
    },
    [onMessageChange, onHtmlContentChange]
  );

  // Sync HTML code to parent
  const handleHtmlCodeChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const html = e.target.value;
      onHtmlContentChange(html);
      onMessageChange(emailHtmlToText(html));
    },
    [onMessageChange, onHtmlContentChange]
  );

  // Sync DnD blocks → parent
  const handleBlocksChange = useCallback(
    (newBlocks: EmailBlock[]) => {
      setBlocks(newBlocks);
      const html = blocksToHtml(newBlocks, subject);
      const text = blocksToPlainText(newBlocks);
      onHtmlContentChange(html);
      onMessageChange(text);
    },
    [subject, onMessageChange, onHtmlContentChange]
  );

  // Apply AI generated content to the current tab
  const handleSendClick = useCallback(() => {
    onSend();
  }, [onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  const canSend = !!(message.trim() || htmlContent.trim());

  return (
    <div className="border-t bg-background">
      {/* Subject */}
      {showSubject && (
        <div className="px-4 pt-3">
          <Input
            placeholder="Subject (optional)"
            value={subject}
            onChange={(e) => onSubjectChange(e.target.value)}
            className="text-sm"
            disabled={disabled || sending}
          />
        </div>
      )}

      {/* Editor Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="px-4 pt-2">
        <div className="flex items-center justify-between mb-2">
          <TabsList className="h-8">
            <TabsTrigger value="richtext" className="text-xs gap-1 px-2 h-7">
              <Type className="w-3 h-3" />
              Rich Text
            </TabsTrigger>
            <TabsTrigger value="html" className="text-xs gap-1 px-2 h-7">
              <Code className="w-3 h-3" />
              HTML
            </TabsTrigger>
            <TabsTrigger value="builder" className="text-xs gap-1 px-2 h-7">
              <LayoutTemplate className="w-3 h-3" />
              Builder
            </TabsTrigger>
            {onAIGenerate && (
              <TabsTrigger
                value="ai"
                className="text-xs gap-1 px-2 h-7"
              >
                {aiGenerating ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                AI
              </TabsTrigger>
            )}
          </TabsList>

          {/* Preview toggle for HTML / Builder */}
          {(activeTab === "html" || activeTab === "builder") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setShowPreview(!showPreview)}
            >
              {showPreview ? (
                <EyeOff className="w-3 h-3" />
              ) : (
                <Eye className="w-3 h-3" />
              )}
              {showPreview ? "Hide Preview" : "Preview"}
            </Button>
          )}
        </div>

        {/* Rich Text Tab */}
        <TabsContent value="richtext" className="mt-0">
          <div
            className="border rounded-md overflow-hidden [&_.rsw-editor]:min-h-[120px] [&_.rsw-editor]:max-h-[300px] [&_.rsw-editor]:overflow-y-auto [&_.rsw-toolbar]:bg-muted/50 [&_.rsw-toolbar]:border-b [&_.rsw-ce]:p-3 [&_.rsw-ce]:text-sm [&_.rsw-btn]:text-foreground"
            onKeyDown={handleKeyDown}
          >
            <DefaultEditor
              value={htmlContent}
              onChange={handleRichTextChange}
            />
          </div>
        </TabsContent>

        {/* HTML Code Tab */}
        <TabsContent value="html" className="mt-0">
          <div className="space-y-2">
            <Textarea
              placeholder="<html>...</html>"
              value={htmlContent}
              onChange={handleHtmlCodeChange}
              className="min-h-[120px] max-h-[300px] font-mono text-xs resize-none"
              disabled={disabled || sending}
              onKeyDown={handleKeyDown}
            />
            {showPreview && htmlContent && (
              <div className="max-h-[200px] overflow-y-auto rounded-md border bg-white p-3 text-gray-900">
                <div
                  className="text-sm"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(htmlContent) }}
                />
              </div>
            )}
          </div>
        </TabsContent>

        {/* DnD Builder Tab */}
        <TabsContent value="builder" className="mt-0">
          <div className="border rounded-md p-3 max-h-[400px] overflow-y-auto">
            <DnDEmailBuilder blocks={blocks} onChange={handleBlocksChange} />
          </div>
          {showPreview && blocks.length > 0 && (
            <div className="mt-2 max-h-[200px] overflow-y-auto rounded-md border bg-white p-3 text-gray-900">
              <div
                className="text-sm"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(blocksToHtml(blocks, subject)),
                }}
              />
            </div>
          )}
        </TabsContent>

        {/* AI Prompt Tab */}
        {onAIGenerate && (
          <TabsContent value="ai" className="mt-0">
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Describe the email you want to generate. AI will create the HTML content for you.
              </p>
              <div className="relative">
                <Textarea
                  placeholder="e.g. Write a follow-up email about our product demo, mention the key features we discussed..."
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  className="min-h-[100px] max-h-[200px] resize-none text-sm pr-10"
                  disabled={disabled || sending || aiGenerating || enhancingPrompt}
                />
                {aiPrompt.trim() && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-2 top-2 h-7 w-7 text-purple-500 hover:text-purple-700 hover:bg-purple-50 dark:hover:bg-purple-950"
                    onClick={handleEnhancePrompt}
                    loading={enhancingPrompt}
                    disabled={disabled || sending || aiGenerating}
                    title="Enhance prompt with AI"
                  >
                    <Wand2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
              <Button
                onClick={() => {
                  onAIGenerate(aiPrompt || undefined);
                }}
                loading={aiGenerating}
                loadingText="Generating..."
                disabled={disabled || sending || enhancingPrompt}
                className="w-full gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
                size="sm"
              >
                <Sparkles className="w-4 h-4" />
                Generate Email
              </Button>
            </div>
          </TabsContent>
        )}
      </Tabs>

      {/* Attachment List */}
      {attachments.length > 0 && (
        <div className="px-4 pt-2 flex flex-wrap gap-2">
          {attachments.map((att, idx) => (
            <div
              key={att.id || att.fileId || idx}
              className="flex items-center gap-1.5 bg-muted/60 border rounded-md px-2 py-1 text-xs"
            >
              <Paperclip className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="truncate max-w-[140px]" title={att.originalName}>
                {att.originalName}
              </span>
              <span className="text-muted-foreground whitespace-nowrap">
                ({(att.size / 1024).toFixed(0)} KB)
              </span>
              <button
                type="button"
                className="ml-0.5 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  onAttachmentsChange?.(attachments.filter((_, i) => i !== idx));
                }}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.gif,.webp"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFilesSelected?.(e.target.files);
          }
          // Reset so the same file can be re-selected
          e.target.value = "";
        }}
      />

      {/* Actions Row */}
      <div className="px-4 pb-3 pt-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {showAttachment && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || sending || uploading}
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Paperclip className="w-4 h-4" />
              )}
            </Button>
          )}
          {showTemplate && (
            <Button
              variant="outline"
              size="sm"
              onClick={onTemplateClick}
              disabled={disabled || sending}
            >
              <FileText className="w-4 h-4 mr-2" />
              Use Template
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Ctrl+Enter to send</span>
          <Button
            onClick={handleSendClick}
            loading={sending}
            disabled={!canSend || disabled}
          >
            <Send className="w-4 h-4 mr-2" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
