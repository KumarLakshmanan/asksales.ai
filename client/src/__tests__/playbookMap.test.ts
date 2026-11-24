import { describe, expect, it } from "vitest";
import { arrangePlaybookMap, needsMapLayout, mapNodeSummary, mapEdgeLabel, mapNodeTitle, MAP_NODE_HEIGHT, MAP_NODE_WIDTH } from "@/lib/playbook-map";
import type { PlaybookGraph } from "@/components/support/PlaybookGraphEditor";

const graph: PlaybookGraph = {
  entryNodeId: "start", schemaVersion: 2,
  fields: [{ key: "resort.topic", type: "single_select", pii: "none", required: true, prompt: "What would you like to know?",
    options: [{ value: "spa", label: "Spa & wellness" }] }],
  nodes: [
    { id: "start", type: "trigger", data: {} },
    { id: "collect-topic", type: "collect", data: { fieldKeys: ["resort.topic"] } },
    { id: "spa", type: "capability", data: { label: "Spa information", capabilityName: "knowledge.answer" } },
    { id: "corporate-complete", type: "complete", data: {} },
    { id: "unused", type: "complete", data: {} },
  ],
  edges: [
    { id: "1", source: "start", target: "collect-topic", priority: 10 },
    { id: "2", source: "collect-topic", target: "spa", priority: 10, condition: { operator: "field_equals", field: "resort.topic", value: "spa" } },
    { id: "3", source: "collect-topic", target: "corporate-complete", priority: 20 },
    { id: "4", source: "spa", target: "collect-topic", priority: 10 },
  ], variants: [{ id: "main", weight: 100 }],
};

describe("readable playbook maps", () => {
  it("lays out branches, loops and disconnected steps without altering runtime data", () => {
    const before = structuredClone(graph);
    const arranged = arrangePlaybookMap(graph);
    expect(graph).toEqual(before);
    expect(arranged.edges).toBe(graph.edges);
    expect(arranged.fields).toBe(graph.fields);
    expect(arranged.variants).toBe(graph.variants);
    expect(arranged.nodes.map(({ position, ...node }) => node)).toEqual(graph.nodes);
    expect(arranged.nodes[1].position!.x).toBeGreaterThan(arranged.nodes[0].position!.x);
    expect(arranged.nodes[2].position!.x).toBe(arranged.nodes[3].position!.x);
    expect(arranged.nodes[2].position!.y).not.toBe(arranged.nodes[3].position!.y);
    expect(needsMapLayout(arranged)).toBe(false);
    expect(arrangePlaybookMap(arranged)).toEqual(arranged);
  });
  it("detects missing, invalid and crowded saved positions", () => {
    expect(needsMapLayout(graph)).toBe(true);
    expect(needsMapLayout({ ...graph, nodes: graph.nodes.map(node => ({ ...node, position: { x: 0, y: 0 } })) })).toBe(true);
    expect(needsMapLayout({ ...graph, nodes: [{ ...graph.nodes[0], position: { x: NaN, y: 0 } }] })).toBe(true);
  });
  it("gives every node room in a 56-step branching map", () => {
    const large: PlaybookGraph = { entryNodeId: "0", nodes: Array.from({ length: 56 }, (_, i) => ({ id: String(i), type: "message", data: {} })),
      edges: Array.from({ length: 55 }, (_, i) => ({ source: String(Math.floor(i / 3)), target: String(i + 1) })) };
    const arranged = arrangePlaybookMap(large);
    for (const [i, node] of arranged.nodes.entries()) {
      for (const other of arranged.nodes.slice(i + 1)) {
        expect(Math.abs(node.position!.x - other.position!.x) >= MAP_NODE_WIDTH + 40
          || Math.abs(node.position!.y - other.position!.y) >= MAP_NODE_HEIGHT + 40).toBe(true);
      }
    }
  });
  it("shows customer prompts, business actions and readable fallback titles", () => {
    expect(mapNodeSummary(graph.nodes[1], graph)).toBe("What would you like to know?");
    expect(mapNodeSummary(graph.nodes[2], graph)).toBe("Answer using approved information");
    expect(mapNodeTitle(graph.nodes[3])).toBe("Corporate complete");
    expect(mapNodeSummary({ id: "stay", type: "collect", data: { fieldKeys: ["stay.checkIn", "stay.checkOut"] } }, graph)).toContain("Check in, Check out");
  });
  it("uses configured option names and accurately distinguishes branches", () => {
    expect(mapEdgeLabel(graph.edges[1], graph)).toBe("Resort topic: Spa & wellness");
    expect(mapEdgeLabel(graph.edges[2], graph)).toBe("Otherwise");
    expect(mapEdgeLabel(graph.edges[0], graph)).toBe("Continue");
    expect(mapEdgeLabel({ source: "x", target: "y", condition: { operator: "field_missing", field: "contact.fullName" } }, graph)).toBe("Contact full name still needed");
  });
});
