"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, Link2, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { connectionLabels, integrationDefinition, type ConnectionState, type IntegrationId, type MetaCapability } from "@/lib/integrations";

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  return <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium", state === "connected" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : state === "disconnected" ? "bg-muted text-muted-foreground" : "bg-amber-500/10 text-amber-800 dark:text-amber-300")}>
    {state === "connected" ? <CheckCircle2 className="h-3.5 w-3.5" /> : state === "disconnected" ? <Unplug className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
    {connectionLabels[state]}
  </span>;
}

/** The same account presentation and feature navigation on all six provider pages. */
export function IntegrationWorkspace({
  provider, state, accountName, accountImage, accountSubtitle, accountDetails, message,
  onConnect, connecting, connectDisabled = false, onDisconnect, onRetry, primaryAction, secondaryActions, selection,
  settings, settingsLabel = "Connection options",
  layout = "account",
  capabilities, onAuthorizeFeature, completeSetup = false, reconnectLabel = "Reconnect",
}: {
  provider: IntegrationId; state: ConnectionState; accountName?: string | null; accountImage?: string | null; accountSubtitle?: string | null;
  accountDetails?: Array<{ label: string; value: ReactNode }>; message?: string | null;
  onConnect: () => void; connecting?: boolean; connectDisabled?: boolean; onDisconnect?: () => void; onRetry?: () => void;
  primaryAction?: ReactNode; secondaryActions?: ReactNode; selection?: ReactNode;
  settings?: ReactNode; settingsLabel?: string;
  layout?: "account" | "settings";
  capabilities?: MetaCapability[]; onAuthorizeFeature?: (scope: string) => void;
  completeSetup?: boolean;
  reconnectLabel?: string;
}) {
  const definition = integrationDefinition(provider);
  const Icon = definition.icon;
  const ready = state === "connected";
  const hasAccount = Boolean(accountName) && state !== "disconnected" && state !== "unavailable";
  const openSettings = () => requestAnimationFrame(() => document.getElementById("connection-settings")?.scrollIntoView({ behavior: "smooth", block: "start" }));

  return <div className="space-y-6">
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <section aria-label={`${definition.name} connection`} className={cn("min-w-0", layout === "account" && "overflow-hidden rounded-2xl border bg-card shadow-sm")}>
        {layout === "account" && <>
        {hasAccount && <div className={cn("h-28 sm:h-36", definition.banner)} />}
        <div className={cn("flex min-h-[440px] flex-col items-center px-5 pb-9 text-center sm:px-8", hasAccount ? "-mt-12" : "justify-center pt-10")}>
          <Avatar className={cn("h-24 w-24 shrink-0 border-4 border-card shadow-sm", !hasAccount && definition.banner)}>
            {accountImage && hasAccount && <AvatarImage src={accountImage} alt={accountName || definition.name} className="object-cover" />}
            <AvatarFallback className={cn("text-white", definition.banner)}><Icon className="h-10 w-10" aria-hidden="true" /></AvatarFallback>
          </Avatar>
          <h2 className="mt-5 max-w-full break-words text-2xl font-semibold tracking-tight sm:text-3xl">{hasAccount ? accountName : state === "unavailable" ? `${definition.name} status unavailable` : `Connect ${definition.name}`}</h2>
          <div className="mt-3 flex max-w-full flex-wrap items-center justify-center gap-3">
            {hasAccount && accountSubtitle && <span className="break-all text-sm text-muted-foreground">{accountSubtitle}</span>}
            <ConnectionBadge state={state} />
          </div>
          <p className={cn("mx-auto mt-5 max-w-xl text-sm leading-7 text-muted-foreground", message && state !== "connected" && "text-foreground")} role={state === "unavailable" ? "alert" : undefined}>{message || (hasAccount ? definition.description : definition.prerequisite)}</p>
          {hasAccount && accountDetails && accountDetails.length > 0 && <dl className="mt-6 flex w-full max-w-xl flex-wrap justify-center gap-x-8 gap-y-4 rounded-xl bg-muted/50 p-5">
            {accountDetails.map(detail => <div key={detail.label} className="min-w-0"><dd className="break-all text-sm font-semibold">{detail.value}</dd><dt className="mt-1 text-xs text-muted-foreground">{detail.label}</dt></div>)}
          </dl>}
          {selection && <div className="mt-6 w-full max-w-xl text-left">{selection}</div>}
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {state === "unavailable" ? <Button onClick={onRetry} variant="outline"><RefreshCw className="mr-2 h-4 w-4" />Try again</Button> : <>
              {ready && primaryAction ? primaryAction : (state === "selection" && !selection) || (state === "action_required" && completeSetup) ? <Button onClick={openSettings}>{state === "selection" ? "Choose account" : "Complete setup"}<ArrowRight className="ml-2 h-4 w-4" /></Button> : state === "paused" ? null : <Button onClick={onConnect} loading={connecting} loadingText="Opening sign-in…" disabled={connectDisabled} className="h-11 rounded-full px-6">
                <Link2 className="mr-2 h-4 w-4" />
                {state === "reconnect" || state === "action_required" || state === "selection" || ready ? reconnectLabel : definition.connectLabel}
              </Button>}
              {ready && primaryAction && <Button variant="outline" className="rounded-full" disabled={connecting || connectDisabled} onClick={onConnect}><RefreshCw className="mr-2 h-4 w-4" />{reconnectLabel}</Button>}
              {secondaryActions}
              {hasAccount && onDisconnect && <Button variant="outline" className="rounded-full border-destructive/25 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDisconnect}><Unplug className="mr-2 h-4 w-4" />Disconnect</Button>}
            </>}
          </div>
          {!hasAccount && state !== "unavailable" && provider !== "msg91" && <p className="mt-5 max-w-lg text-xs leading-5 text-muted-foreground">You’ll authorize access securely with the provider and return here to finish setup.</p>}
        </div>
        </>}
        {settings && <div id="connection-settings" aria-label={settingsLabel} className={cn("scroll-mt-6", layout === "account" && "border-t bg-muted/[0.12] px-5 py-6 sm:px-8")}>
          <div className={cn("w-full space-y-5 text-left", layout === "account" && "mx-auto max-w-3xl")}>{settings}</div>
        </div>}
      </section>
      <aside className="overflow-hidden rounded-2xl border bg-card shadow-sm" aria-label={`${definition.name} features`}>
        <h2 className="border-b px-6 py-5 text-lg font-semibold">{definition.name} features</h2>
        <div className="space-y-1 p-3">
          {definition.features.map(feature => {
            const FeatureIcon = feature.icon;
            const capability = feature.scope ? capabilities?.find(cap => cap.scope === feature.scope || (provider === "instagram" && cap.scope === feature.scope?.replace("instagram_", "instagram_business_"))) : undefined;
            const requiresPermission = Boolean(ready && feature.scope && capability?.status !== "available");
            const mayAuthorize = requiresPermission && capability && !capability.tokenGranted &&
              ["approved", "not_required", ...(provider === "instagram" ? ["testing"] : [])].includes(capability.appReviewStatus) && onAuthorizeFeature;
            const content = <><span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><FeatureIcon className="h-5 w-5" /></span><span className="min-w-0"><span className="block text-sm font-semibold">{feature.name}</span><span className="mt-1 block text-sm leading-6 text-muted-foreground">{feature.description}</span>{requiresPermission && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">{mayAuthorize ? "Grant permission to enable" : "Not available for this connection"}</span>}</span></>;
            const classes = "flex w-full gap-3 rounded-xl p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
            if (feature.href.startsWith("#")) return <button key={feature.name} className={cn(classes, "hover:bg-muted/60")} onClick={openSettings}>{content}</button>;
            if (mayAuthorize) return <button key={feature.name} className={cn(classes, "hover:bg-muted/60")} disabled={connecting} onClick={() => onAuthorizeFeature!(capability!.scope)}>{content}</button>;
            if ((!ready && !feature.href.includes("templates") && !feature.href.includes("/events")) || requiresPermission) return <div key={feature.name} className={classes}>{content}</div>;
            return <Link key={feature.name} href={feature.href} className={cn(classes, "hover:bg-muted/60")}>{content}</Link>;
          })}
        </div>
        {!ready && <p className="border-t px-6 py-4 text-xs leading-5 text-muted-foreground">Complete your connection to use the available features.</p>}
      </aside>
    </div>
  </div>;
}
