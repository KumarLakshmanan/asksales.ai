"use client";

import { useCallback, useEffect, useState } from "react";
import api from "@/lib/admin-api";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";

export const WA_API = "/api/admin/whatsapp-billing";
// The server converts INR and USD rates to credits.
export const CURRENCIES = ["INR", "USD"] as const;
export const CATEGORIES = ["marketing", "utility", "authentication", "service"] as const;
export const CATEGORY_LABELS: Record<string, string> = {
  marketing: "Marketing", utility: "Utility", authentication: "Authentication", service: "Service",
};

export interface CreditLineSettings {
  creditLineId: string;
  systemTokenConfigured: boolean;
  attachOnSignup: boolean;
  currency: string;
  monthlyLimit: number | null;
  alertPercent: number;
  metaAppConfigured: boolean;
  featureEnabled: boolean;
}

export interface Overview {
  settings: CreditLineSettings;
  counts: {
    platformAccounts: number; needsReview: number; awaitingDelivery: number; markets: number;
    creditsThisMonth: number; lastReconciledAt: string | null;
  };
  /** Meta's list cost of this month's billed messages, per billing currency. */
  metaCostThisMonth: Array<{ currency: string; cost: number }>;
  paymentIssues: Array<{ wabaId: string; userId: number | null; businessName: string | null; since: string; detail: string | null }>;
  fees: { marginsSet: number; platformFee: number | null };
  tierVersions: Array<{ currency: string; effectiveFrom: string }>;
  rateCardVersions: Array<{ currency: string; effectiveFrom: string; rates: number; markets: number; complete: boolean }>;
}

export const TABS = ["overview", "rates", "markets", "accounts", "review", "reconciliation", "statement", "fees"] as const;
export type TabId = typeof TABS[number];

export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
export const formatNumber = (value: number, digits = 2) => value.toLocaleString("en-IN", { maximumFractionDigits: digits });
const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹", USD: "$" };
/** Meta's prices in the billing currency, e.g. "₹0.8631". Up to 4 decimals, as on Meta's rate cards. */
export const formatMoney = (value: number, currency: string, digits = 4) =>
  `${CURRENCY_SYMBOLS[currency] ?? `${currency} `}${value.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: digits })}`;
export const formatDateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

/** Load an admin endpoint; `reload` refetches. */
export function useAdminData<T>(endpoint: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(endpoint));
  const reload = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    setError(null);
    try { setData(await api.get<T>(endpoint)); }
    catch (err) { setError(errorText(err, "This section could not be loaded.")); }
    finally { setLoading(false); }
  }, [endpoint]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Callout tone="danger">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span>{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  </Callout>;
}

/** Read a chosen CSV file as text. */
export async function readFileText(file: File | undefined | null): Promise<string> {
  if (!file) return "";
  if (file.size > 1_000_000) throw new Error("Choose a CSV of up to 1 MB.");
  return file.text();
}
