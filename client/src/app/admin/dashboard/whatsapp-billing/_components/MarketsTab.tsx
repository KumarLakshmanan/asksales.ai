"use client";

import { useMemo, useState } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadError, WA_API, errorText, readFileText, useAdminData } from "./shared";

interface Market { callingCode: string; market: string }

export function MarketsTab({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const markets = useAdminData<{ markets: Market[] }>(`${WA_API}/markets`);
  const [filter, setFilter] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const shown = useMemo(() => {
    const query = filter.trim().toLowerCase().replace(/^\+/, "");
    return (markets.data?.markets ?? []).filter(item => !query || item.market.toLowerCase().includes(query) || item.callingCode.startsWith(query));
  }, [markets.data, filter]);

  const add = async () => {
    setAdding(true);
    try {
      await api.post(`${WA_API}/markets`, { rows: [{ callingCode: code, market: name }] });
      toast({ title: "Calling code saved", description: `+${code.replace(/\D/g, "")} is billed as ${name.trim()}.` });
      setCode(""); setName("");
      await markets.reload(); onChanged();
    } catch (error) {
      toast({ title: "Calling code was not saved", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setAdding(false); }
  };

  const remove = async (callingCode: string) => {
    setDeleting(callingCode);
    try {
      await api.delete(`${WA_API}/markets/${callingCode}`);
      toast({ title: `+${callingCode} removed` });
      await markets.reload(); onChanged();
    } catch (error) {
      toast({ title: "Calling code was not removed", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setDeleting(null); }
  };

  return <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Calling codes and markets</CardTitle>
        <CardDescription>Meta prices each message by the recipient&apos;s market. The longest matching calling code wins, so +1-242 can be a different market from +1. A recipient whose code isn&apos;t listed can&apos;t be messaged from a billed account.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="wa-market-code">Calling code</Label>
            <Input id="wa-market-code" inputMode="numeric" placeholder="91" value={code} onChange={event => setCode(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-market-name">Market (as named on the rate card)</Label>
            <Input id="wa-market-name" placeholder="India" value={name} onChange={event => setName(event.target.value)} />
          </div>
          <Button onClick={() => void add()} disabled={!code.replace(/\D/g, "") || !name.trim()} loading={adding} loadingText="Saving…">Save code</Button>
        </div>
        <Input aria-label="Filter markets" placeholder="Filter by market or code" value={filter} onChange={event => setFilter(event.target.value)} className="sm:max-w-xs" />
        {markets.error ? <LoadError message={markets.error} onRetry={() => void markets.reload()} /> : markets.loading ? <LoadingState label="Loading markets…" /> :
          shown.length === 0 ? <p className="text-sm text-muted-foreground">{filter ? "No calling codes match." : "No calling codes yet."}</p> :
          <div className="max-h-[28rem] overflow-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Calling code</TableHead><TableHead>Market</TableHead><TableHead className="w-24"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
              <TableBody>{shown.map(item => <TableRow key={item.callingCode}>
                <TableCell className="tabular-nums">+{item.callingCode}</TableCell>
                <TableCell>{item.market}</TableCell>
                <TableCell><Button variant="ghost" size="sm" className="text-destructive" onClick={() => void remove(item.callingCode)} loading={deleting === item.callingCode} aria-label={`Remove +${item.callingCode}`}>Remove</Button></TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div>}
      </CardContent>
    </Card>
    <MarketsImport onSaved={() => { void markets.reload(); onChanged(); }} />
  </div>;
}

function MarketsImport({ onSaved }: { onSaved: () => void }) {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<{ rows: Market[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);

  const runPreview = async () => {
    setBusy("preview");
    try { setPreview(await api.post(`${WA_API}/markets/preview`, { csv })); }
    catch (error) { toast({ title: "The CSV could not be read", description: errorText(error, "Check the file."), variant: "destructive" }); }
    finally { setBusy(null); }
  };
  const save = async () => {
    if (!preview?.rows.length) return;
    setBusy("save");
    try {
      const result = await api.post<{ saved: number }>(`${WA_API}/markets`, { rows: preview.rows, replace });
      toast({ title: "Calling codes saved", description: `${result.saved} calling codes saved${replace ? "; the old list was replaced" : ""}.` });
      setCsv(""); setPreview(null); setReplace(false);
      onSaved();
    } catch (error) {
      toast({ title: "Calling codes were not saved", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setBusy(null); }
  };

  return <Card>
    <CardHeader>
      <CardTitle className="text-base">Import calling codes</CardTitle>
      <CardDescription>One row per calling code: the code and the market name exactly as it appears on Meta&apos;s rate card, for example &quot;91,India&quot; or &quot;1242,Rest of Latin America&quot;.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <Input aria-label="Calling codes CSV file" type="file" accept=".csv,text/csv,text/plain" onChange={async event => {
        try { setCsv(await readFileText(event.target.files?.[0])); setPreview(null); }
        catch (error) { toast({ title: "File not read", description: errorText(error, "Choose another file."), variant: "destructive" }); }
      }} />
      <Textarea aria-label="Calling codes CSV" rows={5} className="font-mono text-xs" value={csv} onChange={event => { setCsv(event.target.value); setPreview(null); }} />
      <Button variant="outline" onClick={() => void runPreview()} disabled={!csv.trim()} loading={busy === "preview"} loadingText="Reading…">Preview</Button>
      {preview && <div className="space-y-3 rounded-lg border p-4">
        <p className="text-sm font-medium">{preview.rows.length} calling codes found.</p>
        {preview.warnings.length > 0 && <Callout tone="warning" size="sm"><ul className="list-disc space-y-0.5 pl-4">{preview.warnings.slice(0, 10).map(warning => <li key={warning}>{warning}</li>)}</ul></Callout>}
        <div className="flex items-center gap-3">
          <Switch id="wa-markets-replace" checked={replace} onCheckedChange={setReplace} />
          <Label htmlFor="wa-markets-replace">Replace the whole list (codes not in this file are removed)</Label>
        </div>
        <Button onClick={() => void save()} disabled={!preview.rows.length} loading={busy === "save"} loadingText="Saving…">Save {preview.rows.length} calling codes</Button>
      </div>}
    </CardContent>
  </Card>;
}
