"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AssistantDeliveryNotice } from './AssistantDeliveryNotice';
import { customerDeliveryFailure } from '@/lib/customer-delivery-readiness';
import type { OutreachCreationOptions, OutreachSendingAccount } from "../../../../shared/outreachCompose";

type Channel = "email" | "sms";
export interface ReviewedCampaign {
  id: number;
  campaign_name?: string;
  campaign_type?: string;
  status?: string;
  settings?: { accountReviewRequired?: boolean; replyPolicy?: { autoSend?: boolean } };
  [key: string]: unknown;
}
interface DeliveryPreview {
  reviewHash: string;
  campaign: ReviewedCampaign;
  summaries: Array<{ channel: Channel; account: string; recipientCount: number; stepCount: number }>;
  skipped: Array<{ leadId: number; channel: Channel; reason: string }>;
  messages: Array<{ leadId: number; channel: Channel; stepNumber: number; recipient: string; subject?: string; content: string; scheduledFor: string }>;
}

export default function CampaignDeliveryReview({ campaignId, onScheduled }: {
  campaignId: number;
  onScheduled?: (campaign: ReviewedCampaign) => void;
}) {
  const [campaign, setCampaign] = useState<ReviewedCampaign | null>(null);
  const [options, setOptions] = useState<Partial<Record<Channel, OutreachSendingAccount[]>>>({});
  const [selected, setSelected] = useState<Partial<Record<Channel, string>>>({});
  const [startDate, setStartDate] = useState("");
  const [preview, setPreview] = useState<DeliveryPreview | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<"load" | "preview" | "schedule" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [deliveryFailure, setDeliveryFailure] = useState<ReturnType<typeof customerDeliveryFailure>>();
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [scheduled, setScheduled] = useState(false);
  const revision = useRef(0);
  const cancelPendingRequests = useCallback(() => { revision.current++; }, []);
  const channels: Channel[] = campaign?.campaign_type === "both" ? ["email", "sms"]
    : campaign?.campaign_type === "sms" ? ["sms"] : ["email"];

  useEffect(() => {
    let active = true;
    revision.current++;
    setBusy("load"); setError(null); setCampaign(null); setPreview(null); setApproved(false); setSelected({}); setOptions({}); setStartDate(""); setScheduled(false);
    setDeliveryFailure(undefined);
    (async () => {
      try {
        const response = await api.get<{ campaign: ReviewedCampaign }>(`/api/outreach/campaigns/${campaignId}`);
        const needed: Channel[] = response.campaign.campaign_type === "both" ? ["email", "sms"]
          : response.campaign.campaign_type === "sms" ? ["sms"] : ["email"];
        const accountOptions = response.campaign.status === "draft" && !response.campaign.settings?.accountReviewRequired
          ? await Promise.all(needed.map(channel => api.get<OutreachCreationOptions>(`/api/outreach-conversations/compose/options?channel=${channel}`))) : [];
        if (!active) return;
        setCampaign(response.campaign);
        setOptions(Object.fromEntries(accountOptions.map(value => [value.channel, value.accounts])));
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load the campaign. Try again.");
      } finally { if (active) setBusy(null); }
    })();
    return () => { active = false; cancelPendingRequests(); };
  }, [campaignId, retry, cancelPendingRequests]);

  const groups = useMemo(() => {
    const grouped = new Map<number, DeliveryPreview["messages"]>();
    for (const message of preview?.messages ?? []) {
      const items = grouped.get(message.leadId) ?? [];
      items.push(message); grouped.set(message.leadId, items);
    }
    return [...grouped.entries()];
  }, [preview]);
  const eligible = !deliveryFailure && channels.every(channel => (options[channel] ?? []).some(account => account.id === selected[channel] && account.ready && account.assistant?.ready !== false && !!account.providerAccountId
    && (channel !== "email" || !!account.senderId)));
  const invalidate = () => { revision.current++; setPreview(null); setApproved(false); setPage(0); setError(null); };
  const requestBody = () => ({
    accounts: Object.fromEntries(channels.map(channel => {
      const account = options[channel]?.find(item => item.id === selected[channel]);
      return [channel, { senderId: channel === "email" ? account?.senderId : undefined, providerAccountId: account?.providerAccountId }];
    })),
    start_date: startDate ? new Date(startDate).toISOString() : undefined,
  });
  const review = async () => {
    if (!eligible || busy) return;
    const requestRevision = ++revision.current;
    setPreview(null); setApproved(false); setBusy("preview"); setError(null);
    try {
      const result = await api.post<DeliveryPreview>(`/api/outreach/campaigns/${campaignId}/preview`, requestBody());
      if (revision.current === requestRevision) { setPreview(result); setPage(0); }
    } catch (cause) {
      if (revision.current === requestRevision) { setDeliveryFailure(customerDeliveryFailure(cause)); setError(cause instanceof Error ? cause.message : "Unable to preview delivery."); }
    } finally { if (revision.current === requestRevision) setBusy(null); }
  };
  const schedule = async () => {
    if (!approved || !preview || !eligible || busy) return;
    const requestRevision = revision.current;
    setBusy("schedule"); setError(null);
    try {
      const result = await api.post<{ campaign: ReviewedCampaign }>(`/api/outreach/campaigns/${campaignId}/schedule`, {
        ...requestBody(), review_hash: preview.reviewHash,
      });
      if (revision.current !== requestRevision) return;
      setCampaign(result.campaign); setScheduled(true); setPreview(null); setApproved(false); onScheduled?.(result.campaign);
    } catch (cause) {
      if (revision.current !== requestRevision) return;
      invalidate(); setBusy(null); setError(cause instanceof Error ? cause.message : "Scheduling failed. Preview the campaign again.");
      setDeliveryFailure(customerDeliveryFailure(cause));
    } finally { if (revision.current === requestRevision) setBusy(null); }
  };

  if (busy === "load") return <p role="status">Loading campaign and sending accounts…</p>;
  if (!campaign) return <div className="space-y-3"><p role="alert">{error ?? "Campaign unavailable."}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Retry loading campaign</Button></div>;
  if (campaign.status !== "draft" || campaign.settings?.accountReviewRequired) return <div className="space-y-3">
    <h2 className="text-lg font-semibold">{campaign.campaign_name}</h2>
    <p>{campaign.settings?.accountReviewRequired ? "Historical deliveries remain paused. Create a new draft and review its recipients and sending accounts before sending." : scheduled ? "Reviewed campaign scheduled. Track delivery progress in campaign activity." : `Campaign status: ${campaign.status}. Only a draft can be scheduled from this review.`}</p>
    <Button asChild variant="outline"><Link href="/dashboard/outreach/activity">View campaign activity</Link></Button>
  </div>;
  return <div className="space-y-5">
    <div><h2 className="text-lg font-semibold">Review campaign delivery</h2><p className="text-sm text-muted-foreground">{campaign.campaign_name}. Select a sending account for each channel, then review every recipient and personalized sequence before scheduling.</p></div>
    {channels.includes('email') ? <p className="text-sm">Automatic email replies: {campaign.settings?.replyPolicy?.autoSend ? 'On for eligible replies; others stay as drafts.' : 'Off; replies stay as drafts.'}</p> : null}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <AssistantDeliveryNotice readiness={deliveryFailure} />
    {channels.map(channel => <div key={channel} className="space-y-2">
      <Label htmlFor={`campaign-${channel}-account`}>{channel === "email" ? "Email sending account" : "SMS sending account"}</Label>
      <select id={`campaign-${channel}-account`} className="w-full rounded-md border bg-background p-2" value={selected[channel] ?? ""} disabled={!!busy}
        onChange={event => { invalidate(); setSelected(value => ({ ...value, [channel]: event.target.value })); }}>
        <option value="">Select an account</option>
        {(options[channel] ?? []).map(account => <option key={account.id} value={account.id} disabled={!account.ready || account.assistant?.ready === false || (channel === "email" && !account.senderId)}>{account.label}{!account.ready ? ` — ${account.reason ?? "Unavailable"}` : ""}</option>)}
      </select>
      {(options[channel] ?? []).filter(account => account.id === selected[channel] || !account.assistant?.ready).map(account => <AssistantDeliveryNotice key={account.id} readiness={account.assistant} />)}
      {!options[channel]?.some(account => account.ready) && !options[channel]?.some(account => account.assistant?.ready === false) && <p className="text-sm text-muted-foreground">Connect a ready {channel} account in <Link className="underline" href="/dashboard/integrations">Integrations</Link> before reviewing delivery.</p>}
    </div>)}
    <div className="space-y-2"><Label htmlFor="campaign-start-date">Start time (your local time)</Label><Input id="campaign-start-date" type="datetime-local" value={startDate} disabled={!!busy} onChange={event => { invalidate(); setStartDate(event.target.value); }} /><p className="text-xs text-muted-foreground">Leave empty to start when you schedule. The preview shows estimated times for an immediate start.</p></div>
    <Button type="button" disabled={!eligible || !!busy} onClick={review}>{busy === "preview" ? "Preparing preview…" : "Preview recipients and messages"}</Button>
    {preview && <div className="space-y-4">
      {preview.summaries.map(summary => <p key={summary.channel} className="text-sm">{summary.channel}: {summary.recipientCount} recipients × {summary.stepCount} messages from {summary.account}</p>)}
      {preview.skipped.length > 0 && <details><summary>{preview.skipped.length} skipped recipients</summary><ul className="max-h-64 overflow-auto">{preview.skipped.map((item, index) => <li key={index}>Contact #{item.leadId} ({item.channel}): {item.reason}</li>)}</ul></details>}
      <p className="text-sm text-muted-foreground">Expand each contact to inspect all messages. Showing {page * 20 + 1}–{Math.min((page + 1) * 20, groups.length)} of {groups.length} contacts.</p>
      {groups.slice(page * 20, (page + 1) * 20).map(([leadId, messages]) => <details key={leadId} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Contact #{leadId}: {[...new Set(messages.map(item => item.recipient))].join(" · ")} ({messages.length} messages)</summary><div className="mt-3 space-y-4">{messages.map((message, index) => <article key={index} className="rounded-md bg-muted p-3 text-sm"><p>{message.channel} · Step {message.stepNumber} · To: {message.recipient}</p><p>{new Date(message.scheduledFor).toLocaleString()}</p>{message.subject && <p className="mt-2 font-medium">{message.subject}</p>}<p className="mt-2 whitespace-pre-wrap break-words">{message.content}</p></article>)}</div></details>)}
      {groups.length > 20 && <div className="flex gap-2"><Button variant="outline" disabled={page === 0 || !!busy} onClick={() => setPage(value => value - 1)}>Previous contacts</Button><Button variant="outline" disabled={(page + 1) * 20 >= groups.length || !!busy} onClick={() => setPage(value => value + 1)}>Next contacts</Button></div>}
      <Label className="flex items-start gap-2"><input type="checkbox" checked={approved} disabled={!!busy} onChange={event => setApproved(event.target.checked)} />I reviewed the sending accounts, recipients, personalized messages, skipped contacts, and timing. Schedule this campaign.</Label>
      <Button type="button" disabled={!approved || !eligible || !!busy} onClick={schedule}>{busy === "schedule" ? "Scheduling…" : "Schedule reviewed campaign"}</Button>
    </div>}
  </div>;
}
