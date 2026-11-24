"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Clock, Download, FileText, Loader2, MessageCircleQuestion, RefreshCw, Send, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { ProposalDocument, downloadProposalPdf, type CustomerProposalDocument } from '@/components/proposals/ProposalDocument';

interface PublicProposal extends CustomerProposalDocument {
  proposalNumber: string;
  title: string;
  coverNote: string | null;
  recipientName: string | null;
  currency: string | null;
  subtotal: string | null;
  total: string | null;
  status: string;
  validUntil: string | null;
  signatureRequired: boolean | null;
  signedAt: string | null;
  signedByName: string | null;
  showTermsAndConditions: boolean | null;
  termsAndConditions: string | null;
  generatedSections: Array<{ title: string; body: string; kind: "cover" | "content" | "terms" | "closing" }>;
  lineItems: Array<{
    id: number;
    name: string;
    description: string | null;
    quantity: string;
    unitPrice: string;
    unit: string | null;
    total: string;
  }>;
  brand: { companyName: string; logoUrl: string | null; primaryColor: string };
  replacement?: { proposalNumber: string; title: string; publicUrl: string } | null;
}

interface ProposalFeedback {
  id: number;
  kind: "question" | "change_request" | "seller_reply";
  authorName: string | null;
  content: string;
  parentFeedbackId: number | null;
  resolvedAt: string | null;
  createdAt: string;
}

