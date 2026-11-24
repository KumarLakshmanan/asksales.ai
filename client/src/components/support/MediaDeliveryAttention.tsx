"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type MediaDeliveryAttentionItem = {
  id: number; channel: string; name: string; status: "uncertain" | "failed";
  conversation_id?: number; failure_code?: string; updated_at: string;
  failure_summary?: string; recovery_guidance?: string;
  recovery_action?: "retry" | "connection" | "verify" | "new_reply";
  retry_eligible?: boolean; account_binding_required?: boolean;
};

export function MediaDeliveryAttention({ deliveries, loadError, saving, onReload, onRetry, onVerify, onConnections, now = Date.now() }: {
  deliveries: MediaDeliveryAttentionItem[]; loadError: boolean; saving: boolean;
  onReload: () => void; onRetry: (item: MediaDeliveryAttentionItem) => void;
  onVerify: (item: MediaDeliveryAttentionItem) => void; onConnections: () => void; now?: number;
}) {
  if (!loadError && !deliveries.length) return null;
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const recent = deliveries.filter((item) => new Date(item.updated_at).getTime() >= cutoff);
  const historical = deliveries.filter((item) => !(new Date(item.updated_at).getTime() >= cutoff));
  const uncertainCount = deliveries.filter((item) => item.status === "uncertain").length;
  function rows(items: MediaDeliveryAttentionItem[]) {
    return <div className="mt-3 max-h-96 space-y-3 overflow-y-auto pr-1">{items.map((item) => <div key={item.id} className="ak-delivery-row space-y-2 border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.name} · {item.channel} · {item.status === "uncertain" ? "Unconfirmed" : "Failed attempt"}</p>
          <p className="text-xs text-muted-foreground">Conversation {item.conversation_id || "—"} · {new Date(item.updated_at).toLocaleString()}</p></div>
        {item.status === "uncertain" ? <Button size="sm" variant="outline" disabled={saving} onClick={() => onVerify(item)}>Verify outcome</Button>
          : item.recovery_action === "connection" ? <Button size="sm" variant="outline" onClick={onConnections}>Review connection</Button>
            : item.retry_eligible === true && item.recovery_action === "retry" ? <Button size="sm" variant="outline" disabled={saving} onClick={() => onRetry(item)}>Retry image</Button> : null}
      </div>
      <p className="text-sm">{item.failure_summary || (item.status === "uncertain" ? "Delivery was not confirmed; the image may already have arrived." : "This image delivery failed.")}</p>
      <p className="text-xs text-muted-foreground">{item.recovery_guidance || "Check the provider conversation before taking action. Do not resend an unconfirmed delivery."}</p>
      {item.account_binding_required && <p className="text-xs text-amber-700 dark:text-amber-400">This historical conversation has no verified sending account. Use a new inbound conversation on the connected account; retry is disabled.</p>}
      {item.recovery_action === "new_reply" && !item.account_binding_required && <p className="text-xs text-muted-foreground">This conversation is no longer eligible for retry. Use an active customer-requested conversation.</p>}
    </div>)}</div>;
  }
  return <Card className="ak-delivery-attention"><CardHeader><CardTitle className="text-base">Media delivery needs attention</CardTitle>
    <CardDescription>Past attempts are not a live connection-health check. No images are resent automatically from this panel.</CardDescription></CardHeader>
    <CardContent className="space-y-3">
      {loadError ? <div role="alert" className="flex items-center justify-between gap-3 text-sm">Delivery status could not be loaded.<Button variant="outline" onClick={onReload}>Retry</Button></div> : <>
        <p className="text-sm">{deliveries.length - uncertainCount} failed · {uncertainCount} unconfirmed · {recent.length} updated in the last 7 days</p>
        <p className="text-xs text-muted-foreground">Showing up to 100 unresolved attempts. Older entries remain in the audit history; collapsing them does not mark them delivered.</p>
        {recent.length > 0 && <details open><summary className="cursor-pointer text-sm font-medium">Recent attempts ({recent.length})</summary>{rows(recent)}</details>}
        {historical.length > 0 && <details><summary className="cursor-pointer text-sm font-medium">Older attempts ({historical.length}) · {historical.filter((item) => item.status === "uncertain").length} need outcome verification</summary>{rows(historical)}</details>}
      </>}
    </CardContent></Card>;
}
