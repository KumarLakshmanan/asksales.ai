"use client";

import { useLayoutEffect, useRef, useState, type RefObject, type KeyboardEvent } from "react";
import { Bold, Italic, Strikethrough, Code, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import RichTextEditor, { type RichTextEditorHandle } from "@/components/RichTextEditor";
import { emailHtmlToText, plainTextToHtml } from "@/lib/messageFormatting";
import { formatWhatsAppSelection, type WhatsAppTextEdit } from "@/lib/whatsapp-template-text";
import { cn } from "@/lib/utils";
import type { OutreachChannel } from "./types";

interface Props {
  channel: OutreachChannel;
  value: string;
  onChange: (value: string) => void;
  htmlContent?: string;
  onHtmlChange?: (html: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  richTextRef?: RefObject<RichTextEditorHandle | null>;
  id?: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  maxLength?: number;
  compact?: boolean;
  inline?: boolean;
  onKeyDown?: (event: KeyboardEvent) => void;
  onFocus?: () => void;
}

const whatsappActions = [
  { label: "Bold", icon: Bold, delimiter: "*" },
  { label: "Italic", icon: Italic, delimiter: "_" },
  { label: "Strikethrough", icon: Strikethrough, delimiter: "~" },
  { label: "Monospace", icon: Code, delimiter: "```" },
];

/** Email sends HTML plus a text alternative; WhatsApp sends native text markers. */
export function ChannelMessageEditor({ channel, value, onChange, htmlContent, onHtmlChange, textareaRef, richTextRef, id, label = "Message", placeholder, disabled, rows = 4, maxLength, compact = false, inline = false, onKeyDown, onFocus }: Props) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const field = textareaRef || internalRef;
  const pending = useRef<WhatsAppTextEdit | null>(null);
  const [formatError, setFormatError] = useState("");
  const [formatOpen, setFormatOpen] = useState(false);
  useLayoutEffect(() => {
    const edit = pending.current;
    if (!edit || edit.value !== value) return;
    pending.current = null;
    field.current?.focus();
    field.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  }, [value, field]);
  const format = (delimiter: string) => {
    if (disabled) return;
    const start = field.current?.selectionStart ?? value.length;
    const end = field.current?.selectionEnd ?? start;
    const edit = formatWhatsAppSelection(value, start, end, delimiter, maxLength ?? 4096);
    if (!edit) { setFormatError("Formatting would exceed the message length limit."); return; }
    setFormatError("");
    pending.current = edit;
    onChange(edit.value);
  };

  if (channel === "email" && onHtmlChange) return <RichTextEditor
    id={id} label={label} value={htmlContent || plainTextToHtml(value)}
    onChange={(html) => { onChange(emailHtmlToText(html)); onHtmlChange(html); }}
    disabled={disabled} placeholder={placeholder} compact={compact}
    editorRef={richTextRef} onFocus={onFocus} onKeyDown={onKeyDown}
  />;

  const formatting = channel === "whatsapp" && (
    <div role="toolbar" aria-label="WhatsApp formatting" className={cn("flex flex-wrap items-center gap-0.5", !inline && "mb-1 rounded-md bg-muted/50 p-1")}>
      {whatsappActions.map(({ label: action, icon: Icon, delimiter }) => <Button key={action} type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 rounded-md" disabled={disabled} title={action} aria-label={action}
        onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}
        onClick={() => { setFormatOpen(false); format(delimiter); }}><Icon className="h-4 w-4" /></Button>)}
      {!inline && <span className="px-2 text-[11px] text-muted-foreground">WhatsApp formatting</span>}
    </div>
  );
  return <div className={cn("min-w-0", inline && "relative")}>
    {!inline && formatting}
    <Textarea ref={field} id={id} aria-label={label} value={value} onChange={(event) => { setFormatError(""); onChange(event.target.value); }}
      onFocus={onFocus} disabled={disabled} placeholder={placeholder} rows={inline ? 1 : rows} maxLength={maxLength}
      className={cn("min-w-0", inline ? "min-h-10 max-h-28 resize-none border-0 bg-transparent px-2 py-2 pr-9 shadow-none focus-visible:ring-0" : "resize-y", compact && !inline && "min-h-[76px] max-h-[180px] border-0 bg-transparent shadow-none focus-visible:ring-0")}
      onKeyDown={(event) => {
        if (channel === "whatsapp" && (event.ctrlKey || event.metaKey) && ["b", "i"].includes(event.key.toLowerCase())) {
          event.preventDefault(); format(event.key.toLowerCase() === "b" ? "*" : "_");
        } else onKeyDown?.(event);
      }} />
    {inline && !disabled && formatting && (
      <Popover open={formatOpen} onOpenChange={setFormatOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0.5 size-9" aria-label="Format message" title="Format message">
            <Type className="size-4" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-max p-1" onCloseAutoFocus={(event) => {
          if (document.activeElement === field.current) event.preventDefault();
        }}>
          {formatting}
        </PopoverContent>
      </Popover>
    )}
    {formatError && <p role="alert" className="mt-1 text-xs text-destructive">{formatError}</p>}
  </div>;
}
