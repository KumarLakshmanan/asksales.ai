"use client";

import { useId } from 'react';
import Link from 'next/link';
import { ArrowRight, Building2, Check, Mail, Rocket, Zap } from 'lucide-react';
import { FaFacebookMessenger, FaInstagram, FaWhatsapp } from 'react-icons/fa';
import { useHydrated } from '@/hooks/use-hydrated';
import { LIMIT_DEFINITIONS, formatLimit, formatPlanLimit, formatRupees, formatCredits, type BillingTerm, type PlanSlug, type SubscriptionPlan } from '../../../../shared/subscriptions';

export function BillingTermToggle({ value, onChange, plans, disabled = false }: { value: BillingTerm; onChange: (value: BillingTerm) => void; plans?: SubscriptionPlan[]; disabled?: boolean }) {
  const hydrated = useHydrated();
  const id = useId();
  const discounts = plans?.map(plan => Math.round((1 - plan.yearlyRupees / (plan.monthlyRupees * 12)) * 100)) ?? [];
  const savings = discounts.length && Math.max(...discounts) > 0 ? `${new Set(discounts).size > 1 ? 'Up to ' : 'Save '}${Math.max(...discounts)}%` : null;
  return (
    <fieldset disabled={!hydrated || disabled} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/60 p-1.5">
      <legend className="sr-only">Billing term</legend>
      {(['monthly', 'yearly'] as const).map(term => (
        <label key={term} className={`relative flex min-h-11 cursor-pointer items-center gap-2 rounded-full px-5 text-sm font-medium transition-colors motion-reduce:transition-none sm:px-7 ${value === term ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
          <input type="radio" name={`billing-term-${id}`} value={term} checked={value === term} disabled={!hydrated || disabled} onChange={() => { if (hydrated && !disabled) onChange(term); }} className="peer sr-only" />
          <span className="pointer-events-none absolute inset-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2" />
          {term === 'monthly' ? 'Monthly' : 'Yearly'}
          {term === 'yearly' && savings && <span className={`rounded-full px-2 py-0.5 text-[11px] ${value === term ? 'bg-background/15 text-primary-foreground' : 'bg-primary/10 text-primary'}`}>{savings}</span>}
        </label>
      ))}
    </fieldset>
  );
}

type PlanCardsProps = {
  plans: SubscriptionPlan[];
  term: BillingTerm;
  selected?: PlanSlug;
  current?: { plan: string; version: number; term: BillingTerm; cancelAtPeriodEnd?: boolean } | null;
  onSelect?: (plan: PlanSlug) => void;
  disabled?: boolean;
  canManageBilling?: boolean;
  hrefBase?: string;
  layout?: 'cards' | 'comparison';
};

export function PlanCards({ plans, term, selected, current, onSelect, disabled = false, canManageBilling = true, hrefBase = '/subscribe' }: PlanCardsProps) {
  const orderedPlans = [...plans].sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));
  return (
    <div className="grid items-stretch gap-6 md:grid-cols-2 xl:grid-cols-3" data-testid="plan-cards">
      {orderedPlans.map(plan => {
        const active = selected === plan.slug;
        const isCurrent = current?.plan === plan.slug && current.version === plan.version && current.term === term && !current.cancelAtPeriodEnd;
        const Icon = plan.slug === 'starter' ? Rocket : plan.slug === 'growth' ? Zap : Building2;
        const savings = plan.monthlyRupees * 12 - plan.yearlyRupees;
        const monthly = term === 'yearly' ? plan.yearlyRupees / 12 : plan.monthlyRupees;
        const actionStyle = `inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${plan.featured ? 'bg-primary text-primary-foreground hover:bg-primary/90' : active ? 'border border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border border-border bg-card hover:border-primary/40 hover:bg-muted'}`;
        const action = isCurrent ? 'Current plan' : !canManageBilling ? 'Ask your business owner' : active ? 'Selected' : `Choose ${plan.name}`;
        return (
          <article key={`${plan.version}-${plan.slug}`} aria-label={`${plan.name} plan`} className={`relative flex min-w-0 flex-col rounded-[22px] border p-6 sm:p-8 ${plan.featured ? 'border-primary bg-primary/[0.035] ring-1 ring-primary' : 'border-border bg-card'}`}>
            {plan.featured && <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground">Recommended</span>}
            <div className="flex items-center justify-between gap-3 pt-2">
              <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ${plan.featured ? 'bg-primary/10 text-primary' : 'bg-muted text-primary'}`}><Icon className="h-7 w-7" strokeWidth={1.65} aria-hidden /></div>
              {isCurrent && <span className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="h-4 w-4" aria-hidden />Current plan</span>}
            </div>
            <h3 className="mt-6 text-2xl font-semibold tracking-tight">{plan.name}</h3>
            <p className="mt-2 min-h-12 text-sm leading-6 text-muted-foreground">{plan.description}</p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <div className="flex -space-x-1.5" aria-label="WhatsApp, Instagram, Messenger and email supported">
                {([{ Icon: FaWhatsapp, label: 'WhatsApp', color: 'text-[#25D366]' }, { Icon: FaInstagram, label: 'Instagram', color: 'text-[#E4405F]' }, { Icon: FaFacebookMessenger, label: 'Messenger', color: 'text-[#0084FF]' }, { Icon: Mail, label: 'Email', color: 'text-primary' }]).map(({ Icon: ChannelIcon, label, color }) => <span key={label} title={label} className={`flex h-8 w-8 items-center justify-center rounded-full border-2 border-card bg-background ${color}`}><ChannelIcon className="h-4 w-4" aria-hidden /></span>)}
              </div>
              <span className="text-xs font-medium text-muted-foreground">{formatLimit('channelAccounts', plan.limits.channelAccounts)} connected accounts</span>
            </div>
            <div className="mt-8">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-4xl font-semibold tabular-nums tracking-[-0.055em] sm:text-5xl">{formatRupees(monthly)}</span><span className="text-sm text-muted-foreground">/ month</span></p>
              <p className="mt-3 min-h-10 text-xs leading-5 text-muted-foreground">{term === 'yearly' ? <>{formatRupees(plan.yearlyRupees)} billed yearly · tax included<br />{savings > 0 ? `Save ${formatRupees(savings)} a year` : 'Credits deposited every month'}</> : <>Billed monthly · tax included<br />Credits deposited every month</>}</p>
            </div>
            <div className="my-6 border-y border-border py-5">
              {onSelect || isCurrent || !canManageBilling ? <button type="button" disabled={disabled || isCurrent || !canManageBilling} aria-pressed={active} aria-label={`${action}${active ? `: ${plan.name}` : ''}`} onClick={() => onSelect?.(plan.slug)} className={actionStyle}>{action}{isCurrent || active ? <Check className="h-4 w-4" aria-hidden /> : canManageBilling && <ArrowRight className="h-4 w-4" aria-hidden />}</button> : <Link href={`${hrefBase}?plan=${encodeURIComponent(plan.slug)}&term=${term}&version=${plan.version}`} className={actionStyle}>{action}<ArrowRight className="h-4 w-4" aria-hidden /></Link>}
            </div>
            <ul className="space-y-3.5 text-sm leading-5">
              <li className="flex items-start gap-3"><span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Check className="h-3.5 w-3.5" aria-hidden /></span><span><strong className="font-semibold tabular-nums text-primary">{formatCredits(plan.monthlyCredits)}</strong> credits / month</span></li>
              {LIMIT_DEFINITIONS.filter(({ key }) => key !== 'workspaces').map(({ key, label }) => <li className="flex items-start gap-3" key={key}><span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Check className="h-3.5 w-3.5" aria-hidden /></span><span><strong className="font-semibold tabular-nums text-primary">{formatPlanLimit(plan, key)}</strong> {label.replace(/^[A-Z](?=[a-z])/, letter => letter.toLowerCase())}</span></li>)}
            </ul>
            <p className="mt-7 border-t border-border pt-5 text-xs leading-5 text-muted-foreground">Shared across the owner’s business profiles.<br />Unused credits roll over.{plan.version < 2 && <><br />File storage follows your account’s legacy allowance. View Billing usage for your current limit.</>}</p>
          </article>
        );
      })}
    </div>
  );
}

