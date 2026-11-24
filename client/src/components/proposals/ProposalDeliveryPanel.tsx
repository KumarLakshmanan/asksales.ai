"use client";
import styles from "@/components/proposals/proposals.module.css";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, LockKeyhole, RotateCcw, Send } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConversationEventTimeline } from "@/components/support/ConversationEventTimeline";
import { PROPOSAL_CHANNEL_LABELS, type ProposalChannel, type ReadinessIssue } from "../../../../shared/proposals";

type DeliveryProposal = {
  id: number;
  revision: number;
  title: string;
  proposalNumber: string;
  status: string;
  recipientName: string | null;
  recipientEmail: string | null;
  leadId?: number | null;
  outreachConversationId?: number | null;
};
type DeliveryTarget = {
  channel: ProposalChannel;
  outreachConversationId: number | null;
  leadId: number | null;
  recipient: string;
  recipientName: string;
  recipientEmail: string | null;
  providerAccountId: string;
  providerVariant?: "gmail" | "resend";
  senderEmail?: string;
  subject: string;
  message: string;
};
type Prepared = {
  target: DeliveryTarget;
  targetFingerprint: string;
  reviewFingerprint: string;
  ready: boolean;
  issues: ReadinessIssue[];
  proposal: DeliveryProposal;
};
type DeliveryResult = { publicUrl?: string; delivery?: { state: string; channel: ProposalChannel; messageId?: string; error?: string } };

const editableStatuses = new Set(["draft", "sent", "viewed"]);

