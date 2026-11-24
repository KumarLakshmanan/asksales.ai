import type {
  PlaybookEdge,
  PlaybookFieldDefinition,
  PlaybookFieldState,
  PlaybookGraph,
  PlaybookNode,
  PlaybookProfileBinding,
  PlaybookRunStateV2,
} from '../../../models/supportOrchestration/schema.js';
import type { ContactProfileSnapshot } from './ContactProfileService.js';
import { parseJourneyDate } from './JourneyDateParser.js';
import { irrelevantLegacySpaField } from './HospitalityJourneyIntent.js';
import { confidentSemanticIntent, type SupportSemanticIntent } from './SupportSemanticIntent.js';
import { matchExactPlaybookChoice } from './SupportChoiceDelivery.js';
import { escapeRegExp } from '../../../utils/matchText.js';

export interface JourneyTurnInput {
  semanticRequest?: SupportSemanticIntent;
  inboundText: string;
  intent?: string;
  entities?: Record<string, unknown>;
  vaultId?: number | null;
  contactAvailable?: boolean;
  capabilityStatus?: Record<string, string>;
  groundingStatus?: string;
  deliveryStatus?: string;
  /** Bare answers belong only to the prompt shown for this turn, not to an
   * automatically traversed downstream question. */
  allowPromptAnswer?: boolean;
  /** Ordered messages in one coordinated customer turn, not model prose. */
  fragments?: string[];
  fragmentVaultIds?: Array<number | null>;
}

const FIELD_TYPES = new Set([
  'text', 'integer', 'money', 'date', 'datetime', 'email', 'phone', 'boolean', 'single_select', 'multi_select',
]);

const PRIVACY_TOKEN = /\[(?:EMAIL|PHONE|NAME|COMPANY|ADDRESS|PAYMENT_CARD|SSN|GOVERNMENT_ID|IP_ADDRESS)_\d+\]/;

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function entityCandidates(field: PlaybookFieldDefinition): string[] {
  const tail = field.key.split('.').at(-1) || field.key;
  return [...new Set([field.key, tail, ...(field.validation?.entityKeys || [])])];
}

function fieldLabels(field: PlaybookFieldDefinition): string[] {
  return entityCandidates(field).flatMap((label) => {
    const normalizedLabel = label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').toLowerCase();
    const singular = normalizedLabel.replace(/children$/, 'child').replace(/people$/, 'person')
      .replace(/s$/, '');
    return [normalizedLabel, singular];
  });
}

function fieldExplicitlyMentioned(field: PlaybookFieldDefinition, text: string): boolean {
  const normalizedText = text.replace(/[._-]+/g, ' ');
  const labels = [...fieldLabels(field), ...(field.options || []).flatMap((option) =>
    [option.value, option.label, ...(option.aliases || [])])];
  return labels.some((label) => label.length >= 3
    && new RegExp(`\\b${escapeRegExp(label)}\\b`, 'i').test(normalizedText));
}

function labelledCorrectionValue(field: PlaybookFieldDefinition, text: string): unknown {
  if (!['text', 'date', 'datetime'].includes(field.type)) return undefined;
  const labels = fieldLabels(field).sort((a, b) => b.length - a.length)
    .map((label) => escapeRegExp(label).replace(/ /g, '[\\s_-]+'));
  const match = text.match(new RegExp(`\\b(?:${labels.join('|')})\\s*(?::|=|is|to|should be|will be)\\s*([^,;\\n]+)`, 'i'));
  if (!match) return undefined;
  return field.type === 'date' ? match[1].match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
    : match[1].trim().replace(/[.!]+$/, '');
}

/** Consent is a complete, unconditional customer utterance, never a keyword
 * inside a correction, negation, hypothetical, or classifier entity. */
