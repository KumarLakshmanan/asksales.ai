"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { ChannelFollowUpSettings } from "@/hooks/use-channel-follow-up-settings";
import type { InboxChannel } from "../../../../../shared/outreachInbox";

export function SavedFollowUpSummary({ channel, label, settings, loading, error, onRetry, onManage }: {
  channel: InboxChannel;
  label: string;
  settings: ChannelFollowUpSettings | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onManage?: () => void;
}) {
  return <section aria-label="Saved platform follow-ups" className="space-y-3 rounded-md border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">{label} follow-up settings</h3>
      <Button asChild variant="outline" size="sm" className="min-h-11">
        <Link href={`/dashboard/outreach/follow-ups?channel=${channel}`} onClick={event => {
          if (onManage && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
            event.preventDefault(); onManage();
          }
        }}>Manage follow-up settings</Link>
      </Button>
    </div>
    {loading ? <p role="status" className="text-xs text-muted-foreground">Loading saved follow-up settings…</p>
      : error ? <div role="alert" className="space-y-2 text-xs text-destructive"><p>{error}</p><Button variant="outline" size="sm" onClick={onRetry}>Retry follow-up settings</Button></div>
      : settings?.enableAutoFollowUp ? <>
        <p className="text-xs leading-5 text-muted-foreground">Uses your saved {label} settings. Each step is timed from the initial message. Follow-ups stop when the recipient replies.</p>
        <ol className="space-y-2 text-xs">
          {settings.followUpSteps.filter(step => step.enabled !== false).map((step, index) => <li key={step.id} className="flex flex-wrap justify-between gap-2 border-t pt-2">
            <span>Step {index + 1} · {step.delayValue} {step.delayValue === 1 ? step.delayUnit.slice(0, -1) : step.delayUnit} after initial message</span>
            <span className="break-words text-muted-foreground">{step.templateName || "Auto-generated message"}</span>
          </li>)}
        </ol>
      </> : <p className="text-xs text-muted-foreground">Automatic follow-ups are off for {label}.</p>}
  </section>;
}
