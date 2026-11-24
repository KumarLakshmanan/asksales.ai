"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronDown, FileText,
  Clock3, Coins, CreditCard, History, Layers, Megaphone, Plus, ReceiptText, Server, Zap,
} from "lucide-react";
import { useBillingApi } from "@/hooks/use-billing-api";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";
import { usePricingCatalog } from "@/hooks/use-pricing-catalog";
import { useSubscription } from "@/hooks/use-subscription";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import CreditActivity from "@/components/billing/CreditActivity";
import { formatCredits, formatRupees } from "../../../../../../shared/subscriptions";

type WalletData = { balance: number; rechargeRate: number };
type Recharge = {
  id: number; amount: string; amountPaid: string | null;
  currency: string | null; createdAt: string;
};
type RechargeHistory = { transactions: Recharge[]; total: number };

const RECHARGE_OPTIONS = [100, 500, 1000] as const;
const SPEND_LINKS = [
  { label: "Campaign spending", href: "/dashboard/billing/campaign-spends", icon: Megaphone },
  { label: "Provider spending", href: "/dashboard/billing/provider-spends", icon: Server },
  { label: "Daily spending", href: "/dashboard/billing/daywise-spends", icon: CalendarDays },
  { label: "Category spending", href: "/dashboard/billing/category-spends", icon: Layers },
  { label: "Credit activity", href: "/dashboard/billing/transactions", icon: History },
];

function date(value: string | null | undefined) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Not scheduled"
    : parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function LoadLines() {
  return <div role="status" aria-label="Loading billing details" className="space-y-3">
    <Skeleton className="h-6 w-44" /><Skeleton className="h-4 w-64 max-w-full" />
  </div>;
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
    <p>{message}</p><Button size="sm" variant="outline" className="mt-3" onClick={retry}>Try again</Button>
  </div>;
}

function RechargeOption({ amount, rate, enabled }: { amount: number; rate: number; enabled: boolean }) {
  const contents = <>
    <span className="block text-sm font-semibold">{formatRupees(amount)}</span>
    <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
      {rate > 0 ? "≈ " + formatCredits(amount * rate) + " credits" : "See credits at checkout"}
    </span>
  </>;
  const style = "block min-w-0 rounded-lg border border-border bg-muted/20 p-3 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return enabled
    ? <Link href={"/dashboard/billing/recharge?amount=" + amount} className={style + " transition-colors hover:border-primary/50 hover:bg-primary/5"}>{contents}</Link>
    : <div className={style + " bg-muted/30"}>{contents}</div>;
}

