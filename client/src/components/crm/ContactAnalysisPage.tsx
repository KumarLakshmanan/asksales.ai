"use client";

import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import Link from 'next/link';
import {FileSpreadsheet,RefreshCw,Upload} from 'lucide-react';
import {api} from '@/lib/api';
import {creatorSessionScope} from '@/lib/creator-session';
import {subscribeBusinessProfile} from '@/lib/business-profile';
import {PageShell} from '@/components/ui/page-shell';
import {PageHeader} from '@/components/ui/page-header';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import {OperationResultCard} from '@/components/operations/OperationResultCard';
import {contactAnalysisFields,type ContactAnalysisField,type ContactAnalysisSummary,type ContactAnalysisOptions,type AnalyzedContactRow} from '../../../../shared/contactAnalysis';
import type {DashboardOperation} from '../../../../shared/dashboardOperations';

const inputClass='h-10 w-full rounded-md border border-input bg-background px-3 text-sm';
const fieldLabels:Record<ContactAnalysisField,string>={skip:'Skip',firstName:'First / full name',lastName:'Last name',email:'Email',phone:'Phone',company:'Company',role:'Role',notes:'Notes',website:'Website',linkedinUrl:'LinkedIn URL'};
type RowPage={items:AnalyzedContactRow[];nextCursor:number|null};
type ImportProgress={importId:number;successCount:number;duplicateCount:number;skippedCount:number;errorCount:number;warningCount:number;totalRecords:number;issues?:Array<{row:number;type:string;message:string}>};

