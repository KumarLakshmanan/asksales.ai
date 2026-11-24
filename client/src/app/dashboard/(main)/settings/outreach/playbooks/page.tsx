"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Archive,
  ArrowLeft,
  Code2,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Workflow,
  ListChecks,
  Radio,
  ChevronDown,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import api from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import {
  getPlaybookGraphIssues,
  PlaybookGraphEditor,
  type PlaybookGraph,
} from "@/components/support/PlaybookGraphEditor";
import { SupportIntentSelect } from "@/components/support/SupportIntentSelect";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import {
  groupSupportPlaybooks,
  preferredPlaybookId,
} from "@/lib/support-playbook-ui";
import { SearchInput } from "@/components/ui/search-input";

type Graph = PlaybookGraph;
interface Assignment {
  id: number;
  channel: string | null;
  intent: string | null;
  agentType: string | null;
  priority: number;
  trafficPercent: number;
  enabled: boolean;
  agentEnabled?: boolean;
  agentChannels?: string[];
}
export interface Playbook {
  id: number;
  name: string;
  description: string | null;
  status: string;
  enabled: boolean;
  draftGraph: Graph;
  activeVersion: number | null;
  assignments: Assignment[];
  templateKey: string | null;
  templateVersion: number | null;
  templateMode: "managed" | "customized" | "custom";
  templateCurrentVersion?: number | null;
}
interface AgentConfig {
  agentType: string;
  displayName: string;
  enabled: boolean;
}
interface AvailableTemplate {
  templateKey: string;
  name: string;
  description: string | null;
  version: number;
  schemaVersion: 1 | 2;
  installed: boolean;
}

interface FlowValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function playbookStatusLabel(item: Playbook) {
  if (item.status === "archived") return "Archived";
  if (item.enabled === false) return "Paused";
  if (item.status === "published") return "Live";
  return "Draft";
}

const STARTER_GRAPH: Graph = {
  entryNodeId: "start",
  nodes: [
    { id: "start", type: "trigger", data: {}, position: { x: 40, y: 120 } },
    {
      id: "reply",
      type: "message",
      data: {
        instruction:
          "Acknowledge the request and provide the next verified step.",
        requiredPhrases: [],
      },
      position: { x: 310, y: 120 },
    },
    { id: "done", type: "complete", data: {}, position: { x: 600, y: 120 } },
  ],
  edges: [
    {
      id: "start-reply",
      source: "start",
      target: "reply",
      condition: { operator: "always" },
    },
    {
      id: "reply-done",
      source: "reply",
      target: "done",
      condition: { operator: "always" },
    },
  ],
};

function normalizedGraph(input: Graph): Graph {
  const nodes = (input.nodes || []).map((node, index) => ({
    ...node,
    data: node.data || {},
    position: node.position || {
      x: 40 + (index % 3) * 280,
      y: 80 + Math.floor(index / 3) * 170,
    },
  }));
  return {
    ...input,
    fields: input.fields || [],
    entryNodeId: input.entryNodeId || nodes[0]?.id || "",
    nodes,
    edges: (input.edges || []).map((edge, index) => ({
      ...edge,
      id: edge.id || `${edge.source}-${edge.target}-${index}`,
      condition: edge.condition || { operator: "always" },
    })),
  };
}

