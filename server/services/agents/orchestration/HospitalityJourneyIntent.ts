import type { PlaybookGraph, PlaybookRunStateV2 } from '../../../models/supportOrchestration/schema.js';
import { confidentSemanticIntent, type SupportSemanticIntent } from './SupportSemanticIntent.js';

/** An explicit first-person request, not a mention, quotation, negation or
 * mixed booking. Safety/handoff gates still run before the playbook engine. */
export function explicitSpaBookingRequest(request?: SupportSemanticIntent): boolean {
  const intent = confidentSemanticIntent(request);
  return intent?.explicit === true && intent.action === 'booking' && intent.service === 'spa';
}

/** Resolve non-room requests from the published graph, not room-booking intent
 * labels. The same collection step may serve dining/day visits but must not
 * inherit another service's date, occupancy or consent. */
export function hospitalityServiceDestination(graph: PlaybookGraph, request?: SupportSemanticIntent): {
  nodeId: string; topic: string; nextStepKey: string; booking: boolean;
} | undefined {
  const intent = confidentSemanticIntent(request);
  if (!intent?.explicit || !['spa', 'dining', 'day_outing'].includes(intent.service)
    || !(intent.action === 'booking' || (intent.action === 'information' && intent.topicSwitch))) return undefined;
  if (graph.schemaVersion !== 2 || graph.metadata?.templateKey !== 'hospitality-sales-enquiries-v2') return undefined;
  const nextStepKey = intent.service === 'day_outing' ? 'outing.nextStep' : `${intent.service}.nextStep`;
  if (!graph.fields?.find(field => field.key === 'resort.topic')?.options?.some(option => option.value === intent.service)) return undefined;
  const menu=graph.nodes.find(node => node.type === 'collect' && Array.isArray(node.data?.fieldKeys)
    && node.data.fieldKeys.includes(nextStepKey));
  const edges=graph.edges.filter(edge => edge.source === menu?.id && edge.condition?.operator === 'field_equals'
    && edge.condition.field === nextStepKey && edge.condition.value === 'book');
  if (edges.length !== 1) return undefined;
  const target=graph.nodes.find(node => node.id === edges[0].target);
  if (target?.type !== 'collect' || !Array.isArray(target.data?.fieldKeys) || !target.data.fieldKeys.includes('service.dateTime')) return undefined;
  return {nodeId:target.id,topic:intent.service,nextStepKey,booking:intent.action === 'booking'};
}

/** Older immutable runs used shared dining/outing intake. Do not ask their
 * guest counts for spa; new publications use a dedicated spa collect node. */
export function irrelevantLegacySpaField(graph: PlaybookGraph, nodeId: string, state: PlaybookRunStateV2, key: string): boolean {
  return graph.metadata?.templateKey === 'hospitality-sales-enquiries-v2'
    && nodeId === 'collect-service-request' && state.fields['resort.topic']?.value === 'spa'
    && ['service.adults', 'service.children'].includes(key);
}
