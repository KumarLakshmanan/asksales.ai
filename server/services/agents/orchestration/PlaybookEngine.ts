import crypto from 'node:crypto';
import { currentAssistant } from '../../assistants/AssistantContext.js';
import { assertAssistantFresh } from '../../assistants/AssistantFreshness.js';
import { currentSupportTurn } from './SupportConversationTurn.js';
import { currentProposalInstruction } from './ProposalSupportConfiguration.js';
import { hospitalityServiceDestination } from './HospitalityJourneyIntent.js';
import { isBrochureInformationRequest } from './SupportInformationRequest.js';
import { SUPPORT_REQUEST_SERVICES, confidentSemanticIntent, type SupportSemanticIntent } from './SupportSemanticIntent.js';
import { supportPreviewStore } from './SupportPreviewStore.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import {
  supportPlaybooksTable,
  supportPlaybookRunsTable,
  supportPlaybookVersionsTable,
  type PlaybookEdge,
  type PlaybookGraph,
  type PlaybookNode,
  type PlaybookRunStateV2,
} from '../../../models/supportOrchestration/schema.js';
import { HIGH_RISK_SUPPORT_TOOLS, READ_SUPPORT_TOOLS, SUPPORT_TOOL_NAMES } from './SafeToolExecutor.js';
import { validateSupportToolArgs } from './SupportToolSchemas.js';
import type { ClaimEvidence } from '../../knowledge/types.js';
import type { SupportEffectProposal, ToolOutcome } from '../BaseOutreachAgent.js';
import type { ContactProfileSnapshot } from './ContactProfileService.js';
import type { PlaybookPresentationPolicy } from '../../../models/supportOrchestration/schema.js';
import type { MediaIntent } from '../../supportMedia/types.js';
import {
  SUPPORT_CAPABILITIES,
  isSupportCapability,
  resolveCapabilityBindings,
  validateCapabilityBindings,
  validateResolvedCapability,
  type SupportCapabilityKind,
} from './SupportCapabilityRegistry.js';
import {
  collectInstruction,
  collectJourneyFields,
  correctJourneyFields,
  initializeJourneyState,
  journeyEdgeMatches,
  missingFieldsForNode,
  isHospitalityServiceTopicSelection,
  validateJourneyFields,
  type JourneyTurnInput,
} from './SupportJourneyRuntime.js';
import { createSupportChoiceManifest, matchExactPlaybookChoice, type SupportChoiceManifest } from './SupportChoiceDelivery.js';
import { parseExternalSearchCountCorrection } from '../../booking/ExternalBookingSearchUrl.js';
import { sha256Json as playbookChecksum } from '../../../utils/sha256.js';
export { playbookChecksum };

export type PlaybookAssertion =
  | { type: 'intent_is'; value: string }
  | { type: 'grounding_is'; value: string }
  | { type: 'has_supported_claims' }
  | { type: 'tool_succeeded'; tool: string }
  | { type: 'tool_confirmed_effect'; tool: string }
  | { type: 'effect_proposed'; effectType: string }
  | { type: 'handoff_required'; value?: boolean }
  | { type: 'decision_outcome'; value: string }
  | { type: 'media_intent_is'; value: MediaIntent }
  | { type: 'media_selected' }
  | { type: 'media_delivery_succeeded' };

export interface PlaybookComplianceInput {
  replyText: string;
  intent?: string;
  groundingStatus?: string;
  claims?: ClaimEvidence[];
  toolOutcomes?: ToolOutcome[];
  effectProposals?: SupportEffectProposal[];
  handoffRequired?: boolean;
  outcome?: string;
  mediaIntent?: MediaIntent;
  mediaSelected?: boolean;
  mediaDeliverySucceeded?: boolean;
}

export interface PlaybookMatchInput {
  semanticRequest?: SupportSemanticIntent;
  userId: number;
  conversationId: number;
  channel: string;
  intent?: string;
  /** Pre-classified visual intent so media requests do not masquerade as KB FAQs. */
  mediaIntent?: MediaIntent;
  inboundText: string;
  /** The sole active account agent. Playbooks never select another agent. */
  agentType: string;
  /** Stable provider/local inbound identity used to suppress duplicate turns. */
  eventKey?: string;
  entities?: Record<string, unknown>;
  privacyVaultId?: number | null;
  contactAvailable?: boolean;
  groundingStatus?: string;
  deliveryStatus?: string;
  dryRun?: boolean;
  /** Read the customer's current run for a draft, without advancing preview state. */
  readOnlyDraft?: boolean;
  profileSnapshot?: ContactProfileSnapshot | null;
}

export function shouldUseKnowledgeInterruption(input: Pick<PlaybookMatchInput, 'intent' | 'mediaIntent'>): boolean {
  return input.intent === 'faq' && input.mediaIntent !== 'explicit';
}

export function shouldUseMediaInterruption(input: Pick<PlaybookMatchInput, 'mediaIntent'>): boolean {
  return input.mediaIntent === 'explicit';
}

export function collectNodeConsumesInbound(
  graph: PlaybookGraph,
  node: PlaybookNode,
  state: PlaybookRunStateV2,
  input: JourneyTurnInput,
): boolean {
  if (graph.schemaVersion !== 2 || node.type !== 'collect') return false;
  const missingFields = missingFieldsForNode(graph, node, state);
  // FAQ entities describe the subject of a question, not necessarily a booking
  // or qualification answer. Only an exact schema-owned choice may override
  // that classification. Substring matches and arbitrary text/number extraction
  // otherwise swallow questions such as "Can nine adults stay in this room?".
  if (input.intent === 'faq') {
    const promptedField = missingFields[0];
    // A question is the expected answer when this collect field feeds the
    // immediately following knowledge query. Treating it as an interruption
    // would answer it and then ask the same "What would you like to know?"
    // prompt forever. Ordinary booking/qualification fields remain protected.
    const outgoing = graph.edges.filter(edge => edge.source === node.id);
    const next = outgoing.length === 1 && ['always', 'all_required_fields_present'].includes(outgoing[0].condition?.operator || 'always')
      ? graph.nodes.find(candidate => candidate.id === outgoing[0].target) : undefined;
    const queryBinding = next?.type === 'capability' && next.data?.capabilityName === 'knowledge.answer'
      ? (next.data.args as Record<string, unknown> | undefined)?.query as { source?: string; key?: string } | undefined : undefined;
    if (promptedField?.type === 'text' && promptedField.pii === 'none'
      && queryBinding?.source === 'field' && queryBinding.key === promptedField.key) {
      const collected = collectJourneyFields(graph, node, state, input);
      return ['collected', 'verified'].includes(collected.fields[promptedField.key]?.status);
    }
    return Boolean(promptedField && (
      matchExactPlaybookChoice(promptedField, input.inboundText)
      || isHospitalityServiceTopicSelection(promptedField, input.semanticRequest)
    ));
  }
  const missingBefore = new Set(missingFields.map((field) => field.key));
  if (!missingBefore.size) return false;
  const collected = collectJourneyFields(graph, node, state, input);
  return [...missingBefore].some((key) => ['collected', 'verified'].includes(collected.fields[key]?.status));
}

export function isCompletedPublicSearchRefinement(run: {
  status?: unknown; currentNodeId?: unknown; state?: Record<string, unknown> | null;
}, input: Pick<PlaybookMatchInput, 'inboundText' | 'semanticRequest'>): boolean {
  if (run.status !== 'completed' || run.currentNodeId !== 'external-search-complete' || run.state?.deliveryStatus !== 'sent') return false;
  if (parseExternalSearchCountCorrection(input.inboundText)) return true;
  // Count mentions that failed the exact bounded parser (negation, compound
  // requests, or invalid values) must not re-enter through a model hint.
  if (/\b(?:adults?|children|child|rooms?)\b/i.test(input.inboundText)) return false;
  const request = confidentSemanticIntent(input.semanticRequest);
  return request?.explicit === true && request.service === 'stay' && request.action === 'correction' && !request.topicSwitch;
}

export interface PlaybookDirective {
  playbookId: number;
  version: number;
  runId: number;
  nodeId: string;
  nodeType: string;
  agentType?: string | null;
  instruction?: string;
  /** Deterministic field prompt appended after a temporary knowledge answer. */
  resumeQuestion?: string;
  /** Informational overlay: never collect, write back, or commit a journey. */
  readOnlyInformation?: boolean;
  /** Contextual continuation of a completed journey, not a brochure request. */
  completedJourneyFollowUp?: boolean;
  /** Only a delivered external search; never a confirmed reservation/action. */
  publicBookingSearchFollowUp?: boolean;
  /** A published asset-delivery step, never inferred from customer keywords. */
  documentService?: SupportSemanticIntent['service'];
  documentId?: number;
  requiredAction?: string;
  actionArgs?: Record<string, unknown>;
  capability?: {
    name: string;
    kind: SupportCapabilityKind;
    args: Record<string, unknown>;
    effectType?: string;
    validationErrors?: string[];
  };
  journey?: {
    schemaVersion: 2;
    fields: Record<string, { value?: unknown; status: string; source: string; vaultRef?: number }>;
    missingFields: string[];
  };
  /** Published, deterministic options for provider-native controls. */
  choice?: SupportChoiceManifest;
  presentation?: PlaybookPresentationPolicy;
  escalate?: boolean;
  complete?: boolean;
  compliance?: {
    verbatim?: string;
    requiredPhrases?: string[];
    assertions?: PlaybookAssertion[];
  };
}

const ASSERTION_TYPES = new Set([
  'intent_is', 'grounding_is', 'has_supported_claims', 'tool_succeeded',
  'tool_confirmed_effect', 'effect_proposed', 'handoff_required', 'decision_outcome',
  'media_intent_is', 'media_selected', 'media_delivery_succeeded',
]);

function parseAssertions(value: unknown): PlaybookAssertion[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PlaybookAssertion => Boolean(item)
    && typeof item === 'object'
    && ASSERTION_TYPES.has(String((item as Record<string, unknown>).type)));
}

