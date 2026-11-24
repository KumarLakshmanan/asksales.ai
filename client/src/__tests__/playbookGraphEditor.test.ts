import { describe, expect, it } from "vitest";
import {
  getPlaybookGraphIssues,
  normalizePlaybookGraph,
  type PlaybookGraph,
} from "@/components/support/PlaybookGraphEditor";
import { proposalGraphFixture } from './fixtures/playbook';

const validGraph: PlaybookGraph = {
  entryNodeId: "start",
  nodes: [
    { id: "start", type: "trigger", data: {} },
    { id: "reply", type: "message", data: { instruction: "Give a verified answer." } },
    { id: "done", type: "complete", data: {} },
  ],
  edges: [
    { source: "start", target: "reply", condition: { operator: "always" } },
    { source: "reply", target: "done", condition: { operator: "always" } },
  ],
};

describe("playbook graph editor helpers", () => {
  it.each(['proposal.list', 'proposal.request', 'proposal.revision_request'])('accepts registered proposal capabilities (%s)', capabilityName => {
    expect(getPlaybookGraphIssues(proposalGraphFixture(capabilityName))).toEqual([]);
  });

  it.each(['', 'unregistered.capability'])('rejects a missing or unregistered capability (%s)', capabilityName => {
    const graph = proposalGraphFixture();
    graph.nodes.find(node => node.id === 'record-changes')!.data.capabilityName = capabilityName;
    expect(getPlaybookGraphIssues(graph)).toContain('Record changes requires a registered capability.');
  });
  it("normalizes layout and edge metadata without changing the runtime path", () => {
    const normalized = normalizePlaybookGraph(validGraph);

    expect(normalized.entryNodeId).toBe("start");
    expect(normalized.nodes.every((node) => node.position)).toBe(true);
    expect(normalized.edges.every((edge) => edge.id && edge.condition)).toBe(true);
    expect(normalized.edges.map((edge) => `${edge.source}:${edge.target}`)).toEqual([
      "start:reply",
      "reply:done",
    ]);
  });

  it("accepts a connected playbook with a terminal step", () => {
    expect(getPlaybookGraphIssues(validGraph)).toEqual([]);
  });

  it("reports unreachable steps, deterministic loops, and invalid variant weights", () => {
    const issues = getPlaybookGraphIssues({
      entryNodeId: "start",
      nodes: [
        { id: "start", type: "trigger", data: { label: "Start" } },
        { id: "branch", type: "condition", data: { label: "Branch" } },
        { id: "unused", type: "complete", data: { label: "Unused completion" } },
      ],
      edges: [
        { source: "start", target: "branch", condition: { operator: "always" } },
        { source: "branch", target: "start", condition: { operator: "always" } },
      ],
      variants: [{ id: "variant-a", weight: 80, entryNodeId: "start" }],
    });

    expect(issues).toContain("Unused completion is not reachable from the entry step.");
    expect(issues).toContain("Trigger and condition steps contain a loop that would never wait for a customer response.");
    expect(issues).toContain("Variant traffic weights must total 100%.");
  });

  it("validates typed fields and v2 collect/capability steps", () => {
    const graph: PlaybookGraph = {
      schemaVersion: 2,
      entryNodeId: "start",
      fields: [{
        key: "journey.type", type: "single_select", required: true, pii: "none",
        prompt: "Choose an enquiry type.", options: [{ value: "sales", label: "Sales", aliases: ["buy"] }],
      }],
      nodes: [
        { id: "start", type: "trigger", data: {} },
        { id: "collect", type: "collect", data: { fieldKeys: ["journey.type"] } },
        { id: "capability", type: "capability", data: { capabilityName: "inquiry.create", args: {
          category: { source: "field", key: "journey.type" },
        } } },
        { id: "done", type: "complete", data: {} },
      ],
      edges: [
        { source: "start", target: "collect", condition: { operator: "always" } },
        { source: "collect", target: "capability", condition: { operator: "all_required_fields_present" } },
        { source: "capability", target: "done", condition: { operator: "always" } },
      ],
    };
    expect(getPlaybookGraphIssues(graph)).toEqual([]);
    expect(getPlaybookGraphIssues({
      ...graph,
      fields: [{ ...graph.fields![0], pii: "sensitive", required: true }],
    })).toContain("Sensitive field journey.type cannot be required.");
  });

  it("rejects overlapping structured branches even when priorities differ", () => {
    const issues = getPlaybookGraphIssues({
      entryNodeId: "start",
      nodes: [
        { id: "start", type: "trigger", data: {} },
        { id: "left", type: "complete", data: {} },
        { id: "right", type: "complete", data: {} },
      ],
      edges: [
        { source: "start", target: "left", priority: 10, condition: { operator: "contains", value: "book" } },
        { source: "start", target: "right", priority: 20, condition: { operator: "contains", value: "booking" } },
      ],
    });
    expect(issues.some((issue) => issue.includes("overlapping branch conditions"))).toBe(true);
  });
});
