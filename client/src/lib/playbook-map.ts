import type { PlaybookGraph, PlaybookGraphEdge, PlaybookGraphNode } from "@/components/support/PlaybookGraphEditor";

export const MAP_NODE_WIDTH = 280;
export const MAP_NODE_HEIGHT = 176;

/** Display formatting only; these names never participate in intent/routing decisions. */
export function readableName(value: string): string {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : "";
}

const actions: Record<string, string> = {
  "ticket.status": "Check the support request status",
  "catalog.search": "Find matching products or services",
  "availability.check": "Check availability for the requested details",
  "quote.present": "Present a verified quote",
  "knowledge.answer": "Answer using approved information",
  "media.select": "Choose approved photos or documents",
  "asset.deliver": "Share an approved document",
  "inquiry.create": "Record the customer's enquiry",
  "callback.request": "Request a callback with consent",
  "checkout.continue": "Continue the approved booking process",
  "human_handoff.create": "Pass the conversation to the support team",
};

export function mapNodeTitle(node: PlaybookGraphNode): string {
  return String(node.data.label || readableName(node.id));
}

export function mapNodeSummary(node: PlaybookGraphNode, graph: PlaybookGraph): string {
  if (node.type === "collect") {
    const keys = Array.isArray(node.data.fieldKeys) ? node.data.fieldKeys : [];
    const prompts = keys.map(key => graph.fields?.find(field => field.key === key)?.prompt || readableName(String(key)));
    return prompts.length === 1 ? prompts[0] : `Ask only for missing details: ${keys.map(key => readableName(String(key).split(".").pop() || String(key))).join(", ")}.`;
  }
  const instruction = String(node.data.message || node.data.instruction || "");
  if (node.type === "capability" || node.type === "action") {
    const name = String(node.data.capabilityName || node.data.actionName || "");
    return actions[name] || instruction || readableName(name) || "Carry out the configured action";
  }
  return instruction || ({ trigger: "Start here, then follow the matching customer request.",
    condition: "Choose the next step using the labelled conditions.",
    knowledge: "Answer using approved information.", media: "Choose approved photos or documents.",
    handoff: "Pass the conversation to the support team.", escalation: "Ask a person to help.",
    complete: "End this path. No further playbook steps." } as Record<string, string>)[node.type] || "Select this step to read its instructions.";
}

export function mapEdgeLabel(edge: PlaybookGraphEdge, graph: PlaybookGraph): string {
  const rule = edge.condition || { operator: "always" };
  const field = graph.fields?.find(item => item.key === rule.field);
  const value = (raw?: string) => field?.options?.find(option => option.value === raw)?.label || readableName(String(raw ?? ""));
  const fieldName = readableName(rule.field || "Answer");
  switch (rule.operator) {
    case "always": return graph.edges.filter(item => item.source === edge.source).length > 1 ? "Otherwise" : "Continue";
    case "matches_intent": return `Request: ${value(rule.value)}`;
    case "field_equals": return `${fieldName}: ${value(rule.value)}`;
    case "field_in": return `${fieldName}: ${(rule.values || []).map(value).join(" or ")}`;
    case "field_present": return `${fieldName} provided`;
    case "field_missing": return `${fieldName} still needed`;
    case "all_required_fields_present": return "Required details collected";
    case "confirmation_is": return `Confirmation: ${value(rule.value)}`;
    case "capability_status_is": return `Action result: ${value(rule.value)}`;
    case "grounding_is": return `Answer verification: ${value(rule.value)}`;
    case "delivery_is": return `Delivery: ${value(rule.value)}`;
    case "contains": return `Reply contains: ${rule.value || ""}`;
    case "not_contains": return `Reply does not contain: ${rule.value || ""}`;
    case "equals": return `Reply is: ${rule.value || ""}`;
    default: return readableName(rule.operator);
  }
}

/** Stable breadth-first columns; cycles and disconnected nodes remain visible.
 * Only positions change. Priorities, IDs, conditions and runtime data are untouched. */
export function arrangePlaybookMap(graph: PlaybookGraph): PlaybookGraph {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const columns = new Map<string, number>();
  const layers: string[][] = [];
  const visit = (root: string, initial: number) => {
    if (!nodes.has(root) || columns.has(root)) return;
    columns.set(root, initial);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const depth = columns.get(id)!;
      (layers[depth] ||= []).push(id);
      graph.edges.filter(edge => edge.source === id).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).forEach(edge => {
        if (nodes.has(edge.target) && !columns.has(edge.target)) {
          columns.set(edge.target, depth + 1);
          queue.push(edge.target);
        }
      });
    }
  };
  visit(graph.entryNodeId, 0);
  graph.nodes.forEach(node => { if (!columns.has(node.id)) visit(node.id, layers.length); });
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, depth) => layer.forEach((id, row) => {
    positions.set(id, { x: 48 + depth * 520, y: 48 + row * 270 });
  }));
  return { ...graph, nodes: graph.nodes.map(node => ({ ...node, position: positions.get(node.id)! })) };
}

export function needsMapLayout(graph: PlaybookGraph): boolean {
  return graph.nodes.some((node, index) => {
    const point = node.position;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return true;
    return graph.nodes.slice(index + 1).some(other => other.position
      && Math.abs(point.x - other.position.x) < MAP_NODE_WIDTH + 40
      && Math.abs(point.y - other.position.y) < MAP_NODE_HEIGHT + 40);
  });
}
