"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  BookOpen,
  CheckCircle2,
  Code2,
  GitBranch,
  LockKeyhole,
  Plus,
  RefreshCw,
  Route,
  Save,
  ShieldCheck,
  Trash2,
  UserCheck,
  Workflow,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/admin-api";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  getPlaybookGraphIssues,
  normalizePlaybookGraph,
  PlaybookGraphEditor,
  PlaybookVariantsEditor,
  type PlaybookGraph,
} from "@/components/support/PlaybookGraphEditor";

type AgentType =
  | "hotel_sales"
  | "tech_support"
  | "lead_qualifier"
  | "customer_success"
  | "general_service";

interface Assignment {
  channel: string | null;
  intent: string | null;
  agentType: AgentType;
  priority: number;
  trafficPercent: number;
  enabled?: boolean;
}

interface Template {
  id: number;
  templateKey: string;
  name: string;
  description: string | null;
  agentType: AgentType;
  status: "published" | "archived";
  graph: PlaybookGraph;
  assignments: Assignment[];
  version: number;
  updatedAt: string;
}

const AGENTS: AgentType[] = [
  "hotel_sales",
  "tech_support",
  "lead_qualifier",
  "customer_success",
  "general_service",
];

const CHANNELS = ["all", "email", "whatsapp", "instagram", "facebook", "web"];
const INTENTS = [
  "all",
  "greeting",
  "faq",
  "availability_inquiry",
  "pricing_question",
  "booking_request",
  "negotiation",
  "modify_booking",
  "cancel_booking",
  "complaint",
  "refund_request",
  "support_request",
  "speak_to_human",
  "smalltalk",
  "clarify",
  "other",
  "payment_inquiry",
  "ticket_status",
  "lead_qualification",
  "sales_inquiry",
  "purchase_intent",
  "demo_request",
];

const EMPTY_GRAPH: PlaybookGraph = {
  entryNodeId: "start",
  nodes: [
    {
      id: "start",
      type: "trigger",
      data: { label: "Conversation starts" },
      position: { x: 30, y: 110 },
    },
    {
      id: "reply",
      type: "message",
      data: {
        label: "Verified response",
        instruction: "Give a verified, policy-compliant response.",
        requiredPhrases: [],
      },
      position: { x: 310, y: 110 },
    },
    {
      id: "done",
      type: "complete",
      data: { label: "Resolved" },
      position: { x: 600, y: 110 },
    },
  ],
  edges: [
    { id: "start-reply", source: "start", target: "reply", condition: { operator: "always" } },
    { id: "reply-done", source: "reply", target: "done", condition: { operator: "always" } },
  ],
};

function keyFromName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function readable(value: string) {
  return value.replaceAll("_", " ");
}

function createAssignment(agentType: AgentType): Assignment {
  return {
    channel: null,
    intent: null,
    agentType,
    priority: 100,
    trafficPercent: 100,
    enabled: true,
  };
}

