"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, History, RefreshCw } from "lucide-react";
import { useBillingApi } from "@/hooks/use-billing-api";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCredits } from "../../../../shared/subscriptions";

type Transaction = {
  id: number; type: string; amount: string; balanceAfter: string;
  description: string | null; createdAt: string;
};
type Transactions = { transactions: Transaction[]; total: number };

const TYPES = [
  { value: "all", label: "All types" },
  { value: "recharge", label: "Recharges" },
  { value: "deduction", label: "Credit usage" },
  { value: "bonus", label: "Deposits & bonuses" },
  { value: "refund", label: "Credit refunds" },
  { value: "adjustment", label: "Adjustments" },
];
const TYPE_LABELS: Record<string, string> = {
  recharge: "Recharge", deduction: "Credit usage", bonus: "Deposit / bonus",
  refund: "Credit refund", adjustment: "Adjustment",
};
const LIMIT = 10;

function timestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? { date: "—", time: "" } : {
    date: parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
    time: parsed.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

function CreditAmount({ value }: { value: string }) {
  const amount = Number(value);
  return <span className={`font-mono text-sm font-semibold tabular-nums ${amount > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-foreground"}`}>
    {Number.isFinite(amount) ? `${amount > 0 ? "+" : ""}${formatCredits(amount)}` : "—"}
  </span>;
}

export default function CreditActivity() {
  const api = useBillingApi();
  const { billingScopeKey, ready } = useBillingOrganizations();
  const id = useId();
  const [type, setType] = useState("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [page, setPage] = useState(0);
  const invalidRange = !!start && !!end && start > end;
  const filtered = type !== "all" || !!start || !!end;
  const activity = useQuery<Transactions>({
    queryKey: ["wallet-transactions", billingScopeKey, { type, start, end, page, limit: LIMIT }],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(page * LIMIT) });
      if (type !== "all") params.set("type", type);
      // Include the whole selected day in the viewer's local timezone.
      if (start) params.set("startDate", new Date(`${start}T00:00:00.000`).toISOString());
      if (end) params.set("endDate", new Date(`${end}T23:59:59.999`).toISOString());
      return api.get<Transactions>(`/api/wallet/transactions?${params}`);
    },
    enabled: ready && !invalidRange,
  });
  const transactions = activity.data?.transactions ?? [];
  const total = activity.data?.total ?? 0;
  const loading = !ready || activity.isPending;
  const clear = () => { setType("all"); setStart(""); setEnd(""); setPage(0); };

  return <section id="credit-activity" aria-labelledby="credit-activity-heading" className="scroll-mt-5 overflow-hidden rounded-2xl border border-border bg-card">
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 sm:px-6">
      <div className="min-w-0 flex-1">
        <h2 id="credit-activity-heading" className="flex items-center gap-2 text-base font-semibold"><History className="h-5 w-5 text-primary" aria-hidden />Credit activity</h2>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">Deposits, recharges, usage and refunds in your shared credit balance.</p>
      </div>
      <Button variant="ghost" className="min-h-11 shrink-0 gap-2 rounded-lg px-3 text-primary" aria-label="Refresh credit activity" disabled={!ready || activity.isFetching || invalidRange} onClick={() => void activity.refetch()}>
        <RefreshCw className={activity.isFetching ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden />Refresh
      </Button>
    </div>
    <div className="grid items-end gap-3 px-5 py-4 sm:grid-cols-2 sm:px-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
      <div className="min-w-0">
        <label htmlFor={`${id}-type`} className="mb-1.5 block text-xs font-medium text-muted-foreground">Transaction type</label>
        <select id={`${id}-type`} value={type} onChange={event => { setType(event.target.value); setPage(0); }} className="min-h-11 w-full rounded-[10px] border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      <div className="grid w-full min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0"><label htmlFor={`${id}-start`} className="mb-1.5 block text-xs font-medium text-muted-foreground">From date</label><Input id={`${id}-start`} type="date" value={start} max={end || undefined} onChange={event => { setStart(event.target.value); setPage(0); }} className="min-h-11 min-w-0" /></div>
        <div className="min-w-0"><label htmlFor={`${id}-end`} className="mb-1.5 block text-xs font-medium text-muted-foreground">To date</label><Input id={`${id}-end`} type="date" value={end} min={start || undefined} onChange={event => { setEnd(event.target.value); setPage(0); }} className="min-h-11 min-w-0" /></div>
      </div>
      {filtered && <Button variant="ghost" className="min-h-11 text-muted-foreground" onClick={clear}>Clear filters</Button>}
    </div>
    {invalidRange ? <p role="alert" className="border-t border-border px-5 py-6 text-sm text-destructive sm:px-7">The end date must be on or after the start date.</p>
      : activity.isError ? <div role="alert" className="border-t border-border px-5 py-7 sm:px-7"><p className="text-sm">Credit activity could not be loaded.</p><Button variant="outline" className="mt-3" onClick={() => void activity.refetch()}>Try again</Button></div>
      : loading ? <div role="status" aria-label="Loading credit activity" className="space-y-4 border-t border-border px-5 py-6 sm:px-7">{[0, 1, 2].map(index => <Skeleton key={index} className="h-12 w-full" />)}</div>
      : transactions.length ? <>
        <div className="hidden md:block">
          <table className="w-full table-fixed text-left text-sm">
            <caption className="sr-only">Credit transactions for the selected business</caption>
            <thead className="border-y border-border bg-muted/50 text-xs text-muted-foreground"><tr><th scope="col" className="w-[19%] px-7 py-3 font-medium">Date</th><th scope="col" className="w-[18%] px-4 py-3 font-medium">Type</th><th scope="col" className="px-4 py-3 font-medium">Description</th><th scope="col" className="w-[15%] px-4 py-3 text-right font-medium">Credits</th><th scope="col" className="w-[17%] px-7 py-3 text-right font-medium">Balance after</th></tr></thead>
            <tbody className="divide-y divide-border">{transactions.map(transaction => {
              const created = timestamp(transaction.createdAt);
              return <tr key={transaction.id}><td className="px-7 py-4 align-top"><p>{created.date}</p><p className="mt-1 text-xs text-muted-foreground">{created.time}</p></td><td className="px-4 py-4 align-top"><span className="inline-block rounded-md bg-muted px-2 py-1 text-xs font-medium">{TYPE_LABELS[transaction.type] ?? "Credit activity"}</span></td><td className="break-words px-4 py-4 align-top text-muted-foreground"><p>{transaction.description || TYPE_LABELS[transaction.type] || "Credit transaction"}</p><p className="mt-1 text-xs">Transaction #{transaction.id}</p></td><td className="px-4 py-4 text-right align-top"><CreditAmount value={transaction.amount} /></td><td className="px-7 py-4 text-right align-top font-mono text-xs tabular-nums">{Number.isFinite(Number(transaction.balanceAfter)) ? formatCredits(Number(transaction.balanceAfter)) : "—"}</td></tr>;
            })}</tbody>
          </table>
        </div>
        <ul className="divide-y divide-border border-t border-border md:hidden" aria-label="Credit transactions">{transactions.map(transaction => {
          const created = timestamp(transaction.createdAt);
          return <li key={transaction.id} className="px-5 py-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-sm font-medium">{TYPE_LABELS[transaction.type] ?? "Credit activity"}</p><p className="mt-1 text-xs text-muted-foreground">{created.date} · {created.time}</p></div><div className="shrink-0 text-right"><CreditAmount value={transaction.amount} /><p className="mt-1 text-[11px] text-muted-foreground">credits</p></div></div><p className="mt-3 break-words text-sm leading-5 text-muted-foreground">{transaction.description || "Credit transaction"}</p><p className="mt-1 text-xs text-muted-foreground">Transaction #{transaction.id}</p><p className="mt-2 text-xs text-muted-foreground">Balance after: <span className="font-mono tabular-nums">{Number.isFinite(Number(transaction.balanceAfter)) ? formatCredits(Number(transaction.balanceAfter)) : "—"}</span> credits</p></li>;
        })}</ul>
      </> : <div className="border-t border-border px-5 py-10 text-center sm:px-7"><History className="mx-auto h-7 w-7 text-muted-foreground/50" aria-hidden /><p className="mt-3 text-sm font-medium">{filtered ? "No activity matches these filters" : "No credit activity yet"}</p><p className="mt-1 text-xs text-muted-foreground">{filtered ? "Choose another date range or clear the filters." : "Plan deposits, recharges and credit usage will appear here."}</p></div>}
    {!invalidRange && !loading && !activity.isError && total > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 sm:px-7">
      <p role="status" className="text-xs text-muted-foreground">{transactions.length ? `${page * LIMIT + 1}–${Math.min(page * LIMIT + transactions.length, total)}` : "0"} of {total.toLocaleString("en-IN")} transactions</p>
      <div className="flex items-center gap-2"><Button variant="outline" size="sm" className="min-h-11" disabled={page === 0 || activity.isFetching} onClick={() => setPage(value => value - 1)}><ChevronLeft aria-hidden />Previous</Button><Button variant="outline" size="sm" className="min-h-11" disabled={(page + 1) * LIMIT >= total || activity.isFetching} onClick={() => setPage(value => value + 1)}>Next<ChevronRight aria-hidden /></Button></div>
    </div>}
  </section>;
}
