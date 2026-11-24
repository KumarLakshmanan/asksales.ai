"use client";

import { useCallback, useEffect, useRef, type AriaAttributes, type ReactNode, type RefObject } from "react";
import { ArrowUp, Loader2, Mic, MicOff, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ComposerAction } from "./types";

interface ConversationComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  inputDisabled?: boolean;
  busy?: boolean;
  allowQueue?: boolean;
  onStop?: () => void;
  sendDisabled?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onAttach?: () => void;
  attachmentDisabled?: boolean;
  onToggleVoice?: () => void;
  listening?: boolean;
  voiceLabel?: string;
  actions?: ComposerAction[];
  context?: ReactNode;
  controlsLayout?: "inline" | "toolbar";
  attachments?: ReactNode;
  subject?: ReactNode;
  editor?: ReactNode;
  inlineEditor?: boolean;
  footer?: ReactNode;
  shape?: "pill" | "panel";
  sendLabel?: string;
  sendButtonClassName?: string;
  maxHeight?: number;
  maxLength?: number;
  className?: string;
  inputAria?: Pick<AriaAttributes, 'aria-controls' | 'aria-expanded' | 'aria-activedescendant' | 'aria-autocomplete'>;
}

export function ConversationComposer({
  value,
  onValueChange,
  onSend,
  onKeyDown,
  placeholder = "Write a message…",
  disabled = false,
  inputDisabled = false,
  busy = false,
  allowQueue = false,
  onStop,
  sendDisabled = false,
  textareaRef,
  onAttach,
  attachmentDisabled = false,
  onToggleVoice,
  listening = false,
  voiceLabel = "Start dictation",
  actions = [],
  context,
  controlsLayout = "inline",
  attachments,
  subject,
  editor,
  inlineEditor = false,
  footer,
  shape = "pill",
  sendLabel,
  sendButtonClassName,
  maxHeight = shape === "pill" ? 120 : 180,
  maxLength,
  className,
  inputAria,
}: ConversationComposerProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const resolvedRef = textareaRef || internalRef;

  const resize = useCallback(() => {
    const textarea = resolvedRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [maxHeight, resolvedRef]);

  useEffect(() => {
    resize();
  }, [resize, value]);

  useEffect(() => {
    const textarea = resolvedRef.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resize, resolvedRef]);

  const cannotSend = disabled || (busy && !allowQueue) || sendDisabled;

  return (
    <div className={cn("w-full", className)}>
      {subject}
      {attachments ? <div className="mb-2">{attachments}</div> : null}
      <div
        className={cn(
          "border border-border/80 bg-card shadow-[0_8px_28px_rgb(0_0_0/0.08)] transition-[border-color,box-shadow] focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/10",
          shape === "pill" ? "rounded-2xl p-2" : "rounded-xl p-2.5",
          disabled && !inlineEditor && "opacity-65",
        )}
      >
        {inlineEditor ? null : editor}
        <div className={cn("flex min-w-0 items-end gap-1.5", editor && !inlineEditor && "mt-2", inlineEditor && "items-center gap-1")}>
          {onAttach ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onAttach}
              disabled={disabled || busy || attachmentDisabled}
              className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              aria-label="Attach files"
              title="Attach files"
            >
              {attachmentDisabled && busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            </Button>
          ) : null}

          {editor ? <div className="min-w-0 flex-1">{inlineEditor ? editor : null}</div> : <Textarea
            ref={resolvedRef}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            disabled={disabled || inputDisabled}
            rows={1}
            maxLength={maxLength}
            className={cn(
              "min-h-[42px] min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-2.5 text-sm leading-5 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0",
              shape === "panel" && "min-h-[76px]",
            )}
            style={{ maxHeight }}
            aria-label="Message"
            {...inputAria}
          />}

          {controlsLayout === "inline" ? context : null}
          {controlsLayout === "inline" && actions.map((action) => (
            <Button
              key={action.id}
              type="button"
              variant="ghost"
              size="icon"
              onClick={action.onClick}
              disabled={disabled || busy || action.disabled}
              className={cn("h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground", action.active && "bg-primary/10 text-primary")}
              aria-label={action.label}
              title={action.label}
            >
              {action.icon}
            </Button>
          ))}
          {onToggleVoice && controlsLayout === "inline" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onToggleVoice}
              disabled={(disabled || busy) && !listening}
              className={cn("h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground", listening && "bg-destructive/10 text-destructive")}
              aria-label={listening ? "Stop recording" : voiceLabel}
              aria-pressed={listening}
              title={listening ? "Stop recording" : voiceLabel}
            >
              {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          ) : null}

          {busy && onStop && <Button type="button" variant="outline" size="sm" onClick={onStop} aria-label="Stop current response">Stop</Button>}
          <Button
            type="button"
            onClick={onSend}
            disabled={cannotSend}
            size={sendLabel ? "sm" : "icon"}
            className={cn("h-9 shrink-0 rounded-lg", sendLabel ? "gap-1.5 px-3" : "w-9", inlineEditor && "w-9 px-0 sm:w-auto sm:px-3", sendButtonClassName)}
            aria-label={busy && allowQueue ? "Queue message" : sendLabel || "Send message"}
            title={busy && allowQueue ? "Queue message" : sendLabel || "Send message"}
          >
            {busy && !allowQueue ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            {sendLabel ? <span className={inlineEditor ? "hidden sm:inline" : undefined}>{busy ? "Sending…" : sendLabel}</span> : null}
          </Button>
        </div>
        {controlsLayout === "toolbar" && (context || actions.length > 0 || onToggleVoice) ? (
          <div className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-1 gap-y-1 border-t border-border/60 px-1 pt-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {context}
              {actions.map((action) => (
                <Button
                  key={action.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={action.onClick}
                  disabled={disabled || busy || action.disabled}
                  className={cn("h-8 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground", action.active && "bg-primary/10 text-primary")}
                  aria-label={action.label}
                  title={action.label}
                >
                  {action.icon}
                  <span className="ml-1.5">{action.label}</span>
                </Button>
              ))}
            </div>
            {onToggleVoice ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onToggleVoice}
                disabled={(disabled || busy) && !listening}
                className={cn(
                  "h-8 gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:bg-primary/5 hover:text-primary",
                  listening && "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
                )}
                aria-label={listening ? "Stop recording" : voiceLabel}
                aria-pressed={listening}
                title={listening ? "Stop recording" : voiceLabel}
              >
                {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                <span className="hidden sm:inline">{listening ? "Stop dictation" : "Dictate"}</span>
                <span className="sm:hidden">{listening ? "Stop" : "Voice"}</span>
                {listening ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" aria-hidden="true" /> : null}
              </Button>
            ) : null}
          </div>
        ) : null}
        {busy && allowQueue && <p className="px-1 pt-2 text-xs text-muted-foreground" role="status">New messages will run after the current response. Stop takes effect before the next action.</p>}
        {footer ? <div className="mt-2 border-t border-border/50 px-1 pt-2">{footer}</div> : null}
      </div>
      {listening ? (
        <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-destructive" aria-live="polite">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
          Listening...
        </p>
      ) : null}
    </div>
  );
}