export default function AdminSupportPlaybooksPage() {
  const { admin } = useAdminAuth();
  const { toast } = useToast();
  const canEdit = admin?.role === "super_admin";

  const [items, setItems] = useState<Template[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [activeTab, setActiveTab] = useState("flow");

  const [name, setName] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [description, setDescription] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("general_service");
  const [status, setStatus] = useState<"published" | "archived">("published");
  const [graph, setGraph] = useState<PlaybookGraph>(normalizePlaybookGraph(EMPTY_GRAPH));
  const [graphJson, setGraphJson] = useState(JSON.stringify(EMPTY_GRAPH, null, 2));
  const [assignments, setAssignments] = useState<Assignment[]>([]);

  const selected = useMemo(
    () => items.find((item) => item.templateKey === selectedKey) || null,
    [items, selectedKey],
  );

  const applyGraph = useCallback((next: PlaybookGraph) => {
    const normalized = normalizePlaybookGraph(next);
    setGraph(normalized);
    setGraphJson(JSON.stringify(normalized, null, 2));
  }, []);

  const select = useCallback((item: Template) => {
    const normalized = normalizePlaybookGraph(item.graph);
    setIsNew(false);
    setSelectedKey(item.templateKey);
    setName(item.name);
    setTemplateKey(item.templateKey);
    setDescription(item.description || "");
    setAgentType(item.agentType);
    setStatus(item.status);
    setGraph(normalized);
    setGraphJson(JSON.stringify(normalized, null, 2));
    setAssignments((item.assignments || []).map((assignment) => ({ ...assignment })));
    setActiveTab("flow");
  }, []);

  const load = useCallback(async (preferredKey?: string | null) => {
    setLoading(true);
    try {
      const result = await api.get<Template[]>("/api/admin/support-playbook-templates");
      const templates = result || [];
      setItems(templates);
      const key = preferredKey === undefined ? selectedKey : preferredKey;
      const next = templates.find((item) => item.templateKey === key) || templates[0];
      if (next) select(next);
    } catch (error) {
      toast({
        title: "Unable to load support templates",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [select, selectedKey, toast]);

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startNew = () => {
    const nextGraph = normalizePlaybookGraph(EMPTY_GRAPH);
    setIsNew(true);
    setSelectedKey(null);
    setName("");
    setTemplateKey("");
    setDescription("");
    setAgentType("general_service");
    setStatus("published");
    setGraph(nextGraph);
    setGraphJson(JSON.stringify(nextGraph, null, 2));
    setAssignments([createAssignment("general_service")]);
    setActiveTab("flow");
  };

  const switchTab = (nextTab: string) => {
    if (activeTab === "json" && nextTab !== "json") {
      try {
        applyGraph(JSON.parse(graphJson) as PlaybookGraph);
      } catch {
        toast({
          title: "Fix the graph JSON before returning to the visual editor",
          variant: "destructive",
        });
        return;
      }
    }
    setActiveTab(nextTab);
  };

  const updateAssignment = (index: number, patch: Partial<Assignment>) => {
    if (!canEdit) return;
    setAssignments((current) => current.map((assignment, assignmentIndex) => (
      assignmentIndex === index ? { ...assignment, ...patch } : assignment
    )));
  };

  const save = async () => {
    if (!canEdit) return;

    let nextGraph = graph;
    if (activeTab === "json") {
      try {
        nextGraph = normalizePlaybookGraph(JSON.parse(graphJson) as PlaybookGraph);
      } catch {
        toast({ title: "Graph JSON is invalid", variant: "destructive" });
        return;
      }
    }

    if (!name.trim()) {
      toast({ title: "Add a template name", variant: "destructive" });
      return;
    }
    const issues = getPlaybookGraphIssues(nextGraph);
    if (issues.length) {
      toast({
        title: "The playbook flow is not ready",
        description: issues[0],
        variant: "destructive",
      });
      return;
    }
    if (assignments.some((assignment) => (
      assignment.agentType !== agentType
      || !Number.isInteger(assignment.priority)
      || assignment.priority < 0
      || assignment.priority > 100_000
      || !Number.isInteger(assignment.trafficPercent)
      || assignment.trafficPercent < 0
      || assignment.trafficPercent > 100
    ))) {
      toast({
        title: "Check the routing assignments",
        description: "Each route must use this template's agent, 0–100% whole-number traffic, and a whole-number priority from 0–100000.",
        variant: "destructive",
      });
      return;
    }

    const key = isNew ? (templateKey || keyFromName(name)) : templateKey;
    if (!key) {
      toast({ title: "Add a template key", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const body = {
        templateKey: key,
        name: name.trim(),
        description: description.trim(),
        agentType,
        status,
        graph: nextGraph,
        assignments,
      };
      const creating = isNew;
      const result = creating
        ? await api.post<{ template: Template; propagated: number }>(
          "/api/admin/support-playbook-templates",
          body,
        )
        : await api.put<{ template: Template; propagated: number }>(
          `/api/admin/support-playbook-templates/${encodeURIComponent(key)}`,
          body,
        );

      setIsNew(false);
      await load(result.template.templateKey);
      toast({
        title: creating ? "Admin template created" : "Admin template updated",
        description: `${result.propagated} managed client ${result.propagated === 1 ? "copy" : "copies"} updated. Customized copies were preserved.`,
      });
    } catch (error) {
      toast({
        title: "Unable to save template",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const controls = graph.metadata?.controls;
  const flowIssues = getPlaybookGraphIssues(graph);
  const hasEditor = Boolean(selected || isNew);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <BookOpen className="h-5 w-5 text-primary" />
            Support playbook templates
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build the default conversation flows, routing, compliance, and handoff behavior for every support agent.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          {canEdit && (
            <Button onClick={startNew}>
              <Plus className="mr-2 h-4 w-4" />
              New template
            </Button>
          )}
        </div>
      </div>

      {!canEdit && (
        <Callout tone="warning">
          View only. A super admin is required to change platform defaults.
        </Callout>
      )}

      <div className="grid gap-4 lg:grid-cols-[290px_minmax(0,1fr)]">
        <Card className="h-fit shadow-none">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Agent templates</CardTitle>
              <Badge variant="secondary">{items.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-1 p-2 pt-0">
            {loading ? (
              <LoadingState size="section" className="py-8" label="Loading agent templates…" />
            ) : items.length ? (
              items.map((item) => (
                <button
                  key={item.templateKey}
                  type="button"
                  onClick={() => select(item)}
                  className={`w-full rounded-lg border border-transparent p-3 text-left transition-colors hover:bg-muted ${
                    selectedKey === item.templateKey ? "border-primary/20 bg-primary/10" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-5">{item.name}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">v{item.version}</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="secondary" className="h-5 text-[9px]">{readable(item.agentType)}</Badge>
                    <span>{item.status}</span>
                    <span>·</span>
                    <span>{item.graph.nodes?.length || 0} steps</span>
                  </div>
                </button>
              ))
            ) : (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                No support templates are available.
              </div>
            )}
          </CardContent>
        </Card>

        {hasEditor ? (
          <div className="min-w-0 space-y-4">
            <Card className="shadow-none">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-sm">Template definition</CardTitle>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {isNew ? "Create a reusable platform default." : `Editing ${templateKey}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {selected && <Badge variant="outline">Admin source v{selected.version}</Badge>}
                    <Badge className={status === "published" ? "bg-emerald-600" : ""}>
                      {status === "published" ? "Published / live" : "Archived"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <div className="space-y-1.5 xl:col-span-2">
                    <Label className="text-xs">Template name</Label>
                    <Input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        if (isNew && !templateKey) setTemplateKey(keyFromName(event.target.value));
                      }}
                      placeholder="Template name"
                      disabled={!canEdit}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Template key</Label>
                    <Input
                      value={templateKey}
                      onChange={(event) => setTemplateKey(keyFromName(event.target.value))}
                      placeholder="template-key"
                      disabled={!canEdit || !isNew}
                    />
                  </div>
                  <div className="space-y-1.5 xl:col-span-3">
                    <Label className="text-xs">Purpose and usage</Label>
                    <Input
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="Describe when this playbook should be used."
                      disabled={!canEdit}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Default support agent</Label>
                    <select
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm capitalize"
                      value={agentType}
                      onChange={(event) => {
                        const nextAgent = event.target.value as AgentType;
                        setAgentType(nextAgent);
                        setAssignments((current) => current.map((assignment) => ({
                          ...assignment,
                          agentType: nextAgent,
                        })));
                      }}
                      disabled={!canEdit}
                    >
                      {AGENTS.map((agent) => <option key={agent} value={agent}>{readable(agent)}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Template status</Label>
                    <select
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={status}
                      onChange={(event) => setStatus(event.target.value as "published" | "archived")}
                      disabled={!canEdit}
                    >
                      <option value="published">Published / live</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <div className="flex h-10 w-full items-center gap-2 rounded-md border px-3 text-xs text-muted-foreground">
                      <Workflow className="h-3.5 w-3.5" />
                      {graph.nodes.length} steps · {graph.edges.length} connections
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <ShieldCheck className="h-4 w-4" />
                      Mandatory controls
                    </CardTitle>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      These controls remain enforced in every managed client copy.
                    </p>
                  </div>
                  <Badge variant={flowIssues.length ? "destructive" : "secondary"}>
                    {flowIssues.length ? `${flowIssues.length} flow issues` : "Ready to publish"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary" className="gap-1">
                    <LockKeyhole className="h-3 w-3" />Privacy {controls?.privacy || "enforced"}
                  </Badge>
                  <Badge variant="secondary" className="gap-1">
                    <ShieldCheck className="h-3 w-3" />PII redaction {controls?.piiRedaction || "enforced"}
                  </Badge>
                  <Badge variant="secondary" className="gap-1">
                    <ShieldCheck className="h-3 w-3" />Safety {controls?.safety || "enforced"}
                  </Badge>
                  <Badge variant="secondary" className="gap-1">
                    <UserCheck className="h-3 w-3" />Handoff {controls?.humanHandoff || "enabled"}
                  </Badge>
                  <Badge variant="secondary" className="gap-1">
                    <Wrench className="h-3 w-3" />Tool approval {controls?.toolApproval || "required"}
                  </Badge>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Saving increments the template version and atomically updates every client copy still marked managed.
                  Client-customized copies are not overwritten.
                </p>
              </CardContent>
            </Card>

            <Card className="overflow-hidden shadow-none">
              <Tabs value={activeTab} onValueChange={switchTab}>
                <CardHeader className="border-b pb-0">
                  <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-none bg-transparent p-0 sm:flex sm:justify-start sm:gap-0">
                    <TabsTrigger value="flow" className="gap-1.5 rounded-b-none border-b-2 border-transparent data-[state=active]:border-primary">
                      <Workflow className="h-3.5 w-3.5" />Flow editor
                    </TabsTrigger>
                    <TabsTrigger value="routing" className="gap-1.5 rounded-b-none border-b-2 border-transparent data-[state=active]:border-primary">
                      <Route className="h-3.5 w-3.5" />Routing ({assignments.length})
                    </TabsTrigger>
                    <TabsTrigger value="variants" className="gap-1.5 rounded-b-none border-b-2 border-transparent data-[state=active]:border-primary">
                      <GitBranch className="h-3.5 w-3.5" />A/B variants
                    </TabsTrigger>
                    <TabsTrigger value="json" className="gap-1.5 rounded-b-none border-b-2 border-transparent data-[state=active]:border-primary">
                      <Code2 className="h-3.5 w-3.5" />Advanced JSON
                    </TabsTrigger>
                  </TabsList>
                </CardHeader>

                <TabsContent value="flow" className="m-0 p-4">
                  <PlaybookGraphEditor graph={graph} onChange={applyGraph} readOnly={!canEdit} />
                </TabsContent>

                <TabsContent value="routing" className="m-0 p-4">
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold">Channel and intent assignments</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Higher-priority matching assignments are evaluated first. Traffic percentage supports controlled rollout.
                        </p>
                      </div>
                      {canEdit && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setAssignments((current) => [...current, createAssignment(agentType)])}
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />Add assignment
                        </Button>
                      )}
                    </div>

                    {!assignments.length ? (
                      <div className="rounded-xl border-2 border-dashed p-10 text-center">
                        <Route className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
                        <p className="text-sm font-medium text-muted-foreground">This playbook has no routing assignment</p>
                        <p className="mt-1 text-xs text-muted-foreground">It will not receive conversations until an assignment is added.</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {assignments.map((assignment, index) => (
                          <div key={`${assignment.channel}-${assignment.intent}-${index}`} className="rounded-xl border p-3">
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline">Route {index + 1}</Badge>
                                <Badge variant={assignment.enabled === false ? "secondary" : "default"}>
                                  {assignment.enabled === false ? "Disabled" : "Enabled"}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                  Active
                                  <Switch
                                    checked={assignment.enabled !== false}
                                    onCheckedChange={(checked) => updateAssignment(index, { enabled: checked })}
                                    disabled={!canEdit}
                                  />
                                </div>
                                {canEdit && (
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8 text-rose-700"
                                    onClick={() => setAssignments((current) => current.filter((_item, itemIndex) => itemIndex !== index))}
                                    aria-label={`Delete route ${index + 1}`}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            </div>
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                              <div className="space-y-1">
                                <Label className="text-[11px]">Channel</Label>
                                <select
                                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                                  value={assignment.channel || "all"}
                                  onChange={(event) => updateAssignment(index, {
                                    channel: event.target.value === "all" ? null : event.target.value,
                                  })}
                                  disabled={!canEdit}
                                >
                                  {CHANNELS.map((channel) => <option key={channel} value={channel}>{readable(channel)}</option>)}
                                </select>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-[11px]">Intent</Label>
                                <select
                                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                                  value={assignment.intent || "all"}
                                  onChange={(event) => updateAssignment(index, {
                                    intent: event.target.value === "all" ? null : event.target.value,
                                  })}
                                  disabled={!canEdit}
                                >
                                  {INTENTS.map((intent) => <option key={intent} value={intent}>{readable(intent)}</option>)}
                                </select>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-[11px]">Support agent</Label>
                                <select
                                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                                  value={assignment.agentType}
                                  disabled
                                >
                                  {AGENTS.map((agent) => <option key={agent} value={agent}>{readable(agent)}</option>)}
                                </select>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-[11px]">Priority</Label>
                                <Input
                                  type="number"
                                  value={assignment.priority}
                                  onChange={(event) => updateAssignment(index, { priority: Number(event.target.value) })}
                                  disabled={!canEdit}
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-[11px]">Traffic %</Label>
                                <Input
                                  type="number"
                                  min={0}
                                  max={100}
                                  value={assignment.trafficPercent}
                                  onChange={(event) => updateAssignment(index, {
                                    trafficPercent: Math.max(0, Math.min(100, Number(event.target.value))),
                                  })}
                                  disabled={!canEdit}
                                />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="variants" className="m-0 p-4">
                  <PlaybookVariantsEditor graph={graph} onChange={applyGraph} readOnly={!canEdit} />
                </TabsContent>

                <TabsContent value="json" className="m-0 space-y-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">Advanced graph definition</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Use this only for fields not available in the visual editor.
                      </p>
                    </div>
                    {canEdit && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          try {
                            applyGraph(JSON.parse(graphJson) as PlaybookGraph);
                            toast({ title: "JSON applied to the visual flow" });
                          } catch {
                            toast({ title: "Graph JSON is invalid", variant: "destructive" });
                          }
                        }}
                      >
                        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Apply JSON
                      </Button>
                    )}
                  </div>
                  <Textarea
                    className="min-h-[620px] font-mono text-xs"
                    value={graphJson}
                    onChange={(event) => setGraphJson(event.target.value)}
                    disabled={!canEdit}
                    spellCheck={false}
                  />
                </TabsContent>
              </Tabs>
            </Card>

            {canEdit && (
              <div className="sticky bottom-4 z-10 flex justify-end">
                <div className="rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur">
                  <Button onClick={save} loading={saving} loadingText="Save and propagate">
                    <Save className="mr-2 h-4 w-4" />
                    Save and propagate
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <Card className="border-dashed shadow-none">
            <CardContent className="flex min-h-[420px] flex-col items-center justify-center py-24 text-center">
              <Archive className="mb-3 h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">Select a template to inspect it</p>
              <p className="mt-1 text-xs text-muted-foreground">The visual flow, routing, controls, and variants will appear here.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
