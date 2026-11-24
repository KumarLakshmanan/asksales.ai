import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { marketingIntentFromRouter } from '../services/agents/intent/marketingIntent.js';
import { intentWith } from './helpers/semanticIntent.js';
const classify = jest.fn<(...args: any[]) => Promise<any>>();
const complete = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: jest.fn<any>() } }));
jest.unstable_mockModule('../services/agents/intent/IntentClassifierService.js', () => ({ classifyIntent: classify }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: complete } }));
const { ICPGenerationService } = await import('../services/ICPGenerationService.js');
beforeEach(() => { jest.resetAllMocks(); classify.mockResolvedValue(null); });
describe('ICP shared classifier', () => {
  it.each(['content_creation', 'lead_generation', 'outreach', 'performance_marketing', 'general'])('uses configured classification for %s without another completion', async intent => {
    classify.mockResolvedValue({ choices: { intent }, confidence: 0.99 });
    const history = [{ role: 'assistant', content: 'Should I send the campaign?' }];
    expect(await new ICPGenerationService().detectUserIntent('Only prepare a template; do not send.', history, 4, 10)).toBe(intent);
    expect(classify.mock.calls[0][0].messages.slice(1)).toEqual([...history, { role: 'user', content: 'Only prepare a template; do not send.' }]);
    expect(complete).not.toHaveBeenCalled();
  });
  it('retains full-model fallback for uncertainty and general on total failure', async () => {
    complete.mockResolvedValueOnce({ success: true, content: JSON.stringify({ intent: 'performance_marketing', confidence: 99 }) });
    const service = new ICPGenerationService();
    expect(await service.detectUserIntent('Show paid campaign performance', [], 4)).toBe('performance_marketing');
    complete.mockResolvedValueOnce({ success: false });
    expect(await service.detectUserIntent('Unresolved request', [], 4)).toBe('general');
  });
  it('does not call providers without a tenant', async () => {
    expect(await new ICPGenerationService().detectUserIntent('Find leads')).toBe('general');
    expect(classify).not.toHaveBeenCalled();
  });
  it('reuses only an unambiguous current router goal', () => {
    expect(marketingIntentFromRouter(intentWith({}, { hiredAgents: ['icp_generation', 'outreach'] }))).toBe('outreach');
    expect(marketingIntentFromRouter(intentWith({}, { hiredAgents: ['content_studio'] }))).toBe('content_creation');
    expect(marketingIntentFromRouter(intentWith({}, { hiredAgents: ['lead_generation', 'content_studio'] }))).toBeUndefined();
    expect(marketingIntentFromRouter(intentWith({}, { hiredAgents: ['outreach'], needsClarification: true }))).toBeUndefined();
    expect(marketingIntentFromRouter(intentWith({}, { hiredAgents: ['outreach'], action: 'cancel' }))).toBeUndefined();
  });
});
