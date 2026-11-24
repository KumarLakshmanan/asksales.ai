"use client";

import { useMemo, useState } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORY_LABELS, CURRENCIES, LoadError, WA_API, errorText, formatDateTime, formatMoney, formatNumber, useAdminData } from "./shared";

interface StatementLine {
  wabaId: string; userId: number | null; market: string; category: string;
  messages: number; listCost: number; expectedCost: number; tiered: boolean; chargedCredits: number;
}
interface Statement {
  month: string;
  currency: string;
  lines: StatementLine[];
  accounts: Array<{ wabaId: string; userId: number | null; messages: number; listCost: number; expectedCost: number; chargedCredits: number; metaMessages: number | null }>;
  totals: { messages: number; listCost: number; expectedCost: number; tierSavings: number; chargedCredits: number; metaMessages: number | null };
  invoice: { amount: number; reference: string | null; note: string | null; updatedAt: string } | null;
  difference: number | null;
  tierVersion: string | null;
}

/** The last 12 months, newest first, as YYYY-MM. */
function recentMonths(): Array<{ value: string; label: string }> {
  const now = new Date();
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    return {
      value: date.toISOString().slice(0, 7),
      label: date.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }) + (index === 0 ? " (so far)" : ""),
    };
  });
}

const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

/** A difference within 1% (or one currency unit) is rounding and timing, not a billing problem. */
const isSmallDifference = (difference: number, expected: number) => Math.abs(difference) <= Math.max(1, expected * 0.01);

