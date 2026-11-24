import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getIcpCompleteness } from '../utils/icpCompleteness.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createChatCompletionWithFallback = jest.fn<any>();

jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: {
    createChatCompletionWithFallback,
  },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../models/companySettings/functions.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getBusinessProfileContextByUserId: jest.fn<any>().mockResolvedValue(null),
}));

jest.unstable_mockModule('../services/CreditDeductionHooks.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deductCreditsForICPGeneration: jest.fn<any>().mockResolvedValue(undefined),
}));

const { ICPGenerationService } = await import('../services/ICPGenerationService.js');

describe('ICP generation provider routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scores the final enriched profile including its generated summary', async () => {
    const service = new ICPGenerationService();
    const profile = await service.enrichAndScore({
      campaignName: 'Synthetic hotel campaign', campaignObjective: 'Review hotel search settings',
      targetAudience: 'Boutique hotel owners', industry: 'Hospitality', subIndustry: 'Boutique Hotels',
      targetBusinessModel: 'B2B', primaryRegions: ['Chennai'], primaryJobTitles: ['Owner'], primaryChannels: ['google_maps'],
    });
    expect(profile.summary).toBeTruthy();
    expect(profile.fitScore).toBe(getIcpCompleteness(profile).score);
  });

  it('uses the shared provider-fallback path for intent classification', async () => {
    createChatCompletionWithFallback.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        intent: 'lead_generation',
        confidence: 98,
        reasoning: 'The user wants to find prospects.',
      }),
    });

    const service = new ICPGenerationService();
    const result = await service.detectUserIntent('Find resort guests near Nandi Hills', [], 9, 141);

    expect(result).toBe('lead_generation');
    expect(createChatCompletionWithFallback).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        model: '',
        response_format: { type: 'json_object' },
      }),
    );
  });

  it('uses the shared provider-fallback path for structured ICP generation', async () => {
    createChatCompletionWithFallback.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        campaignName: 'ORO Retreat Guests',
        campaignObjective: 'Find guests for luxury stays',
        targetAudience: 'Affluent travellers near Bangalore',
        targetBusinessModel: 'B2C',
        industry: 'Hospitality',
        primaryRegions: ['Bangalore'],
        primaryJobTitles: [],
        primaryChannels: ['google_maps', 'justdial'],
        primaryPainPoint: 'Finding a private premium retreat',
      }),
    });

    const service = new ICPGenerationService();
    Object.assign(service as object, {
      getExistingICP: jest.fn<any>().mockResolvedValue(null),
      detectUserIntent: jest.fn<any>().mockResolvedValue('lead_generation'),
      calculateFitScore: jest.fn<any>().mockResolvedValue(80),
      validateICP: jest.fn<any>().mockReturnValue({ complete: true, missingFields: [] }),
      enrichICP: jest.fn<any>().mockImplementation(async (profile: unknown) => profile),
    });

    const result = await service.generateICP({
      userMessage: 'Find guests for ORO near Nandi Hills',
      conversationHistory: [],
      userId: 9,
      threadId: 141,
    });

    expect(result.success).toBe(true);
    expect(result.icp?.campaignName).toBe('ORO Retreat Guests');
    expect(createChatCompletionWithFallback).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        model: '',
        response_format: { type: 'json_object' },
      }),
    );
  });
});
