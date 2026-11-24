import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const classify = jest.fn<any>();
const complete = jest.fn<any>();
const execute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/agents/intent/IntentClassifierService.js', () => ({ classifyIntent: classify }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: complete } }));
jest.unstable_mockModule('../services/CreditDeductionHooks.js', () => ({ deductCreditsForSentimentAnalysis: jest.fn<any>() }));
const { sentimentAnalysisService: service } = await import('../services/SentimentAnalysisService.js');
const { SentimentStage } = await import('../services/agents/pipeline/stages/SentimentStage.js');
const { crmService } = await import('../services/CRMService.js');
beforeEach(() => { jest.resetAllMocks(); classify.mockResolvedValue(null); });
describe('shared sentiment classification', () => {
  it.each([
    ['negative', 'strong', -0.8], ['negative', 'mild', -0.4],
    ['neutral', 'mild', 0], ['positive', 'mild', 0.4], ['positive', 'strong', 0.8],
  ])('maps %s/%s to ordinal intensity, not confidence', async (label, intensity, score) => {
    classify.mockResolvedValue({ choices: { 'sentiment.label': label, intensity }, confidence: 0.97 });
    expect(await service.analyzeSentiment(4, 'Synthetic text')).toEqual({ sentiment: label, score, keywords: [] });
    expect(complete).not.toHaveBeenCalled();
  });
  it('falls back for a partial decision and validates fallback output', async () => {
    classify.mockResolvedValue({ choices: { 'sentiment.label': 'negative' }, confidence: 0.99 });
    complete.mockResolvedValueOnce({ success: true, content: '{"sentiment":"negative","score":-0.7,"keywords":["disappointed",12]}' });
    expect(await service.analyzeSentiment(4, 'I am disappointed')).toEqual({ sentiment: 'negative', score: -0.7, keywords: ['disappointed'] });
    complete.mockResolvedValueOnce({ success: true, content: '{"sentiment":"won","score":0.99}' });
    expect((await service.analyzeSentiment(4, 'Thanks')).sentiment).toBe('neutral');
  });
  it('returns neutral on provider outage and skips empty text', async () => {
    complete.mockRejectedValueOnce(new Error('offline'));
    expect((await service.analyzeSentiment(4, 'Hello')).sentiment).toBe('neutral');
    classify.mockClear();
    expect((await service.analyzeSentiment(4, '  ')).sentiment).toBe('neutral');
    expect(classify).not.toHaveBeenCalled();
  });
  it.each(['new', 'interested', 'demo', 'negotiable', 'won', 'lost'])('never promotes or closes %s from emotion', status => {
    for (const tone of ['positive', 'neutral', 'negative']) {
      expect(service.mapSentimentToStatus(tone, status)).toBe(status);
      expect(crmService.mapSentimentToPipelineStage(tone, status)).toBe(status);
    }
  });
  it.each(['whatsapp', 'instagram', 'facebook', 'email', 'web'])('%s reuses the same NLU sentiment without another billable call', async channel => {
    const ctx = { message: { userId: 4, channel, inboundText: 'Not happy', metadata: { dryRun: true } },
      nlu: { sentiment: { label: 'negative', score: -0.8 } } } as any;
    await new SentimentStage().execute(ctx);
    expect(ctx.sentiment).toEqual({ sentiment: 'negative', score: -0.8, keywords: [] });
    expect(classify).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