export function explicitCustomerConfirmation(text: string): boolean | undefined {
  const value = String(text || '').trim().replace(/[.!]+$/g, '').trim();
  if (/^(?:no|nope|n|decline|do not|don't)(?:\b|$)/i.test(value)
    && !/\b(?:but|instead|actually|change|correct|update)\b/i.test(value)) return false;
  if (/\b(?:no|not|don't|do\s+not|but|if|unless|except|actually|change|correct|update|only|rather|instead|wait|before|after|until|maybe|provided|assuming|however)\b/i.test(value)) return undefined;
  return /^(?:(?:yes|y|confirm|confirmed)(?:\s*[,;]?\s*(?:please|i confirm|go ahead|please proceed|proceed|please book|book it|reserve it|the (?:booking|details|summary)(?: are correct)?))*|i (?:explicitly )?(?:confirm|agree)(?: (?:the|these) (?:booking|details|summary)(?: are correct)?)?|please (?:do|proceed|book|reserve)|go ahead|book it|reserve it)$/i.test(value)
    ? true : undefined;
}

function entityValue(field: PlaybookFieldDefinition, entities: Record<string, unknown>): unknown {
  for (const key of entityCandidates(field)) {
    if (entities[key] !== undefined && entities[key] !== null) return entities[key];
  }
  return undefined;
}

const NUMBER_WORDS: Record<string, number> = {
  no: 0, none: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

/** A service request can be classified as a FAQ by a provider, but it is an
 * explicit answer to the hospitality topic prompt and must advance the graph. */
export function isHospitalityServiceTopicSelection(field: PlaybookFieldDefinition, request?: SupportSemanticIntent): boolean {
  if (field.key !== 'resort.topic' || field.type !== 'single_select') return false;
  return semanticHospitalitySelection(field, request) !== undefined;
}

function semanticHospitalitySelection(field: PlaybookFieldDefinition, value?: SupportSemanticIntent): string | undefined {
  const request = confidentSemanticIntent(value);
  if (!request?.explicit || !['booking', 'information', 'continue'].includes(request.action)) return undefined;
  const topic = ['spa', 'dining', 'day_outing', 'activities', 'location', 'resort'].includes(request.service) ? request.service : undefined;
  const choice = field.key === 'resort.topic' ? topic : field.key === 'journey.type'
    ? (topic ? 'resort_information' : request.service === 'stay' ? 'leisure'
      : ['corporate', 'celebration'].includes(request.service) ? request.service : undefined) : undefined;
  return field.options?.some(option => option.value === choice) ? choice : undefined;
}

function labelledNumericValue(field: PlaybookFieldDefinition, inboundText: string): number | undefined {
  if (!inboundText.trim()) return undefined;
  const labels = fieldLabels(field)
    .flatMap((candidate) => {
      const normalizedCandidate = normalized(candidate).replace(/[._-]+/g, ' ');
      const singular = normalizedCandidate.endsWith('s') ? normalizedCandidate.slice(0, -1) : normalizedCandidate;
      return [normalizedCandidate, singular];
    })
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (!labels.length) return undefined;
  const number = '(?:no|none|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|-?\\d+(?:\\.\\d+)?)';
  const label = `(?:${labels.join('|')})s?`;
  const match = normalized(inboundText).match(new RegExp(`\\b(${number})\\s+${label}\\b|\\b${label}\\s*(?::|=|is|are|to|should be|will be)?\\s*(${number})\\b`, 'i'));
  const token = match?.[1] || match?.[2];
  if (!token) return undefined;
  return NUMBER_WORDS[token] ?? Number(token);
}

function configuredLiteralValue(field: PlaybookFieldDefinition, inboundText: string): string | undefined {
  const input = normalized(inboundText);
  for (const configured of field.validation?.literalValues || []) {
    const terms = [configured.value, ...(configured.aliases || [])].map(normalized).filter(Boolean);
    if (terms.some((literal) => input === literal)) return configured.value;
  }
  return undefined;
}

function inboundContainsDateExpression(inboundText: string): boolean {
  return /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:today|tomorrow|day\s+after\s+tomorrow|(?:next|this)\s+(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|week|month))\b/i.test(inboundText);
}

function selectionValue(field: PlaybookFieldDefinition, inboundText: string, allowNumber = true): unknown {
  const input = normalized(inboundText);
  const numbered = input.match(/^(\d{1,2})$/);
  if (numbered && allowNumber) return field.options?.[Number(numbered[1]) - 1]?.value;
  const matches = (field.options || []).filter((option) => {
    const terms = [option.value, option.label, option.shortLabel, ...(option.aliases || [])]
      .filter((term): term is string => typeof term === 'string')
      .map(normalized)
      .filter(Boolean);
    return terms.some((term) => input === term);
  });
  return matches.length === 1 ? matches[0].value : undefined;
}

function coerceFieldValue(
  field: PlaybookFieldDefinition,
  raw: unknown,
  inboundText: string,
  allowUnlabelled: boolean,
): unknown {
  if (field.type === 'single_select') {
    // NLU extractors often return the customer-facing label (for example
    // "Birthday") rather than the canonical option value ("birthday").
    // Normalize both through the published option schema, and never let an
    // unrecognized raw entity mask an otherwise valid button/title reply.
    const entitySelection = raw === undefined || raw === null ? undefined : selectionValue(field, String(raw));
    return entitySelection ?? (allowUnlabelled || fieldExplicitlyMentioned(field, inboundText)
      ? selectionValue(field, inboundText, allowUnlabelled) : undefined);
  }
  if (field.type === 'multi_select') {
    if (Array.isArray(raw)) return raw;
    if (!allowUnlabelled && !fieldExplicitlyMentioned(field, inboundText)) return undefined;
    const input = normalized(inboundText);
    const values = (field.options || []).filter((option) =>
      [option.value, option.label, option.shortLabel, ...(option.aliases || [])]
        .filter((term): term is string => typeof term === 'string')
        .map(normalized)
        .some((term) => input === term),
    ).map((option) => option.value);
    return values.length ? values : undefined;
  }
  if (field.type === 'boolean') {
    if (!allowUnlabelled) return undefined;
    return explicitCustomerConfirmation(inboundText);
  }
  if (field.type === 'integer' || field.type === 'money') {
    const candidate = raw ?? labelledNumericValue(field, inboundText)
      ?? (allowUnlabelled ? inboundText.match(/-?\d+(?:\.\d+)?/)?.[0] : undefined);
    const value = Number(candidate);
    return Number.isFinite(value) ? value : undefined;
  }
  if (field.type === 'email' || field.type === 'phone') {
    // A model entity cannot select an identifier from another message's vault.
    // This validates privacy-token provenance, not the customer's intent.
    const pattern = field.type === 'email' ? /\[EMAIL_\d+\]/ : /\[PHONE_\d+\]/;
    const candidate = String(raw ?? '').match(pattern)?.[0]
      ?? (allowUnlabelled ? inboundText.match(pattern)?.[0] : undefined);
    return candidate && inboundText.includes(candidate) ? candidate : undefined;
  }
  if (field.type === 'date') {
    // Classifier entities are hints, not evidence. Reject a carried-forward or
    // hallucinated ISO date unless the current customer turn itself contains a
    // recognizable date expression.
    const parsed = parseJourneyDate(inboundText, field.key, allowUnlabelled);
    if (parsed) return parsed;
    // A checkout-labelled date cannot become the pending check-in (or vice versa).
    const otherDateOnly = /checkIn$/i.test(field.key)
      ? /check[\s-]*out/i.test(inboundText) && !/check[\s-]*in\b/i.test(inboundText)
      : /checkOut$/i.test(field.key) && /check[\s-]*in\b/i.test(inboundText) && !/check[\s-]*out/i.test(inboundText);
    const trustedRaw = !otherDateOnly && inboundContainsDateExpression(inboundText) ? raw : undefined;
    const value = trustedRaw ?? (allowUnlabelled && !otherDateOnly ? inboundText.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] : undefined);
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  }
  if (field.type === 'datetime') {
    const value = (inboundContainsDateExpression(inboundText) ? raw : undefined) ?? (allowUnlabelled ? inboundText : undefined);
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
  }
  if (field.type === 'text' && field.pii === 'contact') {
    const attribute = field.profileBinding?.attribute || (/company/i.test(field.key) ? 'company' : 'fullName');
    const type = attribute === 'email' ? 'EMAIL' : attribute === 'phone' ? 'PHONE' : attribute === 'company' ? 'COMPANY' : 'NAME';
    const token = new RegExp(`\\[${type}_\\d+\\]`);
    const candidate = String(raw ?? '').match(token)?.[0] ?? (allowUnlabelled ? inboundText.match(token)?.[0] : undefined);
    return candidate && inboundText.includes(candidate) ? candidate : undefined;
  }
  if (raw !== undefined) return typeof raw === 'string' ? raw.trim().slice(0, Math.min(field.validation?.maxLength || 500, 8000)) : raw;
  if (field.type === 'text') return configuredLiteralValue(field, inboundText);
  return undefined;
}

function fieldValueValid(field: PlaybookFieldDefinition, value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (field.type === 'integer' && (!Number.isSafeInteger(value) || Number(value) < 0)) return false;
  if (field.type === 'money' && (!Number.isFinite(value) || Number(value) < 0)) return false;
  if (field.type === 'date' && (typeof value !== 'string' || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value)) return false;
  if (field.type === 'single_select' && !field.options?.some((option) => option.value === value)) return false;
  if (field.type === 'multi_select' && (!Array.isArray(value)
    || value.some((item) => !field.options?.some((option) => option.value === item)))) return false;
  if (typeof value === 'number') {
    if (field.validation?.min !== undefined && value < field.validation.min) return false;
    if (field.validation?.max !== undefined && value > field.validation.max) return false;
  }
  if (typeof value === 'string') {
    if (field.validation?.minLength !== undefined && value.length < field.validation.minLength) return false;
    if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) return false;
    if (field.validation?.pattern && !new RegExp(field.validation.pattern).test(value)) return false;
  }
  return true;
}

/** Only unambiguous, non-personal occupancy counts may skip model classification.
 * The caller must resolve the first missing field of the active published run.
 * Never extend this to money, identifiers, consent, or arbitrary free text. */
export function matchActiveOccupancyCount(field: PlaybookFieldDefinition, text: string): number | undefined {
  const allowed = new Set([
    'stay.adults', 'stay.children', 'stay.rooms',
    'service.adults', 'service.children', 'corporate.attendees',
    'corporate.nights', 'celebration.guestCount',
  ]);
  const input = text.trim();
  if (!allowed.has(field.key) || field.type !== 'integer' || field.pii !== 'none'
    || !/^\d{1,4}$/.test(input)) return undefined;
  const value = Number(input);
  return fieldValueValid(field, value) ? value : undefined;
}

export function validateJourneyFields(graph: PlaybookGraph): string[] {
  if (graph.schemaVersion !== 2) return [];
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const field of graph.fields || []) {
    if (!/^[a-z][a-z0-9_.-]{0,119}$/i.test(field.key || '')) errors.push(`Invalid field key: ${field.key || '(empty)'}.`);
    if (keys.has(field.key)) errors.push(`Duplicate field key: ${field.key}.`);
    keys.add(field.key);
    if (!FIELD_TYPES.has(field.type)) errors.push(`Field ${field.key} has unsupported type ${field.type}.`);
    if (!['none', 'contact', 'sensitive'].includes(field.pii)) errors.push(`Field ${field.key} has invalid PII classification.`);
    if (!field.prompt?.trim()) errors.push(`Field ${field.key} requires a prompt.`);
    if (field.pii === 'sensitive' && field.required) errors.push(`Sensitive field ${field.key} cannot be required in an automated playbook.`);
    if (field.profileBinding) {
      if (field.pii !== 'contact') errors.push(`Profile-bound field ${field.key} must use contact PII classification.`);
      if (!['fullName', 'firstName', 'lastName', 'email', 'phone', 'company'].includes(field.profileBinding.attribute)) {
        errors.push(`Field ${field.key} has an unsupported CRM profile attribute.`);
      }
      if (!['fill_missing_or_verify_correction', 'never'].includes(field.profileBinding.writeBack)) {
        errors.push(`Field ${field.key} has an unsupported CRM write-back policy.`);
      }
      if (!['provider', 'customer_verified', 'owner_verified'].includes(field.profileBinding.minimumTrust)) {
        errors.push(`Field ${field.key} has an unsupported CRM trust level.`);
      }
    }
    for (const literal of field.validation?.literalValues || []) {
      if (!literal.value?.trim()) errors.push(`Field ${field.key} literal values require a non-empty canonical value.`);
      if (literal.aliases?.some((alias) => !alias.trim())) errors.push(`Field ${field.key} literal aliases must be non-empty.`);
    }
    if (field.validation?.pattern) {
      if (field.validation.pattern.length > 200) errors.push(`Field ${field.key} validation pattern is too long.`);
      else {
        try { new RegExp(field.validation.pattern); } catch { errors.push(`Field ${field.key} has an invalid validation pattern.`); }
      }
    }
    if (['single_select', 'multi_select'].includes(field.type)) {
      if (!field.options?.length) errors.push(`Field ${field.key} requires selection options.`);
      const values = (field.options || []).map((option) => option.value);
      if (values.some((value) => !value?.trim()) || new Set(values).size !== values.length) {
        errors.push(`Field ${field.key} option values must be non-empty and unique.`);
      }
      for (const option of field.options || []) {
        if (!option.label?.trim()) errors.push(`Field ${field.key} option ${option.value || '(empty)'} requires a label.`);
        if (option.shortLabel !== undefined && (!option.shortLabel.trim() || option.shortLabel.trim().length > 20)) {
          errors.push(`Field ${field.key} option ${option.value || '(empty)'} shortLabel must be between 1 and 20 characters.`);
        }
      }
    }
  }
  return errors;
}

