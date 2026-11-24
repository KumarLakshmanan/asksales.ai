import type { SupportSemanticIntent } from '../../services/agents/orchestration/SupportSemanticIntent.js';

/** Explicit model output fixture, never inferred from the test message. */
export function semanticIntent(action: SupportSemanticIntent['action'], service: SupportSemanticIntent['service'] = 'other',
  overrides: Partial<SupportSemanticIntent> = {}): SupportSemanticIntent {
  return { action, service, explicit: true, topicSwitch: false, pricingRequested: false,
    media: 'none', confidence: 0.99, ...overrides };
}