export default function BillingPage() {
  const api = useBillingApi();
  const billingOrganizations = useBillingOrganizations();
  const { billingScopeKey, ready } = billingOrganizations;
  // Every section below waits for `ready`. If the billing account itself
  // cannot be loaded, say so instead of showing skeletons indefinitely.
  const organizationUnavailable = billingOrganizations.unavailable;
  const subscription = useSubscription();
  const catalog = usePricingCatalog();
  const wallet = useQuery<WalletData>({
    queryKey: ["wallet", billingScopeKey],
    queryFn: () => api.get<WalletData>("/api/wallet"),
    enabled: ready,
  });
  const recharges = useQuery<RechargeHistory>({
    queryKey: ["wallet-recharge-history", billingScopeKey, { limit: 4, offset: 0 }],
    queryFn: () => api.get<RechargeHistory>("/api/wallet/transactions?type=recharge&limit=4&offset=0"),
    enabled: ready,
  });

  const state = subscription.data;
  const subscriptionPending = !ready || subscription.isPending;
  const walletPending = !ready || wallet.isPending;
  const rechargesPending = !ready || recharges.isPending;
  const current = state?.subscription;
  const hasActivePlan = (state?.access.reason === "paid" || state?.access.reason === "admin_grant") && !!current?.paidThrough && new Date(current.paidThrough).getTime() > Date.now();
  const plan = hasActivePlan ? catalog.data?.plans.find(item => item.version === current?.version && item.slug === current?.plan) : undefined;
  const canManage = state?.organization.canManageBilling === true;
  const canRecharge = canManage && state?.access.canTopUp === true;
  const charges = [...(state?.charges ?? [])].sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime()).slice(0, 3);
  const rate = wallet.data?.rechargeRate ?? 0;
  const complimentary = hasActivePlan && current?.source === "admin";
  const needsPayment = !current?.cancelAtPeriodEnd && current?.source !== "admin" && (state?.access.reason === "payment_grace" || ["pending", "halted"].includes(current?.status ?? ""));
  const autoRenew = hasActivePlan && !complimentary && !current?.cancelAtPeriodEnd && ["active", "authenticated"].includes(current?.status ?? "");
  const grace = state?.access.reason === "existing_user_grace" || state?.access.reason === "payment_grace";
  const endAt = hasActivePlan ? current?.paidThrough : grace ? state?.access.accessUntil : null;
  const endTime = endAt ? new Date(endAt).getTime() : NaN;
  const daysLeft = Number.isFinite(endTime) ? Math.max(0, Math.ceil((endTime - Date.now()) / 86_400_000)) : null;
  const renewalLabel = complimentary ? "Plan ends" : hasActivePlan && !autoRenew ? "Paid access ends" : grace ? "Grace access ends" : "Next renewal";
  const manageLabel = !canManage || complimentary ? "View subscription" : hasActivePlan ? "Manage subscription" : "Choose a plan";
  if (organizationUnavailable) return (
    <div className="space-y-5 pb-10">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Billing</h1>
      <LoadError message="Your billing account could not be loaded." retry={() => void billingOrganizations.refetch()} />
    </div>
  );

  return (
    <div className="space-y-5 pb-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Billing</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Your plan, credits and payments in one place{state?.organization.name ? " for " + state.organization.name : ""}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild className="min-h-11 rounded-lg"><Link href="/dashboard/billing/pricing">Compare plans</Link></Button>
          <Button variant="outline" asChild className="min-h-11 rounded-lg"><Link href="/dashboard/billing/analytics">Billing analytics <ArrowUpRight className="ml-1.5 h-4 w-4" aria-hidden /></Link></Button>
        </div>
      </header>

      {state?.mode === "test" && (
        <p role="status" className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
          Payment setup is in test mode. Test payments do not activate a live subscription.
        </p>
      )}

      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby="credit-balance-heading" className="relative isolate flex min-w-0 flex-col justify-between overflow-hidden rounded-2xl bg-[#2563eb] p-5 text-white sm:p-6">
          <div aria-hidden className="pointer-events-none absolute -bottom-36 -right-24 -z-10 h-80 w-80 rounded-full bg-white/[0.05]" />
          <div>
            <h2 id="credit-balance-heading" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-white/90"><Coins className="h-4 w-4" aria-hidden />Available credits</h2>
            {walletPending ? (
              <Skeleton className="mt-4 h-12 w-48 bg-white/20" />
            ) : wallet.isError ? (
              <div role="alert" className="mt-4">
                <p className="text-sm">Credit balance could not be loaded.</p>
                <Button variant="outline" className="mt-3 border-white/30 bg-white/10 text-white hover:bg-white/20" onClick={() => void wallet.refetch()}>Try again</Button>
              </div>
            ) : (
              <p className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-4xl font-semibold tabular-nums tracking-tight sm:text-5xl">{formatCredits(wallet.data?.balance ?? 0)}</span>
                <span className="text-sm text-white/90">credits</span>
              </p>
            )}
            <p className="mt-3 max-w-md text-xs leading-5 text-white/90">One shared balance across your business profiles. Plan deposits and top-ups add to it.</p>
            {(wallet.data?.balance ?? 0) < 0 && (
              <p role="status" className="mt-3 max-w-md rounded-lg bg-white/15 px-3 py-2 text-xs font-medium leading-5 text-white">
                AI work that had already finished cost {formatCredits(Math.abs(wallet.data?.balance ?? 0))} credits more than your balance. Paid features are paused until you add credits; the next top-up or plan deposit covers this first.
              </p>
            )}
            {!canManage && !subscriptionPending && state && (
              <p className="mt-3 text-xs leading-5 text-white/90">Your business owner or billing admin can add credits.</p>
            )}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-white/90">Unused credits roll over.</p>
            <div className="flex flex-wrap items-center gap-3">
              {canRecharge && (
                <Button asChild className="min-h-11 rounded-lg border-white/25 bg-white/15 text-white shadow-none hover:bg-white/25"><Link href="/dashboard/billing/recharge"><Plus aria-hidden />Add credits</Link></Button>
              )}
              <Link href="/dashboard/billing/pricing?tab=credits" className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-xs font-medium text-white underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">See credit costs<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
            </div>
          </div>
        </section>

        <section aria-labelledby="current-plan-heading" className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card">
          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm font-semibold"><CreditCard className="h-5 w-5 text-primary" aria-hidden />Current subscription</p>
              {!subscriptionPending && !subscription.isError && (
                <span className={`rounded-full border px-3 py-1 text-xs font-medium ${needsPayment || grace ? "border-warning/30 bg-warning/10 text-foreground" : hasActivePlan ? "border-primary/20 bg-primary/5 text-primary" : "border-border bg-muted/50 text-muted-foreground"}`}>
                  {complimentary ? "Admin assigned" : needsPayment ? "Payment needed" : hasActivePlan ? autoRenew ? "Active" : "Ending" : grace ? "Grace period" : current?.status === "created" ? "Pending" : "Not subscribed"}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 id="current-plan-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  {subscriptionPending ? <Skeleton className="h-8 w-44" /> : subscription.isError ? "Subscription unavailable" : hasActivePlan ? `${current!.name} plan` : "No active plan"}
                </h2>
                {!subscriptionPending && !subscription.isError && (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {hasActivePlan ? complimentary ? `${current!.term === "yearly" ? "Yearly" : "Monthly"} administrator plan · no charge` : `${current!.term === "yearly" ? "Yearly" : "Monthly"} billing${plan ? ` · ${formatRupees(current!.term === "yearly" ? plan.yearlyRupees : plan.monthlyRupees)} tax included` : ""}` : current?.status === "created" ? "Payment verification is pending. Your plan starts after the charge is confirmed." : grace ? "Choose a plan before your grace access ends." : "Choose a plan to schedule credit deposits and renewal."}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" asChild className="min-h-11 rounded-lg"><Link href="/dashboard/billing/pricing#organization-usage-heading">View usage<ArrowUpRight aria-hidden /></Link></Button>
                <Button asChild className="min-h-11 rounded-lg"><Link href="/dashboard/billing/subscription">{manageLabel}<ArrowRight aria-hidden /></Link></Button>
              </div>
            </div>
            {subscription.isError ? (
              <div className="mt-5"><LoadError message="Subscription details could not be loaded." retry={() => void subscription.refetch()} /></div>
            ) : subscriptionPending ? (
              <div className="mt-5"><LoadLines /></div>
            ) : (
              <>
                <dl className="mt-5 grid min-w-0 grid-cols-2 gap-x-4 gap-y-5 border-t border-border pt-4 sm:grid-cols-4" aria-label="Billing schedule">
                  <div className="min-w-0"><dt className="flex items-start gap-1.5 text-xs text-muted-foreground"><CalendarDays className="h-4 w-4 shrink-0 text-primary" aria-hidden />{renewalLabel}</dt><dd className="mt-2 text-sm font-semibold tabular-nums">{date(endAt)}</dd></div>
                  <div className="min-w-0"><dt className="flex items-start gap-1.5 text-xs text-muted-foreground"><CreditCard className="h-4 w-4 shrink-0 text-primary" aria-hidden />Billing cycle</dt><dd className="mt-2 text-sm font-semibold">{hasActivePlan ? current!.term === "yearly" ? "Yearly" : "Monthly" : "—"}</dd></div>
                  <div className="min-w-0"><dt className="flex items-start gap-1.5 text-xs text-muted-foreground"><Zap className="h-4 w-4 shrink-0 text-primary" aria-hidden />Auto renewal</dt><dd className="mt-2 text-sm font-semibold">{needsPayment ? "Needs attention" : autoRenew ? "On" : "Off"}</dd></div>
                  <div className="min-w-0"><dt className="flex items-start gap-1.5 text-xs text-muted-foreground"><Clock3 className="h-4 w-4 shrink-0 text-primary" aria-hidden />Next credit deposit</dt><dd className="mt-2 text-sm font-semibold tabular-nums">{hasActivePlan ? date(state?.nextDepositAt) : "Not scheduled"}</dd>{hasActivePlan && plan && <dd className="mt-1 text-xs text-muted-foreground">{formatCredits(plan.monthlyCredits)} credits</dd>}</div>
                </dl>
                <div className="mt-4 flex flex-wrap items-start gap-x-4 gap-y-2 text-xs leading-5 text-muted-foreground">
                  <p className="shrink-0 rounded-md bg-primary/5 px-2 py-1 font-medium text-primary" aria-label={daysLeft === null ? "No active billing term" : `${daysLeft} days left in the ${hasActivePlan ? "plan" : "grace"} term`}>{daysLeft === null ? "No paid term" : `${daysLeft.toLocaleString("en-IN")} days left`}</p>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p>{complimentary ? "Administrator plans do not renew automatically." : needsPayment ? "Review your payment mandate." : autoRenew ? "Managed through your payment mandate." : hasActivePlan ? "Your access lasts through the paid term." : "Auto renewal starts when you subscribe."}</p>
                    <p>{complimentary ? "Your complimentary term ends on the date above." : grace ? "Complete payment to keep access." : hasActivePlan ? current!.term === "yearly" ? "Paid yearly. Credits arrive monthly." : "Paid monthly. Unused credits roll over." : "Monthly and yearly plans available."}</p>
                  </div>
                </div>
              </>
            )}
          </div>
          {state?.pendingChange && !subscriptionPending && !subscription.isError && (
            <p className="border-t border-border bg-muted/20 px-5 py-3 text-xs leading-6 sm:px-6">Pending change to {state.pendingChange.name}. {state.pendingChange.source === "admin" ? "This administrator-assigned plan starts after the current term." : "Open your subscription to review its authorization."}</p>
          )}
        </section>
      </div>

      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <section aria-labelledby="invoices-heading" className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 id="invoices-heading" className="flex items-center gap-2 text-base font-semibold"><ReceiptText className="h-5 w-5 text-primary" aria-hidden />Invoices &amp; plan payments</h2><p className="mt-1.5 text-xs leading-5 text-muted-foreground">Verified subscription charges and available invoices.</p></div>
            <Link href="/dashboard/billing/subscription#payment-history-heading" className="inline-flex min-h-10 items-center gap-1 text-xs font-medium text-primary hover:underline">View all <ArrowUpRight className="h-4 w-4" aria-hidden /></Link>
          </div>
          <div className="mt-4 flex-1 overflow-hidden rounded-xl border border-border">
            {subscriptionPending ? <div className="p-5"><LoadLines /></div> : subscription.isError ? <div className="p-4"><LoadError message="Plan payments could not be loaded." retry={() => void subscription.refetch()} /></div> : charges.length ? charges.map(charge => (
              <div key={charge.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 last:border-0">
                <div className="flex min-w-0 items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/5 text-primary"><FileText className="h-4 w-4" aria-hidden /></span><div className="min-w-0"><p className="text-sm font-semibold">{charge.plan} · {formatRupees(charge.amountPaise / 100)}</p><p className="mt-1 text-xs text-muted-foreground">Paid {date(charge.paidAt)}{(charge.refundAmountPaise ?? 0) > 0 ? " · Refunded" : ""}</p></div></div>
                {charge.invoiceUrl ? <a href={charge.invoiceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-primary hover:underline">Invoice <ArrowUpRight className="h-4 w-4" aria-hidden /></a> : <span className="text-xs text-muted-foreground">Invoice unavailable</span>}
              </div>
            )) : (
              <div className="flex h-full min-h-36 flex-col items-center justify-center px-4 py-7 text-center"><span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/50"><FileText className="h-6 w-6 text-muted-foreground" aria-hidden /></span><p className="mt-3 text-sm font-semibold">No plan invoices yet</p><p className="mt-1 text-xs leading-5 text-muted-foreground">A verified subscription payment will appear here.</p></div>
            )}
          </div>
          <aside aria-label="Invoice help" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary/5 px-4 py-3">
            <div className="flex min-w-0 flex-1 items-start gap-2.5"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden /><p className="text-xs leading-5"><span className="block font-medium">Need an invoice or a change to billing details?</span><span className="text-muted-foreground">View your plan invoices, or contact support with your payment reference.</span></p></div>
            <Button variant="outline" asChild className="min-h-11 shrink-0 rounded-lg"><Link href="/contact">Invoice support</Link></Button>
          </aside>
        </section>

        <section aria-labelledby="recharge-heading" className="min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 id="recharge-heading" className="flex items-center gap-2 text-base font-semibold"><Zap className="h-5 w-5 text-primary" aria-hidden />Recharge credits</h2><p className="mt-1.5 text-xs leading-5 text-muted-foreground">One-time top-ups for more work between deposits.</p></div>
            {canRecharge && <Link href="/dashboard/billing/recharge" className="inline-flex min-h-10 items-center gap-1 text-xs font-medium text-primary hover:underline">Custom amount <ArrowRight className="h-4 w-4" aria-hidden /></Link>}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">{RECHARGE_OPTIONS.map(amount => <RechargeOption key={amount} amount={amount} rate={rate} enabled={canRecharge} />)}</div>
          <p className="mt-3 rounded-lg bg-primary/5 px-3 py-3 text-xs leading-5 text-muted-foreground">{subscriptionPending ? "Checking recharge availability…" : canRecharge ? "Estimates use the current rate. Confirm the final amount and credits at checkout." : !canManage && state ? "Ask the business owner or billing admin to purchase credits." : "Top-ups are available with an active paid plan."}</p>
          {!canRecharge && canManage && <Link href="/dashboard/billing/subscription" className="mt-2 inline-flex min-h-10 items-center gap-1 text-xs font-medium text-primary hover:underline">View subscription <ArrowRight className="h-4 w-4" aria-hidden /></Link>}
          <div className="mt-4 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Recent recharges</h3><Link href="/dashboard/billing/recharge-history" className="inline-flex min-h-10 items-center gap-1 text-xs font-medium text-primary hover:underline">View all recharges <ArrowRight className="h-4 w-4" aria-hidden /></Link></div>
            {rechargesPending ? <div className="mt-3"><LoadLines /></div> : recharges.isError ? <div className="mt-3"><LoadError message="Recharge history could not be loaded." retry={() => void recharges.refetch()} /></div> : recharges.data?.transactions.length ? (
              <div className="mt-1 divide-y divide-border">{recharges.data.transactions.slice(0, 3).map(item => <div key={item.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div className="min-w-0"><p className="font-medium">{item.amountPaid && Number.isFinite(Number(item.amountPaid)) ? formatRupees(Number(item.amountPaid)) + " top-up" : "Credit top-up"}</p><p className="mt-0.5 text-xs text-muted-foreground">{date(item.createdAt)}</p></div><span className="shrink-0 text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">+{formatCredits(Number(item.amount))} credits</span></div>)}</div>
            ) : <p className="mt-2 rounded-lg bg-muted/40 px-4 py-4 text-xs leading-5 text-muted-foreground">No credit top-ups yet. Plan deposits and top-ups are tracked separately.</p>}
          </div>
        </section>
      </div>

      <nav aria-label="Billing history" className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Credit activity", detail: "Track credit purchases and usage", href: "#credit-activity", icon: History },
          { label: "Plan payment history", detail: "View your subscription payments", href: "/dashboard/billing/subscription#payment-history-heading", icon: ReceiptText },
          { label: "Recharge history", detail: "See your credit top-up transactions", href: "/dashboard/billing/recharge-history", icon: CreditCard },
        ].map(({ label, detail, href, icon: Icon }) => (
          <Link key={label} href={href} aria-label={label} className="group flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Icon className="h-5 w-5 shrink-0 text-primary" aria-hidden /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{detail}</span></span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden />
          </Link>
        ))}
      </nav>

      <CreditActivity key={billingScopeKey} />

      <details open className="group rounded-xl border border-border bg-card px-5 py-4 sm:px-6">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Explore spending details<ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden /></summary>
        <p className="text-xs leading-5 text-muted-foreground">See where credits were used across activities, providers and time.</p>
        <nav aria-label="Spending details" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2">{SPEND_LINKS.map(({ label, href, icon: Icon }) => <Link key={href} href={href} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Icon className="h-4 w-4" aria-hidden />{label}<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>)}</nav>
      </details>
      <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground"><Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />Credits and billing details follow the business profile selected in the sidebar.</p>
    </div>
  );
}