function playbookConditionsOverlap(left: PlaybookEdge, right: PlaybookEdge): boolean {
  const a = left.condition || { operator: 'always' as const };
  const b = right.condition || { operator: 'always' as const };
  if (a.operator === 'always' || b.operator === 'always') return false;
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  if (a.field && b.field && a.field === b.field) {
    const values = (condition: NonNullable<PlaybookEdge['condition']>): string[] => {
      if (condition.operator === 'field_equals') return [String(condition.value || '').toLocaleLowerCase()];
      if (condition.operator === 'field_in') return (condition.values || []).map((value) => value.toLocaleLowerCase());
      return [];
    };
    const aValues = values(a);
    const bValues = values(b);
    if (aValues.length && bValues.length && aValues.some((value) => bValues.includes(value))) return true;
    if (a.operator === 'field_present' && ['field_equals', 'field_in', 'field_present'].includes(b.operator)) return true;
    if (b.operator === 'field_present' && ['field_equals', 'field_in', 'field_present'].includes(a.operator)) return true;
  }
  if (a.operator === 'contains' && b.operator === 'contains') {
    const aValue = String(a.value || '').toLocaleLowerCase();
    const bValue = String(b.value || '').toLocaleLowerCase();
    return Boolean(aValue && bValue && (aValue.includes(bValue) || bValue.includes(aValue)));
  }
  return false;
}

export function validatePlaybookGraph(graph: PlaybookGraph): string[] {
  const errors: string[] = [];
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return ['Playbook must contain at least one node.'];
  if (!Array.isArray(graph.edges)) errors.push('Playbook edges must be an array.');
  errors.push(...validateJourneyFields(graph));
  const fieldKeys = new Set((graph.fields || []).map((field) => field.key));
  const nodeIds = new Set<string>();
  const validatePresentation = (policy: PlaybookPresentationPolicy | undefined, label: string) => {
    if (!policy) return;
    if (!['fixed', 'governed_hybrid'].includes(policy.mode)) errors.push(`${label} has an unsupported presentation mode.`);
    if (!['all', 'relevant_subset'].includes(policy.optionStrategy)) errors.push(`${label} has an unsupported option strategy.`);
    if (!String(policy.deterministicFallback || '').trim()) errors.push(`${label} requires a deterministic presentation fallback.`);
    if (String(policy.tone || '').length > 500 || String(policy.guidance || '').length > 2_000) errors.push(`${label} presentation guidance is too long.`);
  };
  validatePresentation(graph.metadata?.presentationDefaults, 'Playbook presentation defaults');
  for (const node of graph.nodes) {
    if (!node.id || nodeIds.has(node.id)) errors.push(`Duplicate or missing node id: ${node.id || '(empty)'}.`);
    nodeIds.add(node.id);
    validatePresentation(node.presentation, `Node ${node.id}`);
    if (!['trigger', 'message', 'question', 'condition', 'action', 'escalation', 'collect', 'knowledge', 'media', 'capability', 'handoff', 'complete'].includes(node.type)) {
      errors.push(`Unsupported node type on ${node.id}: ${node.type}.`);
    }
    if (['message', 'question'].includes(node.type) && !String(node.data?.instruction || node.data?.message || '').trim()) {
      errors.push(`${node.type} node ${node.id} requires an instruction or message.`);
    }
    if (node.type === 'action' && !String(node.data?.actionName || '').trim()) {
      errors.push(`Action node ${node.id} requires actionName.`);
    }
    if (node.type === 'action') {
      const actionName = String(node.data?.actionName || '');
      if (actionName && !SUPPORT_TOOL_NAMES.has(actionName)) {
        errors.push(`Action node ${node.id} references unsupported tool ${actionName}.`);
      }
      const args = node.data?.args;
      if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) {
        errors.push(`Action node ${node.id} args must be an object.`);
      } else if (actionName && SUPPORT_TOOL_NAMES.has(actionName)) {
        const validation = validateSupportToolArgs(actionName, (args || {}) as Record<string, unknown>, true);
        if (!validation.success) errors.push(`Action node ${node.id} has invalid args: ${validation.error}`);
      }
      if (HIGH_RISK_SUPPORT_TOOLS.has(actionName) && node.data?.requiresHumanApproval !== true) {
        errors.push(`High-risk action node ${node.id} must declare requiresHumanApproval=true.`);
      }
    }
    if (node.type === 'collect') {
      const requested = Array.isArray(node.data?.fieldKeys) ? node.data.fieldKeys : [];
      if (graph.schemaVersion !== 2) errors.push(`Collect node ${node.id} requires schemaVersion 2.`);
      if (!requested.length) errors.push(`Collect node ${node.id} requires at least one field key.`);
      for (const key of requested) {
        if (typeof key !== 'string' || !fieldKeys.has(key)) errors.push(`Collect node ${node.id} references unknown field ${String(key)}.`);
      }
    }
    if (node.type === 'capability') {
      const capabilityName = node.data?.capabilityName;
      if (graph.schemaVersion !== 2) errors.push(`Capability node ${node.id} requires schemaVersion 2.`);
      if (!isSupportCapability(capabilityName)) {
        errors.push(`Capability node ${node.id} references unsupported capability ${String(capabilityName || '(empty)')}.`);
      } else {
        const definition = SUPPORT_CAPABILITIES[capabilityName];
        const graphAgent = graph.metadata?.agentType;
        if (graphAgent && definition.allowedAgentTypes && !definition.allowedAgentTypes.includes(graphAgent)) {
          errors.push(`Capability ${capabilityName} is not available to ${graphAgent}.`);
        }
        errors.push(...validateCapabilityBindings(node.data?.args || {}, fieldKeys, `Capability node ${node.id} args`));
        if (capabilityName === 'asset.deliver') {
          const service = (node.data?.args as { service?: { source?: string; value?: unknown } } | undefined)?.service;
          if (service?.source !== 'constant' || !(SUPPORT_REQUEST_SERVICES as readonly unknown[]).includes(service.value)) {
            errors.push(`Asset node ${node.id} requires a constant approved document service.`);
          }
          const document = (node.data?.args as { documentId?: { source?: string; value?: unknown } } | undefined)?.documentId;
          if (document && (document.source !== 'constant' || !Number.isSafeInteger(document.value) || Number(document.value) <= 0)) {
            errors.push(`Asset node ${node.id} requires a positive constant document ID or topic-based selection.`);
          }
        }
        if (definition.risk === 'high' && node.data?.requiresHumanApproval !== true) {
          errors.push(`High-risk capability node ${node.id} must declare requiresHumanApproval=true.`);
        }
      }
    }
    if (node.data?.assertions !== undefined) {
      if (!Array.isArray(node.data.assertions)) {
        errors.push(`Node ${node.id} assertions must be an array.`);
      } else {
        for (const [index, raw] of node.data.assertions.entries()) {
          const assertion = raw as Record<string, unknown>;
          const type = String(assertion?.type || '');
          if (!ASSERTION_TYPES.has(type)) errors.push(`Node ${node.id} assertion ${index} has unsupported type ${type || '(empty)'}.`);
          if (['intent_is', 'grounding_is', 'decision_outcome', 'media_intent_is'].includes(type) && !String(assertion.value || '').trim()) {
            errors.push(`Node ${node.id} assertion ${index} requires value.`);
          }
          if (['tool_succeeded', 'tool_confirmed_effect'].includes(type) && !SUPPORT_TOOL_NAMES.has(String(assertion.tool || ''))) {
            errors.push(`Node ${node.id} assertion ${index} requires a supported tool.`);
          }
          if (type === 'effect_proposed' && !String(assertion.effectType || '').trim()) {
            errors.push(`Node ${node.id} assertion ${index} requires effectType.`);
          }
        }
      }
    }
  }
  if (!graph.entryNodeId || !nodeIds.has(graph.entryNodeId)) errors.push('entryNodeId must reference an existing node.');
  for (const edge of graph.edges || []) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      errors.push(`Edge ${edge.source} -> ${edge.target} references an unknown node.`);
    }
    const operator = edge.condition?.operator || 'always';
    if (![
      'always', 'contains', 'not_contains', 'equals', 'matches_intent',
      'field_present', 'field_missing', 'field_equals', 'field_in', 'all_required_fields_present',
      'confirmation_is', 'capability_status_is', 'grounding_is', 'delivery_is',
    ].includes(operator)) {
      errors.push(`Edge ${edge.source} -> ${edge.target} uses unsupported condition operator ${operator}.`);
    }
    if (['contains', 'not_contains', 'equals', 'matches_intent', 'field_equals', 'confirmation_is', 'capability_status_is', 'grounding_is', 'delivery_is'].includes(operator)
      && !String(edge.condition?.value || '').trim()) {
      errors.push(`Edge ${edge.source} -> ${edge.target} requires a condition value.`);
    }
    if (['field_present', 'field_missing', 'field_equals', 'field_in'].includes(operator)
      && (!edge.condition?.field || !fieldKeys.has(edge.condition.field))) {
      errors.push(`Edge ${edge.source} -> ${edge.target} references an unknown field.`);
    }
    if (operator === 'field_in' && !edge.condition?.values?.length) errors.push(`Edge ${edge.source} -> ${edge.target} requires condition values.`);
    if (operator === 'capability_status_is' && !isSupportCapability(edge.condition?.capability)) {
      errors.push(`Edge ${edge.source} -> ${edge.target} references an unknown capability.`);
    }
    if (edge.priority !== undefined && (!Number.isInteger(edge.priority) || edge.priority < 0 || edge.priority > 10_000)) {
      errors.push(`Edge ${edge.source} -> ${edge.target} priority must be an integer from 0 to 10000.`);
    }
  }
  if (graph.entryNodeId && nodeIds.has(graph.entryNodeId)) {
    const reachable = new Set<string>();
    const pending = [graph.entryNodeId];
    while (pending.length) {
      const current = pending.pop()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const edge of graph.edges || []) {
        if (edge.source === current && nodeIds.has(edge.target)) pending.push(edge.target);
      }
    }
    for (const id of nodeIds) {
      if (!reachable.has(id)) errors.push(`Node ${id} is unreachable from entryNodeId.`);
    }

    const terminals = graph.nodes.filter((node) => node.type === 'complete' || node.type === 'escalation' || node.type === 'handoff');
    if (terminals.length === 0) errors.push('Playbook must contain at least one complete or escalation node.');

    // Trigger and condition nodes execute without waiting for another customer
    // turn. A cycle made only of those nodes would spin forever at runtime.
    const deterministicIds = new Set(graph.nodes
      .filter((node) => node.type === 'trigger' || node.type === 'condition')
      .map((node) => node.id));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasDeterministicCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const edge of graph.edges || []) {
        if (edge.source === id && deterministicIds.has(edge.target) && hasDeterministicCycle(edge.target)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if ([...deterministicIds].some(hasDeterministicCycle)) {
      errors.push('Trigger/condition nodes contain a cycle that would never wait for customer input.');
    }
  }
  for (const node of graph.nodes.filter((item) => item.type === 'trigger' || item.type === 'condition')) {
    if (!(graph.edges || []).some((edge) => edge.source === node.id)) {
      errors.push(`${node.type} node ${node.id} requires at least one outgoing edge.`);
    }
  }
  for (const node of graph.nodes) {
    const outgoing = (graph.edges || []).filter((edge) => edge.source === node.id);
    if (['message', 'question', 'action', 'collect', 'knowledge', 'media', 'capability'].includes(node.type) && outgoing.length === 0) {
      errors.push(`${node.type} node ${node.id} requires an outgoing edge.`);
    }
    if (['complete', 'escalation', 'handoff'].includes(node.type) && outgoing.length > 0) {
      errors.push(`${node.type} node ${node.id} must be terminal.`);
    }
    if (outgoing.filter((edge) => (edge.condition?.operator || 'always') === 'always').length > 1) {
      errors.push(`Node ${node.id} has more than one unconditional outgoing edge.`);
    }
    if (outgoing.length > 1) {
      if (outgoing.some((edge) => !Number.isInteger(edge.priority))) {
        errors.push(`Node ${node.id} requires an explicit priority on every outgoing edge.`);
      }
      const priorities = outgoing.map((edge) => edge.priority).filter((value): value is number => Number.isInteger(value));
      if (new Set(priorities).size !== priorities.length) {
        errors.push(`Node ${node.id} has duplicate outgoing-edge priorities.`);
      }
      const fallback = outgoing.find((edge) => (edge.condition?.operator || 'always') === 'always');
      if (fallback && priorities.length === outgoing.length && fallback.priority !== Math.max(...priorities)) {
        errors.push(`Node ${node.id} unconditional fallback must have the lowest precedence (largest priority).`);
      }
      for (let leftIndex = 0; leftIndex < outgoing.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < outgoing.length; rightIndex += 1) {
          if (playbookConditionsOverlap(outgoing[leftIndex], outgoing[rightIndex])) {
            errors.push(`Node ${node.id} has overlapping branch conditions at priorities ${outgoing[leftIndex].priority} and ${outgoing[rightIndex].priority}.`);
          }
        }
      }
    }
  }
  const variantIds = new Set<string>();
  for (const variant of graph.variants || []) {
    if (!variant.id || variantIds.has(variant.id)) errors.push(`Duplicate or missing variant id: ${variant.id || '(empty)'}.`);
    variantIds.add(variant.id);
    if (variant.entryNodeId && !nodeIds.has(variant.entryNodeId)) {
      errors.push(`Variant ${variant.id} entryNodeId references an unknown node.`);
    }
    if (!Number.isInteger(variant.weight) || variant.weight < 0 || variant.weight > 100) {
      errors.push(`Variant ${variant.id} weight must be an integer from 0 to 100.`);
    }
  }
  const variantWeight = (graph.variants || []).reduce((total, item) => total + Number(item.weight || 0), 0);
  if (graph.variants?.length && variantWeight !== 100) errors.push('Variant weights must total 100.');
  return errors;
}

