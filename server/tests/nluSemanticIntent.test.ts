import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { semanticIntent } from './helpers/supportSemanticFixture.js';
import { DEFAULT_CRM_CONFIGURATION } from '../../shared/crmConfiguration.js';
import { UNCHANGED_CRM_DECISION } from '../../shared/crmPipeline.js';
const chat = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {
  createChatCompletionWithFallback: chat,
} }));
const { NLUService } = await import('../services/agents/NLUService.js');
const { confidentSemanticIntent } = await import('../services/agents/orchestration/SupportSemanticIntent.js');
const classification = (semanticRequest: unknown, extra = {}) => ({ content: JSON.stringify({
  intent: 'faq', semanticRequest, entities: {}, needsHuman: false,
  riskLevel: 'low', riskFactors: [], classificationConfidence: 0.99, ...extra,
}) });
beforeEach(() => { jest.resetAllMocks(); });
describe('model-owned support intent', () => {
  const crmPipeline = { currentStageKey: 'contacted', stages: [DEFAULT_CRM_CONFIGURATION.stages[0],
    DEFAULT_CRM_CONFIGURATION.stages[1], { key: 'accepted', label: 'Order accepted', type: 'won' as const }] };
  it('supplies the configured stage catalog and validates a custom acceptance decision', async () => {
    chat.mockResolvedValueOnce(classification(semanticIntent('other'), { intent: 'purchase_intent',
      crmStageDecision: { stageKey: 'accepted', outcome: 'won', evidence: 'explicit_acceptance', confidence: 0.98 },
    }));
    const result = await new NLUService().analyze(9, 'I accept the quotation we discussed.', undefined, { crmPipeline });
    expect(result.crmStageDecision).toEqual({ stageKey: 'accepted', outcome: 'won', evidence: 'explicit_acceptance', confidence: 0.98 });
    expect(chat.mock.calls[0][1].messages[0].content).toContain('Order accepted');
    expect(chat.mock.calls[0][1].messages[0].content).toContain('Negative sentiment');
  });
  it.each([
    undefined, { stageKey: 'invented', outcome: 'won', evidence: 'explicit_acceptance', confidence: 1 },
    { stageKey: 'accepted', outcome: 'lost', evidence: 'explicit_rejection', confidence: 1 },
    { stageKey: 'accepted', outcome: 'won', evidence: 'progress', confidence: 1 },
  ])('keeps CRM unchanged for missing, invented or mismatched stage decisions: %j', async crmStageDecision => {
    chat.mockResolvedValueOnce(classification(semanticIntent('information'), { crmStageDecision }));
    const result = await new NLUService().analyze(9, 'What is the refund policy?', undefined, { crmPipeline });
    expect(result.crmStageDecision).toEqual(UNCHANGED_CRM_DECISION);
    expect(result.semanticRequest?.action).toBe('information');
    expect(result.needsHuman).toBe(false);
  });
  it('caps CRM outcome confidence at the overall model confidence', async () => {
    chat.mockResolvedValueOnce(classification(semanticIntent('other'), { classificationConfidence: 0.9,
      crmStageDecision: { stageKey: 'accepted', outcome: 'won', evidence: 'explicit_acceptance', confidence: 1 },
    }));
    const result = await new NLUService().analyze(9, 'Sounds fine, perhaps.', undefined, { crmPipeline });
    expect(result.crmStageDecision?.confidence).toBe(0.9);
  });
  it.each(['greeting', 'smalltalk'])('does not turn a confident %s with no business action into an outage', async intent => {
    chat.mockResolvedValueOnce(classification(semanticIntent('unclear', 'general', { confidence: 0.91 }), {
      intent, entities: { rooms: 3 }, classificationConfidence: 0.91,
    }));
    const result = await new NLUService().analyze(9, 'Hi');
    expect(result.intent).toBe(intent);
    expect(result.needsHuman).toBe(false);
    expect(result.riskFactors).not.toContain('classification_unavailable');
    expect(result.semanticRequest).toMatchObject({ action:'other', explicit:false, topicSwitch:false });
    expect(result.entities).toEqual({});
  });
  it.each([
    { intent:'booking_request' }, { intent:'greeting', riskLevel:'critical' },
    { intent:'greeting', needsHuman:true }, { intent:'greeting', classificationConfidence:0.4 },
  ])('does not authorize an unclear action with risk or uncertainty: %j', async extra => {
    chat.mockResolvedValueOnce(classification(semanticIntent('unclear'), extra));
    const result = await new NLUService().analyze(9, 'Ambiguous request');
    expect(result.riskFactors).toContain('classification_unavailable');
    expect(result.needsHuman).toBe(true);
  });
  it.each(['Hi', 'Namaste', 'வணக்கம்', 'good morning!'])('sends even greetings to the model: %s', async text => {
    chat.mockResolvedValueOnce(classification(semanticIntent('other'), { intent: 'greeting' }));
    expect((await new NLUService().analyze(9, text)).intent).toBe('greeting');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].messages[1].content).toContain(text);
  });
  it.each([
    ["I'd like to book a Spa Slot", semanticIntent('booking', 'spa', { topicSwitch: true })],
    ['Could you please share the corporate brochure and pricing details for the one day office setup?', semanticIntent('document', 'corporate', { pricingRequested: true })],
    ['மசாஜ் செய்ய நேரம் ஒதுக்க முடியுமா?', semanticIntent('booking', 'spa', { topicSwitch: true })],
    ["Don't book the spa", semanticIntent('booking', 'spa', { explicit: false })],
  ])('passes model decisions through without phrase-based overrides: %s', async (text, request) => {
    chat.mockResolvedValueOnce(classification(request));
    const nlu = await new NLUService().analyze(9, text as string, 'Agent: How many nights for the corporate event?');
    expect(nlu.semanticRequest).toEqual(request);
    const prompt = chat.mock.calls[0][1].messages[0].content;
    expect(prompt).toContain('Classify meaning, not keywords');
    expect(prompt).toContain('history resolves references');
  });
  it.each(['Hi', 'book spa', 'send corporate brochure', 'I want a human'])('never guesses from text during provider outage: %s', async text => {
    chat.mockRejectedValueOnce(new Error('Provider unavailable'));
    const nlu = await new NLUService().analyze(9, text);
    expect(nlu).toMatchObject({ intent: 'clarify', classificationConfidence: 0 });
    expect(nlu.semanticRequest).toBeUndefined();
  });
  it.each([undefined, {}, { ...semanticIntent('document'), action: 'invented' },
    { ...semanticIntent('booking', 'spa'), confidence: 1.5 }])('rejects missing or invalid semantic output', async request => {
    chat.mockResolvedValueOnce(classification(request));
    const nlu = await new NLUService().analyze(9, 'book spa');
    expect(nlu.semanticRequest).toBeUndefined();
    expect(nlu.intent).toBe('clarify');
    expect(nlu.classificationConfidence).toBe(0);
  });
  it('caps semantic confidence at overall model confidence', async () => {
    chat.mockResolvedValueOnce(classification(semanticIntent('booking', 'spa'), { classificationConfidence: 0.4 }));
    const nlu = await new NLUService().analyze(9, 'book spa');
    expect(nlu.classificationConfidence).toBe(0);
    expect(nlu.intent).toBe('clarify');
    expect(confidentSemanticIntent(nlu.semanticRequest)).toBeUndefined();
  });
  it('requests a canonical appointment field and distinguishes continuation from a fresh booking', async () => {
    chat.mockResolvedValueOnce(classification(semanticIntent('continue', 'spa'), {
      intent: 'booking_request', entities: { 'service.dateTime': '23 September 2026 at 4 PM' },
    }));
    const nlu = await new NLUService().analyze(9, '23 September 2026 at 4 PM',
      'Agent: What date and time would work best for you?');
    expect(nlu.semanticRequest?.action).toBe('continue');
    expect(nlu.entities['service.dateTime']).toBe('23 September 2026 at 4 PM');
    const prompt = chat.mock.calls[0][1].messages[0].content;
    expect(prompt).toContain('Do not split it into appointmentDate and appointmentTime');
    expect(prompt).toContain("Do not copy a date/time from history");
  });
});