const TRUST_RANK = { provider: 1, customer_verified: 2, owner_verified: 3 } as const;

function compatibleProfileBinding(field: PlaybookFieldDefinition): PlaybookFieldDefinition['profileBinding'] {
  if (field.profileBinding) return field.profileBinding;
  // Backward-compatible hydration for already-published Graph v2 runs that
  // used the canonical contact keys before profile bindings were introduced.
  const compatibilityAttributes: Partial<Record<string, PlaybookProfileBinding['attribute']>> = {
    'contact.fullName': 'fullName',
    'contact.firstName': 'firstName',
    'contact.lastName': 'lastName',
    'contact.email': 'email',
    'contact.phone': 'phone',
    'contact.company': 'company',
  };
  const attribute = compatibilityAttributes[field.key];
  return field.pii === 'contact' && attribute
    ? { attribute, read: true, writeBack: 'never', minimumTrust: 'provider' }
    : undefined;
}

export function initializeJourneyState(graph: PlaybookGraph, profile?: ContactProfileSnapshot | null): PlaybookRunStateV2 {
  const fields: Record<string, PlaybookFieldState> = Object.fromEntries((graph.fields || []).map((field) => [field.key, {
    status: 'missing', source: 'customer',
  } satisfies PlaybookFieldState]));
  for (const field of graph.fields || []) {
    const binding = compatibleProfileBinding(field);
    if (!binding?.read || !profile) continue;
    const profileValue = profile.fields[binding.attribute];
    if (!profileValue || TRUST_RANK[profileValue.trust] < TRUST_RANK[binding.minimumTrust]) continue;
    fields[field.key] = {
      value: profileValue.value,
      status: 'verified',
      source: 'crm',
      vaultRef: profileValue.vaultRef,
      trust: profileValue.trust,
    };
  }
  return {
    graphVersion: 2,
    fields,
  };
}

