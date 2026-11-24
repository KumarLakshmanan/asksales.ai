"use client";

import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import Link from 'next/link';
import {BarChart3,RefreshCw} from 'lucide-react';
import {api} from '@/lib/api';
import {creatorSessionScope} from '@/lib/creator-session';
import {subscribeBusinessProfile} from '@/lib/business-profile';
import {PageShell} from '@/components/ui/page-shell';
import {PageHeader} from '@/components/ui/page-header';
import {Button} from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Card,CardContent} from '@/components/ui/card';
import {ChatOperationResults} from '@/components/operations/ChatOperationResults';
import type {CampaignExportOperation} from '../../../../../shared/campaignExports';
import {campaignReportUrl,outreachReportChannels,type CampaignReport,type CampaignReportFilters,type CampaignReportOptions} from '../../../../../shared/campaignReporting';
import {trackingChannelLabel} from '../../../../../shared/outreachTracking';
import {plainDeliveryReason} from '@/lib/outreach-delivery-status';

type Filters = Partial<CampaignReportFilters>;
const selectClass='h-10 w-full rounded-md border border-input bg-background px-3 text-sm';
const showTime=(value:string|null)=>value ? new Date(value).toLocaleString() : 'Not yet scheduled';
const plural=(count:number,one:string,many=`${one}s`)=>`${count.toLocaleString()} ${count===1 ? one : many}`;
/** Email addresses read as they are; long provider IDs are shortened to their last digits. */
const accountLabel=(id:string)=>id.includes('@') || id.length<=8 ? id : `ending ${id.slice(-4)}`;
/** Channels whose provider sends no delivery receipt, so Delivered stays at zero. */
const noReceiptChannels=new Set(['sms','linkedin','twitter']);
const initialFilters=(): Filters=>{
  if(typeof window==='undefined') return {};
  const query=new URLSearchParams(window.location.search);
  return Object.fromEntries([...query.entries()].filter(([key])=>['workspaceId','campaignId','preparedOutreachId','importId','importSource','channel','accountId','from','to','messageKind'].includes(key))) as Filters;
};

