"use client";
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Columns3, X } from 'lucide-react';
import { paidAdsFilterUpdates, paidAdsPeriod, paidCampaignFreshness } from '@/lib/paid-ads-filters';
import { usePaidAdsDashboard } from '@/hooks/usePaidAdsDashboard';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Pagination } from '@/components/ui/pagination';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaidAdsFilterSelect } from './PaidAdsFilterSelect';
import { PaidAdAccountSelector } from './PaidAdAccountSelector';
import { CampaignEvidenceBadge } from './CampaignEvidenceBadge';
import { usePaidAdsNavigation } from './PaidAdsSectionContext';
import { managedCampaignHref, providerCampaignHref, withPaidAdsContext } from './campaignRoutes';
import { campaignResult, type PresentedCampaign } from '@/lib/performancePresentation';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import styles from '@/components/marketing/marketing.module.css';

type Campaign=PresentedCampaign & {name:string;status:string;providerStatus?:string;adPlatform:string;platformCampaignId?:string;budgetAmount:number;budgetType?:string;accountRegistryId?:number;campaignAiConsent:boolean};
type Column='platform'|'status'|'monitoring'|'spend'|'results'|'cost'|'budget'|'freshness';
const columns:Column[]=['platform','status','monitoring','spend','results','cost','budget','freshness'];
const labels:Record<Column,string>={platform:'Platform',status:'Delivery',monitoring:'Monitoring',spend:'Spend',results:'Results',cost:'Cost / result',budget:'Budget',freshness:'Last synced'};
const defaults:Column[]=['platform','status','monitoring','spend','results','cost'];
const money=(value:number,currency:string)=>Number.isFinite(value)?new Intl.NumberFormat(undefined,{style:'currency',currency}).format(value):'—';
const count=(value:number)=>Number.isFinite(value)?new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(value):'Unavailable';
type SavedView={name:string;query:string;columns:Column[];sort:string;descending:boolean};
export function UnifiedCampaignInventory({onCreativeWorkspace}:{onCreativeWorkspace:()=>void}) {
  const params=useSearchParams(); const navigation=usePaidAdsNavigation();
  const [syncing,setSyncing]=useState(false); const [syncError,setSyncError]=useState(''); const [page,setPage]=useState(1);
  const [visible,setVisible]=useState<Column[]>(defaults); const [sort,setSort]=useState('name'); const [descending,setDescending]=useState(false);
  const [saved,setSaved]=useState<SavedView[]>([]); const [viewName,setViewName]=useState('');
  const account=params.get('account')||'all',period=paidAdsPeriod({period:params.get('period'),date:params.get('date')}),platform=params.get('platform')||'all',status=params.get('status')||'all',search=params.get('search')||'',currency=params.get('currency')||'',objective=params.get('objective')||'all';
  useEffect(()=>{try{const value=JSON.parse(localStorage.getItem('asksales-paid-inventory-views-v1')||'[]');if(Array.isArray(value))setSaved(value.filter(item=>item&&typeof item.name==='string'&&typeof item.query==='string'&&Array.isArray(item.columns)).slice(0,20));}catch{}},[]);
  const dashboard=usePaidAdsDashboard<{campaigns:Campaign[];availableCurrencies:string[];currency:string}>({account,period,platform,status,currency,objective,comparison:params.get('comparison')||'previous_period'});
  const campaigns=useMemo(()=>dashboard.data?.campaigns || [],[dashboard.data]), currencies=dashboard.data?.availableCurrencies || [], currentCurrency=dashboard.data?.currency || '';
  const loading=dashboard.isFetching || syncing, error=syncError || dashboard.error?.message;
  const load=dashboard.refresh;
  const filtered=useMemo(()=>campaigns.filter(c=>c.name.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>{
    const value=(c:Campaign):string|number=>sort==='name'?c.name:sort==='spend'?Number(c.metrics.spend||0):sort==='cost'?campaignResult(c).cost:sort==='results'?campaignResult(c).result:sort==='budget'?c.budgetAmount:sort==='platform'?c.adPlatform:sort==='monitoring'?c.aiState||'':sort==='status'?c.providerStatus||c.status:c.metricsUpdatedAt||'';
    const av=value(a),bv=value(b); if(typeof av==='number'&& !Number.isFinite(av))return 1;if(typeof bv==='number'&&!Number.isFinite(bv))return -1;
    return (typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv)))*(descending?-1:1);
  }),[campaigns,search,sort,descending]);
  const pageCount=Math.max(1,Math.ceil(filtered.length/20));
  const currentPage=Math.min(page,pageCount);
  const visibleRows=filtered.slice((currentPage-1)*20,currentPage*20);
  const href=(c:Campaign)=>withPaidAdsContext(c.source==='provider_cache'?providerCampaignHref(c.adPlatform as 'meta'|'google',String(c.platformCampaignId)):managedCampaignHref(Number(c.id)),new URLSearchParams({...Object.fromEntries(params),...(c.accountRegistryId?{account:String(c.accountRegistryId)}:{})}).toString());
  const cell=(c:Campaign,column:Column)=>{
    const result=campaignResult(c);
    switch(column){
      case'platform':return <Badge variant="outline">{c.adPlatform==='meta'?'Meta':c.adPlatform==='google'?'Google':'Multiple platforms'}</Badge>;
      case'status':return <Badge variant="outline" className={`capitalize ${['active','ACTIVE','published'].includes(c.providerStatus||c.status)?'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':'bg-muted/60 text-muted-foreground'}`}>{(c.providerStatus||c.status).replaceAll('_',' ')}</Badge>;
      case'monitoring':return <CampaignEvidenceBadge campaign={c}/>;
      case'spend':return money(Number(c.metrics.spend||0),c.currency);
      case'results':return `${count(result.result)} ${result.resultLabel.toLowerCase()}`;
      case'cost':return `${money(result.cost,c.currency)} ${result.costLabel}`;
      case'budget':return `${money(c.budgetAmount,c.currency)} / ${c.budgetType==='daily'?'day':'campaign'}`;
      case'freshness':return paidCampaignFreshness(c.metricsUpdatedAt, Boolean(c.failedSyncs));
    }
  };
  const update=(key:string,value:string)=>{setPage(1);navigation.updateQuery(paidAdsFilterUpdates({[key]:value}));};
  const save=()=>{const name=viewName.trim();if(!name)return;const next=[...saved.filter(item=>item.name!==name),{name,query:params.toString(),columns:visible,sort,descending}].slice(-20);setSaved(next);localStorage.setItem('asksales-paid-inventory-views-v1',JSON.stringify(next));setViewName('');};
  return <section className="space-y-4" aria-label="Campaign inventory">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Campaign inventory</h2><p className="text-sm text-muted-foreground">{dashboard.isPending?'Loading campaigns…':`${filtered.length} campaigns`} · {currentCurrency || 'Account currency'} · One entry per campaign</p></div><div className="flex gap-2"><Button variant="outline" onClick={onCreativeWorkspace}>Creative & draft workspace</Button><Button disabled={loading} onClick={()=>void load()}>{loading?'Loading…':'Refresh view'}</Button></div></div>
    <div className="flex flex-wrap items-center gap-2"><PaidAdAccountSelector value={account} onChange={value=>update('account',value)}/>{account!=='all'&&<Button variant="outline" disabled={loading} onClick={async()=>{setSyncing(true);setSyncError('');try{await api.post(`/api/campaigns/accounts/${account}/refresh`,{});await load();}catch{setSyncError('Account refresh failed. Check provider permissions and reconnect if needed.');}finally{setSyncing(false);}}}>Sync selected account</Button>}</div>
    <div className="flex flex-wrap items-end gap-3"><SearchInput wrapperClassName="sm:w-64" aria-label="Search campaigns" placeholder="Search campaigns" value={search} onValueChange={value=>update('search',value)}/>
      {[{label:'Platform',key:'platform',value:platform,values:['all','meta','google']},{label:'Objective',key:'objective',value:params.get('objective')||'all',values:['all','awareness','traffic','engagement','leads','sales','app_promotion','conversations','conversions']},{label:'Delivery status',key:'status',value:status,values:['all','active','paused','draft','report_only','provider_failed']},{label:'Date range',key:'period',value:period,values:['7d','30d','90d']}].map(filter=><PaidAdsFilterSelect key={filter.key} label={filter.label} value={filter.value} onChange={value=>update(filter.key,value)} items={filter.values} itemLabel={filter.key==='period'?value=>`Last ${value.slice(0,-1)} days`:undefined} className="w-full sm:w-40"/>)}
      {currencies.length>1&&<Select value={currency||currentCurrency} onValueChange={value=>update('currency',value)}><SelectTrigger aria-label="Reporting currency" className="w-28"><SelectValue/></SelectTrigger><SelectContent>{currencies.map(value=><SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>}
      <Sheet><SheetTrigger asChild><Button variant="outline"><Columns3 aria-hidden="true" className="mr-2 h-4 w-4"/>Columns &amp; saved views</Button></SheetTrigger><SheetContent overlayClassName={styles.drawerOverlay} className={styles.drawer}>
        <SheetHeader className="pr-6"><SheetTitle>Columns &amp; saved views</SheetTitle><SheetDescription>Choose the information in your campaign inventory. Saved views stay in this browser.</SheetDescription></SheetHeader>
        <div className="mt-6 space-y-3"><label className="block text-sm font-medium" htmlFor="paid-view-name">Saved view name</label><Input id="paid-view-name" value={viewName} onChange={e=>setViewName(e.target.value)} placeholder="Name this view" maxLength={60}/><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!viewName.trim()} onClick={save}>Save view</Button><Button variant="ghost" onClick={()=>setVisible(defaults)}>Reset columns</Button></div></div>
        <fieldset className="mt-7 space-y-1"><legend className="mb-2 text-sm font-semibold">Show columns</legend><label className="flex items-center gap-3 rounded-lg px-2 py-3 text-sm text-muted-foreground"><input type="checkbox" checked disabled className="h-4 w-4 accent-primary"/>Campaign <span className="ml-auto text-xs">Always shown</span></label>{columns.map(column=><label key={column} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-3 text-sm hover:bg-muted/50"><input type="checkbox" className="h-4 w-4 accent-primary" checked={visible.includes(column)} onChange={e=>setVisible(e.target.checked?[...visible,column]:visible.filter(value=>value!==column))}/>{labels[column]}</label>)}</fieldset>
        {saved.length > 0 && <div className="mt-6 space-y-2 border-t pt-5"><h3 className="text-sm font-semibold">Your saved views</h3>{saved.map(view=><div key={view.name} className="flex items-center justify-between gap-2"><Button className="min-w-0 flex-1 justify-start truncate" variant="secondary" onClick={()=>{const query=new URLSearchParams(view.query);navigation.updateQuery(Object.fromEntries(['account','period','platform','status','search','currency','objective'].map(key=>[key,query.get(key)])));setVisible(view.columns.filter(column=>columns.includes(column)));setSort(view.sort);setDescending(view.descending);}}>{view.name}</Button><Button size="icon" variant="ghost" aria-label={`Delete saved view ${view.name}`} onClick={()=>{const next=saved.filter(item=>item.name!==view.name);setSaved(next);localStorage.setItem('asksales-paid-inventory-views-v1',JSON.stringify(next));}}><X aria-hidden="true" className="h-4 w-4"/></Button></div>)}</div>}
      </SheetContent></Sheet>
    </div>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="hidden overflow-x-auto rounded-lg border md:block" aria-busy={loading}><Table><TableHeader><TableRow>{['name',...visible].map(column=><TableHead key={column} aria-sort={sort===column?(descending?'descending':'ascending'):'none'}><button className="py-2 text-left focus-visible:outline focus-visible:outline-2" onClick={()=>{setDescending(sort===column?!descending:false);setSort(column);}}>{column==='name'?'Campaign':labels[column as Column]}{sort===column?(descending?' ↓':' ↑'):''}</button></TableHead>)}</TableRow></TableHeader><TableBody>{visibleRows.map(c=><TableRow key={c.id}><TableCell className="max-w-80"><Link href={href(c)} className="font-medium underline-offset-4 hover:underline">{c.name}</Link></TableCell>{visible.map(column=><TableCell key={column} className="whitespace-nowrap">{cell(c,column)}</TableCell>)}</TableRow>)}</TableBody></Table></div>
    <div className="space-y-3 md:hidden">{visibleRows.map(c=><article key={c.id} className="rounded-lg border p-4"><Link className="font-semibold underline-offset-4 hover:underline" href={href(c)}>{c.name}</Link><div className="mt-2 flex flex-wrap gap-2">{cell(c,'platform')}{cell(c,'status')}{cell(c,'monitoring')}</div><dl className="mt-3 grid grid-cols-2 gap-3">{['spend','results','cost'].map(column=><div key={column}><dt className="text-xs text-muted-foreground">{labels[column as Column]}</dt><dd className="mt-1 text-sm">{cell(c,column as Column)}</dd></div>)}</dl></article>)}</div>
    {dashboard.isFetching&&!dashboard.isPending&&<p role="status" className="text-sm text-muted-foreground">Updating reporting data… Previously loaded campaigns remain visible.</p>}
    {dashboard.isPending&&<p role="status" className="rounded-lg border p-8 text-sm text-muted-foreground">Loading campaign inventory…</p>}
    {!loading&&!filtered.length&&<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No campaigns match these filters. Discover an account and refresh its reporting to load existing campaigns.</p>}
    <Pagination page={currentPage} pageSize={20} totalItems={filtered.length} onPageChange={setPage} itemLabel="campaigns" aria-label="Campaign inventory pages"/>
    <p className="text-xs text-muted-foreground">Results retain their objective labels. Compare costs within the same result type and currency. Saved views are stored in this browser.</p>
  </section>;
}
