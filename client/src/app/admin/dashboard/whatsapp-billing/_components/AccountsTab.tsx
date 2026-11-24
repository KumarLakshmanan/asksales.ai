"use client";

import { useState } from "react";
import api, { ApiError } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CURRENCIES, LoadError, WA_API, errorText, formatDateTime, formatNumber, useAdminData } from "./shared";

interface BillingAccount {
  wabaId: string; billingMode: "platform" | "customer_own"; currency: string; dailySpendCapCredits: number | null;
  allocationConfigId: string | null; creditLineStatus: "none" | "attached" | "failed" | "revoked"; creditLineError: string | null;
  attachedAt: string | null; revokedAt: string | null; userId: number | null; businessProfileId: number | null;
  ownerEmail: string | null; businessName: string | null; note: string | null; updatedAt: string;
  creditsThisMonth: number; needsReview: number;
  paymentIssueAt: string | null; paymentIssueDetail: string | null;
}

const CREDIT_LINE_LABELS: Record<BillingAccount["creditLineStatus"], string> = {
  none: "Not attached", attached: "Attached", failed: "Attach failed", revoked: "Revoked",
};

type Draft = { wabaId: string; billingMode: BillingAccount["billingMode"]; currency: string; cap: string; note: string; isNew: boolean };

export function AccountsTab({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const accounts = useAdminData<{ accounts: BillingAccount[] }>(`${WA_API}/accounts`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [incompleteWarning, setIncompleteWarning] = useState<string | null>(null);
  const [pending, setPending] = useState<{ wabaId: string; action: "attach" | "revoke" } | null>(null);
  const [acting, setActing] = useState(false);

  const openEdit = (account: BillingAccount) => setDraft({
    wabaId: account.wabaId, billingMode: account.billingMode, currency: account.currency,
    cap: account.dailySpendCapCredits === null ? "" : String(account.dailySpendCapCredits), note: account.note ?? "", isNew: false,
  });

  const save = async (force = false) => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.put(`${WA_API}/accounts/${encodeURIComponent(draft.wabaId.trim())}`, {
        billingMode: draft.billingMode, currency: draft.currency, note: draft.note.trim() || null,
        dailySpendCapCredits: draft.cap.trim() === "" ? null : Number(draft.cap), ...(force ? { force: true } : {}),
      });
      toast({ title: "Billing account saved", description: draft.billingMode === "platform" ? "Messages from this account are now charged to the customer's wallet." : "The customer pays Meta directly for this account." });
      setDraft(null); setIncompleteWarning(null);
      await accounts.reload(); onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setIncompleteWarning(error.message);
      else toast({ title: "Billing account was not saved", description: errorText(error, "Try again."), variant: "destructive" });
    } finally { setSaving(false); }
  };

  const runAction = async () => {
    if (!pending) return;
    setActing(true);
    try {
      const result = await api.post<{ status: string; error?: string; verified?: boolean }>(`${WA_API}/accounts/${pending.wabaId}/${pending.action}`);
      toast({
        title: pending.action === "attach" ? "Credit line attached" : result.status === "skipped" ? "Account returned to customer billing" : "Credit line revoked",
        description: pending.action === "attach" && result.verified === false ? "Meta accepted it, but the account's funding source doesn't match yet. Check again later." : undefined,
      });
    } catch (error) {
      toast({ title: pending.action === "attach" ? "Credit line was not attached" : "Credit line was not revoked", description: errorText(error, "Try again."), variant: "destructive" });
    } finally {
      setActing(false); setPending(null);
      await accounts.reload(); onChanged();
    }
  };

  return <Card>
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <CardTitle className="text-base">WhatsApp Business Accounts</CardTitle>
        <CardDescription className="mt-1.5">Accounts set to &quot;We pay Meta&quot; have each delivered message charged to the owner&apos;s wallet. Set a daily limit to cap what one account can spend.</CardDescription>
      </div>
      <Button variant="outline" onClick={() => setDraft({ wabaId: "", billingMode: "platform", currency: "INR", cap: "", note: "", isNew: true })}>Add account</Button>
    </CardHeader>
    <CardContent>
      {accounts.error ? <LoadError message={accounts.error} onRetry={() => void accounts.reload()} /> : accounts.loading ? <LoadingState label="Loading accounts…" /> :
        !accounts.data?.accounts.length ? <p className="text-sm text-muted-foreground">No accounts yet. They appear here when a customer connects WhatsApp with &quot;Attach to new signups&quot; on, or when you add one.</p> :
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Account</TableHead><TableHead>Who pays Meta</TableHead><TableHead>Credit line</TableHead>
              <TableHead className="text-right">Credits this month</TableHead><TableHead className="text-right">Daily limit</TableHead><TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>{accounts.data.accounts.map(account => <TableRow key={account.wabaId}>
              <TableCell>
                <p className="font-medium tabular-nums">{account.wabaId}</p>
                <p className="text-xs text-muted-foreground">{account.businessName || account.ownerEmail || "No business linked"}{account.businessName && account.ownerEmail ? ` · ${account.ownerEmail}` : ""}</p>
                {account.note && <p className="text-xs text-muted-foreground">{account.note}</p>}
              </TableCell>
              <TableCell>
                <Badge variant={account.billingMode === "platform" ? "default" : "secondary"}>{account.billingMode === "platform" ? "We pay Meta" : "Customer pays Meta"}</Badge>
                <p className="mt-1 text-xs text-muted-foreground">{account.currency}</p>
              </TableCell>
              <TableCell>
                <p className={account.creditLineStatus === "failed" ? "text-sm text-destructive" : "text-sm"}>{CREDIT_LINE_LABELS[account.creditLineStatus]}</p>
                <p className="text-xs text-muted-foreground">{account.creditLineStatus === "attached" ? formatDateTime(account.attachedAt) : account.creditLineStatus === "revoked" ? formatDateTime(account.revokedAt) : ""}</p>
                {account.creditLineError && <p className="max-w-xs text-xs text-amber-700 dark:text-amber-300">{account.creditLineError}</p>}
                {account.paymentIssueAt && <div className="mt-1 max-w-xs">
                  <Badge variant="destructive">Payment problem</Badge>
                  <p className="mt-1 text-xs text-destructive">Meta refused messages since {formatDateTime(account.paymentIssueAt)}{account.paymentIssueDetail ? `: ${account.paymentIssueDetail}` : ""}.</p>
                </div>}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(account.creditsThisMonth)}
                {account.needsReview > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">{account.needsReview} to review</p>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{account.dailySpendCapCredits === null ? "None" : formatNumber(account.dailySpendCapCredits)}</TableCell>
              <TableCell>
                <div className="flex flex-wrap justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(account)}>Edit</Button>
                  {account.creditLineStatus !== "attached"
                    ? <Button variant="ghost" size="sm" onClick={() => setPending({ wabaId: account.wabaId, action: "attach" })}>Attach credit line</Button>
                    : <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setPending({ wabaId: account.wabaId, action: "revoke" })}>Revoke</Button>}
                </div>
              </TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>}
    </CardContent>

    <Dialog open={Boolean(draft)} onOpenChange={open => { if (!open) { setDraft(null); setIncompleteWarning(null); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{draft?.isNew ? "Add a WhatsApp Business Account" : `Account ${draft?.wabaId}`}</DialogTitle>
          <DialogDescription>Changing who pays Meta here only changes how AskSales charges wallets. Attach or revoke the credit line separately so Meta bills the same way.</DialogDescription>
        </DialogHeader>
        {draft && <div className="space-y-4">
          {draft.isNew && <div className="space-y-1.5">
            <Label htmlFor="wa-account-id">WhatsApp Business Account ID</Label>
            <Input id="wa-account-id" inputMode="numeric" value={draft.wabaId} onChange={event => setDraft({ ...draft, wabaId: event.target.value })} />
          </div>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wa-account-mode">Who pays Meta</Label>
              <Select value={draft.billingMode} onValueChange={value => setDraft({ ...draft, billingMode: value as Draft["billingMode"] })}>
                <SelectTrigger id="wa-account-mode"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="platform">We pay Meta (charge the wallet)</SelectItem><SelectItem value="customer_own">Customer pays Meta</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wa-account-currency">Meta billing currency</Label>
              <Select value={draft.currency} onValueChange={value => setDraft({ ...draft, currency: value })}>
                <SelectTrigger id="wa-account-currency"><SelectValue /></SelectTrigger>
                <SelectContent>{CURRENCIES.map(code => <SelectItem key={code} value={code}>{code}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-account-cap">Daily limit (credits)</Label>
            <Input id="wa-account-cap" inputMode="decimal" placeholder="No limit" value={draft.cap} onChange={event => setDraft({ ...draft, cap: event.target.value })} />
            <p className="text-xs text-muted-foreground">Sends are refused once the day&apos;s WhatsApp message charges reach this amount.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-account-note">Note</Label>
            <Textarea id="wa-account-note" rows={2} maxLength={500} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} />
          </div>
          {incompleteWarning && <Callout tone="warning">{incompleteWarning} Save anyway only if you mean to block this account&apos;s messages until rates are imported.</Callout>}
        </div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => { setDraft(null); setIncompleteWarning(null); }}>Cancel</Button>
          {incompleteWarning
            ? <Button variant="destructive" onClick={() => void save(true)} loading={saving}>Save anyway</Button>
            : <Button onClick={() => void save()} loading={saving} loadingText="Saving…" disabled={!draft?.wabaId.trim()}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={Boolean(pending)} onOpenChange={open => { if (!open && !acting) setPending(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.action === "attach" ? `Attach our credit line to ${pending?.wabaId}?` : `Revoke our credit line from ${pending?.wabaId}?`}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.action === "attach"
            ? "Meta will bill this account's messages to our credit line, and each delivered message is charged to the owner's wallet. The credit line can't be swapped for another one later."
            : "Meta stops billing this account to us and the customer must add their own payment method in Meta. Meta applies a revoke to all of this customer's accounts shared with us."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={acting}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={event => { event.preventDefault(); void runAction(); }} disabled={acting}
            className={pending?.action === "revoke" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}>
            {acting ? "Working…" : pending?.action === "attach" ? "Attach credit line" : "Revoke credit line"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