export function ProposalDeliveryPanel({ proposal, initialChannel = "email", onRefresh }: {
  proposal: DeliveryProposal;
  initialChannel?: ProposalChannel;
  onRefresh: () => Promise<DeliveryProposal | void> | void;
}) {
  const [channel, setChannel] = useState<ProposalChannel>(initialChannel);
  const [providerVariant, setProviderVariant] = useState<"gmail" | "resend">("gmail");
  const [providerAccountId, setProviderAccountId] = useState("");
  const [recipientName, setRecipientName] = useState(proposal.recipientName || "");
  const [recipientEmail, setRecipientEmail] = useState(proposal.recipientEmail || "");
  const [subject, setSubject] = useState(`Proposal: ${proposal.title}`);
  const [message, setMessage] = useState(`Please review ${proposal.title} (${proposal.proposalNumber}).`);
  const [prepared, setPrepared] = useState<Prepared>();
  const [approvedRevision, setApprovedRevision] = useState<number>();
  const [pendingTeamReview, setPendingTeamReview] = useState(false);
  const [busy, setBusy] = useState<"prepare" | "approve" | "send">();
  const [error, setError] = useState("");
  const [result, setResult] = useState<DeliveryResult>();
  const [sendKey, setSendKey] = useState(() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-proposal`);
  const [activityRefresh, setActivityRefresh] = useState(0);
  const payload = useMemo(() => ({
    channel,
    ...(channel === "email" ? { providerVariant, recipientEmail: recipientEmail.trim() } : {}),
    ...(providerAccountId.trim() ? { providerAccountId: providerAccountId.trim() } : {}),
    ...(proposal.outreachConversationId ? { outreachConversationId: proposal.outreachConversationId } : {}),
    ...(proposal.leadId ? { leadId: proposal.leadId } : {}),
    recipientName: recipientName.trim(),
    subject: subject.trim(),
    message: message.trim(),
  }), [channel, providerVariant, providerAccountId, proposal.outreachConversationId, proposal.leadId, recipientName, recipientEmail, subject, message]);

  useEffect(() => {
    setPrepared(undefined);
    setApprovedRevision(undefined);
    setPendingTeamReview(false);
    setResult(undefined);
  }, [payload]);

  const prepare = async () => {
    setBusy("prepare"); setError("");
    try {
      const next = await api.post<Prepared>(`/api/proposals/${proposal.id}/prepare-delivery`, {...payload, expectedRevision: proposal.revision});
      setPrepared(next);
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : "The delivery review could not be prepared."); }
    finally { setBusy(undefined); }
  };

  const approve = async () => {
    if (!prepared) return;
    setBusy("approve"); setError("");
    try {
      const review = await api.post<{ revision: number; approved: boolean; requirement: { reasons: string[] } }>(`/api/proposals/${proposal.id}/approve`, {
        ...payload,
        expectedRevision: prepared.proposal.revision,
        expectedTargetFingerprint: prepared.targetFingerprint,
        expectedReviewFingerprint: prepared.reviewFingerprint,
      });
      setApprovedRevision(review.revision);
      setPendingTeamReview(!review.approved);
      setActivityRefresh(value => value + 1);
      await onRefresh();
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : "The reviewed version could not be approved."); }
    finally { setBusy(undefined); }
  };

  const send = async () => {
    if (!approvedRevision) return;
    setBusy("send"); setError("");
    try {
      const delivery = await api.post<DeliveryResult>(`/api/proposals/${proposal.id}/send`, {
        ...payload,
        expectedRevision: approvedRevision,
        idempotencyKey: sendKey,
      });
      setResult(delivery);
      setActivityRefresh(value => value + 1);
      await onRefresh();
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : "The provider did not accept this proposal delivery."); }
    finally { setBusy(undefined); }
  };

  const outcome = result?.delivery?.state;
  const unresolved = outcome === "uncertain" || outcome === "queued";
  const resultActions = (result?.publicUrl || outcome === "sent" || outcome === "failed") ? <>
    {result?.publicUrl && <Button asChild variant="outline"><a href={result.publicUrl} target="_blank" rel="noreferrer">Open customer link</a></Button>}
    {(outcome === "sent" || outcome === "failed") && <Button variant="ghost" onClick={()=>{setResult(undefined);setPrepared(undefined);setApprovedRevision(undefined);setSendKey(globalThis.crypto?.randomUUID?.() || `${Date.now()}-proposal`);}}>{outcome === "failed" ? "Review delivery again" : "Prepare another delivery"}</Button>}
  </> : undefined;
  const resultCard = result && <Callout
    tone={outcome === "sent" ? "success" : outcome === "failed" ? "danger" : "warning"}
    role={outcome === "failed" || outcome === "uncertain" ? "alert" : "status"}
    title={outcome === "sent" ? "Delivery sent" : outcome === "failed" ? "Delivery failed" : outcome === "uncertain" ? "Delivery unconfirmed" : outcome === "queued" ? "Delivery pending" : "Delivery recorded"}
    actions={resultActions}
  >
    {outcome === "uncertain" && <p>Check provider history and reconcile this attempt before preparing another delivery.</p>}
    {outcome === "queued" && <p>Wait for this attempt to finish. Refresh the proposal to check its outcome before preparing another delivery.</p>}
    {outcome === "failed" && <p>Review the provider error before preparing a new delivery.</p>}
    {result.delivery?.error && <p className="mt-2">{result.delivery.error}</p>}
    {result.delivery?.messageId && <p className="mt-1 text-muted-foreground">Provider receipt: {result.delivery.messageId}</p>}
  </Callout>;

  if (!editableStatuses.has(proposal.status) || unresolved) return <section className={`${styles.delivery} space-y-4`}><h2 className="font-semibold">Delivery</h2><p className="mt-2 text-sm text-muted-foreground">{unresolved ? "This delivery attempt needs confirmation before another delivery can be prepared." : `This proposal is ${proposal.status.replaceAll("_", " ")} and cannot be sent.`}</p>{resultCard}{proposal.outreachConversationId && <ConversationEventTimeline conversationId={proposal.outreachConversationId} refreshToken={proposal.revision + activityRefresh} />}</section>;

  return <section className={`${styles.delivery} space-y-5`} aria-labelledby="proposal-delivery-title">
    <div><h2 id="proposal-delivery-title" className="font-semibold">Delivery review</h2><p className="mt-1 text-sm text-muted-foreground">Resolve the live customer identity and provider account, approve the exact content, then send this version once.</p></div>
    {proposal.outreachConversationId && <ConversationEventTimeline conversationId={proposal.outreachConversationId} refreshToken={proposal.revision + activityRefresh} />}
    <div className="grid gap-4 min-[640px]:grid-cols-2">
      <label className="space-y-2 text-sm">Channel<select className="h-10 w-full rounded-md border bg-background px-3" value={channel} onChange={event=>setChannel(event.target.value as ProposalChannel)}>{Object.entries(PROPOSAL_CHANNEL_LABELS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {channel === "email" && <label className="space-y-2 text-sm">Email provider<select className="h-10 w-full rounded-md border bg-background px-3" value={providerVariant} onChange={event=>setProviderVariant(event.target.value as "gmail"|"resend")}><option value="gmail">Gmail</option><option value="resend">Verified sender (Resend)</option></select></label>}
      <label className="space-y-2 text-sm">Customer name<Input value={recipientName} onChange={event=>setRecipientName(event.target.value)} /></label>
      {channel === "email" && <label className="space-y-2 text-sm">Customer email<Input type="email" value={recipientEmail} onChange={event=>setRecipientEmail(event.target.value)} /></label>}
      <label className="space-y-2 text-sm min-[640px]:col-span-2">Provider account ID <span className="text-xs text-muted-foreground">(optional when a default or conversation-bound account exists)</span><Input value={providerAccountId} onChange={event=>setProviderAccountId(event.target.value)} placeholder="Use the connected default" /></label>
      <label className="space-y-2 text-sm min-[640px]:col-span-2">Subject<Input value={subject} onChange={event=>setSubject(event.target.value)} /></label>
      <label className="space-y-2 text-sm min-[640px]:col-span-2">Message<Textarea rows={4} value={message} onChange={event=>setMessage(event.target.value)} /><span className="text-xs text-muted-foreground">The secure proposal link is appended automatically. Use {"{{proposal_url}}"} to place it in the message.</span></label>
    </div>
    <Button variant="outline" loading={busy === "prepare"} loadingText="Prepare delivery review" disabled={(!!busy && busy !== "prepare") || !subject.trim() || !message.trim()} onClick={()=>void prepare()}><RotateCcw className="mr-2 h-4 w-4"/>Prepare delivery review</Button>
    {prepared && <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-start gap-3"><LockKeyhole className="mt-0.5 h-5 w-5 text-primary"/><div><p className="font-medium">Resolved delivery</p><p className="mt-1 text-sm text-muted-foreground">{PROPOSAL_CHANNEL_LABELS[prepared.target.channel]} · {prepared.target.recipient} · account {prepared.target.senderEmail || prepared.target.providerAccountId || "unavailable"}</p></div></div>
      {prepared.issues.length ? <ul className="space-y-2">{prepared.issues.map(issue=><li className={`rounded-md border p-3 text-sm ${issue.severity === "error" ? "border-destructive/30 text-destructive" : "border-amber-500/30 text-amber-700 dark:text-amber-300"}`} key={`${issue.code}:${issue.field}`}>{issue.message}</li>)}</ul> : <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4"/>Recipient, content, pricing, link, and provider checks passed.</p>}
      <Button loading={busy === "approve"} loadingText="Approve this exact version" disabled={(!!busy && busy !== "approve") || !prepared.ready} onClick={()=>void approve()}><CheckCircle2 className="mr-2 h-4 w-4"/>Approve this exact version</Button>
    </div>}
    {pendingTeamReview && <Callout tone="warning" title="Assigned team review is pending">A configured reviewer must approve the current fingerprint. After their decision, refresh this proposal and prepare the delivery again.</Callout>}
    {approvedRevision && !pendingTeamReview && !result && <Callout tone="success" title={`Approved revision ${approvedRevision}`} actions={<Button loading={busy === "send"} loadingText="Send approved proposal" disabled={!!busy && busy !== "send"} onClick={()=>void send()}><Send className="mr-2 h-4 w-4"/>Send approved proposal</Button>}>Sending will contact the resolved customer through the account shown above and consume the channel credit once.</Callout>}
    {resultCard}
    {error && <Callout tone="danger" size="sm">{error}</Callout>}
  </section>;
}
