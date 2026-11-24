"use client";
import { ConversationRecovery } from "@/components/support/ConversationRecovery";
import { ApprovalResumeRecovery } from "@/components/support/ApprovalResumeRecovery";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAssistantList, useAssistantWorkspace } from "@/hooks/use-outreach-assistants";
import { Activity, AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, FlaskConical, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import api from "@/lib/api";
import { readSupportSimulationResult, type SimulationResult } from "@/lib/support-simulation";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PrivacyAccessHistory, type PrivacyAccessRecord } from "@/components/support/PrivacyAccessHistory";
import { hasCurrentDeliveryReconciliation } from "@/lib/delivery-reconciliation";
import { LoadingState } from "@/components/ui/loading-state";
import { Callout } from "@/components/ui/callout";

interface Report {
  periodDays: number;
  outcomes: Array<{ channel: string; outcome: string; count: number; avg_confidence: number | null; avg_duration_ms: number | null }>;
  delivery: Array<{ status: string; count: number }>;
  handoffs: Array<{ status: string; priority: string; count: number; avg_age_seconds: number | null }>;
  playbooks: Array<{ id: number; name: string; version: number | null; runs: number; avg_compliance: number | null; completed: number }>;
  privacy: { retained_records: number; expiring_within_7_days: number; configured: boolean };
  tools: Array<{ tool_name: string; risk_level: string; status: string; count: number }>;
  privacyAccess: Array<{ action: string; count: number; last_access_at: string | null }>;
  privacyAccessHistory?: PrivacyAccessRecord[];
  knowledgeGaps: Array<{ intent: string; count: number; avg_confidence: number | null }>;
  guardrails: Array<{ violation_type: string; count: number }>;
  csat: { responses: number; average_rating: number | null; rating_1: number; rating_2: number; rating_3: number; rating_4: number; rating_5: number };
  adminAudit: Array<{ id: number; actor_type: string; actor_id: number | null; action: string; entity_type: string; entity_id: string | null; created_at: string }>;
  readiness: { llm: boolean; whatsapp: boolean; instagram: boolean; facebook: boolean; email: boolean; privacyVault: boolean; moderationEnabled: boolean; moderationConfigured: boolean; moderationFailClosed: boolean };
}

interface DeliveryAction {
  id: number;
  conversationId: number;
  channel: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  providerMessageId: string | null;
  nextAttemptAt?: string | null;
  leaseExpiresAt?: string | null;
  reconciledAt?: string | null;
  reconciliationNote?: string | null;
  updatedAt?: string;
  createdAt: string;
  payload: { recipient?: string; text?: string };
}

