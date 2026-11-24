"use client";

import { useMemo, useState } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CATEGORIES, CATEGORY_LABELS, CURRENCIES, LoadError, WA_API, errorText, formatMoney, formatNumber, readFileText, useAdminData, type Overview } from "./shared";

interface RateRow { id: number; market: string; category: string; currency: string; rate: number; effective_from: string; source: string | null }
interface ParsedRate { market: string; category: string; rate: number }

const CURRENT = "current";

export function RateCardsTab({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const { toast } = useToast();
  const [currency, setCurrency] = useState("INR");
  const [version, setVersion] = useState(CURRENT);
  const versions = overview.rateCardVersions.filter(item => item.currency === currency);
  const endpoint = `${WA_API}/rate-cards?currency=${currency}${version !== CURRENT ? `&effectiveFrom=${version}` : ""}`;
  const rates = useAdminData<{ rates: RateRow[] }>(endpoint);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Pivot to one row per market with a column per category.
  const table = useMemo(() => {
    const byMarket = new Map<string, Record<string, RateRow>>();
    for (const row of rates.data?.rates ?? []) {
      const entry = byMarket.get(row.market) ?? {};
      entry[row.category] = row;
      byMarket.set(row.market, entry);
    }
    return [...byMarket.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rates.data]);

  const saveRate = async (row: RateRow) => {
    const value = edits[row.id];
    if (value === undefined || (value.trim() !== "" && Number(value) === row.rate)) return;
    if (value.trim() === "" || !(Number(value) >= 0)) {
      toast({ title: "Enter a rate of 0 or more", description: `${row.market}, ${CATEGORY_LABELS[row.category]} still uses ${row.rate}.`, variant: "destructive" });
      setEdits(current => { const next = { ...current }; delete next[row.id]; return next; });
      return;
    }
    setSavingId(row.id);
    try {
      await api.put(`${WA_API}/rate-cards/${row.id}`, { rate: Number(value) });
      setEdits(current => { const next = { ...current }; delete next[row.id]; return next; });
      toast({ title: "Rate updated", description: `${row.market}, ${CATEGORY_LABELS[row.category]}: ${value} ${currency}` });
      await rates.reload();
    } catch (error) {
      toast({ title: "Rate was not updated", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setSavingId(null); }
  };

  const deleteVersion = async () => {
    try {
      const result = await api.post<{ deleted: number }>(`${WA_API}/rate-cards/delete-version`, { currency, effectiveFrom: version });
      toast({ title: "Rate card version deleted", description: `${result.deleted} rates removed.` });
      setVersion(CURRENT);
      onChanged();
    } catch (error) {
      toast({ title: "Version was not deleted", description: errorText(error, "Try again."), variant: "destructive" });
    }
  };

  return <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rates per message</CardTitle>
        <CardDescription>Meta&apos;s list rate per delivered message, by recipient market and category. The margin and credit conversion are set on the Fees tab.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="wa-rates-currency">Currency</Label>
            <Select value={currency} onValueChange={value => { setCurrency(value); setVersion(CURRENT); }}>
              <SelectTrigger id="wa-rates-currency" className="w-full sm:w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{CURRENCIES.map(code => <SelectItem key={code} value={code}>{code}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-rates-version">Version</Label>
            <Select value={version} onValueChange={setVersion}>
              <SelectTrigger id="wa-rates-version" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={CURRENT}>In effect today</SelectItem>
                {versions.map(item => <SelectItem key={item.effectiveFrom} value={item.effectiveFrom}>From {item.effectiveFrom} ({item.markets} markets)</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {version !== CURRENT && <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>Delete this version</Button>}
        </div>
        {rates.error ? <LoadError message={rates.error} onRetry={() => void rates.reload()} /> : rates.loading ? <LoadingState label="Loading rates…" /> :
          table.length === 0 ? <p className="text-sm text-muted-foreground">No {currency} rates{version === CURRENT ? " are in effect today" : " in this version"}. Import Meta&apos;s rate card below.</p> :
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Market</TableHead>
                {CATEGORIES.map(category => <TableHead key={category} className="text-right">{CATEGORY_LABELS[category]}</TableHead>)}
              </TableRow></TableHeader>
              <TableBody>{table.map(([market, byCategory]) => <TableRow key={market}>
                <TableCell className="font-medium">{market}</TableCell>
                {CATEGORIES.map(category => {
                  const row = byCategory[category];
                  if (!row) return <TableCell key={category} className="text-right text-amber-700 dark:text-amber-300">Missing</TableCell>;
                  const value = edits[row.id] ?? String(row.rate);
                  return <TableCell key={category} className="text-right">
                    <Input aria-label={`${market} ${CATEGORY_LABELS[category]} rate`} inputMode="decimal" className="ml-auto h-8 w-28 text-right tabular-nums"
                      value={value} disabled={savingId === row.id}
                      onChange={event => setEdits(current => ({ ...current, [row.id]: event.target.value }))}
                      onBlur={() => void saveRate(row)}
                      onKeyDown={event => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
                    {version === CURRENT && <span className="sr-only">Effective from {row.effective_from}</span>}
                  </TableCell>;
                })}
              </TableRow>)}</TableBody>
            </Table>
            <p className="mt-2 text-xs text-muted-foreground">Edit a rate and press Enter or move away to save it.</p>
          </div>}
      </CardContent>
    </Card>

    {/* Keyed by currency so a switch never shows, or deletes, the other currency's tiers. */}
    <VolumeTiersCard key={currency} currency={currency} onChanged={onChanged} />

    <RateCardImport defaultCurrency={currency} onSaved={() => { onChanged(); void rates.reload(); }} />

    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the {currency} rate card from {version}?</AlertDialogTitle>
          <AlertDialogDescription>All its rates are removed. Messages then use the previous version, or are blocked if there is none. Charges already made keep their rates.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={() => void deleteVersion()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete version</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}

interface TierRow { id: number; market: string; category: string; volumeFrom: number; volumeTo: number | null; rate: number }
interface ParsedTier { market: string; category: "utility" | "authentication"; volumeFrom: number; volumeTo: number | null; rate: number }

/** Tiers are stored as "after N messages"; Meta shows the first message of a tier as N+1. */
const formatVolume = (from: number, to: number | null) =>
  to === null ? `Over ${formatNumber(from, 0)}` : `${formatNumber(from === 0 ? 1 : from + 1, 0)} – ${formatNumber(to, 0)}`;

/**
 * Meta's monthly volume tiers for utility and authentication. They only feed the
 * monthly statement (what Meta should bill); wallets are always charged list rates.
 */
function VolumeTiersCard({ currency, onChanged }: { currency: string; onChanged: () => void }) {
  const { toast } = useToast();
  const [version, setVersion] = useState(CURRENT);
  const tiers = useAdminData<{ effectiveFrom: string | null; versions: Array<{ effectiveFrom: string; tiers: number; markets: number }>; tiers: TierRow[] }>(
    `${WA_API}/tiers?currency=${currency}${version !== CURRENT ? `&effectiveFrom=${version}` : ""}`);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const shown = tiers.data?.effectiveFrom ?? null;

  const deleteVersion = async () => {
    if (!shown) return;
    try {
      await api.post(`${WA_API}/tiers/delete-version`, { currency, effectiveFrom: shown });
      toast({ title: "Tier version deleted", description: `${currency} tiers from ${shown} were removed.` });
      setVersion(CURRENT);
      onChanged();
      void tiers.reload();
    } catch (error) {
      toast({ title: "Tier version was not deleted", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setConfirmDelete(false); }
  };

  return <Card>
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
      <div className="space-y-1.5">
        <CardTitle className="text-base">Volume tiers ({currency})</CardTitle>
        <CardDescription>Meta lowers utility and authentication rates as a month&apos;s volume grows, per market. Tiers only change the monthly statement&apos;s expected bill; customers are always charged list rates.</CardDescription>
      </div>
      <Button variant="outline" size="sm" className="shrink-0 self-start" onClick={() => setImporting(value => !value)} aria-expanded={importing}>
        {importing ? "Close import" : "Import tiers"}
      </Button>
    </CardHeader>
    <CardContent className="space-y-4">
      {tiers.error && !tiers.data ? <LoadError message={tiers.error} onRetry={() => void tiers.reload()} />
        : !tiers.data ? <LoadingState label="Loading volume tiers…" />
        : <>
          {tiers.data.versions.length > 0 && <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="wa-tier-version">Version</Label>
              <Select value={version} onValueChange={setVersion}>
                <SelectTrigger id="wa-tier-version" className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={CURRENT}>In effect today</SelectItem>
                  {tiers.data.versions.map(item => <SelectItem key={item.effectiveFrom} value={item.effectiveFrom}>
                    From {item.effectiveFrom} · {item.markets} {item.markets === 1 ? "market" : "markets"}
                  </SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {shown && <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={tiers.loading || Boolean(tiers.error)} onClick={() => setConfirmDelete(true)}>Delete this version</Button>}
          </div>}
          {tiers.data.tiers.length === 0
            ? <p className="text-sm text-muted-foreground">{tiers.data.versions.length
              ? "No tiers are in effect yet; the saved versions start later. Pick one above to see it."
              : "No tiers imported. The monthly statement uses list rates until you import Meta's tier file."}</p>
            : <div className="max-h-80 overflow-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Market</TableHead><TableHead>Category</TableHead><TableHead>Messages in the month</TableHead><TableHead className="text-right">Rate</TableHead>
                </TableRow></TableHeader>
                <TableBody>{tiers.data.tiers.map(row => <TableRow key={row.id}>
                  <TableCell>{row.market}</TableCell>
                  <TableCell>{CATEGORY_LABELS[row.category] ?? row.category}</TableCell>
                  <TableCell className="tabular-nums">{formatVolume(row.volumeFrom, row.volumeTo)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(row.rate, currency)}</TableCell>
                </TableRow>)}</TableBody>
              </Table>
            </div>}
          {shown && tiers.data.tiers.length > 0 && <p className="text-xs text-muted-foreground">Showing tiers from {shown}.</p>}
        </>}

      {importing && <TierImport currency={currency} onSaved={() => { setImporting(false); setVersion(CURRENT); onChanged(); void tiers.reload(); }} />}
    </CardContent>

    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the {currency} volume tiers from {shown}?</AlertDialogTitle>
          <AlertDialogDescription>The monthly statement then uses the previous tier version, or list rates if there is none. Wallet charges are not affected.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep them</AlertDialogCancel>
          <AlertDialogAction onClick={() => void deleteVersion()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete tiers</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}

function TierImport({ currency, onSaved }: { currency: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  // Meta's tiers count per calendar month, so they start on the 1st.
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 8) + "01");
  const [preview, setPreview] = useState<{ rows: ParsedTier[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);

  const runPreview = async () => {
    setBusy("preview");
    try { setPreview(await api.post(`${WA_API}/tiers/preview`, { csv })); }
    catch (error) { toast({ title: "The CSV could not be read", description: errorText(error, "Check the file."), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const save = async () => {
    if (!preview?.rows.length) return;
    setBusy("save");
    try {
      const result = await api.post<{ saved: number }>(`${WA_API}/tiers`, { currency, effectiveFrom, rows: preview.rows, source: "Meta volume tiers" });
      toast({ title: "Volume tiers saved", description: `${result.saved} ${currency} tiers take effect on ${effectiveFrom}.` });
      onSaved();
    } catch (error) {
      toast({ title: "Volume tiers were not saved", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setBusy(null); }
  };

  return <div className="space-y-4 rounded-lg border p-4">
    <p className="text-sm text-muted-foreground">Upload Meta&apos;s volume-tier CSV in {currency}, or a file with Market, Category, Tier (such as 0:750000) and Rate columns. Nothing is saved until you confirm.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="wa-tier-file">Tier CSV file</Label>
        <Input id="wa-tier-file" type="file" accept=".csv,text/csv,text/plain" onChange={async event => {
          try { setCsv(await readFileText(event.target.files?.[0])); setPreview(null); }
          catch (error) { toast({ title: "File not read", description: errorText(error, "Choose another file."), variant: "destructive" }); }
        }} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="wa-tier-date">Takes effect on</Label>
        <Input id="wa-tier-date" type="date" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} />
      </div>
    </div>
    <div className="space-y-1.5">
      <Label htmlFor="wa-tier-csv">Or paste the tier CSV</Label>
      <Textarea id="wa-tier-csv" rows={5} className="font-mono text-xs" value={csv} onChange={event => { setCsv(event.target.value); setPreview(null); }} />
    </div>
    <Button variant="outline" onClick={() => void runPreview()} disabled={!csv.trim()} loading={busy === "preview"} loadingText="Reading…">Preview</Button>
    {preview && <div className="space-y-3">
      <p className="text-sm font-medium">{preview.rows.length} tiers for {new Set(preview.rows.map(row => row.market)).size} markets found.</p>
      {preview.warnings.length > 0 && <Callout tone="warning" size="sm">
        <ul className="list-disc space-y-0.5 pl-4">{preview.warnings.slice(0, 12).map(warning => <li key={warning}>{warning}</li>)}</ul>
        {preview.warnings.length > 12 && <p className="mt-1">…and {preview.warnings.length - 12} more.</p>}
      </Callout>}
      {preview.rows.length > 0 && <div className="max-h-56 overflow-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Market</TableHead><TableHead>Category</TableHead><TableHead>Messages in the month</TableHead><TableHead className="text-right">Rate</TableHead></TableRow></TableHeader>
          <TableBody>{preview.rows.slice(0, 40).map(row => <TableRow key={`${row.market}-${row.category}-${row.volumeFrom}`}>
            <TableCell>{row.market}</TableCell><TableCell>{CATEGORY_LABELS[row.category]}</TableCell>
            <TableCell className="tabular-nums">{formatVolume(row.volumeFrom, row.volumeTo)}</TableCell>
            <TableCell className="text-right tabular-nums">{row.rate}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {preview.rows.length > 40 && <p className="mt-2 text-xs text-muted-foreground">Showing the first 40 tiers.</p>}
      </div>}
      <Callout tone="info" size="sm">Saving replaces every {currency} tier already saved for {effectiveFrom || "that date"}.</Callout>
      <Button onClick={() => void save()} disabled={!preview.rows.length || !effectiveFrom} loading={busy === "save"} loadingText="Saving…">Save {preview.rows.length} tiers</Button>
    </div>}
  </div>;
}

function nextQuarterStart(): string {
  const now = new Date();
  const month = Math.floor(now.getUTCMonth() / 3) * 3 + 3;
  return new Date(Date.UTC(now.getUTCFullYear() + (month >= 12 ? 1 : 0), month % 12, 1)).toISOString().slice(0, 10);
}

function RateCardImport({ defaultCurrency, onSaved }: { defaultCurrency: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState("Meta rate card");
  const [preview, setPreview] = useState<{ rows: ParsedRate[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);

  const runPreview = async () => {
    setBusy("preview");
    try { setPreview(await api.post(`${WA_API}/rate-cards/preview`, { csv })); }
    catch (error) { toast({ title: "The CSV could not be read", description: errorText(error, "Check the file."), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const save = async () => {
    if (!preview?.rows.length) return;
    setBusy("save");
    try {
      const result = await api.post<{ saved: number }>(`${WA_API}/rate-cards`, { currency, effectiveFrom, source, rows: preview.rows });
      toast({ title: "Rate card saved", description: `${result.saved} ${currency} rates take effect on ${effectiveFrom}.` });
      setCsv(""); setPreview(null);
      onSaved();
    } catch (error) {
      toast({ title: "Rate card was not saved", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setBusy(null); }
  };

  const markets = new Set(preview?.rows.map(row => row.market)).size;

  return <Card>
    <CardHeader>
      <CardTitle className="text-base">Import a rate card</CardTitle>
      <CardDescription>Upload Meta&apos;s rate-card CSV for one currency (a Market column and Marketing, Utility, Authentication and Service columns), or a three-column file: market, category, rate. Nothing is saved until you confirm.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="wa-rate-file">CSV file</Label>
        <Input id="wa-rate-file" type="file" accept=".csv,text/csv,text/plain" onChange={async event => {
          try { setCsv(await readFileText(event.target.files?.[0])); setPreview(null); }
          catch (error) { toast({ title: "File not read", description: errorText(error, "Choose another file."), variant: "destructive" }); }
        }} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="wa-rate-csv">Or paste the CSV</Label>
        <Textarea id="wa-rate-csv" rows={6} className="font-mono text-xs" value={csv} onChange={event => { setCsv(event.target.value); setPreview(null); }} />
      </div>
      <Button variant="outline" onClick={() => void runPreview()} disabled={!csv.trim()} loading={busy === "preview"} loadingText="Reading…">Preview</Button>

      {preview && <div className="space-y-4 rounded-lg border p-4">
        <p className="text-sm font-medium">{preview.rows.length} rates for {markets} markets found.</p>
        {preview.warnings.length > 0 && <Callout tone="warning" size="sm">
          <ul className="list-disc space-y-0.5 pl-4">{preview.warnings.slice(0, 12).map(warning => <li key={warning}>{warning}</li>)}</ul>
          {preview.warnings.length > 12 && <p className="mt-1">…and {preview.warnings.length - 12} more.</p>}
        </Callout>}
        {preview.rows.length > 0 && <div className="max-h-64 overflow-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Market</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Rate</TableHead></TableRow></TableHeader>
            <TableBody>{preview.rows.slice(0, 40).map(row => <TableRow key={`${row.market}-${row.category}`}>
              <TableCell>{row.market}</TableCell><TableCell>{CATEGORY_LABELS[row.category]}</TableCell><TableCell className="text-right tabular-nums">{row.rate}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
          {preview.rows.length > 40 && <p className="mt-2 text-xs text-muted-foreground">Showing the first 40 rates.</p>}
        </div>}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="wa-import-currency">Currency of these rates</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id="wa-import-currency"><SelectValue /></SelectTrigger>
              <SelectContent>{CURRENCIES.map(code => <SelectItem key={code} value={code}>{code}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-import-date">Takes effect on</Label>
            <Input id="wa-import-date" type="date" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} />
            <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => setEffectiveFrom(nextQuarterStart())}>Next quarter ({nextQuarterStart()})</button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-import-source">Source note</Label>
            <Input id="wa-import-source" maxLength={200} value={source} onChange={event => setSource(event.target.value)} />
          </div>
        </div>
        <Callout tone="info" size="sm">Saving replaces any {currency} rates already saved for the same markets on {effectiveFrom || "that date"}.</Callout>
        <Button onClick={() => void save()} disabled={!preview.rows.length || !effectiveFrom} loading={busy === "save"} loadingText="Saving…">Save {preview.rows.length} rates</Button>
      </div>}
    </CardContent>
  </Card>;
}
