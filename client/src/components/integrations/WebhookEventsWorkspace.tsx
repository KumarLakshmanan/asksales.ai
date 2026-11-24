"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Bell, CheckCircle2, MessageCircle, RefreshCw, Send, UserRound, type LucideIcon } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import { asRecordOrNull as record } from "../../../../shared/records";

export interface ChannelEvent {
  event_key?: string;
  id: number;
  source?: string;
  platform?: string;
  event_type?: string | null;
  message_text?: string | null;
  comment_text?: string | null;
  payload?: unknown;
  signature_valid?: boolean | null;
  processed?: boolean | null;
  error?: string | null;
  created_at?: string | null;
}

type Category = "Messages" | "Comments" | "Delivery" | "Account" | "Other";
type EventView = { title: string; summary: string; category: Category; detail?: string; status: "received" | "handled" | "attention"; icon: LucideIcon };
const categories = ["All activity", "Messages", "Comments", "Delivery", "Account", "Other"] as const;

function first(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) ? record(value[0]) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function payloadDetails(payload: unknown): { message?: string; kind?: string } {
  const root = record(payload);
  const entry = first(root?.entry);
  const messaging = first(entry?.messaging);
  const change = first(entry?.changes);
  const value = record(change?.value);
  const whatsappMessage = first(value?.messages);
  const status = first(value?.statuses);
  const data = record(root?.data);
  return {
    message: text(record(messaging?.message)?.text) || text(record(whatsappMessage?.text)?.body) || text(record(root?.message)?.text) || text(root?.message) || text(value?.text) || text(root?.text) || text(root?.message_text) || text(data?.subject),
    kind: root?.item === "comment" ? "comments" : whatsappMessage ? "message" : status ? text(status.status) : messaging?.message || record(root?.message) ? "message" : text(change?.field),
  };
}

export function describeChannelEvent(event: ChannelEvent, platform: string): EventView {
  const eventType = (event.event_type || "").toLowerCase();
  const payload = payloadDetails(event.payload);
  const message = text(event.message_text) || text(event.comment_text) || payload.message;
  const status: EventView["status"] = event.error || event.signature_valid === false || /error|failed|rejected|bounce|complaint/.test(eventType) ? "attention" : event.processed ? "handled" : "received";
  if (eventType.startsWith('sms_delivery_')) {
    const report = record(event.payload);
    const failure = text(report?.failureReason) || text(event.error);
    const delivered = eventType === 'sms_delivery_delivered';
    const failed = /failed|rejected/.test(eventType);
    return { title: delivered ? 'SMS delivered' : failed ? 'SMS delivery failed' : 'SMS sent',
      summary: failure || (delivered ? 'MSG91 confirmed that the SMS reached the recipient.' : failed ? 'MSG91 reported a delivery failure. Check the sender and recipient in your SMS history.' : 'MSG91 accepted the SMS for delivery.'),
      detail: failure, category: 'Delivery', status, icon: delivered ? CheckCircle2 : failed ? AlertCircle : Send };
  }
  if (/comment|reply/.test(eventType) || payload.kind === "comments") return { title: "New comment", summary: message || "Someone commented on your content.", detail: message, category: "Comments", status, icon: MessageCircle };
  if (/message|messaging|direct_message|dm/.test(eventType) || payload.kind === "message") {
    if (/read/.test(eventType)) return { title: "Message read", summary: "A customer read a message.", category: "Delivery", status, icon: CheckCircle2 };
    if (/reaction/.test(eventType)) return { title: "Message reaction", summary: "A customer reacted to a message.", category: "Messages", status, icon: MessageCircle };
    return { title: "New message", summary: message || `A message arrived from ${platform}.`, detail: message, category: "Messages", status, icon: MessageCircle };
  }
  if (/follow|mention|like|reaction/.test(eventType)) return { title: /mention/.test(eventType) ? "Account mentioned" : /follow/.test(eventType) ? "New follower" : "New reaction", summary: "Someone interacted with your account or content.", category: "Account", status, icon: UserRound };
  if (/deliver|sent|open|click|read|bounce|complaint|status/.test(eventType) || payload.kind && /deliver|sent|read|failed/.test(payload.kind)) {
    const problem = /bounce|complaint|failed/.test(eventType) || status === "attention";
    return { title: problem ? "Delivery needs attention" : /open|read/.test(eventType) ? "Message opened" : /click/.test(eventType) ? "Link clicked" : "Delivery update", summary: problem ? "A message could not be delivered. Review the recipient or connection." : "The delivery status of a message changed.", category: "Delivery", status, icon: problem ? AlertCircle : Send };
  }
  if (eventType === "incoming") return { title: "Activity received", summary: message || `${platform} sent a new update.`, detail: message, category: "Other", status, icon: Bell };
  if (eventType === "processed") return { title: "Activity handled", summary: "A channel update was handled successfully.", category: "Other", status: "handled", icon: CheckCircle2 };
  if (status === "attention") return { title: "Activity needs attention", summary: "An update could not be handled. Try reconnecting if this continues.", category: "Other", status, icon: AlertCircle };
  return { title: "Account activity", summary: message || `${platform} sent an update.`, detail: message, category: "Account", status, icon: Bell };
}

