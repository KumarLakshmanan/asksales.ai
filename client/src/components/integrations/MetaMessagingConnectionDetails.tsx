"use client";

import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MetaMessagingAccount } from "@/lib/integrations";
import { describeLastChecked } from "@/lib/last-checked";

export function MetaMessagingConnectionDetails({ account, refreshing, onRefresh }: {
  account: MetaMessagingAccount;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  const incomingReady = account.webhookSubscribed === true;
  const tokenExpires = account.expiresAt ? new Date(account.expiresAt) : null;
  const validExpiry = tokenExpires && !Number.isNaN(tokenExpires.getTime());

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-base font-semibold">Connection health</h3>
        <p className="mt-1 text-sm text-muted-foreground">Your account and message delivery status.</p>
      </div>
      {account.authorized && <Button variant="outline" size="sm" onClick={() => void onRefresh()} loading={refreshing} loadingText="Refresh connection">
        <RefreshCw className="mr-2 h-4 w-4" />
        Refresh connection
      </Button>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium">{account.connected ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleAlert className="h-4 w-4 text-amber-600" />}Account access</div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{account.connected ? "Connected to AskSales" : "Finish account selection or reconnect"}</p>
      </div>
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium">{incomingReady ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleAlert className="h-4 w-4 text-amber-600" />}Incoming messages</div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{incomingReady ? "Message events are active" : "Message events need attention"}</p>
      </div>
    </div>
    {account.readinessErrorCode && account.readinessErrorCode !== "APP_REVIEW" && <p className="text-sm text-amber-700 dark:text-amber-300">This connection needs attention. Try reconnecting or contact support if the issue continues.</p>}
    {validExpiry && <p className="text-xs text-muted-foreground">Authorization expires {tokenExpires.toLocaleDateString()}</p>}
    {account.lastVerifiedAt && (() => {
      const { text, stale } = describeLastChecked(account.lastVerifiedAt);
      return <p className={stale ? "text-xs text-amber-700 dark:text-amber-300" : "text-xs text-muted-foreground"}>
        {text}{stale && account.authorized ? ". This status may be out of date; use Refresh connection to check again." : ""}
      </p>;
    })()}
  </div>;
}
