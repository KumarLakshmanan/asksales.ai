"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Link2, RefreshCw, Settings } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConnectionBadge } from "@/components/integrations/IntegrationWorkspace";
import { integrationDefinitions, integrationPath, messagingState, metaAdsState, googleAdsState, whatsappState, msg91State, type ConnectionState, type IntegrationId, type MetaMessagingStatus } from "@/lib/integrations";
import type { MSG91SettingsResponse } from "../../../../../../shared/msg91";

interface Summary { state: ConnectionState; account?: string | null }
const loaders: Record<IntegrationId, () => Promise<Summary>> = {
  instagram: async () => { const { officialApi } = await api.get<MetaMessagingStatus>("/api/instagram/oauth/status"); return { state: messagingState(officialApi), account: officialApi.username }; },
  facebook: async () => { const { officialApi } = await api.get<MetaMessagingStatus>("/api/facebook/oauth/status"); return { state: messagingState(officialApi), account: officialApi.username }; },
  whatsapp: async () => {
    const result = await api.get<{ configured: boolean; enabled?: boolean; config?: { connectionStatus?: string; tokenStatus?: string; displayPhoneNumber?: string; verifiedName?: string } }>("/api/whatsapp/config");
    return { state: whatsappState(result), account: result.config?.verifiedName || result.config?.displayPhoneNumber };
  },
  email: async () => {
    const [gmail, senders, domains] = await Promise.all([
      api.get<{ connected: boolean; tokenExpired?: boolean; email?: string }>("/api/gmail/oauth/status"),
      api.get<{ senders: Array<{ isVerified: boolean; isDefault: boolean; email: string; type: string }> }>("/api/email-senders"),
      api.get<{ domains: Array<{ name: string; status: string }> }>("/api/resend/domains"),
    ]);
    const sender = senders.senders?.find(s => s.type === "resend" && s.isVerified && domains.domains?.some(d => d.status === "verified" && s.email.endsWith(`@${d.name}`)));
    return { state: (gmail.connected && !gmail.tokenExpired) || sender ? "connected" : gmail.tokenExpired ? "reconnect" : domains.domains?.length ? "action_required" : "disconnected", account: gmail.connected && !gmail.tokenExpired ? gmail.email : sender?.email };
  },
  meta: async () => {
    const { platforms } = await api.get<{ platforms: Array<{ platform: string; accountName?: string; isActive: boolean; selectionRequired?: boolean; adAccountId?: string; pageId?: string; expiresAt?: string }> }>("/api/meta/oauth/platforms");
    const account = platforms?.find(p => p.platform === "meta");
    return { state: metaAdsState(account), account: account?.accountName };
  },
  "google-ads": async () => {
    const { config } = await api.get<{ config: { customerId?: string; ready?: boolean; hasRefreshToken?: boolean } | null }>("/api/integrations/google-ads/config");
    if (!config?.ready) return { state: googleAdsState(config) };
    const { accounts } = await api.get<{ accounts: Array<{ customerId: string; name?: string; manager?: boolean }> }>("/api/integrations/google-ads/accounts");
    const selected = accounts?.find(account => account.customerId === config.customerId && !account.manager);
    return { state: selected ? "connected" : "action_required", account: selected?.name || (config.customerId ? `Customer ${config.customerId}` : undefined) };
  },
  msg91: async () => { const result = await api.get<MSG91SettingsResponse>("/api/msg91-settings"); return { state: msg91State(result), account: result.settings?.senderId }; },
  youtube: async () => { const result = await api.get<{ connected: boolean; channelName?: string; readiness?: string }>("/api/youtube/oauth/status"); return { state: result.readiness === "needs_reconnect" ? "reconnect" : result.connected ? "connected" : "disconnected", account: result.channelName }; },
};

export default function IntegrationsOverview() {
  const [statuses, setStatuses] = useState<Partial<Record<IntegrationId, Summary>>>({});
  const [pending, setPending] = useState<IntegrationId[]>([]);
  const generation = useRef(0);
  const load = useCallback(async (ids: IntegrationId[]) => {
    const current = generation.current;
    setPending(previous => [...new Set([...previous, ...ids])]);
    await Promise.all(ids.map(async id => {
      let status: Summary;
      try { status = await loaders[id](); } catch { status = { state: "unavailable" }; }
      if (current !== generation.current) return;
      setStatuses(previous => ({ ...previous, [id]: status }));
      setPending(previous => previous.filter(value => value !== id));
    }));
  }, []);
  useEffect(() => {
    void load(integrationDefinitions.map(item => item.id));
    return () => { generation.current += 1; };
  }, [load]);
  const count = integrationDefinitions.filter(item => statuses[item.id]?.state === "connected").length;
  const unknown = integrationDefinitions.filter(item => statuses[item.id]?.state === "unavailable").length;

  const renderCard = (definition: typeof integrationDefinitions[number]) => {
    const Icon = definition.icon;
    const status = statuses[definition.id];
    const loading = !status || pending.includes(definition.id);
    return <article key={definition.id} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="flex flex-1 flex-wrap items-start gap-3 p-5">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ color: definition.color, backgroundColor: `${definition.color}12` }}><Icon className="h-6 w-6" aria-hidden="true" /></span>
        <div className="min-w-[140px] flex-1"><h2 className="text-base font-semibold"><Link href={integrationPath(definition.id)} className="hover:underline">{definition.name}</Link></h2><p className="mt-1 break-words text-sm leading-6 text-muted-foreground">{status?.account || definition.description}</p></div>
        <div className="w-full pt-1">{loading ? <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" role="status"><Spinner size="xs" label={null} />Checking connection…</span> : <ConnectionBadge state={status.state} />}</div>
      </div>
      <div className="flex min-h-16 items-center justify-end gap-2 border-t bg-muted/40 px-5 py-3">
        {status?.state === "unavailable" && <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load([definition.id])}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry</Button>}
        <Button asChild size="sm" variant={status?.state === "connected" ? "outline" : "default"} className="rounded-full px-4"><Link href={integrationPath(definition.id)}>
          {status?.state === "connected" ? <Settings className="mr-1.5 h-3.5 w-3.5" /> : <Link2 className="mr-1.5 h-3.5 w-3.5" />}
          {status?.state === "connected" ? "Settings" : status?.state === "selection" ? "Choose account" : status?.state === "reconnect" ? "Reconnect" : status?.state === "action_required" || status?.state === "paused" ? "Finish setup" : "Connect"}
        </Link></Button>
      </div>
    </article>;
  };

  return <div className="mx-auto w-full max-w-[1600px] space-y-8 px-4 py-6 sm:px-6 lg:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">All Integrations</h1><p className="mt-2 text-sm text-muted-foreground">Connect your channels and advertising accounts to AskSales.</p><p className="mt-3 text-sm font-medium text-muted-foreground" aria-live="polite">{count} / {integrationDefinitions.length} integrations connected{unknown > 0 && ` · ${unknown} status unavailable`}</p></div>
      <Button variant="outline" size="sm" onClick={() => void load(integrationDefinitions.map(item => item.id))} disabled={pending.length > 0}><RefreshCw className={`mr-2 h-4 w-4 ${pending.length ? "animate-spin" : ""}`} />Refresh status</Button>
    </header>
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{integrationDefinitions.map(renderCard)}</div>
    <p className="py-2 text-center text-sm text-muted-foreground">Need help connecting? <Link href="/dashboard/support" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">Contact support<ArrowRight className="h-3.5 w-3.5" /></Link></p>
  </div>;
}
