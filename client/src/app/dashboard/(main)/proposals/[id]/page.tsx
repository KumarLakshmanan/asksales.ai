"use client";
import styles from "@/components/proposals/proposals.module.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Clock3, Download, Edit3, Eye, FileText, MessageSquare, Send, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { PageErrorState } from "@/components/ui/page-state";
import { ProposalDocument, downloadProposalPdf, type CustomerProposalDocument, type ProposalBrand } from "@/components/proposals/ProposalDocument";
import { ProposalDeliveryPanel } from "@/components/proposals/ProposalDeliveryPanel";
import { ProposalWorkflowPanel } from "@/components/proposals/ProposalWorkflowPanel";
import type { ProposalChannel, ProposalDocumentMetadata, ProposalLineItem } from "../../../../../../../shared/proposals";

type Proposal = CustomerProposalDocument & {
  id:number;revision:number;proposalNumber:string;title:string;status:string;currency:string;
  recipientName:string|null;recipientEmail:string|null;leadId?:number|null;contactId?:number|null;outreachConversationId?:number|null;
  subtotal:string;discountType:"fixed"|"percentage"|null;discountValue:string;taxRate:string;total:string;
  sentAt:string|null;viewedAt:string|null;acceptedAt:string|null;rejectedAt:string|null;rejectionReason:string|null;
  validUntil:string|null;signatureRequired:boolean;showTermsAndConditions:boolean;termsAndConditions:string|null;
  metadata?:ProposalDocumentMetadata|null;lineItems:ProposalLineItem[];createdAt:string;updatedAt:string;
};
type Comment = {id:number;content:string;isResolved:boolean;createdAt:string};

const statusStyle:Record<string,{label:string;className:string;icon:typeof FileText}>={
  draft:{label:"Draft",className:"bg-muted text-muted-foreground",icon:Edit3},sending:{label:"Sending",className:"bg-warning/10 text-warning",icon:Clock3},delivery_unknown:{label:"Delivery needs review",className:"bg-warning/10 text-warning",icon:Clock3},sent:{label:"Sent",className:"bg-info/10 text-info",icon:Send},viewed:{label:"Viewed",className:"bg-primary/10 text-primary",icon:Eye},accepted:{label:"Accepted",className:"bg-success/10 text-success",icon:CheckCircle2},rejected:{label:"Declined",className:"bg-destructive/10 text-destructive",icon:XCircle},expired:{label:"Expired",className:"bg-warning/10 text-warning",icon:Clock3},superseded:{label:"Superseded",className:"bg-muted text-muted-foreground",icon:FileText},
};
const deliveryChannels=new Set<ProposalChannel>(["email","whatsapp","facebook","instagram","sms","linkedin","twitter","web"]);

