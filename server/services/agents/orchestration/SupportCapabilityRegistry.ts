import type {
  PlaybookCapabilityName,
  PlaybookFieldState,
  PlaybookValueBinding,
} from '../../../models/supportOrchestration/schema.js';
import { validateSupportToolArgs } from './SupportToolSchemas.js';
import { SUPPORT_REQUEST_SERVICES } from './SupportSemanticIntent.js';

export type SupportCapabilityKind = 'tool' | 'effect' | 'context' | 'handoff';

export interface SupportCapabilityDefinition {
  name: PlaybookCapabilityName;
  kind: SupportCapabilityKind;
  description: string;
  toolName?: string;
  effectType?: 'support_ticket' | 'handoff' | 'inquiry' | 'callback';
  risk: 'read' | 'write' | 'high';
  allowedAgentTypes?: string[];
}

export interface CapabilityResolutionContext {
  intent?: string;
  channel: string;
  conversationId: number;
  contactAvailable: boolean;
}

export const SUPPORT_CAPABILITIES: Record<PlaybookCapabilityName, SupportCapabilityDefinition> = {
  'ticket.status': {
    name: 'ticket.status', kind: 'tool', risk: 'read', toolName: 'get_ticket_status',
    allowedAgentTypes: ['tech_support', 'customer_success', 'general_service'],
    description: 'Reads ticket status authorized for the current customer conversation.',
  },
  'catalog.search': {
    name: 'catalog.search', kind: 'context', risk: 'read',
    description: 'Searches the published tenant catalog through the knowledge evidence lane.',
  },
  'availability.check': {
    name: 'availability.check', kind: 'tool', risk: 'read', toolName: 'check_room_availability',
    allowedAgentTypes: ['hotel_sales'],
    description: 'Checks current resource availability through the tenant adapter.',
  },
  'quote.present': {
    name: 'quote.present', kind: 'context', risk: 'read',
    description: 'Presents only a verified quote already returned by an authorized adapter.',
  },
  'proposal.list': {
    name: 'proposal.list', kind: 'tool', risk: 'read', toolName: 'get_conversation_proposals',
    description: 'Returns customer-safe proposal status scoped to the current conversation.',
  },
  'proposal.request': {
    name: 'proposal.request', kind: 'tool', risk: 'write', toolName: 'create_conversation_proposal_draft',
    description: 'Prepares a customer-requested offer, following the account optional review policy and explicit draft-only restrictions.',
  },
  'proposal.revision_request': {
    name: 'proposal.revision_request', kind: 'tool', risk: 'write', toolName: 'request_proposal_revision',
    description: 'Prepares requested changes as a separate offer, following the account optional review policy.',
  },
  'knowledge.answer': {
    name: 'knowledge.answer', kind: 'tool', risk: 'read', toolName: 'answer_from_knowledge_base',
    description: 'Answers through the canonical tenant knowledge gateway.',
  },
  'media.select': {
    name: 'media.select', kind: 'context', risk: 'read',
    description: 'Requests governed media selection from the shared media evidence lane.',
  },
  'asset.deliver': {
    name: 'asset.deliver', kind: 'context', risk: 'read',
    description: 'Automatically finds a relevant approved PDF for the customer request and configured topic; supports WhatsApp and secure webchat downloads.',
  },
  'inquiry.create': {
    name: 'inquiry.create', kind: 'effect', risk: 'write', effectType: 'inquiry',
    description: 'Creates a structured tenant enquiry after canonical reply delivery.',
  },
  'callback.request': {
    name: 'callback.request', kind: 'effect', risk: 'write', effectType: 'callback',
    description: 'Creates a consented callback request after canonical reply delivery.',
  },
  'checkout.continue': {
    // This capability delivers a governed referral only. It cannot create a
    // booking, hold inventory, take payment, or claim completion; explicit
    // customer confirmation is enforced by the adapter. Treat the referral as
    // a write, while the actual financial transaction remains external.
    name: 'checkout.continue', kind: 'tool', risk: 'write', toolName: 'continue_external_booking',
    allowedAgentTypes: ['hotel_sales'],
    description: 'Continues through the owner-approved external checkout handoff.',
  },
  'human_handoff.create': {
    name: 'human_handoff.create', kind: 'handoff', risk: 'write',
    description: 'Creates a canonical human handoff through the shared gateway.',
  },
};

export function isSupportCapability(value: unknown): value is PlaybookCapabilityName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUPPORT_CAPABILITIES, value);
}

function isBinding(value: unknown): value is PlaybookValueBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = (value as { source?: unknown }).source;
  return source === 'field' || source === 'sum' || source === 'coalesce'
    || source === 'constant' || source === 'context';
}

