"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, ExternalLink, FileText, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationSource } from "./types";

interface SourceTrayProps {
  sources: ConversationSource[];
  confidence?: number | null;
  label?: string;
  defaultExpanded?: boolean;
  className?: string;
}
function confidenceLabel(confidence?: number | null) {
  if (confidence == null) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return "Review suggested";
  if (confidence >= 0.8) return "High grounding";
  if (confidence >= 0.55) return "Medium grounding";
  return "Review suggested";
}

export function SourceTray({ sources, confidence, label = "Sources", defaultExpanded = false, className }: SourceTrayProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (sources.length === 0 && confidence == null) return null;
  // Routing/intent confidence without evidence is not grounding confidence.
  const grounding = sources.length === 0 ? "No source evidence" : confidenceLabel(confidence);

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border/60 bg-muted/20", className)}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <BookOpen className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        <span className="font-medium text-foreground">{sources.length} {sources.length === 1 ? label.replace(/s$/, "") : label}</span>
        {grounding ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {grounding}
          </span>
        ) : <span className="ml-auto" />}
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="border-t border-border/60 p-2">
          <p className="px-1 pb-2 text-[11px] leading-5 text-muted-foreground">These sources support reviewing the answer. Match percentages describe retrieval similarity, not a guarantee that the answer is correct.</p>
          <div className="grid gap-2 sm:grid-cols-2">
          {sources.map((source, index) => {
            const content = (
              <>
                <div className="flex min-w-0 items-start gap-2">
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground">{source.title || `Source ${index + 1}`}</span>
                      {source.similarity != null ? (
                        <span className="ml-auto shrink-0 rounded-md bg-background px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                          {Math.round(source.similarity * 100)}%
                        </span>
                      ) : null}
                    </div>
                    {source.excerpt ? <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">{source.excerpt}</p> : null}
                    {(source.type || source.filename) ? <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/75">{[source.type, source.filename].filter(Boolean).join(" · ")}</p> : null}
                  </div>
                  {source.href ? <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                </div>
              </>
            );
            const itemClass = "rounded-lg border border-border/50 bg-card p-2.5 text-left transition-colors hover:border-border hover:bg-card/80";
            return source.href ? (
              <a key={source.id ?? index} href={source.href} target="_blank" rel="noreferrer" className={itemClass}>{content}</a>
            ) : (
              <div key={source.id ?? index} className={itemClass}>{content}</div>
            );
          })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