interface ToolExecution {
  id: number;
  conversationId: number;
  toolName: string;
  riskLevel: string;
  status: string;
  attemptCount: number;
  error: string | null;
  lastAttemptAt: string;
  reconciliationStatus: string | null;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unexpected error";

export default function SupportOrchestrationPage() {
  const workspace = useAssistantWorkspace();
  return <SupportOperations key={`${workspace.scopeKey[1]}:${workspace.profileId ?? 'pending'}`} workspace={workspace} />;
}

function SupportOperations({ workspace }: { workspace: ReturnType<typeof useAssistantWorkspace> }) {
  const assistants = useAssistantList(workspace);
  const [assistantId, setAssistantId] = useState('');
  const [assistantRevision, setAssistantRevision] = useState<'draft' | 'published'>('draft');
  const selectedAssistant = assistants.data?.assistants.find(item => item.id === assistantId);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const simulationReady = !!workspace.profileId && !workspace.profiles.isLoading && !assistants.isError
    && assistants.data?.runtimeEnabled === true && !!selectedAssistant
    && (assistantRevision === 'draft' || !!selectedAssistant.publishedRevision);
  const router = useRouter();
  const { toast } = useToast();
  const [report, setReport] = useState<Report | null>(null);
  const [uncertain, setUncertain] = useState<DeliveryAction[]>([]);
  const [toolRecovery, setToolRecovery] = useState<ToolExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [workingId, setWorkingId] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [providerIds, setProviderIds] = useState<Record<number, string>>({});
  const [toolNotes, setToolNotes] = useState<Record<number, string>>({});
  const [toolResults, setToolResults] = useState<Record<number, string>>({});
  const [simMessage, setSimMessage] = useState("");
  const [simChannel, setSimChannel] = useState("web");
  const [simKnownName, setSimKnownName] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [previewSessionId, setPreviewSessionId] = useState<number | undefined>();
  const [simulationHistory, setSimulationHistory] = useState<Array<{ message: string; reply: string }>>([]);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextReport, uncertainRows, sendingRows, failedRows, failedTools, runningTools] = await Promise.all([
        api.get<Report>("/api/support/ai/orchestration-report?days=30"),
        api.get<DeliveryAction[]>("/api/support/ai/delivery-actions?status=uncertain"),
        api.get<DeliveryAction[]>("/api/support/ai/delivery-actions?status=sending"),
        api.get<DeliveryAction[]>("/api/support/ai/delivery-actions?status=failed"),
        api.get<ToolExecution[]>("/api/support/ai/tool-executions?status=failed"),
        api.get<ToolExecution[]>("/api/support/ai/tool-executions?status=running"),
      ]);
      setReport(nextReport);
      setUncertain([...uncertainRows, ...sendingRows, ...failedRows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      setToolRecovery([...failedTools, ...runningTools].sort((a, b) => Date.parse(b.lastAttemptAt) - Date.parse(a.lastAttemptAt)));
    } catch (error: unknown) {
      setLoadError(errorMessage(error));
      toast({ title: "Unable to load operations data", description: errorMessage(error), variant: "destructive" });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const openLinkedSection = () => {
      if (window.location.hash === "#simulator") {
        setActiveTab("test");
      }
    };
    openLinkedSection();
    window.addEventListener("hashchange", openLinkedSection);
    return () => window.removeEventListener("hashchange", openLinkedSection);
  }, []);

  useEffect(() => {
    if (report && activeTab === "test" && window.location.hash === "#simulator") {
      requestAnimationFrame(() => document.getElementById("simulator")?.scrollIntoView?.({ block: "start" }));
    }
  }, [activeTab, report]);

  const totals = useMemo(() => ({
    audited: report?.outcomes.reduce((sum, item) => sum + Number(item.count), 0) || 0,
    handoffs: report?.handoffs.reduce((sum, item) => sum + Number(item.count), 0) || 0,
    toolRuns: report?.tools.reduce((sum, item) => sum + Number(item.count), 0) || 0,
    reveals: report?.privacyAccess.reduce((sum, item) => sum + Number(item.count), 0) || 0,
  }), [report]);
  const deliveryReview = uncertain.filter((action) => !hasCurrentDeliveryReconciliation(action));
  const recordedReconciliations = uncertain.filter(hasCurrentDeliveryReconciliation);
  const reviewCount = deliveryReview.length + toolRecovery.length;
  const criticalSetup = report ? [
    !report.readiness.llm ? "AI provider needs attention before automatic replies can run." : null,
    !report.readiness.privacyVault || !report.privacy.configured ? "Sensitive-message protection needs an administrator to finish setup." : null,
  ].filter((message): message is string => Boolean(message)) : [];

  const reconcile = async (action: DeliveryAction, outcome: "sent" | "failed") => {
    const note = (notes[action.id] || "").trim();
    if (note.length < 3) {
      toast({ title: "Add a verification note", description: "Record how the provider outcome was confirmed.", variant: "destructive" });
      return;
    }
    setWorkingId(action.id);
    try {
      await api.post(`/api/support/ai/delivery-actions/${action.id}/reconcile`, {
        outcome,
        note,
        providerMessageId: providerIds[action.id] || null,
      });
      toast({ title: outcome === "sent" ? "Delivery confirmed" : "Action reopened for a safe retry" });
      await load();
    } catch (error: unknown) {
      toast({ title: "Unable to reconcile delivery", description: errorMessage(error), variant: "destructive" });
    } finally { setWorkingId(null); }
  };