export default function ProposalDetailPage(){
  const params=useParams(),router=useRouter(),id=String(params.id);
  const [proposal,setProposal]=useState<Proposal>(),[brand,setBrand]=useState<ProposalBrand>(),[comments,setComments]=useState<Comment[]>([]);
  const [newComment,setNewComment]=useState(""),[loading,setLoading]=useState(true),[error,setError]=useState(""),[commentError,setCommentError]=useState(""),[exporting,setExporting]=useState(false);
  const documentRef=useRef<HTMLDivElement>(null);
  const load=useCallback(async()=>{
    try{setError("");const [record,branding]=await Promise.all([api.get<Proposal>(`/api/proposals/${id}`),api.get<ProposalBrand>(`/api/proposals/brand?proposalId=${id}`)]);setProposal(record);setBrand(branding);return record;}catch(failure){setError(failure instanceof ApiError?failure.message:"The proposal could not be loaded.");}
  },[id]);
  const refresh=useCallback(()=>{void load();},[load]);
  const loadComments=useCallback(async()=>{try{setComments(await api.get<Comment[]>(`/api/proposals/${id}/comments`));}catch{setCommentError("Internal comments could not be loaded.");}},[id]);
  useEffect(()=>{void Promise.all([load(),loadComments()]).finally(()=>setLoading(false));},[load,loadComments]);
  const addComment=async()=>{if(!newComment.trim())return;try{setCommentError("");await api.post(`/api/proposals/${id}/comments`,{content:newComment.trim()});setNewComment("");await loadComments();}catch(failure){setCommentError(failure instanceof ApiError?failure.message:"The comment could not be saved.");}};
  const exportPdf=async()=>{const element=documentRef.current?.firstElementChild;if(!element||!proposal)return;setExporting(true);try{await downloadProposalPdf(element as HTMLElement,proposal.proposalNumber);}catch{setError("The PDF could not be prepared.");}finally{setExporting(false);}};

  if(loading)return <section className="page-shell"><LoadingState className="min-h-80" label="Loading proposal…" showLabel/></section>;
  if(!proposal)return <PageErrorState title="Proposal could not be loaded" description={error||"This proposal is unavailable."} reset={()=>void load()}/>;
  const status=statusStyle[proposal.status]||statusStyle.draft,StatusIcon=status.icon;
  const initialChannel=(typeof window!=="undefined"?new URLSearchParams(window.location.search).get("channel"):null) as ProposalChannel|null;

  return <section className={`page-shell ${styles.workspace} ${styles.editorShell} pb-20 [&_button]:min-h-10 [&_button]:min-w-10`}>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3"><Button size="icon" variant="ghost" className="h-10 w-10" aria-label="Back to proposals" onClick={()=>router.push("/dashboard/proposals")}><ArrowLeft className="h-4 w-4"/></Button><div className="min-w-0"><p className="eyebrow">{proposal.proposalNumber}</p><div className="mt-1 flex flex-wrap items-center gap-2"><h1 className="page-title truncate">{proposal.title}</h1><Badge className={`${status.className} border-0`}><StatusIcon className="mr-1 h-3.5 w-3.5"/>{status.label}</Badge></div><p className="mt-1 text-sm text-muted-foreground">Revision {proposal.revision} · updated {new Date(proposal.updatedAt).toLocaleString()}</p></div></div>
      <div className="flex flex-wrap gap-2">{proposal.status==="draft"&&<Button variant="outline" onClick={()=>router.push(`/dashboard/proposals/${proposal.id}/edit`)}><Edit3 className="mr-2 h-4 w-4"/>Edit draft</Button>}<Button variant="outline" loading={exporting} loadingText="Preparing PDF…" onClick={()=>void exportPdf()}><Download className="mr-2 h-4 w-4"/>Download PDF</Button></div>
    </header>
    {error&&<Callout tone="danger">{error}</Callout>}
    <section className={styles.summary} aria-label="Proposal summary">
      <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Customer</p><p className="mt-1 font-medium">{proposal.recipientName||"Not set"}</p><p className="truncate text-xs text-muted-foreground">{proposal.recipientEmail||"No email"}</p></CardContent></Card>
      <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Value</p><p className="mt-1 text-xl font-semibold tabular-nums">{proposal.currency} {Number(proposal.total||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</p><p className="text-xs text-muted-foreground">Initial total</p></CardContent></Card>
      <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Valid until</p><p className="mt-1 font-medium">{proposal.validUntil?new Date(proposal.validUntil).toLocaleDateString():"No expiry"}</p><p className="text-xs text-muted-foreground">{proposal.sentAt?`Sent ${new Date(proposal.sentAt).toLocaleDateString()}`:"Not delivered"}</p></CardContent></Card>
      <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Approval</p><p className="mt-1 font-medium">{proposal.metadata?.approvedAt?"Approved":"Review required"}</p><p className="text-xs text-muted-foreground">{String((proposal.metadata?.teamApproval as {status?:string}|undefined)?.status||"Seller review").replaceAll("_"," ")}</p></CardContent></Card>
    </section>
    <div className={styles.detailGrid}>
      <div className={styles.previewPaper} ref={documentRef}><ProposalDocument proposal={proposal} brand={brand}/></div>
      <div className={`${styles.detailAside} space-y-5`}>
        <ProposalDeliveryPanel proposal={proposal} initialChannel={initialChannel&&deliveryChannels.has(initialChannel)?initialChannel:"email"} onRefresh={load}/>
        <Card><CardHeader className="border-b px-5 py-4"><CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="h-4 w-4"/>Internal notes</CardTitle></CardHeader><CardContent className="space-y-3 p-5"><ol className="max-h-64 space-y-2 overflow-y-auto">{comments.map(comment=><li key={comment.id} className="rounded-lg bg-muted/40 p-3 text-sm"><p className="whitespace-pre-wrap">{comment.content}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(comment.createdAt).toLocaleString()}</p></li>)}</ol>{!comments.length&&!commentError&&<p className="text-sm text-muted-foreground">No internal notes yet.</p>}<Textarea aria-label="Internal proposal note" value={newComment} onChange={event=>setNewComment(event.target.value)} rows={3} placeholder="Add a note for your team"/><Button variant="outline" disabled={!newComment.trim()} onClick={()=>void addComment()}>Add note</Button>{commentError&&<p role="alert" className="text-xs text-destructive">{commentError}</p>}</CardContent></Card>
      </div>
    </div>
    <ProposalWorkflowPanel proposal={proposal} onRefresh={refresh}/>
  </section>;
}
