"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/admin-api";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RefreshCw, Save, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { policyValidationMessage } from "@/lib/support-policy-rules";
import {
  SUPPORT_CHANNEL_OPTIONS,
  SUPPORT_TOOL_OPTIONS,
  supportPolicyRuleLabel,
  supportPolicyRuleSummary,
  supportPolicyRules,
} from "@/lib/support-runtime-options";

interface AgentTemplate {
  id: number; agentType: string; displayName: string; description: string | null; systemPrompt: string;
  toolsEnabled: string[]; escalationRules: unknown; channelScope: string[]; priority: number;
  metadata: Record<string, unknown>; version: number;
}

export default function AdminSupportAgentsPage() {
  const { admin } = useAdminAuth();
  const { toast } = useToast();
  const canEdit = admin?.role === "super_admin";
  const [items, setItems] = useState<AgentTemplate[]>([]);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentTemplate | null>(null);
  const [rulesJson, setRulesJson] = useState("{}");
  const [metadataJson, setMetadataJson] = useState("{}");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const selected = useMemo(() => items.find((item) => item.agentType === selectedType) || null, [items, selectedType]);

  const choose = useCallback((item: AgentTemplate) => {
    setSelectedType(item.agentType); setDraft({ ...item });
    setRulesJson(JSON.stringify(item.escalationRules, null, 2));
    setMetadataJson(JSON.stringify(item.metadata, null, 2));
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<AgentTemplate[]>("/api/admin/support-agent-templates");
      setItems(result || []); const next = result.find((item) => item.agentType === selectedType) || result[0]; if (next) choose(next);
    } catch (error) { toast({ title: "Unable to load agent defaults", description: error instanceof Error ? error.message : undefined, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [choose, selectedType, toast]);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!draft || !canEdit) return;
    try {
      const escalationRules = JSON.parse(rulesJson); const metadata = JSON.parse(metadataJson);
      const validationError = policyValidationMessage(escalationRules);
      if (validationError) throw new Error(validationError);
      setSaving(true);
      const result = await api.put<{ template: AgentTemplate; propagated: number }>(`/api/admin/support-agent-templates/${draft.agentType}`, { ...draft, escalationRules, metadata });
      await load(); toast({ title: "Agent defaults updated", description: `${result.propagated} managed client ${result.propagated === 1 ? "configuration" : "configurations"} updated. Client-customized configurations were preserved.` });
    } catch (error) { toast({ title: "Unable to save agent defaults", description: error instanceof Error ? error.message : undefined, variant: "destructive" }); }
    finally { setSaving(false); }
  };

  const controls = (draft?.metadata || {}) as Record<string, string>;
  const visiblePolicyRules = (() => {
    try { return supportPolicyRules(JSON.parse(rulesJson || "{}")); }
    catch { return supportPolicyRules(draft?.escalationRules); }
  })();
  return <div className="space-y-5 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Support agent defaults</h1><p className="text-sm text-muted-foreground">Global prompts, tools, channels, escalation policies, privacy, safety, and handoff settings.</p></div><Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></div>
    {!canEdit && <Callout tone="warning">View only. A super admin is required to change global defaults.</Callout>}
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]"><Card><CardHeader><CardTitle className="text-sm">Support agents</CardTitle></CardHeader><CardContent className="space-y-1 p-2 pt-0">{loading ? <LoadingState size="section" className="py-8" label="Loading support agents…" /> : items.map((item) => <button key={item.agentType} onClick={() => choose(item)} className={`w-full rounded-lg p-3 text-left hover:bg-muted ${selectedType === item.agentType ? "bg-primary/10" : ""}`}><div className="flex justify-between gap-2"><span className="text-sm font-medium">{item.displayName}</span><Badge variant="outline">v{item.version}</Badge></div><p className="mt-1 text-[11px] text-muted-foreground">{item.agentType.replaceAll("_", " ")}</p></button>)}</CardContent></Card>
    {draft && selected ? <div className="space-y-4"><Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4" />Policy status</CardTitle></CardHeader><CardContent><div className="flex flex-wrap gap-2"><Badge variant="secondary">Privacy {controls.privacyStatus || "enforced"}</Badge><Badge variant="secondary">PII redaction {controls.piiRedactionStatus || "enforced"}</Badge><Badge variant="secondary">Safety {controls.safetyStatus || "enforced"}</Badge><Badge variant="secondary">Handoff {controls.handoffStatus || "enabled"}</Badge><Badge variant="secondary">Tool approval {controls.toolApprovalStatus || "required"}</Badge></div><p className="mt-3 text-xs text-muted-foreground">Saving creates admin version {selected.version + 1} and updates tenants still using the managed version.</p></CardContent></Card>
    <Card><CardHeader><CardTitle className="text-sm">Agent template</CardTitle></CardHeader><CardContent className="space-y-5"><div className="grid gap-3 md:grid-cols-2"><Input aria-label="Display name" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} disabled={!canEdit} /><Input aria-label="Description" value={draft.description || ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} disabled={!canEdit} /><div><Input aria-label="Routing priority" type="number" min={1} max={1000} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} disabled={!canEdit} /><p className="mt-1 text-[11px] text-muted-foreground">Lower numbers are routed first.</p></div></div><div><p className="mb-1 text-xs font-medium">System prompt</p><Textarea className="min-h-56 font-mono text-xs" value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} disabled={!canEdit} /></div>
    <section className="space-y-2"><div className="flex items-center justify-between"><p className="text-xs font-medium">Channel scope</p><Badge variant="outline">{draft.channelScope.length === 0 ? "All supported" : `${draft.channelScope.length} selected`}</Badge></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{SUPPORT_CHANNEL_OPTIONS.map((option) => { const checked = draft.channelScope.includes(option.value); return <button type="button" aria-pressed={checked} disabled={!canEdit} key={option.value} onClick={() => setDraft({ ...draft, channelScope: checked ? draft.channelScope.filter((item) => item !== option.value) : [...draft.channelScope, option.value] })} className={cn("rounded-lg border p-3 text-left disabled:cursor-not-allowed disabled:opacity-70", checked ? "border-primary bg-primary/10" : "border-border")}><span className="block text-xs font-semibold">{option.label}</span><span className="mt-1 block text-[10px] text-muted-foreground">{option.description}</span></button>; })}</div>{canEdit && <div className="flex justify-end"><Button type="button" size="sm" variant="ghost" onClick={() => setDraft({ ...draft, channelScope: [] })}>Use all channels</Button></div>}</section>
    <section className="space-y-2"><div className="flex items-center justify-between"><p className="text-xs font-medium">Authorized tools</p><Badge variant="outline">{draft.toolsEnabled.length} enabled</Badge></div><div className="grid gap-2 md:grid-cols-2">{SUPPORT_TOOL_OPTIONS.map((tool) => { const checked = draft.toolsEnabled.includes(tool.value); return <label key={tool.value} className={cn("flex items-start gap-3 rounded-lg border p-3", checked && "border-primary/50 bg-primary/5", !canEdit && "opacity-70")}><input className="mt-0.5 h-4 w-4" type="checkbox" checked={checked} disabled={!canEdit} onChange={() => setDraft({ ...draft, toolsEnabled: checked ? draft.toolsEnabled.filter((item) => item !== tool.value) : [...draft.toolsEnabled, tool.value] })} /><span><span className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold">{tool.label}</span><Badge variant={tool.risk === "write" ? "outline" : "secondary"} className="h-5 text-[9px]">{tool.risk === "write" ? "Approval required" : tool.risk === "handoff" ? "Handoff" : "Read only"}</Badge></span><span className="mt-1 block text-[10px] text-muted-foreground">{tool.description}</span></span></label>; })}</div></section>
    <section className="space-y-3"><div className="flex items-center justify-between"><p className="text-xs font-medium">Escalation and safety policies</p><Badge variant="outline">{visiblePolicyRules.filter((rule) => rule.enabled).length} active</Badge></div><div className="grid gap-2 md:grid-cols-2">{visiblePolicyRules.map((rule) => <div key={rule.id} className="rounded-lg border p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{supportPolicyRuleLabel(rule.type)}</span><Badge variant={rule.enabled ? "secondary" : "outline"} className="text-[9px]">{rule.enabled ? "Active" : "Disabled"}</Badge></div><p className="mt-1 text-[10px] text-muted-foreground">{supportPolicyRuleSummary(rule)}</p></div>)}</div><details className="rounded-lg border"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">Advanced policy JSON</summary><div className="border-t p-3"><Textarea aria-label="Advanced policy JSON" className="min-h-64 font-mono text-xs" value={rulesJson} onChange={(e) => setRulesJson(e.target.value)} disabled={!canEdit} /></div></details></section>
    <details className="rounded-lg border"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">Advanced control metadata</summary><div className="border-t p-3"><Textarea aria-label="Advanced control metadata" className="min-h-64 font-mono text-xs" value={metadataJson} onChange={(e) => setMetadataJson(e.target.value)} disabled={!canEdit} /></div></details>{canEdit && <div className="flex justify-end"><Button onClick={save} loading={saving} loadingText="Save and propagate"><Save className="mr-2 h-4 w-4" />Save and propagate</Button></div>}</CardContent></Card></div> : <Card><CardContent className="py-24 text-center text-sm text-muted-foreground">Select an agent to inspect it.</CardContent></Card>}</div>
  </div>;
}
