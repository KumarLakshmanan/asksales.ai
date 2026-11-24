"use client";
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Circle, RefreshCw } from 'lucide-react';
import api from '@/lib/admin-api';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import PlanCatalogEditor from '@/components/admin/PlanCatalogEditor';
import OrganizationCredits from '@/components/admin/OrganizationCredits';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { formatCredits, formatRupees } from '../../../../../../../shared/subscriptions';

interface Controls {
  settings: { capacityEnforced?: boolean; enforced: boolean; launchedAt: string | null; credentialId: number | null };
  credentials: { id: number; name: string; active: boolean; mode: string; webhookConfigured: boolean }[];
  plans: { credential_id: number; slug: string; term: string; provider_plan_id: string }[];
  readiness: { monthlyTest: boolean; yearlyTest: boolean; live: boolean; liveWebhookVerifiedAt: string | null; overdueGrants: number; missingGrants: number; unreconciledRefunds: number; ready: boolean };
  refunds: { paymentId: string; organizationId: number; subscriptionId: string; amountPaise: number; refundAmountPaise: number; observedAt: string; cancelledDeposits: number; retainedCredits: number }[];
  issues: { id: string; user_id: number; sync_error: string | null; status: string }[];
  webhookPath: string | null;
  catalogVersion?: number;
  expectedPlans?: number;
}
export default function SubscriptionSettings() {
  const [tab, setTab] = useState('catalog');
  useEffect(() => { const requested = new URLSearchParams(window.location.search).get('tab'); if (requested === 'organizations' || requested === 'payments') setTab(requested); }, []);
  const [data, setData] = useState<Controls | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try { const result = await api.get<Controls>('/api/admin/subscriptions'); setData(result); setCredentialId(String(result.settings.credentialId || '')); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not load subscriptions.'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const action = async (path: string, method: 'post' | 'put', body?: unknown) => {
    setBusy(true); setError(''); setNotice('');
    try { setData(await api[method]<Controls>(`/api/admin/subscriptions/${path}`, body)); setSecret(''); setNotice('Subscription settings updated.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The update failed.'); }
    finally { setBusy(false); }
  };
  return <main className="mx-auto max-w-[1440px] space-y-7 px-4 py-6 sm:px-6"><header className="flex flex-wrap justify-between gap-4"><div><h1 className="text-2xl font-semibold">Subscription billing</h1><p className="mt-2 text-sm text-muted-foreground">Manage business plans, monthly credits, capacity and payment setup.</p></div><Button variant="outline" disabled={busy} onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></header>
    {error && <Callout tone="danger">{error}</Callout>}{notice && <Callout tone="success" announce>{notice}</Callout>}
    <Tabs value={tab} onValueChange={setTab}><TabsList aria-label="Billing administration" className="h-auto flex-wrap justify-start"><TabsTrigger value="catalog" className="min-h-11">Plans & allowances</TabsTrigger><TabsTrigger value="organizations" className="min-h-11">Billing accounts & credits</TabsTrigger><TabsTrigger value="payments" className="min-h-11">Payment setup & rollout</TabsTrigger></TabsList><TabsContent value="catalog" className="mt-7"><PlanCatalogEditor /></TabsContent><TabsContent value="organizations" className="mt-7"><OrganizationCredits /></TabsContent><TabsContent value="payments" className="mt-7 space-y-7">
    {!data ? <p role="status">{busy ? 'Loading billing configuration…' : 'Use Refresh to load billing configuration.'}</p> : <>
      <section className="rounded-xl border border-border p-6"><h2 className="text-lg font-semibold">1. Payment credentials</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Use the encrypted credentials in <Link className="text-primary underline" href="/admin/dashboard/integrations">Provider Integrations</Link>. Start with a test key, complete both purchases, then select a live key. Test credit deposits are simulated and never enter real wallets.</p><div className="mt-5 grid gap-5 sm:grid-cols-2"><div><Label htmlFor="subscription-key">Razorpay credential</Label><select id="subscription-key" value={credentialId} onChange={event => setCredentialId(event.target.value)} className="mt-2 h-11 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">Select a credential</option>{data.credentials.map(c => <option key={c.id} value={c.id} disabled={!c.active}>{c.name} · {c.mode}{!c.active ? ' · inactive' : ''}</option>)}</select></div><div><Label htmlFor="subscription-secret">Subscription webhook secret</Label><Input id="subscription-secret" className="mt-2 h-11" type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} placeholder="Leave blank to keep the saved secret" /><p className="mt-2 text-xs text-muted-foreground">At least 16 characters. Stored encrypted. Use the same secret in Razorpay.</p></div></div><Button className="mt-5" disabled={busy || !credentialId} onClick={() => void action('configuration', 'put', { credentialId: Number(credentialId), ...(secret ? { webhookSecret: secret } : {}) })}>Save configuration</Button></section>
      <section className="rounded-xl border border-border p-6"><h2 className="text-lg font-semibold">2. Plans and webhook</h2><p className="mt-3 text-sm text-muted-foreground">{data.plans.filter(p => p.credential_id === data.settings.credentialId).length} payment plans provisioned for the selected credential. New catalog versions provision their own monthly and yearly payment plans when published.</p><Button className="mt-4" disabled={busy || !data.settings.credentialId} onClick={() => void action('provision','post')}>Provision monthly and yearly plans</Button><p className="mt-5 text-sm leading-6 text-muted-foreground">Create a webhook in Razorpay using your public API origin and the path below. Enable subscription.authenticated, subscription.activated, subscription.charged, subscription.pending, subscription.halted, subscription.cancelled, subscription.completed, subscription.paused, subscription.resumed, refund.processed and payment.refunded.</p><code className="mt-3 block break-all rounded-lg bg-muted p-3 text-xs">{data.webhookPath || 'Select a credential first'}</code><p className="mt-3 text-xs text-muted-foreground">Delivery is verified only after a correctly signed event for a managed subscription is reconciled against Razorpay.</p></section>
      <section className="rounded-xl border border-border p-6"><h2 className="text-lg font-semibold">3. Verification and rollout</h2><ul className="mt-4 space-y-3 text-sm">{([
        ['Verified test monthly purchase',data.readiness.monthlyTest],['Verified test yearly purchase',data.readiness.yearlyTest],['Live credential selected',data.readiness.live],['Verified live webhook delivery',!!data.readiness.liveWebhookVerifiedAt],['Credit ledger reconciled',!data.readiness.overdueGrants && !data.readiness.missingGrants && !data.issues.length],['Refunds reconciled',data.readiness.unreconciledRefunds === 0],
      ] as const).map(([label, done]) => <li className="flex items-center gap-3" key={label}>{done ? <Check aria-label="Complete" className="h-4 w-4 text-primary" /> : <Circle aria-label="Pending" className="h-4 w-4 text-muted-foreground" />}{label}</li>)}</ul><p className="mt-5 text-sm leading-6 text-muted-foreground">Enabling enforcement records the first launch time. Accounts created before that time get 30 days to subscribe. Disabling and re-enabling does not restart that grace period.</p><p className="mt-3 text-sm">Status: <strong>{data.settings.enforced ? 'Enforced' : 'Not enforced'}</strong> · Launch: {data.settings.launchedAt ? new Date(data.settings.launchedAt).toLocaleString() : 'Not launched'}</p><Button className="mt-5" disabled={busy || (!data.settings.enforced && (!data.readiness.ready || data.readiness.unreconciledRefunds !== 0))} onClick={() => void action('enforcement','put',{ enabled: !data.settings.enforced })}>{data.settings.enforced ? 'Disable enforcement' : 'Enable subscription requirement'}</Button></section>
      <section className="rounded-xl border border-border p-6"><div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-lg font-semibold">Billing health</h2><Button variant="outline" disabled={busy} onClick={() => void action('reconcile','post')}>Run reconciliation</Button></div><p className="mt-3 text-sm text-muted-foreground">Overdue deposits: {data.readiness.overdueGrants} · Charge/grant mismatches: {data.readiness.missingGrants} · Subscription issues: {data.issues.length} · Unreconciled refunds: {data.readiness.unreconciledRefunds ?? 'Unavailable'}</p>{data.issues.length > 0 && <ul className="mt-4 space-y-3 text-sm">{data.issues.map(issue => <li key={issue.id} className="break-all rounded-lg bg-muted p-3">Account {issue.user_id} · {issue.status} · {issue.sync_error || 'Creation awaiting reconciliation'}<span className="block text-xs text-muted-foreground">{issue.id}</span></li>)}</ul>}</section>
      <section aria-labelledby="reconciled-refunds-heading" className="rounded-xl border border-border p-6">
        <h2 id="reconciled-refunds-heading" className="text-lg font-semibold">Reconciled refunds</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">A refunded payment no longer provides paid access or future credit deposits. Credits already deposited remain in the shared wallet.</p>
        {data.refunds?.length ? <ul className="mt-5 divide-y divide-border">{data.refunds.map(refund => <li key={refund.paymentId} className="py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-sm font-medium">Billing account {refund.organizationId} · {formatRupees(refund.refundAmountPaise / 100)} refunded</p><p className="text-xs text-muted-foreground">Recorded {new Date(refund.observedAt).toLocaleString('en-IN')}</p></div>
          <p className="mt-2 text-sm text-muted-foreground">Original payment: {formatRupees(refund.amountPaise / 100)} · {refund.cancelledDeposits} future deposits cancelled · {formatCredits(refund.retainedCredits)} credits retained</p>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">Payment {refund.paymentId}<br />Subscription {refund.subscriptionId}</p>
        </li>)}</ul> : <p className="mt-4 text-sm text-muted-foreground">No reconciled subscription refunds.</p>}
      </section>
    </>}
    {data && <section className="rounded-xl border border-border p-6"><h2 className="text-lg font-semibold">Capacity enforcement</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">Measure billing account usage before enabling capacity limits. Existing legacy plans retain their terms. When enabled, businesses on new plans keep existing data but cannot increase resources past an allowance.</p><p className="mt-3 text-sm">Status: <strong>{data.settings.capacityEnforced ? 'Enforced for new plans' : 'Reporting only'}</strong></p><Button className="mt-5" disabled={busy} onClick={() => void action('capacity-enforcement', 'put', { enabled: !data.settings.capacityEnforced })}>{data.settings.capacityEnforced ? 'Return to reporting only' : 'Enable capacity limits'}</Button></section>}
    </TabsContent></Tabs>
  </main>;
}
