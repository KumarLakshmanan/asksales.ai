"use client";

import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { Edit3, Eye, FileText, Plus, Send, Trash2, TriangleAlert, Check, CheckCircle2, Info } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ProposalPageHeader } from "@/components/proposals/ProposalPageHeader";
import styles from "@/components/proposals/proposals.module.css";
import { useRouter } from "next/navigation";

type Proposal={id:number;proposalNumber:string;title:string;recipientName:string|null;recipientEmail:string|null;status:string;currency:string;total:string;validUntil:string|null;sentAt:string|null;createdAt:string;updatedAt:string;lastActivityAt:string;owner:{id:number;name:string;email?:string|null}|null;metadata?:{teamApproval?:{status?:string};onboarding?:{status?:string}}};
type Analytics={total:number;draft:number;sent:number;viewed:number;accepted:number;rejected:number;expired:number;delivery_unknown:number;acceptanceRate:number;funnel?:{created:number;delivered:number;viewed:number;decided:number;accepted:number}};
const statusConfig:Record<string,{label:string;tone:StatusTone}>={draft:{label:"Draft",tone:"neutral"},sending:{label:"Sending",tone:"progress"},delivery_unknown:{label:"Delivery review",tone:"warning"},sent:{label:"Sent",tone:"info"},viewed:{label:"Viewed",tone:"progress"},accepted:{label:"Accepted",tone:"success"},rejected:{label:"Declined",tone:"danger"},expired:{label:"Expired",tone:"warning"},superseded:{label:"Superseded",tone:"neutral"}};

