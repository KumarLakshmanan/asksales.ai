"use client";

import { selectedBusinessProfileId } from '@/lib/business-profile';

import { useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import Link from 'next/link';
import { KnowledgeReadinessDetails, type KnowledgeReadiness } from './KnowledgeReadiness';

interface Scope {
  title: string; sourceUrl: string | null; businessProfileId: number | null;
  audience: "customer" | "internal"; accessScope: "tenant" | "business_profile" | "staff_only";
  usageScopes: string[]; allowedChannels: string[]; locale: string | null;
}
interface Version {
  readiness?: KnowledgeReadiness | null;
  id: number; version_no: number; status: string; current_published_version_id: number | null;
  normalized_content: string; vector_index_status: string; lexical_index_status: string;
  audience: Scope["audience"]; usage_scopes: string[];
  effective_at?: string | null; expires_at?: string | null; review_due_at?: string | null;
  diagnostics?: { publicationMetadata?: Scope; privacyReasons?: string[]; injectionFlags?: string[]; conflictVersionIds?: number[] };
}
const channels = ["web", "whatsapp", "instagram", "facebook", "email", "internal", "support_portal"];
const purposes = ["support_answer", "outreach_reply", "content_draft", "proposal", "hotel_policy", "internal_assist"];
const selectClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

const personalDataLabels: Record<string, string> = {
  name: "a person's name", email: "an email address", phone: "a phone number", address: "a postal address",
  ip_address: "a public IP address", payment_card: "a card-like number", government_id: "a government ID", ssn: "a social security number",
};
const flagLabels: Record<string, string> = {
  private_key: "a private key", password_assignment: "a password", api_secret: "an API key or secret", bearer_token: "an access token",
  payment_card: "a card-like number", ignore_instructions: "text telling the AI to ignore its instructions",
  prompt_override: "text trying to override AI safety rules", prompt_exfiltration: "text asking the AI to reveal hidden prompts",
  tool_directive: "text telling the AI to run tools", role_reassignment: "text telling the AI to change its role",
};

/** Owner-facing wording for stored scan codes; the codes stay the audit record. */
export function knowledgeBlockReasons(codes: readonly string[]): string[] {
  const found = (prefix: string) => codes.filter(code => code.startsWith(prefix)).map(code => code.slice(prefix.length));
  const describe = (scope: string) => {
    const messages: string[] = [];
    const kinds = found(`${scope}personal_data:`).map(kind => personalDataLabels[kind] || kind.replaceAll("_", " "));
    if (codes.includes(`${scope}personal_data_detected`)) messages.push(kinds.length
      ? `Personal data found${scope ? " in the title or link" : ""}: ${[...new Set(kinds)].join(", ")}. Remove it, or add your business phone, email or address in Business profile so it is treated as public.`
      : `Personal data found${scope ? " in the title or link" : ""}. Remove names, contact details or identifiers that belong to people.`);
    const secrets = found(`${scope}secret:`).map(code => flagLabels[code] || code.replaceAll("_", " "));
    if (secrets.length) messages.push(`Sensitive value found: ${[...new Set(secrets)].join(", ")}. Remove it before publishing.`);
    const injections = [...found(`${scope}injection:`), ...(scope ? [] : codes.filter(code => flagLabels[code] && !code.includes(":") && !["private_key", "password_assignment", "api_secret", "bearer_token", "payment_card"].includes(code)))]
      .map(code => flagLabels[code] || code.replaceAll("_", " "));
    if (injections.length) messages.push(`Unsafe instructions found: ${[...new Set(injections)].join(", ")}. Rewrite this text as plain information.`);
    return messages;
  };
  const messages = [...describe(""), ...describe("metadata:")];
  const known = /^(?:metadata:)?(?:personal_data(?:_detected|:.+)|secret:.+|injection:.+)$/;
  const other = codes.filter(code => !known.test(code) && !flagLabels[code]);
  return [...messages, ...other];
}

interface KnowledgeReviewDialogProps {
  entry: { id: number; title: string; sourceUrl?: string; businessProfileId?: number | null; audience?: string | null;
    accessScope?: string | null; allowedChannels?: string[]; usageScopes?: string[]; locale?: string | null };
  profiles: { id: number; companyName: string }[]; onClose: () => void; onChanged: () => void;
}

export function KnowledgeReviewDialog(props: KnowledgeReviewDialogProps) {
  return <KnowledgeReviewContent key={props.entry.id} {...props} />;
}

function KnowledgeReviewContent({ entry, profiles, onClose, onChanged }: KnowledgeReviewDialogProps) {
  const active = useRef(true);
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [allowLexicalOnly, setAllowLexicalOnly] = useState(false);
  const [reason, setReason] = useState("");
  const [scopeDirty, setScopeDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [conflictReviewId, setConflictReviewId] = useState<number | null>(null);
  const [conflictDetails, setConflictDetails] = useState<{ versionId: number; ids: number[] } | null>(null);
  const [conflictRefreshFailed, setConflictRefreshFailed] = useState(false);
  const version = versions.find(item => item.id === selectedId);
  const live = versions.find(item => item.id === item.current_published_version_id);
  const editable = version?.status === "ready_for_review";
  const conflictIds = conflictDetails?.versionId === selectedId ? conflictDetails.ids : version?.diagnostics?.conflictVersionIds;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const load = async () => {
    const response = await api.get<{ versions: Version[] }>(`/api/knowledge-base/${entry.id}/versions`);
    if (!active.current) return;
    setVersions(response.versions);
    setSelectedId(current => current ?? response.versions[0]?.id ?? null);
  };
  useEffect(() => { let active = true;
    api.get<{ versions: Version[] }>(`/api/knowledge-base/${entry.id}/versions`).then(response => {
      if (active) { setVersions(response.versions); setSelectedId(response.versions[0]?.id ?? null); }
    }).catch(() => { if (active) setError("Versions could not be loaded. Close this panel and try again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [entry.id]);
  useEffect(() => {
    if (!version) return;
    setScope(version.diagnostics?.publicationMetadata || {
      title: entry.title, sourceUrl: entry.sourceUrl || null, businessProfileId: entry.businessProfileId || null,
      audience: entry.audience === "internal" ? "internal" : "customer",
      accessScope: entry.accessScope === "staff_only" ? "staff_only" : entry.businessProfileId ? "business_profile" : "tenant",
      usageScopes: entry.usageScopes?.length ? entry.usageScopes : version.usage_scopes || ["support_answer"],
      allowedChannels: entry.allowedChannels || [], locale: entry.locale || null,
    });
    setScopeDirty(false); setAllowLexicalOnly(false);
  }, [version, entry]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (scopeDirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [scopeDirty]);
  const change = (patch: Partial<Scope>) => { setScope(value => value ? { ...value, ...patch } : null); setScopeDirty(true); };
  const refreshConflictDetails = async (versionId: number) => {
    try {
      const response = await api.get<{ versions: Version[] }>(`/api/knowledge-base/${entry.id}/versions`);
      const refreshed = response.versions.find(item => item.id === versionId);
      if (!refreshed) throw new Error('Version details unavailable');
      if (active.current) {
        // Refresh diagnostics without replacing the owner's scope edits.
        setConflictDetails({ versionId, ids: refreshed.diagnostics?.conflictVersionIds || [] });
        setConflictRefreshFailed(false);
      }
    } catch { if (active.current) setConflictRefreshFailed(true); }
  };
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try {
      await action();
      if (!active.current) return;
      await load();
      if (!active.current) return;
      setScopeDirty(false); setConflictReviewId(null); setConflictDetails(null); setConflictRefreshFailed(false); onChanged();
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof Error && cause.message === 'KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION' && selectedId !== null) {
        setError('Publication paused because conflicting knowledge requires review. Review the version details before deciding what to replace.');
        setConflictReviewId(selectedId);
        await refreshConflictDetails(selectedId);
      } else setError(cause instanceof Error ? cause.message : "The change could not be saved.");
    } finally { if (active.current) setBusy(false); }
  };
  const saveScope = () => api.put(`/api/knowledge-base/${entry.id}/versions/${selectedId}/scope`, { metadata: scope });
  return <Dialog open onOpenChange={open => { if (!open) { if (scopeDirty) setConfirmClose(true); else onClose(); } }}>
    <DialogContent className="max-h-[90dvh] max-w-5xl overflow-y-auto">
      <DialogHeader><DialogTitle>Review knowledge: {entry.title}</DialogTitle>
        <DialogDescription>Agents can use the live version only when privacy, safety and access checks pass. Draft content and scope take effect together when published.</DialogDescription></DialogHeader>
      {error && <Callout tone="danger">{error}</Callout>}
      {conflictRefreshFailed && conflictReviewId === selectedId && <div className="space-y-2 text-sm"><p role="alert">Conflict details could not be refreshed. Your draft is retained.</p><Button variant="outline" disabled={busy} onClick={async () => {
        if (conflictReviewId === null) return;
        setBusy(true); await refreshConflictDetails(conflictReviewId); if (active.current) setBusy(false);
      }}>Retry conflict details</Button></div>}
      {loading ? <p role="status">Loading versions…</p> : !versions.length ? <p>This entry has no indexed version yet. Finish processing or retry indexing first.</p> : <>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>{live ? `Stored live version: v${live.version_no}${live.status === "published_degraded" ? " · keyword search only" : ""}` : "Not live"}</span>
          <label className="flex items-center gap-2">Inspect version
            <select aria-label="Inspect knowledge version" className={selectClass} value={selectedId || ""} disabled={busy || scopeDirty}
              onChange={event => setSelectedId(Number(event.target.value))}>
              {versions.map(item => <option key={item.id} value={item.id}>v{item.version_no} · {item.status.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          {scopeDirty && <span className="text-muted-foreground">Unsaved scope changes</span>}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="min-w-0"><h3 className="mb-2 text-sm font-medium">Live content {live ? `(v${live.version_no})` : ""}</h3>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-sans text-sm">{live?.normalized_content || "No published version."}</pre>
            {live?.readiness && live.id !== version?.id && <KnowledgeReadinessDetails readiness={live.readiness} />}</section>
          <section className="min-w-0"><h3 className="mb-2 text-sm font-medium">Selected content (v{version?.version_no})</h3>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-sans text-sm">{version?.normalized_content}</pre></section>
        </div>
        {version?.readiness ? <KnowledgeReadinessDetails readiness={version.readiness} /> : <p className="text-sm text-muted-foreground">Keyword index: {version?.lexical_index_status}. Semantic index: {version?.vector_index_status}. Current readiness unavailable.</p>}
        {version?.readiness && ['privacy_blocked', 'safety_blocked', 'partially_blocked'].includes(version.readiness.status) && <Link className="text-sm text-primary underline" href={`/dashboard/knowledge-base/${entry.id}`}>Review and correct source</Link>}
        {(version?.effective_at || version?.expires_at || version?.review_due_at) && <p className="text-sm text-muted-foreground">{version.effective_at ? `Effective: ${new Date(version.effective_at).toLocaleString()}. ` : ''}{version.expires_at ? `Expires: ${new Date(version.expires_at).toLocaleString()}. ` : ''}{version.review_due_at ? `Review due: ${new Date(version.review_due_at).toLocaleString()}.` : ''}</p>}
        {[
          ...knowledgeBlockReasons([...(version?.diagnostics?.privacyReasons || []), ...(version?.diagnostics?.injectionFlags || [])]),
          ...(conflictIds?.length ? [`Conflicts with versions: ${conflictIds.join(", ")}`] : []),
        ].map(message => <p key={message} className="text-sm text-destructive">{message}</p>)}
        {scope && <fieldset disabled={!editable || busy} className="space-y-4 rounded-lg border p-4">
          <legend className="px-2 text-sm font-medium">Version audience and scope</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">Audience<select className={selectClass} value={scope.audience} onChange={event => change({ audience: event.target.value as Scope["audience"], ...(event.target.value === "customer" && scope.accessScope === "staff_only" ? { accessScope: scope.businessProfileId ? "business_profile" : "tenant" } : {}) })}>
              <option value="customer">Customers and staff</option><option value="internal">Internal staff only</option></select></label>
            <label className="space-y-1 text-sm">Business profile<select className={selectClass} disabled value={scope.businessProfileId || ""} onChange={event => change({ businessProfileId: event.target.value ? Number(event.target.value) : selectedBusinessProfileId(), accessScope: scope.accessScope === "staff_only" ? "staff_only" : event.target.value ? "business_profile" : "tenant" })}>
              <option value="">Current business</option>{profiles.filter(profile => profile.id === selectedBusinessProfileId()).map(profile => <option key={profile.id} value={profile.id}>{profile.companyName}</option>)}</select></label>
            <label className="space-y-1 text-sm">Access<select className={selectClass} value={scope.accessScope} onChange={event => change({ accessScope: event.target.value as Scope["accessScope"], ...(event.target.value === "staff_only" ? { audience: "internal" as const } : {}) })}>
              <option value="tenant">Organization</option>{scope.businessProfileId && <option value="business_profile">Selected business profile</option>}<option value="staff_only">Staff only</option></select></label>
            <label className="space-y-1 text-sm">Language / locale<Input value={scope.locale || ""} placeholder="All languages, or en-IN" onChange={event => change({ locale: event.target.value || null })} /></label>
          </div>
          <fieldset><legend className="mb-2 text-sm">Channels (none selected means all channels)</legend><div className="flex flex-wrap gap-3">{channels.map(channel => <label key={channel} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scope.allowedChannels.includes(channel)} onChange={event => change({ allowedChannels: event.target.checked ? [...scope.allowedChannels, channel] : scope.allowedChannels.filter(value => value !== channel) })} />{channel.replaceAll("_", " ")}</label>)}</div></fieldset>
          <fieldset><legend className="mb-2 text-sm">Used for</legend><div className="flex flex-wrap gap-3">{purposes.map(purpose => <label key={purpose} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scope.usageScopes.includes(purpose)} onChange={event => change({ usageScopes: event.target.checked ? [...scope.usageScopes, purpose] : scope.usageScopes.filter(value => value !== purpose) })} />{purpose.replaceAll("_", " ")}</label>)}</div></fieldset>
          <p className="text-xs text-muted-foreground">Support answer is shared factual knowledge available to specialist assistants. Select only specific purposes to narrow access. When restricting channels, include support portal for staff library access.</p>
          {editable && <Button variant="outline" disabled={!scopeDirty || !scope.usageScopes.length} onClick={() => void mutate(saveScope)}>Save draft scope</Button>}
        </fieldset>}
        {editable && <div className="space-y-3">
          {version?.vector_index_status !== "completed" && <label className="flex items-start gap-2 rounded-md border p-3 text-sm"><input type="checkbox" checked={allowLexicalOnly} onChange={event => setAllowLexicalOnly(event.target.checked)} className="mt-1" />Publish with keyword search only. Exact wording can work, but semantic matches may be missed until indexing recovers.</label>}
          <Button disabled={busy || ['privacy_blocked', 'safety_blocked', 'partially_blocked'].includes(version?.readiness?.status || '') || !scope?.usageScopes.length || (version?.vector_index_status !== "completed" && !allowLexicalOnly)} onClick={() => void mutate(async () => {
            if (scopeDirty) { await saveScope(); if (!active.current) return; }
            return api.post(`/api/knowledge-base/${entry.id}/versions/${selectedId}/publish`, { authority: "owner_authored", allowLexicalOnly });
          })}>{busy ? "Saving…" : `Publish v${version?.version_no}`}</Button>
        </div>}
        {version && ['published', 'published_degraded', 'retired'].includes(version.status) && !versions.some(item => item.status === 'ready_for_review') && <Button variant="outline" disabled={busy} onClick={() => void mutate(async () => {
          const response = await api.post<{ result: { versionId: number } }>(`/api/knowledge-base/${entry.id}/versions/${selectedId}/draft`, {});
          if (active.current) setSelectedId(response.result.versionId);
        })}>Create draft from v{version.version_no}</Button>}
        {live && <div className="space-y-2 border-t pt-4"><label className="text-sm">Withdrawal reason<Input value={reason} onChange={event => setReason(event.target.value)} placeholder="Why should agents stop using this entry?" /></label>
          <Button variant="destructive" disabled={busy || !reason.trim()} onClick={() => void mutate(() => api.post(`/api/knowledge-base/${entry.id}/withdraw`, { reason }))}>Withdraw live version</Button>
          <p className="text-xs text-muted-foreground">Stops new replies from using this entry immediately. Version history remains available.</p></div>}
      </>}
      {confirmClose && <div role="alert" className="space-y-2 rounded-md border p-3 text-sm"><p>Discard unsaved scope changes?</p><Button variant="outline" onClick={() => setConfirmClose(false)}>Keep editing</Button> <Button variant="destructive" onClick={onClose}>Discard changes</Button></div>}
    </DialogContent>
  </Dialog>;
}

export function KnowledgeRetrievalTester({ profiles }: { profiles: { id: number; companyName: string }[] }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [audience, setAudience] = useState("customer");
  const [channel, setChannel] = useState("web");
  const [purpose, setPurpose] = useState("support_answer");
  const [profile, setProfile] = useState("");
  const [locale, setLocale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ status: string; diagnostics: { degraded?: boolean; reason?: string }; ownerReadiness?: { scopeOnly: boolean; privacyBlockedSources: number; safetyBlockedSources: number; indexingBlockedSources: number }; evidence: { evidenceId: string; title: string; excerpt: string; sourceUrl?: string; versionId: number }[] } | null>(null);
  const blockedSources = (result?.ownerReadiness?.privacyBlockedSources || 0) + (result?.ownerReadiness?.safetyBlockedSources || 0) + (result?.ownerReadiness?.indexingBlockedSources || 0);
  const statusText: Record<string, string> = { sufficient: "Published evidence found", insufficient: "No matching published evidence for these settings. Check the wording, publication status and scope.", unavailable: "Search is temporarily unavailable. Try again after indexing or provider recovery.", stale_only: "Matching knowledge has expired. Review and republish it.", access_denied: "Matching knowledge is restricted to staff.", conflict_detected: "Conflicting knowledge requires owner review." };
  return <><Button size="sm" variant="outline" onClick={() => setOpen(true)}>Test retrieval</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>Test published knowledge</DialogTitle><DialogDescription>Check the exact evidence available to a channel and audience. This does not send a customer message.</DialogDescription></DialogHeader>
    <label className="space-y-1 text-sm">Question<Input value={question} onChange={event => setQuestion(event.target.value)} placeholder="What are the check-in times?" /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Audience<select className={selectClass} value={audience} onChange={event => setAudience(event.target.value)}><option value="customer">Customer</option><option value="internal">Staff</option></select></label>
      <label className="text-sm">Channel<select className={selectClass} value={channel} onChange={event => setChannel(event.target.value)}>{channels.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="text-sm">Business profile<select className={selectClass} value={profile} onChange={event => setProfile(event.target.value)}><option value="">Current business</option>{profiles.filter(profile => profile.id === selectedBusinessProfileId()).map(value => <option key={value.id} value={value.id}>{value.companyName}</option>)}</select></label>
      <label className="text-sm">Purpose<select className={selectClass} value={purpose} onChange={event => setPurpose(event.target.value)}>{purposes.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="text-sm">Language / locale<Input value={locale} onChange={event => setLocale(event.target.value)} placeholder="All languages, or en-IN" /></label>
    </div>
    <Button disabled={busy || !question.trim()} onClick={async () => { setBusy(true); setError(""); setResult(null); try {
      const response = await api.post<{ result: NonNullable<typeof result> }>("/api/knowledge-base/test-retrieval", { question, audience, channel, purpose, locale: locale || null, businessProfileId: profile ? Number(profile) : null }); setResult(response.result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Search failed. Try again."); } finally { setBusy(false); } }}>{busy ? "Searching…" : "Run retrieval test"}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <section aria-live="polite" className="space-y-3"><p className="text-sm font-medium">{result.status === 'insufficient' && blockedSources > 0 ? 'No usable evidence returned. Published sources in this scope require review.' : statusText[result.status] || result.status}</p>
      {result.ownerReadiness && blockedSources > 0 && <div className="rounded-md border p-3 text-sm"><p>Owner diagnostics: {result.ownerReadiness.privacyBlockedSources} privacy blocked · {result.ownerReadiness.safetyBlockedSources} safety blocked · {result.ownerReadiness.indexingBlockedSources} awaiting indexing.</p><p>These are source readiness counts for the selected settings, not matches to your question. Review versions, correct the source, rebuild its index and review before publishing. Blocked content remains excluded.</p></div>}
      {result.diagnostics.degraded && <p className="text-sm text-muted-foreground">Semantic search coverage is reduced. Keyword search still applies privacy and access rules; this does not mean stored source embeddings are missing.</p>}{result.evidence.map(item => <article key={item.evidenceId} className="space-y-2 rounded-md border p-3"><p className="text-sm font-medium">{item.title}</p><p className="whitespace-pre-wrap break-words text-sm">{item.excerpt}</p>{item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl) && <a className="break-all text-sm text-primary underline" href={item.sourceUrl} target="_blank" rel="noreferrer">Source</a>}</article>)}</section>}
  </DialogContent></Dialog></>;
}