export function collectJourneyFields(
  graph: PlaybookGraph,
  node: PlaybookNode,
  state: PlaybookRunStateV2,
  input: JourneyTurnInput,
): PlaybookRunStateV2 {
  if (graph.schemaVersion !== 2 || node.type !== 'collect') return state;
  const requested = Array.isArray(node.data?.fieldKeys)
    ? node.data.fieldKeys.filter((key): key is string => typeof key === 'string')
    : [];
  const fields = { ...state.fields };
  const definitions = new Map((graph.fields || []).map((field) => [field.key, field]));
  const missingBefore = missingFieldsForNode(graph, node, state).map(field => field.key);
  const promptedKey = input.allowPromptAnswer === false ? undefined : missingBefore[0];
  for (const key of requested) {
    if (irrelevantLegacySpaField(graph, node.id, state, key)) continue;
    const field = definitions.get(key);
    if (!field || field.pii === 'sensitive') continue;
    const bookingName = isBookingNameField(graph, node, field);
    if (bookingName && key === promptedKey && fields[key]?.source === 'crm'
      && fields[key]?.value && (explicitCustomerConfirmation(input.inboundText) === true
        || /^(?:use (?:my |the )?(?:whatsapp|saved|profile)(?: profile)? name)[.!]?$/i.test(input.inboundText.trim()))) {
      fields[key] = { ...fields[key], bookingNameConfirmed: true };
      continue;
    }
    if (bookingName && key === promptedKey && explicitCustomerConfirmation(input.inboundText) === false) {
      fields[key] = { status: 'missing', source: 'customer', bookingNameDeclined: true };
      continue;
    }
    // Contact values are only persisted as stable privacy tokens linked to the
    // encrypted vault. Raw values from an entity extractor are never trusted.
    if (field.pii === 'contact' && !input.vaultId) continue;
    const request = confidentSemanticIntent(input.semanticRequest);
    // The currently asked, schema-owned selection is explicit even when the
    // classifier marks a short button title/number as uncertain. It must also
    // take precedence over a conflicting extracted entity. This exception
    // never applies to prose, negation, or an unprompted future field.
    const exactChoice = input.allowPromptAnswer !== false && key === promptedKey && field.type === 'single_select'
      ? matchExactPlaybookChoice(field, input.inboundText) : undefined;
    if (['single_select', 'multi_select'].includes(field.type) && input.semanticRequest && !request?.explicit && !exactChoice) continue;
    const modelChoice = key === promptedKey || request?.topicSwitch
      ? semanticHospitalitySelection(field, request) : undefined;
    const raw = exactChoice?.value ?? modelChoice ?? (input.allowPromptAnswer === false && !fieldExplicitlyMentioned(field, input.inboundText)
      ? undefined : entityValue(field, input.entities || {}));
    // The renderer asks one missing field at a time. Apply free-form parsing
    // only to that prompted field while still accepting explicitly keyed NLU
    // entities for any declared field. This prevents a reply such as "40"
    // from becoming the attendee count, number of nights, adults, children,
    // and rooms simultaneously.
    let value = coerceFieldValue(field, raw, input.inboundText, key === promptedKey);
    if (input.fragments && input.fragments.length > 1) {
      // A bare count stays attached to the one delivered prompt. Exact named
      // choices can be supplied in another message, without pretending a new
      // question was asked between the two inbound messages.
      const candidates = input.fragments.map(fragment => coerceFieldValue(field, undefined, fragment, key === promptedKey))
        .filter(candidate => candidate !== undefined);
      const unique = [...new Map(candidates.map(candidate => [JSON.stringify(candidate), candidate])).values()];
      // Joined text parsers (and extracted entities) may choose the first
      // number. Conflicting message-level answers require clarification.
      if (unique.length > 1) continue;
      if (value === undefined && unique.length === 1) value = unique[0];
    }
    if (field.pii === 'contact' && (typeof value !== 'string' || !PRIVACY_TOKEN.test(value))) continue;
    // Repeating a reservation request is not itself a date, requirement or
    // callback time. For a model-classified booking action, accept extracted
    // field entities above but do not store the whole request as a field.
    if (field.pii === 'none' && field.type === 'text' && value === undefined && key === promptedKey
      && request?.action !== 'booking'
      // The model must identify actual proposal requirements. A repeated
      // "I need a proposal" is not itself a title, reference or deliverable.
      && !field.key.startsWith('proposal.')
      // The AI extraction contract owns appointment date/time values. A
      // continuation can also mean "I haven't chosen a date yet"; an absent
      // date entity must not turn that sentence into a collected date.
      && !(field.key === 'service.dateTime' && input.semanticRequest)) {
      value = input.inboundText.trim().slice(0, 500);
    }
    if (value === undefined) continue;
    const fragmentVault = field.pii === 'contact' && input.fragments && input.fragmentVaultIds
      ? input.fragments.map((fragment, index) => typeof value === 'string' && fragment.includes(value)
        ? input.fragmentVaultIds![index] : null).find(Boolean)
      : input.vaultId;
    if (field.pii === 'contact' && !fragmentVault) continue;
    fields[key] = {
      value,
      status: fieldValueValid(field, value) ? 'collected' : 'invalid',
      source: 'customer',
      ...(field.pii !== 'none' && fragmentVault ? { vaultRef: fragmentVault } : {}),
      ...(bookingName ? { bookingNameConfirmed: true } : {}),
    };
  }
  for (const field of graph.fields || []) {
    if (field.type !== 'date' || !/checkOut$/i.test(field.key)) continue;
    const startKey = field.key.replace(/checkOut$/i, 'checkIn');
    const start = fields[startKey]?.value;
    const end = fields[field.key]?.value;
    const dayuse = Object.entries(fields).some(([key, entry]) => /stayType$/i.test(key) && entry.value === 'dayuse');
    if (typeof start === 'string' && typeof end === 'string' && (end < start || (!dayuse && end === start))) {
      fields[field.key] = { ...fields[field.key], status: 'invalid' };
    }
  }
  return { ...state, fields };
}