export function validateCapabilityBindings(
  value: unknown,
  fieldKeys: Set<string>,
  path = 'args',
): string[] {
  if (isBinding(value)) {
    if (value.source === 'field' && (!value.key || !fieldKeys.has(value.key))) {
      return [`${path} references unknown field ${value.key || '(empty)'}.`];
    }
    if (value.source === 'sum') {
      if (!Array.isArray(value.keys) || value.keys.length < 2) {
        return [`${path} sum binding requires at least two fields.`];
      }
      const unknown = value.keys.filter((key) => !fieldKeys.has(key));
      if (unknown.length) return [`${path} references unknown fields ${unknown.join(', ')}.`];
    }
    if (value.source === 'coalesce') {
      if (!Array.isArray(value.keys) || value.keys.length < 2) {
        return [`${path} coalesce binding requires at least two fields.`];
      }
      const unknown = value.keys.filter((key) => !fieldKeys.has(key));
      if (unknown.length) return [`${path} references unknown fields ${unknown.join(', ')}.`];
    }
    if (value.source === 'context'
      && !['intent', 'channel', 'conversationId', 'contactAvailable'].includes(value.key)) {
      return [`${path} references unsupported context key ${String(value.key)}.`];
    }
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => validateCapabilityBindings(item, fieldKeys, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => validateCapabilityBindings(child, fieldKeys, `${path}.${key}`));
  }
  return [];
}

export function resolveCapabilityBindings(
  value: unknown,
  fields: Record<string, PlaybookFieldState>,
  context: CapabilityResolutionContext,
): unknown {
  if (isBinding(value)) {
    if (value.source === 'constant') return value.value;
    if (value.source === 'field') return fields[value.key]?.value;
    if (value.source === 'sum') {
      const values = value.keys.map((key) => Number(fields[key]?.value));
      return values.every(Number.isFinite) ? values.reduce((total, item) => total + item, 0) : undefined;
    }
    if (value.source === 'coalesce') {
      for (const key of value.keys) {
        const field = fields[key];
        if (field && ['collected', 'verified'].includes(field.status)
          && field.value !== undefined && field.value !== null && field.value !== '') {
          return field.value;
        }
      }
      return undefined;
    }
    return context[value.key];
  }
  if (Array.isArray(value)) return value.map((item) => resolveCapabilityBindings(item, fields, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, resolveCapabilityBindings(child, fields, context)]));
  }
  return value;
}

export function validateResolvedCapability(
  capabilityName: PlaybookCapabilityName,
  args: Record<string, unknown>,
  input: { agentType: string; contactAvailable: boolean },
): string[] {
  const definition = SUPPORT_CAPABILITIES[capabilityName];
  const errors: string[] = [];
  if (capabilityName === 'asset.deliver' && !(SUPPORT_REQUEST_SERVICES as readonly unknown[]).includes(args.service)) {
    errors.push('asset.deliver requires a configured document service.');
  }
  if (capabilityName === 'asset.deliver' && args.documentId != null && (!Number.isSafeInteger(args.documentId) || Number(args.documentId) <= 0)) {
    errors.push('asset.deliver requires a positive document ID.');
  }
  if (definition.allowedAgentTypes && !definition.allowedAgentTypes.includes(input.agentType)) {
    errors.push(`${capabilityName} is not available to ${input.agentType}.`);
  }
  if (capabilityName === 'callback.request') {
    // An explicit refusal is a valid no-op, not an invalid callback request.
    // Missing consent still fails closed; only a true opt-in requires contact
    // details and a preferred time.
    if (args.consent !== false) {
      if (args.consent !== true) errors.push('callback.request requires explicit consent=true.');
      if (!input.contactAvailable && !args.contact) errors.push('callback.request requires an available contact method.');
      if (!String(args.preferredTime || '').trim()) errors.push('callback.request requires a preferred time.');
    }
  }
  if (capabilityName === 'inquiry.create' && args.callback && typeof args.callback === 'object' && !Array.isArray(args.callback)) {
    const callback = args.callback as Record<string, unknown>;
    // An inquiry may still be recorded when the customer declines contact.
    // Only validate callback-specific requirements after explicit opt-in;
    // downstream effect policy records declined inquiries without scheduling
    // a callback or creating a handoff.
    if (callback.consent === true) {
      if (!input.contactAvailable && !callback.contact) errors.push('inquiry.create callback bundle requires an available contact method.');
      if (!String(callback.preferredTime || '').trim()) errors.push('inquiry.create callback bundle requires a preferred time.');
    }
  }
  if (definition.toolName) {
    const validation = validateSupportToolArgs(definition.toolName, args);
    if (!validation.success) errors.push(validation.error);
  }
  return errors;
}
