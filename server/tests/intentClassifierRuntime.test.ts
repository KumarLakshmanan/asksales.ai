import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intentWith } from './helpers/semanticIntent.js';
import { semanticIntent } from './helpers/supportSemanticFixture.js';
const decisions = jest.fn<(state: any, questions: Record<string, unknown>) => Promise<any>>();
const campaignCompletion = jest.fn<(...args: any[]) => Promise<any>>();
const supportCompletion = jest.fn<(...args: any[]) => Promise<any>>();
const selection = jest.fn<(...args: any[]) => any>();
const credentials = jest.fn<() => Promise<any>>();
jest.unstable_mockModule('../models/intentClassifierCredentials/functions.js', () => ({
  getActiveClassifierCredentials: credentials, markClassifierCredentialUsed: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {
  createClassifierProvider: selection, createChatCompletionWithFallback: supportCompletion,
} }));
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: campaignCompletion }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitAgentStatus: jest.fn() } }));
const { IntentRiskClassifierStage } = await import('../services/agents/pipeline/stages/IntentRiskClassifierStage.js');
const { runUnifiedRouter } = await import('../mastra/unifiedRouter.js');
let thread = 18000;
function decisionResponse(output: any, questions: Record<string, unknown>, confidence = 0.99) {
  return { answers: Object.fromEntries(Object.keys(questions).map(path => {
    let value: any = output;
    for (const part of path.split('.')) value = Array.isArray(value) ? value.includes(part) : value?.[part];
    return [path, { type: 'choice', choice: String(value), confidence }];
  })) };
}
const completion = (output: unknown) => ({ success: true, content: JSON.stringify(output) });
const state = (text: string) => ({ userId: 1, threadId: ++thread, messages: [
  { role: 'assistant', content: 'We were reviewing LinkedIn leads. What should I do next?' }, { role: 'user', content: text },
] } as any);
const supportOutput = (action: Parameters<typeof semanticIntent>[0], service: Parameters<typeof semanticIntent>[1], extra = {}) => ({
  intent: 'booking_request', semanticRequest: semanticIntent(action, service), entities: {},
  secondaryIntents: [], sentiment: { label: 'neutral', score: 0 }, urgency: 'low', needsHuman: false,
  riskLevel: 'low', riskFactors: [], classificationConfidence: 0.99, summary: 'Synthetic request', ...extra,
});
beforeEach(() => {
  jest.resetAllMocks();
  credentials.mockResolvedValue([{ id: 27, platform: 'openrouter', apiKey: 'classifier-key', isActive: true, config: { model: 'typesafe/jev-1.13' } }]);
  selection.mockReturnValue({ defaultModel: 'typesafe/jev-1.13', createIntentDecisions: decisions });
});
it('passes trusted simulation scope to both support classifiers without granting consent', async () => {
  const output = supportOutput('information','corporate',{contactPreference:'unchanged'});
  decisions.mockImplementation(async (state,questions) => {
    expect(state.contract).toContain('TRUSTED SURFACE');
    expect(state.contract).toContain('preview is never consent');
    return decisionResponse(output,questions);
  });
  supportCompletion.mockImplementation(async (_user,options) => {
    expect(options.messages[0].content).toContain('do not by themselves withdraw');
    return completion(output);
  });
  const ctx:any={message:{userId:1,inboundText:'Explore a corporate event. Preview only, do not send customer messages.',metadata:{executionMode:'preview',conversationKind:'owner_support'}},metadata:{}};
  await new IntentRiskClassifierStage().execute(ctx);
  expect(ctx.nlu.needsHuman).toBe(false); expect(ctx.nlu.contactPreferenceVerified).not.toBe(true);
  expect(ctx.nlu.semanticRequest).toMatchObject({service:'corporate',action:'information'});
});
describe('campaign Jev runtime integration', () => {
  it('uses Jev for a realistic long campaign context without truncating the latest request', async () => {
    const latest = 'Explain the saved campaign analytics only. Do not approve, send, publish, or spend anything.';
    const output = intentWith({ status: 'none' }, { action: 'question', hiredAgents: ['performance_marketing'], nextAgent: 'performance_marketing' });
    const input = state(latest);
    input.companyProfile = { companyName: 'Example', description: 'Business context '.repeat(900) };
    input.messages.unshift({ role: 'user', content: 'Old campaign plan '.repeat(1800) });
    decisions.mockImplementation(async (classifierState, questions) => {
      expect(classifierState.contract).toContain('A classifier decision never authorizes execution');
      expect(classifierState.conversation.at(-1)).toMatchObject({ role: 'user', content: latest });
      expect(Buffer.byteLength(JSON.stringify({ state: classifierState, questions }), 'utf8')).toBeLessThanOrEqual(30_000);
      return decisionResponse(output, questions);
    });
    campaignCompletion.mockResolvedValue(completion(output));
    expect((await runUnifiedRouter(input)).nextAgent).toBe('performance_marketing');
    expect(decisions).toHaveBeenCalledTimes(1);
    expect(campaignCompletion.mock.calls[0][1].messages.some((message: { content: string }) => message.content.includes('Business context '))).toBe(true);
  });

  it('keeps read-only analytics with safety prohibitions out of the approval-status route', async () => {
    const output = intentWith({ status: 'none' }, { action: 'question', hiredAgents: ['performance_marketing'], nextAgent: 'performance_marketing' });
    decisions.mockImplementation(async (_state, questions) => {
      expect(JSON.stringify(questions['semanticRequest.status'])).toContain('not safety prohibitions or old pending cards');
      expect(JSON.stringify(questions['semanticRequest.status'])).toContain('Performance analytics');
      return decisionResponse(output, questions);
    });
    campaignCompletion.mockResolvedValue(completion(output));
    const result = await runUnifiedRouter(state('@sarah Show saved campaign analytics and charts. Do not create reviews, publish, schedule or spend.'));
    expect(result).toMatchObject({ action: 'question', nextAgent: 'performance_marketing', semanticRequest: { status: 'none' } });
    expect(campaignCompletion.mock.calls[0][1].messages[0].content).toContain('It must not be replaced with an approval-status summary');
  });

  it('invalidates routing reuse when the administrator changes the classifier', async () => {
    const output = intentWith({}, { action: 'question' });
    decisions.mockImplementation(async (_state, questions) => decisionResponse(output, questions));
    campaignCompletion.mockResolvedValue(completion(output));
    const input = state('Explain the current campaign.');
    await runUnifiedRouter(input);
    await runUnifiedRouter(input);
    expect(campaignCompletion).toHaveBeenCalledTimes(1);
    credentials.mockResolvedValue([{ id: 28, platform: 'gemini', apiKey: 'classifier-key', isActive: true, config: { model: 'gemini-2.5-flash' } }]);
    selection.mockReturnValue({ defaultModel: 'gemini-2.5-flash', createChatCompletion: async () => completion({ answers: {} }) });
    await runUnifiedRouter(input);
    expect(selection).toHaveBeenLastCalledWith(1, expect.objectContaining({ platform: 'gemini' }));
    expect(campaignCompletion).toHaveBeenCalledTimes(2);
  });
  it.each(['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'])('routes %s using classifier labels plus full-model extraction', async agent => {
    const output = intentWith({}, { hiredAgents: [agent], nextAgent: agent });
    decisions.mockImplementation(async (_state, questions) => decisionResponse(output, questions));
    campaignCompletion.mockResolvedValue(completion(output));
    expect((await runUnifiedRouter(state('Prepare the requested work, no execution.'))).nextAgent).toBe(agent);
    expect(decisions).toHaveBeenCalledTimes(1);
    expect(campaignCompletion.mock.calls[0][1].messages[1].content).toContain('Intent classification');
  });
  it('keeps a compound lead → content request ordered and excludes outreach', async () => {
    const output = intentWith({ contentOperation: 'generate' }, { hiredAgents: ['lead_generation', 'content_studio'], nextAgent: 'lead_generation', mode: 'hire_team' });
    decisions.mockImplementation(async (_state, questions) => decisionResponse(output, questions));
    campaignCompletion.mockResolvedValue(completion(output));
    const result = await runUnifiedRouter(state('Find leads, then write a post, but no outreach.'));
    expect(result.hiredAgents).toEqual(['lead_generation', 'content_studio']);
  });
  it('reclassifies disagreements independently, never merges an inconsistent plan', async () => {
    const classified = intentWith({}, { action: 'question' });
    const actual = intentWith({}, { action: 'revise' });
    decisions.mockImplementation(async (_state, questions) => decisionResponse(classified, questions));
    campaignCompletion.mockResolvedValueOnce(completion(actual)).mockResolvedValueOnce(completion(actual));
    expect((await runUnifiedRouter(state('Change the selected review.'))).action).toBe('revise');
    expect(campaignCompletion).toHaveBeenCalledTimes(2);
    expect(campaignCompletion.mock.calls[1][1].messages.some((m: any) => m.content.startsWith('Intent classification'))).toBe(false);
  });
  it('falls back for uncertain labels without changing saved approvals', async () => {
    const output = intentWith({}, { action: 'question' });
    decisions.mockImplementation(async (_state, questions) => decisionResponse(output, questions, 0.7));
    campaignCompletion.mockResolvedValue(completion(output));
    const input = state('Why? Do not proceed.');
    input.pendingApproval = { id: 'review-1', args: { limit: 25 } };
    await runUnifiedRouter(input);
    expect(input.pendingApproval).toEqual({ id: 'review-1', args: { limit: 25 } });
    expect(campaignCompletion).toHaveBeenCalledTimes(1);
    expect(campaignCompletion.mock.calls[0][1].messages.some((m: any) => m.content.startsWith('Intent classification'))).toBe(false);
  });
});
describe('shared inbound support channel classification', () => {
  it.each(['web', 'whatsapp', 'email'])('%s preserves a service switch and a later correction despite negated execution', async channel => {
    const history = [{ role: 'assistant', content: 'Could you share your company name?' }];
    const cases = [
      { text: 'Forget the corporate event. Explore a spa appointment instead; do not book anything.',
        output: supportOutput('information', 'spa', { intent: 'faq', contactPreference: 'unchanged',
          semanticRequest: semanticIntent('information', 'spa', { topicSwitch: true }) }) },
      { text: 'September 30, 2026 at 3 PM. This is still only a preview.',
        output: supportOutput('continue', 'spa', { contactPreference: 'unchanged',
          entities: { 'service.dateTime': 'September 30, 2026 at 3 PM' } }) },
      { text: 'Correction: make it 4 PM on September 30, not 3 PM. No contact details or confirmation yet.',
        output: supportOutput('correction', 'spa', { contactPreference: 'unchanged',
          entities: { 'service.dateTime': 'September 30, 2026 at 4 PM' } }) },
    ];
    for (const { text, output } of cases) {
      decisions.mockImplementation(async (_state, questions) => decisionResponse(output, questions));
      supportCompletion.mockResolvedValue(completion(output));
      const ctx = { message: { userId: 1, channel, inboundText: text, metadata: { conversationHistory: [...history] } } } as any;
      await new IntentRiskClassifierStage().execute(ctx);
      expect(ctx.nlu.semanticRequest).toMatchObject({ ...output.semanticRequest });
      expect(ctx.nlu.entities).toEqual(output.entities);
      expect(ctx.nlu.contactPreference).toBe('unchanged');
      history.push({ role: 'user', content: text });
    }
    expect(decisions).toHaveBeenCalledTimes(3);
    expect(supportCompletion).toHaveBeenCalledTimes(3);
  });
  it('preserves a confident contact withdrawal even when no service journey applies', async () => {
    const output = supportOutput('unclear', 'general', { intent: 'clarify', contactPreference: 'opt_out' });
    decisions.mockImplementation(async (_state, questions) => decisionResponse(output, questions));
    supportCompletion.mockResolvedValue(completion(output));
    const ctx = { message: { userId: 1, channel: 'whatsapp', inboundText: 'Please leave me alone and stop all future messages.', metadata: {} } } as any;
    await new IntentRiskClassifierStage().execute(ctx);
    expect(ctx.nlu.contactPreference).toBe('opt_out');
    expect(ctx.nlu.contactPreferenceVerified).toBe(true);
    expect(ctx.nlu.classificationConfidence).toBeGreaterThanOrEqual(0.95);
    expect(decisions).toHaveBeenCalledTimes(1);
  });
  it('does not trust model-supplied opt-out verification when that classifier field was deferred', async () => {
    const output = supportOutput('unclear', 'general', { intent: 'clarify', contactPreference: 'opt_out', contactPreferenceVerified: true });
    decisions.mockImplementation(async (_state, questions) => {
      const response = decisionResponse(output, questions);
      delete response.answers.contactPreference;
      return response;
    });
    supportCompletion.mockResolvedValue(completion(output));
    const ctx = { message: { userId: 1, channel: 'whatsapp', inboundText: 'Maybe later.', metadata: {} } } as any;
    await new IntentRiskClassifierStage().execute(ctx);
    expect(ctx.nlu.contactPreferenceVerified).not.toBe(true);
    expect(ctx.nlu.classificationConfidence).toBe(0);
    expect(ctx.nlu.riskFactors).toContain('contact_preference_unverified');
  });
  it('does not persist a paraphrased opt-out from the extractor alone during classifier outage', async () => {
    decisions.mockRejectedValue(new Error('offline'));
    supportCompletion.mockResolvedValue(completion(supportOutput('unclear', 'general', {
      intent: 'clarify', contactPreference: 'opt_out', contactPreferenceVerified: true,
    })));
    const ctx = { message: { userId: 1, channel: 'email', inboundText: 'Please leave me alone.', metadata: {} } } as any;
    await new IntentRiskClassifierStage().execute(ctx);
    expect(ctx.nlu.contactPreferenceVerified).not.toBe(true);
    expect(ctx.nlu.classificationConfidence).toBe(0);
    expect(ctx.nlu.riskFactors).toContain('contact_preference_unverified');
  });
  it.each(['whatsapp', 'instagram', 'facebook', 'email', 'webchat'])('%s uses Jev through the shared pipeline with multi-message context', async channel => {
    const output = supportOutput('continue', 'spa', { entities: { 'service.dateTime': '24 September at 4 PM' } });
    decisions.mockImplementation(async (_state, questions) => decisionResponse(output, questions));
    supportCompletion.mockResolvedValue(completion(output));
    const ctx = { message: { userId: 1, channel, inboundText: '24 September at 4 PM', metadata: { conversationHistory: [
      { role: 'user', content: 'Book a spa visit' }, { role: 'assistant', content: 'Which date and time?' },
    ] } } } as any;
    await new IntentRiskClassifierStage().execute(ctx);
    expect(ctx.nlu.semanticRequest).toMatchObject({ action: 'continue', service: 'spa', topicSwitch: false });
    expect(ctx.nlu.entities['service.dateTime']).toBe('24 September at 4 PM');
    expect(decisions.mock.calls[0][0].conversation[0].content).toContain('Which date and time?');
    expect(supportCompletion.mock.calls[0][1].messages[1].content).toContain('Intent classification');
  });
  it('uses a fresh classifier for a multilingual change of topic, then preserves a human handoff', async () => {
    const stage = new IntentRiskClassifierStage();
    const spa = supportOutput('booking', 'spa', { semanticRequest: semanticIntent('booking', 'spa', { topicSwitch: true }) });
    const human = supportOutput('human', 'general', { intent: 'speak_to_human', needsHuman: true });
    decisions.mockImplementationOnce(async (_state, questions) => decisionResponse(spa, questions)).mockImplementationOnce(async (_state, questions) => decisionResponse(human, questions));
    supportCompletion.mockResolvedValueOnce(completion(spa)).mockResolvedValueOnce(completion(human));
    const ctx = { message: { userId: 1, channel: 'whatsapp', inboundText: 'மசாஜ் செய்ய நேரம் ஒதுக்க முடியுமா?', metadata: {} } } as any;
    await stage.execute(ctx);
    expect(ctx.nlu.semanticRequest.service).toBe('spa');
    ctx.message.inboundText = 'Please connect me to a person instead.';
    await stage.execute(ctx);
    expect(ctx.nlu.needsHuman).toBe(true);
    expect(decisions).toHaveBeenCalledTimes(2);
  });
  it('falls back on disagreement and fails closed when both providers fail', async () => {
    const output = supportOutput('document', 'corporate', { intent: 'faq' });
    decisions.mockImplementation(async (_state, questions) => decisionResponse(output, questions));
    supportCompletion.mockResolvedValueOnce(completion(supportOutput('booking', 'stay'))).mockResolvedValueOnce(completion(output));
    const ctx = { message: { userId: 1, channel: 'instagram', inboundText: 'Share the corporate brochure', metadata: {} } } as any;
    await new IntentRiskClassifierStage().execute(ctx);
    expect(ctx.nlu.semanticRequest.action).toBe('document');
    expect(supportCompletion).toHaveBeenCalledTimes(2);
    decisions.mockRejectedValueOnce(new Error('offline'));
    supportCompletion.mockRejectedValueOnce(new Error('offline'));
    await new IntentRiskClassifierStage().execute(ctx);
    expect(ctx.nlu).toMatchObject({ intent: 'clarify', needsHuman: true, classificationConfidence: 0 });
  });
});