export default function PublicProposalPage() {
  const params = useParams();
  const token = String(params.token || "");
  const [proposal, setProposal] = useState<PublicProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [feedback, setFeedback] = useState<ProposalFeedback[]>([]);
  const [feedbackKind, setFeedbackKind] = useState<"question" | "change_request">("question");
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackKey, setFeedbackKey] = useState(() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-feedback`);
  const [sendingFeedback, setSendingFeedback] = useState(false);

  const loadFeedback = useCallback(async () => {
    try {
      const data = await api.get<{ proposalId: number; feedback: ProposalFeedback[] }>(`/api/proposals/public/${encodeURIComponent(token)}/feedback`, {
        skipAuth: true,
        suppressUnauthorizedEvent: true,
      });
      setFeedback(data.feedback || []);
    } catch { /* The proposal itself remains reviewable if discussion history is unavailable. */ }
  }, [token]);

  const loadProposal = useCallback(async () => {
    try {
      setError("");
      const data = await api.get<PublicProposal>(`/api/proposals/public/${encodeURIComponent(token)}`, {
        skipAuth: true,
        suppressUnauthorizedEvent: true,
      });
      setProposal(data);
      void loadFeedback();
      setName((current) => current || data.recipientName || "");
      if (data.status === "sent") {
        void api.post<{ status: string }>(`/api/proposals/public/${encodeURIComponent(token)}/view`, undefined, {
          skipAuth: true,
          suppressUnauthorizedEvent: true,
        }).then((view) => {
          setProposal((current) => current ? { ...current, status: view.status } : current);
        }).catch(() => {});
      }
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "This proposal link is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [token, loadFeedback]);

  useEffect(() => { void loadProposal(); }, [loadProposal]);

  const respond = async (action: "accept" | "reject") => {
    if (action === "accept" && proposal?.signatureRequired && !name.trim()) {
      setError("Enter your full name to accept and sign this proposal.");
      return;
    }
    if (action === "accept" && !confirmed) {
      setError("Confirm that you have reviewed the proposal and terms.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await api.post(`/api/proposals/public/${encodeURIComponent(token)}/${action}`, {
        name: name.trim() || undefined,
        reason: action === "reject" ? reason.trim() || undefined : undefined,
      }, { skipAuth: true, suppressUnauthorizedEvent: true });
      await loadProposal();
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : `The proposal could not be ${action}ed.`);
    } finally {
      setSubmitting(false);
    }
  };

  const submitFeedback = async () => {
    if (!feedbackText.trim()) {
      setError(feedbackKind === "question" ? "Enter your question." : "Describe the changes you need.");
      return;
    }
    setSendingFeedback(true);
    setError("");
    try {
      await api.post(`/api/proposals/public/${encodeURIComponent(token)}/feedback`, {
        kind: feedbackKind,
        content: feedbackText.trim(),
        authorName: name.trim() || proposal?.recipientName || undefined,
        requestKey: feedbackKey,
      }, { skipAuth: true, suppressUnauthorizedEvent: true });
      setFeedbackText("");
      setFeedbackKey(globalThis.crypto?.randomUUID?.() || `${Date.now()}-feedback`);
      await loadFeedback();
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Your message could not be recorded.");
    } finally {
      setSendingFeedback(false);
    }
  };

  if (loading) {
    return (
      <main id="main-content" className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner size="md" label={null} /> Opening proposal…
        </div>
      </main>
    );
  }

  if (!proposal) {
    return (
      <main id="main-content" className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
        <Card className="w-full max-w-lg border-border/60 shadow-sm">
          <CardContent className="p-8 text-center">
            <XCircle className="mx-auto h-10 w-10 text-destructive" />
            <h1 className="mt-4 text-xl font-semibold">Proposal unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">{error || "The link may be invalid or no longer active."}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const canRespond = ["sent", "viewed"].includes(proposal.status);
  const accepted = proposal.status === "accepted";
  const rejected = proposal.status === "rejected";

  return (
    <main id="main-content" className="min-h-screen bg-muted/30 px-4 py-8 [&_button]:min-h-11 [&_button]:min-w-11 sm:px-6 lg:py-12">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-col justify-between gap-4 rounded-2xl border border-border/60 bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:p-6">
          <div className="flex items-center gap-4">
            {proposal.brand.logoUrl ? (
              <img src={proposal.brand.logoUrl} alt="" className="h-12 max-w-40 object-contain" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <FileText className="h-6 w-6 text-primary" />
              </div>
            )}
            <div>
              <p className="text-sm font-medium">{proposal.brand.companyName}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2"><Button variant="outline" loading={exporting} loadingText="Preparing PDF…" onClick={async () => { const element = document.getElementById('customer-proposal-document'); if (!element) return; setExporting(true); try { await downloadProposalPdf(element, proposal.proposalNumber); } catch { setError('Unable to prepare the PDF. Please try again.'); } finally { setExporting(false); } }}><Download className="mr-2 h-4 w-4" />Download PDF</Button><Badge variant="outline" className="w-fit capitalize">{proposal.status}</Badge></div>
        </header>

        {(accepted || rejected || proposal.status === "expired" || proposal.status === "sending" || proposal.status === "superseded") && (
          <div className={`rounded-xl border p-4 ${accepted ? "border-emerald-500/30 bg-emerald-500/10" : rejected ? "border-rose-500/30 bg-rose-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
            <div className="flex items-start gap-3">
              {accepted ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" /> : <Clock className="mt-0.5 h-5 w-5 text-amber-600" />}
              <div>
                <p className="font-medium">{accepted ? "Proposal accepted" : rejected ? "Proposal declined" : proposal.status === "sending" ? "Proposal delivery is being finalized" : proposal.status === "superseded" ? "A newer proposal is available" : "Proposal expired"}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {accepted
                    ? `Thank you${proposal.signedByName ? `, ${proposal.signedByName}` : ""}. Your response has been recorded.`
                    : proposal.status === "superseded" && proposal.replacement
                      ? `This version was replaced by ${proposal.replacement.proposalNumber}.`
                    : proposal.status === "sending"
                      ? "The proposal is available, but responses will open after delivery is confirmed."
                      : "This proposal is no longer awaiting a response."}
                </p>
                {proposal.status === "superseded" && proposal.replacement?.publicUrl && <Button asChild className="mt-3"><a href={proposal.replacement.publicUrl}>Open current proposal <RefreshCw className="ml-2 h-4 w-4" /></a></Button>}
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div><ProposalDocument id="customer-proposal-document" proposal={proposal} brand={proposal.brand} /></div>

          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <Card className="border-border/60 shadow-sm">
              <CardHeader className="border-b px-5 py-4">
                <CardTitle className="text-base">Proposal details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 p-5">
                <div>
                  <p className="text-xs text-muted-foreground">Prepared for</p>
                  <p className="mt-1 text-sm font-medium">{proposal.recipientName || "Recipient"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Valid until</p>
                  <p className="mt-1 text-sm font-medium">{proposal.validUntil ? new Date(proposal.validUntil).toLocaleDateString() : "No expiry"}</p>
                </div>
              </CardContent>
            </Card>

            {canRespond && (
              <Card className="border-border/60 shadow-sm">
                <CardHeader className="border-b px-5 py-4">
                  <CardTitle className="text-base">Your decision</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 p-5">
                  {proposal.signatureRequired && (
                    <div className="space-y-1.5">
                      <Label htmlFor="signer-name" className="text-xs">Full name</Label>
                      <Input id="signer-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Type your full name" />
                      <p className="text-xs text-muted-foreground">Your typed name will be recorded with the acceptance time.</p>
                    </div>
                  )}
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 p-3">
                    <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} className="mt-0.5" />
                    <span className="text-xs leading-5">I reviewed this proposal and agree to its terms.</span>
                  </label>
                  <Button className="w-full gap-2" disabled={submitting || !confirmed} onClick={() => void respond("accept")}>
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Accept proposal
                  </Button>
                  <div className="border-t pt-4">
                    <Label htmlFor="decline-reason" className="text-xs">Decline reason (optional)</Label>
                    <Textarea id="decline-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className="mt-1.5 resize-none" />
                    <Button variant="outline" className="mt-3 w-full gap-2 text-destructive hover:text-destructive" disabled={submitting} onClick={() => void respond("reject")}>
                      <XCircle className="h-4 w-4" /> Decline proposal
                    </Button>
                  </div>
                  {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                </CardContent>
              </Card>
            )}

            {(canRespond || feedback.length > 0) && (
              <Card className="border-border/60 shadow-sm">
                <CardHeader className="border-b px-5 py-4">
                  <CardTitle className="flex items-center gap-2 text-base"><MessageCircleQuestion className="h-4 w-4" /> Questions and changes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 p-5">
                  {feedback.length > 0 && <ol className="max-h-72 space-y-3 overflow-y-auto" aria-label="Proposal discussion">
                    {feedback.map(item => <li key={item.id} className={`rounded-lg border p-3 text-sm ${item.kind === "seller_reply" ? "ml-5 bg-muted/40" : "bg-background"}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{item.authorName || (item.kind === "seller_reply" ? "Seller" : "Customer")}</span>
                        <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{item.content}</p>
                      {item.kind !== "seller_reply" && <span className="mt-2 inline-block text-xs text-muted-foreground">{item.kind === "question" ? "Question" : "Change request"}{item.resolvedAt ? " · Addressed" : " · Awaiting reply"}</span>}
                    </li>)}
                  </ol>}
                  {canRespond && <div className="space-y-3 border-t pt-4">
                    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Message type">
                      <Button type="button" variant={feedbackKind === "question" ? "default" : "outline"} onClick={() => setFeedbackKind("question")}>Ask a question</Button>
                      <Button type="button" variant={feedbackKind === "change_request" ? "default" : "outline"} onClick={() => setFeedbackKind("change_request")}>Request changes</Button>
                    </div>
                    <Label htmlFor="proposal-feedback">{feedbackKind === "question" ? "Your question" : "Changes you need"}</Label>
                    <Textarea id="proposal-feedback" rows={4} value={feedbackText} onChange={event => setFeedbackText(event.target.value)} maxLength={10000} placeholder={feedbackKind === "question" ? "What would you like clarified?" : "Describe the scope, timing, or commercial changes you want reviewed."} />
                    <Button className="w-full" loading={sendingFeedback} disabled={!feedbackText.trim()} onClick={() => void submitFeedback()}><Send className="mr-2 h-4 w-4" />Send to proposal owner</Button>
                  </div>}
                  {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                </CardContent>
              </Card>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
