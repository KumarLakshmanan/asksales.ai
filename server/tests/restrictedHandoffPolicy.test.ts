import { describe, expect, it } from '@jest/globals';
import { permittedHandoffReason, prepareNonHandoffFallback } from '../services/agents/orchestration/RestrictedHandoffPolicy.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { NLUResult } from '../services/agents/NLUService.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';

const ctx = (text = '0'): PipelineContext => ({
  message: { userId: 9, conversationId: 461, channel: 'whatsapp', senderIdentifier: 'test', inboundText: text },
  metadata: { ownerHandoffPolicy: { mode: 'customer_requests_only', bookingSearchUrl: 'https://bookings.orocircle.com/?propertyId=10955' } },
  confidence: 0, policyViolations: [],
});
const nlu = (changes: Partial<NLUResult> = {}): NLUResult => ({
  intent: 'faq', secondaryIntents: [], entities: {}, sentiment: { label: 'neutral', score: 0 },
  urgency: 'low', needsHuman: true, summary: '', riskLevel: 'low', riskFactors: [], classificationConfidence: 0.95, ...changes,
});

describe('owner-restricted automatic handoff policy', () => {
  it.each(['Knowledge evidence is insufficient', 'Conflicting published information', 'Confidence score 0.1'])(
    'offers a human without falsely claiming a handoff for %s', reason => {
      const c=ctx(); c.nlu=nlu({needsHuman:false});
      prepareNonHandoffFallback(c,reason);
      expect(c.agentResult?.replyText).toContain('I’m not sure');
      expect(c.agentResult?.replyText).toContain('Would you like me to connect you with a human support agent?');
      expect(c.agentResult?.effectProposals).toEqual([]);
      expect(c.agentResult?.escalated).toBe(false);
      expect(permittedHandoffReason(c)).toBeNull();
      c.nlu=nlu({intent:'speak_to_human',semanticRequest:semanticIntent('human')});
      expect(permittedHandoffReason(c)).toBe('customer_requested_human');
    });
  it('allows a high-confidence refund classification', () => {
    const c = ctx(); c.nlu = nlu({ intent: 'refund_request' });
    expect(permittedHandoffReason(c)).toBe('refund_request');
  });
  it('does not turn a bare speak_to_human classification into a ticket', () => {
    const c = ctx('Tomorrow at 7 PM'); c.nlu = nlu({ intent: 'speak_to_human' });
    expect(permittedHandoffReason(c)).toBeNull();
  });
  it.each(['Please refund me', 'I want a refund', 'Please connect me to a human', 'I need a manager'])('does not infer intent from words during an outage: %s', text => {
    expect(permittedHandoffReason(ctx(text))).toBeNull();
  });
  it.each(['refund', 'human'] as const)('uses the model decision for %s', action => {
    const c = ctx('A paraphrased customer request');
    c.nlu = nlu({ semanticRequest: semanticIntent(action) });
    expect(permittedHandoffReason(c)).toBeTruthy();
    c.nlu.semanticRequest!.explicit = false;
    expect(permittedHandoffReason(c)).toBeNull();
  });
  it.each(["I don't want a refund", "Don't connect me to a human", 'What is your refund policy?', 'Please book one room', '0'])('does not invent permission from %s', text => {
    expect(permittedHandoffReason(ctx(text))).toBeNull();
  });
  it('requires severe customer-relationship evidence, not ordinary frustration', () => {
    const c = ctx('Your team repeatedly failed to resolve my complaint.');
    c.nlu = nlu({ intent: 'complaint', riskLevel: 'high', sentiment: { label: 'negative', score: -0.95 }, riskFactors: ['repeated_unresolved_complaint'] });
    expect(permittedHandoffReason(c)).toBe('severe_customer_relationship');
    c.nlu.sentiment.score = -0.5;
    expect(permittedHandoffReason(c)).toBeNull();
    c.nlu.sentiment.score = -0.95; c.nlu.classificationConfidence = 0.3;
    expect(permittedHandoffReason(c)).toBeNull();
  });
  it.each(['classification_unavailable', 'self_harm', 'financial_loss', 'prompt_injection'])('does not create a ticket solely for %s', factor => {
    const c = ctx(); c.nlu = nlu({ riskLevel: 'critical', riskFactors: [factor] });
    expect(permittedHandoffReason(c)).toBeNull();
  });
  it('recognizes a severe repeated relationship breakdown independently of financial risk', () => {
    const c = ctx('Five complaints remain unresolved and I have lost all trust.');
    c.nlu = nlu({ intent: 'complaint', riskLevel: 'medium', sentiment: { label: 'negative', score: -0.98 },
      riskFactors: ['repeated_unresolved_complaint', 'relationship_breakdown'] });
    expect(permittedHandoffReason(c)).toBe('severe_customer_relationship');
    c.nlu.riskFactors = ['extreme_dissatisfaction'];
    expect(permittedHandoffReason(c)).toBeNull();
    c.nlu.riskFactors = ['repeated_unresolved_complaint', 'relationship_breakdown'];
    c.nlu.sentiment.score = -0.5;
    expect(permittedHandoffReason(c)).toBeNull();
  });
  it('does not give an unrelated secrets warning for a non-severe complaint review', () => {
    const c = ctx(); c.nlu = nlu({ intent: 'complaint' });
    prepareNonHandoffFallback(c, 'Intent or risk policy requires human review.');
    expect(c.agentResult?.replyText).toContain('what remains unresolved');
    expect(c.agentResult?.replyText).not.toMatch(/password|card|ticket|support team/);
  });
  it('does not treat menu choices or callback consent as requests for a person', () => {
    const c = ctx('yes'); c.nlu = nlu({ intent: 'speak_to_human' });
    c.metadata!.activePlaybookSelection = { value: 'true' };
    expect(permittedHandoffReason(c)).toBeNull();
  });
  it('preserves all other owners existing policies and ignores caller metadata', () => {
    const c = ctx(); c.metadata = {};
    c.message.metadata = { ownerHandoffPolicy: { mode: 'customer_requests_only' } };
    expect(permittedHandoffReason(c)).toBe('existing_policy');
  });
  it.each(['Intent and risk classification is unavailable.', 'AI provider unavailable', 'Confidence score 0.1', 'Sensitive content could not be placed in the restricted privacy vault.', 'Detected potential prompt injection attempt.'])('replaces the rejected draft without tools/media or handoff claims: %s', reason => {
    const c = ctx(); c.agentResult = { replyText: 'UNSAFE ORIGINAL: support team contacted', escalated: true, confidence: 0 };
    c.metadata!.playbookDirective = { choice: { fallbackText: 'REJECTED CHOICE' } };
    prepareNonHandoffFallback(c, reason);
    expect(c.agentResult?.replyText).not.toMatch(/UNSAFE|contacted|ticket|queued|REJECTED/);
    expect(c.agentResult?.effectProposals).toEqual([]);
    expect(c.agentResult?.escalated).toBe(false);
    expect(c.metadata?.suppressBusinessEffects).toBe(true);
    expect(c.metadata?.playbookDirective.choice).toBeUndefined();
  });
  it('offers an approved search URL with zero children preserved and no personal data', () => {
    const c = ctx(); c.metadata!.playbookDirective = { journey: { fields: Object.fromEntries(Object.entries({
      'stay.checkIn': '2026-10-01', 'stay.checkOut': '2026-10-02', 'stay.adults': 2, 'stay.children': 0, 'stay.rooms': 1, 'contact.fullName': 'Private Name',
    }).map(([key,value]) => [key,{value,status:'collected'}])) } };
    prepareNonHandoffFallback(c, 'Verified availability failed');
    expect(c.agentResult?.replyText).toContain('propertyId=10955');
    expect(c.agentResult?.replyText).toContain('children=0');
    expect(c.agentResult?.replyText).not.toContain('Private Name');
    expect(c.agentResult?.replyText).toContain('No booking or payment has been confirmed');
  });
  it('does not route a safety rejection into booking or transactional actions', () => {
    const c = ctx(); c.metadata!.playbookDirective = { capability: { name: 'checkout.continue' } };
    prepareNonHandoffFallback(c, 'Safety review is unavailable');
    expect(c.agentResult?.replyText).not.toContain('https://');
    expect(c.agentResult?.effectProposals).toEqual([]);
  });
  it('preserves emergency guidance without automatic ticket creation', () => {
    const c = ctx(); c.nlu = nlu({ riskFactors: ['self_harm'] });
    prepareNonHandoffFallback(c, 'Critical risk detected');
    expect(c.agentResult?.replyText).toContain('emergency services');
    expect(permittedHandoffReason(c)).toBeNull();
  });
});
