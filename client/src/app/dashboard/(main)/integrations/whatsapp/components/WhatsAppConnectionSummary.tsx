"use client";

import { Activity, CheckCircle2, CircleAlert, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { describeLastChecked } from "@/lib/last-checked";

type WhatsAppStatus = {
  connectionStatus?: "ready" | "limited" | "action_required" | "reauth_required";
  readinessErrorCode?: string | null;
  readiness?: { sending: boolean; customerReplies?: boolean; webhook: boolean };
  tokenStatus?: "active" | "expiring_soon" | "expired" | "invalid" | "unknown";
  accessTokenExpiresAt?: string | null;
  lastVerifiedAt?: string | null;
};

export function WhatsAppConnectionSummary({ status, testing, onTest }: {
  status: WhatsAppStatus;
  testing: boolean;
  onTest: () => Promise<void>;
}) {
  const connected = status.connectionStatus === "ready" || status.connectionStatus === "limited";
  const repliesReady = Boolean(status.readiness?.customerReplies && status.readiness?.webhook);
  const sendingReady = Boolean(status.readiness?.sending);
  const needsMetaAction = status.readinessErrorCode === "meta_100_33";

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="flex items-center gap-2 text-base font-semibold"><Activity className="h-4 w-4 text-[#25D366]" />Connection health</h3>
        <p className="mt-1 text-sm text-muted-foreground">Check what this number can do in AskSales.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void onTest()} loading={testing} loadingText="Test connection">
        <Smartphone className="mr-2 h-4 w-4" />
        Test connection
      </Button>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      {[
        { label: "Meta connection", ready: connected, description: connected ? "Account authorized" : "Reconnect to Meta" },
        { label: "Customer replies", ready: repliesReady, description: repliesReady ? "Incoming messages ready" : "Incoming messages need attention" },
        { label: "Sending", ready: sendingReady, description: sendingReady ? "Messages can be sent" : "Sending needs attention" },
      ].map(item => <div key={item.label} className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium">{item.ready ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleAlert className="h-4 w-4 text-amber-600" />}{item.label}</div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.description}</p>
      </div>)}
    </div>
    {needsMetaAction && <Callout tone="warning">
      Meta no longer exposes this phone number to the selected business account. Check phone registration, account restrictions, payment status, and business verification in <a className="font-semibold underline underline-offset-2" href="https://business.facebook.com/latest/whatsapp_manager/phone_numbers/" target="_blank" rel="noreferrer">WhatsApp Manager</a>. Reconnecting alone cannot restore a disabled account.
    </Callout>}
    {(status.tokenStatus === "expiring_soon" || status.tokenStatus === "expired" || status.tokenStatus === "invalid") && <p className="text-sm text-amber-700 dark:text-amber-300">Your authorization needs attention. Reconnect WhatsApp to renew access.</p>}
    {status.lastVerifiedAt && <LastCheckedNote value={status.lastVerifiedAt} action="Test connection" />}
  </div>;
}

function LastCheckedNote({ value, action }: { value: string; action: string }) {
  const { text, stale } = describeLastChecked(value);
  return <p className={stale ? "text-xs text-amber-700 dark:text-amber-300" : "text-xs text-muted-foreground"}>
    {text}{stale ? `. This status may be out of date; use ${action} to check again.` : ""}
  </p>;
}
