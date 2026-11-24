"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import api from "@/lib/api";
import { Callout } from "@/components/ui/callout";

type WhatsAppBillingSummary = {
  platformBilled: boolean;
  enabled: boolean;
  monthStart: string;
  byCategory: Array<{ category: string; messages: number; credits: number }>;
  totalCredits: number;
  pendingMessages: number;
  reviewMessages: number;
  freeServiceByNumber: Array<{ phoneNumberId: string; free: number; billable: number }>;
  dailySpendCap: number | null;
  spentToday: number;
};

const FREE_SERVICE_PER_MONTH = 1000;
const CATEGORY_LABELS: Record<string, string> = {
  marketing: "Marketing", utility: "Utility", authentication: "Authentication", service: "Service replies", free: "Free messages",
};
const credits = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/**
 * Month-to-date Meta message charges for accounts that AskSales bills for Meta.
 * Renders nothing for accounts that pay Meta directly.
 */
export function WhatsAppBillingCard({ phoneNumberId }: { phoneNumberId?: string | null }) {
  const query = useQuery<WhatsAppBillingSummary, Error>({
    queryKey: ["whatsapp-billing-summary", phoneNumberId ?? null],
    queryFn: () => api.get<WhatsAppBillingSummary>(`/api/whatsapp/billing/summary${phoneNumberId ? `?phoneNumberId=${encodeURIComponent(phoneNumberId)}` : ""}`),
    staleTime: 60_000,
  });
  const summary = query.data;
  if (query.isPending || query.isError || !summary?.enabled || !summary.platformBilled) return null;

  const month = new Date(`${summary.monthStart}T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", timeZone: "UTC" });
  const capUsed = summary.dailySpendCap ? Math.min(100, Math.round(summary.spentToday / summary.dailySpendCap * 100)) : null;

  return <section className="space-y-4 rounded-xl border bg-card p-4" aria-labelledby="whatsapp-billing-heading">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="whatsapp-billing-heading" className="flex items-center gap-2 text-base font-semibold"><Wallet className="h-4 w-4 text-[#25D366]" />Message charges</h3>
        <p className="mt-1 text-sm text-muted-foreground">AskSales pays Meta for this number. Each delivered message is charged to your wallet: Meta&apos;s price for its category and recipient country, our service margin, and the WhatsApp message fee.</p>
      </div>
      <Link href="/dashboard/billing/transactions" className="text-sm font-medium text-[#25D366] underline-offset-2 hover:underline">Wallet history</Link>
    </div>

    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg border p-3">
        <p className="text-xs text-muted-foreground">{month} so far</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{credits(summary.totalCredits)} <span className="text-sm font-normal text-muted-foreground">credits</span></p>
      </div>
      {summary.freeServiceByNumber.map(number => <div key={number.phoneNumberId} className="rounded-lg border p-3">
        <p className="text-xs text-muted-foreground">Free service replies this month</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{Math.min(number.free, FREE_SERVICE_PER_MONTH).toLocaleString("en-IN")} <span className="text-sm font-normal text-muted-foreground">of {FREE_SERVICE_PER_MONTH.toLocaleString("en-IN")}</span></p>
      </div>)}
      {summary.dailySpendCap !== null && <div className="rounded-lg border p-3">
        <p className="text-xs text-muted-foreground">Today&apos;s spending limit</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{credits(summary.spentToday)} <span className="text-sm font-normal text-muted-foreground">of {credits(summary.dailySpendCap)}</span></p>
        <div className="mt-2 h-1.5 rounded-full bg-muted" role="progressbar" aria-valuenow={capUsed ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Daily limit used">
          <div className={capUsed !== null && capUsed >= 90 ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-[#25D366]"} style={{ width: `${capUsed ?? 0}%` }} />
        </div>
      </div>}
    </div>

    {summary.byCategory.length > 0 ? <div className="overflow-x-auto"><table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">Category</th><th className="py-1 text-right font-medium">Messages</th><th className="py-1 text-right font-medium">Credits</th></tr></thead>
      <tbody>{summary.byCategory.map(row => <tr key={row.category} className="border-t">
        <td className="py-1.5">{CATEGORY_LABELS[row.category] ?? row.category}</td>
        <td className="py-1.5 text-right tabular-nums">{row.messages.toLocaleString("en-IN")}</td>
        <td className="py-1.5 text-right tabular-nums">{credits(row.credits)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="text-sm text-muted-foreground">No WhatsApp messages have been charged this month.</p>}

    {summary.pendingMessages > 0 && <p className="text-xs text-muted-foreground">{summary.pendingMessages === 1 ? "1 message is" : `${summary.pendingMessages.toLocaleString("en-IN")} messages are`} waiting for Meta&apos;s delivery report. Credits held for them are released if Meta doesn&apos;t deliver them.</p>}
    {summary.reviewMessages > 0 && <Callout tone="warning">{summary.reviewMessages === 1 ? "1 message charge is" : `${summary.reviewMessages.toLocaleString("en-IN")} message charges are`} being checked by our team. Credits held for them stay held until the check is done.</Callout>}
  </section>;
}
