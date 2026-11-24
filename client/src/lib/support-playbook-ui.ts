export interface SupportPlaybookSummary {
  id: number;
  status: string;
  enabled: boolean;
  activeVersion: number | null;
}

export interface SupportPlaybookGroups<T extends SupportPlaybookSummary> {
  current: T[];
  archived: T[];
}

export function supportPlaybookPriority(item: SupportPlaybookSummary): number {
  return (item.status === 'published' ? 100 : 0)
    + (item.enabled !== false ? 20 : 0)
    + (item.activeVersion ? 10 : 0)
    - (item.status === 'archived' ? 200 : 0);
}

export function preferredPlaybookId(items: SupportPlaybookSummary[]): number | null {
  return sortSupportPlaybooks(items.filter((item) => item.status !== 'archived'))[0]?.id ?? null;
}

export function sortSupportPlaybooks<T extends SupportPlaybookSummary>(items: T[]): T[] {
  return [...items].sort((left, right) => supportPlaybookPriority(right) - supportPlaybookPriority(left) || right.id - left.id);
}

export function groupSupportPlaybooks<T extends SupportPlaybookSummary>(items: T[]): SupportPlaybookGroups<T> {
  return {
    current: sortSupportPlaybooks(items.filter((item) => item.status !== 'archived')),
    archived: [...items]
      .filter((item) => item.status === 'archived')
      .sort((left, right) => right.id - left.id),
  };
}

/** Walk actual connections from the entry; retain unreachable steps for honest inspection. */
export function orderedPlaybookNodes<T extends { id: string }>(graph: { entryNodeId: string; nodes: T[]; edges: Array<{ source: string; target: string }> }): Array<{ node: T; reachable: boolean }> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const result: Array<{ node: T; reachable: boolean }> = [];
  const queue = [graph.entryNodeId];
  while (queue.length) {
    const id = queue.shift()!;
    const node = nodes.get(id);
    if (!node || seen.has(id)) continue;
    seen.add(id); result.push({ node, reachable: true });
    graph.edges.filter((edge) => edge.source === id).forEach((edge) => queue.push(edge.target));
  }
  graph.nodes.filter((node) => !seen.has(node.id)).forEach((node) => result.push({ node, reachable: false }));
  return result;
}