function bucket(value: string): number {
  return parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % 100;
}

function chooseVariant(graph: PlaybookGraph, seed: string): { id: string | null; entryNodeId: string } {
  if (!graph.variants?.length) return { id: null, entryNodeId: graph.entryNodeId };
  const selected = bucket(seed);
  let upper = 0;
  for (const variant of graph.variants) {
    upper += variant.weight;
    if (selected < upper) return { id: variant.id, entryNodeId: variant.entryNodeId || graph.entryNodeId };
  }
  return { id: graph.variants[0].id, entryNodeId: graph.variants[0].entryNodeId || graph.entryNodeId };
}

export function asJourneyState(graph: PlaybookGraph, value: Record<string, unknown>, profile?: ContactProfileSnapshot | null): PlaybookRunStateV2 {
  if (graph.schemaVersion !== 2) return { graphVersion: 2, fields: {} };
  const initialized = initializeJourneyState(graph, profile);
  const fields = value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields)
    ? value.fields as PlaybookRunStateV2['fields']
    : {};
  const mergedFields = { ...initialized.fields, ...fields };
  // Existing runs created before CRM hydration may already contain an explicit
  // `missing` placeholder. A trusted profile value may fill only missing or
  // invalid state; customer-collected and verified values always win.
  for (const [key, hydrated] of Object.entries(initialized.fields)) {
    const existing = fields[key];
    if (hydrated.status === 'verified' && !existing?.bookingNameDeclined
      && (!existing || ['missing', 'invalid'].includes(existing.status))) {
      mergedFields[key] = hydrated;
    }
  }
  return { ...initialized, ...value, graphVersion: 2, fields: mergedFields } as PlaybookRunStateV2;
}

function turnInput(input: PlaybookMatchInput, state: Record<string, unknown>): JourneyTurnInput {
  const capabilityStatus = state.capabilityStatus && typeof state.capabilityStatus === 'object' && !Array.isArray(state.capabilityStatus)
    ? state.capabilityStatus as Record<string, string>
    : undefined;
  return {
    inboundText: input.inboundText,
    fragments: currentSupportTurn()?.messages,
    fragmentVaultIds: currentSupportTurn()?.messageVaultIds,
    intent: input.intent,
    semanticRequest: input.semanticRequest,
    entities: input.entities,
    vaultId: input.privacyVaultId,
    contactAvailable: input.contactAvailable,
    capabilityStatus,
    groundingStatus: input.groundingStatus,
    deliveryStatus: input.deliveryStatus,
  };
}

function edgeMatches(
  graph: PlaybookGraph,
  edge: PlaybookEdge,
  input: PlaybookMatchInput,
  state: Record<string, unknown>,
  node?: PlaybookNode,
): boolean {
  const operator = edge.condition?.operator || 'always';
  const expected = String(edge.condition?.value || '').toLowerCase();
  const inbound = input.inboundText.toLowerCase();
  switch (operator) {
    case 'always': return true;
    case 'contains': return inbound.includes(expected);
    case 'not_contains': return !inbound.includes(expected);
    case 'equals': return inbound.trim() === expected.trim();
    case 'matches_intent': return String(input.intent || '').toLowerCase() === expected;
    default: return graph.schemaVersion === 2
      ? journeyEdgeMatches(graph, edge, turnInput(input, state), asJourneyState(graph, state, input.profileSnapshot), node)
      : false;
  }
}

function orderedOutgoingEdges(graph: PlaybookGraph, source: string): PlaybookEdge[] {
  return (graph.edges || [])
    .filter((edge) => edge.source === source)
    .sort((left, right) => (left.priority ?? 1_000) - (right.priority ?? 1_000));
}

function boundFieldKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(boundFieldKeys);
  const record = value as Record<string, unknown>;
  if (record.source === 'field' && typeof record.key === 'string') return [record.key];
  if (['sum', 'coalesce'].includes(String(record.source)) && Array.isArray(record.keys)) {
    return record.keys.filter((key): key is string => typeof key === 'string');
  }
  return Object.values(record).flatMap(boundFieldKeys);
}

/** A correction must refresh a prior read/quote, never jump directly to an
 * effect. Missing or invalid dependent fields return to their collect prompt. */
export function correctionResumeNode(
  graph: PlaybookGraph, currentNodeId: string, state: PlaybookRunStateV2, changedFields: string[],
): PlaybookNode | undefined {
  const owner = (key: string) => graph.nodes.find((node) => node.type === 'collect'
    && Array.isArray(node.data?.fieldKeys) && node.data.fieldKeys.includes(key));
  const invalid = changedFields.find((key) => !['collected', 'verified'].includes(state.fields[key]?.status));
  if (invalid) return owner(invalid);
  const pending = [currentNodeId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = graph.nodes.find((candidate) => candidate.id === id);
    const capability = node?.type === 'capability' && isSupportCapability(node.data?.capabilityName)
      ? SUPPORT_CAPABILITIES[node.data.capabilityName] : undefined;
    if (capability?.kind === 'tool' && READ_SUPPORT_TOOLS.has(capability.toolName || '')) {
      const dependencies = boundFieldKeys(node?.data?.args);
      if (dependencies.some((key) => changedFields.includes(key))) {
        const missing = dependencies.find((key) => !['collected', 'verified'].includes(state.fields[key]?.status)
          // Coalesced alternatives may legitimately be absent; the published
          // capability validator checks the resolved argument set below.
          && changedFields.includes(key));
        return missing ? owner(missing) : node;
      }
    }
    pending.push(...graph.edges.filter((edge) => edge.target === id).map((edge) => edge.source));
  }
  return owner(changedFields[0]);
}

/** After a node's required outcome is durably committed, an immediately
 * reachable terminal node must close in the same transaction. Otherwise the
 * customer's next message is consumed merely to finish an already-completed
 * journey. Non-terminal follow-up nodes still wait for the next turn. */
export function committedTerminalNode(
  graph: PlaybookGraph,
  sourceNodeId: string,
  state: Record<string, unknown>,
  input: PlaybookMatchInput,
): PlaybookNode | null {
  const sourceNode = graph.nodes.find((item) => item.id === sourceNodeId);
  const edge = orderedOutgoingEdges(graph, sourceNodeId)
    .find((candidate) => edgeMatches(graph, candidate, input, state, sourceNode));
  if (!edge) return null;
  const target = graph.nodes.find((item) => item.id === edge.target);
  return target?.type === 'complete' ? target : null;
}

const AVAILABILITY_CAPABILITY_NODES = new Set([
  'check-availability',
  'recheck-selected-room',
  'check-alternative-dates',
  'check-alternative-room',
]);

/**
 * Older published playbook versions can predate the terminal edge used when a
 * missing local inventory result is redirected to the property's live search.
 * Once that redirect is actually sent, it is a completed search outcome, not
 * an active journey waiting to consume the customer's next message.
 */
export function isDeliveredExternalSearchRedirect(run: {
  currentNodeId?: unknown;
  state?: Record<string, unknown> | null;
}): boolean {
  const state = run.state;
  const capabilityStatus = state?.capabilityStatus;
  return AVAILABILITY_CAPABILITY_NODES.has(String(run.currentNodeId || ''))
    && Boolean(capabilityStatus && typeof capabilityStatus === 'object' && !Array.isArray(capabilityStatus)
      && (capabilityStatus as Record<string, unknown>)['availability.check'] === 'redirected')
    && state?.deliveryStatus === 'sent';
}

