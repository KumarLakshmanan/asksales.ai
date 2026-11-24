"use client";
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Wallet } from 'lucide-react';
import { Callout } from '@/components/ui/callout';
import { useBillingApi } from "@/hooks/use-billing-api";
import { useSubscription } from '@/hooks/use-subscription';
import { useBillingOrganizations } from '@/hooks/use-billing-organizations';
import { LIMIT_DEFINITIONS, formatLimit, formatCredits } from '../../../../shared/subscriptions';

export default function OrganizationUsage() {
  const api = useBillingApi();
  const organizations = useBillingOrganizations();
  const subscription = useSubscription();
  const wallet = useQuery({ queryKey: ['wallet', organizations.billingScopeKey], queryFn: () => api.get<{ balance: number }>('/api/wallet'), enabled: organizations.ready });
  const state = subscription.data;
  if (organizations.unavailable || subscription.isError || wallet.isError) return <Callout tone="danger" actions={<button className="min-h-11 text-sm text-primary underline" onClick={() => { if (organizations.unavailable) void organizations.refetch(); else { void subscription.refetch(); void wallet.refetch(); } }}>Try again</button>}>Business usage could not be loaded.</Callout>;
  if (!state || !wallet.data) return <div role="status" className="h-32 rounded-[14px] border border-border bg-muted/30 p-6 text-sm text-muted-foreground">Loading shared usage…</div>;
  return <section aria-labelledby="organization-usage-heading" className="rounded-[14px] border border-border bg-card">
    <div className="flex flex-wrap items-center justify-between gap-5 p-5 sm:p-7"><div><p className="text-xs text-muted-foreground">Owner’s shared credit wallet</p><h2 id="organization-usage-heading" className="mt-2 flex items-baseline gap-2 text-2xl font-semibold tabular-nums tracking-tight"><Wallet className="h-5 w-5 self-center text-primary" aria-hidden />{formatCredits(Number(wallet.data.balance))}<span className="text-sm font-normal text-muted-foreground">credits available</span></h2></div><div className="text-sm"><p className="font-medium">{state.subscription ? `${state.subscription.name} · ${state.subscription.term}` : 'No active subscription'}</p><p className="mt-1 text-xs text-muted-foreground">{state.nextDepositAt ? `Next deposit ${new Date(state.nextDepositAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'Next deposit appears after a verified payment'}</p></div><Link href="/dashboard/billing/subscription" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary hover:underline">{state.organization.canManageBilling ? 'Manage subscription' : 'View subscription'}<ArrowUpRight className="h-4 w-4" aria-hidden /></Link></div>
    <details className="border-t border-border" open><summary className="cursor-pointer px-5 py-4 text-sm font-medium sm:px-7">Capacity across the owner’s business profiles</summary><div className="grid gap-x-8 gap-y-6 px-5 pb-7 sm:grid-cols-2 sm:px-7 xl:grid-cols-3">{LIMIT_DEFINITIONS.filter(({ key }) => key !== 'workspaces').map(({ key, label }) => {
      const used = state.entitlements.usage[key] ?? 0;
      const limit = state.entitlements.limits[key];
      const over = limit !== null && used > limit;
      const percent = limit !== null && limit > 0 ? Math.min(100, used / limit * 100) : limit === 0 && used > 0 ? 100 : 0;
      return <div key={key}><div className="flex flex-wrap justify-between gap-2 text-xs"><span className="text-muted-foreground">{label}</span><span className={`font-medium tabular-nums ${over ? 'text-destructive' : ''}`}>{formatLimit(key, used)} / {formatLimit(key, limit)}</span></div><div role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} {...(limit !== null ? { 'aria-valuemax': Math.max(limit, used) } : {})} aria-valuetext={`${formatLimit(key, used)} used of ${formatLimit(key, limit)}`} className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div style={{ width: `${percent}%` }} className={`h-full rounded-full ${over ? 'bg-destructive' : 'bg-primary/75'}`} /></div>{over && <p className="mt-1.5 text-[11px] text-destructive">Above this plan’s allowance</p>}</div>;
    })}</div><p className="border-t border-border px-5 py-4 text-xs leading-5 text-muted-foreground sm:px-7">Capacity measures current resources and does not reset monthly. {state.entitlements.enforced ? 'Existing data is retained if you exceed a limit; reduce usage or upgrade to add more.' : 'Usage is being measured. New plan capacity enforcement is not active for this account.'}</p></details>
  </section>;
}
