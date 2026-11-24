import { describe, expect, it } from '@jest/globals';
import { shouldRequireDirectHumanHandoff } from '../services/agents/orchestration/HandoffIntentPolicy.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';

describe('direct handoff intent policy', () => {
  it('lets the semantic request decide despite conflicting advisory flags', () => {
    const base = { text: 'A customer response', riskLevel: 'low' as const, riskFactors: [] };
    expect(shouldRequireDirectHumanHandoff({ ...base, intent: 'speak_to_human', modelNeedsHuman: true,
      semanticRequest: semanticIntent('continue', 'stay') })).toBe(false);
    expect(shouldRequireDirectHumanHandoff({ ...base, intent: 'speak_to_human', modelNeedsHuman: true,
      semanticRequest: semanticIntent('human', 'general', { explicit: false }) })).toBe(false);
    expect(shouldRequireDirectHumanHandoff({ ...base, intent: 'faq', modelNeedsHuman: false,
      semanticRequest: semanticIntent('human') })).toBe(true);
  });
  it('does not let a model-only flag hijack a low-risk external booking request', () => {
    expect(shouldRequireDirectHumanHandoff({
      text: 'Please send the external booking page.',
      intent: 'booking_request',
      riskLevel: 'low',
      riskFactors: [],
      modelNeedsHuman: true,
    })).toBe(false);
  });

  it('preserves explicit person requests and critical risk handoffs', () => {
    expect(shouldRequireDirectHumanHandoff({
      text: 'Please connect me to a human agent.', intent: 'support_request', riskLevel: 'low', riskFactors: [], modelNeedsHuman: true,
      semanticRequest: semanticIntent('human'),
    })).toBe(true);
    expect(shouldRequireDirectHumanHandoff({
      text: 'This is an emergency.', intent: 'other', riskLevel: 'critical', riskFactors: [], modelNeedsHuman: false,
    })).toBe(true);
  });
});
