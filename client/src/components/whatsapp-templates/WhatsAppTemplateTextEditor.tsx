"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Bold, Code, Italic, Plus, Strikethrough } from "lucide-react";
import { editWhatsAppText, formatWhatsAppSelection, nextWhatsAppVariable, type WhatsAppTextEdit } from "@/lib/whatsapp-template-text";

const fieldClassName = "w-full rounded-[10px] border border-input bg-card px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/80 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";
const formattingActions = [
  { label: "Bold text", icon: Bold, delimiter: "*" },
  { label: "Italic text", icon: Italic, delimiter: "_" },
  { label: "Strikethrough text", icon: Strikethrough, delimiter: "~" },
  { label: "Monospace text", icon: Code, delimiter: "```" },
];

export function WhatsAppTemplateTextEditor({
  component,
  value,
  onChange,
  onVariableAdded,
  disabled = false,
  error,
}: {
  component: "header" | "body";
  value: string;
  onChange: (value: string) => void;
  onVariableAdded: (index: number) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const pendingSelection = useRef<WhatsAppTextEdit | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const limit = component === "header" ? 60 : 1024;
  useLayoutEffect(() => {
    const edit = pendingSelection.current;
    if (!edit || edit.value !== value) return;
    pendingSelection.current = null;
    field.current?.focus();
    field.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  }, [value]);
  const applyEdit = (edit: WhatsAppTextEdit | null) => {
    if (!edit) {
      setEditError(`This change would exceed the ${limit}-character limit.`);
      return false;
    }
    setEditError(null);
    if (edit.value === value) {
      field.current?.focus();
      field.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    } else {
      pendingSelection.current = edit;
      onChange(edit.value);
    }
    return true;
  };
  const insertVariable = () => {
    if (disabled) return;
    const start = field.current?.selectionStart ?? value.length;
    const end = field.current?.selectionEnd ?? start;
    const index = nextWhatsAppVariable(value.slice(0, start) + value.slice(end));
    if (applyEdit(editWhatsAppText(value, start, end, `{{${index}}}`, limit))) onVariableAdded(index);
  };
  const variableButton = <button type="button" disabled={disabled} aria-label={`Add ${component} variable`} onMouseDown={(event) => event.preventDefault()} onClick={insertVariable} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-semibold text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-3.5 w-3.5" />Variable</button>;
  const describedBy = error || editError ? `whatsapp-${component}-error` : undefined;

  return <div>
    {component === "body" && <div role="toolbar" aria-label="Body formatting" className="mb-2 flex flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1">
      {formattingActions.map(({ label, icon: Icon, delimiter }) => <button key={label} type="button" aria-label={label} title={label} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => {
        if (disabled) return;
        const start = field.current?.selectionStart ?? value.length;
        const end = field.current?.selectionEnd ?? start;
        applyEdit(formatWhatsAppSelection(value, start, end, delimiter));
      }} className="flex h-11 w-11 items-center justify-center rounded-md text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"><Icon className="h-4 w-4" /></button>)}
      <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />{variableButton}
    </div>}
    <div className={component === "header" ? "flex flex-wrap gap-2" : ""}>
      {component === "header" ? <input id="whatsapp-header-text" ref={(node) => { field.current = node; }} aria-label="Header text" aria-invalid={Boolean(error || editError)} aria-describedby={describedBy} value={value} onChange={(event) => { setEditError(null); onChange(event.target.value); }} maxLength={limit} disabled={disabled} placeholder="Header title" className={`${fieldClassName} min-h-11 min-w-0 flex-1 ${error ? "border-destructive" : ""}`} />
        : <textarea id="whatsapp-body" ref={(node) => { field.current = node; }} aria-label="Body" aria-invalid={Boolean(error || editError)} aria-describedby={describedBy} value={value} onChange={(event) => { setEditError(null); onChange(event.target.value); }} maxLength={limit} disabled={disabled} rows={7} placeholder="Write your message" className={`${fieldClassName} min-h-48 resize-y p-3 leading-6 ${error ? "border-destructive" : ""}`} />}
      {component === "header" && variableButton}
    </div>
    <div className="mt-2 flex items-start justify-between gap-3">
      <p className="text-xs leading-5 text-muted-foreground">{component === "body" ? "Select text to format it. Add variables for personalized details." : "A short title for your message."}</p>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{value.length}/{limit}</span>
    </div>
    {(error || editError) && <p id={`whatsapp-${component}-error`} role="alert" className="mt-2 text-xs text-destructive">{error || editError}</p>}
  </div>;
}
