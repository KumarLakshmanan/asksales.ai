"use client";

import Link from "next/link";
import { useState } from 'react';
import { Send, Target } from "lucide-react";

import { useOptionalWorkflow } from "@/contexts/WorkflowContext";
import { Button } from "@/components/ui/button";
import { INBOX_CHANNELS, type InboxChannel } from '../../../../shared/outreachInbox';

const channelLabels: Record<InboxChannel, string> = { email: 'Email', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger', sms: 'SMS' };

interface OutreachTabProps {
  icpId?: number;
  threadId?: number;
  onSendMessage?: (message: string) => void;
}

export default function OutreachTab({ icpId, threadId, onSendMessage }: OutreachTabProps) {
  const [channel, setChannel] = useState<InboxChannel>('whatsapp');
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
        <select aria-label="Campaign outreach channel" className="h-10 w-full rounded-md border bg-background px-3" value={channel} onChange={event => setChannel(event.target.value as InboxChannel)}>
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
      )}><Send className="mr-2 h-4 w-4" />Prepare {channelLabels[channel]} review</Button>
      <p className="text-xs leading-5 text-muted-foreground">The review card opens in this conversation. Nothing is sent until you review it and select Confirm and run.</p>
    </section>
  );
}
