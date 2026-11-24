"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Activity, ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { businessProfileHeaders, selectedBusinessProfileId, subscribeBusinessProfile } from "@/lib/business-profile";
import { formatNumericDateTimeIST, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { AssistantActivity, AssistantConversationContext, AssistantPage } from "../../../../shared/assistantOperations";
import { isPositiveSafeInteger as validId } from "../../../../shared/numbers";

type ConversationActivityPage = AssistantPage<AssistantActivity> & { context: AssistantConversationContext };
const labels: Record<AssistantActivity["kind"], string> = {
  message: "Message", schedule: "Follow-up", delivery: "Delivery", playbook: "Playbook",
  approval: "Approval", proposal: "Proposal", session: "Conversation session",
};
const readable = (value: string) => value.replaceAll("_", " ");

/** Uses persisted actions and receipts, never success claims in generated text. */
export function ConversationEventTimeline({ conversationId, refreshToken = 0, initiallyOpen = false, className }: {
  conversationId: number; refreshToken?: number; initiallyOpen?: boolean; className?: string;
}) {
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const [open, setOpen] = useState(initiallyOpen);
  const [items, setItems] = useState<AssistantActivity[]>([]);
  const [context, setContext] = useState<AssistantConversationContext | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const loading = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const scope = useRef<string | null>(null);
  const loadedEarlier = useRef(false);
  const load = useCallback(async (more = false) => {
    if (!validId(conversationId) || (more && (loading.current || !cursorRef.current))) return;
    const request = more ? generation.current : ++generation.current;
    loading.current = true;
    setBusy(true);
    const query = new URLSearchParams({ limit: "25" });
    if (more && cursorRef.current) query.set("cursor", cursorRef.current);
    try {
      const page = await api.get<ConversationActivityPage>(
        `/api/settings/outreach/assistants/conversations/${conversationId}/activity?${query}`,
        { headers: businessProfileHeaders() },
      );
      if (request !== generation.current) return;
      if (!Array.isArray(page.items) || !page.context) throw new Error("Conversation activity could not be loaded.");
      if (more) loadedEarlier.current = true;
      setItems(previous => {
        if (!more && !loadedEarlier.current) return page.items;
        const boundary = page.items.at(-1);
        const retained = more ? previous : page.nextCursor && boundary ? previous.filter(item => item.createdAt < boundary.createdAt || (item.createdAt === boundary.createdAt && item.key < boundary.key)) : [];
        return [...new Map([...retained, ...page.items].map(item => [item.key, item])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.key.localeCompare(a.key));
      });
      setContext(page.context);
      if (more || !loadedEarlier.current || !page.nextCursor) cursorRef.current = page.nextCursor;
      setCursor(cursorRef.current);
      setError(null);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Conversation activity could not be loaded.");
    } finally {
      if (request === generation.current) { loading.current = false; setBusy(false); }
    }
  }, [conversationId, profileId]);
  useEffect(() => {
    const identity = `${profileId}:${conversationId}`;
    if (scope.current !== identity) {
      scope.current = identity;
      loadedEarlier.current = false;
      setItems([]); setContext(null); setCursor(null); cursorRef.current = null; setError(null);
    }
    void load();
    return () => { generation.current++; loading.current = false; };
  }, [load, refreshToken]);

  if (!validId(conversationId)) return null;
  const human = context?.mode && /^(human|human_owned|manual|human_support|human_takeover|support_agent)$/i.test(context.mode);
  return <section className={cn("rounded-xl border bg-card text-sm", className)} aria-label="Assistant and conversation activity">
    <div className="flex items-start gap-3 p-3 sm:p-4">
      <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{context?.name || (busy ? "Loading assistant details…" : "Conversation activity")}
          {context?.revision != null && <span className="ml-2 text-xs font-normal text-muted-foreground">Published revision {context.revision}</span>}
        </p>
        {context && <div className="mt-1 space-y-1 text-xs text-muted-foreground">
          <p className="break-words">{context.assistantId ? "Assigned assistant" : "No published assistant assigned"} · {human ? "Human support" : readable(context.mode)} · Session {readable(context.sessionStatus)}
            <span> · {({ whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Messenger", email: "Email", web: "Web chat" } as Record<string, string>)[context.channel] || context.channel}</span>
            {context.accountId && <span> · {/^\d{9,}$/.test(context.accountId) ? `Account ending ${context.accountId.slice(-4)}` : `Account ${context.accountId}`}</span>}</p>
          {context.playbook && <p>Playbook: {context.playbook.name} · {readable(context.playbook.status)}{context.playbook.nodeId && <span> · Step {context.playbook.nodeId}</span>}</p>}
          {context.followUp && <p>Support check-in: {readable(context.followUp.status)}{context.followUp.scheduledAt && <span> · {formatNumericDateTimeIST(context.followUp.scheduledAt)}</span>}</p>}
          {human && <Link href="/dashboard/support" className="inline-flex items-center gap-1 text-primary hover:underline">Open support tickets<ArrowUpRight className="h-3 w-3" /></Link>}
        </div>}
        {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" loading={busy} onClick={() => void load()} aria-label="Refresh conversation activity">
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label={open ? "Hide recorded activity" : "Show recorded activity"}>
        <span className="hidden sm:inline">Activity</span><ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </Button>
    </div>
    {open && <div className="border-t px-3 pb-3 pt-4 sm:px-4">
      <p className="mb-3 text-xs text-muted-foreground">Recorded actions and delivery results. Newest first.</p>
      {!items.length && !busy && !error && <p className="text-xs text-muted-foreground">No recorded assistant actions for this conversation yet.</p>}
      <ol className="space-y-0" aria-label="Recorded conversation events">
        {items.map(item => <li key={item.key} className="relative ml-1 border-l border-border pb-4 pl-4 last:border-transparent last:pb-0">
          <span aria-hidden="true" className={cn("absolute -left-1 top-1 h-2 w-2 rounded-full bg-muted-foreground", /failed|blocked|rejected|uncertain/.test(item.status) && "bg-destructive", /delivered|completed|approved/.test(item.status) && "bg-emerald-500")} />
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-xs font-medium">{item.kind === "delivery" && ["Approved PDF delivery", "Proposal delivery"].includes(item.content || "") ? item.content : labels[item.kind]} · {readable(item.status)}{item.step != null && ` · Step ${item.step}`}</p>
            <time dateTime={item.createdAt} className="text-[11px] text-muted-foreground">{formatNumericDateTimeIST(item.createdAt)}</time>
          </div>
          {item.reason && <p className="mt-1 break-words text-xs text-muted-foreground">{item.reason}</p>}
          {["playbook", "approval", "proposal"].includes(item.kind) && item.content && <p className="mt-1 break-words text-xs text-muted-foreground">{item.content}</p>}
          {item.scheduledAt && <p className="mt-1 text-xs text-muted-foreground">Scheduled: {formatNumericDateTimeIST(item.scheduledAt)}</p>}
          {item.providerMessageId && <p className="mt-1 break-all text-[11px] text-muted-foreground">Provider receipt: {item.providerMessageId}</p>}
          {item.assistantRevision != null && <p className="mt-1 text-[11px] text-muted-foreground">Assistant revision {item.assistantRevision}</p>}
          {item.kind === "proposal" && validId(item.resourceId) && <Link href={`/dashboard/proposals/${item.resourceId}`} className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">Open proposal<ArrowUpRight className="h-3 w-3" /></Link>}
        </li>)}
      </ol>
      {cursor && <Button className="mt-4" variant="outline" size="sm" disabled={busy} onClick={() => void load(true)}>{busy ? "Loading…" : "Load earlier activity"}</Button>}
    </div>}
  </section>;
}
