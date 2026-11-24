import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const classifyJevLeadSemanticsBatch = jest.fn<any>();
const createProviderForUser = jest.fn<any>();
const createChatCompletion = jest.fn<any>();
jest.unstable_mockModule('../services/lead-generation/JevLeadSemanticService.js', () => ({
  classifyJevLeadSemanticsBatch,
  JEV_LEAD_BATCH_SIZE: 4,
  JEV_LEAD_MAX_BATCHES: 2,
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: { createProviderForUser },
}));
jest.unstable_mockModule('../services/CreditDeductionHooks.js', () => ({
  deductCreditsForLead: jest.fn<any>().mockResolvedValue(undefined),
}));

const { LeadScoringService } = await import('../services/LeadScoringService.js');
const previousScoringFlag = process.env.LEAD_SCORING;

beforeEach(() => {
  process.env.LEAD_SCORING = 'false';
  jest.clearAllMocks();
  createProviderForUser.mockResolvedValue({ defaultModel: 'test-model', createChatCompletion });
  createChatCompletion.mockResolvedValue({ success: true, content: JSON.stringify({
    score: 50, reasoning: 'test result', qualityScore: 12, relevanceScore: 13, engagementScore: 12, fitScore: 13,
  }) });
});
afterAll(() => {
  if (previousScoringFlag === undefined) delete process.env.LEAD_SCORING;
  else process.env.LEAD_SCORING = previousScoringFlag;
});

describe('Jev lead scoring bands', () => {
  it('applies a small qualitative band adjustment while preserving deterministic completeness and metrics', async () => {
    const lead = { id: 3, email: 'lead@example.test', source: 'directory' };
    process.env.LEAD_SCORING = 'true';
    const baselineService = new LeadScoringService();
    classifyJevLeadSemanticsBatch
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([[0, {
        industry: 'match', audience: 'possible', band: 'strong_fit',
      }]]));

    const baseline = await baselineService.scoreLead(9, lead, { industry: 'Technology' });
    const qualified = await new LeadScoringService().scoreLead(9, lead, { industry: 'Technology' });

    expect(qualified.breakdown).toEqual(baseline.breakdown);
    expect(qualified.score).toBe(baseline.score + 6);
    expect(qualified.semanticFit).toEqual({ industry: 'match', audience: 'possible', band: 'strong_fit' });
    expect(qualified.insights).toContain('Semantic relevance band: strong fit.');
    expect(qualified.semanticFit).not.toHaveProperty('confidence');
    expect(qualified.llmScore?.score).toBe(baseline.llmScore?.score);
  });

  it('limits bulk semantic review to two bounded batches instead of one call per lead', async () => {
    process.env.LEAD_SCORING = 'true';
    classifyJevLeadSemanticsBatch.mockImplementation(async (_userId: number, candidates: object[]) =>
      new Map(candidates.map((_candidate, index) => [index, {
        industry: 'match', audience: 'match', band: 'qualified_fit' as const,
      }])));
    const leads = Array.from({ length: 11 }, (_, index) => ({
      id: index + 1,
      email: `lead${index}@example.test`,
      source: 'directory',
    }));

    const result = await new LeadScoringService().scoreAndRankLeads(9, leads, { industry: 'Technology' });

    expect(classifyJevLeadSemanticsBatch).toHaveBeenCalledTimes(2);
    expect(classifyJevLeadSemanticsBatch.mock.calls.map((call) => (call[1] as object[]).length)).toEqual([4, 4]);
    expect(result.filter((item) => item.semanticFit).length).toBe(8);
    expect(result.filter((item) => item.semanticFit?.band === 'qualified_fit').every((item) => item.score > 0)).toBe(true);
  });

  it('uses unknown as a neutral band and clamps poor-fit adjustments', async () => {
    process.env.LEAD_SCORING = 'true';
    const lead = { email: 'lead@example.test', source: 'directory' };
    const service = new LeadScoringService();
    createChatCompletion
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ score: 50, reasoning: '', qualityScore: 12, relevanceScore: 13, engagementScore: 12, fitScore: 13 }) })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ score: 4, reasoning: '', qualityScore: 1, relevanceScore: 1, engagementScore: 1, fitScore: 1 }) });
    classifyJevLeadSemanticsBatch
      .mockResolvedValueOnce(new Map([[0, { industry: 'unknown', audience: 'unknown', band: 'unknown' }]]))
      .mockResolvedValueOnce(new Map([[0, { industry: 'conflict', audience: 'conflict', band: 'poor_fit' }]]));

    const unknown = await service.scoreLead(9, lead, { industry: 'Technology' });
    const poorFit = await service.scoreLead(9, lead, { industry: 'Technology' });
    expect(unknown.score).toBe(unknown.llmScore?.score);
    expect(poorFit.score).toBe(0);
    expect(poorFit.breakdown).toEqual(unknown.breakdown);
  });

  it('does not classify standalone or bulk scores while lead scoring is disabled', async () => {
    const service = new LeadScoringService();
    const lead = { email: 'lead@example.test', source: 'directory' };
    await service.scoreLead(9, lead, { industry: 'Technology' });
    await service.scoreAndRankLeads(9, [lead, { ...lead, id: 2 }], { industry: 'Technology' });
    expect(classifyJevLeadSemanticsBatch).not.toHaveBeenCalled();
    expect(createProviderForUser).not.toHaveBeenCalled();
  });
});