export function PlanComparison({ plans }: { plans: SubscriptionPlan[] }) {
  const rows = [
    { label: 'Monthly total · tax included', value: (plan: SubscriptionPlan) => formatRupees(plan.monthlyRupees) },
    { label: 'Yearly total · tax included', value: (plan: SubscriptionPlan) => formatRupees(plan.yearlyRupees) },
    { label: 'Credits deposited monthly', value: (plan: SubscriptionPlan) => formatCredits(plan.monthlyCredits) },
    ...LIMIT_DEFINITIONS.filter(({ key }) => key !== 'workspaces').map(({ key, label }) => ({ label, value: (plan: SubscriptionPlan) => formatPlanLimit(plan, key) })),
    { label: 'Unused credit rollover', value: () => 'Included' },
    { label: 'Credit top-ups while subscribed', value: () => 'Available' },
  ];
  return <section id="plan-comparison" aria-labelledby="comparison-heading" className="scroll-mt-24">
    <h2 id="comparison-heading" className="text-2xl font-semibold tracking-tight">Compare every allowance</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">One set of limits across the owner’s business profiles. Each profile is one workspace.</p>
    <div className="mt-7 hidden overflow-hidden rounded-[14px] border border-border md:block"><table className="w-full table-fixed text-left text-sm"><caption className="sr-only">Business plan prices, credits and capacity limits</caption><thead className="bg-muted/40"><tr><th scope="col" className="w-[34%] px-5 py-5 font-medium">Included in your plan</th>{plans.map(plan => <th scope="col" className={`px-4 py-5 font-semibold ${plan.featured ? 'bg-primary/5 text-primary' : ''}`} key={plan.slug}>{plan.name}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.label} className="border-t border-border"><th scope="row" className="px-5 py-4 font-normal text-muted-foreground">{row.label}</th>{plans.map(plan => <td key={plan.slug} className={`px-4 py-4 tabular-nums ${plan.featured ? 'bg-primary/[0.025] font-medium' : ''}`}>{row.value(plan)}</td>)}</tr>)}</tbody></table></div>
    <div className="mt-6 space-y-3 md:hidden">{plans.map(plan => <details key={plan.slug} className="rounded-xl border border-border bg-card p-5"><summary className="min-h-7 cursor-pointer font-semibold">{plan.name}{plan.featured && <span className="ml-3 text-xs font-medium text-primary">Recommended</span>}</summary><dl className="mt-5 space-y-3">{rows.map(row => <div className="flex justify-between gap-4 text-sm" key={row.label}><dt className="text-muted-foreground">{row.label}</dt><dd className="shrink-0 text-right font-medium tabular-nums">{row.value(plan)}</dd></div>)}</dl></details>)}</div>
  </section>;
}

export function CatalogLoading() {
  return <div role="status" aria-label="Loading plans" className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(index => <div key={index} className="h-[680px] rounded-[22px] border border-border bg-muted/30 p-8"><div className="h-14 w-14 rounded-2xl bg-muted" /><div className="mt-8 h-6 w-32 rounded bg-muted" /><div className="mt-10 h-12 w-44 rounded bg-muted" /><div className="mt-10 space-y-5">{[0, 1, 2, 3, 4, 5].map(row => <div key={row} className="h-4 rounded bg-muted" />)}</div></div>)}</div>;
}
export function CatalogError({ retry }: { retry: () => void }) {
  return <div role="alert" className="rounded-[14px] border border-destructive/30 bg-card p-7"><h2 className="text-lg font-semibold">Plans could not be loaded</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Refresh to see the current prices and allowances.</p><button type="button" onClick={retry} className="mt-4 min-h-11 rounded-[10px] border border-border px-5 text-sm font-medium hover:bg-muted focus-visible:outline-primary">Try again</button></div>;
}