export default function ProposalsPage(){
  const router=useRouter();
  const [proposals,setProposals]=useState<Proposal[]>([]),[analytics,setAnalytics]=useState<Analytics>(),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [search,setSearch]=useState(""),deferredSearch=useDeferredValue(search),[status,setStatus]=useState("all"),[attention,setAttention]=useState("all"),[sort,setSort]=useState("updated");
  const [page,setPage]=useState(1),[total,setTotal]=useState(0),[deleteId,setDeleteId]=useState<number|null>(null),[deleting,setDeleting]=useState(false);
  const hasActiveFilters=Boolean(search)||status!=="all"||attention!=="all";
  const noProposalsYet=!hasActiveFilters&&analytics?.total===0;
  const load=useCallback(async()=>{setLoading(true);setError("");try{const query=new URLSearchParams({page:String(page),limit:"25",sort});if(deferredSearch)query.set("search",deferredSearch);if(status!=="all")query.set("status",status);if(attention!=="all")query.set("attention",attention);const data=await api.get<{proposals:Proposal[];total:number;totalPages:number}>(`/api/proposals?${query}`);setProposals(data.proposals||[]);setTotal(data.total||0);}catch(failure){setError(failure instanceof ApiError?failure.message:"Proposals could not be loaded.");}finally{setLoading(false);}},[page,sort,deferredSearch,status,attention]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{void api.get<Analytics>("/api/proposals/analytics").then(setAnalytics).catch(()=>{});},[]);
  const resetPage=()=>setPage(1);
  const remove=async()=>{if(!deleteId)return;setDeleting(true);try{await api.delete(`/api/proposals/${deleteId}`);setDeleteId(null);await load();setAnalytics(await api.get<Analytics>("/api/proposals/analytics"));}catch(failure){setError(failure instanceof ApiError?failure.message:"The proposal could not be deleted.");}finally{setDeleting(false);}};


  const metrics = analytics ? [
    {label:"Created", value:analytics.funnel?.created??analytics.total, icon:FileText},
    {label:"Delivered", value:analytics.funnel?.delivered??analytics.sent, icon:Send},
    {label:"Viewed", value:analytics.funnel?.viewed??analytics.viewed, icon:Eye},
    {label:"Decided", value:analytics.funnel?.decided??(analytics.accepted+analytics.rejected), icon:CheckCircle2},
    {label:"Accepted", value:`${analytics.accepted} · ${analytics.acceptanceRate}%`, icon:Check, help:"Accepted / decided"},
  ] : [];
  return <div className={`page-shell ${styles.workspace} [&_button]:min-h-10`}>
    <ProposalPageHeader title="Proposals" description="Turn customer context into offers, decisions, and onboarding." actions={<>
      <Button variant="outline" onClick={()=>router.push("/dashboard/proposals/settings")}>Proposal settings</Button>
      <Button variant="outline" onClick={()=>router.push("/dashboard/proposals/catalog")}>Catalog</Button>
      <Button variant="outline" onClick={()=>router.push("/dashboard/proposals/templates")}>Templates</Button>
      <Button variant="outline" onClick={()=>router.push("/dashboard/proposals/analytics")}>Analytics</Button>
      <Button onClick={()=>router.push("/dashboard/proposals/new")}><Plus aria-hidden="true"/>New proposal</Button>
    </>}/>
    {analytics && <section aria-label="Proposal funnel">
      <p className="mb-3 text-sm font-semibold">All proposals</p>
      <div className={styles.funnel}>{metrics.map(metric=><div key={metric.label} className={styles.metric}>
        <span className={styles.metricIcon}><metric.icon aria-hidden="true" className="h-5 w-5"/></span>
        <div className="min-w-0"><p className={styles.metricLabel}>{metric.label}</p><p className={styles.metricValue}>{metric.value}</p>{metric.help&&<p className={styles.metricHelp}>{metric.help}</p>}</div>
      </div>)}</div>
    </section>}
    <section className={styles.filters} aria-label="Proposal filters">
      <SearchInput aria-label="Search proposals" value={search} onValueChange={value=>{setSearch(value);resetPage();}} wrapperClassName={styles.search} placeholder="Search title or proposal number"/>
      <Select value={status} onValueChange={value=>{setStatus(value);resetPage();}}><SelectTrigger className="w-44" aria-label="Status filter"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{Object.entries(statusConfig).map(([value,config])=><SelectItem key={value} value={value}>{config.label}</SelectItem>)}</SelectContent></Select>
      <Select value={attention} onValueChange={value=>{setAttention(value);resetPage();}}><SelectTrigger className="w-48" aria-label="Attention filter"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">All work</SelectItem><SelectItem value="needs_approval">Needs approval</SelectItem><SelectItem value="awaiting_response">Awaiting response</SelectItem><SelectItem value="expiring_soon">Expiring in 7 days</SelectItem><SelectItem value="needs_review">Delivery needs review</SelectItem><SelectItem value="customer_response">Customer questions</SelectItem><SelectItem value="overdue">Overdue</SelectItem></SelectContent></Select>
      <Select value={sort} onValueChange={value=>{setSort(value);resetPage();}}><SelectTrigger className="w-44" aria-label="Sort proposals"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="updated">Recently updated</SelectItem><SelectItem value="created">Recently created</SelectItem><SelectItem value="value">Highest value</SelectItem><SelectItem value="expiry">Expiry date</SelectItem></SelectContent></Select>
    </section>

    {error&&<Callout tone="danger" actions={<Button variant="outline" onClick={()=>void load()}>Retry</Button>}>{error}</Callout>}
    {loading ? <LoadingState className={styles.empty} label="Loading proposals" showLabel/>
      : !proposals.length ? !error && <div className={styles.empty}>
        <span className={styles.emptyIcon}><FileText aria-hidden="true" className="h-7 w-7"/></span>
        <div>{noProposalsYet ? <><h2>No proposals yet</h2><p className="mt-2 text-sm text-muted-foreground">Create your first offer from customer context, a catalog item or a template.</p></> : <><h2>No proposals match this view</h2><p className="mt-2 text-sm text-muted-foreground">Clear a filter or prepare a new offer.</p></>}</div>
        <Button onClick={()=>router.push("/dashboard/proposals/new")}><Plus aria-hidden="true"/>New proposal</Button>
      </div>
      : <div className={styles.tableWrap}><table aria-label="Proposals" className={`${styles.table} ${styles.workbenchTable} min-w-[1280px]`}>
        <thead><tr>{["Proposal","Customer","Owner","Status","Value","Expiry","Last activity","Next action","Actions"].map(label=><th key={label} scope="col" className={["Value","Actions"].includes(label)?"text-right":""}>{label}</th>)}</tr></thead>
        <tbody>{proposals.map(proposal=>{
          const config=statusConfig[proposal.status]||statusConfig.draft;
          const teamStatus=proposal.metadata?.teamApproval?.status;
          const nextAction=proposal.status==="draft"?(teamStatus==="changes_requested"?"Revise for reviewer":"Finish and send"):proposal.status==="delivery_unknown"?"Check provider receipt":proposal.status==="sent"?"Await first view":proposal.status==="viewed"?"Follow up or await decision":proposal.status==="accepted"?(proposal.metadata?.onboarding?.status==="failed"?"Repair onboarding":"Track onboarding"):proposal.status==="rejected"?"Review decline reason":proposal.status==="expired"?"Create revision":"View history";
          return <tr key={proposal.id}>
            <td><button className="flex min-h-10 max-w-60 flex-col items-start justify-center gap-1 text-left font-semibold text-primary hover:underline" onClick={()=>router.push(`/dashboard/proposals/${proposal.id}`)}><span>{proposal.title}</span><span className="text-xs font-normal text-muted-foreground">{proposal.proposalNumber}</span></button></td>
            <td><p>{proposal.recipientName||"Customer not set"}</p><p className="mt-1 max-w-48 truncate text-xs text-muted-foreground" title={proposal.recipientEmail||undefined}>{proposal.recipientEmail||"No email"}</p></td>
            <td><div className={styles.owner}><span className={styles.avatar} aria-hidden="true">{(proposal.owner?.name||"Unassigned").split(/\s+/).map(part=>part[0]).slice(0,2).join("").toUpperCase()}</span><div><p>{proposal.owner?.name||"Unassigned"}</p>{proposal.owner?.email&&proposal.owner.email!==proposal.owner.name&&<p className="mt-1 max-w-36 truncate text-xs text-muted-foreground" title={proposal.owner.email}>{proposal.owner.email}</p>}</div></div></td>
            <td><StatusBadge tone={config.tone} label={config.label}/>{teamStatus&&<p className="mt-2 text-xs capitalize text-muted-foreground">Team: {teamStatus.replaceAll("_"," ")}</p>}</td>
            <td className="whitespace-nowrap text-right font-medium tabular-nums">{proposal.currency} {Number(proposal.total||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
            <td className="whitespace-nowrap">{proposal.validUntil?new Date(proposal.validUntil).toLocaleDateString():"—"}</td>
            <td className="whitespace-nowrap">{new Date(proposal.lastActivityAt||proposal.updatedAt).toLocaleDateString()}</td>
            <td><span className="inline-flex max-w-40 items-center gap-1.5 leading-5">{["delivery_unknown","expired"].includes(proposal.status)&&<TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-600"/>}{nextAction}</span></td>
            <td><div className={styles.rowActions}>
              <Button size="sm" variant="outline" data-draft={proposal.status==="draft"} aria-label={`View ${proposal.title}`} onClick={()=>router.push(`/dashboard/proposals/${proposal.id}`)}><Eye aria-hidden="true"/>View</Button>
              {proposal.status==="draft"&&<>
                <Button size="sm" variant="outline" data-draft="true" aria-label={`Edit ${proposal.title}`} onClick={()=>router.push(`/dashboard/proposals/${proposal.id}/edit`)}><Edit3 aria-hidden="true"/>Edit</Button>
                <Button size="sm" variant="outline" data-draft="true" title="Open delivery review" aria-label={`Send ${proposal.title}`} onClick={()=>router.push(`/dashboard/proposals/${proposal.id}?send=1`)}><Send aria-hidden="true"/>Send</Button>
                <Button size="sm" variant="outline" data-draft="true" className="text-destructive" aria-label={`Delete ${proposal.title}`} onClick={()=>setDeleteId(proposal.id)}><Trash2 aria-hidden="true"/>Delete</Button>
              </>}
            </div></td>
          </tr>;
        })}</tbody>
      </table></div>}
    {!loading&&proposals.length>0&&<div className={styles.footer}>
      <p className="inline-flex items-center gap-2"><Info aria-hidden="true" className="h-4 w-4 shrink-0"/>Send opens delivery review; approval and sending are separate.</p>
      <Pagination className="w-full" aria-label="Proposal pages" page={page} pageSize={25} totalItems={total} onPageChange={setPage} itemLabel="proposals"/>
    </div>}
    <AlertDialog open={deleteId!==null} onOpenChange={open=>{if(!open&&!deleting)setDeleteId(null);}}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete this draft?</AlertDialogTitle><AlertDialogDescription>This removes its line items, internal notes, reminders, and saved draft history. This cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel><AlertDialogAction disabled={deleting} className="bg-destructive text-destructive-foreground" onClick={event=>{event.preventDefault();void remove();}}>{deleting?<Spinner size="sm" label={null}/>:<Trash2 aria-hidden="true" className="h-4 w-4"/>}Delete draft</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>;
}