  const simulate = async () => {
    if (!simMessage.trim() || !simulationReady || simulating) return;
    setSimulating(true);
    setSimulation(null);
    try {
      const result = readSupportSimulationResult(await api.post<unknown>("/api/support/ai/simulate", { message: simMessage, channel: simChannel, assistantId, assistantRevision, previewSessionId, mockProfile: { knownName: simKnownName } }, workspace.requestOptions));
      if (!mounted.current) return;
      setSimulation(result); setPreviewSessionId(result.previewSessionId);
      setSimulationHistory((history) => [...history, { message: simMessage, reply: result.replyText || result.handoffReason || "No automatic response proposed." }]);
      setSimMessage("");
    } catch (error: unknown) {
      if (!mounted.current) return;
      toast({ title: "Simulation failed", description: errorMessage(error), variant: "destructive" });
    } finally { if (mounted.current) setSimulating(false); }
  };

  const reconcileTool = async (execution: ToolExecution, outcome: "succeeded" | "not_executed") => {
    const note = (toolNotes[execution.id] || "").trim();
    if (note.length < 3) {
      toast({ title: "Add a verification note", description: "Record how the tool side effect was verified.", variant: "destructive" });
      return;
    }
    let result: Record<string, unknown> | undefined;
    if (outcome === "succeeded") {
      try {
        const enteredResult = toolResults[execution.id] || "";
        const parsed = JSON.parse(enteredResult.trim() ? enteredResult : "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        result = parsed;
      } catch {
        toast({ title: "Add a valid result object", description: "Successful reconciliation requires a JSON object with the verified provider result.", variant: "destructive" });
        return;
      }
    }
    setWorkingId(execution.id);
    try {
      await api.post(`/api/support/ai/tool-executions/${execution.id}/reconcile`, { outcome, note, result });
      toast({ title: outcome === "succeeded" ? "Tool result confirmed" : "No side effect confirmed; safe resume queued" });
      await load();
    } catch (error: unknown) {
      toast({ title: "Unable to reconcile tool execution", description: errorMessage(error), variant: "destructive" });
    } finally { setWorkingId(null); }
  };

  if (loading && !report) return <LoadingState size="section" className="py-16" label="Loading outreach operations" />;

  return <div className="container mx-auto max-w-screen-xl space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
      <div className="flex min-w-0 items-start gap-3">
        <Button size="icon" variant="ghost" onClick={() => router.push("/dashboard/settings/outreach")} aria-label="Back to outreach settings"><ArrowLeft className="h-4 w-4" /></Button>
        <div><p className="text-xs font-medium text-muted-foreground">Outreach settings</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">AI reply operations</h1><p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">Monitor automated customer replies across connected messaging channels, test a reply, and resolve items that need verification.</p></div>
      </div>
      <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Refresh data</Button>
    </header>

    {loadError && <Callout tone="danger" title="Operations data could not be refreshed." actions={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>}>{loadError}{report ? " The last loaded results are still shown." : ""}</Callout>}

    {report && <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
      <TabsList aria-label="Operations sections" className="flex h-auto w-full flex-wrap justify-start gap-1 sm:w-fit">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="test">Test a reply</TabsTrigger>
        <TabsTrigger value="review">Review issues{reviewCount > 0 && <span className="ml-2 rounded-full bg-amber-500/15 px-1.5 text-xs text-amber-700 dark:text-amber-300">{reviewCount}</span>}</TabsTrigger>
        <TabsTrigger value="reports">Reports &amp; status</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="space-y-5">
        <section aria-labelledby="operations-next-step" className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="p-5 sm:p-6"><p className="text-xs font-medium text-muted-foreground">Recent activity and current checks</p><h2 id="operations-next-step" className="mt-1 text-xl font-semibold tracking-tight">What needs your attention</h2><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Use this page to verify uncertain sends and test changes before customers see them. Routine activity stays in the reports.</p></div>
          <div className="grid border-y bg-muted/20 sm:grid-cols-3">
            {[{ label: "AI decisions · 30 days", value: totals.audited }, { label: "Human handoffs · 30 days", value: totals.handoffs }, { label: "Needs verification now", value: reviewCount }].map((item) => <div key={item.label} className="border-b p-5 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><p className="text-2xl font-semibold tabular-nums">{item.value}</p><p className="mt-1 text-xs text-muted-foreground">{item.label}</p></div>)}
          </div>
          <div className="space-y-3 p-5 sm:p-6">
            {criticalSetup.map((message) => <Callout key={message} tone="warning" className="p-3">{message}</Callout>)}
            {reviewCount > 0 ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><p className="text-sm"><span className="font-semibold">{reviewCount} item{reviewCount === 1 ? "" : "s"} need verification.</span><span className="ml-1 text-muted-foreground">Check the provider or business system before marking an outcome.</span></p><Button size="sm" onClick={() => setActiveTab("review")}>Review issues<ArrowRight className="ml-2 h-4 w-4" /></Button></div> : criticalSetup.length === 0 ? <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" />No delivery or tool checks need action right now.</p> : null}
          </div>
        </section>

        <section aria-label="Common operations tasks" className="grid gap-4 md:grid-cols-3">
          <Card className="shadow-none"><CardContent className="flex h-full flex-col p-5"><FlaskConical className="h-5 w-5 text-primary" /><h3 className="mt-4 font-semibold">Test a customer message</h3><p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">Preview the reply and handoff decision before changing live automation.</p><Button variant="outline" size="sm" className="mt-5 self-start" onClick={() => setActiveTab("test")}>Open test<ArrowRight className="ml-2 h-4 w-4" /></Button></CardContent></Card>
          <Card className="shadow-none"><CardContent className="flex h-full flex-col p-5"><Activity className="h-5 w-5 text-primary" /><h3 className="mt-4 font-semibold">Change reply behavior</h3><p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">Edit the playbooks that guide replies, routing, and handoffs.</p><Button asChild variant="outline" size="sm" className="mt-5 self-start"><Link href="/dashboard/settings/outreach/playbooks">Open playbooks<ArrowRight className="ml-2 h-4 w-4" /></Link></Button></CardContent></Card>
          <Card className="shadow-none"><CardContent className="flex h-full flex-col p-5"><ShieldCheck className="h-5 w-5 text-primary" /><h3 className="mt-4 font-semibold">Check connections</h3><p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">Review accounts for the email and messaging channels you use.</p><Button asChild variant="outline" size="sm" className="mt-5 self-start"><Link href="/dashboard/integrations">Manage connections<ArrowRight className="ml-2 h-4 w-4" /></Link></Button></CardContent></Card>
        </section>
      </TabsContent>

      <TabsContent value="reports" className="space-y-5">
        <div><h2 className="text-lg font-semibold">Reports and system status</h2><p className="mt-1 text-sm text-muted-foreground">Detailed results from the last 30 days and the current configuration of the services behind outreach AI.</p></div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[{ label: "Authorized tool runs", value: totals.toolRuns, icon: Wrench }, { label: "Restricted data reveals", value: totals.reveals, icon: ShieldCheck }].map(({ label, value, icon: Icon }) => <Card key={label} className="shadow-none"><CardContent className="flex items-center justify-between p-4"><div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p></div><Icon className="h-5 w-5 text-muted-foreground" /></CardContent></Card>)}
        </div>

    {!report.privacy.configured && <Callout tone="warning" title="Sensitive-message protection needs setup"><p className="text-xs text-muted-foreground">Ask a workspace administrator to configure the privacy vault. Messages containing sensitive information are held until it is ready.</p><details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Technical setup</summary><p className="mt-1">Set <code>SUPPORT_PII_ENCRYPTION_KEY</code> to a secret of at least 32 characters, or configure the shared secrets encryption key.</p></details></Callout>}

    <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">System and channel status</CardTitle><p className="text-xs text-muted-foreground">A missing channel connection matters only if your team uses that channel. An administrator manages service-level configuration.</p></CardHeader><CardContent className="space-y-5">
      <div><h3 className="mb-2 text-xs font-semibold">Required services</h3><div className="grid gap-2 sm:grid-cols-3">{[
        ["AI provider", report.readiness.llm, "Needed for automatic replies"],
        ["Privacy vault", report.readiness.privacyVault, "Protects sensitive messages"],
        ["Moderation", !report.readiness.moderationEnabled || report.readiness.moderationConfigured, report.readiness.moderationEnabled ? "Configured provider available" : "Optional provider disabled"],
      ].map(([label, ready, detail]) => <div key={String(label)} className="flex gap-2 rounded-md border p-3"><span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${ready ? "bg-emerald-500" : "bg-amber-500"}`} /><div><p className="text-xs font-medium">{String(label)}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{String(detail)}</p></div></div>)}</div></div>
      <div><h3 className="mb-2 text-xs font-semibold">Channel connections</h3><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{[
        ["WhatsApp", report.readiness.whatsapp], ["Instagram", report.readiness.instagram], ["Facebook", report.readiness.facebook], ["Email", report.readiness.email],
      ].map(([label, ready]) => <div key={String(label)} className="flex items-center gap-2 rounded-md border p-3 text-xs"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ready ? "bg-emerald-500" : "bg-muted-foreground/40"}`} /><span className="font-medium">{String(label)}</span><span className="ml-auto text-muted-foreground">{ready ? "Connected" : "Not connected"}</span></div>)}</div><Button asChild variant="link" size="sm" className="mt-2 px-0"><Link href="/dashboard/integrations">Manage connections<ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button></div>
      <p className="border-t pt-3 text-xs text-muted-foreground">Moderation outage behavior: {report.readiness.moderationFailClosed ? "block automatic actions when moderation is unavailable" : "continue under the configured policy when moderation is unavailable"}.</p>
    </CardContent></Card>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">Outcomes by channel</CardTitle></CardHeader><CardContent className="space-y-2">{report?.outcomes.length ? report.outcomes.map((item, index) => <div key={`${item.channel}-${item.outcome}-${index}`} className="flex items-center gap-2 rounded-md border p-2 text-xs"><Badge variant="outline" className="capitalize">{item.channel}</Badge><span className="capitalize">{item.outcome.replaceAll("_", " ")}</span><span className="ml-auto font-semibold">{item.count}</span><span className="text-muted-foreground">{item.avg_confidence == null ? "—" : `${Math.round(item.avg_confidence * 100)}% confidence`}</span></div>) : <p className="text-sm text-muted-foreground">No audited outcomes in this period.</p>}</CardContent></Card>
      <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">Published playbook performance</CardTitle></CardHeader><CardContent className="space-y-2">{report?.playbooks.length ? report.playbooks.map((item) => <div key={`${item.id}-${item.version}`} className="flex items-center gap-2 rounded-md border p-2 text-xs"><span className="font-medium">{item.name}</span><Badge variant="secondary">v{item.version || "—"}</Badge><span className="ml-auto">{item.runs} runs</span><span className="text-muted-foreground">{item.avg_compliance == null ? "—" : `${Math.round(item.avg_compliance * 100)}% compliant`}</span></div>) : <p className="text-sm text-muted-foreground">No playbook runs in this period.</p>}</CardContent></Card>
    </div>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">Knowledge gaps</CardTitle></CardHeader><CardContent className="space-y-2">{report?.knowledgeGaps.length ? report.knowledgeGaps.map((item) => <div key={item.intent} className="flex items-center gap-2 rounded-md border p-2 text-xs"><span className="font-medium capitalize">{item.intent.replaceAll("_", " ")}</span><span className="ml-auto font-semibold">{item.count}</span><span className="text-muted-foreground">{item.avg_confidence == null ? "—" : `${Math.round(item.avg_confidence * 100)}% confidence`}</span></div>) : <p className="text-sm text-muted-foreground">No low-confidence, ungrounded intents in this period.</p>}</CardContent></Card>
      <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">Guardrail and policy events</CardTitle></CardHeader><CardContent className="space-y-2">{report?.guardrails.length ? report.guardrails.map((item) => <div key={item.violation_type} className="flex items-center gap-2 rounded-md border p-2 text-xs"><Badge variant="outline" className="capitalize">{item.violation_type.replaceAll("_", " ")}</Badge><span className="ml-auto font-semibold">{item.count}</span></div>) : <p className="text-sm text-muted-foreground">No guardrail or policy violations in this period.</p>}</CardContent></Card>
    </div>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">Customer satisfaction</CardTitle></CardHeader><CardContent>{report?.csat.responses ? <div className="space-y-3"><div className="flex items-end gap-2"><span className="text-3xl font-semibold">{Number(report.csat.average_rating || 0).toFixed(1)}</span><span className="pb-1 text-xs text-muted-foreground">/ 5 from {report.csat.responses} responses</span></div><div className="grid grid-cols-5 gap-2">{[1,2,3,4,5].map((rating) => <div key={rating} className="rounded border p-2 text-center"><p className="text-[10px] text-muted-foreground">{rating} star</p><p className="text-sm font-semibold">{Number(report.csat[`rating_${rating}` as keyof Report["csat"]] || 0)}</p></div>)}</div></div> : <p className="text-sm text-muted-foreground">No CSAT responses in this period.</p>}</CardContent></Card>
      <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">Immutable configuration audit</CardTitle></CardHeader><CardContent className="max-h-64 space-y-2 overflow-y-auto">{report?.adminAudit.length ? report.adminAudit.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-md border p-2 text-xs"><Badge variant="outline" className="capitalize">{item.actor_type.replaceAll("_", " ")}</Badge><span className="font-medium">{item.action.replaceAll("_", " ")}</span><span className="text-muted-foreground">{item.entity_type}</span><span className="ml-auto whitespace-nowrap text-[10px] text-muted-foreground">{new Date(item.created_at).toLocaleString()}</span></div>) : <p className="text-sm text-muted-foreground">No configuration mutations in this period.</p>}</CardContent></Card>
    </div>

    <PrivacyAccessHistory entries={report?.privacyAccessHistory} />
      </TabsContent>

      <TabsContent value="test" className="space-y-4">
        <div><h2 className="text-lg font-semibold">Test a reply safely</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Try a realistic customer message. The preview shows the proposed reply and routing without sending a message or changing CRM data.</p></div>

    <Card id="simulator" className="scroll-mt-6 shadow-none"><CardHeader><CardTitle className="text-sm">Reply preview</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-xs text-muted-foreground">Approved read-only tools may run during a test. Customer sends and business changes are suppressed. Each turn continues this isolated test journey.</p><div className="grid gap-3 sm:grid-cols-2"><label>Assistant<select aria-label="Simulation assistant" className="h-10 w-full rounded-md border bg-background px-3" value={assistantId} disabled={simulating || simulationHistory.length > 0} onChange={event => setAssistantId(event.target.value)}><option value="">Choose an assistant</option>{assistants.data?.assistants.map(item => <option key={item.id} value={item.id}>{item.draft.name}</option>)}</select></label><label>Configuration<select aria-label="Simulation configuration" className="h-10 w-full rounded-md border bg-background px-3" value={assistantRevision} disabled={simulating || simulationHistory.length > 0} onChange={event => setAssistantRevision(event.target.value as 'draft' | 'published')}><option value="draft">Saved draft</option><option value="published" disabled={!selectedAssistant?.publishedRevision}>Published revision</option></select></label></div>{assistants.hasNextPage && <Button variant="outline" disabled={assistants.isFetchingNextPage || simulating || simulationHistory.length > 0} onClick={() => void assistants.fetchNextPage()}>Load more assistants</Button>}{assistants.isError && <p role="alert">Assistants could not be loaded. <Button variant="outline" onClick={() => void assistants.refetch()}>Retry assistants</Button></p>}{assistants.data?.runtimeEnabled === false && <p role="alert">AI replies are disabled. Review assistant setup.</p>}<div className="grid gap-2 md:grid-cols-[160px_1fr]"><select aria-label="Simulation channel" className="h-10 rounded-md border bg-background px-3 text-sm" value={simChannel} disabled={simulating || simulationHistory.length > 0} onChange={(event) => setSimChannel(event.target.value)}>{["web","email","whatsapp","instagram","facebook"].map((value) => <option key={value}>{value}</option>)}</select><Textarea aria-label="Customer test message" value={simMessage} onChange={(event) => setSimMessage(event.target.value)} placeholder="Enter one realistic customer message. Nothing will be sent or saved to CRM." rows={3} /></div><label className="flex items-center gap-2 text-xs"><Switch checked={simKnownName} disabled={simulating || simulationHistory.length > 0} onCheckedChange={setSimKnownName} />Use a test customer whose name is already known in CRM</label><div className="flex flex-wrap gap-2"><Button onClick={() => void simulate()} loading={simulating} disabled={!simMessage.trim() || !simulationReady}>Preview reply safely</Button><Button variant="outline" disabled={simulating} onClick={() => { setPreviewSessionId(undefined); setSimulation(null); setSimulationHistory([]); }}>Start a new test</Button></div>{simulationHistory.length > 0 && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-xs font-medium">Test conversation ({simulationHistory.length} turns)</summary><ol className="mt-3 space-y-3">{simulationHistory.map((turn, index) => <li key={index} className="space-y-1 text-sm"><p className="whitespace-pre-wrap break-words"><span className="font-medium">Customer: </span>{turn.message}</p><p className="whitespace-pre-wrap break-words text-muted-foreground"><span className="font-medium">Assistant: </span>{turn.reply}</p></li>)}</ol></details>}{simulation && <div className="space-y-3 rounded-lg border bg-muted/20 p-4"><div className="flex flex-wrap gap-2"><Badge variant="outline" className="capitalize">{simulation.outcome.replaceAll("_", " ")}</Badge><Badge variant="secondary">{simulation.agentType || "no agent"}</Badge>{simulation.intent && <Badge variant="outline">{simulation.intent}</Badge>}<span className="text-xs text-muted-foreground">{Math.round(simulation.confidence * 100)}% composite confidence</span></div>{simulation.piiTypes.length > 0 && <p className="text-xs text-amber-700">Redacted before models: {simulation.piiTypes.join(", ")}</p>}<div><p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Proposed response</p><p className="whitespace-pre-wrap text-sm">{simulation.replyText || simulation.handoffReason || "No automatic response proposed."}</p></div>{simulation.playbook && <p className="text-xs">Playbook #{simulation.playbook.playbookId} v{simulation.playbook.version} · node <code>{simulation.playbook.nodeId}</code></p>}<details><summary className="cursor-pointer text-xs font-medium">Technical decision trace</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background p-3 text-[10px]">{JSON.stringify({ mockKnownName: simKnownName, redactedInput: simulation.redactedInput, riskLevel: simulation.riskLevel, classificationConfidence: simulation.classificationConfidence, toolCalls: simulation.toolCalls, guardrail: simulation.guardrail, policyViolations: simulation.policyViolations, sideEffectsSuppressed: simulation.sideEffectsSuppressed }, null, 2)}</pre></details></div>}</CardContent></Card>
      </TabsContent>

      <TabsContent value="review" forceMount className="space-y-4 data-[state=inactive]:hidden">
        <div><h2 className="text-lg font-semibold">Verify uncertain outcomes</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Use provider records or your business system to confirm what happened before choosing an action. This prevents duplicate sends or repeated tool changes.</p></div>
        <ConversationRecovery />
        <ApprovalResumeRecovery />

    <Card className="shadow-none"><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4 text-amber-600" />Delivery reconciliation · {deliveryReview.length}</CardTitle></CardHeader><CardContent className="space-y-3">{deliveryReview.length === 0 ? <div className="flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />No ambiguous provider outcomes.</div> : deliveryReview.map((action) => <div key={action.id} className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs"><Badge className="capitalize" variant="outline">{action.status}</Badge><Badge variant="secondary" className="capitalize">{action.channel}</Badge><span>Conversation #{action.conversationId}</span><span className="text-muted-foreground">attempt {action.attemptCount}</span><span className="ml-auto text-muted-foreground">{new Date(action.createdAt).toLocaleString()}</span></div>
      <p className="line-clamp-2 text-sm">{action.payload?.text || "Outbound support message"}</p>{action.lastError && <p className="text-xs text-rose-700">{action.lastError}</p>}
      <div className="grid gap-2 md:grid-cols-2"><div className="space-y-1"><label htmlFor={`delivery-note-${action.id}`} className="text-xs font-medium">Provider verification note</label><Input id={`delivery-note-${action.id}`} value={notes[action.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [action.id]: event.target.value }))} placeholder="Required provider verification note" /></div><div className="space-y-1"><label htmlFor={`delivery-provider-id-${action.id}`} className="text-xs font-medium">Provider message ID</label><Input id={`delivery-provider-id-${action.id}`} value={providerIds[action.id] || ""} onChange={(event) => setProviderIds((current) => ({ ...current, [action.id]: event.target.value }))} placeholder="Provider message ID (if sent)" /></div></div>
      {action.nextAttemptAt && <p className="text-xs text-muted-foreground">Automatic retry after {new Date(action.nextAttemptAt).toLocaleString()}.</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={workingId === action.id} onClick={() => void reconcile(action, "sent")}>Confirm sent</Button><Button size="sm" variant="outline" disabled={workingId === action.id} onClick={() => void reconcile(action, "failed")}>Confirm not sent & allow retry</Button></div>
    </div>)}</CardContent></Card>