export function StatementTab({ defaultCurrency }: { defaultCurrency: string }) {
  const months = useMemo(() => recentMonths(), []);
  // Meta invoices a month after it ends, so open on last month.
  const [month, setMonth] = useState(months[1].value);
  const [currency, setCurrency] = useState(defaultCurrency);
  const statement = useAdminData<Statement>(`${WA_API}/statement?month=${month}&currency=${currency}`);
  // useAdminData keeps the last result while a new month loads; never show it under the new selection.
  const data = statement.data && statement.data.month === month && statement.data.currency === currency ? statement.data : null;

  return <div className="space-y-6">
    <div className="flex flex-wrap items-end gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="wa-statement-month">Month</Label>
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger id="wa-statement-month" className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>{months.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="wa-statement-currency">Currency</Label>
        <Select value={currency} onValueChange={setCurrency}>
          <SelectTrigger id="wa-statement-currency" className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>{CURRENCIES.map(code => <SelectItem key={code} value={code}>{code}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>

    {statement.error ? <LoadError message={statement.error} onRetry={() => void statement.reload()} />
      : !data ? <LoadingState label="Building the statement…" showLabel />
      : <StatementBody data={data} money={value => formatMoney(value, data.currency, 2)} onInvoiceSaved={() => void statement.reload()} />}
  </div>;
}

function StatementBody({ data, money, onInvoiceSaved }: { data: Statement; money: (value: number) => string; onInvoiceSaved: () => void }) {
  const { totals } = data;
  const metaCountGap = totals.metaMessages !== null && totals.metaMessages !== totals.messages;
  const cards: Array<{ label: string; value: string; hint?: string; warn?: boolean }> = [
    { label: "Billed messages (our records)", value: formatNumber(totals.messages, 0) },
    { label: "Billed messages (Meta's count)", value: totals.metaMessages === null ? "—" : formatNumber(totals.metaMessages, 0),
      hint: totals.metaMessages === null ? "No reconciliation data for this month yet." : metaCountGap ? "Differs from our records; see the accounts below." : undefined, warn: metaCountGap },
    { label: "Meta should bill (after volume tiers)", value: money(totals.expectedCost) },
    { label: "At list rates", value: money(totals.listCost), hint: totals.tierSavings > 0 ? `${money(totals.tierSavings)} saved by volume tiers.` : data.tierVersion ? undefined : "No volume tiers imported, so list rates are used." },
    { label: "Credits charged to wallets", value: formatNumber(totals.chargedCredits) },
  ];

  return <>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map(card => <div key={card.label} className="rounded-xl border bg-card p-4">
        <p className="text-xs text-muted-foreground">{card.label}</p>
        <p className={card.warn ? "mt-1 text-xl font-semibold tabular-nums text-amber-700 dark:text-amber-300" : "mt-1 text-xl font-semibold tabular-nums"}>{card.value}</p>
        {card.hint && <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p>}
      </div>)}
      <InvoiceDifference data={data} money={money} />
    </div>

    <InvoiceForm key={`${data.month}-${data.currency}-${data.invoice?.updatedAt ?? "none"}`} data={data} onSaved={onInvoiceSaved} />

    <Card>
      <CardHeader>
        <CardTitle className="text-base">By account</CardTitle>
        <CardDescription>Meta&apos;s count comes from its pricing analytics. A gap usually means messages sent outside this app, or a delivery report that never arrived.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.accounts.length === 0 ? <p className="text-sm text-muted-foreground">No billed messages in this month.</p> :
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Account</TableHead><TableHead className="text-right">Messages</TableHead><TableHead className="text-right">Meta&apos;s count</TableHead>
                <TableHead className="text-right">List cost</TableHead><TableHead className="text-right">Meta should bill</TableHead><TableHead className="text-right">Credits charged</TableHead>
              </TableRow></TableHeader>
              <TableBody>{data.accounts.map(account => {
                const gap = account.metaMessages !== null && account.metaMessages !== account.messages;
                return <TableRow key={account.wabaId}>
                  <TableCell>
                    <span className="block font-mono text-xs">{account.wabaId}</span>
                    {account.userId !== null && <span className="block text-xs text-muted-foreground">User {account.userId}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(account.messages, 0)}</TableCell>
                  <TableCell className={gap ? "text-right tabular-nums font-medium text-amber-700 dark:text-amber-300" : "text-right tabular-nums"}>
                    {account.metaMessages === null ? "—" : formatNumber(account.metaMessages, 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(account.listCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(account.expectedCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(account.chargedCredits)}</TableCell>
                </TableRow>;
              })}</TableBody>
            </Table>
          </div>}
      </CardContent>
    </Card>

    {data.lines.length > 0 && <Card>
      <CardHeader>
        <CardTitle className="text-base">By market and category</CardTitle>
        <CardDescription>{data.tierVersion
          ? `Utility and authentication use the volume tiers from ${data.tierVersion}, counted across all accounts as Meta does.`
          : "Every line uses list rates. Import volume tiers on the Rate cards tab to see the discount Meta applies."}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-[28rem] overflow-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Account</TableHead><TableHead>Market</TableHead><TableHead>Category</TableHead>
              <TableHead className="text-right">Messages</TableHead><TableHead className="text-right">List cost</TableHead><TableHead className="text-right">Meta should bill</TableHead>
            </TableRow></TableHeader>
            <TableBody>{data.lines.map(line => <TableRow key={`${line.wabaId}-${line.market}-${line.category}`}>
              <TableCell className="font-mono text-xs">{line.wabaId}</TableCell>
              <TableCell>{line.market}</TableCell>
              <TableCell>
                {CATEGORY_LABELS[line.category] ?? line.category}
                {line.tiered && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Tiered</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(line.messages, 0)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(line.listCost)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(line.expectedCost)}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>}
  </>;
}

function InvoiceDifference({ data, money }: { data: Statement; money: (value: number) => string }) {
  if (!data.invoice || data.difference === null) {
    return <div className="rounded-xl border border-dashed bg-card p-4">
      <p className="text-xs text-muted-foreground">Meta&apos;s invoice</p>
      <p className="mt-1 text-xl font-semibold text-muted-foreground">Not entered</p>
      <p className="mt-1 text-xs text-muted-foreground">Enter the total below to compare it with what we expect.</p>
    </div>;
  }
  const small = isSmallDifference(data.difference, data.totals.expectedCost);
  const sign = data.difference > 0 ? "+" : data.difference < 0 ? "−" : "";
  return <div className={small ? "rounded-xl border bg-card p-4" : "rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40"}>
    <p className="text-xs text-muted-foreground">Meta&apos;s invoice {money(data.invoice.amount)}</p>
    <p className={small ? "mt-1 text-xl font-semibold tabular-nums" : "mt-1 text-xl font-semibold tabular-nums text-amber-800 dark:text-amber-200"}>
      {sign}{money(Math.abs(data.difference))}
    </p>
    <p className="mt-1 text-xs text-muted-foreground">{small
      ? "Matches what we expected, within rounding."
      : data.difference > 0 ? "Meta billed more than we expected. Check the accounts with a count gap." : "Meta billed less than we expected. Check for refunds or free messages."}</p>
  </div>;
}

function InvoiceForm({ data, onSaved }: { data: Statement; onSaved: () => void }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState(data.invoice ? String(data.invoice.amount) : "");
  const [reference, setReference] = useState(data.invoice?.reference ?? "");
  const [note, setNote] = useState(data.invoice?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);

  const save = async () => {
    const value = Number(amount);
    if (amount.trim() === "" || !Number.isFinite(value) || value < 0) {
      setAmountError("Enter the invoice total, for example 1520.40.");
      return;
    }
    setSaving(true);
    try {
      await api.put(`${WA_API}/statement/invoice`, { month: data.month, currency: data.currency, amount: value, reference, note });
      toast({ title: "Invoice total saved", description: `${formatMoney(value, data.currency, 2)} for ${monthLabel(data.month)}.` });
      onSaved();
    } catch (error) {
      toast({ title: "Invoice total was not saved", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setSaving(false); }
  };

  return <Card>
    <CardHeader>
      <CardTitle className="text-base">Meta&apos;s invoice for this month</CardTitle>
      <CardDescription>Copy the WhatsApp total from Meta&apos;s invoice in Business Settings → Billing and payments. It is stored for this month and currency only.</CardDescription>
    </CardHeader>
    <CardContent>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="wa-invoice-amount">Total ({data.currency})</Label>
          <Input id="wa-invoice-amount" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setAmountError(null); }}
            aria-invalid={Boolean(amountError)} aria-describedby={amountError ? "wa-invoice-amount-error" : undefined} />
          {amountError && <p id="wa-invoice-amount-error" className="text-xs text-destructive">{amountError}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wa-invoice-reference">Invoice number</Label>
          <Input id="wa-invoice-reference" maxLength={120} value={reference} onChange={event => setReference(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wa-invoice-note">Note</Label>
          <Input id="wa-invoice-note" maxLength={500} value={note} onChange={event => setNote(event.target.value)} />
        </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} loadingText="Saving…">{data.invoice ? "Update invoice total" : "Save invoice total"}</Button>
          {data.invoice && <p className="text-xs text-muted-foreground">Last saved {formatDateTime(data.invoice.updatedAt)}.</p>}
        </div>
      </form>
      {data.totals.messages === 0 && !data.invoice && <Callout tone="info" size="sm" className="mt-3">There are no billed messages this month, so an invoice is not expected.</Callout>}
    </CardContent>
  </Card>;
}