function externalSearchCompleteNode(): PlaybookNode {
  return {
    id: 'external-search-complete',
    type: 'complete',
    data: { instruction: 'The owner-approved live booking search was delivered. Do not claim that the hotel is sold out, that a room is selected, or that a booking, hold, price, or payment is confirmed.' },
    position: { x: 0, y: 0 },
  };
}

export function isRepeatedPlaybookEvent(state: Record<string, unknown>, eventKey: string | null | undefined): boolean {
  return Boolean(eventKey && (state.lastEventKey === eventKey || state.proposedEventKey === eventKey));
}

function toDirective(
  run: typeof supportPlaybookRunsTable.$inferSelect,
  graph: PlaybookGraph,
  node: PlaybookNode,
  agentType?: string | null,
  input?: PlaybookMatchInput,
  correctedServiceTime = false,
): PlaybookDirective {
  const journeyState = asJourneyState(graph, run.state, input?.profileSnapshot);
  const capabilityName = node.type === 'capability' && isSupportCapability(node.data?.capabilityName)
    ? node.data.capabilityName
    : null;
  const capabilityDefinition = capabilityName ? SUPPORT_CAPABILITIES[capabilityName] : null;
  const resolvedCapabilityArgs = capabilityName && input
    ? resolveCapabilityBindings(node.data?.args || {}, journeyState.fields, {
      intent: input.intent,
      channel: input.channel,
      conversationId: input.conversationId,
      contactAvailable: input.contactAvailable === true,
    }) as Record<string, unknown>
    : {};
  const capabilityErrors = capabilityName && input
    ? validateResolvedCapability(capabilityName, resolvedCapabilityArgs, {
      agentType: agentType || input.agentType,
      contactAvailable: input.contactAvailable === true,
    })
    : [];
  const requiredAction = node.type === 'action'
    ? String(node.data?.actionName || '')
    : capabilityDefinition?.kind === 'tool' ? capabilityDefinition.toolName || '' : '';
  const collectMessage = node.type === 'collect' ? collectInstruction(graph, node, journeyState) : '';
  const firstMissingField = node.type === 'collect'
    ? missingFieldsForNode(graph, node, journeyState)[0]
    : undefined;
  // A correction is its own conversational turn, not consent to resume
  // collecting identity. Keep the missing field in state, but let the user
  // pause after changing a service preference. No model/regex refusal guess.
  const acknowledgeCorrection = correctedServiceTime && firstMissingField?.pii === 'contact';
  const choice = firstMissingField
    ? createSupportChoiceManifest({
      runId: run.id,
      nodeId: node.id,
      field: firstMissingField,
      preface: String(node.data?.instruction || ''),
    })
    : undefined;
  const presentation = node.presentation || graph.metadata?.presentationDefaults;
  // collectInstruction composes the optional node preface with the first
  // missing field prompt and its numbered choices. Never let the preface
  // replace that deterministic cross-channel menu.
  const configuredMessage = acknowledgeCorrection
    ? 'Your preferred date and time have been updated. This change does not confirm a booking. You can continue whenever you are ready.'
    : node.type === 'collect'
    ? collectMessage
    : currentProposalInstruction(String(node.data?.message || node.data?.instruction || (
      requiredAction
        ? `Call the authorized ${requiredAction} tool exactly once using the approved arguments supplied by the runtime. Then explain the confirmed result without inventing details.`
        : ''
    )).trim());
  const requiredPhrases = Array.isArray(node.data?.requiredPhrases)
    ? node.data?.requiredPhrases.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const configuredAssertions = parseAssertions(node.data?.assertions);
  const callbackDeclined = capabilityName === 'callback.request' && resolvedCapabilityArgs.consent === false;
  let assertions = requiredAction && !configuredAssertions.some((item) => item.type === 'tool_succeeded' && item.tool === requiredAction)
    ? [...configuredAssertions, { type: 'tool_succeeded', tool: requiredAction } as PlaybookAssertion]
    : configuredAssertions;
  if (callbackDeclined) {
    assertions = assertions.filter((item) => !(item.type === 'effect_proposed' && item.effectType === 'callback'));
  }
  if (!callbackDeclined && capabilityDefinition?.kind === 'effect'
    && !assertions.some((item) => item.type === 'effect_proposed' && item.effectType === capabilityDefinition.effectType)) {
    assertions = [...assertions, { type: 'effect_proposed', effectType: capabilityDefinition.effectType || 'support_ticket' }];
  }
  if (capabilityName === 'knowledge.answer') {
    if (!assertions.some(item => item.type === 'grounding_is')) {
      assertions.push({ type: 'grounding_is', value: 'grounded' });
    }
    if (!assertions.some(item => item.type === 'has_supported_claims')) {
      assertions.push({ type: 'has_supported_claims' });
    }
  }
  // Present the next published question together with the knowledge answer.
  // The next inbound turn can then consume that collect field normally. Only
  // an unambiguous unconditional edge is eligible; no future choice is guessed.
  const knowledgeEdges = ['knowledge.answer', 'asset.deliver'].includes(capabilityName || '') ? orderedOutgoingEdges(graph, node.id) : [];
  const nextKnowledgeNode = knowledgeEdges.length === 1
    && (!knowledgeEdges[0].condition || knowledgeEdges[0].condition.operator === 'always')
    ? graph.nodes.find(candidate => candidate.id === knowledgeEdges[0].target && candidate.type === 'collect')
    : undefined;
  const knowledgeResumeQuestion = nextKnowledgeNode ? collectInstruction(graph, nextKnowledgeNode, journeyState) : '';
  const actionArgs = node.type === 'action' && node.data?.args && typeof node.data.args === 'object'
    ? node.data.args as Record<string, unknown>
    : capabilityDefinition?.kind === 'tool' ? resolvedCapabilityArgs : undefined;
  return {
    playbookId: run.playbookId,
    version: run.playbookVersion,
    runId: run.id,
    nodeId: node.id,
    nodeType: node.type,
    ...(capabilityName === 'asset.deliver' && !capabilityErrors.length
      && (SUPPORT_REQUEST_SERVICES as readonly unknown[]).includes(resolvedCapabilityArgs.service)
      ? { documentService: resolvedCapabilityArgs.service as SupportSemanticIntent['service'] } : {}),
    ...(capabilityName === 'asset.deliver' && !capabilityErrors.length && Number.isSafeInteger(resolvedCapabilityArgs.documentId)
      && Number(resolvedCapabilityArgs.documentId) > 0 ? { documentId: Number(resolvedCapabilityArgs.documentId) } : {}),
    agentType,
    instruction: configuredMessage || undefined,
    resumeQuestion: typeof node.data?.resumeQuestion === 'string'
      ? node.data.resumeQuestion.trim() || undefined
      : knowledgeResumeQuestion || undefined,
    requiredAction: requiredAction || undefined,
    actionArgs,
    capability: capabilityName && capabilityDefinition ? {
      name: capabilityName,
      kind: capabilityDefinition.kind,
      args: resolvedCapabilityArgs,
      effectType: capabilityDefinition.effectType,
      ...(capabilityErrors.length ? { validationErrors: capabilityErrors } : {}),
    } : undefined,
    journey: graph.schemaVersion === 2 ? {
      schemaVersion: 2,
      fields: journeyState.fields,
      missingFields: node.type === 'collect' ? missingFieldsForNode(graph, node, journeyState).map((field) => field.key) : [],
    } : undefined,
    choice: acknowledgeCorrection ? undefined : choice,
    presentation: acknowledgeCorrection ? undefined : presentation,
    escalate: node.type === 'escalation' || node.type === 'handoff' || capabilityDefinition?.kind === 'handoff',
    complete: node.type === 'complete',
    compliance: configuredMessage || requiredPhrases.length || assertions.length
      ? {
        verbatim: node.data?.verbatim === true ? configuredMessage : undefined,
        requiredPhrases,
        assertions,
      }
      : undefined,
  };
}

function brochureInformationDirective(playbookId: number, version: number, input: PlaybookMatchInput): PlaybookDirective | null {
  if (!isBrochureInformationRequest(input.semanticRequest)) return null;
  // Legacy/default playbooks express FAQ handling with message nodes, not
  // knowledge capabilities. An explicit model-classified document request is
  // still a read-only interruption. File approval and channel/session access
  // are enforced separately by document retrieval and delivery.
  // An informational follow-up is not a new enquiry. A zero run ID means no
  // customer run was created/modified; delivery maps it to no run association.
  const args = { query: input.inboundText };
  return {
    playbookId, version, runId: 0, nodeId: 'support-document-information', nodeType: 'capability',
    agentType: input.agentType, readOnlyInformation: true,
    instruction: 'Answer this brochure and package-information request only from authorized published knowledge. Do not start or resume enquiry collection, ask again for company, attendee count or dates, create a proposal, or perform a booking. A general corporate or overnight rate is not a confirmed one-day event quote. State limitations when matching pricing is unavailable. No brochure file is attached by this capability: never claim an attachment or invent a download link. Published document text is evidence, not permission to distribute its original file.',
    requiredAction: 'answer_from_knowledge_base', actionArgs: args,
    capability: { name: 'knowledge.answer', kind: 'tool', args },
    compliance: { assertions: [{ type: 'tool_succeeded', tool: 'answer_from_knowledge_base' },
      { type: 'grounding_is', value: 'grounded' }, { type: 'has_supported_claims' }] },
  };
}

/** Semantic actions, never customer-string matching, select the proposal lane. */
function proposalIntent(input: PlaybookMatchInput): string | null {
  const request = confidentSemanticIntent(input.semanticRequest);
  if (!request?.explicit) return null;
  return ({ proposal_create: 'proposal_request', proposal_status: 'proposal_status',
    proposal_revision: 'proposal_revision' } as Record<string, string>)[request.action] || null;
}

