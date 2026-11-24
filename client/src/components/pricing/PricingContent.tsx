"use client";
import { useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUpRight, Check, ChevronDown } from 'lucide-react';
import { type BillingTerm } from '../../../../shared/subscriptions';
import { usePricingCatalog } from '@/hooks/use-pricing-catalog';
import { BillingTermToggle, PlanCards, PlanComparison, CatalogLoading, CatalogError } from './PlanCards';
import PlanFinder from './PlanFinder';

const features = ['Lead discovery & enrichment', 'Content & creative tools', 'Outreach & follow-ups', 'Performance marketing', 'CRM & pipeline', 'Knowledge & support tools'];
const faqs = [
  ['What changes between plans?', 'Your monthly credit deposit and shared capacity: business profiles, contacts, storage, connected channels, assistants, staff, support agents, teams, automations and knowledge sources. Every plan includes the AskSales toolkit, subject to connected-provider requirements and platform availability.'],
  ['How are credits shared?', 'The owner’s business profiles share one subscription and credit wallet. Your business profile is your workspace. Staff use the credits available to the business they are invited to; they can only access businesses they have joined.'],
  ['How does yearly billing work?', 'Pay the listed yearly total upfront. Credits arrive in twelve monthly deposits, beginning after a verified plan payment. Deposits follow your monthly anniversary, adjusted for shorter months. The price selector shows the monthly equivalent and the full yearly total.'],
  ['Do unused credits expire?', 'Unused credits roll over indefinitely in the owner’s shared wallet. If the subscription ends, the balance stays in the wallet and can be used again after resubscribing.'],
  ['Do capacity limits reset every month?', 'No. Capacity measures the resources you currently have, such as saved contacts, stored files and active automations. Removing or deactivating a resource releases its allowance where applicable. Messages, conversations, AI generation and automation executions consume credits.'],
  ['How are team members and support agents counted?', 'Staff seats include the owner, active staff and outstanding invitations. Enabled support-agent logins have a separate allowance. Internal AI workers are not counted as support-agent seats.'],
  ['Can I buy extra credits?', 'Yes. Business owners and billing admins with an active paid plan can purchase one-time top-ups in Billing. Top-ups use the recharge rate shown at purchase; that rate does not change the plan’s monthly credit deposit.'],
  ['Can I change plans or cancel?', 'Plan and billing-term changes take effect at your next renewal, after you authorize the replacement payment mandate. Cancellation stops future renewals; access and remaining yearly credit deposits continue through your paid term. If usage exceeds a new plan’s allowance, existing resources are retained and increases are blocked until usage is within the limit.'],
  ['Are taxes included?', 'Yes. Listed INR subscription prices include applicable tax. Any available tax breakdown appears on the verified payment invoice. Advertising spend is charged separately by the connected advertising provider.'],
  ['Is there a free trial?', 'No. New accounts complete setup and admin approval before subscribing. Existing customers retain their eligibility for the initial subscription grace period. A failed renewal has a seven-day recovery period; no credits are deposited for an unpaid period.'],
] as const;
const container = 'mx-auto w-full max-w-[1440px] px-5 sm:px-8 lg:px-12';

export default function PricingContent() {
  const [term, setTerm] = useState<BillingTerm>('monthly');
  const catalog = usePricingCatalog();
  const plans = catalog.data?.plans ?? [];
  return <>
    <section className={`${container} pb-16 pt-32 sm:pb-20 sm:pt-40`}>
      <div className="mx-auto max-w-3xl text-center"><p className="text-sm font-medium text-primary">AskSales pricing</p><h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.1] tracking-[-0.045em] sm:text-5xl">Choose your plan.</h1><p className="mx-auto mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">One plan and credit wallet for your business profiles. Give your staff the room they need to grow.</p></div>
      <div id="plans" className="mt-8 flex scroll-mt-28 flex-col items-center gap-5 text-center"><BillingTermToggle value={term} onChange={setTerm} plans={plans} /><p aria-live="polite" className="text-xs text-muted-foreground">{term === 'monthly' ? 'Monthly payments. Monthly credit deposits.' : 'One yearly payment. Twelve monthly credit deposits.'}</p><a href="#plan-comparison" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline">Compare all features & limits<ArrowUpRight className="h-4 w-4" aria-hidden /></a></div>
      <div className="mt-9 sm:mt-12">{catalog.isLoading ? <CatalogLoading /> : catalog.isError || !plans.length ? <CatalogError retry={() => void catalog.refetch()} /> : <PlanCards plans={plans} term={term} />}</div>
      <p className="mt-6 text-center text-xs leading-6 text-muted-foreground">All prices in INR, tax included. Allowances are shared across the owner’s business profiles.</p>
      <a href="#plan-finder" className="mx-auto mt-3 flex min-h-11 w-fit items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline">Help me find my starting point<ArrowDown className="h-4 w-4" aria-hidden /></a>
    </section>
    <section className={`${container} pb-16 sm:pb-20`} aria-labelledby="included-heading"><div className="border-y border-border py-8"><h2 id="included-heading" className="text-lg font-semibold">The full toolkit, at every level.</h2><ul className="mt-6 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">{features.map(feature => <li key={feature} className="flex items-center gap-3"><Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />{feature}</li>)}</ul><p className="mt-6 text-xs leading-6 text-muted-foreground">Connect your channels, choose your providers and share capacity across your businesses. Staff only see the businesses they have joined.</p></div></section>
    {!!plans.length && <PlanFinder term={term} plans={plans} />}
    {!!plans.length && <div className={`${container} py-16 lg:py-24`}><PlanComparison plans={plans} /><div className="mt-8 border-l-2 border-primary pl-5 text-sm leading-7"><h3 className="font-semibold">Credits cover the work. Allowances cover the resources.</h3><p className="mt-2 max-w-3xl text-muted-foreground">Lead operations, content generation and outreach consume credits at their current rates. Storage, contacts and active tools use the capacity included in your plan. See operation costs in <Link href="/dashboard/billing/pricing?tab=credits" className="font-medium text-primary underline underline-offset-4">Billing’s credit costs</Link>.</p></div></div>}
    <section aria-labelledby="faq-heading" className="border-t border-border bg-muted/20 py-16 sm:py-24"><div className={`${container} grid gap-10 lg:grid-cols-[.7fr_1.3fr]`}><div><p className="text-sm font-medium text-primary">A few useful details</p><h2 id="faq-heading" className="mt-4 text-3xl font-semibold tracking-tight">Before you choose.</h2><p className="mt-5 max-w-sm text-sm leading-7 text-muted-foreground">Understand shared credits, capacity and what happens when your needs change.</p><Link href="/contact" className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">Contact us</Link></div><div className="divide-y divide-border border-y border-border">{faqs.map(([question, answer]) => <details key={question} className="group py-5"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-5 text-base font-medium focus-visible:outline-primary [&::-webkit-details-marker]:hidden">{question}<ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden /></summary><p className="max-w-3xl pb-2 pt-3 text-sm leading-7 text-muted-foreground">{answer}</p></details>)}</div></div></section>
  </>;
}
