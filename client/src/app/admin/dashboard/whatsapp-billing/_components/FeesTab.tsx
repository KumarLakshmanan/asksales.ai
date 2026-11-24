"use client";

import { useMemo, useState } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { LoadError, errorText, useAdminData } from "./shared";

interface PricingItem { id: number; eventKey: string; name: string; description: string | null; category: string; creditsPerUnit: string; unitLabel: string; isActive: boolean }

const FEES: Array<{ key: string; label: string; help: string; unit: string }> = [
  { key: "outreach_whatsapp_platform", label: "Platform fee per message (we pay Meta)", unit: "credits per message",
    help: "Our own fee per WhatsApp message on accounts billed through our credit line, charged on top of Meta's message charge. Set it to 0 to charge only Meta's rate and margin." },
  { key: "outreach_whatsapp", label: "Platform fee per message (customer pays Meta)", unit: "credits per message",
    help: "The fee per WhatsApp message on accounts that pay Meta themselves. Meta's charge isn't added for these." },
  { key: "whatsapp_margin_marketing", label: "Margin on Marketing messages", unit: "% on Meta's rate", help: "" },
  { key: "whatsapp_margin_utility", label: "Margin on Utility messages", unit: "% on Meta's rate", help: "" },
  { key: "whatsapp_margin_authentication", label: "Margin on Authentication messages", unit: "% on Meta's rate", help: "" },
  { key: "whatsapp_margin_service", label: "Margin on Service messages", unit: "% on Meta's rate", help: "" },
  { key: "whatsapp_free_message_fee", label: "Fee for messages Meta delivers free", unit: "credits per message",
    help: "Charged for delivered messages Meta doesn't bill, such as free service replies and messages in a free entry-point window." },
];

export function FeesTab() {
  const { toast } = useToast();
  const pricing = useAdminData<PricingItem[]>("/api/admin/credit-pricing");
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);

  const rows = useMemo(() => {
    const byKey = new Map((pricing.data ?? []).map(item => [item.eventKey, item]));
    return FEES.map(fee => ({ fee, item: byKey.get(fee.key) ?? null }));
  }, [pricing.data]);

  const save = async (item: PricingItem, patch: { creditsPerUnit?: number; isActive?: boolean }) => {
    setSaving(item.id);
    try {
      await api.put(`/api/admin/credit-pricing/${item.id}`, patch);
      setEdits(current => { const next = { ...current }; delete next[item.id]; return next; });
      toast({ title: `${item.name} saved` });
      await pricing.reload();
    } catch (error) {
      toast({ title: "Fee was not saved", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setSaving(null); }
  };

  return <Card>
    <CardHeader>
      <CardTitle className="text-base">Fees and margins</CardTitle>
      <CardDescription>What a delivered WhatsApp message costs the customer on an account billed through us: Meta&apos;s rate for the category and market, plus the margin, converted at the recharge rate, plus the platform fee. Changes apply to new messages and are recorded in Pricing History.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {pricing.error ? <LoadError message={pricing.error} onRetry={() => void pricing.reload()} /> : pricing.loading ? <LoadingState label="Loading fees…" /> : <>
        {rows.some(row => !row.item) && <Callout tone="warning" size="sm">Some fees are missing. Run the database migrations (595_whatsapp_platform_billing) to create them.</Callout>}
        {rows.map(({ fee, item }) => item && <div key={fee.key} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">{fee.label}</p>
            {fee.help && <p className="mt-1 text-xs text-muted-foreground">{fee.help}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={item.isActive} disabled={saving === item.id} onCheckedChange={checked => void save(item, { isActive: checked })} aria-label={`${fee.label} active`} />
              {item.isActive ? "On" : "Off"}
            </label>
            <Input aria-label={`${fee.label} (${fee.unit})`} inputMode="decimal" className="h-9 w-24 text-right tabular-nums"
              value={edits[item.id] ?? String(Number(item.creditsPerUnit))} onChange={event => setEdits(current => ({ ...current, [item.id]: event.target.value }))} />
            <span className="w-28 text-xs text-muted-foreground">{fee.unit}</span>
            <Button size="sm" variant="outline" disabled={edits[item.id] === undefined || edits[item.id].trim() === "" || !(Number(edits[item.id]) >= 0)} loading={saving === item.id}
              onClick={() => void save(item, { creditsPerUnit: Number(edits[item.id]) })}>Save</Button>
          </div>
        </div>)}
        <p className="text-xs text-muted-foreground">A margin or fee that is switched off counts as 0.</p>
      </>}
    </CardContent>
  </Card>;
}