/** Apply only explicitly labelled corrections to already collected facts.
 * The engine revalidates the affected read capability before it can accept a
 * fresh confirmation. Contact corrections remain in the separate vault/CRM
 * confirmation workflow; model entities alone cannot change an identity. */
export function correctJourneyFields(
  graph: PlaybookGraph,
  state: PlaybookRunStateV2,
  input: JourneyTurnInput,
  _options: { atConfirmationPrompt?: boolean } = {},
): { state: PlaybookRunStateV2; changedFields: string[] } {
  const request = confidentSemanticIntent(input.semanticRequest);
  const explicitChangeRequest = request?.action === 'correction' && request.explicit;
  if (!explicitChangeRequest) {
    return { state, changedFields: [] };
  }
  const fields = { ...state.fields };
  const changedFields: string[] = [];
  for (const field of graph.fields || []) {
    const extractedCorrection = entityValue(field, input.entities || {});
    if (field.pii !== 'none' || field.type === 'boolean'
      || !['collected', 'verified'].includes(fields[field.key]?.status)
      || (!fieldExplicitlyMentioned(field, input.inboundText)
        // The canonical extracted slot + existing collected value identify
        // the service even when a short correction is classified "general".
        && !(field.key === 'service.dateTime' && extractedCorrection !== undefined))) continue;
    const raw = field.type === 'integer' || field.type === 'money'
      ? labelledNumericValue(field, input.inboundText)
      : extractedCorrection ?? labelledCorrectionValue(field, input.inboundText);
    const value = coerceFieldValue(field, raw, input.inboundText, false);
    if (value === undefined || JSON.stringify(value) === JSON.stringify(fields[field.key]?.value)) continue;
    fields[field.key] = { value, status: fieldValueValid(field, value) ? 'collected' : 'invalid', source: 'customer' };
    changedFields.push(field.key);
  }
  if (!changedFields.length) return { state, changedFields };

  // A corrected start date can invalidate the previously collected end date.
  // Re-collect that dependency instead of presenting an impossible stay to a
  // tool or treating the old quote as confirmation of the new range.
  for (const key of [...changedFields].filter((key) => /(?:^|\.)check(?:In|Out)$/.test(key))) {
    const startKey = key.replace(/check(?:In|Out)$/, 'checkIn');
    const endKey = key.replace(/check(?:In|Out)$/, 'checkOut');
    const start = fields[startKey], end = fields[endKey];
    if (start?.status === 'collected' && end?.status === 'collected' && end.value && String(end.value) <= String(start.value)) {
      fields[endKey] = { ...(changedFields.includes(endKey) ? { value: end.value } : {}), status: 'invalid', source: 'customer' };
      if (!changedFields.includes(endKey)) changedFields.push(endKey);
    }
  }
  for (const field of graph.fields || []) {
    if (field.type === 'boolean' && /confirm|consent|approv/i.test(`${field.key} ${field.prompt}`)) {
      fields[field.key] = { status: 'missing', source: 'customer' };
    }
  }
  const { pendingConfirmation: _confirmation, capabilityStatus: _capabilities,
    groundingStatus: _grounding, deliveryStatus: _delivery, ...rest } = state;
  return { state: { ...rest, fields }, changedFields };
}

