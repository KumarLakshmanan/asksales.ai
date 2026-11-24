"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";

interface SMSCallbacks { url: string; deliveryUrl: string; expiresAt?: string }

export function MSG91Callbacks() {
  const { toast } = useToast();
  const [callbacks, setCallbacks] = useState<SMSCallbacks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ success: boolean; webhooks: { sms?: SMSCallbacks } }>("/api/webhooks/config");
      if (!result.success || !result.webhooks.sms?.url || !result.webhooks.sms.deliveryUrl) throw new Error("SMS callback URLs could not be loaded.");
      setCallbacks(result.webhooks.sms);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "SMS callback URLs could not be loaded.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const copied = () => toast({ title: "Callback URL copied" });
  const copyFailed = () => toast({ title: "Could not copy URL", description: "Select and copy the URL from the field.", variant: "destructive" });

  return <section aria-labelledby="msg91-callbacks-title" className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="msg91-callbacks-title" className="text-sm font-semibold">Delivery and replies</h3><Button asChild variant="outline" size="sm" className="rounded-full"><Link href="/dashboard/integrations/msg91/events">Events and activity</Link></Button></div>
    {!loading && callbacks?.expiresAt && <p className="text-xs text-muted-foreground">Copy these URLs into MSG91 to renew callback setup. These URLs expire on {new Date(callbacks.expiresAt).toLocaleDateString()}; previously configured URLs keep their original expiry.</p>}
    {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner label={null} />Loading callback URLs…</p> : error ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Retry callback setup</Button></div> : callbacks && <>
      <div className="space-y-2">
        <Label htmlFor="msg91-delivery-url">Delivery callback URL</Label>
        <div className="flex gap-2"><Input id="msg91-delivery-url" readOnly value={callbacks.deliveryUrl} className="min-w-0 font-mono text-xs" /><CopyButton iconOnly value={callbacks.deliveryUrl} label="Copy delivery callback URL" onCopied={copied} onError={copyFailed} /></div>
        <p className="text-xs leading-6 text-muted-foreground">In MSG91 SMS → Webhook (New), create an <strong>OnReportReceived</strong> webhook with POST and JSON. Map these fields to the matching MSG91 values:</p>
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 text-xs leading-6">{'{\n  "requestId": "MSG91 request ID",\n  "senderId": "Sender ID",\n  "telNum": "Recipient phone",\n  "status": "Delivery status",\n  "deliveryTime": "Delivery time"\n}'}</pre>
        <p className="text-xs leading-5 text-muted-foreground">Status 0 is sent, 1 is delivered, and failure or rejection statuses are recorded as failed. These updates appear in SMS history.</p>
      </div>
      <div className="space-y-2 border-t pt-4">
        <Label htmlFor="msg91-inbound-url">Incoming SMS callback URL</Label>
        <div className="flex gap-2"><Input id="msg91-inbound-url" readOnly value={callbacks.url} className="min-w-0 font-mono text-xs" /><CopyButton iconOnly value={callbacks.url} label="Copy incoming SMS callback URL" onCopied={copied} onError={copyFailed} /></div>
        <p className="text-xs leading-6 text-muted-foreground">For an MSG91 inbound number or longcode, configure a POST JSON callback with <code>sender</code>, <code>message</code>, and a unique <code>requestId</code>. You can include <code>receivedAt</code> and <code>providerAccountId</code> (your Sender ID) to match replies to the correct sender.</p>
        <p className="text-xs leading-6 text-muted-foreground">Incoming SMS must be enabled on your MSG91 account. Replies from existing contacts appear in the outreach inbox.</p>
      </div>
    </>}
  </section>;
}
