"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from 'react';
import { Send, Target } from "lucide-react";

import { useOptionalWorkflow } from "@/contexts/WorkflowContext";
import { Button } from "@/components/ui/button";
import { useOptionalWidgets } from "@/components/widgets/WidgetContext";
import type { WidgetState } from "@/components/widgets/types";
import { INBOX_CHANNELS, INBOX_CHANNEL_LABELS as channelLabels, type InboxChannel } from '../../../../shared/outreachInbox';

const ATTEMPT_STATUS: Record<WidgetState['status'], string> = {
  active: 'Waiting for your review', draft: 'Draft', running: 'Sending', queued: 'Queued',
  provider_succeeded: 'Sent', succeeded: 'Sent', failed: 'Did not send', cancelled: 'Cancelled',
};

interface OutreachAttempt { id: number; channel: InboxChannel | null; recipients: number; status: string; when: string }

/** Outreach reviews already prepared in this conversation, newest first. */
export function outreachAttempts(widgets: WidgetState[]): OutreachAttempt[] {
  return widgets
    .filter(widget => widget.toolName === 'send_outreach_messages')
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))
    .map(widget => {
      const values = { ...widget.formValues, ...(widget.submittedValues || {}) } as Record<string, unknown>;
      const channel = INBOX_CHANNELS.includes(values.channel as InboxChannel) ? values.channel as InboxChannel : null;
      const recipients = Array.isArray(values.lead_ids) ? values.lead_ids.length : 0;
      return { id: widget.id, channel, recipients, status: ATTEMPT_STATUS[widget.status] || 'Prepared', when: widget.updatedAt || widget.createdAt };
    });
}

export function outreachReviewLabel(channel: InboxChannel): string {
  return `Prepare ${channelLabels[channel]} outreach for this campaign`;
}

interface OutreachTabProps {
  icpId?: number;
  threadId?: number;
  /** The second argument is the short label the chat shows instead of the full instruction. */
  onSendMessage?: (message: string, displayContent?: string) => void;
}

export default function OutreachTab({ icpId, threadId, onSendMessage }: OutreachTabProps) {
  const widgetContext = useOptionalWidgets();
  const widgets = widgetContext?.widgets;
  const attempts = useMemo(() => outreachAttempts(widgets || []), [widgets]);
  const lastChannel = attempts.find(attempt => attempt.channel)?.channel ?? null;
  const [channel, setChannel] = useState<InboxChannel>(lastChannel ?? 'whatsapp');
  const [channelTouched, setChannelTouched] = useState(false);
  // Default to the channel this campaign already used, until the user picks one.
  useEffect(() => {
    if (!channelTouched && lastChannel) setChannel(lastChannel);
  }, [channelTouched, lastChannel]);
  const workflow = useOptionalWorkflow();
  const state = workflow?.state;
  if (state?.outreachNeedsReview && state.campaignId) return (
    <div className="space-y-4 p-6">
      <h2 className="text-lg font-semibold">Campaign draft ready for review</h2>
      <p className="text-sm text-muted-foreground">Review recipients, personalized messages, sending accounts, and timing before scheduling delivery.</p>
      <Button asChild><Link href={`/dashboard/outreach/campaigns/${state.campaignId}/review`}>Review campaign delivery</Link></Button>
    </div>
  );
  if (!icpId) {
    return (
      <div className="flex h-full min-h-80 items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Target className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold">ICP required for outreach</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Select or create an ideal customer profile before preparing this campaign’s outreach.
          </p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            {onSendMessage && (
              <Button
                type="button"
                onClick={() => onSendMessage("Help me create an ideal customer profile for an outreach campaign.")}
              >
                Create an ICP
              </Button>
            )}
            <Button asChild variant={onSendMessage ? "outline" : "default"}>
              <Link href="/dashboard/outreach">
                <Send className="mr-2 h-4 w-4" />
                Open outreach
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="h-full space-y-5 overflow-auto bg-background p-4 sm:p-6" aria-label="Campaign outreach creation">
      <div><h2 className="text-lg font-semibold">Create campaign outreach</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Prepare recipients, content and follow-up times in one review card.</p></div>
      <label className="block space-y-2 text-sm font-medium">Channel
        <select aria-label="Campaign outreach channel" className="h-10 w-full rounded-md border bg-background px-3" value={channel} onChange={event => { setChannelTouched(true); setChannel(event.target.value as InboxChannel); }}>
          {INBOX_CHANNELS.map(value => <option key={value} value={value}>{channelLabels[value]}</option>)}
        </select>
      </label>
      <ol className="space-y-3 rounded-xl border bg-card p-4 text-sm">
        <li><span className="font-medium">1. Choose recipients</span><p className="mt-1 text-xs leading-5 text-muted-foreground">Keep your selected leads, or filter current campaign leads, campaign uploads and CRM imports. Search by name, email or phone.</p></li>
        <li><span className="font-medium">2. Review your message</span><p className="mt-1 text-xs leading-5 text-muted-foreground">{channel === 'whatsapp' ? 'Choose the sending account, an approved WhatsApp template and its media.' : 'Choose a sending account and review the message for each recipient.'}</p></li>
        <li><span className="font-medium">3. Set send and follow-up times</span><p className="mt-1 text-xs leading-5 text-muted-foreground">Send now or schedule. Follow-up messages and delays apply only to this outreach; global timings stay unchanged.</p></li>
      </ol>
      <Button className="w-full" disabled={!threadId || !onSendMessage} onClick={() => onSendMessage?.(
        `Prepare a ${channelLabels[channel]} outreach review for this campaign using its exact selected recipients. If no recipients are selected, show the recipient picker first. Let me review the sending account, approved content and media, send timing, and per-outreach follow-up times in the shared review card. Keep global follow-up settings unchanged. Prepare only; do not send or search for new leads.`,
        outreachReviewLabel(channel),
      )}><Send className="mr-2 h-4 w-4" />Prepare {channelLabels[channel]} review</Button>
      <p className="text-xs leading-5 text-muted-foreground">The review card opens in this conversation. Nothing is sent until you review it and select Confirm and run.</p>
      {attempts.length > 0 && (
        <div className="space-y-2" aria-label="Earlier outreach in this campaign">
          <h3 className="text-sm font-medium">Earlier outreach in this campaign</h3>
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {attempts.slice(0, 5).map(attempt => (
              <li key={attempt.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span>
                  {attempt.channel ? channelLabels[attempt.channel] : 'Outreach'}
                  {attempt.recipients > 0 ? ` · ${attempt.recipients} ${attempt.recipients === 1 ? 'recipient' : 'recipients'}` : ''}
                </span>
                <span className="text-xs text-muted-foreground">{attempt.status} · {new Date(attempt.when).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
