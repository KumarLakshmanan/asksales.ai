"use client";
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { usePricingCatalog } from '@/hooks/use-pricing-catalog';
import { useSubscription } from '@/hooks/use-subscription';
import { BillingTermToggle, PlanCards, PlanComparison, CatalogLoading, CatalogError } from '@/components/pricing/PlanCards';
import OrganizationUsage from '@/components/billing/OrganizationUsage';
import CreditCosts from '@/components/billing/CreditCosts';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { BillingTerm } from '../../../../../../../shared/subscriptions';
import { LoadingState } from '@/components/ui/loading-state';

function PricingWorkspace() {
  const search = useSearchParams();
  const [term, setTerm] = useState<BillingTerm>('monthly');
  const catalog = usePricingCatalog();
  const subscription = useSubscription();
  const plans = catalog.data?.plans ?? [];
  const paidSubscription = subscription.data?.subscription;
  const current = paidSubscription?.paidThrough && new Date(paidSubscription.paidThrough).getTime() > Date.now() ? paidSubscription : null;
  return <div className="space-y-7"><header><h1 className="text-3xl font-semibold tracking-tight">Pricing</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Compare business capacity and the cost of the work you run.</p></header><Tabs defaultValue={search.get('tab') === 'credits' ? 'credits' : 'plans'}><TabsList aria-label="Pricing views"><TabsTrigger value="plans" className="min-h-11">Plans & limits</TabsTrigger><TabsTrigger value="credits" className="min-h-11">Credit costs</TabsTrigger></TabsList><TabsContent value="plans" className="mt-7 space-y-10"><OrganizationUsage /><section aria-labelledby="choose-plan-heading"><div className="mb-10 flex flex-wrap items-center justify-between gap-5"><div><h2 id="choose-plan-heading" className="text-2xl font-semibold tracking-tight">Choose your plan</h2><p className="mt-2 text-sm text-muted-foreground">One subscription across the owner’s business profiles.</p></div><BillingTermToggle value={term} onChange={setTerm} plans={plans} /></div>{catalog.isLoading ? <CatalogLoading /> : catalog.isError || !plans.length ? <CatalogError retry={() => void catalog.refetch()} /> : <PlanCards plans={plans} term={term} current={current} canManageBilling={subscription.data?.organization.canManageBilling ?? false} hrefBase="/dashboard/billing/subscription" />}</section>{!!plans.length && <PlanComparison plans={plans} />}</TabsContent><TabsContent value="credits" className="mt-7"><CreditCosts /></TabsContent></Tabs></div>;
}
export default function BillingPricingPage() { return <Suspense fallback={<LoadingState size="page" label="Loading pricing…" />}><PricingWorkspace /></Suspense>; }