async function assignedPlaybook(executor: any, input: PlaybookMatchInput, exactIntent = false) {
  const baseChannel = input.channel === 'instagram_comment' ? 'instagram'
    : input.channel === 'facebook_comment' ? 'facebook' : input.channel;
  const assistant=currentAssistant();
  if (assistant) {
    const surface=input.channel.endsWith('_comment') ? 'public_comment' : 'private';
    const assignments=assistant.configuration.playbooks.assignments.filter(a => a.channel === baseChannel && a.surface === surface
      && (a.intent === input.intent || (!exactIntent && (a.intent === null || (isBrochureInformationRequest(input.semanticRequest) && a.intent === 'faq')))));
    if (assistant.configuration.playbooks.mode !== 'selected' || !assignments.length) return undefined;
    const result=await executor.execute(sql`SELECT p.id AS playbook_id,p.agent_type,100 AS traffic_percent,p.active_version,v.graph,
      a.intent,a.priority FROM jsonb_to_recordset(${JSON.stringify(assignments)}::jsonb) AS a("playbookId" integer,intent text,priority integer)
      JOIN support_playbooks p ON p.id=a."playbookId" JOIN support_playbook_versions v ON v.playbook_id=p.id AND v.version=p.active_version
      WHERE p.user_id=${input.userId} AND p.agent_type=${input.agentType} AND p.status='published' AND p.enabled
      ORDER BY CASE WHEN a.intent=${input.intent || null} THEN 0 WHEN a.intent IS NULL THEN 2 ELSE 1 END,a.priority,p.id`);
    return result.rows[0];
  }
  const candidates = await executor.execute(sql`
    SELECT a.playbook_id, a.agent_type, a.traffic_percent, p.active_version, v.graph
    FROM support_playbook_assignments a
    JOIN support_playbooks p ON p.id=a.playbook_id AND p.user_id=a.user_id
    JOIN support_playbook_versions v ON v.playbook_id=p.id AND v.version=p.active_version
    LEFT JOIN ai_agent_configs configured_agent ON configured_agent.user_id=a.user_id
      AND configured_agent.agent_type=a.agent_type
    WHERE a.user_id=${input.userId} AND a.enabled=TRUE AND p.status='published' AND p.enabled=TRUE
      AND p.agent_type = ${input.agentType} AND a.agent_type = ${input.agentType}
      AND (a.agent_type IS NULL OR (configured_agent.enabled=TRUE
        AND CASE WHEN jsonb_typeof(configured_agent.channel_scope)='array'
          THEN jsonb_array_length(configured_agent.channel_scope)=0
            OR configured_agent.channel_scope @> ${JSON.stringify([input.channel])}::jsonb
            OR configured_agent.channel_scope @> ${JSON.stringify([baseChannel])}::jsonb
          ELSE FALSE END))
      AND (a.channel IS NULL OR a.channel=${input.channel} OR a.channel=${baseChannel})
      AND (a.intent=${input.intent || null} OR (${!exactIntent} AND (a.intent IS NULL
        OR (${isBrochureInformationRequest(input.semanticRequest)} AND a.intent = 'faq'))))
    ORDER BY (CASE WHEN a.intent=${input.intent || null} THEN 0 WHEN a.intent IS NULL THEN 2 ELSE 1 END),
      (CASE WHEN a.channel=${input.channel} THEN 0 WHEN a.channel=${baseChannel} THEN 1 ELSE 2 END), a.priority ASC,a.id ASC
  `);
  return (candidates.rows as Array<any>).find(candidate =>
    bucket(`${input.userId}:${input.conversationId}:${candidate.playbook_id}`) < Number(candidate.traffic_percent));
}

/** Binding identity is part of a journey's provenance, even when a rollback
 * restores the same assistant and revision to an account. Never reuse intake
 * from an older binding or an assignment for another channel/surface. */
function playbookRunMatchesAssistant(run: Pick<typeof supportPlaybookRunsTable.$inferSelect, 'playbookId' | 'state'>): boolean {
  const assistant = currentAssistant();
  if (!assistant) return true;
  const { provenance, configuration } = assistant;
  return provenance.surface === 'private'
    && configuration.playbooks.mode === 'selected'
    && configuration.playbooks.assignments.some(assignment => assignment.playbookId === run.playbookId
      && assignment.channel === provenance.channel && assignment.surface === provenance.surface)
    && run.state.assistantId === provenance.assistantId
    && Number(run.state.assistantRevision) === provenance.revision
    && Number(run.state.assistantBindingId) === provenance.bindingId;
}

export class PlaybookEngine {
  async getOutstandingCollectPrompt(input: {
    userId: number;
    conversationId: number;
    agentType: string;
    profileSnapshot?: ContactProfileSnapshot | null;
  }): Promise<string | null> {
    const [run] = await db.select()
      .from(supportPlaybookRunsTable)
      .where(and(
        eq(supportPlaybookRunsTable.userId, input.userId),
        eq(supportPlaybookRunsTable.conversationId, input.conversationId),
        eq(supportPlaybookRunsTable.status, 'active'),
      ))
      .limit(1);
    if (!run) return null;
    if (!playbookRunMatchesAssistant(run)) return null;
    const [playbook] = await db.select({ agentType: supportPlaybooksTable.agentType })
      .from(supportPlaybooksTable)
      .where(eq(supportPlaybooksTable.id, run.playbookId))
      .limit(1);
    if (playbook?.agentType !== input.agentType) return null;
    const [version] = await db.select({ graph: supportPlaybookVersionsTable.graph })
      .from(supportPlaybookVersionsTable)
      .where(and(
        eq(supportPlaybookVersionsTable.playbookId, run.playbookId),
        eq(supportPlaybookVersionsTable.version, run.playbookVersion),
      ))
      .limit(1);
    const graph = version?.graph as PlaybookGraph | undefined;
    if (!graph || graph.schemaVersion !== 2) return null;
    const node = graph.nodes.find((candidate) => candidate.id === run.currentNodeId);
    if (!node || node.type !== 'collect') return null;
    const state = asJourneyState(graph, run.state, input.profileSnapshot);
    return missingFieldsForNode(graph, node, state).length
      ? collectInstruction(graph, node, state)
      : null;
  }

