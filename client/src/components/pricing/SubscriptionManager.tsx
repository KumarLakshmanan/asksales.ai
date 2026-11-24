"use client";
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CreditCard, Loader2, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSubscription } from '@/hooks/use-subscription';
import { usePricingCatalog } from '@/hooks/use-pricing-catalog';
import { useBillingOrganizations } from '@/hooks/use-billing-organizations';
import BillingOrganizationSelector from '@/components/billing/BillingOrganizationSelector';
import { BUSINESS_PROFILE_HEADER } from '@/lib/business-profile';
import { BILLING_ORGANIZATION_HEADER } from '@/lib/billing-organization';
import api, { type ApiOptions } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { formatCredits, formatRupees, type BillingTerm, type PlanSlug, type SubscriptionCheckout, type SubscriptionState } from '../../../../shared/subscriptions';
import { BillingTermToggle, PlanCards, CatalogError, CatalogLoading } from './PlanCards';
import { loadSubscriptionCheckout, PLAN_INTENT_KEY } from '@/lib/subscription-checkout';

const date = (value: string | null) => value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Awaiting payment';

export default function SubscriptionManager({ showOrganizationSelector = false }: { showOrganizationSelector?: boolean }) {
  const search = useSearchParams();
  const auth = useAuth();
  const query = useSubscription();
  const catalog = usePricingCatalog();
  const organizations = useBillingOrganizations();
  const cache = useQueryClient();
  const [plan, setPlan] = useState<PlanSlug>('starter');
  const [term, setTerm] = useState<BillingTerm>('monthly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmCancel, setConfirmCancel] = useState<'renewal' | 'pending' | null>(null);
  const [selectionReady, setSelectionReady] = useState(false);
  const state = query.data;
  const adminManaged = state?.subscription?.source === 'admin' && !!state.subscription.paidThrough && new Date(state.subscription.paidThrough).getTime() > Date.now();
  const adminScheduled = state?.pendingChange?.source === 'admin';
  const checkoutBlocked = adminManaged || adminScheduled;
  const plans = useMemo(() => catalog.data?.plans ?? [], [catalog.data]);
  const selected = plans.find(candidate => candidate.slug === plan) ?? plans[0];
  const requestOptions: ApiOptions = { headers: { ...(organizations.organizationId ? { [BILLING_ORGANIZATION_HEADER]: String(organizations.organizationId) } : {}), ...(organizations.businessProfileId ? { [BUSINESS_PROFILE_HEADER]: String(organizations.businessProfileId) } : {}) } };
  const currentSubscription = state?.subscription?.paidThrough && new Date(state.subscription.paidThrough).getTime() > Date.now() ? state.subscription : null;
  const isCurrent = !!selected && !!currentSubscription && state?.subscription?.version === selected.version && state.subscription.plan === selected.slug && state.subscription.term === term && !state.subscription.cancelAtPeriodEnd;
  const canManage = state?.organization.canManageBilling === true;

  useEffect(() => {
    if (!catalog.data) return;
    let saved: { plan?: string; term?: string } = {};
    try { saved = JSON.parse(sessionStorage.getItem(PLAN_INTENT_KEY) || '{}'); } catch { /* Storage is optional. */ }
    const chosen = plans.find(candidate => candidate.slug === (search.get('plan') || saved.plan || 'starter')) ?? plans[0];
    if (chosen) setPlan(chosen.slug);
    setTerm((search.get('term') || saved.term) === 'yearly' ? 'yearly' : 'monthly');
    setSelectionReady(true);
  }, [search, catalog.data, plans]);
  useEffect(() => {
    if (selectionReady) { try { sessionStorage.setItem(PLAN_INTENT_KEY, JSON.stringify({ plan, term, version: selected?.version })); } catch { /* Optional preference. */ } }
  }, [plan, term, selectionReady, selected?.version]);

  const accept = async (updated: SubscriptionState) => {
    cache.setQueryData(['subscription', auth.user?.id, organizations.billingScopeKey], updated);
    await Promise.all([cache.invalidateQueries({ queryKey: ['platform-access'] }), cache.invalidateQueries({ queryKey: ['wallet'] })]);
  };
  const refresh = async () => {
    setBusy(true); setError('');
    try { await accept(await api.post<SubscriptionState>('/api/subscriptions/refresh', {}, requestOptions)); setNotice('Billing status refreshed.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to refresh billing.'); }
    finally { setBusy(false); }
  };
  const checkout = async () => {
    if (busy || !selected || !canManage || isCurrent || checkoutBlocked) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await loadSubscriptionCheckout();
      const checkout = await api.post<SubscriptionCheckout>(state?.subscription?.paidThrough ? '/api/subscriptions/change' : '/api/subscriptions/start', { plan: selected.slug, term, catalogVersion: selected.version }, requestOptions);
      const razorpay = new window.Razorpay({
        key: checkout.keyId, subscription_id: checkout.subscriptionId, name: 'AskSales',
        description: `${selected.name} · ${term} subscription`, prefill: { name: auth.user?.name, email: auth.user?.email },
        theme: { color: '#2563EB' },
        handler: async (response: { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string }) => {
          try {
            const updated = await api.post<SubscriptionState>('/api/subscriptions/verify', {
              subscriptionId: checkout.subscriptionId, paymentId: response.razorpay_payment_id, signature: response.razorpay_signature,
            }, requestOptions);
            await accept(updated);
            setNotice(updated.access.reason === 'paid' ? 'Payment verified. Your subscription is active.'
              : checkout.replacement ? 'Authorization received. Your new plan starts at renewal after the mandate is confirmed.'
              : 'Payment details received. Access and credits appear after the full plan charge is verified. Use “Sync payment” to check again.');
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Verification is pending. Sync payment to check again.');
          } finally { setBusy(false); }
        },
        modal: { ondismiss: () => { setBusy(false); void query.refetch(); } },
      });
      razorpay.on('payment.failed', () => { setBusy(false); setError('Payment was not completed. You can retry or sync payment if money was debited.'); });
      razorpay.open();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Checkout is unavailable.'); setBusy(false); }
  };
  const cancel = async () => {
    if (!confirmCancel) return;
    setBusy(true); setError('');
    try { await accept(await api.post<SubscriptionState>('/api/subscriptions/cancel', { scope: confirmCancel }, requestOptions)); setConfirmCancel(null); setNotice('Cancellation saved. Paid access and scheduled credit deposits continue through the paid term.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Cancellation failed. Try again.'); }
    finally { setBusy(false); }
  };

  if (auth.isLoading) return <div className="py-16" role="status">Checking your account…</div>;
  if (catalog.isLoading) return <CatalogLoading />;
  if (catalog.isError || !selected) return <CatalogError retry={() => void catalog.refetch()} />;
  if (!auth.user) return <div className="mx-auto max-w-2xl rounded-[14px] border border-border p-7 sm:p-10"><p className="font-mono text-xs uppercase tracking-widest text-primary">Your selection</p><h1 className="mt-4 text-3xl font-semibold">Start with {selected.name}.</h1><p className="mt-5 text-lg">{formatRupees(term === 'yearly' ? selected.yearlyRupees : selected.monthlyRupees)} / {term === 'yearly' ? 'year' : 'month'} · {formatCredits(selected.monthlyCredits)} credits each month</p><p className="mt-4 text-sm leading-7 text-muted-foreground">Create your account, complete setup and wait for admin approval. Then authorize your subscription payment. There is no free trial.</p><div className="mt-7 flex flex-wrap gap-3"><Button asChild><Link href="/login?mode=register">Create account<ArrowRight className="ml-2 h-4 w-4" /></Link></Button><Button variant="outline" asChild><Link href="/login">Sign in</Link></Button></div><Link href="/pricing" className="mt-6 inline-block text-sm text-primary underline underline-offset-4">Compare plans</Link></div>;
  if (!auth.isSetupComplete || !auth.isApproved) return <div className="mx-auto max-w-xl rounded-xl border border-border p-8"><h1 className="text-2xl font-semibold">{!auth.isSetupComplete ? 'Complete your account setup' : 'Your account is awaiting approval'}</h1><p className="mt-4 text-sm leading-7 text-muted-foreground">You can subscribe after setup and admin approval. Your plan selection is saved in this browser.</p><Button className="mt-6" asChild><Link href={!auth.isSetupComplete ? (!auth.hasBusinessProfile ? '/setup/business-profile' : '/setup/brand-toolkit') : '/dashboard/approval-pending'}>{!auth.isSetupComplete ? 'Continue setup' : 'View approval status'}</Link></Button></div>;
  // A failed or empty billing-account answer never becomes `ready`; show the
  // selector's error and Retry instead of "Loading subscription…" forever.
  // Rendered inline: mounting BillingOrganizationSelector here would add a
  // query observer that refetches on mount and flips back to loading.
  if (organizations.unavailable) return <div role="alert" className="rounded-xl border border-destructive/40 p-6"><h1 className="text-xl font-semibold">Billing could not be loaded</h1><p className="mt-3 text-sm text-muted-foreground">{organizations.isError ? 'Your billing account could not be loaded. Please try again.' : 'No billing account was found for the selected business. Choose a business in the sidebar or try again.'}</p><Button className="mt-5" variant="outline" onClick={() => void organizations.refetch()}>Try again</Button></div>;
  if (!organizations.ready || query.isLoading) return <p role="status" className="py-12">Loading subscription…</p>;
  if (query.isError || !state) return <div role="alert" className="rounded-xl border border-destructive/40 p-6"><h1 className="text-xl font-semibold">Billing could not be loaded</h1><p className="mt-3 text-sm text-muted-foreground">Your subscription could not be verified. Please try again.</p><Button className="mt-5" variant="outline" onClick={() => void query.refetch()}>Retry</Button></div>;
  const currentPlan = state.subscription;
  const organizationSelector = showOrganizationSelector ? <BillingOrganizationSelector disabled={busy} /> : null;
  const selectedPrice = term === 'yearly' ? selected.yearlyRupees : selected.monthlyRupees;
  const paymentAction = !canManage ? 'Ask your business owner' : isCurrent ? 'Current plan' : state.subscription?.paidThrough ? 'Authorize plan at renewal' : 'Continue to payment';
  return <div className={`space-y-8 ${checkoutBlocked ? '' : 'pb-40 sm:pb-32'}`}>
    {organizationSelector}
    <header className="flex flex-wrap items-start justify-between gap-5"><div><p className="font-mono text-xs uppercase tracking-widest text-primary">Shared business plan · INR</p><h1 className="mt-3 text-3xl font-semibold tracking-tight">Your subscription</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">One subscription and credit wallet across the owner’s business profiles. Staff work in the business they have joined.</p></div><div className="flex flex-wrap gap-3">{!adminManaged && <Button variant="outline" disabled={busy || !canManage} onClick={() => void refresh()}><RefreshCw className="mr-2 h-4 w-4" />Sync payment</Button>}{state.access.allowed && <Button variant="outline" asChild><Link href="/dashboard/home">Open workspace</Link></Button>}</div></header>
    {state.mode === 'test' && <Callout tone="warning" announce>Test mode. Razorpay payments and their deposits are simulated. Administrator-assigned plans and credits are separate account grants.</Callout>}
    {error && <Callout tone="danger">{error}</Callout>}
    {notice && <p role="status" className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">{notice}</p>}
    {['existing_user_grace', 'payment_grace', 'subscription_required'].includes(state.access.reason) && <div className="rounded-xl border border-border p-5"><h2 className="font-semibold">{state.access.reason === 'existing_user_grace' ? 'Time to choose your plan' : state.access.reason === 'payment_grace' ? 'Your renewal needs attention' : 'Subscribe to use your workspace'}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{state.access.accessUntil ? `Access continues until ${date(state.access.accessUntil)}. ` : ''}Your unused wallet credits are retained. {state.access.reason === 'payment_grace' ? 'No credits are deposited for an unpaid period. Update your payment method through Razorpay’s renewal notice, then sync payment here.' : 'Choose a plan below to continue.'}</p></div>}
    {state.subscription && <section className="rounded-[14px] border border-border p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{currentPlan?.name} · {state.subscription.term}</h2>
          {state.subscription.source === 'admin' ? <>
            <p className="mt-2 text-sm text-muted-foreground">Administrator assigned · no payment mandate or invoice. Plan ends {date(state.subscription.paidThrough)}.</p>
            <p className="mt-2 text-sm text-muted-foreground">This plan does not renew automatically. {state.nextDepositAt ? `Next credit deposit: ${date(state.nextDepositAt)}.` : ''}</p>
          </> : <>
            <p className="mt-2 text-sm text-muted-foreground">Mandate status: {state.subscription.status}. {state.subscription.paidThrough ? `Paid through ${date(state.subscription.paidThrough)}.` : 'No active paid term.'}</p>
            <p className="mt-2 text-sm text-muted-foreground">{state.subscription.cancelAtPeriodEnd ? 'Auto renewal is off.' : 'Renews automatically while the payment mandate is active.'} {state.nextDepositAt ? `Next credit deposit: ${date(state.nextDepositAt)}.` : ''}</p>
          </>}
        </div>
        {state.subscription.source !== 'admin' && <Button variant="outline" disabled={busy || !canManage || state.subscription.cancelAtPeriodEnd} onClick={() => setConfirmCancel('renewal')}>{state.subscription.status === 'created' ? 'Cancel pending checkout' : 'Cancel auto renewal'}</Button>}
      </div>
      {state.pendingChange && <div className="mt-5 border-t border-border pt-5">
        <p className="text-sm font-medium">Pending change: {state.pendingChange.name} · {state.pendingChange.term}</p>
        {state.pendingChange.source === 'admin'
          ? <p className="mt-2 text-sm text-muted-foreground">Administrator assigned · starts after the current term. No payment authorization is needed.</p>
          : <><p className="mt-2 text-sm text-muted-foreground">{state.pendingChange.status} · Starts after the current paid term. Authorize the new mandate to complete this change.</p><Button className="mt-3" variant="outline" disabled={busy || !canManage} onClick={() => setConfirmCancel('pending')}>Cancel pending change</Button></>}
      </div>}
      {confirmCancel && <div role="alertdialog" aria-labelledby="cancel-title" className="mt-6 rounded-xl border border-border bg-muted/30 p-5"><h3 id="cancel-title" className="font-semibold">{confirmCancel === 'pending' ? 'Cancel the pending plan change?' : 'Stop future renewal payments?'}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Access and annual credit deposits continue through your paid term. Unused credits remain in your wallet. Cancelling an authorized replacement does not restart the old mandate.</p><div className="mt-4 flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void cancel()}>Confirm cancellation</Button><Button variant="outline" onClick={() => setConfirmCancel(null)}>Keep it</Button></div></div>}
    </section>}
    <section aria-labelledby="choose-heading"><div className="mb-10 flex flex-wrap items-center justify-between gap-5"><h2 id="choose-heading" className="text-xl font-semibold">{state.subscription?.paidThrough ? 'Choose your next plan' : 'Choose your plan'}</h2><BillingTermToggle value={term} onChange={setTerm} plans={plans} disabled={busy || checkoutBlocked} /></div><PlanCards plans={plans} term={term} selected={plan} current={currentSubscription} onSelect={setPlan} disabled={busy || checkoutBlocked} canManageBilling={canManage} /></section>
    {checkoutBlocked ? <section className="rounded-[14px] border border-primary/30 bg-primary/5 p-6">
      <h2 className="font-semibold">Administrator-managed plan</h2>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">Your complimentary plan {adminScheduled ? 'is scheduled after the current term' : 'is active'} and does not create a payment or invoice. Ask support to change or end it. Payment checkout is available after the administrator term ends.</p>
    </section> : <section aria-labelledby="selection-summary-heading" className="mx-auto w-full max-w-5xl rounded-[18px] border border-border bg-card p-5 sm:p-7">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-10">
        <div>
          <h2 id="selection-summary-heading" className="text-lg font-semibold">Your selection: {selected.name}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{formatCredits(selected.monthlyCredits)} credits arrive each month. {term === 'yearly' ? 'The full yearly amount is paid upfront; credits arrive monthly.' : 'The listed amount is paid each month.'} {state.subscription?.paidThrough ? 'Changes start at renewal. Authorize a replacement mandate before the existing one is cancelled.' : 'Credits and access activate after the full plan charge is verified.'}</p>
        </div>
        <div className="rounded-xl bg-muted/50 px-4 py-3 md:min-w-48 md:text-right">
          <p className="text-xs text-muted-foreground">{term === 'yearly' ? 'Yearly total' : 'Monthly total'} · tax included</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{formatRupees(selectedPrice)}</p>
          {term === 'yearly' && <p className="mt-1 text-xs text-muted-foreground">{formatRupees(selectedPrice / 12)} / month equivalent</p>}
        </div>
      </div>
      <p className="mt-5 border-t border-border pt-4 text-xs leading-6 text-muted-foreground">By continuing, you authorize recurring payments under the <Link href="/terms" className="underline underline-offset-2">Terms</Link>. Cancel future renewals from this page.</p>
      {!canManage && <p className="mt-2 text-sm text-muted-foreground">Only your business owner or a billing admin can change this subscription.</p>}
      {!state.checkoutAvailable && <p className="mt-2 text-sm text-muted-foreground">Checkout is awaiting payment setup. Please contact support.</p>}
    </section>}
    <div className="flex flex-wrap gap-5 text-sm text-primary"><Link href="/dashboard/billing" className="underline underline-offset-4">Billing overview</Link>{state.access.canTopUp && <Link href="/dashboard/billing/recharge" className="underline underline-offset-4">Buy extra credits</Link>}<Link href="/contact" className="underline underline-offset-4">Contact support</Link></div>
    {state.charges.length > 0 && <section aria-labelledby="payment-history-heading">
      <h2 id="payment-history-heading" className="text-xl font-semibold">Plan payment history</h2>
      {state.charges.some(charge => (charge.refundAmountPaise ?? 0) > 0) && <p className="mt-3 text-sm leading-6 text-muted-foreground">Refunded payments do not provide paid access or future credit deposits. Credits already deposited remain in the owner’s shared wallet. A refund does not cancel your renewal mandate.</p>}
      <div className="mt-4 divide-y divide-border border-y border-border">{state.charges.map(charge => {
        const refunded = (charge.refundAmountPaise ?? 0) > 0;
        return <article aria-label={`Payment ${charge.id}`} className="flex flex-wrap items-center justify-between gap-3 py-5 text-sm" key={charge.id}>
          <div><p className="font-medium">{charge.plan} · {formatRupees(charge.amountPaise / 100)}</p><p className="mt-1 text-muted-foreground">{refunded ? 'Original term: ' : ''}{date(charge.periodStart)} – {date(charge.periodEnd)}{charge.taxPaise !== null ? ` · Invoice tax: ${formatRupees(charge.taxPaise / 100)}` : ''}</p>
            {refunded && <p className="mt-2 font-medium text-foreground">Refund recorded · {formatRupees(charge.refundAmountPaise! / 100)}{charge.refundObservedAt ? ` · ${date(charge.refundObservedAt)}` : ''}</p>}
          </div>
          {charge.invoiceUrl && <a href={charge.invoiceUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">{refunded ? 'View original invoice' : 'View invoice'}</a>}
        </article>;
      })}</div>
    </section>}
    {!checkoutBlocked && <div className="subscription-checkout-bar fixed inset-x-0 bottom-0 z-[var(--layer-header)] border-t border-border bg-background/95 shadow-[0_-12px_30px_-20px_rgba(0,0,0,0.35)] backdrop-blur-md" role="region" aria-label="Selected plan checkout">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-3 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6 lg:px-8">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">Selected plan · {term === 'yearly' ? 'yearly billing' : 'monthly billing'}</p>
          <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold sm:text-base"><span>{selected.name}</span><span aria-hidden className="text-muted-foreground">·</span><span className="tabular-nums">{formatRupees(selectedPrice)} / {term === 'yearly' ? 'year' : 'month'}</span><span className="text-xs font-normal text-muted-foreground">tax included</span></p>
        </div>
        <Button className="min-h-12 w-full shrink-0 sm:w-auto sm:min-w-60" disabled={busy || !state.checkoutAvailable || !canManage || isCurrent} onClick={() => void checkout()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}{paymentAction}</Button>
      </div>
    </div>}
  </div>;
}