export function CampaignReportView() {
  const scope=useSyncExternalStore(subscribeBusinessProfile,creatorSessionScope,()=> 'anonymous');
  return <CampaignReportPanel key={scope} scope={scope}/>;
}
function CampaignReportPanel({scope}:{scope:string}) {
  const [filters,setFilters]=useState<Filters>({});
  const [options,setOptions]=useState<CampaignReportOptions>();
  const [report,setReport]=useState<CampaignReport>();
  const [exportOperation,setExportOperation]=useState<CampaignExportOperation>(),[exporting,setExporting]=useState(false);
  const exportRequest=useRef({fingerprint:'',key:''}),exportPending=useRef(false);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[optionError,setOptionError]=useState('');
  const request=useRef(0);
  const load=useCallback(async (next:Filters)=>{
    const version=++request.current;
    setLoading(true);setError('');setReport(undefined);
    const params=Object.fromEntries(Object.entries(next).filter(([,value])=>value!==undefined && value!==''));
    try {
      // The default 30-second read deadline already outlasts the server's 25-second query limit
      // (server/tenancy/statementTimeout.ts), which answers a slow report with its own message.
      const data=await api.get<CampaignReport>('/api/outreach/reports',{params});
      if(version!==request.current || creatorSessionScope()!==scope) return;
      setReport(data);
      window.history.replaceState(null,'',data.links.report);
    } catch(e) {if(version===request.current) setError(e instanceof Error ? e.message : 'Report unavailable. Try again.');}
    finally {if(version===request.current) setLoading(false);}
  },[scope]);
  useEffect(()=>{
    const next=initialFilters();setFilters(next);void load(next);
    let active=true;
    api.get<CampaignReportOptions>('/api/outreach/reports/options').then(data=>{if(active)setOptions(data);}).catch(()=>{if(active)setOptionError('Filter choices could not be loaded. Refresh the page to retry.');});
    return ()=>{active=false;request.current++;};
  },[load]);
  const change=(key:keyof Filters,value:string)=>setFilters(current=>({...current,[key]:value || undefined}));
  async function createExport() {
    if(!report || exportPending.current)return;exportPending.current=true;setExporting(true);setError('');
    const fingerprint=JSON.stringify(report.filters);if(exportRequest.current.fingerprint!==fingerprint)exportRequest.current={fingerprint,key:crypto.randomUUID()};
    try {const result=await api.post<CampaignExportOperation>('/api/outreach/reports/exports',{name:'Campaign delivery report',filters:report.filters,requestKey:exportRequest.current.key});
      if(creatorSessionScope()===scope) {setExportOperation(result);exportRequest.current={fingerprint:'',key:''};}}
    catch(reason) {if(creatorSessionScope()===scope)setError(reason instanceof Error ? reason.message : 'The report could not be generated. Retry to recover the same request.');}
    finally {exportPending.current=false;if(creatorSessionScope()===scope)setExporting(false);}
  }
  const day=(value:string|undefined)=>value?.slice(0,10) || '';
  const dirty=report && Object.entries({...filters,...report.filters}).some(([key])=>String((filters as Record<string,unknown>)[key] ?? (key==='messageKind' ? 'outreach' : ''))!==String((report.filters as unknown as Record<string,unknown>)[key] ?? ''));
  /** A filter with nothing to choose from is disabled and says why, instead of offering only "All". */
  const empty=(key:'workspaces'|'campaigns'|'preparedCampaigns'|'imports')=>Boolean(options) && !(options?.[key]?.length);
  const accounts=options?.accounts.filter(a=>!filters.channel || a.channel===filters.channel) ?? [];
  const field=(label:string,node:React.ReactNode)=><div className="space-y-2"><Label>{label}{node}</Label></div>;
  return <PageShell>
    <PageHeader icon={BarChart3} title="Campaign reports" subtitle="Delivery receipts, customer responses and retry schedules from your saved outreach records."
      actions={<><Button asChild variant="outline"><Link href="/dashboard/outreach/tracking">Message tracking</Link></Button><Button asChild variant="outline"><Link href="/dashboard/crm">Open contacts</Link></Button><Button asChild variant="outline"><Link href="/dashboard/outreach/activity">Campaign activity</Link></Button></>}/>
    <form onSubmit={event=>{event.preventDefault();void load(filters);}} className="rounded-xl border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {field('Campaign workspace',<select className={selectClass} disabled={empty('workspaces')} value={filters.workspaceId ?? ''} onChange={e=>change('workspaceId',e.target.value)}><option value="">{empty('workspaces') ? 'No campaign workspaces yet' : 'All workspaces'}</option>{options?.workspaces.map(w=><option key={w.id} value={w.id}>{w.name || `Workspace ${w.id}`}</option>)}</select>)}
        {field('Outreach campaign',<select className={selectClass} disabled={empty('campaigns')} value={filters.campaignId ?? ''} onChange={e=>change('campaignId',e.target.value)}><option value="">{empty('campaigns') ? 'No saved outreach campaigns' : 'All outreach campaigns'}</option>{options?.campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>)}
        {field('Prepared outreach',<select className={selectClass} disabled={empty('preparedCampaigns')} value={filters.preparedOutreachId ?? ''} onChange={event=>change('preparedOutreachId',event.target.value)}><option value="">{empty('preparedCampaigns') ? 'None prepared in chat yet' : 'All prepared campaigns'}</option>{options?.preparedCampaigns?.map(campaign=><option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select>)}
        {field('Imported audience',<select className={selectClass} disabled={empty('imports')} value={filters.importId ? `${filters.importSource}:${filters.importId}` : ''} onChange={e=>{const [source,id]=e.target.value.split(':');setFilters(f=>({...f,importSource:source as Filters['importSource'] || undefined,importId:id ? Number(id) : undefined}));}}><option value="">{empty('imports') ? 'No imported audiences yet' : 'All audiences'}</option>{options?.imports.map(i=><option key={`${i.source}:${i.id}`} value={`${i.source}:${i.id}`}>{i.name} · {i.source==='crm' ? 'CRM' : 'Campaign'}</option>)}</select>)}
        {field('Channel',<select className={selectClass} value={filters.channel ?? ''} onChange={e=>{change('channel',e.target.value);change('accountId','');}}><option value="">All channels</option>{outreachReportChannels.map(c=><option key={c} value={c}>{trackingChannelLabel(c)}</option>)}</select>)}
        {field('Sending account',<select className={selectClass} disabled={Boolean(options) && !accounts.length} value={filters.accountId ?? ''} onChange={e=>change('accountId',e.target.value)}><option value="">{options && !accounts.length ? (filters.channel ? `No ${trackingChannelLabel(filters.channel)} accounts used yet` : 'No sending accounts used yet') : 'All accounts'}</option>{accounts.map(a=><option key={`${a.channel}:${a.id}`} value={a.id} title={`${trackingChannelLabel(a.channel)} account ${a.id}`}>{filters.channel ? `Account ${accountLabel(a.id)}` : `${trackingChannelLabel(a.channel)} · ${accountLabel(a.id)}`}</option>)}</select>)}
        {field('Outbound messages',<select className={selectClass} value={filters.messageKind || 'outreach'} onChange={e=>change('messageKind',e.target.value)}><option value="outreach">Initial outreach</option><option value="follow_up">Follow-ups</option><option value="all">Outreach and follow-ups</option></select>)}
        {field('Created on or after (UTC)',<Input type="date" value={day(filters.from)} onChange={e=>change('from',e.target.value ? `${e.target.value}T00:00:00Z` : '')}/>)}
        {field('Created before (UTC)',<Input type="date" value={day(filters.to)} onChange={e=>change('to',e.target.value ? `${e.target.value}T00:00:00Z` : '')}/>)}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">Workspace and import filters use saved recipient membership. They can include other outreach to the same audience; choose an outreach campaign or creation dates to narrow the report.</p>
      {optionError && <p role="alert" className="mt-2 text-sm text-destructive">{optionError}</p>}
      <div className="mt-4 flex gap-2"><Button type="submit" loading={loading} loadingText="Loading report…"><RefreshCw className="mr-2 h-4 w-4"/>Apply filters</Button><Button type="button" variant="outline" onClick={()=>{setFilters({});void load({});}}>Reset</Button></div>
    </form>
    {error && <Callout tone="danger">{error}</Callout>}
    {loading && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Loading the latest saved records… Accounts with tens of thousands of messages can take up to half a minute.</p>}
    {report && <>
      {dirty && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Filters changed. Apply them to refresh the displayed report.</p>}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-sm text-muted-foreground">Snapshot {showTime(report.checkedAt)} · {plural(report.uniqueRecipients,'distinct recipient')} · {plural(report.counts.total,'message')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild><Link href={campaignReportUrl(report.filters).replace('/outreach/reports','/outreach/engagement')}>View customer engagement</Link></Button>
          <Button variant="outline" size="sm" asChild><Link href={campaignReportUrl(report.filters).replace('/outreach/reports','/outreach/retries')}>Review eligible retries</Link></Button>
          <Button variant="outline" size="sm" onClick={()=>void createExport()} disabled={exporting}>{exporting ? 'Preparing downloads…' : 'Download report'}</Button>
        </div>
      </div>
      {exportOperation && <ChatOperationResults results={[exportOperation.card]}/>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([
          ['Provider accepted',report.counts.accepted,'Includes delivered and awaiting confirmation'],
          ['Confirmed delivered',report.counts.delivered,'Delivery or read receipt recorded'],
          ['Awaiting confirmation',report.counts.awaitingConfirmation,'Already included in accepted'],
          ['Queued',report.counts.queued,`${report.counts.retrying} waiting for a retry`],
          ['Processing',report.counts.processing,'Currently being processed'],
          ['Failed',report.counts.failed,'See recorded reasons below'],
          ['Needs review',report.counts.review,'Requires a supported review action'],
          ['Responding customers',report.engagement.respondingCustomers,`${report.engagement.responseRate}% of all selected recipients`],
        ] as const).map(([label,value,hint])=><Card key={label}><CardContent className="p-4"><p className="text-sm font-medium">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p><p className="mt-1 text-xs text-muted-foreground">{hint}</p></CardContent></Card>)}
      </div>
      <Card><CardContent className="space-y-3 p-4"><h2 className="font-semibold">Customer engagement</h2><p className="text-sm">{plural(report.engagement.inboundResponses,'customer response')} from {plural(report.engagement.respondingCustomers,'customer')}</p><ul className="flex flex-wrap gap-2 text-sm">{([
          [report.engagement.typedReplies,'typed reply','typed replies'],
          [report.engagement.quickReplies,'quick reply','quick replies'],
          [report.engagement.menuSelections,'menu selection'],
          [report.engagement.otherResponses,'other response'],
          [report.engagement.assistantReplies,'AI reply','AI replies'],
        ] as Array<[number,string,string?]>).filter(([count],index)=>count>0 || index===0).map(([count,one,many])=><li key={one} className="rounded-full bg-muted px-3 py-1">{plural(count,one,many)}</li>)}</ul><p className="text-sm">Next queued attempt: {showTime(report.nextAttemptAt)}</p><p className="text-xs text-muted-foreground">{report.definitions.attribution} {report.definitions.history}</p><p className="text-xs text-muted-foreground">{report.definitions.clicks}</p></CardContent></Card>
      <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><caption className="p-4 text-left font-semibold">Delivery by channel</caption><thead className="bg-muted"><tr>{['Channel','Accepted','Delivered','Queued','Failed','Next attempt'].map(h=><th key={h} className="whitespace-nowrap p-3 font-medium">{h}</th>)}</tr></thead><tbody>{report.channels.map(c=><tr key={c.channel} className="border-t"><th scope="row" className="p-3 font-medium">{trackingChannelLabel(c.channel)}</th><td className="p-3 tabular-nums">{c.accepted.toLocaleString()}</td><td className="p-3 tabular-nums">{noReceiptChannels.has(c.channel) && !c.delivered ? <span className="text-muted-foreground" title="This channel doesn't send delivery receipts">Not reported</span> : c.delivered.toLocaleString()}</td><td className="p-3 tabular-nums">{c.queued.toLocaleString()}</td><td className="p-3 tabular-nums">{c.failed.toLocaleString()}</td><td className="p-3">{showTime(c.nextAttemptAt)}</td></tr>)}{!report.channels.length && <tr><td colSpan={6} className="p-4 text-muted-foreground">No outreach matches these filters.</td></tr>}</tbody></table>{report.channels.some(c=>c.channel==='email' && c.accepted>0 && !c.delivered) && <p className="border-t p-3 text-xs text-muted-foreground">Gmail doesn't send delivery receipts, so email sent through Gmail counts as accepted, not delivered. Opens and replies still show here and on the engagement page.</p>}{report.channels.some(c=>c.channel==='instagram' && c.accepted>0) && <p className="border-t p-3 text-xs text-muted-foreground">Instagram reports when a message is seen, not when it's delivered, so Instagram messages count as delivered once they're read.</p>}</div>
      <Card><CardContent className="p-4"><h2 className="font-semibold">Failures and review reasons</h2>{!report.failures.length ? <p className="mt-3 text-sm text-muted-foreground">No failed messages or review items in this report.</p> : <ul className="mt-3 space-y-2">{report.failures.map((f,index)=><li key={index} className="rounded-md bg-muted p-3 text-sm"><strong>{plural(f.count,'message')} · {trackingChannelLabel(f.channel)}</strong>{f.code && /^\d+$/.test(f.code) && <span className="ml-2 text-xs text-muted-foreground">Provider code {f.code}</span>}<p className="mt-1 break-words">{plainDeliveryReason(f.reason)}</p></li>)}</ul>}</CardContent></Card>
    </>}
  </PageShell>;
}
