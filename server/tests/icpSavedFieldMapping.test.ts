import { describe, expect, it, jest } from '@jest/globals';
const execute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {} }));
const { ICPGenerationService } = await import('../services/ICPGenerationService.js');
const row = { id: 139, user_id: 1, thread_id: 185, sub_industry: 'Boutique Hotels', primary_value_proposition: 'Reduce manual hotel workflows', fit_score: 81, approved: true, revision: 2, approved_revision: 2 };

describe('saved ICP fields remain available to conversations', () => {
  it.each(['thread', 'latest'])('preserves value proposition, sub-industry and approval in the %s loader', async scope => {
    execute.mockResolvedValue({ rows: [row] });
    const service = new ICPGenerationService();
    const profile = scope === 'thread' ? await service.getICPForThread(1, 185) : await service.getLatestICPForUser(1);
    expect(profile).toMatchObject({ id: 139, subIndustry: 'Boutique Hotels', primaryValueProposition: 'Reduce manual hotel workflows', approved: true, revision: 2, approvedRevision: 2 });
  });
});
