"use client";

import { useState } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORY_LABELS, LoadError, WA_API, errorText, formatDateTime, formatNumber, useAdminData } from "./shared";

interface Charge {
  id: number; ownerEmail: string | null; wabaId: string; phoneNumberId: string; wamid: string | null; messageKind: string; templateName: string | null;
  expectedCategory: string; metaCategory: string | null; metaPricingType: string | null; metaBillable: boolean | null; market: string | null;
  currency: string; reservedRate: number; reservedCredits: number; settledRate: number | null; chargedCredits: number | null;
  status: string; reviewReason: string | null; createdAt: string; settledAt: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  needs_review: "Needs review", reserved: "Reserved", sent: "Sent, awaiting delivery", settled: "Charged", refunded: "Refunded", all: "All",
};

export function ReviewTab({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const [status, setStatus] = useState("needs_review");
  const charges = useAdminData<{ charges: Charge[] }>(`${WA_API}/charges?status=${status}&limit=100`);
  const [busy, setBusy] = useState<string | null>(null);

  const resolve = async (charge: Charge, action: "refund" | "charge") => {
    setBusy(`${charge.id}-${action}`);
    try {
      await api.post(`${WA_API}/charges/${charge.id}/resolve`, { action });
      toast({ title: action === "refund" ? "Credits returned to the wallet" : "Charge confirmed", description: `${formatNumber(charge.reservedCredits)} credits for message ${charge.id}.` });
      await charges.reload(); onChanged();
    } catch (error) {
      toast({ title: "The charge was not resolved", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setBusy(null); }
  };

  return <Card>
    <CardHeader>
      <CardTitle className="text-base">Message charges</CardTitle>
      <CardDescription>A charge needs review when Meta never sent a delivery report, the send outcome was unclear, or Meta billed a category we have no rate for. Refund returns the held credits; Charge keeps them.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="wa-charge-status">Show</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger id="wa-charge-status" className="w-full sm:w-64"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(STATUS_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {charges.error ? <LoadError message={charges.error} onRetry={() => void charges.reload()} /> : charges.loading ? <LoadingState label="Loading charges…" /> :
        !charges.data?.charges.length ? <p className="text-sm text-muted-foreground">{status === "needs_review" ? "Nothing needs review." : "No charges with this status."}</p> :
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Message</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Credits</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>{charges.data.charges.map(charge => <TableRow key={charge.id}>
              <TableCell>
                <p className="font-medium">#{charge.id} · {charge.templateName || charge.messageKind}</p>
                <p className="text-xs text-muted-foreground">{charge.ownerEmail || "Unknown owner"} · WABA {charge.wabaId}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(charge.createdAt)}{charge.market ? ` · ${charge.market}` : ""}</p>
              </TableCell>
              <TableCell>
                <p className="text-sm">{CATEGORY_LABELS[charge.metaCategory ?? charge.expectedCategory] ?? charge.metaCategory ?? charge.expectedCategory}</p>
                {charge.metaCategory && charge.metaCategory !== charge.expectedCategory && <p className="text-xs text-amber-700 dark:text-amber-300">Expected {CATEGORY_LABELS[charge.expectedCategory] ?? charge.expectedCategory}</p>}
                {charge.metaPricingType && <p className="text-xs text-muted-foreground">{charge.metaPricingType.replace(/_/g, " ")}</p>}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <p>{formatNumber(charge.chargedCredits ?? charge.reservedCredits)}</p>
                <p className="text-xs text-muted-foreground">{formatNumber(charge.settledRate ?? charge.reservedRate, 6)} {charge.currency}</p>
              </TableCell>
              <TableCell>
                <p className="text-sm">{STATUS_LABELS[charge.status] ?? charge.status}</p>
                {charge.reviewReason && <p className="max-w-xs text-xs text-muted-foreground">{charge.reviewReason}</p>}
              </TableCell>
              <TableCell>
                {charge.status === "needs_review" && <div className="flex justify-end gap-1">
                  <Button variant="outline" size="sm" onClick={() => void resolve(charge, "refund")} loading={busy === `${charge.id}-refund`} disabled={Boolean(busy)}>Refund</Button>
                  <Button size="sm" onClick={() => void resolve(charge, "charge")} loading={busy === `${charge.id}-charge`} disabled={Boolean(busy)}>Charge</Button>
                </div>}
              </TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>}
    </CardContent>
  </Card>;
}
