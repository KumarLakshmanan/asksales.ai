"use client";

import { useRef, useCallback, useEffect, useLayoutEffect, useImperativeHandle, useState, type Ref, type KeyboardEvent } from "react";
import DOMPurify from "dompurify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bold, Italic, Underline, Strikethrough, List, ListOrdered, Link, Heading2, AlignLeft, AlignCenter, AlignRight, Undo, Redo } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RichTextEditorHandle {
  insertText: (text: string) => void;
}

const toggleCommands = ["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList", "justifyLeft", "justifyCenter", "justifyRight"];

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
  id?: string;
  label?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  editorRef?: Ref<RichTextEditorHandle>;
}

export default function RichTextEditor({ value, onChange, placeholder = "Start typing…", className, disabled = false, compact = false, id, label = "Email message", onKeyDown, onFocus, editorRef: handleRef }: RichTextEditorProps) {
  const editor = useRef<HTMLDivElement>(null);
  const selection = useRef<Range | null>(null);
  const emitted = useRef<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const [active, setActive] = useState<Record<string, boolean>>({});

  // Update only for an external change (template, AI draft, clear). Updating
  // innerHTML on each keystroke destroys the browser's selection and undo stack.
  useLayoutEffect(() => {
    if (!editor.current || value === emitted.current) return;
    const safe = DOMPurify.sanitize(value || "");
    if (editor.current.innerHTML !== safe) {
      editor.current.innerHTML = safe;
      selection.current = null;
    }
    emitted.current = value;
  }, [value]);

  const rememberSelection = useCallback(() => {
    const current = window.getSelection();
    if (current?.rangeCount && editor.current?.contains(current.anchorNode) && editor.current.contains(current.focusNode)) {
      selection.current = current.getRangeAt(0).cloneRange();
      if (typeof document.queryCommandState === "function") {
        const next = Object.fromEntries(toggleCommands.map(command => [command, document.queryCommandState(command)]));
        setActive(previous => toggleCommands.every(command => previous[command] === next[command]) ? previous : next);
      }
    }
  }, []);
  useEffect(() => {
    document.addEventListener("selectionchange", rememberSelection);
    return () => document.removeEventListener("selectionchange", rememberSelection);
  }, [rememberSelection]);
  const restoreSelection = useCallback(() => {
    const element = editor.current;
    if (!element) return;
    element.focus();
    const current = window.getSelection();
    const range = selection.current;
    if (range && element.contains(range.commonAncestorContainer)) {
      current?.removeAllRanges();
      current?.addRange(range);
    } else {
      const end = document.createRange();
      end.selectNodeContents(element);
      end.collapse(false);
      current?.removeAllRanges();
      current?.addRange(end);
    }
  }, []);
  const emitChange = useCallback(() => {
    if (!editor.current) return;
    const html = DOMPurify.sanitize(editor.current.innerHTML);
    emitted.current = html;
    rememberSelection();
    onChange(html);
  }, [onChange, rememberSelection]);
  const exec = useCallback((command: string, argument?: string) => {
    if (disabled) return;
    restoreSelection();
    document.execCommand(command, false, argument);
    emitChange();
  }, [disabled, restoreSelection, emitChange]);
  useImperativeHandle(handleRef, () => ({ insertText: (text) => exec("insertText", text) }), [exec]);

  const buttons = [
    { icon: Bold, command: "bold", title: "Bold" },
    { icon: Italic, command: "italic", title: "Italic" },
    { icon: Underline, command: "underline", title: "Underline" },
    { icon: Strikethrough, command: "strikeThrough", title: "Strikethrough" },
    { icon: List, command: "insertUnorderedList", title: "Bullet list" },
    { icon: ListOrdered, command: "insertOrderedList", title: "Numbered list" },
    ...(!compact ? [
      { icon: Heading2, command: "formatBlock", argument: "h2", title: "Heading" },
      { icon: AlignLeft, command: "justifyLeft", title: "Align left" },
      { icon: AlignCenter, command: "justifyCenter", title: "Align center" },
      { icon: AlignRight, command: "justifyRight", title: "Align right" },
    ] : []),
    { icon: Link, command: "link", title: "Insert link" },
    { icon: Undo, command: "undo", title: "Undo" },
    { icon: Redo, command: "redo", title: "Redo" },
  ];

  return <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border bg-card", disabled && "opacity-65", className)}>
    <div role="toolbar" aria-label="Email formatting" className="flex flex-wrap items-center gap-0.5 border-b bg-muted/50 p-1">
      {buttons.map(({ icon: Icon, command, title, ...button }) => <Button key={command} type="button" variant="ghost" size="icon" className={cn("h-11 w-11 shrink-0 rounded-md", active[command] && "bg-primary/10 text-primary")} title={title} aria-label={title} aria-pressed={toggleCommands.includes(command) ? Boolean(active[command]) : undefined} disabled={disabled}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (command === "link") { rememberSelection(); setLinkOpen((open) => !open); setLinkError(""); }
          else exec(command, "argument" in button ? button.argument : undefined);
        }}><Icon className="h-4 w-4" /></Button>)}
    </div>
    {linkOpen && <div className="space-y-1 border-b p-2">
      <div className="flex min-w-0 flex-wrap gap-2">
        <Input aria-label="Link URL" type="url" className="min-w-0 flex-1" value={linkUrl} disabled={disabled} placeholder="https://example.com" onChange={(event) => { setLinkUrl(event.target.value); setLinkError(""); }} />
        <Button type="button" size="sm" disabled={disabled || !linkUrl.trim()} onClick={() => {
          const url = linkUrl.trim();
          if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) { setLinkError("Enter an https, http, email or phone link."); return; }
          exec("createLink", url); setLinkOpen(false); setLinkUrl("");
        }}>Apply link</Button>
      </div>
      {linkError && <p role="alert" className="text-xs text-destructive">{linkError}</p>}
    </div>}
    <div id={id} ref={editor} contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-label={label} aria-multiline="true" aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      className={cn("min-w-0 overflow-y-auto whitespace-pre-wrap break-words p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 [&:empty]:before:pointer-events-none [&:empty]:before:text-muted-foreground [&:empty]:before:content-[attr(data-placeholder)] [&_h2]:text-lg [&_h2]:font-semibold [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_img]:max-w-full", compact ? "min-h-[96px] max-h-[220px]" : "min-h-[200px] max-h-[480px]")}
      onInput={emitChange} onFocus={onFocus} onKeyDown={onKeyDown} onKeyUp={rememberSelection} onMouseUp={rememberSelection} onTouchEnd={rememberSelection} onBlur={rememberSelection}
      onPaste={(event) => {
        event.preventDefault();
        const html = event.clipboardData.getData("text/html");
        rememberSelection();
        if (html) exec("insertHTML", DOMPurify.sanitize(html));
        else exec("insertText", event.clipboardData.getData("text/plain"));
      }} data-placeholder={placeholder} />
  </div>;
}
