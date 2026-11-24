"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  Connection,
  Controls,
  Edge,
  EdgeChange,
  EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  Node,
  NodeChange,
  NodeProps,
  NodeTypes,
  Position,
  ReactFlow,
  ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import { SupportIntentSelect } from "./SupportIntentSelect";
import { SupportDocumentStepEditor } from "./SupportDocumentStepEditor";
import { PlaybookQuestionsEditor, fieldTitle } from "./PlaybookQuestionsEditor";
import { orderedPlaybookNodes } from "@/lib/support-playbook-ui";
import { arrangePlaybookMap, needsMapLayout, mapNodeTitle, mapNodeSummary, mapEdgeLabel, MAP_NODE_WIDTH, MAP_NODE_HEIGHT } from "@/lib/playbook-map";
import {
  CheckCircle2,
  ChevronRight,
  List,
  CircleStop,
  GitBranch,
  HelpCircle,
  ImageIcon,
  ListChecks,
  MessageSquare,
  BookOpen,
  Play,
  Plus,
  Save,
  Trash2,
  UserRoundX,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { SUPPORT_CAPABILITY_NAMES } from "../../../../shared/supportCapabilities";

export type PlaybookNodeType =
  | "trigger"
  | "message"
  | "question"
  | "condition"
  | "action"
  | "escalation"
  | "collect"
  | "knowledge"
  | "media"
  | "capability"
  | "handoff"
  | "complete";

export type PlaybookEdgeOperator =
  | "always"
  | "contains"
  | "not_contains"
  | "equals"
  | "matches_intent"
  | "field_present"
  | "field_missing"
  | "field_equals"
  | "field_in"
  | "all_required_fields_present"
  | "confirmation_is"
  | "capability_status_is"
  | "grounding_is"
  | "delivery_is";

export type PlaybookFieldType =
  | "text"
  | "integer"
  | "money"
  | "date"
  | "datetime"
  | "email"
  | "phone"
  | "boolean"
  | "single_select"
  | "multi_select";

export interface PlaybookFieldDefinition {
  key: string;
  type: PlaybookFieldType;
  required: boolean;
  pii: "none" | "contact" | "sensitive";
  prompt: string;
  validation?: Record<string, unknown>;
  options?: Array<{
    value: string;
    label: string;
    shortLabel?: string;
    aliases?: string[];
  }>;
  profileBinding?: {
    attribute:
      | "fullName"
      | "firstName"
      | "lastName"
      | "email"
      | "phone"
      | "company";
    read: boolean;
    writeBack: "fill_missing_or_verify_correction" | "never";
    minimumTrust: "provider" | "customer_verified" | "owner_verified";
  };
}

export interface PlaybookPresentationPolicy {
  mode: "fixed" | "governed_hybrid";
  tone?: string;
  guidance?: string;
  optionStrategy: "all" | "relevant_subset";
  allowReordering: boolean;
  avoidRecentPhrasings: boolean;
  deterministicFallback: string;
}

export interface PlaybookGraphNode {
  id: string;
  type: PlaybookNodeType;
  data: Record<string, unknown>;
  position?: { x: number; y: number };
  presentation?: PlaybookPresentationPolicy;
}

export interface PlaybookGraphEdge {
  id?: string;
  source: string;
  target: string;
  condition?: {
    operator: PlaybookEdgeOperator;
    value?: string;
    field?: string;
    values?: string[];
    capability?: string;
  };
  priority?: number;
}

export interface PlaybookControlProfile {
  privacy: string;
  piiRedaction: string;
  safety: string;
  humanHandoff: string;
  toolApproval: string;
}

export interface PlaybookGraph {
  schemaVersion?: 1 | 2;
  entryNodeId: string;
  fields?: PlaybookFieldDefinition[];
  nodes: PlaybookGraphNode[];
  edges: PlaybookGraphEdge[];
  variants?: Array<{ id: string; weight: number; entryNodeId?: string }>;
  metadata?: {
    templateKey?: string;
    templateVersion?: number;
    systemDefault?: boolean;
    agentType?: string;
    controls?: PlaybookControlProfile;
    presentationDefaults?: PlaybookPresentationPolicy;
  };
}

const NODE_TYPES: PlaybookNodeType[] = [
  "trigger",
  "message",
  "question",
  "condition",
  "action",
  "escalation",
  "collect",
  "knowledge",
  "media",
  "capability",
  "handoff",
  "complete",
];

const EDGE_OPERATORS: PlaybookEdgeOperator[] = [
  "always",
  "contains",
  "not_contains",
  "equals",
  "matches_intent",
  "field_present",
  "field_missing",
  "field_equals",
  "field_in",
  "all_required_fields_present",
  "confirmation_is",
  "capability_status_is",
  "grounding_is",
  "delivery_is",
];

const CAPABILITIES: readonly string[] = SUPPORT_CAPABILITY_NAMES;

const NODE_META = {
  trigger: {
    label: "Start",
    description: "Starts the playbook",
    icon: Zap,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#f59e0b",
  },
  message: {
    label: "Message",
    description: "Guides the AI response",
    icon: MessageSquare,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#3b82f6",
  },
  question: {
    label: "Question",
    description: "Collects required information",
    icon: HelpCircle,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#8b5cf6",
  },
  condition: {
    label: "Branch",
    description: "Branches using edge rules",
    icon: GitBranch,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#06b6d4",
  },
  action: {
    label: "Action",
    description: "Calls an approved tool",
    icon: Play,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#10b981",
  },
  escalation: {
    label: "Escalation",
    description: "Hands off to a person",
    icon: UserRoundX,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#f43f5e",
  },
  collect: {
    label: "Collect answers",
    description: "Collects only missing typed information",
    icon: ListChecks,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#7c3aed",
  },
  knowledge: {
    label: "Knowledge",
    description: "Uses published tenant evidence",
    icon: BookOpen,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#4f46e5",
  },
  media: {
    label: "Media",
    description: "Selects approved photos, documents, or other media",
    icon: ImageIcon,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#c026d3",
  },
  capability: {
    label: "Business action",
    description:
      "Checks availability, answers a question, or carries out an approved business action",
    icon: Play,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#059669",
  },
  handoff: {
    label: "Handoff",
    description: "Passes the conversation to the configured support team",
    icon: UserRoundX,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#e11d48",
  },
  complete: {
    label: "Complete",
    description: "Finishes the playbook",
    icon: CircleStop,
    className: "border-primary/40 bg-card text-card-foreground",
    miniMap: "#64748b",
  },
} satisfies Record<
  PlaybookNodeType,
  {
    label: string;
    description: string;
    icon: typeof Zap;
    className: string;
    miniMap: string;
  }
>;

interface FlowNodeData {
  graphNode: PlaybookGraphNode;
  summary: string;
  entry: boolean;
}

function displayLabel(node: PlaybookGraphNode) {
  return mapNodeTitle(node);
}

function instructionFor(node: PlaybookGraphNode) {
  return String(node.data.message || node.data.instruction || "");
}

function FlowNode({ data, selected }: NodeProps<FlowNodeData>) {
  const node = data.graphNode;
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  const preview = data.summary;

  return (
    <div
      style={{ width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT, borderLeftColor: meta.miniMap }}
      title={`${displayLabel(node)} — ${preview}`}
      className={`overflow-hidden rounded-xl border border-l-4 px-4 py-3 shadow-sm ${meta.className} ${
        selected ? "ring-2 ring-primary ring-offset-2" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-current"
      />
      <div className="flex items-start gap-2">
        <div className="mt-0.5 rounded-md bg-background/70 p-1.5">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="line-clamp-2 break-words text-sm font-semibold leading-5">
              {displayLabel(node)}
            </span>
            {node.data.verbatim === true && (
              <span className="rounded bg-current/10 px-1 py-0.5 text-[8px] font-bold tracking-wide">
                MUST SAY
              </span>
            )}
          </div>
          <p className="text-[11px] uppercase tracking-wide opacity-60">
            {data.entry ? "Starts here · " : ""}{meta.label}
          </p>
        </div>
      </div>
      {preview && (
        <p className="mt-2 line-clamp-3 border-t border-current/10 pt-2 text-xs leading-5 text-muted-foreground">
          {preview}
        </p>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-current"
      />
    </div>
  );
}

const FLOW_NODE_TYPES: NodeTypes = { playbookNode: FlowNode };
function FlowEdge(props: EdgeProps) {
  const [path, x, y] = getSmoothStepPath(props);
  return <BaseEdge {...props} path={path} labelX={x} labelY={y + (props.data?.labelOffset || 0)} />;
}
const FLOW_EDGE_TYPES = { playbookEdge: FlowEdge };
const FLOW_NODE_WIDTH = MAP_NODE_WIDTH;
const FLOW_NODE_HEIGHT = MAP_NODE_HEIGHT;

export function normalizePlaybookGraph(input: PlaybookGraph): PlaybookGraph {
  const nodes = (input.nodes || []).map((node) => ({
    ...node,
    data: node.data || {},
  }));

  const normalized = {
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
  return needsMapLayout(normalized) ? arrangePlaybookMap(normalized) : normalized;
}

function editorConditionsOverlap(
  left: PlaybookGraphEdge,
  right: PlaybookGraphEdge,
): boolean {
  const a = left.condition || { operator: "always" as const };
  const b = right.condition || { operator: "always" as const };
  if (a.operator === "always" || b.operator === "always") return false;
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  if (a.field && b.field && a.field === b.field) {
    const values = (
      condition: NonNullable<PlaybookGraphEdge["condition"]>,
    ): string[] => {
      if (condition.operator === "field_equals")
        return [String(condition.value || "").toLocaleLowerCase()];
      if (condition.operator === "field_in")
        return (condition.values || []).map((value) =>
          value.toLocaleLowerCase(),
        );
      return [];
    };
    const aValues = values(a);
    const bValues = values(b);
    if (
      aValues.length &&
      bValues.length &&
      aValues.some((value) => bValues.includes(value))
    )
      return true;
    if (
      a.operator === "field_present" &&
      ["field_equals", "field_in", "field_present"].includes(b.operator)
    )
      return true;
    if (
      b.operator === "field_present" &&
      ["field_equals", "field_in", "field_present"].includes(a.operator)
    )
      return true;
  }
  if (a.operator === "contains" && b.operator === "contains") {
    const aValue = String(a.value || "").toLocaleLowerCase();
    const bValue = String(b.value || "").toLocaleLowerCase();
    return Boolean(
      aValue && bValue && (aValue.includes(bValue) || bValue.includes(aValue)),
    );
  }
  return false;
}

export function getPlaybookGraphIssues(graph: PlaybookGraph): string[] {
  const issues: string[] = [];
  const nodeIds = new Set<string>();

  if (!graph.nodes.length) return ["Add at least one node."];
  for (const node of graph.nodes) {
    if (!node.id || nodeIds.has(node.id))
      issues.push(
        `Step ID “${node.id || "(empty)"}” is missing or duplicated.`,
      );
    nodeIds.add(node.id);
  }
  if (!nodeIds.has(graph.entryNodeId))
    issues.push("Choose a valid entry node.");
  if (
    !graph.nodes.some(
      (node) =>
        node.type === "complete" ||
        node.type === "escalation" ||
        node.type === "handoff",
    )
  ) {
    issues.push("Add a complete or escalation node.");
  }
  const fieldKeys = new Set<string>();
  if (graph.schemaVersion === 2) {
    for (const field of graph.fields || []) {
      if (!field.key.trim() || fieldKeys.has(field.key))
        issues.push(
          `Field key “${field.key || "(empty)"}” is missing or duplicated.`,
        );
      fieldKeys.add(field.key);
      if (!field.prompt.trim())
        issues.push(
          `Field ${field.key || "(unnamed)"} requires a customer prompt.`,
        );
      if (field.pii === "sensitive" && field.required)
        issues.push(`Sensitive field ${field.key} cannot be required.`);
      if (
        (field.type === "single_select" || field.type === "multi_select") &&
        !field.options?.length
      ) {
        issues.push(`Field ${field.key} requires at least one option.`);
      }
    }
  }
  for (const node of graph.nodes) {
    if (
      (node.type === "message" || node.type === "question") &&
      !instructionFor(node).trim()
    ) {
      issues.push(`${displayLabel(node)} requires an instruction.`);
    }
    if (node.type === "action" && !String(node.data.actionName || "").trim()) {
      issues.push(`${displayLabel(node)} requires an approved action name.`);
    }
    if (node.type === "collect") {
      const keys = Array.isArray(node.data.fieldKeys)
        ? node.data.fieldKeys
        : [];
      if (graph.schemaVersion !== 2)
        issues.push(`${displayLabel(node)} requires Playbook Graph v2.`);
      if (!keys.length)
        issues.push(`${displayLabel(node)} requires at least one field.`);
      if (keys.some((key) => typeof key !== "string" || !fieldKeys.has(key)))
        issues.push(`${displayLabel(node)} references an unknown field.`);
    }
    if (
      node.type === "capability" &&
      !CAPABILITIES.includes(String(node.data.capabilityName || ""))
    ) {
      issues.push(`${displayLabel(node)} requires a registered capability.`);
    }
  }
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push(
        `The ${edge.source} → ${edge.target} connection references a missing node.`,
      );
    }
  }
  for (const node of graph.nodes.filter(
    (item) => item.type === "trigger" || item.type === "condition",
  )) {
    if (!graph.edges.some((edge) => edge.source === node.id)) {
      issues.push(`${displayLabel(node)} requires an outgoing connection.`);
    }
  }
  for (const node of graph.nodes) {
    const outgoing = graph.edges.filter((edge) => edge.source === node.id);
    if (outgoing.length <= 1) continue;
    if (outgoing.some((edge) => !Number.isInteger(edge.priority))) {
      issues.push(
        `${displayLabel(node)} requires an explicit priority on every outgoing connection.`,
      );
    }
    const priorities = outgoing
      .map((edge) => edge.priority)
      .filter((value): value is number => Number.isInteger(value));
    if (new Set(priorities).size !== priorities.length)
      issues.push(`${displayLabel(node)} has duplicate branch priorities.`);
    const fallback = outgoing.find(
      (edge) => (edge.condition?.operator || "always") === "always",
    );
    if (
      fallback &&
      priorities.length === outgoing.length &&
      fallback.priority !== Math.max(...priorities)
    ) {
      issues.push(
        `${displayLabel(node)} requires its unconditional fallback to have the largest priority number.`,
      );
    }
    for (let leftIndex = 0; leftIndex < outgoing.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < outgoing.length;
        rightIndex += 1
      ) {
        if (
          editorConditionsOverlap(outgoing[leftIndex], outgoing[rightIndex])
        ) {
          issues.push(
            `${displayLabel(node)} has overlapping branch conditions.`,
          );
        }
      }
    }
  }

  if (nodeIds.has(graph.entryNodeId)) {
    const reachable = new Set<string>();
    const pending = [graph.entryNodeId];
    while (pending.length) {
      const current = pending.pop();
      if (!current || reachable.has(current)) continue;
      reachable.add(current);
      for (const edge of graph.edges) {
        if (edge.source === current && nodeIds.has(edge.target))
          pending.push(edge.target);
      }
    }
    for (const node of graph.nodes) {
      if (!reachable.has(node.id))
        issues.push(
          `${displayLabel(node)} is not reachable from the entry step.`,
        );
    }

    const deterministicIds = new Set(
      graph.nodes
        .filter((node) => node.type === "trigger" || node.type === "condition")
        .map((node) => node.id),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const containsDeterministicCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const edge of graph.edges) {
        if (
          edge.source === id &&
          deterministicIds.has(edge.target) &&
          containsDeterministicCycle(edge.target)
        ) {
          return true;
        }
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if ([...deterministicIds].some(containsDeterministicCycle)) {
      issues.push(
        "Trigger and condition steps contain a loop that would never wait for a customer response.",
      );
    }
  }

  const variantIds = new Set<string>();
  for (const variant of graph.variants || []) {
    if (!variant.id || variantIds.has(variant.id))
      issues.push(
        `Variant ID “${variant.id || "(empty)"}” is missing or duplicated.`,
      );
    variantIds.add(variant.id);
    if (variant.entryNodeId && !nodeIds.has(variant.entryNodeId)) {
      issues.push(
        `Variant ${variant.id || "(unnamed)"} references a missing entry step.`,
      );
    }
    if (
      !Number.isInteger(variant.weight) ||
      variant.weight < 0 ||
      variant.weight > 100
    ) {
      issues.push(
        `Variant ${variant.id || "(unnamed)"} must use a whole-number weight from 0 to 100.`,
      );
    }
  }
  const variantWeight = (graph.variants || []).reduce(
    (sum, variant) => sum + Number(variant.weight || 0),
    0,
  );
  if (graph.variants?.length && variantWeight !== 100)
    issues.push("Variant traffic weights must total 100%.");

  return [...new Set(issues)];
}

function makeNodeId(graph: PlaybookGraph, type: PlaybookNodeType) {
  let sequence = graph.nodes.length + 1;
  let id = `${type}-${sequence}`;
  while (graph.nodes.some((node) => node.id === id))
    id = `${type}-${++sequence}`;
  return id;
}

function defaultNodeData(type: PlaybookNodeType): Record<string, unknown> {
  if (type === "message")
    return {
      label: "Approved response",
      instruction: "Provide the approved, verified response.",
      requiredPhrases: [],
    };
  if (type === "question")
    return {
      label: "Qualifying question",
      instruction: "Ask the required qualifying question.",
      requiredPhrases: [],
    };
  if (type === "action")
    return {
      label: "Approved action",
      actionName: "answer_from_knowledge_base",
      args: {},
    };
  if (type === "escalation")
    return {
      label: "Human handoff",
      instruction: "Explain that a support specialist will take over.",
    };
  if (type === "collect")
    return { label: "Collect information", fieldKeys: [] };
  if (type === "knowledge")
    return {
      label: "Grounded answer",
      instruction: "Answer only from published tenant knowledge.",
    };
  if (type === "media")
    return {
      label: "Approved media",
      instruction: "Select only relevant published tenant media.",
    };
  if (type === "capability")
    return {
      label: "Governed capability",
      capabilityName: "knowledge.answer",
      args: {},
    };
  if (type === "handoff")
    return {
      label: "Human handoff",
      instruction: "Explain that the configured human team will take over.",
    };
  return { label: NODE_META[type].label };
}

export function PlaybookGraphEditor({
  graph,
  onChange,
  readOnly = false,
  section = "all",
  guided = false,
}: {
  graph: PlaybookGraph;
  onChange: (graph: PlaybookGraph) => void;
  readOnly?: boolean;
  section?: "all" | "questions" | "flow";
  guided?: boolean;
}) {
  const { toast } = useToast();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    guided
      ? graph.nodes.find((node) => node.type === "collect")?.id ||
          graph.entryNodeId ||
          null
      : null,
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [actionArgsText, setActionArgsText] = useState("{}");
  const [flowView, setFlowView] = useState<"list" | "map">(
    guided ? "list" : "map",
  );
  const [stepQuery, setStepQuery] = useState("");
  const [newStepType, setNewStepType] = useState<PlaybookNodeType>("message");
  const [connectionTarget, setConnectionTarget] = useState("");
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [repairLayout, setRepairLayout] = useState(() => needsMapLayout(graph));
  const mapGraph = useMemo(() => repairLayout ? arrangePlaybookMap(graph) : graph, [graph, repairLayout]);
  const focusStep = (id: string) => {
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    void flowInstance?.fitView({ nodes: [{ id }], padding: 0.8, minZoom: 0.85, maxZoom: 1 });
  };

  const flowNodes = useMemo<Node<FlowNodeData>[]>(
    () =>
      mapGraph.nodes.map((node) => ({
        id: node.id,
        type: "playbookNode",
        position: node.position || { x: 0, y: 0 },
        data: { graphNode: node, summary: mapNodeSummary(node, graph), entry: node.id === graph.entryNodeId },
        selected: selectedNodeId === node.id,
        // React Flow 11 can leave controlled nodes permanently hidden when its
        // ResizeObserver measurement does not complete (notably with React 19).
        // Supplying the editor's known node footprint makes initialization and
        // fitView deterministic while the observer can still refine it later.
        width: FLOW_NODE_WIDTH,
        height: FLOW_NODE_HEIGHT,
      })),
    [mapGraph, graph, selectedNodeId],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge, index) => {
        const siblings = graph.edges.filter(item => item.source === edge.source && item.target === edge.target);
        const active = selectedNodeId === edge.source || selectedNodeId === edge.target || selectedEdgeId === (edge.id || `${edge.source}-${edge.target}-${index}`);
        return ({
        id: edge.id || `${edge.source}-${edge.target}-${index}`,
        source: edge.source,
        target: edge.target,
        type: "playbookEdge",
        animated: false,
        style: { stroke: active ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))", strokeWidth: active ? 2.5 : 1.25, opacity: selectedNodeId && !active ? 0.25 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed },
        label: selectedNodeId && !active ? undefined : mapEdgeLabel(edge, graph),
        labelStyle: { fontSize: 11, fontWeight: 500, fill: "hsl(var(--foreground))" },
        labelBgStyle: { fill: "hsl(var(--background))", fillOpacity: 0.96 },
        labelBgPadding: [8, 5] as [number, number],
        data: { graphEdge: edge, labelOffset: (siblings.indexOf(edge) - (siblings.length - 1) / 2) * 28 },
      }); }),
    [graph, selectedNodeId, selectedEdgeId],
  );

  const selectedNode =
    graph.nodes.find((node) => node.id === selectedNodeId) || null;
  const selectedEdge =
    graph.edges.find(
      (edge, index) =>
        (edge.id || `${edge.source}-${edge.target}-${index}`) ===
        selectedEdgeId,
    ) || null;

  useEffect(() => {
    setActionArgsText(JSON.stringify(selectedNode?.data.args || {}, null, 2));
  }, [selectedNodeId, selectedNode?.data.args]);

  useEffect(() => {
    if (
      selectedNodeId &&
      !graph.nodes.some((node) => node.id === selectedNodeId)
    )
      setSelectedNodeId(null);
    if (selectedEdgeId && !flowEdges.some((edge) => edge.id === selectedEdgeId))
      setSelectedEdgeId(null);
  }, [flowEdges, graph.nodes, selectedEdgeId, selectedNodeId]);

  const applyGraph = useCallback(
    (next: PlaybookGraph) => {
      if (!readOnly) onChange(next);
    },
    [onChange, readOnly],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (readOnly) return;
      // Selection/measurement are view state, not edits to the saved playbook.
      const edits = changes.filter(change => change.type === "position" || change.type === "remove");
      if (!edits.length) return;
      setRepairLayout(false);
      const nextFlow = applyNodeChanges(edits, flowNodes);
      const remainingIds = new Set(nextFlow.map((node) => node.id));
      const nextNodes: PlaybookGraphNode[] = nextFlow.flatMap((flowNode) => {
        const current = graph.nodes.find((node) => node.id === flowNode.id);
        return current ? [{ ...current, position: flowNode.position }] : [];
      });
      applyGraph({
        ...graph,
        nodes: nextNodes,
        edges: graph.edges.filter(
          (edge) =>
            remainingIds.has(edge.source) && remainingIds.has(edge.target),
        ),
        entryNodeId: remainingIds.has(graph.entryNodeId)
          ? graph.entryNodeId
          : nextNodes[0]?.id || "",
      });
    },
    [applyGraph, flowNodes, graph, readOnly],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readOnly) return;
      const edits = changes.filter(change => change.type === "remove");
      if (!edits.length) return;
      const nextFlow = applyEdgeChanges(edits, flowEdges);
      applyGraph({
        ...graph,
        edges: nextFlow.map((edge) => ({
          ...((edge.data?.graphEdge as PlaybookGraphEdge | undefined) || {}),
          id: edge.id,
          source: edge.source,
          target: edge.target,
        })),
      });
    },
    [applyGraph, flowEdges, graph, readOnly],
  );

  const connect = useCallback(
    (connection: Connection) => {
      if (readOnly || !connection.source || !connection.target) return;
      const id = `${connection.source}-${connection.target}-${Date.now()}`;
      applyGraph({
        ...graph,
        edges: [
          ...graph.edges,
          {
            id,
            source: connection.source,
            target: connection.target,
            condition: { operator: "always" },
          },
        ],
      });
      setSelectedNodeId(null);
      setSelectedEdgeId(id);
    },
    [applyGraph, graph, readOnly],
  );

  const addNode = (type: PlaybookNodeType) => {
    const id = makeNodeId(graph, type);
    const nextNode: PlaybookGraphNode = {
      id,
      type,
      data: defaultNodeData(type),
      position: {
        x: 80 + (graph.nodes.length % 4) * 250,
        y: 90 + Math.floor(graph.nodes.length / 4) * 180,
      },
    };
    applyGraph({
      ...graph,
      entryNodeId: graph.entryNodeId || id,
      nodes: [...graph.nodes, nextNode],
    });
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  };

  const updateNode = (patch: Partial<PlaybookGraphNode>) => {
    if (!selectedNode) return;
    applyGraph({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === selectedNode.id ? { ...node, ...patch } : node,
      ),
    });
  };

  const updateNodeData = (patch: Record<string, unknown>) => {
    if (!selectedNode) return;
    updateNode({ data: { ...selectedNode.data, ...patch } });
  };

  const updateInstruction = (instruction: string) => {
    if (!selectedNode) return;
    const key = Object.prototype.hasOwnProperty.call(
      selectedNode.data,
      "message",
    )
      ? "message"
      : "instruction";
    updateNodeData({ [key]: instruction });
  };

  const updateEdgeCondition = (
    patch: Partial<NonNullable<PlaybookGraphEdge["condition"]>>,
  ) => {
    if (!selectedEdge) return;
    applyGraph({
      ...graph,
      edges: graph.edges.map((edge, index) => {
        const edgeId = edge.id || `${edge.source}-${edge.target}-${index}`;
        return edgeId === selectedEdgeId
          ? {
              ...edge,
              id: edgeId,
              condition: {
                operator: edge.condition?.operator || "always",
                ...edge.condition,
                ...patch,
              },
            }
          : edge;
      }),
    });
  };

  const saveActionArgs = () => {
    if (!selectedNode) return;
    try {
      const args = JSON.parse(actionArgsText) as unknown;
      if (!args || Array.isArray(args) || typeof args !== "object")
        throw new Error();
      updateNodeData({ args });
      toast({ title: "Action arguments updated" });
    } catch {
      toast({
        title: "Action arguments must be a JSON object",
        variant: "destructive",
      });
    }
  };

  const deleteSelectedNode = () => {
    if (!selectedNode) return;
    const nodes = graph.nodes.filter((node) => node.id !== selectedNode.id);
    applyGraph({
      ...graph,
      nodes,
      edges: graph.edges.filter(
        (edge) =>
          edge.source !== selectedNode.id && edge.target !== selectedNode.id,
      ),
      entryNodeId:
        graph.entryNodeId === selectedNode.id
          ? nodes[0]?.id || ""
          : graph.entryNodeId,
    });
    setSelectedNodeId(null);
  };

  const deleteSelectedEdge = () => {
    if (!selectedEdgeId) return;
    applyGraph({
      ...graph,
      edges: graph.edges.filter(
        (edge, index) =>
          (edge.id || `${edge.source}-${edge.target}-${index}`) !==
          selectedEdgeId,
      ),
    });
    setSelectedEdgeId(null);
  };

  const issues = getPlaybookGraphIssues(graph);
  const phraseText =
    selectedNode && Array.isArray(selectedNode.data.requiredPhrases)
      ? selectedNode.data.requiredPhrases
          .filter((value): value is string => typeof value === "string")
          .join("\n")
      : "";
  const previewField =
    selectedNode?.type === "collect"
      ? (graph.fields || []).find(
          (field) =>
            Array.isArray(selectedNode.data.fieldKeys) &&
            selectedNode.data.fieldKeys.includes(field.key),
        )
      : undefined;
  const presentationForSelectedNode: PlaybookPresentationPolicy = {
    mode:
      selectedNode?.presentation?.mode ||
      graph.metadata?.presentationDefaults?.mode ||
      "fixed",
    tone:
      selectedNode?.presentation?.tone ||
      graph.metadata?.presentationDefaults?.tone ||
      "Natural and concise",
    guidance:
      selectedNode?.presentation?.guidance ||
      graph.metadata?.presentationDefaults?.guidance ||
      "Preserve the configured meaning.",
    optionStrategy:
      selectedNode?.presentation?.optionStrategy ||
      graph.metadata?.presentationDefaults?.optionStrategy ||
      "all",
    allowReordering:
      selectedNode?.presentation?.allowReordering ??
      graph.metadata?.presentationDefaults?.allowReordering ??
      false,
    avoidRecentPhrasings:
      selectedNode?.presentation?.avoidRecentPhrasings ??
      graph.metadata?.presentationDefaults?.avoidRecentPhrasings ??
      true,
    deterministicFallback:
      selectedNode?.presentation?.deterministicFallback ||
      graph.metadata?.presentationDefaults?.deterministicFallback ||
      (selectedNode ? instructionFor(selectedNode) : "") ||
      "Please provide the requested information.",
  };

  const orderedSteps = orderedPlaybookNodes(graph).filter(({ node }) =>
    `${displayLabel(node)} ${NODE_META[node.type].label} ${instructionFor(node)}`
      .toLowerCase()
      .includes(stepQuery.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      {section !== "flow" && (
        <PlaybookQuestionsEditor
          graph={graph}
          onChange={applyGraph}
          readOnly={readOnly}
        />
      )}
      {section !== "questions" && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="flex rounded-lg border p-1"
                aria-label="Flow view"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={flowView === "list" ? "secondary" : "ghost"}
                  aria-pressed={flowView === "list"}
                  onClick={() => setFlowView("list")}
                >
                  <List className="mr-2 h-4 w-4" />
                  Steps
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={flowView === "map" ? "secondary" : "ghost"}
                  aria-pressed={flowView === "map"}
                  onClick={() => setFlowView("map")}
                >
                  <Workflow className="mr-2 h-4 w-4" />
                  Flow map
                </Button>
              </div>
              <details className="relative">
                <summary className="cursor-pointer rounded-md border px-3 py-2 text-sm font-medium">
                  Add step
                </summary>
                <div className="absolute left-0 top-full z-20 mt-2 w-64 space-y-3 rounded-lg border bg-popover p-4 shadow-md">
                  <label className="block space-y-2 text-sm">
                    Step type
                    <select
                      aria-label="New step type"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={newStepType}
                      onChange={(e) =>
                        setNewStepType(e.target.value as PlaybookNodeType)
                      }
                    >
                      {NODE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {NODE_META[type].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {NODE_META[newStepType].description}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    disabled={readOnly}
                    onClick={() => {
                      addNode(newStepType);
                      setStepQuery("");
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add {NODE_META[newStepType].label.toLowerCase()}
                  </Button>
                </div>
              </details>
            </div>
            <Badge
              variant={issues.length ? "destructive" : "secondary"}
              className="gap-1.5"
            >
              {issues.length ? (
                <>
                  <Workflow className="h-3 w-3" />
                  {issues.length} flow{" "}
                  {issues.length === 1 ? "issue" : "issues"}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3 w-3" />
                  Local checks passed
                </>
              )}
            </Badge>
          </div>

          <div
            className={`grid min-w-0 overflow-hidden rounded-xl border bg-background ${flowView === "list" ? "xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.5fr)]" : (selectedNode || selectedEdge) ? "2xl:grid-cols-[minmax(0,1fr)_320px]" : ""}`}
          >
            {flowView === "list" ? (
              <div className="min-w-0">
                <SearchInput
                  aria-label="Search steps"
                  placeholder="Find a step…"
                  value={stepQuery}
                  onValueChange={setStepQuery}
                  wrapperClassName="m-3 w-auto"
                />
                <nav
                  aria-label="Conversation steps"
                  className="max-h-64 space-y-1 overflow-y-auto p-2 pt-0 xl:max-h-[620px]"
                >
                  {orderedSteps.map(({ node, reachable }) => {
                    const Icon = NODE_META[node.type].icon;
                    return (
                      <button
                        type="button"
                        key={node.id}
                        aria-current={
                          selectedNodeId === node.id ? "step" : undefined
                        }
                        onClick={() => {
                          setSelectedNodeId(node.id);
                          setSelectedEdgeId(null);
                        }}
                        className={`flex w-full items-start gap-3 rounded-lg border-l-2 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedNodeId === node.id ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted"}`}
                      >
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-sm font-medium">
                            {displayLabel(node)}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {NODE_META[node.type].label}
                            {node.id === graph.entryNodeId
                              ? " · Starts here"
                              : ""}
                            {!reachable ? " · Not connected" : ""}
                          </span>
                        </span>
                        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    );
                  })}
                  {!orderedSteps.length && (
                    <p className="p-4 text-sm text-muted-foreground">
                      {graph.nodes.length
                        ? "No steps match your search."
                        : "Add a step to start this conversation."}
                    </p>
                  )}
                </nav>
              </div>
            ) : (
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 p-3">
                  <label className="flex w-full min-w-0 items-center gap-2 text-xs font-medium sm:w-auto sm:flex-1">
                    Jump to step
                    <select aria-label="Jump to step" value={selectedNodeId || ""} onChange={event => focusStep(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm">
                      <option value="" disabled>Choose a step…</option>
                      {orderedPlaybookNodes(graph).map(({ node, reachable }) => <option key={node.id} value={node.id}>{displayLabel(node)}{reachable ? "" : " (not connected)"}</option>)}
                    </select>
                  </label>
                  <Button size="sm" variant="outline" onClick={() => focusStep(graph.entryNodeId)} disabled={!graph.nodes.length}>Start here</Button>
                  <Button size="sm" variant="outline" onClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); void flowInstance?.fitView({ padding: 0.12, minZoom: 0.05, maxZoom: 1 }); }}>Show whole flow</Button>
                  {!readOnly && <Button size="sm" variant="outline" onClick={() => applyGraph(arrangePlaybookMap(graph))}>Auto arrange</Button>}
                  <p className="w-full text-xs text-muted-foreground">Follow arrows from left to right. Select a step to highlight its connections. Scroll to zoom; drag the background to explore.</p>
                </div>
              <div className="relative h-[480px] min-w-0 bg-muted/10 sm:h-[680px]">
                <ReactFlow
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={FLOW_NODE_TYPES}
                  edgeTypes={FLOW_EDGE_TYPES}
                  onInit={instance => {
                    setFlowInstance(instance);
                    requestAnimationFrame(() => { void instance.fitView({
                      nodes: graph.nodes.length > 8 ? [...new Set([graph.entryNodeId, ...graph.edges.filter(edge => edge.source === graph.entryNodeId).map(edge => edge.target)])].map(id => ({ id })) : undefined,
                      padding: 0.3, minZoom: 0.65, maxZoom: 1,
                    }); });
                  }}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={connect}
                  onNodeClick={(_event, node) => {
                    setSelectedNodeId(node.id);
                    setSelectedEdgeId(null);
                  }}
                  onEdgeClick={(_event, edge) => {
                    setSelectedEdgeId(edge.id);
                    setSelectedNodeId(null);
                  }}
                  onPaneClick={() => {
                    setSelectedNodeId(null);
                    setSelectedEdgeId(null);
                  }}
                  nodesDraggable={!readOnly}
                  nodesConnectable={!readOnly}
                  edgesUpdatable={false}
                  deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
                  minZoom={0.05}
                  maxZoom={1.8}
                >
                  <Background
                    variant={BackgroundVariant.Dots}
                    gap={18}
                    size={1}
                  />
                  <Controls showInteractive={!readOnly} />
                  <MiniMap
                    className="!hidden sm:!block"
                    pannable
                    zoomable
                    nodeColor={(node) =>
                      NODE_META[(node.data as FlowNodeData).graphNode.type]
                        ?.miniMap || "#94a3b8"
                    }
                  />
                </ReactFlow>
                {!graph.nodes.length && (
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                    <Workflow className="mb-3 h-10 w-10 text-muted-foreground/30" />
                    <p className="text-sm font-medium text-muted-foreground">
                      No flow steps yet
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Add a trigger to begin building this playbook.
                    </p>
                  </div>
                )}
              </div>
              </div>
            )}

            {(flowView === "list" || selectedNode || selectedEdge) && <aside
              aria-label="Step editor"
              className={`flex min-h-[320px] max-h-[700px] min-w-0 flex-col overflow-y-auto border-t bg-background ${flowView === "list" ? "xl:border-l xl:border-t-0" : "2xl:border-l 2xl:border-t-0"}`}
            >
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div>
                  <p className="text-sm font-semibold">
                    {selectedNode
                      ? "Step properties"
                      : selectedEdge
                        ? "Branch condition"
                        : "Flow inspector"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {selectedNode
                      ? selectedNode.id
                      : selectedEdge
                        ? `${selectedEdge.source} → ${selectedEdge.target}`
                        : "Select a step or connection"}
                  </p>
                </div>
                {(selectedNode || selectedEdge) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label="Close flow inspector"
                    onClick={() => {
                      setSelectedNodeId(null);
                      setSelectedEdgeId(null);
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              {selectedNode ? (
                <>
                  <div className="flex-1 space-y-4 overflow-y-auto p-4">
                    <Badge className={NODE_META[selectedNode.type].className}>
                      {NODE_META[selectedNode.type].label}
                    </Badge>
                    <p className="break-words text-sm leading-6 text-muted-foreground">{mapNodeSummary(selectedNode, graph)}</p>
                    <div className="space-y-1.5">
                      <Label htmlFor="playbook-step-label" className="text-xs">
                        Step label
                      </Label>
                      <Input
                        id="playbook-step-label"
                        value={displayLabel(selectedNode)}
                        onChange={(event) =>
                          updateNodeData({ label: event.target.value })
                        }
                        disabled={readOnly}
                      />
                    </div>
                    <details className="space-y-1.5">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        Change step type
                      </summary>
                      <Label className="text-xs">Step type</Label>
                      <select
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                        value={selectedNode.type}
                        onChange={(event) =>
                          updateNode({
                            type: event.target.value as PlaybookNodeType,
                          })
                        }
                        disabled={readOnly}
                      >
                        {NODE_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {NODE_META[type].label}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        {NODE_META[selectedNode.type].description}
                      </p>
                    </details>

                    {[
                      "message",
                      "question",
                      "escalation",
                      "knowledge",
                      "media",
                      "capability",
                      "handoff",
                      "complete",
                    ].includes(selectedNode.type) && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          {selectedNode.type === "escalation" ||
                          selectedNode.type === "handoff"
                            ? "Handoff message"
                            : "AI instruction"}
                        </Label>
                        <Textarea
                          rows={6}
                          value={instructionFor(selectedNode)}
                          onChange={(event) =>
                            updateInstruction(event.target.value)
                          }
                          placeholder="Describe exactly what the AI should say or do at this step."
                          disabled={readOnly}
                        />
                      </div>
                    )}

                    {selectedNode.type === "collect" && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">
                          Questions in this step
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Asked in this order when the answer is not already
                          known. Edit the wording in Questions.
                        </p>
                        <ol className="divide-y rounded-lg border px-3">
                          {(Array.isArray(selectedNode.data.fieldKeys)
                            ? selectedNode.data.fieldKeys
                            : []
                          ).map((key) => {
                            const field = graph.fields?.find(
                              (item) => item.key === key,
                            );
                            return (
                              <li key={String(key)} className="py-3">
                                <p className="text-xs font-medium">
                                  {fieldTitle(String(key))}
                                </p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {field?.prompt ||
                                    "Question not found. Choose an existing question below."}
                                </p>
                              </li>
                            );
                          })}
                        </ol>
                        <details>
                          <summary className="cursor-pointer py-2 text-xs font-medium">
                            Choose questions for this step
                          </summary>
                          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2">
                            {(graph.fields || []).map((field) => {
                              const selected =
                                Array.isArray(selectedNode.data.fieldKeys) &&
                                selectedNode.data.fieldKeys.includes(field.key);
                              return (
                                <label
                                  key={field.key}
                                  className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    disabled={readOnly}
                                    onChange={(event) => {
                                      const current = Array.isArray(
                                        selectedNode.data.fieldKeys,
                                      )
                                        ? selectedNode.data.fieldKeys.filter(
                                            (key): key is string =>
                                              typeof key === "string",
                                          )
                                        : [];
                                      updateNodeData({
                                        fieldKeys: event.target.checked
                                          ? [...current, field.key]
                                          : current.filter(
                                              (key) => key !== field.key,
                                            ),
                                      });
                                    }}
                                  />
                                  <span>{fieldTitle(field.key)}</span>
                                  <span className="ml-auto text-muted-foreground">
                                    {field.key.split(".")[0]}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </details>
                        {!(graph.fields || []).length && (
                          <p className="text-[11px] text-warning">
                            Add customer questions before configuring this step.
                          </p>
                        )}
                      </div>
                    )}

                    {(
                      ["collect", "message", "question"] as PlaybookNodeType[]
                    ).includes(selectedNode.type) && (
                      <details className="space-y-3 rounded-lg border p-3">
                        <summary className="cursor-pointer text-sm font-medium">
                          AI wording & tone
                        </summary>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <Label className="text-xs">AI wording</Label>
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              Natural phrasing is allowed while the question,
                              choices, and next step remain controlled.
                            </p>
                          </div>
                          <select
                            className="h-9 rounded-md border bg-background px-2 text-xs"
                            disabled={readOnly}
                            value={
                              selectedNode.presentation?.mode ||
                              graph.metadata?.presentationDefaults?.mode ||
                              "fixed"
                            }
                            onChange={(event) =>
                              updateNode({
                                presentation: {
                                  mode: event.target
                                    .value as PlaybookPresentationPolicy["mode"],
                                  tone:
                                    selectedNode.presentation?.tone ||
                                    graph.metadata?.presentationDefaults
                                      ?.tone ||
                                    "Natural and concise",
                                  guidance:
                                    selectedNode.presentation?.guidance ||
                                    graph.metadata?.presentationDefaults
                                      ?.guidance ||
                                    "Preserve the configured meaning.",
                                  optionStrategy:
                                    selectedNode.presentation?.optionStrategy ||
                                    graph.metadata?.presentationDefaults
                                      ?.optionStrategy ||
                                    "all",
                                  allowReordering:
                                    selectedNode.presentation
                                      ?.allowReordering ??
                                    graph.metadata?.presentationDefaults
                                      ?.allowReordering ??
                                    false,
                                  avoidRecentPhrasings:
                                    selectedNode.presentation
                                      ?.avoidRecentPhrasings ??
                                    graph.metadata?.presentationDefaults
                                      ?.avoidRecentPhrasings ??
                                    true,
                                  deterministicFallback:
                                    selectedNode.presentation
                                      ?.deterministicFallback ||
                                    graph.metadata?.presentationDefaults
                                      ?.deterministicFallback ||
                                    instructionFor(selectedNode) ||
                                    "Please provide the requested information.",
                                },
                              })
                            }
                          >
                            <option value="fixed">
                              Always use fixed wording
                            </option>
                            <option value="governed_hybrid">
                              Natural AI variation
                            </option>
                          </select>
                        </div>
                        {(selectedNode.presentation?.mode ||
                          graph.metadata?.presentationDefaults?.mode) ===
                          "governed_hybrid" && (
                          <>
                            <Input
                              disabled={readOnly}
                              value={presentationForSelectedNode.tone || ""}
                              placeholder="Tone"
                              onChange={(event) =>
                                updateNode({
                                  presentation: {
                                    ...presentationForSelectedNode,
                                    tone: event.target.value,
                                  },
                                })
                              }
                            />
                            <Textarea
                              disabled={readOnly}
                              rows={2}
                              value={presentationForSelectedNode.guidance || ""}
                              placeholder="AI guidance"
                              onChange={(event) =>
                                updateNode({
                                  presentation: {
                                    ...presentationForSelectedNode,
                                    guidance: event.target.value,
                                  },
                                })
                              }
                            />
                            <select
                              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                              disabled={readOnly}
                              value={presentationForSelectedNode.optionStrategy}
                              onChange={(event) =>
                                updateNode({
                                  presentation: {
                                    ...presentationForSelectedNode,
                                    optionStrategy: event.target
                                      .value as PlaybookPresentationPolicy["optionStrategy"],
                                  },
                                })
                              }
                            >
                              <option value="all">
                                Show all eligible options
                              </option>
                              <option value="relevant_subset">
                                AI selects relevant options
                              </option>
                            </select>
                            <Textarea
                              disabled={readOnly}
                              rows={3}
                              value={
                                presentationForSelectedNode.deterministicFallback
                              }
                              placeholder="Required deterministic fallback"
                              onChange={(event) =>
                                updateNode({
                                  presentation: {
                                    ...presentationForSelectedNode,
                                    deterministicFallback: event.target.value,
                                  },
                                })
                              }
                            />
                            <label className="flex items-center justify-between text-xs">
                              <span>Avoid recent phrasing</span>
                              <Switch
                                disabled={readOnly}
                                checked={
                                  presentationForSelectedNode.avoidRecentPhrasings
                                }
                                onCheckedChange={(value) =>
                                  updateNode({
                                    presentation: {
                                      ...presentationForSelectedNode,
                                      avoidRecentPhrasings: value,
                                    },
                                  })
                                }
                              />
                            </label>
                          </>
                        )}
                      </details>
                    )}

                    {previewField && (
                      <details className="space-y-2 rounded-lg border p-3">
                        <summary className="cursor-pointer text-sm font-medium">
                          Channel previews
                        </summary>
                        <div>
                          <Label className="text-xs">
                            Native channel preview
                          </Label>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            Provider payloads use these approved option IDs;
                            unsupported controls fall back to a numbered list.
                          </p>
                        </div>
                        <div className="grid gap-2">
                          {[
                            "WhatsApp",
                            "Instagram",
                            "Facebook",
                            "Email",
                            "Web chat",
                          ].map((previewChannel) => (
                            <div
                              key={previewChannel}
                              className="rounded-md bg-muted/30 p-2"
                            >
                              <div className="mb-1 flex items-center justify-between text-[11px] font-medium">
                                <span>{previewChannel}</span>
                                <span className="text-muted-foreground">
                                  {![
                                    "single_select",
                                    "multi_select",
                                    "boolean",
                                  ].includes(previewField.type)
                                    ? "Written answer"
                                    : previewChannel === "WhatsApp" &&
                                        (previewField.options?.length || 0) > 3
                                      ? "native list"
                                      : previewChannel === "Email" ||
                                          previewChannel === "Web chat"
                                        ? "accessible selector"
                                        : "quick replies"}
                                </span>
                              </div>
                              <p className="text-xs">{previewField.prompt}</p>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {(
                                  previewField.options ||
                                  (previewField.type === "boolean"
                                    ? [
                                        { value: "yes", label: "Yes" },
                                        { value: "no", label: "No" },
                                      ]
                                    : [])
                                )
                                  .slice(
                                    0,
                                    previewChannel === "Instagram" ? 13 : 10,
                                  )
                                  .map((option) => (
                                    <span
                                      key={option.value}
                                      className="rounded border bg-background px-2 py-1 text-[11px]"
                                    >
                                      {option.shortLabel || option.label}
                                    </span>
                                  ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {selectedNode.type === "action" && (
                      <>
                        <div className="space-y-1.5">
                          <Label className="text-xs">
                            Approved action name
                          </Label>
                          <Input
                            value={String(selectedNode.data.actionName || "")}
                            onChange={(event) =>
                              updateNodeData({ actionName: event.target.value })
                            }
                            placeholder="answer_from_knowledge_base"
                            disabled={readOnly}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Action arguments</Label>
                          <Textarea
                            rows={5}
                            className="font-mono text-xs"
                            value={actionArgsText}
                            onChange={(event) =>
                              setActionArgsText(event.target.value)
                            }
                            disabled={readOnly}
                            spellCheck={false}
                          />
                          {!readOnly && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="w-full"
                              onClick={saveActionArgs}
                            >
                              <Save className="mr-1.5 h-3.5 w-3.5" />
                              Apply arguments
                            </Button>
                          )}
                        </div>
                      </>
                    )}

                    {selectedNode.type === "capability" && (
                      <>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Governed capability</Label>
                          <select
                            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                            value={String(
                              selectedNode.data.capabilityName || "",
                            )}
                            disabled={readOnly}
                            onChange={(event) =>
                              updateNodeData({
                                capabilityName: event.target.value,
                              })
                            }
                          >
                            {CAPABILITIES.map((capability) => (
                              <option key={capability} value={capability}>
                                {capability === "asset.deliver" ? "Share approved document" : capability}
                              </option>
                            ))}
                          </select>
                        </div>
                        {selectedNode.data.capabilityName === "asset.deliver" && <SupportDocumentStepEditor
                          args={selectedNode.data.args} readOnly={readOnly}
                          onChange={(args) => updateNodeData({ args })} />}
                        <details className="space-y-2 rounded-lg border p-3">
                          <summary className="cursor-pointer text-sm font-medium">
                            Advanced: action inputs
                          </summary>
                          <Label className="text-xs">
                            Typed argument bindings
                          </Label>
                          <Textarea
                            rows={7}
                            className="font-mono text-xs"
                            value={actionArgsText}
                            onChange={(event) =>
                              setActionArgsText(event.target.value)
                            }
                            disabled={readOnly}
                            spellCheck={false}
                          />
                          <p className="text-[11px] text-muted-foreground">
                            Bind fields with{" "}
                            {`{"source":"field","key":"stay.checkIn"}`} or use
                            constant/context bindings.
                          </p>
                          {!readOnly && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="w-full"
                              onClick={saveActionArgs}
                            >
                              <Save className="mr-1.5 h-3.5 w-3.5" />
                              Apply bindings
                            </Button>
                          )}
                        </details>
                      </>
                    )}

                    {["message", "question"].includes(selectedNode.type) && (
                      <>
                        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                          <div>
                            <Label className="text-xs">Must say verbatim</Label>
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              Require the full approved wording in the reply.
                            </p>
                          </div>
                          <Switch
                            checked={selectedNode.data.verbatim === true}
                            onCheckedChange={(checked) =>
                              updateNodeData({ verbatim: checked })
                            }
                            disabled={readOnly}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Required phrases</Label>
                          <Textarea
                            rows={4}
                            value={phraseText}
                            onChange={(event) =>
                              updateNodeData({
                                requiredPhrases: event.target.value
                                  .split("\n")
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder={"One required phrase per line"}
                            disabled={readOnly}
                          />
                          <p className="text-[11px] text-muted-foreground">
                            Replies are scored against these phrases for
                            compliance.
                          </p>
                        </div>
                      </>
                    )}

                    <section
                      aria-label="Next steps"
                      className="space-y-2 border-t pt-4"
                    >
                      <h4 className="text-sm font-medium">What happens next</h4>
                      {graph.edges
                        .map((edge, i) => ({ edge, i }))
                        .filter(({ edge }) => edge.source === selectedNode.id)
                        .map(({ edge, i }) => (
                          <button
                            type="button"
                            key={edge.id || i}
                            onClick={() => {
                              setSelectedEdgeId(
                                edge.id || `${edge.source}-${edge.target}-${i}`,
                              );
                              setSelectedNodeId(null);
                            }}
                            className="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                          >
                            <span className="min-w-0">
                              <span className="block break-words">
                                {displayLabel(
                                  graph.nodes.find(
                                    (n) => n.id === edge.target,
                                  ) || {
                                    id: edge.target,
                                    type: "complete",
                                    data: {},
                                  },
                                )}
                              </span>
                              <span className="block break-words text-xs text-muted-foreground">
                                {mapEdgeLabel(edge, graph)}
                              </span>
                            </span>
                            <ChevronRight className="h-4 w-4 shrink-0" />
                          </button>
                        ))}
                      {!graph.edges.some(
                        (e) => e.source === selectedNode.id,
                      ) && (
                        <p className="text-xs text-muted-foreground">
                          {["complete", "handoff", "escalation"].includes(
                            selectedNode.type,
                          )
                            ? "This path ends here."
                            : "No next step connected yet."}
                        </p>
                      )}
                      <details>
                        <summary className="cursor-pointer py-2 text-xs text-muted-foreground">
                          Connect another step
                        </summary>
                        <div className="flex flex-wrap gap-2">
                          <select
                            aria-label="Next step to connect"
                            className="h-10 min-w-0 max-w-full flex-1 rounded-md border bg-background px-2 text-sm"
                            value={connectionTarget}
                            disabled={readOnly}
                            onChange={(e) =>
                              setConnectionTarget(e.target.value)
                            }
                          >
                            <option value="">Choose a step</option>
                            {graph.nodes
                              .filter((n) => n.id !== selectedNode.id)
                              .map((n) => (
                                <option key={n.id} value={n.id}>
                                  {displayLabel(n)}
                                </option>
                              ))}
                          </select>
                          <Button
                            variant="outline"
                            disabled={
                              readOnly ||
                              !connectionTarget ||
                              !graph.nodes.some(
                                (n) => n.id === connectionTarget,
                              )
                            }
                            onClick={() => {
                              connect({
                                source: selectedNode.id,
                                target: connectionTarget,
                                sourceHandle: null,
                                targetHandle: null,
                              });
                              setConnectionTarget("");
                            }}
                          >
                            Connect
                          </Button>
                        </div>
                      </details>
                    </section>
                    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                      <div>
                        <Label className="text-xs">Entry step</Label>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          The first step used when this playbook starts.
                        </p>
                      </div>
                      {graph.entryNodeId === selectedNode.id ? (
                        <Badge>Current entry</Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            applyGraph({
                              ...graph,
                              entryNodeId: selectedNode.id,
                            })
                          }
                          disabled={readOnly}
                        >
                          Set entry
                        </Button>
                      )}
                    </div>
                  </div>
                  {!readOnly && (
                    <div className="border-t p-3">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full text-destructive"
                        onClick={deleteSelectedNode}
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        Delete step
                      </Button>
                    </div>
                  )}
                </>
              ) : selectedEdge ? (
                <>
                  <div className="flex-1 space-y-4 p-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Rule</Label>
                      <select
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                        value={selectedEdge.condition?.operator || "always"}
                        onChange={(event) =>
                          updateEdgeCondition({
                            operator: event.target
                              .value as PlaybookEdgeOperator,
                          })
                        }
                        disabled={readOnly}
                      >
                        {EDGE_OPERATORS.map((operator) => (
                          <option key={operator} value={operator}>
                            {operator.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Field</Label>
                      <select
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                        value={selectedEdge.condition?.field || ""}
                        disabled={
                          readOnly ||
                          !String(
                            selectedEdge.condition?.operator || "",
                          ).startsWith("field_")
                        }
                        onChange={(event) =>
                          updateEdgeCondition({ field: event.target.value })
                        }
                      >
                        <option value="">Select field</option>
                        {(graph.fields || []).map((field) => (
                          <option key={field.key} value={field.key}>
                            {field.key}
                          </option>
                        ))}
                      </select>
                    </div>
                    {(selectedEdge.condition?.operator || "always") ===
                      "capability_status_is" && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Capability</Label>
                        <select
                          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                          value={selectedEdge.condition?.capability || ""}
                          disabled={readOnly}
                          onChange={(event) =>
                            updateEdgeCondition({
                              capability: event.target.value,
                            })
                          }
                        >
                          <option value="">Select capability</option>
                          {CAPABILITIES.map((capability) => (
                            <option key={capability}>{capability}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label className="text-xs">Comparison value</Label>
                      {selectedEdge.condition?.operator === "matches_intent" ? (
                        <SupportIntentSelect
                          value={selectedEdge.condition.value || ""}
                          onChange={(value) => updateEdgeCondition({ value })}
                          disabled={readOnly}
                          allowAll={false}
                        />
                      ) : (
                        <Input
                          value={
                            (selectedEdge.condition?.operator || "always") ===
                            "field_in"
                              ? (selectedEdge.condition?.values || []).join(
                                  ", ",
                                )
                              : selectedEdge.condition?.value || ""
                          }
                          onChange={(event) =>
                            (selectedEdge.condition?.operator || "always") ===
                            "field_in"
                              ? updateEdgeCondition({
                                  values: event.target.value
                                    .split(",")
                                    .map((value) => value.trim())
                                    .filter(Boolean),
                                })
                              : updateEdgeCondition({
                                  value: event.target.value,
                                })
                          }
                          placeholder="Value, intent, status, or comma-separated values"
                          disabled={
                            readOnly ||
                            [
                              "always",
                              "field_present",
                              "field_missing",
                              "all_required_fields_present",
                            ].includes(
                              selectedEdge.condition?.operator || "always",
                            )
                          }
                        />
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Branch priority</Label>
                      <Input
                        type="number"
                        min={0}
                        value={selectedEdge.priority ?? 100}
                        disabled={readOnly}
                        onChange={(event) =>
                          applyGraph({
                            ...graph,
                            edges: graph.edges.map((edge, index) =>
                              (edge.id ||
                                `${edge.source}-${edge.target}-${index}`) ===
                              selectedEdgeId
                                ? {
                                    ...edge,
                                    priority: Number(event.target.value),
                                  }
                                : edge,
                            ),
                          })
                        }
                      />
                    </div>
                    <div className="rounded-lg bg-muted p-3 text-[11px] text-muted-foreground">
                      Conditions are evaluated against the latest user message.
                      “Matches intent” uses the detected support intent.
                    </div>
                  </div>
                  {!readOnly && (
                    <div className="border-t p-3">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full text-destructive"
                        onClick={deleteSelectedEdge}
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        Delete connection
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center text-muted-foreground">
                  <GitBranch className="mb-3 h-8 w-8 opacity-30" />
                  <p className="text-sm font-medium">
                    Build the conversation path
                  </p>
                  <p className="mt-1 max-w-xs text-sm leading-relaxed">
                    Choose a step to edit its questions, wording, and next
                    actions. Use the flow map when you need the full picture.
                  </p>
                </div>
              )}
            </aside>}
          </div>
        </>
      )}
      {issues.length > 0 && (
        <Callout tone="warning" size="sm" title="Before publishing">
          <ul className="list-disc space-y-0.5 pl-4">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

export function PlaybookVariantsEditor({
  graph,
  onChange,
  readOnly = false,
}: {
  graph: PlaybookGraph;
  onChange: (graph: PlaybookGraph) => void;
  readOnly?: boolean;
}) {
  const variants = graph.variants || [];
  const total = variants.reduce(
    (sum, variant) => sum + Number(variant.weight || 0),
    0,
  );

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Deterministic A/B variants</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Split conversations consistently between alternate entry paths.
            Weights must total 100%.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={readOnly}
          onClick={() =>
            onChange({
              ...graph,
              variants: [
                ...variants,
                {
                  id: `variant-${variants.length + 1}`,
                  weight: variants.length ? 0 : 100,
                  entryNodeId: graph.entryNodeId,
                },
              ],
            })
          }
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add variant
        </Button>
      </div>

      {!variants.length ? (
        <div className="rounded-xl border-2 border-dashed p-10 text-center">
          <Workflow className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground">
            No traffic variants configured
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            All conversations currently begin at the main entry step.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {variants.map((variant, index) => (
            <div
              key={`${variant.id}-${index}`}
              className="grid gap-2 rounded-lg border p-3 md:grid-cols-[1fr_120px_1fr_40px]"
            >
              <div className="space-y-1">
                <Label className="text-[11px]">Variant name</Label>
                <Input
                  value={variant.id}
                  disabled={readOnly}
                  onChange={(event) =>
                    onChange({
                      ...graph,
                      variants: variants.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, id: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Traffic %</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={variant.weight}
                  disabled={readOnly}
                  onChange={(event) =>
                    onChange({
                      ...graph,
                      variants: variants.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              weight: Math.max(
                                0,
                                Math.min(100, Number(event.target.value)),
                              ),
                            }
                          : item,
                      ),
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Entry step</Label>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={variant.entryNodeId || graph.entryNodeId}
                  disabled={readOnly}
                  onChange={(event) =>
                    onChange({
                      ...graph,
                      variants: variants.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, entryNodeId: event.target.value }
                          : item,
                      ),
                    })
                  }
                >
                  {graph.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {displayLabel(node)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-destructive"
                  disabled={readOnly}
                  onClick={() =>
                    onChange({
                      ...graph,
                      variants: variants.filter(
                        (_item, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                  aria-label={`Delete ${variant.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between rounded-lg border p-3 text-xs">
        <span className="text-muted-foreground">Configured traffic</span>
        <Badge
          variant={total === 100 || total === 0 ? "secondary" : "destructive"}
        >
          {total}%
        </Badge>
      </div>
    </div>
  );
}