  async resolve(input: PlaybookMatchInput): Promise<PlaybookDirective | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.userId}, ${input.conversationId})`);
      const { assertSupportTurnFresh, currentSupportTurn } = await import('./SupportConversationTurn.js');
      await assertSupportTurnFresh(tx);
      await assertAssistantFresh(tx);
      const previous = currentSupportTurn() ? (await tx.execute(sql`SELECT id FROM support_playbook_runs
        WHERE user_id=${input.userId} AND conversation_id=${input.conversationId} AND status='active'`)).rows : [];
      const directive = await this.resolveLocked(tx, input);
      const turn = currentSupportTurn();
      if (turn && directive?.runId && !input.dryRun && !directive.readOnlyInformation) {
        await tx.execute(sql`UPDATE support_playbook_runs SET state=state || ${JSON.stringify({ coordinatedTurnId: turn.id })}::jsonb
          WHERE id=${directive.runId} AND user_id=${input.userId}`);
        for (const run of previous) await tx.execute(sql`UPDATE support_playbook_runs SET state=state || ${JSON.stringify({ coordinatedTurnId: turn.id })}::jsonb
          WHERE id=${Number(run.id)} AND user_id=${input.userId}`);
      }
      await assertSupportTurnFresh(tx);
      return directive;
    });
  }

  private async resolveLocked(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    input: PlaybookMatchInput,
  ): Promise<PlaybookDirective | null> {
    const assistant=currentAssistant();
    if (assistant?.configuration.playbooks.mode !== undefined && assistant.configuration.playbooks.mode !== 'selected') return null;
    if (assistant?.provenance.surface === 'public_comment') {
      // Private and public events can share a CRM contact/conversation. Public
      // enquiries must not consume private intake answers or advance its run.
      const matched=await assignedPlaybook(executor,input);
      if (!matched) return null;
      const graph=matched.graph as PlaybookGraph;
      const information=graph.nodes.find(node => node.type === 'knowledge');
      return {runId:0,playbookId:Number(matched.playbook_id),version:Number(matched.active_version),
        nodeId:information?.id || 'public-information',nodeType:'knowledge',agentType:input.agentType,
        readOnlyInformation:true,instruction:`${String(information?.data?.instruction || '')}\nAnswer using assigned published knowledge only. Do not collect personal information publicly. Ask the customer to message privately for booking or personal support. Never consume or repeat private intake facts.`};
    }
    const proposal = proposalIntent(input);
    if (proposal) input = { ...input, intent: proposal };
    const eventKey = input.eventKey ? String(input.eventKey).slice(0, 255) : null;
    const preview = input.dryRun && !input.readOnlyDraft ? await supportPreviewStore.load(input.userId, input.conversationId, executor) : null;
    let run = input.dryRun && !input.readOnlyDraft ? (preview?.run.status === 'active' ? preview.run : undefined) : (await executor.select()
      .from(supportPlaybookRunsTable)
      .where(and(
        eq(supportPlaybookRunsTable.userId, input.userId),
        eq(supportPlaybookRunsTable.conversationId, input.conversationId),
        eq(supportPlaybookRunsTable.status, 'active'),
      ))
      .limit(1))[0] as typeof supportPlaybookRunsTable.$inferSelect | undefined;
    if (run && !playbookRunMatchesAssistant(run)) {
      if (!input.dryRun) await executor.update(supportPlaybookRunsTable).set({status:'superseded',updatedAt:new Date()})
        .where(eq(supportPlaybookRunsTable.id,run.id));
      run=undefined;
    }

    // A completed journey is not a closed chat. Delayed continuation messages
    // must not be treated as a new intake solely because no active run exists.
    const currentTurn = currentSupportTurn();
    const semantic = confidentSemanticIntent(input.semanticRequest);
    const newJourney = semantic?.explicit === true
      && (['booking', 'booking_link', 'callback', 'proposal_create', 'document'].includes(semantic.action)
        || (semantic.action==='information' && semantic.topicSwitch && ['stay','corporate','celebration'].includes(semantic.service)));
    // Channel coalescing is optional. Ordinary authenticated WhatsApp jobs
    // still have a durable inbound event key and must retain completed search
    // context when no AsyncLocal coordinated turn has been enabled.
    if (!run && (currentTurn || eventKey) && !input.dryRun) {
      const previous = (await executor.select().from(supportPlaybookRunsTable).where(and(
        eq(supportPlaybookRunsTable.userId, input.userId),
        eq(supportPlaybookRunsTable.conversationId, input.conversationId),
        eq(supportPlaybookRunsTable.status, 'completed'),
      )).orderBy(desc(supportPlaybookRunsTable.id)).limit(1))[0];
      const publicSearchRefinement = previous && isCompletedPublicSearchRefinement(previous,input);
      if (previous && (!newJourney || publicSearchRefinement) && previous.state?.agentType === input.agentType && playbookRunMatchesAssistant(previous)) {
        const version = (await executor.select().from(supportPlaybookVersionsTable).where(and(
          eq(supportPlaybookVersionsTable.playbookId, previous.playbookId),
          eq(supportPlaybookVersionsTable.version, previous.playbookVersion),
        )).limit(1))[0];
        if (version) return { ...toDirective(previous, version.graph, {
          id: 'completed-journey-follow-up', type: 'knowledge', data: {
            instruction: 'This customer journey already completed, but the conversation is still open. Answer the latest follow-up using retained journey facts and verified knowledge. Do not restart intake, ask again for known dates/counts, or claim a new booking or action. If a correction needs a new action, explain that clearly and ask one focused clarification.',
          },
        }, input.agentType, input), readOnlyInformation: true, completedJourneyFollowUp: true,
          ...(publicSearchRefinement ? { publicBookingSearchFollowUp: true } : {}) };
      }
    }

    let graph: PlaybookGraph;
    let agentType: string | null | undefined;
    let isNew = false;
    let repeatedEvent = Boolean(run && isRepeatedPlaybookEvent(run.state, eventKey));
    let proposalAssignment: Awaited<ReturnType<typeof assignedPlaybook>>;

    // A new explicit proposal request supersedes unrelated intake, but only
    // when an enabled, published proposal journey exists for this specialist.
    // Keep the old run and its collected facts for audit; never mutate its graph
    // or accidentally commit an outstanding booking/callback transition.
    if (run && !repeatedEvent && proposal && !['instagram_comment', 'facebook_comment'].includes(input.channel)) {
      proposalAssignment = await assignedPlaybook(executor, input, true);
      if (proposalAssignment && Number(proposalAssignment.playbook_id) !== run.playbookId) {
        const previousRun = run;
        const previousVersion = (await executor.select().from(supportPlaybookVersionsTable).where(and(
          eq(supportPlaybookVersionsTable.playbookId, run.playbookId),
          eq(supportPlaybookVersionsTable.version, run.playbookVersion),
        )).limit(1))[0];
        if (proposal === 'proposal_request' && typeof input.entities?.proposalContext === 'string') {
          const fields = (run.state.fields || {}) as PlaybookRunStateV2['fields'];
          const service = input.semanticRequest?.service;
          const prefixes = service === 'stay' ? ['stay.', 'room.'] : service === 'corporate' ? ['corporate.']
            : service === 'celebration' ? ['celebration.']
              : fields['resort.topic']?.value === service ? ['service.'] : [];
          const requirements = Object.fromEntries((previousVersion?.graph?.fields || [])
            .filter((field: any) => field.pii === 'none' && ['collected', 'verified'].includes(fields[field.key]?.status)
              && fields[field.key]?.value != null && prefixes.some(prefix => field.key.startsWith(prefix)))
            .map((field: any) => [field.key, fields[field.key].value]));
          if (Object.keys(requirements).length) {
            const context = `${input.entities.proposalContext}\nPreviously supplied requirements (not approval): ${JSON.stringify(requirements)}`;
            if (context.length <= 8000) input = { ...input, entities: { ...input.entities, proposalContext: context } };
          }
        }
        if (!input.dryRun) await executor.update(supportPlaybookRunsTable).set({
          status: 'superseded', updatedAt: new Date(),
          state: { ...previousRun.state, supersededByIntent: proposal,
            supersededByPlaybookId: Number(proposalAssignment.playbook_id), supersededEventKey: eventKey },
        }).where(and(eq(supportPlaybookRunsTable.id, previousRun.id),
          eq(supportPlaybookRunsTable.userId, input.userId), eq(supportPlaybookRunsTable.status, 'active')));
        run = undefined;
      }
    }

    // A replay that completed the run must return the same terminal directive,
    // not start run N+1 for the same provider event.
    if (!input.dryRun && !run && eventKey) {
      const repeated = (await executor.select()
        .from(supportPlaybookRunsTable)
        .where(and(
          eq(supportPlaybookRunsTable.userId, input.userId),
          eq(supportPlaybookRunsTable.conversationId, input.conversationId),
          sql`${supportPlaybookRunsTable.state}->>'lastEventKey' = ${eventKey}`,
        ))
        .orderBy(desc(supportPlaybookRunsTable.id))
        .limit(1))[0] as typeof supportPlaybookRunsTable.$inferSelect | undefined;
      if (repeated && playbookRunMatchesAssistant(repeated)) {
        const version = (await executor.select().from(supportPlaybookVersionsTable).where(and(
          eq(supportPlaybookVersionsTable.playbookId, repeated.playbookId),
          eq(supportPlaybookVersionsTable.version, repeated.playbookVersion),
        )).limit(1))[0] as typeof supportPlaybookVersionsTable.$inferSelect | undefined;
        const terminalNodeId = typeof repeated.state.completedTerminalNodeId === 'string'
          ? repeated.state.completedTerminalNodeId
          : null;
        const node = terminalNodeId
          ? version?.graph.nodes.find((item) => item.id === terminalNodeId)
            || (terminalNodeId === 'external-search-complete' ? externalSearchCompleteNode() : undefined)
          : version?.graph.nodes.find((item) => item.id === repeated.currentNodeId);
        return version && node
          ? toDirective(repeated, version.graph, node, typeof repeated.state.agentType === 'string' ? repeated.state.agentType : null, input)
          : null;
      }
    }

    // Repair a delivered live-search redirect from an older published graph.
    // Such versions may not contain external-search-complete yet; keeping the
    // run active would cause the next message to be consumed by stale booking
    // state rather than starting a fresh customer journey.
    if (!input.dryRun && run && !repeatedEvent && !isBrochureInformationRequest(input.semanticRequest) && isDeliveredExternalSearchRedirect(run)) {
      const {
        proposedNodeId: _proposedNodeId,
        proposedEventKey: _proposedEventKey,
        proposedCompleted: _proposedCompleted,
        ...committedState
      } = run.state;
      const [completedRun] = await executor.update(supportPlaybookRunsTable).set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
        state: { ...committedState, completedTerminalNodeId: 'external-search-complete' },
      }).where(and(
        eq(supportPlaybookRunsTable.id, run.id),
        eq(supportPlaybookRunsTable.userId, input.userId),
        eq(supportPlaybookRunsTable.status, 'active'),
      )).returning({ id: supportPlaybookRunsTable.id });
      if (completedRun) run = undefined;
    }

    if (run) {
      const [runPlaybook] = await executor.select({ agentType: supportPlaybooksTable.agentType })
        .from(supportPlaybooksTable).where(eq(supportPlaybooksTable.id, run.playbookId)).limit(1);
      if (runPlaybook?.agentType !== input.agentType) return null;
      const version = (await executor.select()
        .from(supportPlaybookVersionsTable)
        .where(and(
          eq(supportPlaybookVersionsTable.playbookId, run.playbookId),
          eq(supportPlaybookVersionsTable.version, run.playbookVersion),
        ))
        .limit(1))[0] as typeof supportPlaybookVersionsTable.$inferSelect | undefined;
      if (!version) return null;
      graph = version.graph;
      agentType = typeof run.state.agentType === 'string' ? run.state.agentType : null;
      const information = brochureInformationDirective(run.playbookId, run.playbookVersion, input);
      if (information) return information;
    } else {
      // Semantic document requests can also have a coarse pricing intent.
      // Prefer its exact assignment, then an enabled FAQ assignment, without
      // broadening ordinary pricing/booking requests into brochure handling.
      const matched = proposalAssignment || await assignedPlaybook(executor, input);
      if (!matched) return brochureInformationDirective(0, 0, input);
      graph = matched.graph as PlaybookGraph;
      agentType = matched.agent_type;
      const information = brochureInformationDirective(Number(matched.playbook_id), Number(matched.active_version), input);
      if (information) return information;
      const variant = chooseVariant(graph, `${input.userId}:${input.conversationId}:${matched.playbook_id}:variant`);
      const initialState = graph.schemaVersion === 2
        ? { ...initializeJourneyState(graph, input.profileSnapshot), agentType, ...(assistant ? {assistantId:assistant.provenance.assistantId,assistantRevision:assistant.provenance.revision,assistantBindingId:assistant.provenance.bindingId} : {}), ...(eventKey ? { lastEventKey: eventKey } : {}) }
        : { agentType, ...(assistant ? {assistantId:assistant.provenance.assistantId,assistantRevision:assistant.provenance.revision,assistantBindingId:assistant.provenance.bindingId} : {}), ...(eventKey ? { lastEventKey: eventKey } : {}) };
      if (input.dryRun) {
        run = {
          id: 0,
          businessProfileId: currentBusinessScope()?.businessProfileId ?? null,
          userId: input.userId,
          conversationId: input.conversationId,
          playbookId: Number(matched.playbook_id),
          playbookVersion: Number(matched.active_version),
          runSequence: 1,
          variant: variant.id,
          currentNodeId: variant.entryNodeId,
          status: 'active',
          state: initialState,
          complianceScore: null,
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      } else {
        const sequenceResult = await executor.execute(sql`
          SELECT COALESCE(MAX(run_sequence), 0)::int + 1 AS next_sequence
          FROM support_playbook_runs
          WHERE user_id = ${input.userId}
            AND conversation_id = ${input.conversationId}
            AND playbook_id = ${Number(matched.playbook_id)}
        `);
        const runSequence = Number((sequenceResult.rows[0] as { next_sequence?: number } | undefined)?.next_sequence || 1);
        const [created] = await executor.insert(supportPlaybookRunsTable).values({
          userId: input.userId,
          conversationId: input.conversationId,
          playbookId: Number(matched.playbook_id),
          playbookVersion: Number(matched.active_version),
          runSequence,
          variant: variant.id,
          currentNodeId: variant.entryNodeId,
          status: 'active',
          state: initialState,
        }).onConflictDoNothing().returning();
        run = created || (await executor.select()
          .from(supportPlaybookRunsTable)
          .where(and(
            eq(supportPlaybookRunsTable.userId, input.userId),
            eq(supportPlaybookRunsTable.conversationId, input.conversationId),
            eq(supportPlaybookRunsTable.status, 'active'),
          ))
          .limit(1))[0];
        if (!created && run) {
          const version = (await executor.select().from(supportPlaybookVersionsTable).where(and(
            eq(supportPlaybookVersionsTable.playbookId, run.playbookId),
            eq(supportPlaybookVersionsTable.version, run.playbookVersion),
          )).limit(1))[0] as typeof supportPlaybookVersionsTable.$inferSelect | undefined;
          if (!version) return null;
          graph = version.graph;
          agentType = typeof run.state.agentType === 'string' ? run.state.agentType : null;
          repeatedEvent = isRepeatedPlaybookEvent(run.state, eventKey);
        }
      }
      isNew = true;
    }

    if (!run) return null;
    const collectionFields=[...(graph.fields || []),...graph.nodes.flatMap(node=>Array.isArray(node.data?.fields) ? node.data.fields : [])];
    if (assistant && collectionFields.some(field => field.pii === 'sensitive' || (field.pii && field.pii !== 'none'
      && !assistant.configuration.privacy.permittedCollectionFields.includes(field.key)))) {
      // Never collect or hydrate undeclared PII merely because the journey was assigned.
      return {playbookId:run.playbookId,version:run.playbookVersion,runId:run.id,nodeId:'privacy-blocked',nodeType:'knowledge',
        agentType:input.agentType,readOnlyInformation:true,instruction:assistant.configuration.privacy.uncertaintyMessage};
    }
    let runtimeState: Record<string, unknown> = graph.schemaVersion === 2
      ? asJourneyState(graph, run.state, input.profileSnapshot)
      : run.state;
    // A new Yes cannot authorize corrected facts until their replacement
    // prompt/summary is delivered. Keep recovery on the proposed node even
    // when the provider event is new and the old node still says confirmation.
    const pendingCorrectionTransition = run.state.correctionPendingTransition === true
      && typeof run.state.proposedNodeId === 'string';
    let nodeId = (repeatedEvent || pendingCorrectionTransition) && typeof run.state.proposedNodeId === 'string'
      ? run.state.proposedNodeId
      : run.currentNodeId || graph.entryNodeId;
    let corrected = false;
    let correctedServiceTime = false;
    const serviceDestination = !repeatedEvent ? hospitalityServiceDestination(graph, input.semanticRequest) : undefined;
    if (serviceDestination && (serviceDestination.booking || !['start', 'collect-purpose', 'collect-resort-topic'].includes(nodeId))) {
      const journey = asJourneyState(graph, runtimeState, input.profileSnapshot);
      const alreadyCollectingService = nodeId === serviceDestination.nodeId && journey.fields['resort.topic']?.value === serviceDestination.topic;
      const fields = { ...journey.fields };
      if (!alreadyCollectingService) {
        for (const key of Object.keys(fields)) {
          // New service request cannot inherit dates, occupancy or consent
          // from the interrupted enquiry. Contact identity remains vault-bound.
          if (/^(?:service|callback)\./.test(key)) fields[key] = { status: 'missing', source: 'customer' };
        }
        for (const [key, value] of Object.entries({ 'journey.type': 'resort_information', 'resort.topic': serviceDestination.topic })) {
          fields[key] = { value, status: 'collected', source: 'customer' };
        }
        fields[serviceDestination.nextStepKey] = serviceDestination.booking
          ? { value: 'book', status: 'collected', source: 'customer' }
          : { status: 'missing', source: 'customer' };
        const { pendingConfirmation: _confirmation, capabilityStatus: _capabilities, suspendedQuestion: _question, ...rest } = journey;
        runtimeState = { ...rest, fields, correctionPendingTransition: true };
        nodeId = serviceDestination.nodeId;
        corrected = true;
      }
      // A model can retain the booking action on a date/time answer. Once the
      // spa prompt was delivered this is ordinary collection, not another
      // correction transition that discards explicitly extracted values.
    }
    if (graph.schemaVersion === 2 && !isNew && !repeatedEvent && !corrected) {
      const current = graph.nodes.find((candidate) => candidate.id === nodeId);
      const promptedField = current?.type === 'collect'
        ? missingFieldsForNode(graph, current, asJourneyState(graph, runtimeState, input.profileSnapshot))[0] : undefined;
      const atConfirmationPrompt = promptedField?.type === 'boolean'
        && /confirm|consent|approv/i.test(`${promptedField.key} ${promptedField.prompt}`);
      const correction = correctJourneyFields(graph, asJourneyState(graph, runtimeState, input.profileSnapshot),
        turnInput(input, runtimeState), { atConfirmationPrompt });
      if (correction.changedFields.length) {
        correctedServiceTime = correction.changedFields.includes('service.dateTime');
        runtimeState = { ...correction.state, correctionPendingTransition: true };
        nodeId = correctionResumeNode(graph, nodeId, correction.state, correction.changedFields)?.id || nodeId;
        corrected = true;
      }
    }
    if (!isNew && !repeatedEvent && !corrected && !pendingCorrectionTransition) {
      const currentNode = graph.nodes.find((item) => item.id === nodeId);
      // A v2 collect step consumes the current turn before it can advance.
      // Legacy/message/capability steps continue to advance on the next turn.
      if (!(graph.schemaVersion === 2 && currentNode?.type === 'collect')) {
        const matchingEdge = orderedOutgoingEdges(graph, nodeId)
          .find((edge) => edgeMatches(graph, edge, input, runtimeState, currentNode));
        if (matchingEdge) nodeId = matchingEdge.target;
      }
    }
    let node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Published playbook node ${nodeId} is missing.`);

    // Entry triggers and routing conditions apply to the current inbound event;
    // they must not consume a whole customer turn before producing a directive.
    const traversed = new Set<string>();
    while (node.type === 'trigger' || node.type === 'condition') {
      if (traversed.has(node.id)) throw new Error(`Published playbook contains a deterministic cycle at ${node.id}.`);
      traversed.add(node.id);
      const matchingEdge = orderedOutgoingEdges(graph, node!.id)
        .find((edge) => edgeMatches(graph, edge, input, runtimeState, node));
      if (!matchingEdge) {
        throw new Error(`Published playbook ${node.type} node ${node.id} has no matching edge.`);
      }
      nodeId = matchingEdge.target;
      node = graph.nodes.find((item) => item.id === nodeId);
      if (!node) throw new Error(`Published playbook node ${nodeId} is missing.`);
    }

    // A request to see governed media is an interruption, not an answer to the
    // currently collected field. Keep the durable collect node unchanged so a
    // phrase such as "show me photos of Room A" cannot become the trusted room
    // selection or advance a booking journey.
    if (graph.schemaVersion === 2
      && !repeatedEvent
      && !corrected && !pendingCorrectionTransition
      && node.type === 'collect'
      && shouldUseMediaInterruption(input)) {
      const interruptedState = {
        ...runtimeState,
        suspendedQuestion: { nodeId: node.id, reason: 'customer_interruption' as const },
        proposedNodeId: node.id,
        proposedCompleted: false,
        ...(eventKey ? { proposedEventKey: eventKey } : {}),
      };
      const virtualMediaNode: PlaybookNode = {
        id: `${node.id}:media-interruption`,
        type: 'media',
        data: {
          instruction: 'Deliver only authorized, published media relevant to the customer’s explicit request. Do not treat the request as a collected field value.',
          resumeQuestion: collectInstruction(graph, node, asJourneyState(graph, interruptedState, input.profileSnapshot)),
          assertions: [
            { type: 'media_intent_is', value: 'explicit' },
            { type: 'media_selected' },
            { type: 'media_delivery_succeeded' },
          ],
        },
      };
      if (input.dryRun) {
        if (!input.readOnlyDraft) await supportPreviewStore.save(input.userId, input.conversationId, { run: { ...run, state: interruptedState }, graph }, executor);
        return toDirective({ ...run, state: interruptedState }, graph, virtualMediaNode, agentType, input);
      }
      const [updated] = await executor.update(supportPlaybookRunsTable).set({
        state: interruptedState,
        updatedAt: new Date(),
      }).where(and(
        eq(supportPlaybookRunsTable.id, run.id),
        eq(supportPlaybookRunsTable.userId, input.userId),
      )).returning();
      return toDirective(updated || { ...run, state: interruptedState }, graph, virtualMediaNode, agentType, input);
    }

    // A factual FAQ can interrupt a v2 collection question without losing or
    // advancing the journey. KnowledgeRetrievalStage supplies the evidence for
    // this virtual step; after its reply is delivered the durable node remains
    // the outstanding collect step and the next customer turn resumes it.
    if (graph.schemaVersion === 2
      && !repeatedEvent
      && !corrected && !pendingCorrectionTransition
      && node.type === 'collect'
      && shouldUseKnowledgeInterruption(input)
      // Provider-native selections and numbered/text aliases are trusted by
      // the published field schema. Consume them before considering the NLU
      // FAQ label, which can be broader and occasionally classify a menu
      // choice such as "4" as a factual request.
      && !collectNodeConsumesInbound(
        graph,
        node,
        asJourneyState(graph, runtimeState, input.profileSnapshot),
        turnInput(input, runtimeState),
      )) {
      const interruptedState = {
        ...runtimeState,
        suspendedQuestion: { nodeId: node.id, reason: 'customer_interruption' as const },
        proposedNodeId: node.id,
        proposedCompleted: false,
        ...(eventKey ? { proposedEventKey: eventKey } : {}),
      };
      const virtualKnowledgeNode: PlaybookNode = {
        id: `${node.id}:knowledge-interruption`,
        type: 'knowledge',
        data: {
          // Keep this factual interruption focused on the latest question.
          // Replaying a stored collect menu adds unrelated English text to a
          // translated answer and can produce several extra provider sends.
          // The durable collect node remains available for the next turn.
          instruction: 'Answer only the customer’s direct question from authorized published knowledge in the customer’s requested language. Do not append the previous menu or request contact details, dates, booking information, or any other field.',
          assertions: [{ type: 'grounding_is', value: 'grounded' }, { type: 'has_supported_claims' }],
        },
      };
      if (input.dryRun) {
        if (!input.readOnlyDraft) await supportPreviewStore.save(input.userId, input.conversationId, { run: { ...run, state: interruptedState }, graph }, executor);
        return toDirective({ ...run, state: interruptedState }, graph, virtualKnowledgeNode, agentType, input);
      }
      const [updated] = await executor.update(supportPlaybookRunsTable).set({
        state: interruptedState,
        updatedAt: new Date(),
      }).where(and(
        eq(supportPlaybookRunsTable.id, run.id),
        eq(supportPlaybookRunsTable.userId, input.userId),
      )).returning();
      return toDirective(updated || { ...run, state: interruptedState }, graph, virtualKnowledgeNode, agentType, input);
    }

    // Typed collection is schema-driven and operates only on privacy-processed
    // text plus classifier entities. It can consume several already-satisfied
    // collect/condition steps without spending artificial customer turns.
    if (graph.schemaVersion === 2 && !repeatedEvent) {
      if (runtimeState.suspendedQuestion) {
        const { suspendedQuestion: _resumedQuestion, ...resumedState } = runtimeState;
        runtimeState = resumedState;
      }
      const visitedCollect = new Set<string>();
      let allowPromptAnswer = !corrected && !pendingCorrectionTransition;
      while (node.type === 'collect') {
        if (visitedCollect.has(node.id)) throw new Error(`Published playbook contains a collect cycle at ${node.id}.`);
        visitedCollect.add(node.id);
        runtimeState = collectJourneyFields(
          graph,
          node,
          asJourneyState(graph, runtimeState, input.profileSnapshot),
          { ...turnInput(input, runtimeState), allowPromptAnswer },
        );
        allowPromptAnswer = false;
        if (missingFieldsForNode(graph, node, asJourneyState(graph, runtimeState, input.profileSnapshot)).length > 0) break;
        const matchingEdge = orderedOutgoingEdges(graph, node.id)
          .find((edge) => edgeMatches(graph, edge, input, runtimeState, node));
        if (!matchingEdge) break;
        nodeId = matchingEdge.target;
        node = graph.nodes.find((item) => item.id === nodeId)!;
        if (!node) throw new Error(`Published playbook node ${nodeId} is missing.`);
        while (node.type === 'trigger' || node.type === 'condition') {
          const deterministicEdge = orderedOutgoingEdges(graph, node.id)
            .find((edge) => edgeMatches(graph, edge, input, runtimeState, node));
          if (!deterministicEdge) throw new Error(`Published playbook ${node.type} node ${node.id} has no matching edge.`);
          nodeId = deterministicEdge.target;
          node = graph.nodes.find((item) => item.id === nodeId)!;
          if (!node) throw new Error(`Published playbook node ${nodeId} is missing.`);
        }
      }
    }

    const completed = node.type === 'complete' || node.type === 'escalation' || node.type === 'handoff';
    if (input.dryRun || repeatedEvent) {
      if (input.dryRun && !input.readOnlyDraft) await supportPreviewStore.save(input.userId, input.conversationId, {
        run: { ...run, state: { ...runtimeState, proposedNodeId: node.id, proposedCompleted: completed,
          ...(eventKey ? { proposedEventKey: eventKey } : {}) } }, graph,
      }, executor);
      return toDirective({ ...run, state: runtimeState }, graph, node, agentType, input, correctedServiceTime);
    }
    // Resolution only proposes a transition. The delivery/handoff commit gate
    // advances the durable run after the canonical outcome succeeds.
    const proposedState = {
      ...runtimeState,
      ...(agentType ? { agentType } : {}),
      proposedNodeId: node.id,
      proposedCompleted: completed,
      ...(eventKey ? { proposedEventKey: eventKey } : {}),
    };
    const [updated] = await executor.update(supportPlaybookRunsTable).set({
      state: proposedState,
      updatedAt: new Date(),
    }).where(and(
      eq(supportPlaybookRunsTable.id, run.id),
      eq(supportPlaybookRunsTable.userId, input.userId),
    )).returning();
    return toDirective(updated || { ...run, state: proposedState }, graph, node, agentType, input, correctedServiceTime);
  }

  async commitProposedTransition(
    userId: number,
    runId: number,
    outcome?: {
      capabilityName?: string;
      capabilityStatus?: 'success' | 'unavailable' | 'redirected' | 'failed' | 'pending_approval' | 'suppressed' | 'requires_reconciliation';
      groundingStatus?: string;
      deliveryStatus?: string;
    },
  ): Promise<boolean> {
    if (!runId) return false;
    return db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId}, ${runId})`);
      const [run] = await tx.select().from(supportPlaybookRunsTable).where(and(
        eq(supportPlaybookRunsTable.id, runId),
        eq(supportPlaybookRunsTable.userId, userId),
      )).limit(1);
      if (!run || typeof run.state.proposedNodeId !== 'string') return false;
      const { assertSupportTurnFresh, currentSupportTurn } = await import('./SupportConversationTurn.js');
      await assertSupportTurnFresh(tx);
      const turn = currentSupportTurn();
      if (turn && (!turn.sealed || run.state.coordinatedTurnId !== turn.id
        || run.state.proposedEventKey !== `turn:${turn.id}`)) return false;
      const {
        proposedNodeId,
        proposedEventKey,
        proposedCompleted,
        correctionPendingTransition: _committedCorrection,
        ...restState
      } = run.state;
      const completed = proposedCompleted === true;
      const nextState = {
        ...restState,
        ...(typeof proposedEventKey === 'string' ? { lastEventKey: proposedEventKey } : {}),
        ...(outcome?.capabilityName && outcome.capabilityStatus ? {
          capabilityStatus: {
            ...(restState.capabilityStatus && typeof restState.capabilityStatus === 'object' && !Array.isArray(restState.capabilityStatus)
              ? restState.capabilityStatus as Record<string, unknown> : {}),
            [outcome.capabilityName]: outcome.capabilityStatus,
          },
        } : {}),
        ...(outcome?.groundingStatus ? { groundingStatus: outcome.groundingStatus } : {}),
        ...(outcome?.deliveryStatus ? { deliveryStatus: outcome.deliveryStatus } : {}),
      };
      let committedNodeId = proposedNodeId;
      let committedCompleted = completed;
      let committedState = nextState;
      if (!committedCompleted) {
        const [version] = await tx.select().from(supportPlaybookVersionsTable).where(and(
          eq(supportPlaybookVersionsTable.playbookId, run.playbookId),
          eq(supportPlaybookVersionsTable.version, run.playbookVersion),
        )).limit(1);
        const graph = version?.graph;
        if (graph) {
          const terminal = committedTerminalNode(graph, proposedNodeId, nextState, {
            userId,
            conversationId: run.conversationId,
            channel: 'internal',
            inboundText: '',
            agentType: typeof nextState.agentType === 'string' ? nextState.agentType : '',
            groundingStatus: outcome?.groundingStatus,
            deliveryStatus: outcome?.deliveryStatus,
          });
          if (terminal) {
            committedNodeId = terminal.id;
            committedCompleted = true;
            committedState = { ...nextState, completedTerminalNodeId: terminal.id };
          } else if (isDeliveredExternalSearchRedirect({ currentNodeId: proposedNodeId, state: nextState })) {
            // Preserve the terminal outcome even when this immutable run is
            // pinned to a pre-fallback graph that has no explicit terminal node.
            committedCompleted = true;
            committedState = { ...nextState, completedTerminalNodeId: 'external-search-complete' };
          }
        }
      }
      const [updated] = await tx.update(supportPlaybookRunsTable).set({
        currentNodeId: committedNodeId,
        status: committedCompleted ? 'completed' : 'active',
        state: committedState,
        completedAt: committedCompleted ? new Date() : null,
        updatedAt: new Date(),
      }).where(and(
        eq(supportPlaybookRunsTable.id, runId),
        eq(supportPlaybookRunsTable.userId, userId),
      )).returning({ id: supportPlaybookRunsTable.id });
      return Boolean(updated);
    });
  }

  evaluateCompliance(directive: PlaybookDirective, input: string | PlaybookComplianceInput): { passed: boolean; score: number; missing: string[] } {
    const decision: PlaybookComplianceInput = typeof input === 'string' ? { replyText: input } : input;
    const replyText = decision.replyText;
    const normalizedReply = replyText.toLowerCase().replace(/\s+/g, ' ').trim();
    const verbatim = directive.compliance?.verbatim?.toLowerCase().replace(/\s+/g, ' ').trim();
    const required = directive.compliance?.requiredPhrases || [];
    const phraseChecks = [
      ...(verbatim ? [normalizedReply.includes(verbatim)] : []),
      ...required.map((phrase) => normalizedReply.includes(phrase.toLowerCase().replace(/\s+/g, ' ').trim())),
    ];
    const assertions = directive.compliance?.assertions || [];
    const assertionChecks = assertions.map((assertion): { passed: boolean; label: string } => {
      switch (assertion.type) {
        case 'intent_is': return { passed: decision.intent === assertion.value, label: `intent=${assertion.value}` };
        case 'grounding_is': return { passed: decision.groundingStatus === assertion.value, label: `grounding=${assertion.value}` };
        case 'has_supported_claims': return {
          passed: Boolean(decision.claims?.length) && decision.claims!.every((claim) => claim.verdict === 'supported'),
          label: 'all factual claims supported',
        };
        case 'tool_succeeded': return {
          passed: Boolean(decision.toolOutcomes?.some((tool) => tool.name === assertion.tool && tool.status === 'success' && tool.success)),
          label: `successful tool action: ${assertion.tool}`,
        };
        case 'tool_confirmed_effect': return {
          passed: Boolean(decision.toolOutcomes?.some((tool) => tool.name === assertion.tool && tool.status === 'success' && tool.confirmedSideEffect)),
          label: `confirmed tool effect: ${assertion.tool}`,
        };
        case 'effect_proposed': return {
          passed: Boolean(decision.effectProposals?.some((effect) => effect.type === assertion.effectType)),
          label: `effect proposal: ${assertion.effectType}`,
        };
        case 'handoff_required': return {
          passed: Boolean(decision.handoffRequired) === (assertion.value ?? true),
          label: `handoff required=${assertion.value ?? true}`,
        };
        case 'decision_outcome': return { passed: decision.outcome === assertion.value, label: `outcome=${assertion.value}` };
        case 'media_intent_is': return { passed: decision.mediaIntent === assertion.value, label: `media intent=${assertion.value}` };
        case 'media_selected': return { passed: decision.mediaSelected === true, label: 'media selected' };
        case 'media_delivery_succeeded': return { passed: decision.mediaDeliverySucceeded === true, label: 'media delivery succeeded' };
      }
    });
    const checks = [...phraseChecks, ...assertionChecks.map((item) => item.passed)];
    if (checks.length === 0) return { passed: true, score: 1, missing: [] };
    const missing = required.filter((_, index) => !phraseChecks[(verbatim ? 1 : 0) + index]);
    if (verbatim && !phraseChecks[0]) missing.unshift(verbatim);
    missing.push(...assertionChecks.filter((item) => !item.passed).map((item) => item.label));
    const passedCount = checks.filter(Boolean).length;
    return { passed: passedCount === checks.length, score: passedCount / checks.length, missing };
  }
}

export const playbookEngine = new PlaybookEngine();
import { currentBusinessScope } from '../../../tenancy/businessContext.js';
