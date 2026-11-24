import { beforeEach, describe, expect, it, jest } from '@jest/globals';

/* eslint-disable @typescript-eslint/no-explicit-any */
const createProvider = jest.fn<any>();
const findCampaign = jest.fn<any>();
const generateProposalFromKB = jest.fn<any>();
const logWarn = jest.fn();
const logError = jest.fn();

jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: logWarn, error: logError, info: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({ businessOwnerUserId: () => 7, businessCacheKey: () => 'k' }));
jest.unstable_mockModule('../models/campaigns/functions', () => ({ CampaignModel: { findByIdForUser: findCampaign } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createProviderForUser: createProvider } }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
class ProposalWorkflowError extends Error { constructor(message: string, public readonly statusCode = 400) { super(message); } }
jest.unstable_mockModule('../services/ProposalService.js', () => ({ proposalService: { generateProposalFromKBAndProfile: generateProposalFromKB }, ProposalWorkflowError }));
jest.unstable_mockModule('../services/ReminderService.js', () => ({ reminderService: {} }));
jest.unstable_mockModule('../services/IdempotencyService.js', () => ({ idempotencyService: {} }));
jest.unstable_mockModule('../services/ProposalDocumentService.js', () => ({ ProposalDocumentError: class extends Error { statusCode = 400; } }));
jest.unstable_mockModule('../utils/emailTemplates.js', () => ({ getBrandInfo: jest.fn() }));

const { LLMProviderResponseError } = await import('../services/agents/LLMProviderErrors.js');
const { ContentTextGenerationError, providerGenerationFailure } = await import('../services/content/ContentTextGenerationError.js');
const { requestAICampaignPlan } = await import('../controllers/campaignController.js');
const { generateProposal } = await import('../controllers/proposalController.js');

const providerBody = 'upstream 500 {"error":"sk-live-secret leaked body"}';

function response() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

describe('provider failure classification for generators', () => {
  it('classifies provider responses and setup errors, never application errors', () => {
    expect(providerGenerationFailure(new LLMProviderResponseError('429 Too Many Requests', 'openai', 'gpt'), 'a proposal')?.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(providerGenerationFailure(new Error('No active LLM API keys configured. Please ask an administrator to configure an AI provider.'), 'an ICP')?.code).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(providerGenerationFailure(new Error('No LLM provider configured for this user.'), 'a campaign')?.message).toMatch(/^Campaign generation is unavailable/);
    expect(providerGenerationFailure(new Error('connect ECONNREFUSED 10.0.0.5:5432'), 'a proposal')).toBeNull();
    expect(new ContentTextGenerationError(providerBody, 'a campaign plan').message).not.toMatch(/secret|upstream/);
  });
});

describe('campaign plan generation', () => {
  beforeEach(() => { jest.clearAllMocks(); findCampaign.mockResolvedValue({ id: 3, name: 'Spring' }); });
  const request = () => ({ params: { id: '3' }, body: { message: 'Plan a launch' } }) as any;

  it('answers a failed provider response with a classified error and no provider body', async () => {
    createProvider.mockResolvedValue({ defaultModel: 'm', createChatCompletion: async () => ({ success: false, error: providerBody }) });
    const res = response();
    await requestAICampaignPlan(request(), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ success: false, code: 'AI_PROVIDER_FAILED' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|upstream|details/);
  });

  it('says the provider is not configured when no AI key exists', async () => {
    createProvider.mockRejectedValue(new Error('No active LLM API keys configured. Please ask an administrator to configure an AI provider.'));
    const res = response();
    await requestAICampaignPlan(request(), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'AI_PROVIDER_NOT_CONFIGURED', error: expect.stringMatching(/^Campaign plan generation is unavailable/) });
  });

  it('keeps unexpected failures generic and retryable without raw details', async () => {
    findCampaign.mockRejectedValue(new Error('relation "campaigns" does not exist'));
    const res = response();
    await requestAICampaignPlan(request(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, code: 'CAMPAIGN_PLAN_GENERATION_FAILED', error: expect.stringMatching(/try again/) });
  });
});

describe('proposal generation', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('classifies a provider failure instead of echoing the provider body', async () => {
    generateProposalFromKB.mockRejectedValue(new ContentTextGenerationError('Request timed out', 'a proposal'));
    const res = response();
    await generateProposal({ body: { title: 'Q3' } } as any, res);
    expect(res.statusCode).toBe(504);
    expect(res.body).toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', error: 'The AI provider timed out before returning a proposal. Please try again.' });
  });

  it('keeps workflow errors and hides unexpected ones', async () => {
    generateProposalFromKB.mockRejectedValue(new ProposalWorkflowError('Choose a contact first', 400));
    const workflow = response();
    await generateProposal({ body: { title: 'Q3' } } as any, workflow);
    expect(workflow.statusCode).toBe(400);
    generateProposalFromKB.mockRejectedValue(new Error('password authentication failed for user "app"'));
    const unexpected = response();
    await generateProposal({ body: { title: 'Q3' } } as any, unexpected);
    expect(unexpected.statusCode).toBe(500);
    expect(JSON.stringify(unexpected.body)).not.toMatch(/password/);
  });
});
