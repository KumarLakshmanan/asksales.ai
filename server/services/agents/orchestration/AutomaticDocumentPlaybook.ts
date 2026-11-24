import type { PlaybookGraph } from '../../../models/supportOrchestration/schema.js';

/** Upgrade only existing brochure menu nodes; factual spa/dining/location
 * answers and all owner-authored collection/consent branches stay unchanged. */
export function automaticHospitalityDocuments(source: PlaybookGraph): PlaybookGraph {
  if (source.schemaVersion !== 2) throw new Error('A version-2 hospitality journey is required.');
  const graph = structuredClone(source);
  for (const [id, service, label] of [
    ['answer-resort-details', 'resort', 'Find and share resort factsheet'],
    ['answer-day-outing', 'day_outing', 'Find and share day-outing brochure'],
  ]) {
    const node = graph.nodes.find(item => item.id === id);
    if (node?.type !== 'capability' || !['knowledge.answer', 'asset.deliver'].includes(String(node.data?.capabilityName))) {
      throw new Error(`Unexpected document node: ${id}`);
    }
    node.data = { ...node.data, label, capabilityName: 'asset.deliver',
      instruction: 'Search current approved documents for this topic and the customer request. Share only a verified match. If none matches, explain that and offer support without starting a callback. Custom written offers use the proposal agent, not a brochure. Never claim delivery without its receipt.',
      args: { service: { source: 'constant', value: service } } };
  }
  return graph;
}