function formatTime(value?: string | null): string {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function WebhookEventsWorkspace({ platform, platformLabel }: { platform: string; platformLabel?: string }) {
  const label = platformLabel || platform;
  const [events, setEvents] = useState<ChannelEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [category, setCategory] = useState<(typeof categories)[number]>("All activity");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const response = await api.get<{ events: ChannelEvent[] }>(`/api/integrations/${platform}/webhook-events?limit=100`);
      const next = (response.events || []).map(event => ({ ...event, platform: event.platform || platform }));
      next.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      const displayEvents = next.filter(event => !(event.source === "webhook_log" && event.event_type === "processed"));
      setEvents(displayEvents);
      setSelected(current => current && displayEvents.some(event => `${event.platform}:${event.event_key || event.id}` === current) ? current : null);
    } catch {
      setError("Please try again. If this continues, contact support.");
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => events.filter(event => {
    const view = describeChannelEvent(event, label);
    const matchesCategory = category === "All activity" || view.category === category;
    const query = search.trim().toLowerCase();
    return matchesCategory && (!query || `${view.title} ${view.summary}`.toLowerCase().includes(query));
  }), [events, category, label, search]);

  const selectedEvent = visible.find(event => `${event.platform}:${event.event_key || event.id}` === selected) || null;
  const selectedView = selectedEvent ? describeChannelEvent(selectedEvent, label) : null;

  return <div className="space-y-5">
    <div className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div><p className="text-sm font-semibold">Recent activity</p><p className="mt-1 text-sm text-muted-foreground">Messages, interactions, and delivery updates received from {label}.</p></div>
      <Button variant="outline" className="self-start rounded-full sm:self-auto" onClick={() => { setLoading(true); void load(); }} loading={loading} loadingText="Refresh activity"><RefreshCw className="mr-2 h-4 w-4" />Refresh activity</Button>
    </div>

    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.75fr)]">
      <section aria-label={`${label} activity list`} className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="space-y-4 border-b p-4 sm:p-5"><SearchInput value={search} onValueChange={setSearch} placeholder="Search activity" aria-label="Search activity" /><div className="flex flex-wrap gap-2">{categories.map(item => <Button key={item} size="sm" variant={category === item ? "default" : "outline"} className="rounded-full" onClick={() => { setCategory(item); setSelected(null); }}>{item}</Button>)}</div></div>
        {loading ? <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">Loading activity…</div> : error ? <div role="alert" className="space-y-3 p-8 text-center"><AlertCircle className="mx-auto h-7 w-7 text-destructive" /><p className="font-medium">Activity is unavailable</p><p className="text-sm text-muted-foreground">{error}</p><Button variant="outline" onClick={() => { setLoading(true); void load(); }}>Try again</Button></div> : visible.length === 0 ? <div className="p-10 text-center"><Bell className="mx-auto h-8 w-8 text-muted-foreground/50" /><p className="mt-3 font-medium">{events.length ? "No matching activity" : "No activity yet"}</p><p className="mt-1 text-sm text-muted-foreground">{events.length ? "Try another search or filter." : `New ${label} activity will appear here when it arrives.`}</p></div> : <div className="max-h-[680px] divide-y overflow-y-auto">{visible.map(event => { const view = describeChannelEvent(event, label); const Icon = view.icon; const key = `${event.platform}:${event.event_key || event.id}`; return <button type="button" key={key} onClick={() => setSelected(key)} className={cn("flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5", selected === key && "bg-primary/5")}><span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", view.status === "attention" ? "bg-amber-500/10 text-amber-700" : "bg-primary/10 text-primary")}><Icon className="h-5 w-5" /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">{view.title}</span><span className="text-xs text-muted-foreground">{formatTime(event.created_at)}</span></span><span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{view.summary}</span><span className="mt-2 block text-xs font-medium text-muted-foreground">{view.category}</span></span></button>; })}</div>}
      </section>

      <aside aria-label="Activity details" className="self-start rounded-2xl border bg-card p-5 shadow-sm sm:p-6">{selectedEvent && selectedView ? <div className="space-y-5"><div><span className="text-xs font-medium text-muted-foreground">{selectedView.category} · {label}</span><h2 className="mt-2 text-xl font-semibold tracking-tight">{selectedView.title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{selectedView.summary}</p></div><div className="space-y-3 border-t pt-5 text-sm"><div className="flex justify-between gap-4"><span className="text-muted-foreground">Received</span><span className="text-right font-medium">{formatTime(selectedEvent.created_at)}</span></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">Status</span><span className={cn("font-medium", selectedView.status === "attention" ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400")}>{selectedView.status === "attention" ? "Needs attention" : selectedView.status === "handled" ? "Handled" : "Received"}</span></div></div>{selectedView.detail && <div className="rounded-xl bg-muted/50 p-4"><p className="text-xs font-medium text-muted-foreground">Message</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{selectedView.detail}</p></div>}</div> : <div className="py-12 text-center"><MessageCircle className="mx-auto h-8 w-8 text-muted-foreground/50" /><p className="mt-3 font-medium">Select an update</p><p className="mt-1 text-sm text-muted-foreground">A readable summary will appear here.</p></div>}</aside>
    </div>
  </div>;
}
