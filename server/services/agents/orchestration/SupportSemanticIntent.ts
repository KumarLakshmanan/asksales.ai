/** Model-owned understanding of the latest turn. Code validates the schema and
 * applies policy; it never infers these values from words or regular expressions. */
export const SUPPORT_REQUEST_ACTIONS = ['continue', 'information', 'history', 'document', 'booking', 'callback',
  'proposal_create', 'proposal_status', 'proposal_revision', 'human', 'refund', 'booking_link',
  'negotiation', 'objection', 'resolution_confirmed', 'correction', 'other', 'unclear'] as const;
export const SUPPORT_REQUEST_SERVICES = ['stay', 'corporate', 'celebration', 'spa', 'dining', 'day_outing',
  'activities', 'location', 'resort', 'technical_support', 'sales', 'general', 'other'] as const;
export interface SupportSemanticIntent {
  action: typeof SUPPORT_REQUEST_ACTIONS[number];
  service: typeof SUPPORT_REQUEST_SERVICES[number];
  explicit: boolean;
  topicSwitch: boolean;
  pricingRequested: boolean;
  media: 'none' | 'explicit' | 'helpful';
  confidence: number;
}

export function parseSupportSemanticIntent(value: unknown): SupportSemanticIntent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!(SUPPORT_REQUEST_ACTIONS as readonly unknown[]).includes(item.action)
    || !(SUPPORT_REQUEST_SERVICES as readonly unknown[]).includes(item.service)
    || !['none', 'explicit', 'helpful'].includes(String(item.media))
    || typeof item.explicit !== 'boolean' || typeof item.topicSwitch !== 'boolean'
    || typeof item.pricingRequested !== 'boolean'
    || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
    || item.confidence < 0 || item.confidence > 1) return undefined;
  return { action: item.action, service: item.service, explicit: item.explicit,
    topicSwitch: item.topicSwitch, pricingRequested: item.pricingRequested,
    media: item.media, confidence: item.confidence } as SupportSemanticIntent;
}

export function confidentSemanticIntent(value: unknown): SupportSemanticIntent | undefined {
  const parsed = parseSupportSemanticIntent(value);
  return parsed && parsed.confidence >= 0.85 ? parsed : undefined;
}