    {recordedReconciliations.length > 0 && <Card className="shadow-none"><CardHeader><CardTitle className="text-sm">Recorded delivery reconciliations · {recordedReconciliations.length}</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-xs text-muted-foreground">These failed records have a current reconciliation and no scheduled retry. Review the recorded evidence for context.</p>
      {recordedReconciliations.map((action) => <div key={action.id} className="space-y-2 rounded-lg border p-3" aria-label={`Recorded reconciliation for conversation ${action.conversationId}`}>
        <div className="flex flex-wrap items-center gap-2 text-xs"><Badge variant="outline" className="capitalize">{action.status}</Badge><Badge variant="secondary" className="capitalize">{action.channel}</Badge><span>Conversation #{action.conversationId}</span><span>No retry scheduled</span></div>
        <p className="line-clamp-2 text-sm">{action.payload?.text || "Outbound support message"}</p>
        {action.lastError && <p className="text-xs text-muted-foreground">{action.lastError}</p>}
        {action.reconciliationNote && <p className="text-xs text-muted-foreground">Recorded note: {action.reconciliationNote}</p>}
        <p className="text-xs text-muted-foreground">Reconciled {new Date(action.reconciledAt!).toLocaleString()}</p>
      </div>)}
    </CardContent></Card>}

    <Card className="shadow-none"><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Wrench className="h-4 w-4 text-amber-600" />Tool execution recovery · {toolRecovery.length}</CardTitle></CardHeader><CardContent className="space-y-3">{toolRecovery.length === 0 ? <div className="flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />No tool executions require reconciliation.</div> : toolRecovery.map((execution) => <div key={execution.id} className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs"><Badge variant="outline" className="capitalize">{execution.status}</Badge><Badge variant="secondary">{execution.riskLevel} risk</Badge><code>{execution.toolName}</code><span>Conversation #{execution.conversationId}</span><span className="ml-auto text-muted-foreground">{new Date(execution.lastAttemptAt).toLocaleString()}</span></div>
      {execution.error && <p className="text-xs text-rose-700">{execution.error}</p>}
      <div className="space-y-1"><label htmlFor={`tool-note-${execution.id}`} className="text-xs font-medium">Tool verification note</label><Input id={`tool-note-${execution.id}`} value={toolNotes[execution.id] || ""} onChange={(event) => setToolNotes((current) => ({ ...current, [execution.id]: event.target.value }))} placeholder="Required provider or database verification note" /></div>
      <div className="space-y-1"><label htmlFor={`tool-result-${execution.id}`} className="text-xs font-medium">Verified result</label><Textarea id={`tool-result-${execution.id}`} value={toolResults[execution.id] || ""} onChange={(event) => setToolResults((current) => ({ ...current, [execution.id]: event.target.value }))} placeholder='Verified result JSON for “confirmed succeeded” (for example {"bookingId":"..."})' rows={2} /></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={workingId === execution.id} onClick={() => void reconcileTool(execution, "succeeded")}>Confirm succeeded</Button><Button size="sm" variant="outline" disabled={workingId === execution.id} onClick={() => void reconcileTool(execution, "not_executed")}>Confirm no side effect & resume</Button></div>
    </div>)}</CardContent></Card>
      </TabsContent>
    </Tabs>}
  </div>;
}
