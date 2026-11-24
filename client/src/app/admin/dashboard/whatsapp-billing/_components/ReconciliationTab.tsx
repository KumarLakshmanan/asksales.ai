"use client";

import { useState } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORY_LABELS, LoadError, WA_API, errorText, formatNumber, useAdminData } from "./shared";

interface ReconciliationRow {
  wabaId: string; day: string; category: string; metaVolume: number; metaCost: number; currency: string;
  ledgerVolume: number; ledgerCost: number; fetchedAt: string;
}

/** Same rule as the server alert: more than 2 messages and more than 2% apart. */
const isVariance = (meta: number, ledger: number) => {
  const diff = Math.abs(meta - ledger);
  return diff > 2 && diff > Math.max(meta, ledger) * 0.02;
};

export function ReconciliationTab({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const data = useAdminData<{ rows: ReconciliationRow[] }>(`${WA_API}/reconciliation?days=30`);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<{ wabas: number; variances: string[]; errors: string[] } | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const result = await api.post<{ wabas: number; variances: string[]; errors: string[] }>(`${WA_API}/reconciliation/run`);
      setLastRun(result);
      await data.reload(); onChanged();
    } catch (error) {
      toast({ title: "Reconciliation did not run", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setRunning(false); }
  };

  return <Card>
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <CardTitle className="text-base">Reconciliation with Meta</CardTitle>
        <CardDescription className="mt-1.5">Billable messages Meta counted per account, day and category, beside the messages we charged. Meta doesn&apos;t report cost for accounts on our credit line, so its count is priced at our rate. Runs every 6 hours; today and yesterday may still change.</CardDescription>
      </div>
      <Button variant="outline" onClick={() => void run()} loading={running} loadingText="Checking with Meta…">Run now</Button>
    </CardHeader>
    <CardContent className="space-y-4">
      {lastRun && <Callout tone={lastRun.errors.length || lastRun.variances.length ? "warning" : "success"} size="sm">
        Checked {lastRun.wabas} account(s). {lastRun.variances.length ? `${lastRun.variances.length} difference(s) found.` : "No differences in settled days."}
        {lastRun.errors.length > 0 && <ul className="mt-1 list-disc pl-4">{lastRun.errors.slice(0, 5).map(error => <li key={error}>{error}</li>)}</ul>}
      </Callout>}
      {data.error ? <LoadError message={data.error} onRetry={() => void data.reload()} /> : data.loading ? <LoadingState label="Loading reconciliation…" /> :
        !data.data?.rows.length ? <p className="text-sm text-muted-foreground">No reconciliation yet. It needs the credit line settings and at least one account billed through us.</p> :
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Day</TableHead><TableHead>Account</TableHead><TableHead>Category</TableHead>
              <TableHead className="text-right">Meta count</TableHead><TableHead className="text-right">Our count</TableHead>
              <TableHead className="text-right">Meta cost</TableHead><TableHead className="text-right">Our cost</TableHead>
            </TableRow></TableHeader>
            <TableBody>{data.data.rows.map(row => {
              const variance = isVariance(row.metaVolume, row.ledgerVolume);
              return <TableRow key={`${row.wabaId}-${row.day}-${row.category}`} className={variance ? "bg-amber-500/10" : undefined}>
                <TableCell className="tabular-nums">{row.day}</TableCell>
                <TableCell className="tabular-nums">{row.wabaId}</TableCell>
                <TableCell>{CATEGORY_LABELS[row.category] ?? row.category}</TableCell>
                <TableCell className="text-right tabular-nums">{row.metaVolume}</TableCell>
                <TableCell className="text-right tabular-nums">{row.ledgerVolume}{variance && <span className="sr-only"> (differs from Meta)</span>}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(row.metaCost, 4)} {row.currency}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(row.ledgerCost, 4)} {row.currency}</TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
        </div>}
    </CardContent>
  </Card>;
}
