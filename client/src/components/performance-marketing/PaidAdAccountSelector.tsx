"use client";
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { paidAdAccountNames, type PaidAdAccountIdentity } from '@/lib/paid-ad-accounts';

type Account = PaidAdAccountIdentity & {currency:string|null;timezone:string|null;is_manager:boolean;reporting_available:boolean;publishing_available:boolean;verified_at:string|null;error_code:string|null;last_succeeded_at:string|null;last_attempt_at:string|null;data_available_through:string|null};
export function PaidAdAccountSelector({value,onChange,className}:{value:string;onChange:(value:string)=>void;className?:string}) {
  const queryClient = useQueryClient();
  const {data, isPending: loading, isError: loadError} = useQuery({queryKey:['paid-ad-accounts'], queryFn:()=>api.get<{accounts:Account[]}>('/api/campaigns/accounts'), staleTime:60_000});
  const accounts = data?.accounts || [];
  const [busyPlatform,setBusyPlatform]=useState<'meta'|'google'|null>(null);
  const {toast}=useToast();
  const discover=async(platform:'meta'|'google')=>{
    setBusyPlatform(platform);
    try {
      const result=await api.post<{accounts:Account[];failures:string[]}>('/api/campaigns/accounts/discover',{platform});
      queryClient.setQueryData(['paid-ad-accounts'], {accounts:result.accounts});
      toast({title:result.failures.length?'Some accounts could not be verified':'Accounts verified',description:result.failures.join(' ') || 'Select an account and refresh to load its campaigns.'});
    } catch {toast({title:'Account discovery unavailable',description:'Connect the provider in Integrations and check Ads permissions.',variant:'destructive'});}
    finally{setBusyPlatform(null);}
  };
  const selected=accounts.find(account=>String(account.id)===value);
  const accountNames = paidAdAccountNames(accounts);
  const authorizationReady = !!selected?.verified_at && !selected.error_code;
  const reportingIssue = selected?.error_code === 'INCOMPLETE_REPORTING' ? 'Latest reporting sync was incomplete' : 'Latest reporting sync failed';
  return <div className={cn("space-y-2 sm:col-span-2 lg:col-span-3 xl:col-span-5", className)}><div className="flex flex-wrap items-center gap-2">
    <Select value={value} onValueChange={onChange} disabled={loading}><SelectTrigger aria-label="Ad account" className="w-full sm:w-auto sm:min-w-64"><SelectValue placeholder={loading?'Loading ad accounts…':'All ad accounts'}/></SelectTrigger><SelectContent>
      <SelectItem value="all">All ad accounts</SelectItem>
      {accounts.map(account=><SelectItem key={account.id} value={String(account.id)} disabled={account.is_manager}>{accountNames.get(account.id)} · {account.platform==='meta'?'Meta':'Google'} · {account.currency || 'Currency unavailable'}{account.is_manager?' · Manager account':account.error_code?' · Sync issue':!account.reporting_available?' · Reporting unavailable':''}</SelectItem>)}
    </SelectContent></Select>
    <Button type="button" variant="outline" size="sm" loading={busyPlatform==='meta'} disabled={busyPlatform!==null&&busyPlatform!=='meta'} onClick={()=>discover('meta')}>Find Meta accounts</Button>
    <Button type="button" variant="outline" size="sm" loading={busyPlatform==='google'} disabled={busyPlatform!==null&&busyPlatform!=='google'} onClick={()=>discover('google')}>Find Google accounts</Button>
    {selected&&<span className="text-xs text-muted-foreground" title={`Last attempt: ${selected.last_attempt_at || 'Never'}; last successful sync: ${selected.last_succeeded_at || 'Never'}`}>{selected.error_code?reportingIssue:selected.last_succeeded_at?`Synced ${new Date(selected.last_succeeded_at).toLocaleString()}`:'Waiting for first sync'} · Data through {selected.data_available_through?.slice(0,10)||'unavailable'}</span>}
  </div>
  {loadError&&<Callout tone="warning" size="sm" announce actions={<Button asChild variant="link" size="sm" className="h-auto p-0"><Link href="/dashboard/integrations">Check provider connections</Link></Button>}>Saved ad accounts could not be loaded.</Callout>}
  {!loading&&!loadError&&!accounts.length&&<p className="text-xs text-muted-foreground">No verified ad accounts yet. Connect Meta or Google Ads in Integrations, then use account discovery.</p>}
  {selected&&<div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border bg-muted/20 px-3 py-2 text-xs" aria-label="Selected ad account readiness"><span>Authorization: <strong>{selected.error_code?'Recheck required':authorizationReady?'Verified':'Not verified'}</strong></span><span>Customer: <strong>Selected</strong></span><span>Reporting: <strong>{selected.error_code?'Needs attention':selected.reporting_available?'Ready':'Unavailable'}</strong></span><span>Publishing: <strong>{authorizationReady?(selected.publishing_available?'Ready':'Unavailable'):'Not verified'}</strong></span><span>Timezone: <strong>{selected.timezone||'Unavailable'}</strong></span>{selected.error_code&&<Link className="text-primary underline" href={`/dashboard/integrations/${selected.platform==='meta'?'meta':'google-ads'}`}>Review {selected.platform==='meta'?'Meta Ads':'Google Ads'} connection</Link>}</div>}</div>;
}