export function ContactAnalysisPage() {
  const scope=useSyncExternalStore(subscribeBusinessProfile,creatorSessionScope,()=> 'anonymous');
  return <ContactAnalysisWizard key={scope} scope={scope}/>;
}
function ContactAnalysisWizard({scope}:{scope:string}) {
  const [files,setFiles]=useState<File[]>([]),[country,setCountry]=useState<'IN'|'none'>('none');
  const [operation,setOperation]=useState<DashboardOperation>(),[operationId,setOperationId]=useState('');
  const [recent,setRecent]=useState<DashboardOperation[]>([]),[error,setError]=useState(''),[pollError,setPollError]=useState('');
  const [busy,setBusy]=useState(false),[uploadPercent,setUploadPercent]=useState(0),[refresh,setRefresh]=useState(0);
  const [rows,setRows]=useState<AnalyzedContactRow[]>([]),[rowStatus,setRowStatus]=useState(''),[nextCursor,setNextCursor]=useState<number|null>(null);
  const [rowsLoading,setRowsLoading]=useState(false),[rowsError,setRowsError]=useState('');
  const [mapping,setMapping]=useState<ContactAnalysisOptions>(),[mappingOpen,setMappingOpen]=useState(false);
  const [editing,setEditing]=useState<AnalyzedContactRow>(),[correction,setCorrection]=useState({firstName:'',lastName:'',phone:'',email:'',company:''});
  const [excludeRow,setExcludeRow]=useState(false);
  const active=useRef(true),working=useRef(false),rowsVersion=useRef(0),uploadKey=useRef(''),revisionKey=useRef('');
  const summary=operation?.kind==='contact_analysis' && operation.result && typeof operation.result==='object' && 'version' in operation.result
    ? operation.result as ContactAnalysisSummary : undefined;
  const imported=operation?.kind==='contact_import' ? operation.result as ImportProgress|null : undefined;
  const current=useCallback(()=>active.current && creatorSessionScope()===scope,[scope]);
  const choose=useCallback((id:string)=>{
    setOperationId(id);setOperation(undefined);setPollError('');setRows([]);
    window.history.replaceState(null,'',`/dashboard/crm/import/analyze?operationId=${encodeURIComponent(id)}`);
  },[]);
  useEffect(()=>{
    active.current=true;
    const id=new URLSearchParams(window.location.search).get('operationId');if(id && /^[a-f0-9-]{36}$/i.test(id))choose(id);
    api.get<{items:DashboardOperation[]}>('/api/crm/contact-analysis').then(result=>{if(current())setRecent(result.items);}).catch(()=>{if(current())setError('Recent operations could not be loaded. You can still upload files or open a saved operation link.');});
    return ()=>{active.current=false;rowsVersion.current++;};
  },[choose,current]);
  useEffect(()=>{
    if(!operationId)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const result=await api.get<DashboardOperation>(`/api/crm/contact-analysis/${operationId}`,{signal:controller.signal});
        if(!current() || controller.signal.aborted)return;
        setOperation(result);setPollError('');
        if(['queued','running'].includes(result.status))timer=setTimeout(poll,2500);
      } catch(e) {
        if(!current() || controller.signal.aborted)return;
        setPollError(e instanceof Error ? e.message : 'Saved progress could not be loaded.');timer=setTimeout(poll,10000);
      }
    };
    void poll();return ()=>{controller.abort();clearTimeout(timer);};
  },[operationId,current,refresh]);
  const loadRows=useCallback(async(cursor=0)=>{
    if(!operationId)return;
    const version=++rowsVersion.current;setRowsLoading(true);setRowsError('');
    try {
      const page=await api.get<RowPage>(`/api/crm/contact-analysis/${operationId}/rows`,{params:{after:cursor,...(rowStatus ? {status:rowStatus} : {})}});
      if(!current() || version!==rowsVersion.current)return;
      setRows(previous=>cursor ? [...previous,...page.items] : page.items);setNextCursor(page.nextCursor);
    } catch(e) {if(current() && version===rowsVersion.current)setRowsError(e instanceof Error ? e.message : 'Rows could not be loaded.');}
    finally {if(current() && version===rowsVersion.current)setRowsLoading(false);}
  },[operationId,rowStatus,current]);
  useEffect(()=>{
    setRows([]);setNextCursor(null);rowsVersion.current++;
    if(operation?.kind==='contact_analysis' && operation.status==='ready')void loadRows();
  },[operation?.kind,operation?.status,loadRows]);
  const mutate=async(action:()=>Promise<DashboardOperation>)=>{
    if(working.current)return;
    working.current=true;setBusy(true);setError('');
    try {
      const result=await action();if(!current())return;
      choose(result.id);setOperation(result);setRecent(previous=>[result,...previous.filter(item=>item.id!==result.id)]);setMappingOpen(false);setEditing(undefined);
    } catch(e) {if(current())setError(e instanceof Error ? e.message : 'The operation could not be started.');}
    finally {working.current=false;if(current())setBusy(false);}
  };
  const analyze=()=>void mutate(async()=>{
    if(!files.length)throw new Error('Choose at least one contact file.');
    if(files.length>20 || files.some(file=>file.size>25*1024*1024) || files.reduce((sum,file)=>sum+file.size,0)>100*1024*1024)throw new Error('Choose up to 20 files, at most 25 MB each and 100 MB combined.');
    if(!uploadKey.current)uploadKey.current=crypto.randomUUID();
    const form=new FormData();files.forEach(file=>form.append('files',file));form.append('options',JSON.stringify({defaultCountry:country}));form.append('requestKey',uploadKey.current);
    setUploadPercent(0);
    return api.postForm<DashboardOperation>('/api/crm/contact-analysis',form,{onUploadProgress:percent=>{if(current())setUploadPercent(percent);}});
  });
  const revise=(options:ContactAnalysisOptions)=>void mutate(()=>{
    if(!revisionKey.current)revisionKey.current=crypto.randomUUID();
    return api.post<DashboardOperation>(`/api/crm/contact-analysis/${operationId}/reanalyze`,{options,requestKey:revisionKey.current});
  });
  const openMapping=()=>{
    if(!summary)return;
    revisionKey.current='';setMapping({...summary.options,sheets:summary.sheets.map(sheet=>({fileHash:sheet.fileHash,sheetName:sheet.sheetName,included:sheet.included,headerRow:sheet.headerRow,mapping:Object.fromEntries(sheet.columns.map(col=>[col.key,col.field]))}))});setMappingOpen(true);
  };
  const edit=(row:AnalyzedContactRow)=>{
    const sheet=summary?.sheets.find(s=>s.fileHash===row.fileHash && s.sheetName===row.sheetName);
    const value=(field:'phone'|'email')=>row.contact[field] || row.raw[sheet?.columns.find(col=>col.field===field)?.key || ''] || '';
    revisionKey.current='';setCorrection({firstName:row.contact.firstName || '',lastName:row.contact.lastName || '',company:row.contact.company || '',phone:value('phone'),email:value('email')});setExcludeRow(row.status==='excluded');setEditing(row);
  };
  const saveCorrection=()=>{
    if(!summary || !editing)return;
    const prior=(summary.options.rows || []).filter(row=>!(row.fileHash===editing.fileHash && row.sheetName===editing.sheetName && row.rowNumber===editing.rowNumber));
    revise({...summary.options,rows:[...prior,{fileHash:editing.fileHash,sheetName:editing.sheetName,rowNumber:editing.rowNumber,contact:correction,excluded:excludeRow}]});
  };
  return <PageShell>
    <PageHeader icon={FileSpreadsheet} title="Analyze and import contacts" subtitle="Combine Excel worksheets and CSV files, review unique contacts, then import the ready audience."
      actions={<Button asChild variant="outline"><Link href="/dashboard/crm/contacts">Open contacts</Link></Button>}/>
    <ol aria-label="Import steps" className="grid gap-2 text-sm sm:grid-cols-3">{['1. Upload files','2. Review analysis','3. Import contacts'].map((step,index)=><li key={step} className={`rounded-lg border p-3 ${index===(operation?.kind==='contact_import' ? 2 : summary ? 1 : 0) ? 'border-primary bg-primary/5 font-semibold' : 'text-muted-foreground'}`}>{step}</li>)}</ol>
    <section className="space-y-4 rounded-xl border bg-card p-4" aria-label="Contact files">
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="contact-files">Excel, CSV or TSV files</Label><Input id="contact-files" type="file" multiple accept=".xlsx,.xls,.csv,.tsv" disabled={busy} onChange={e=>{setFiles(Array.from(e.target.files || []));uploadKey.current='';setError('');setOperationId('');setOperation(undefined);setRows([]);window.history.replaceState(null,'','/dashboard/crm/import/analyze');}}/></div>
        <div className="space-y-2"><Label htmlFor="phone-country">Country for local phone numbers</Label><select id="phone-country" className={inputClass} disabled={busy} value={country} onChange={e=>{setCountry(e.target.value as 'IN'|'none');uploadKey.current='';}}><option value="none">Use international numbers as entered</option><option value="IN">India (+91)</option></select></div></div>
      <p className="text-xs text-muted-foreground">Up to 20 files · 25 MB per file · 100 MB combined. Exact file copies are counted once. Source data is retained for 30 days so interrupted work can resume.</p>
      {!!files.length && <ul className="flex flex-wrap gap-2 text-xs">{files.map((file,index)=><li key={index} className="rounded-md bg-muted p-2">{file.name} · {(file.size/1024).toFixed(0)} KB</li>)}</ul>}
      <Button disabled={busy || !files.length} onClick={analyze}><Upload className="mr-2 h-4 w-4"/>{busy ? `Uploading… ${uploadPercent}%` : 'Analyze files'}</Button>
    </section>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {pollError && <div role="alert" className="rounded-lg border border-amber-400/40 p-3 text-sm">{pollError} Displayed progress is the last saved result. <Button variant="outline" size="sm" onClick={()=>setRefresh(value=>value+1)}>Check again</Button></div>}
    {operationId && !operation && !pollError && <p role="status">Loading saved operation…</p>}
    {operation && <><OperationResultCard result={operation.card}/><p className="text-xs text-muted-foreground">Staged files and downloads expire {new Date(operation.expiresAt).toLocaleString()}.</p>
      {['review','failed','queued'].includes(operation.status) && <Button disabled={busy} variant="outline" onClick={()=>void mutate(()=>api.post<DashboardOperation>(`/api/crm/contact-analysis/${operation.id}/resume`))}><RefreshCw className="mr-2 h-4 w-4"/>Resume saved operation</Button>}
    </>}
    {summary && <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
        ['Unique contacts',summary.totals.uniqueContacts],['Phone entries',summary.totals.uniquePhoneEntries],['Unique emails',summary.totals.uniqueEmails],['Indian mobile format',summary.totals.indianMobileNumbers],
        ['Duplicate files',summary.totals.duplicateFiles],['Duplicate rows',summary.totals.duplicateRows],['Need review',summary.totals.reviewContacts+summary.totals.invalidRows],['Ready to import',summary.totals.readyContacts],
      ].map(([label,value])=><div key={label} className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{Number(value).toLocaleString()}</p></div>)}</div>
      <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Review this audience</h2><p className="text-sm">Analyzed files: {summary.files.map(file=>file.name).join(', ')}. Local phone country: {summary.defaultCountry==='IN' ? 'India (+91)' : 'International numbers as entered'}.</p><p className="text-sm text-muted-foreground">{summary.definitions.identity}</p><p className="text-xs text-muted-foreground">{summary.definitions.phones} {summary.definitions.consent}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={openMapping} disabled={busy}>Review worksheet mapping</Button><Button disabled={busy || !summary.totals.readyContacts || operation?.status!=='ready'} onClick={()=>void mutate(()=>api.post<DashboardOperation>(`/api/crm/contact-analysis/${operationId}/import`,{requestKey:`import-${operationId}`}))}>Import {summary.totals.readyContacts.toLocaleString()} ready contacts</Button></div>
        <p className="text-xs text-muted-foreground">Flagged, duplicate and excluded rows stay out of this import. Marketing messages are prepared and reviewed separately.</p>
        {summary.defaultCountry==='none' && (summary.issueCounts?.country_code_required || 0)>0 && <div role="status" className="space-y-2 rounded-lg border border-amber-400/40 p-3 text-sm">
          <p>{summary.issueCounts!.country_code_required.toLocaleString()} {summary.issueCounts!.country_code_required===1 ? 'row has a local phone number' : 'rows have local phone numbers'} without a country code, so {summary.issueCounts!.country_code_required===1 ? 'it is' : 'they are'} held for review.</p>
          <Button size="sm" variant="outline" disabled={busy || operation?.status!=='ready'} onClick={()=>{revisionKey.current='';revise({...summary.options,defaultCountry:'IN'});}}>Re-check these numbers as India (+91)</Button>
        </div>}
        {!summary.totals.readyContacts && operation?.status==='ready' && (summary.totals.reviewContacts+summary.totals.invalidRows)>0 && <p role="status" className="text-sm">
          No contacts are ready to import yet. Each held row shows its reason below; correct or exclude it, then import.{' '}
          <Button size="sm" variant="link" className="h-auto p-0" onClick={()=>setRowStatus('review')}>Show rows that need review</Button>
        </p>}
        {summary.files.filter(file=>file.duplicateOf).map((file,index)=><p key={index} className="text-sm">Duplicate file skipped: {file.name} matches {file.duplicateOf}.</p>)}
        {summary.sheets.flatMap(sheet=>sheet.warnings.map((warning,index)=><p key={`${sheet.fileHash}:${sheet.sheetName}:${index}`} className="text-sm text-amber-700 dark:text-amber-300">{sheet.fileName} / {sheet.sheetName}: {warning}</p>))}
      </section>
      <section className="space-y-3" aria-label="Contact row preview"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Source rows</h2><Label>Show rows<select className={inputClass} value={rowStatus} onChange={e=>setRowStatus(e.target.value)}><option value="">All rows</option><option value="ready">Ready to import</option><option value="review">Needs review</option><option value="invalid">Invalid identifiers</option><option value="duplicate">Duplicate rows</option><option value="excluded">Excluded rows</option></select></Label></div>
        {rowsError && <p role="alert" className="text-sm text-destructive">{rowsError} <Button variant="outline" size="sm" onClick={()=>void loadRows()}>Try again</Button></p>}
        <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><thead className="bg-muted"><tr>{['Contact','Phone / email','Source','Status','Review'].map(label=><th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.key} className="border-t"><td className="p-3">{[row.contact.firstName,row.contact.lastName].filter(Boolean).join(' ') || 'Unnamed contact'}</td><td className="p-3"><p>{row.contact.phone || row.phoneKey || '—'}</p><p className="text-xs text-muted-foreground">{row.contact.email || '—'}</p></td><td className="p-3 text-xs">{row.fileName}<br/>{row.sheetName} · row {row.rowNumber}</td><td className="p-3"><p className="capitalize">{row.status}</p>{row.issues.map((issue,index)=><p key={index} className="mt-1 max-w-64 text-xs text-muted-foreground">{issue.message}</p>)}</td><td className="p-3"><Button size="sm" variant="outline" onClick={()=>edit(row)} disabled={busy}>Review row {row.rowNumber}</Button></td></tr>)}{!rows.length && !rowsLoading && !rowsError && <tr><td colSpan={5} className="p-4 text-muted-foreground">No rows match this view.</td></tr>}</tbody></table></div>
        {rowsLoading && <p role="status">Loading rows…</p>}{nextCursor!==null && <Button variant="outline" disabled={rowsLoading} onClick={()=>void loadRows(nextCursor)}>Load more rows</Button>}
      </section>
    </>}
    {imported && <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">CRM import receipts</h2><p className="text-sm">{imported.successCount} saved · {imported.duplicateCount} duplicates · {imported.skippedCount} skipped · {imported.errorCount} failed · {imported.warningCount} with warnings</p><p className="text-sm text-muted-foreground">Import #{imported.importId}. Existing committed receipts are reused when this operation resumes.</p>{!!imported.issues?.length && <div><p className="text-xs text-muted-foreground">First 20 recorded issues</p><ul className="mt-2 space-y-2">{imported.issues.map((issue,index)=><li key={index} className="rounded-md bg-muted p-2 text-sm">Import row {issue.row}: {issue.message}</li>)}</ul></div>}<Button asChild variant="outline"><Link href={`/dashboard/outreach/prepare?importOperationId=${operationId}`}>Prepare outreach</Link></Button></section>}
    {!!recent.length && <section className="space-y-2"><h2 className="font-semibold">Recent operations</h2><div className="flex flex-wrap gap-2">{recent.slice(0,12).map(item=><Button key={item.id} variant="outline" size="sm" onClick={()=>choose(item.id)}>{item.kind==='contact_analysis' ? 'Analysis' : 'Import'} · {new Date(item.createdAt).toLocaleDateString()} · {item.status}</Button>)}</div></section>}
    <Sheet open={mappingOpen} onOpenChange={setMappingOpen}><SheetContent className="w-full overflow-y-auto sm:max-w-xl"><SheetHeader><SheetTitle>Worksheet mapping</SheetTitle><SheetDescription>Choose which worksheets and contact columns to analyze. Applying changes creates a fresh preview.</SheetDescription></SheetHeader>
      <Label className="mt-5 block">Default phone country for this preview<select className={inputClass} value={mapping?.defaultCountry || 'none'} onChange={e=>{revisionKey.current='';setMapping(value=>({...value!,defaultCountry:e.target.value as 'IN'|'none'}));}}><option value="none">International numbers as entered</option><option value="IN">India (+91)</option></select></Label>
      <div className="mt-6 space-y-5">{mapping?.sheets?.map((sheet,index)=><section key={`${sheet.fileHash}:${sheet.sheetName}`} className="space-y-3 rounded-lg border p-3"><Label className="flex items-center gap-2"><input type="checkbox" checked={sheet.included} onChange={e=>{revisionKey.current='';setMapping(value=>({...value!,sheets:value!.sheets!.map((s,i)=>i===index ? {...s,included:e.target.checked} : s)}));}}/>{summary?.sheets[index]?.fileName} / {sheet.sheetName}</Label><Label>Header row<Input type="number" min={1} value={sheet.headerRow} onChange={e=>{revisionKey.current='';setMapping(value=>({...value!,sheets:value!.sheets!.map((s,i)=>i===index ? {...s,headerRow:Number(e.target.value)} : s)}));}}/></Label>
        {Object.entries(sheet.mapping || {}).map(([column,field])=><Label key={column} className="block">{column} · {summary?.sheets[index]?.columns.find(c=>c.key===column)?.label}<select className={inputClass} value={field} onChange={e=>{revisionKey.current='';setMapping(value=>({...value!,sheets:value!.sheets!.map((s,i)=>i===index ? {...s,mapping:{...s.mapping,[column]:e.target.value as ContactAnalysisField}} : s)}));}}>{contactAnalysisFields.map(field=><option key={field} value={field}>{fieldLabels[field]}</option>)}</select></Label>)}</section>)}
        <Button disabled={busy || !mapping} onClick={()=>mapping && revise(mapping)}>Apply mapping and reanalyze</Button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div></SheetContent></Sheet>
    <Sheet open={Boolean(editing)} onOpenChange={open=>{if(!open)setEditing(undefined);}}><SheetContent className="w-full overflow-y-auto sm:max-w-xl"><SheetHeader><SheetTitle>Review contact row {editing?.rowNumber}</SheetTitle><SheetDescription>{editing?.fileName} / {editing?.sheetName}. Corrections are reanalyzed before any CRM import.</SheetDescription></SheetHeader><div className="mt-6 space-y-4">
      {editing?.issues.map((issue,index)=><p key={index} className="rounded-md bg-muted p-3 text-sm">{issue.message}</p>)}
      {Object.entries(correction).map(([field,value])=><Label key={field} className="block">{fieldLabels[field as ContactAnalysisField]}<Input value={value} onChange={e=>{revisionKey.current='';setCorrection(previous=>({...previous,[field]:e.target.value}));}}/></Label>)}
      <Label className="flex items-center gap-2"><input type="checkbox" checked={excludeRow} onChange={e=>{revisionKey.current='';setExcludeRow(e.target.checked);}}/>Exclude this row from the audience</Label>
      <Button disabled={busy} onClick={saveCorrection}>Save correction and reanalyze</Button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div></SheetContent></Sheet>
  </PageShell>;
}
