"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";

/** Mirrors server WhatsAppBatchQuote (services/whatsapp/WhatsAppBillingService.ts). */
type WhatsAppBatchQuote = {
  platformBilled: boolean;
  messages: number;
  messageCredits: number;
  platformFeeCredits: number;
  totalCredits: number;
  byCategory: Record<string, { messages: number; credits: number }>;
  estimatedRecipients: number;
  missingRates: string[];
  walletBalance: number | null;
  sufficient: boolean;
};

export type WhatsAppCostItem = { recipient?: string; templateName?: string; templateLanguage?: string };

const MAX_QUOTE_ITEMS = 5000;
const CATEGORY_LABELS: Record<string, string> = {
  marketing: "marketing", utility: "utility", authentication: "authentication", service: "replies",
};
const credits = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/**
 * The WhatsApp cost of this outreach, for accounts AskSales bills for Meta.
 * Renders nothing for accounts that pay Meta themselves. The launch is checked
 * again on the server, so this is guidance, never the gate.
 */
export function WhatsAppCostPreview({ items, phoneNumberId }: { items: WhatsAppCostItem[]; phoneNumberId?: string | null }) {
  const quoted = items.slice(0, MAX_QUOTE_ITEMS);
  const key = JSON.stringify([phoneNumberId ?? null, quoted]);
  const query = useQuery<WhatsAppBatchQuote, Error>({
    queryKey: ["whatsapp-cost-preview", key],
    queryFn: () => api.post<WhatsAppBatchQuote>("/api/whatsapp/billing/quote", { phoneNumberId: phoneNumberId ?? undefined, items: quoted }),
    enabled: quoted.length > 0,
    staleTime: 60_000,
  });

  if (!quoted.length || query.isError) return null;
  if (query.isPending) {
    return <div>
      <dt className="text-xs text-muted-foreground">WhatsApp cost</dt>
      <dd className="mt-1 h-5 w-40 animate-pulse rounded bg-muted" aria-label="Working out the WhatsApp cost" />
    </div>;
  }
  const quote = query.data;
  if (!quote?.platformBilled) return null;

  const partial = items.length > quoted.length;
  const categories = Object.entries(quote.byCategory)
    .filter(([, bucket]) => bucket.messages > 0)
    .map(([category, bucket]) => `${bucket.messages.toLocaleString("en-IN")} ${CATEGORY_LABELS[category] ?? category}`);
  const short = quote.walletBalance !== null && quote.walletBalance < quote.totalCredits;

  return <div>
    <dt className="text-xs text-muted-foreground">WhatsApp cost{partial ? ` (first ${MAX_QUOTE_ITEMS.toLocaleString("en-IN")} messages)` : ""}</dt>
    <dd className="mt-1 space-y-1">
      <p><span className="font-medium tabular-nums">About {credits(quote.totalCredits)} credits</span>
        {quote.platformFeeCredits > 0 && <span className="text-muted-foreground"> · {credits(quote.messageCredits)} Meta + {credits(quote.platformFeeCredits)} fee</span>}
      </p>
      {categories.length > 0 && <p className="text-xs text-muted-foreground">{categories.join(" · ")}. Charged per delivered message; undelivered ones are refunded.</p>}
      {quote.estimatedRecipients > 0 && <p className="text-xs text-muted-foreground">{quote.estimatedRecipients.toLocaleString("en-IN")} number(s) have no country match, so they are counted at the highest rate.</p>}
      {quote.missingRates.length > 0 && <p role="alert" className="text-xs text-destructive">No price yet for {quote.missingRates.join(", ")}. These messages can&apos;t be sent until an administrator adds the rate.</p>}
      {!quote.missingRates.length && short && <p role="alert" className="text-xs text-destructive">
        Your wallet has {credits(quote.walletBalance ?? 0)} credits. <Link href="/dashboard/billing/recharge" className="underline">Recharge</Link> before launching.
      </p>}
    </dd>
  </div>;
}