export default function PlaybooksPage() {
  const router = useRouter();
  const pathname = usePathname();
  const supportSurface = pathname.startsWith("/dashboard/support/");
  const { toast } = useToast();
  const [items, setItems] = useState<Playbook[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [graph, setGraph] = useState<Graph>(normalizedGraph(STARTER_GRAPH));
  const [graphJson, setGraphJson] = useState(
    JSON.stringify(STARTER_GRAPH, null, 2),
  );
  const [draftPlaybookId, setDraftPlaybookId] = useState<number | null>(null);
  const [editorMode, setEditorMode] = useState<"visual" | "json">("visual");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [section, setSection] = useState<
    "flow" | "graph" | "questions" | "channels" | "settings"
  >("flow");
  const [playbookQuery, setPlaybookQuery] = useState("");
  const [channel, setChannel] = useState("whatsapp");
  const [intent, setIntent] = useState("");
  const [activeAgent, setActiveAgent] = useState<AgentConfig | null>(null);
  const [availableTemplates, setAvailableTemplates] = useState<
    AvailableTemplate[]
  >([]);
  const [templateKey, setTemplateKey] = useState("");
  const [assignmentPriority, setAssignmentPriority] = useState(100);
  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) || null,
    [items, selectedId],
  );
  const playbookGroups = useMemo(() => groupSupportPlaybooks(items), [items]);
  const installableTemplates = useMemo(
    () => availableTemplates.filter((template) => !template.installed),
    [availableTemplates],
  );
  const [checkedDraft, setCheckedDraft] = useState<{
    key: string;
    graph: Graph | null;
    result: FlowValidation;
  } | null>(null);
  // Invalidate on render, before effects run, so another playbook/revision
  // cannot briefly inherit the previous draft's all-clear.
  const validationKey = JSON.stringify([selectedId, editorMode, graphJson]);
  const candidate = useMemo(() => {
    try {
      const currentGraph = editorMode === "json" ? JSON.parse(graphJson) : graph;
      return { graph: currentGraph as Graph, issues: getPlaybookGraphIssues(currentGraph) };
    } catch {
      return { graph: null, issues: ["Provide a valid playbook graph."] };
    }
  }, [editorMode, graph, graphJson]);
  const validation = draftPlaybookId === selectedId && checkedDraft?.key === validationKey && checkedDraft.graph === candidate.graph
    ? checkedDraft.result
    : null;
  const validating = validation === null;
  const flowErrors = [...new Set([...candidate.issues, ...(validation?.errors || [])])];
  const checksPassed = validation?.valid === true && flowErrors.length === 0;
  const dirty = Boolean(
    selected &&
      (name !== selected.name ||
        description !== (selected.description || "") ||
        graphJson !==
          JSON.stringify(normalizedGraph(selected.draftGraph), null, 2)),
  );
  const { confirmLeave: confirmDiscard } = useUnsavedChanges(dirty);
  const navigate = (url: string) => {
    if (confirmDiscard()) router.push(url);
  };
  const selectedControls = selected?.draftGraph.metadata?.controls || {
    privacy: "enforced",
    piiRedaction: "enforced",
    safety: "enforced",
    humanHandoff: "enabled",
    toolApproval: "required",
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [result, configs, templates] = await Promise.all([
        api.get<Playbook[]>("/api/support/ai/playbooks"),
        api.get<AgentConfig[]>("/api/settings/ai-agents"),
        api.get<AvailableTemplate[]>("/api/support/ai/playbook-templates"),
      ]);
      setItems(result || []);
      setActiveAgent((configs || []).find((config) => config.enabled) || null);
      setAvailableTemplates(templates || []);
      setTemplateKey((current) => {
        const installable = (templates || []).filter(
          (template) => !template.installed,
        );
        return installable.some((template) => template.templateKey === current)
          ? current
          : installable[0]?.templateKey || "";
      });
      setSelectedId((current) =>
        current &&
        result.some((item) => item.id === current && item.status !== "archived")
          ? current
          : preferredPlaybookId(result),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Support playbooks could not be loaded.";
      setLoadError(message);
      toast({
        title: "Unable to load playbooks",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!selected) return;
    const next = normalizedGraph(selected.draftGraph);
    setName(selected.name);
    setDescription(selected.description || "");
    setGraph(next);
    setGraphJson(JSON.stringify(next, null, 2));
    setDraftPlaybookId(selected.id);
  }, [selected]);

  useEffect(() => {
    if (!selectedId || draftPlaybookId !== selectedId) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        if (!candidate.graph) throw new Error("Provide a valid playbook graph.");
        const result = await api.post<FlowValidation>("/api/support/ai/playbooks/validate", { graph: candidate.graph });
        if (!cancelled) setCheckedDraft({ key: validationKey, graph: candidate.graph, result });
      } catch (error) {
        if (!cancelled)
          setCheckedDraft({
            key: validationKey,
            graph: candidate.graph,
            result: {
              valid: false,
              errors: [
                error instanceof Error
                  ? error.message
                  : "Validation is unavailable. Retry before publishing.",
              ],
              warnings: [],
            },
          });
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [candidate, validationKey, selectedId, draftPlaybookId]);

  const updateVisualGraph = useCallback((next: Graph) => {
    setGraph(next);
    setGraphJson(JSON.stringify(next, null, 2));
  }, []);

  const parseGraph = () => {
    if (editorMode === "visual") return graph;
    try {
      return normalizedGraph(JSON.parse(graphJson) as Graph);
    } catch {
      toast({ title: "Graph JSON is invalid", variant: "destructive" });
      return null;
    }
  };

  const switchMode = (mode: "visual" | "json") => {
    if (mode === "visual" && editorMode === "json") {
      try {
        const next = normalizedGraph(JSON.parse(graphJson) as Graph);
        setGraph(next);
        setGraphJson(JSON.stringify(next, null, 2));
      } catch {
        toast({
          title: "Fix invalid JSON before opening the visual editor",
          variant: "destructive",
        });
        return;
      }
    }
    setEditorMode(mode);
  };

  const create = async () => {
    if (!confirmDiscard()) return;
    setWorking(true);
    try {
      const created = await api.post<Playbook>("/api/support/ai/playbooks", {
        name: `Support playbook ${items.length + 1}`,
        graph: STARTER_GRAPH,
      });
      await load();
      setSelectedId(created.id);
      toast({ title: "Playbook created" });
    } catch (error: any) {
      toast({
        title: "Unable to create",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const installTemplate = async () => {
    if (!confirmDiscard()) return;
    if (!templateKey) return;
    setWorking(true);
    try {
      const result = await api.post<{ playbook: Playbook; created: boolean }>(
        `/api/support/ai/playbook-templates/${encodeURIComponent(templateKey)}/install`,
        {},
      );
      await load();
      setSelectedId(result.playbook.id);
      toast({
        title: result.created
          ? "Managed template installed"
          : "Template already installed",
        description:
          "The template is now available for the active support agent and can be customized for this account.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to install template",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const save = async (): Promise<boolean> => {
    if (!selected) return false;
    const nextGraph = parseGraph();
    if (!nextGraph) return false;
    setWorking(true);
    try {
      await api.put(`/api/support/ai/playbooks/${selected.id}`, {
        name,
        description,
        graph: nextGraph,
      });
      setGraph(nextGraph);
      setGraphJson(JSON.stringify(nextGraph, null, 2));
      await load();
      toast({ title: "Draft saved" });
      return true;
    } catch (error: any) {
      toast({
        title: "Unable to save",
        description: error?.message,
        variant: "destructive",
      });
      return false;
    } finally {
      setWorking(false);
    }
  };

  const publish = async () => {
    if (!selected) return;
    if (candidate.issues.length) {
      toast({
        title: "Fix the flow before publishing",
        description: candidate.issues.join(" "),
        variant: "destructive",
      });
      return;
    }
    const nextGraph = parseGraph();
    if (!nextGraph) return;
    try {
      const result = await api.post<{
        valid: boolean;
        errors: string[];
        warnings: string[];
      }>("/api/support/ai/playbooks/validate", { graph: nextGraph });
      setCheckedDraft({ key: validationKey, graph: candidate.graph, result });
      if (!result.valid) {
        toast({
          title: "Fix the flow before publishing",
          description: result.errors.join(" "),
          variant: "destructive",
        });
        return;
      }
    } catch (error) {
      toast({
        title: "Validation unavailable",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
      return;
    }
    if (
      !window.confirm(
        `Publish changes to “${name}”? New conversations will use this version${selected.enabled === false ? " when the playbook is enabled" : ""}.`,
      )
    )
      return;
    if (!(await save())) return;
    setWorking(true);
    try {
      const version = await api.post<{ version: number }>(
        `/api/support/ai/playbooks/${selected.id}/publish`,
        {},
      );
      await load();
      toast({ title: `Version ${version.version} published` });
    } catch (error: any) {
      toast({
        title: "Publish validation failed",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const addAssignment = async () => {
    if (!selected || !confirmDiscard()) return;
    setWorking(true);
    try {
      await api.post(`/api/support/ai/playbooks/${selected.id}/assignments`, {
        channel,
        intent: intent || null,
        priority: assignmentPriority,
        trafficPercent: 100,
      });
      await load();
      toast({ title: "Routing assignment added" });
    } catch (error: any) {
      toast({
        title: "Unable to assign",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const removeAssignment = async (assignmentId: number) => {
    if (!selected || !confirmDiscard()) return;
    setWorking(true);
    try {
      await api.delete(
        `/api/support/ai/playbooks/${selected.id}/assignments/${assignmentId}`,
      );
      await load();
      toast({ title: "Routing assignment removed" });
    } catch (error: any) {
      toast({
        title: "Unable to remove assignment",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const togglePlaybook = async (enabled: boolean) => {
    if (!selected || !confirmDiscard()) return;
    setWorking(true);
    try {
      await api.patch(`/api/support/ai/playbooks/${selected.id}/enabled`, {
        enabled,
      });
      await load();
      toast({ title: enabled ? "Playbook enabled" : "Playbook disabled" });
    } catch (error: any) {
      toast({
        title: "Unable to update playbook",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const toggleAssignment = async (assignmentId: number, enabled: boolean) => {
    if (!selected || !confirmDiscard()) return;
    setWorking(true);
    try {
      await api.patch(
        `/api/support/ai/playbooks/${selected.id}/assignments/${assignmentId}/enabled`,
        { enabled },
      );
      await load();
      toast({ title: enabled ? "Assignment enabled" : "Assignment disabled" });
    } catch (error: any) {
      toast({
        title: "Unable to update assignment",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const archive = async () => {
    if (!selected || !confirmDiscard()) return;
    if (
      !window.confirm(
        `Archive “${selected.name}”? New conversations will stop using it. Its history will be retained.`,
      )
    )
      return;
    setWorking(true);
    try {
      await api.post(`/api/support/ai/playbooks/${selected.id}/archive`, {});
      await load();
      toast({
        title: "Playbook archived",
        description: "New conversations will no longer be assigned to it.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to archive",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const resetToAdmin = async () => {
    if (!selected?.templateKey) return;
    if (
      !window.confirm(
        "Replace this account's custom playbook and routing assignments with the current admin template?",
      )
    )
      return;
    setWorking(true);
    try {
      await api.post(
        `/api/support/ai/playbooks/${selected.id}/reset-default`,
        {},
      );
      await load();
      toast({
        title: "Admin template restored",
        description: "Future admin updates will apply to this playbook again.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to reset playbook",
        description: error?.message,
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <PageLoadingState label="Loading support playbooks…" />;
  if (loadError)
    return (
      <PageErrorState
        title="Support playbooks could not be loaded"
        description={loadError}
        reset={() => void load()}
      />
    );

  const filteredPlaybooks = playbookGroups.current.filter((item) =>
    item.name.toLowerCase().includes(playbookQuery.toLowerCase()),
  );
  const sections = [
    { id: "flow" as const, label: "Conversation", icon: Workflow },
    { id: "graph" as const, label: "Graph", icon: Workflow },
    { id: "questions" as const, label: "Questions", icon: ListChecks },
    { id: "channels" as const, label: "Channels", icon: Radio },
    { id: "settings" as const, label: "Settings", icon: Settings2 },
  ];
  const chooseSection = (next: typeof section) => {
    if (editorMode === "json" && next !== "settings") {
      try {
        const parsed = normalizedGraph(JSON.parse(graphJson));
        updateVisualGraph(parsed);
        setEditorMode("visual");
      } catch {
        toast({
          title: "Fix invalid JSON before leaving advanced settings",
          variant: "destructive",
        });
        return;
      }
    }
    setSection(next);
  };

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1600px] space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0"
            aria-label={
              supportSurface ? "Back to support" : "Back to assistants"
            }
            onClick={() =>
              navigate(
                supportSurface
                  ? "/dashboard/support"
                  : "/dashboard/settings/outreach",
              )
            }
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Support playbooks
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Shape how your agent helps customers, one conversation at a time.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            onClick={() => navigate("/dashboard/settings/outreach")}
          >
            <Settings2 className="mr-2 h-4 w-4" />
            Assistants
          </Button>
          <Button variant="outline" onClick={create} disabled={working}>
            <Plus className="mr-2 h-4 w-4" />
            New playbook
          </Button>
        </div>
      </header>
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside
          aria-label="Your playbooks"
          className="min-w-0 rounded-xl border bg-card p-3"
        >
          <div className="flex items-center justify-between gap-2 px-1 pb-3">
            <h2 className="text-sm font-medium">Your playbooks</h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {playbookGroups.current.length}
            </span>
          </div>
          <SearchInput
            aria-label="Search playbooks"
            placeholder="Find a playbook…"
            wrapperClassName="mb-2"
            value={playbookQuery}
            onValueChange={setPlaybookQuery}
          />
          <nav
            aria-label="Playbook selection"
            className="grid gap-1 sm:grid-cols-2 xl:grid-cols-1"
          >
            {filteredPlaybooks.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={selectedId === item.id ? "true" : undefined}
                disabled={working}
                onClick={() => {
                  if (confirmDiscard()) {
                    if (selectedId !== item.id) setCheckedDraft(null);
                    setSelectedId(item.id);
                    setEditorMode("visual");
                  }
                }}
                className={`min-w-0 rounded-lg border-l-2 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedId === item.id ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted"}`}
              >
                <span className="block break-words text-sm font-medium">
                  {item.name}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className={
                      playbookStatusLabel(item) === "Live" ? "text-success" : ""
                    }
                  >
                    {playbookStatusLabel(item)}
                  </span>
                  <span>
                    {item.activeVersion
                      ? `Version ${item.activeVersion}`
                      : "Not published"}
                  </span>
                </span>
              </button>
            ))}
          </nav>
          {!filteredPlaybooks.length && (
            <p className="p-3 text-sm text-muted-foreground">
              {playbookGroups.current.length
                ? "No playbooks match your search."
                : "Create a playbook or start from a template."}
            </p>
          )}
          {installableTemplates.length > 0 && (
            <details className="mt-3 border-t pt-2">
              <summary className="cursor-pointer py-2 text-sm font-medium">
                Start from a template
              </summary>
              <div className="space-y-2 py-2">
                <select
                  aria-label="Industry template"
                  className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                  value={templateKey}
                  onChange={(e) => setTemplateKey(e.target.value)}
                  disabled={working}
                >
                  {installableTemplates.map((template) => (
                    <option
                      key={template.templateKey}
                      value={template.templateKey}
                    >
                      {template.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={installTemplate}
                  disabled={working || !templateKey}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Install template
                </Button>
              </div>
            </details>
          )}
          {playbookGroups.archived.length > 0 && (
            <details className="mt-3 border-t pt-2">
              <summary className="cursor-pointer py-2 text-sm text-muted-foreground">
                Archived ({playbookGroups.archived.length})
              </summary>
              <p className="pb-2 text-xs text-muted-foreground">
                Retained for history. These do not start new conversations.
              </p>
              {playbookGroups.archived.map((item) => (
                <div key={item.id} className="border-t py-3">
                  <p className="break-words text-sm text-muted-foreground">
                    {item.name}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.activeVersion
                      ? `Last published version ${item.activeVersion}`
                      : "Never published"}
                  </p>
                </div>
              ))}
            </details>
          )}
        </aside>
        {selected ? (
          <div className="min-w-0 space-y-4">
            <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="break-words text-lg font-semibold">
                      {selected.name}
                    </h2>
                    <Badge
                      variant={
                        playbookStatusLabel(selected) === "Live"
                          ? "default"
                          : "secondary"
                      }
                    >
                      {playbookStatusLabel(selected)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {activeAgent?.displayName || "Support agent"}
                    {selected.activeVersion
                      ? ` · Published version ${selected.activeVersion}`
                      : " · Not published"}{" "}
                    · {graph.nodes.length} steps · {graph.fields?.length || 0}{" "}
                    questions
                  </p>
                  <p id="playbook-routing-simulator-note" className="mt-2 text-xs leading-5 text-muted-foreground">
                    Tests published routing, not this draft.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-describedby="playbook-routing-simulator-note"
                    onClick={() =>
                      navigate(
                        "/dashboard/settings/outreach/orchestration#simulator",
                      )
                    }
                  >
                    <Activity className="mr-2 h-4 w-4" />
                    Open routing simulator
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={save}
                    disabled={working}
                  >
                    <Save className="mr-2 h-4 w-4" />
                    Save draft
                  </Button>
                  <Button
                    size="sm"
                    onClick={publish}
                    disabled={
                      working || validating || !checksPassed || selected.status === "archived"
                    }
                  >
                    <Rocket className="mr-2 h-4 w-4" />
                    Publish changes
                  </Button>
                </div>
              </div>
              <div
                role="status"
                aria-live="polite"
                className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs"
              >
                <span
                  className={dirty ? "text-warning" : "text-muted-foreground"}
                >
                  {working
                    ? "Saving changes…"
                    : dirty
                      ? "Unsaved changes"
                      : "Draft saved"}{" "}
                  ·{" "}
                  {validating
                    ? "Checking flow…"
                    : checksPassed
                      ? "Checks passed"
                      : "Needs attention"}
                </span>
                <span className="text-muted-foreground">
                  Draft edits do not change live conversations until published.
                </span>
              </div>
              {flowErrors.length || validation?.warnings.length ? (
                <details
                  open={!!flowErrors.length}
                  className="rounded-lg border border-warning/30 bg-warning/5 p-3"
                >
                  <summary className="cursor-pointer text-sm font-medium">
                    {flowErrors.length
                      ? `${flowErrors.length} issue(s) to fix before publishing`
                      : "Review suggestions"}
                  </summary>
                  {flowErrors.map((error, i) => (
                    <p
                      key={i}
                      className="mt-2 break-words text-sm text-destructive"
                    >
                      {error}
                    </p>
                  ))}
                  {validation?.warnings.map((warning, i) => (
                    <p
                      key={i}
                      className="mt-2 break-words text-sm text-muted-foreground"
                    >
                      {warning}
                    </p>
                  ))}
                </details>
              ) : null}
            </div>
            <nav
              aria-label="Playbook sections"
              className="grid grid-cols-2 gap-1 rounded-lg border bg-card p-1 sm:grid-cols-3 lg:grid-cols-5"
            >
              {sections.map((tab) => (
                <Button
                  key={tab.id}
                  variant={section === tab.id ? "secondary" : "ghost"}
                  aria-pressed={section === tab.id}
                  className="min-w-0 justify-start gap-2"
                  onClick={() => chooseSection(tab.id)}
                >
                  <tab.icon className="h-4 w-4 shrink-0" />
                  {tab.label}
                </Button>
              ))}
            </nav>
            <Card className="min-w-0 shadow-none">
              <CardContent className="min-w-0 p-4 sm:p-5">
                {(section === "flow" ||
                  section === "graph" ||
                  section === "questions") && (
                  <>
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                      {(section === "flow" || section === "graph") && (
                        <div>
                          <h2 className="text-base font-semibold">
                            {section === "graph"
                              ? "Graph editor"
                              : "Conversation flow"}
                          </h2>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {section === "graph"
                              ? "Select a step or connection to edit it. Drag between step handles to connect the flow."
                              : "Choose a step to see what your agent asks, says, or does next. You can also open Graph to edit the full flow visually."}
                          </p>
                        </div>
                      )}
                    </div>
                    <PlaybookGraphEditor
                      key={`${selected.id}:${section}`}
                      graph={graph}
                      onChange={updateVisualGraph}
                      guided={section !== "graph"}
                      section={section === "questions" ? "questions" : "flow"}
                      readOnly={working}
                    />
                  </>
                )}
                {section === "channels" && (
                  <section className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold">
                        Where this playbook runs
                      </h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Choose the channels and customer requests that use this
                        playbook.
                      </p>
                      <p className="mt-2 text-xs text-warning">
                        Channel rules take effect immediately. They are not part
                        of the saved draft.
                      </p>
                    </div>
                    <div className="divide-y">
                      {selected.assignments?.map((assignment) => (
                        <div
                          key={assignment.id}
                          className="flex flex-wrap items-center gap-3 py-4"
                        >
                          <Switch
                            aria-label={`Enable ${assignment.channel || "all channels"} ${assignment.intent || "all requests"}`}
                            checked={assignment.enabled}
                            disabled={working}
                            onCheckedChange={(value) =>
                              void toggleAssignment(assignment.id, value)
                            }
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">
                              {assignment.channel === "web"
                                ? "Web chat"
                                : assignment.channel === "whatsapp"
                                  ? "WhatsApp"
                                  : assignment.channel
                                    ? assignment.channel[0].toUpperCase() +
                                      assignment.channel.slice(1)
                                    : "All agent channels"}
                            </p>
                            <p className="mt-1 break-words text-xs text-muted-foreground">
                              {assignment.intent
                                ? assignment.intent.replaceAll("_", " ")
                                : "All customer requests"}{" "}
                              · {assignment.trafficPercent}% of eligible traffic
                              · Priority {assignment.priority}
                            </p>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {assignment.enabled ? "Enabled" : "Paused"}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive"
                            disabled={working}
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Remove this channel rule? It will stop routing new matches immediately.",
                                )
                              )
                                void removeAssignment(assignment.id);
                            }}
                            aria-label="Remove assignment"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    {!selected.assignments?.length && (
                      <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                        No channel rules yet. Add a rule to choose where this
                        playbook is used.
                      </p>
                    )}
                    <details className="rounded-lg border p-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        Add channel rule
                      </summary>
                      <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <label className="space-y-2 text-sm">
                          Channel
                          <select
                            aria-label="Assignment channel"
                            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                            value={channel}
                            onChange={(e) => setChannel(e.target.value)}
                          >
                            {[
                              "email",
                              "whatsapp",
                              "instagram",
                              "facebook",
                              "web",
                            ].map((value) => (
                              <option key={value} value={value}>
                                {value === "web"
                                  ? "Web chat"
                                  : value === "whatsapp"
                                    ? "WhatsApp"
                                    : value[0].toUpperCase() + value.slice(1)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="space-y-2 text-sm">
                          <p>Customer request (optional)</p>
                          <SupportIntentSelect
                            value={intent}
                            onChange={setIntent}
                            disabled={working}
                          />
                        </div>
                        <label className="space-y-2 text-sm">
                          Priority
                          <Input
                            type="number"
                            value={assignmentPriority}
                            onChange={(e) =>
                              setAssignmentPriority(Number(e.target.value))
                            }
                          />
                          <span className="block text-xs text-muted-foreground">
                            Used when multiple playbooks match a request.
                          </span>
                        </label>
                      </div>
                      <Button
                        className="mt-4"
                        variant="outline"
                        onClick={addAssignment}
                        disabled={working}
                      >
                        Add channel rule
                      </Button>
                    </details>
                  </section>
                )}
                {section === "settings" && (
                  <div className="space-y-6">
                    <section className="space-y-4">
                      <div>
                        <h2 className="text-base font-semibold">
                          Playbook details
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          A clear name and description help your team find the
                          right playbook.
                        </p>
                      </div>
                      <label className="block space-y-2 text-sm font-medium">
                        Playbook name
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          disabled={working}
                        />
                      </label>
                      <label className="block space-y-2 text-sm font-medium">
                        What this journey handles
                        <Textarea
                          rows={2}
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          disabled={working}
                        />
                      </label>
                    </section>
                    <section className="space-y-4 border-t pt-5">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <h3 className="text-sm font-medium">
                            Accept new conversations
                          </h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Pause without deleting this playbook. Changes apply
                            immediately.
                          </p>
                        </div>
                        <Switch
                          aria-label="Accept new conversations"
                          checked={selected.enabled !== false}
                          disabled={working}
                          onCheckedChange={(v) => void togglePlaybook(v)}
                        />
                      </div>
                      {selected.templateKey && (
                        <div className="rounded-lg bg-muted/40 p-4">
                          <p className="text-sm font-medium">
                            {selected.templateMode === "managed"
                              ? "Managed template"
                              : "Customized for this account"}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            Template version {selected.templateVersion || 1}
                            {selected.templateCurrentVersion &&
                            selected.templateCurrentVersion !==
                              selected.templateVersion
                              ? ` · Latest version ${selected.templateCurrentVersion}`
                              : ""}
                            . Managed playbooks receive safe platform updates.
                            Saving your edits makes this account’s playbook a
                            custom version.
                          </p>
                          {selected.templateMode !== "managed" && (
                            <Button
                              className="mt-3"
                              size="sm"
                              variant="outline"
                              onClick={resetToAdmin}
                              disabled={working}
                            >
                              <RefreshCw className="mr-2 h-4 w-4" />
                              Restore template
                            </Button>
                          )}
                        </div>
                      )}
                    </section>
                    <details className="border-t pt-4">
                      <summary className="cursor-pointer py-2 text-sm font-medium">
                        <ShieldCheck className="mr-2 inline h-4 w-4" />
                        Safety & privacy protections
                      </summary>
                      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                        {[
                          ["Privacy", selectedControls.privacy],
                          [
                            "Personal information protection",
                            selectedControls.piiRedaction,
                          ],
                          ["Safety checks", selectedControls.safety],
                          ["Human handoff", selectedControls.humanHandoff],
                          ["Action approval", selectedControls.toolApproval],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            className="flex justify-between gap-3 rounded-md bg-muted/30 p-3"
                          >
                            <dt>{label}</dt>
                            <dd className="text-muted-foreground">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                    <details className="border-t pt-4">
                      <summary className="cursor-pointer py-2 text-sm font-medium">
                        <Code2 className="mr-2 inline h-4 w-4" />
                        Developer tools
                      </summary>
                      <p className="my-3 text-sm text-muted-foreground">
                        Edit the complete graph, including advanced settings.
                        Changes still pass the same validation before
                        publishing.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          switchMode(editorMode === "json" ? "visual" : "json")
                        }
                      >
                        {editorMode === "json"
                          ? "Apply JSON to editor"
                          : "Developer JSON"}
                        <ChevronDown className="ml-2 h-4 w-4" />
                      </Button>
                      {editorMode === "json" && (
                        <Textarea
                          aria-label="Playbook developer JSON"
                          className="mt-3 min-h-[480px] font-mono text-xs"
                          value={graphJson}
                          onChange={(e) => setGraphJson(e.target.value)}
                          disabled={working}
                          spellCheck={false}
                        />
                      )}
                    </details>
                    <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-5">
                      <div>
                        <h3 className="text-sm font-medium">
                          Archive this playbook
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Stop new conversations and keep its history.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        className="text-destructive"
                        onClick={archive}
                        disabled={working}
                      >
                        <Archive className="mr-2 h-4 w-4" />
                        Archive
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card className="border-dashed shadow-none">
            <CardContent className="py-20 text-center">
              <Workflow className="mx-auto mb-4 h-8 w-8 text-muted-foreground" />
              <h2 className="text-base font-medium">
                Your next conversation starts here
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a playbook or choose a template to get started.
              </p>
              <Button
                variant="outline"
                className="mt-5"
                onClick={create}
                disabled={working}
              >
                New playbook
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
