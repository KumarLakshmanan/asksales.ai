"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { failedCount, waitingCount, type BatchCounts, type RecipientFilter } from "../../../../../shared/outreachTracking";
import { chartColor, chartPaletteClass, type ChartColorKey } from "./chartPalette";
import { formatCount } from "./status";

interface Part { id: RecipientFilter; label: string; hint: string; color: ChartColorKey; count: number }

/** Every message is in exactly one of these right now, so the parts add up to all recipients. */
function parts(counts: BatchCounts): Part[] {
  return [
    { id: "read", label: "Read", hint: "Opened by the recipient", color: "read", count: counts.read },
    { id: "delivered", label: "Delivered", hint: "Reached the phone, not read yet", color: "delivered", count: counts.delivered },
    { id: "sent", label: "Sent", hint: "Accepted, waiting for a delivery receipt", color: "sent", count: counts.sent },
    { id: "waiting", label: "Waiting", hint: "Scheduled or held, not sent yet", color: "waiting", count: waitingCount(counts) },
    { id: "failed", label: "Failed", hint: "Failed or expired", color: "failed", count: failedCount(counts) },
    { id: "needs_attention", label: "Needs attention", hint: "Not sent and not retried", color: "attention", count: counts.needsAttention },
  ];
}

const share = (count: number, total: number) => {
  if (!total) return "0%";
  const value = (count / total) * 100;
  return value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
};

interface DeliveryBreakdownProps {
  counts: BatchCounts;
  /** The recipient filter currently applied, shown as the selected part. */
  selected: RecipientFilter;
  onSelect: (filter: RecipientFilter) => void;
}

/**
 * One bar split by where each message is right now. Each part can be pressed
 * to list those recipients; the legend under it repeats every number, so
 * nothing depends on colour or on hovering.
 */
export function DeliveryBreakdown({ counts, selected, onSelect }: DeliveryBreakdownProps) {
  const all = parts(counts);
  const total = all.reduce((sum, part) => sum + part.count, 0);
  const visible = all.filter(part => part.count > 0);

  return (
    <Card className={chartPaletteClass}>
      <CardHeader>
        <CardTitle>Where the messages are now</CardTitle>
        <CardDescription>Select a part to list those recipients below.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {total === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No messages in this outreach yet.</p>
        ) : (
          <TooltipProvider delayDuration={100}>
            {/* The 2px gaps separate the parts; no borders are drawn around them. */}
            <div className="flex h-6 w-full gap-0.5 overflow-hidden rounded-md" role="group" aria-label="Messages by current status">
              {visible.map(part => (
                <Tooltip key={part.id}>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => onSelect(part.id)} aria-pressed={selected === part.id}
                      aria-label={`${part.label}: ${formatCount(part.count)} messages, ${share(part.count, total)}. Show these recipients.`}
                      style={{ flexGrow: part.count, background: chartColor[part.color] }}
                      className={cn(
                        // A sliver still gets a hit area wide enough to point at.
                        "h-full min-w-[10px] basis-0 transition-[filter,opacity] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
                        selected !== "all" && selected !== part.id && "opacity-40",
                      )} />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p><span className="font-semibold tabular-nums">{formatCount(part.count)}</span> {part.label.toLowerCase()} · {share(part.count, total)}</p>
                    <p className="text-xs opacity-80">{part.hint}</p>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
        )}
        <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3" aria-label="Status legend">
          {all.map(part => (
            <li key={part.id}>
              <button type="button" onClick={() => onSelect(selected === part.id ? "all" : part.id)} aria-pressed={selected === part.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected === part.id && "bg-muted",
                )}>
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: chartColor[part.color] }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{part.label}</span>
                <span className="font-semibold tabular-nums">{formatCount(part.count)}</span>
                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{share(part.count, total)}</span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
