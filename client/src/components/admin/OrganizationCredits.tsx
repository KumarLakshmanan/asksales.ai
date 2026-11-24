"use client";
import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Coins } from 'lucide-react';
import api from '@/lib/admin-api';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchInput } from '@/components/ui/search-input';
import { Textarea } from '@/components/ui/textarea';
import { formatCredits } from '../../../../shared/subscriptions';
import AdminPlanAssignment from './AdminPlanAssignment';

type OrganizationWallet = { id: number; name: string; ownerUserId: number; ownerEmail: string; balance: number; planName: string | null; planSlug: string | null; catalogVersion: number | null };
export default function OrganizationCredits() {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const query = useQuery({ queryKey: ['admin-organization-wallets', deferredSearch], queryFn: () => api.get<{ organizations: OrganizationWallet[]; resultLimit: number; hasMore: boolean }>('/api/admin/subscriptions/organizations', { params: { search: deferredSearch } }) });
  const [selectedId, setSelectedId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selected = query.data?.organizations.find(org => org.id === Number(selectedId));
  const creditAmount = Number(amount);
  const valid = !!selected && Number.isFinite(creditAmount) && creditAmount > 0 && creditAmount <= 100_000_000 && reason.trim().length >= 3;
  const addCredits = async () => {
    if (!valid || !selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const updated = await api.post<{ balance: number; organizationId: number }>(`/api/admin/subscriptions/organizations/${selected.id}/credits`, { amount: creditAmount, reason: reason.trim() });
      setNotice(`${formatCredits(creditAmount)} credits added to ${selected.name}. New balance: ${formatCredits(Number(updated.balance))} credits.`);
      setAmount(''); setReason(''); setConfirm(false); await query.refetch();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Credits could not be added. Try again.'); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby="organization-credits-heading" className="space-y-6"><header><h2 id="organization-credits-heading" className="text-xl font-semibold">Billing account wallets</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">View the shared wallet for any billing account and record a credit adjustment. Every adjustment includes the administrator and reason in its transaction history.</p></header>
    <div className="max-w-2xl"><Label htmlFor="organization-wallet-search">Find a billing account</Label><SearchInput id="organization-wallet-search" aria-label="Find a billing account" value={search} onValueChange={value => { setSearch(value); setConfirm(false); }} placeholder="Search billing account name or owner" wrapperClassName="mt-2" className="min-h-11" /></div>
    {query.isError && <Callout tone="danger" className="max-w-3xl">Billing account wallets could not be loaded. <button className="text-primary underline" onClick={() => void query.refetch()}>Try again</button></Callout>}
    {query.data?.hasMore && <p role="status" className="max-w-3xl text-sm text-muted-foreground">Showing the first {query.data.resultLimit} matching billing accounts. More accounts match; narrow your search by account name, owner email or exact account ID.</p>}
    {error && <Callout tone="danger" className="max-w-3xl">{error}</Callout>}{notice && <Callout tone="success" announce className="max-w-3xl">{notice}</Callout>}
    <form className="max-w-3xl rounded-[14px] border border-border bg-card p-5 sm:p-7" onSubmit={event => { event.preventDefault(); setConfirm(true); }}><Label htmlFor="organization-wallet">Billing account wallet</Label><select id="organization-wallet" required disabled={busy || query.isLoading} value={selectedId} onChange={event => { setSelectedId(event.target.value); setConfirm(false); setError(''); setNotice(''); }} className="mt-2 block min-h-11 w-full rounded-[10px] border border-border bg-background px-3 text-sm focus-visible:outline-primary"><option value="">{query.isLoading ? 'Loading billing accounts…' : 'Select a billing account'}</option>{query.data?.organizations.map(org => <option key={org.id} value={org.id}>{org.name} · {org.ownerEmail} · {formatCredits(Number(org.balance))} credits</option>)}</select>
      {selected && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y border-border py-5"><div><p className="text-xs text-muted-foreground">Current balance</p><p className="mt-2 flex items-center gap-2 text-2xl font-semibold tabular-nums"><Coins className="h-5 w-5 text-primary" aria-hidden />{formatCredits(Number(selected.balance))} <span className="text-sm font-normal text-muted-foreground">credits</span></p></div><div className="text-sm"><p>{selected.planName ?? 'No subscription'}</p><p className="mt-1 text-xs text-muted-foreground">Owner account #{selected.ownerUserId}{selected.catalogVersion ? ` · Catalog ${selected.catalogVersion}` : ''}</p></div></div>}
      <div className="mt-5"><Label htmlFor="organization-credit-amount">Credits to add</Label><Input id="organization-credit-amount" required disabled={busy} type="number" min={0.01} max={100_000_000} step={0.01} value={amount} onChange={event => { setAmount(event.target.value); setConfirm(false); }} placeholder="0" className="mt-2 min-h-11 max-w-xs" /></div><div className="mt-5"><Label htmlFor="organization-credit-reason">Reason for adjustment</Label><Textarea id="organization-credit-reason" required disabled={busy} maxLength={500} value={reason} onChange={event => { setReason(event.target.value); setConfirm(false); }} placeholder="Explain why these credits are being added" className="mt-2" /></div><Button className="mt-5" variant="outline" disabled={busy || !valid}>Review credit adjustment</Button>
      {confirm && selected && <div role="alertdialog" aria-labelledby="credit-confirm-heading" className="mt-5 rounded-xl border border-primary/30 bg-primary/5 p-5"><h3 id="credit-confirm-heading" className="font-semibold">Add {formatCredits(creditAmount)} credits to {selected.name}?</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Billing account #{selected.id} · {reason}</p><div className="mt-4 flex flex-wrap gap-3"><Button type="button" disabled={busy || !valid} onClick={() => void addCredits()}>{busy ? 'Adding credits…' : 'Add credits'}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button></div></div>}
    </form>
    <AdminPlanAssignment key={selectedId} organizationId={selected?.id ?? null} onChanged={() => query.refetch()} />
  </section>;
}
