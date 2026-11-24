import { AlertCircle, CheckCircle2, Inbox, Mail, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConnectionBadge } from "@/components/integrations/IntegrationWorkspace";
import type { GmailStatus } from "./types";

interface GmailIntegrationProps {
  gmailStatus: GmailStatus;
  reconnectEmail?: string | null;
  connecting: boolean;
  disconnecting: boolean;
  refreshing: boolean;
  refreshError?: string | null;
  settingUpWatch: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onSetupWatch: () => void;
}

export function GmailIntegration({ gmailStatus, reconnectEmail, connecting, disconnecting, refreshing, refreshError, settingUpWatch, onConnect, onDisconnect, onRefresh, onSetupWatch }: GmailIntegrationProps) {
  const connected = gmailStatus.connected && !gmailStatus.tokenExpired && !gmailStatus.requiresReconnect;
  const needsReconnect = !connected && Boolean(reconnectEmail || gmailStatus.requiresReconnect || gmailStatus.tokenExpired);
  const signInUnavailable = gmailStatus.configSource === "none";
  const watchNeedsAttention = connected && (gmailStatus.watchStatus && gmailStatus.watchStatus !== "active" || Boolean(gmailStatus.watchRenewalStatus));

  return <section aria-labelledby="gmail-heading" className="overflow-hidden rounded-2xl border bg-card shadow-sm">
    <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex min-w-0 items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400"><Mail className="h-5 w-5" /></span>
        <div className="min-w-0">
          <h2 id="gmail-heading" className="text-lg font-semibold tracking-tight">Gmail account</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{refreshError ? "Last known Google account details are shown below. Retry to check the current connection." : connected ? "Your Google account is connected for email sending. Manage reply sync below." : "Connect a Google account to send email and sync replies."}</p>
        </div>
      </div>
      <ConnectionBadge state={refreshError ? "unavailable" : needsReconnect ? "reconnect" : connected ? "connected" : "disconnected"} />
    </div>

    {refreshError && <div className="space-y-3 border-b p-5 sm:p-6">
      <p id="gmail-refresh-error" role="alert" className="text-sm leading-6 text-foreground">{refreshError} Showing the last known Gmail status; it may be out of date.</p>
      <Button variant="outline" size="sm" className="rounded-full" onClick={onRefresh} disabled={refreshing} aria-describedby="gmail-refresh-error">Retry Gmail status</Button>
    </div>}

    {gmailStatus.connectionState === "rate_limited" && <p role="status" className="border-b p-5 text-sm">Google temporarily limited this mailbox. Sending and reply sync will retry after {gmailStatus.cooldownUntil ? new Date(gmailStatus.cooldownUntil).toLocaleString() : "the provider cooldown"}.</p>}
    {gmailStatus.syncPending && !gmailStatus.syncFailures && <p role="status" className="border-b p-5 text-sm">Reply sync is queued or processing. Inbox changes may not appear until it finishes.</p>}
    {Boolean(gmailStatus.syncFailures) && <p role="status" className="border-b p-5 text-sm">Reply sync is delayed. Saved inbox changes will be retried{gmailStatus.syncRetryAt ? ` after ${new Date(gmailStatus.syncRetryAt).toLocaleString()}` : " automatically"}.</p>}
    {gmailStatus.connected ? <div className="space-y-5 p-5 sm:p-6">
      <div className="flex flex-col gap-4 rounded-xl bg-muted/50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500 text-sm font-semibold text-white">{gmailStatus.email?.charAt(0).toUpperCase() || "G"}</span>
          <div className="min-w-0"><p className="break-all text-sm font-semibold">{gmailStatus.email || "Gmail account"}</p><p className="mt-0.5 text-xs text-muted-foreground">{refreshError || needsReconnect ? "Previously connected through Google" : "Connected through Google"}</p></div>
        </div>
        <Button variant="outline" size="sm" className="self-start rounded-full sm:self-auto" onClick={onRefresh} loading={refreshing} loadingText="Refresh status" aria-describedby={refreshError ? "gmail-refresh-error" : undefined}>
          <RefreshCw className="mr-2 h-4 w-4" />Refresh status
        </Button>
      </div>

      {gmailStatus.tokenExpired ? <Callout tone="warning" role="alert" title="Gmail authorization expired">Reconnect this account to resume Gmail sending and reply sync.</Callout> : gmailStatus.watchStatus ? <div className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3"><Inbox className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><p className="text-sm font-medium">{refreshError ? "Last known reply sync" : "Reply sync"} {watchNeedsAttention ? "needs attention" : "is active"}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{refreshError ? "Refresh Gmail status to check the current reply sync state." : watchNeedsAttention ? "Restart inbox monitoring to receive new replies here." : "New replies from this Gmail account are being monitored."}</p></div></div>
        {watchNeedsAttention && <Button variant="outline" size="sm" className="self-start rounded-full sm:self-auto" onClick={onSetupWatch} loading={settingUpWatch} loadingText="Restart sync"><RefreshCw className="mr-2 h-4 w-4" />Restart sync</Button>}
      </div> : null}

      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={onConnect} loading={connecting} loadingText="Opening Google…" disabled={signInUnavailable} className="rounded-full">{needsReconnect ? "Reconnect Gmail" : "Change Gmail account"}</Button>
        <Button variant="outline" className="rounded-full border-destructive/25 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDisconnect} disabled={disconnecting}><Unplug className="mr-2 h-4 w-4" />Disconnect Gmail</Button>
      </div>
    </div> : <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex items-start gap-3">{needsReconnect || signInUnavailable ? <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" /> : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />}<p className="max-w-xl text-sm leading-6 text-muted-foreground">{needsReconnect ? <><span className="font-medium text-foreground">{reconnectEmail || gmailStatus.email}</span> was used before, but Gmail access is no longer active. {signInUnavailable ? "Ask the app administrator to configure Gmail sign-in before reconnecting." : "Sign in with Google again to resume sending and reply sync."}</> : signInUnavailable ? "Gmail sign-in has not been configured by the app administrator yet." : "Use your Gmail address for outreach. You’ll choose which Google account to authorize during sign-in."}</p></div>
      <Button onClick={onConnect} loading={connecting} loadingText="Opening Google…" disabled={signInUnavailable} className="shrink-0 self-start rounded-full px-5 sm:self-auto">{needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}</Button>
    </div>}
  </section>;
}
