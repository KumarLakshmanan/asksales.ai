"use client";

import { useEffect, useState } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Callout } from "@/components/ui/callout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, Circle, ArrowRight } from "lucide-react";
import { CURRENCIES, WA_API, errorText, formatDateTime, formatMoney, formatNumber, type CreditLineSettings, type Overview, type TabId } from "./shared";

export function OverviewTab({ overview, onChanged, onNavigate }: { overview: Overview; onChanged: () => void; onNavigate: (tab: TabId) => void }) {
  const { counts, rateCardVersions } = overview;
  const metaCost = overview.metaCostThisMonth.length
    ? overview.metaCostThisMonth.map(row => formatMoney(row.cost, row.currency, 2)).join(" · ")
    : formatMoney(0, overview.settings.currency, 2);
  const stats = [
    { label: "Accounts billed through us", value: formatNumber(counts.platformAccounts, 0), tab: "accounts" as TabId },
    { label: "Charges needing review", value: formatNumber(counts.needsReview, 0), warn: counts.needsReview > 0, tab: "review" as TabId },
    { label: "Waiting for Meta's delivery report", value: formatNumber(counts.awaitingDelivery, 0) },
    { label: "Meta's cost this month (list rates)", value: metaCost, tab: "statement" as TabId },
    { label: "Credits charged to wallets this month", value: formatNumber(counts.creditsThisMonth) },
    { label: "Last checked against Meta", value: formatDateTime(counts.lastReconciledAt), tab: "reconciliation" as TabId },
  ];
  return <div className="space-y-6">
    {overview.paymentIssues.length > 0 && <Callout tone="danger" title={`Meta is refusing messages on ${overview.paymentIssues.length === 1 ? "1 account" : `${overview.paymentIssues.length} accounts`} for a payment problem`}>
      <ul className="mt-1 space-y-1">
        {overview.paymentIssues.map(issue => <li key={issue.wabaId}>
          <span className="font-medium">{issue.businessName || `WABA ${issue.wabaId}`}</span>
          <span className="text-muted-foreground"> · since {formatDateTime(issue.since)}{issue.detail ? ` · ${issue.detail}` : ""}</span>
        </li>)}
      </ul>
      <p className="mt-2">Check the credit line in Meta Business Settings (billing and payments). Messages keep failing until it is fixed; this clears by itself once Meta bills a message again.</p>
    </Callout>}

    <SetupChecklist overview={overview} onNavigate={onNavigate} />

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {stats.map(stat => {
        const body = <>
          <p className="text-xs text-muted-foreground">{stat.label}</p>
          <p className={stat.warn ? "mt-1 text-xl font-semibold tabular-nums text-amber-700 dark:text-amber-300" : "mt-1 text-xl font-semibold tabular-nums"}>{stat.value}</p>
        </>;
        return stat.tab
          ? <button key={stat.label} type="button" onClick={() => onNavigate(stat.tab!)}
              className="rounded-xl border bg-card p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</button>
          : <div key={stat.label} className="rounded-xl border bg-card p-4">{body}</div>;
      })}
    </div>

    <CreditLineSettingsCard settings={overview.settings} onSaved={onChanged} />

    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rate card versions</CardTitle>
        <CardDescription>Meta changes rates only at the start of a quarter. Import the new card before it takes effect; the newest version on or before today is used.</CardDescription>
      </CardHeader>
      <CardContent>
        {rateCardVersions.length === 0 ? <p className="text-sm text-muted-foreground">No rate card has been imported. Messages on billed accounts are blocked until one is.</p> :
          <Table>
            <TableHeader><TableRow><TableHead>Currency</TableHead><TableHead>Takes effect</TableHead><TableHead className="text-right">Markets</TableHead><TableHead className="text-right">Rates</TableHead></TableRow></TableHeader>
            <TableBody>{rateCardVersions.map(version => <TableRow key={`${version.currency}-${version.effectiveFrom}`}>
              <TableCell>{version.currency}</TableCell>
              <TableCell>
                {version.effectiveFrom}
                {version.effectiveFrom > new Date().toISOString().slice(0, 10) && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Upcoming</span>}
                {!version.complete && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">Missing a category</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{version.markets}</TableCell>
              <TableCell className="text-right tabular-nums">{version.rates}</TableCell>
            </TableRow>)}</TableBody>
          </Table>}
      </CardContent>
    </Card>
  </div>;
}

/** What still has to be set up before billed messages can go out, in the order it is needed. */
function SetupChecklist({ overview, onNavigate }: { overview: Overview; onNavigate: (tab: TabId) => void }) {
  const { settings, counts, rateCardVersions, fees, tierVersions } = overview;
  const today = new Date().toISOString().slice(0, 10);
  const current = rateCardVersions.find(version => version.currency === settings.currency && version.effectiveFrom <= today);
  const steps: Array<{ label: string; detail: string; done: boolean; tab?: TabId }> = [
    { label: "Map calling codes to Meta's markets", detail: counts.markets ? `${counts.markets} calling codes mapped.` : "Import Meta's market list.", done: counts.markets > 1, tab: "markets" },
    { label: `Import a complete ${settings.currency} rate card`, detail: current ? `${current.markets} markets from ${current.effectiveFrom}${current.complete ? "" : "; a category is missing"}.` : "Billed messages are refused until there is one.", done: Boolean(current?.complete), tab: "rates" },
    { label: "Set the margins and the platform fee", detail: fees.marginsSet ? `${fees.marginsSet} of 4 margins set; platform fee ${fees.platformFee ?? 0} credits.` : `All margins are 0%; platform fee ${fees.platformFee ?? 0} credits.`, done: fees.marginsSet > 0, tab: "fees" },
    { label: "Save the Meta credit line and system token", detail: settings.creditLineId && settings.systemTokenConfigured ? `Credit line ${settings.creditLineId}.` : "Enter both below, then check them with Meta.", done: Boolean(settings.creditLineId && settings.systemTokenConfigured) },
    { label: "Switch billing on for this server", detail: settings.featureEnabled ? "WHATSAPP_PLATFORM_BILLING_ENABLED is on." : "Set WHATSAPP_PLATFORM_BILLING_ENABLED=true and redeploy.", done: settings.featureEnabled },
    { label: "Attach accounts", detail: counts.platformAccounts ? `${counts.platformAccounts} billed through us${settings.attachOnSignup ? "; new signups attach automatically" : ""}.` : settings.attachOnSignup ? "New signups attach automatically." : "Attach existing accounts, or turn on attach to new signups.", done: counts.platformAccounts > 0 || settings.attachOnSignup, tab: "accounts" },
  ];
  const optional = tierVersions.some(version => version.currency === settings.currency)
    ? null : "Optional: import Meta's volume tiers on the Rate cards tab, so the monthly statement shows what Meta should actually bill.";
  const remaining = steps.filter(step => !step.done).length;
  return <Card>
    <CardHeader>
      <CardTitle className="text-base">{remaining ? `Setup: ${steps.length - remaining} of ${steps.length} done` : "Setup complete"}</CardTitle>
      <CardDescription>{remaining ? "Work through these in order." : "Billed messages are priced, reserved and settled automatically."}</CardDescription>
    </CardHeader>
    <CardContent>
      <ol className="divide-y rounded-lg border">
        {steps.map(step => <li key={step.label} className="flex items-center gap-3 p-3">
          {step.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-label="Done" /> : <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-label="To do" />}
          <div className="min-w-0 flex-1">
            <p className={step.done ? "text-sm text-muted-foreground" : "text-sm font-medium"}>{step.label}</p>
            <p className="text-xs text-muted-foreground">{step.detail}</p>
          </div>
          {!step.done && step.tab && <Button variant="ghost" size="sm" className="shrink-0 gap-1" onClick={() => onNavigate(step.tab!)}>Open<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Button>}
        </li>)}
      </ol>
      {optional && <p className="mt-3 text-xs text-muted-foreground">{optional}</p>}
    </CardContent>
  </Card>;
}

function CreditLineSettingsCard({ settings, onSaved }: { settings: CreditLineSettings; onSaved: () => void }) {
  const { toast } = useToast();
  const [creditLineId, setCreditLineId] = useState(settings.creditLineId);
  const [systemToken, setSystemToken] = useState("");
  const [currency, setCurrency] = useState(settings.currency);
  const [attachOnSignup, setAttachOnSignup] = useState(settings.attachOnSignup);
  const [monthlyLimit, setMonthlyLimit] = useState(settings.monthlyLimit === null ? "" : String(settings.monthlyLimit));
  const [alertPercent, setAlertPercent] = useState(String(settings.alertPercent));
  const [businessId, setBusinessId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; creditLines: string[]; error?: string } | null>(null);

  useEffect(() => {
    setCreditLineId(settings.creditLineId); setCurrency(settings.currency); setAttachOnSignup(settings.attachOnSignup);
    setMonthlyLimit(settings.monthlyLimit === null ? "" : String(settings.monthlyLimit)); setAlertPercent(String(settings.alertPercent));
  }, [settings]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`${WA_API}/credit-line`, {
        creditLineId: creditLineId.trim(), currency, attachOnSignup,
        monthlyLimit: monthlyLimit.trim() === "" ? null : Number(monthlyLimit), alertPercent: Number(alertPercent),
        ...(systemToken.trim() ? { systemToken: systemToken.trim() } : {}),
      });
      setSystemToken("");
      toast({ title: "Credit line settings saved" });
      onSaved();
    } catch (error) {
      toast({ title: "Settings were not saved", description: errorText(error, "Check the values and try again."), variant: "destructive" });
    } finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try { setTestResult(await api.post(`${WA_API}/credit-line/test`, { businessId: businessId.trim() })); }
    catch (error) { setTestResult({ ok: false, creditLines: [], error: errorText(error, "The check could not run.") }); }
    finally { setTesting(false); }
  };

  return <Card>
    <CardHeader>
      <CardTitle className="text-base">Meta credit line</CardTitle>
      <CardDescription>Our Solution Partner credit line pays Meta for customers&apos; WhatsApp messages. The system user token is stored encrypted and never shown again.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {!settings.metaAppConfigured && <Callout tone="warning">Save the Meta app (App ID and secret) on the Meta integration settings first. These settings are stored with it.</Callout>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="wa-credit-line-id">Credit line ID</Label>
          <Input id="wa-credit-line-id" inputMode="numeric" value={creditLineId} onChange={event => setCreditLineId(event.target.value)} />
          <p className="text-xs text-muted-foreground">The ID from GET /&#123;business_id&#125;/extendedcredits.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wa-system-token">System user token</Label>
          <Input id="wa-system-token" type="password" autoComplete="off" value={systemToken} onChange={event => setSystemToken(event.target.value)}
            placeholder={settings.systemTokenConfigured ? "Saved. Enter a new token to replace it" : ""} />
          <p className="text-xs text-muted-foreground">Needs business_management and whatsapp_business_management.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wa-credit-currency">Currency Meta bills in</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="wa-credit-currency"><SelectValue /></SelectTrigger>
            <SelectContent>{CURRENCIES.map(code => <SelectItem key={code} value={code}>{code}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Set on each WABA when the credit line is attached. It cannot be changed afterwards.</p>
        </div>
        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div>
            <Label htmlFor="wa-attach-signup">Attach to new signups</Label>
            <p className="mt-1 text-xs text-muted-foreground">When a customer connects WhatsApp, attach our credit line and bill their messages to their wallet.</p>
          </div>
          <Switch id="wa-attach-signup" checked={attachOnSignup} onCheckedChange={setAttachOnSignup} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wa-monthly-limit">Monthly spend alert limit ({currency})</Label>
          <Input id="wa-monthly-limit" inputMode="decimal" value={monthlyLimit} onChange={event => setMonthlyLimit(event.target.value)} placeholder="No limit" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wa-alert-percent">Alert at (% of the limit)</Label>
          <Input id="wa-alert-percent" inputMode="numeric" value={alertPercent} onChange={event => setAlertPercent(event.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} loading={saving} loadingText="Saving…">Save settings</Button>
      </div>
      <div className="space-y-2 rounded-lg border p-3">
        <Label htmlFor="wa-business-id">Check the saved token and credit line</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id="wa-business-id" inputMode="numeric" placeholder="Our Meta business portfolio ID" value={businessId} onChange={event => setBusinessId(event.target.value)} />
          <Button variant="outline" onClick={() => void test()} loading={testing} loadingText="Checking…" disabled={!businessId.trim()}>Check with Meta</Button>
        </div>
        {testResult && <Callout tone={testResult.ok ? "success" : "danger"} size="sm">
          {testResult.ok ? `The token works and the credit line was found. Credit lines visible: ${testResult.creditLines.join(", ")}.` : testResult.error || "The check failed."}
        </Callout>}
      </div>
    </CardContent>
  </Card>;
}