export function isBookingNameField(graph: PlaybookGraph, node: PlaybookNode, field: PlaybookFieldDefinition): boolean {
  return graph.metadata?.agentType === 'hotel_sales' && field.key === 'contact.fullName'
    && /booking|reservation/i.test(`${node.id} ${String(node.data?.label || '')}`);
}

export function missingFieldsForNode(graph: PlaybookGraph, node: PlaybookNode, state: PlaybookRunStateV2): PlaybookFieldDefinition[] {
  const requested = new Set(Array.isArray(node.data?.fieldKeys) ? node.data.fieldKeys.filter((key): key is string => typeof key === 'string') : []);
  return (graph.fields || []).filter((field) => requested.has(field.key)
    && !irrelevantLegacySpaField(graph, node.id, state, field.key)
    && field.required
    && (!['collected', 'verified'].includes(state.fields[field.key]?.status)
      || (isBookingNameField(graph, node, field) && state.fields[field.key]?.source === 'crm'
        && state.fields[field.key]?.bookingNameConfirmed !== true)));
}

export function collectInstruction(graph: PlaybookGraph, node: PlaybookNode, state: PlaybookRunStateV2): string {
  const missing = missingFieldsForNode(graph, node, state);
  // Proposal collection instructions govern the specialist ("ask only for
  // missing requirements"), not the customer. Only their field prompts belong
  // in the reply, including on older immutable proposal graph versions.
  const proposalCollection = missing.some(field => field.key.startsWith('proposal.'));
  const preface = proposalCollection ? '' : String(node.data?.instruction || '').trim();
  if (!missing.length) return preface || 'Confirm the collected information and continue to the next step.';
  // Ask one field at a time. Besides being easier to answer on small screens,
  // this gives numbered selections a stable plain-text representation that is
  // preserved by WhatsApp, Meta DMs, email, and web chat. The field schema—not
  // a channel handler or specialist prompt—remains the source of the menu.
  const field = missing[0];
  if (isBookingNameField(graph, node, field)) {
    return state.fields[field.key]?.source === 'crm' && state.fields[field.key]?.value
      ? 'Should I use your saved contact name for this booking? Reply Yes, or send Name: followed by the name you want on the booking.'
      : 'What name should I use for this booking? Send Name: followed by the booking name.';
  }
  const choices = ['single_select', 'multi_select'].includes(field.type)
    ? (field.options || []).map((option, index) => `${index + 1}. ${option.label}`)
    : [];
  return [
    preface,
    field.prompt,
    ...(choices.length ? ['', ...choices, '', 'Reply with a number or describe your choice in your own words.'] : []),
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1] !== '')).join('\n').trim();
}

export function journeyEdgeMatches(
  graph: PlaybookGraph,
  edge: PlaybookEdge,
  input: JourneyTurnInput,
  state: PlaybookRunStateV2,
  node?: PlaybookNode,
): boolean {
  const condition = edge.condition || { operator: 'always' as const };
  const value = state.fields[condition.field || '']?.value;
  switch (condition.operator) {
    case 'field_present': return value !== undefined && value !== null && value !== '';
    case 'field_missing': return value === undefined || value === null || value === '';
    case 'field_equals': return normalized(value) === normalized(condition.value);
    case 'field_in': return (condition.values || []).map(normalized).includes(normalized(value));
    case 'all_required_fields_present': return Boolean(node) && missingFieldsForNode(graph, node!, state).length === 0;
    case 'confirmation_is': return state.pendingConfirmation?.confirmed === (condition.value !== 'false');
    case 'capability_status_is': return input.capabilityStatus?.[String(condition.capability || '')] === condition.value;
    case 'grounding_is': return input.groundingStatus === condition.value;
    case 'delivery_is': return input.deliveryStatus === condition.value;
    default: return false;
  }
}
