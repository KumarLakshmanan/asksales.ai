import { describe, expect, it } from '@jest/globals';
import { getIcpCompleteness, ICP_SCORABLE_FIELDS, icpDraftReceipt } from '../utils/icpCompleteness.js';
import { icpProfilesTable } from '../models/icpData/schema.js';
import { buildAgentContext } from '../mastra/utils/contextManager.js';

describe('ICP completeness facts and review receipts', () => {
  it('uses the same persisted fields for scoring and explanations', () => {
    const profile: Record<string, unknown> = Object.fromEntries(ICP_SCORABLE_FIELDS.map(field => [field, 'Known']));
    profile.budgetRange = ''; profile.targetRevenueRange = null; profile.summary = undefined;
    expect(getIcpCompleteness(profile)).toMatchObject({ score: 80, totalFields: 15, missingFields: ['summary', 'targetRevenueRange', 'budgetRange'] });
    expect(getIcpCompleteness(profile).filledFields).toContain('primaryValueProposition');
  });
  it('can reach 100% using only fields retained by the saved profile schema', () => {
    for (const field of ICP_SCORABLE_FIELDS) expect(icpProfilesTable).toHaveProperty(field);
    expect(getIcpCompleteness(Object.fromEntries(ICP_SCORABLE_FIELDS.map(field => [field, 'Known']))).score).toBe(100);
    expect(getIcpCompleteness({ companyGrowthStage: 'Growth' }).score).toBe(0);
  });
  it('keeps a legacy saved score authoritative when answering a read-only question', () => {
    const profile = { campaignName: 'Saved campaign', targetAudience: 'Hotel owners', summary: 'Saved summary', fitScore: 56 };
    const context = buildAgentContext({ icpProfile: profile } as never);
    expect(context).toContain('"score":56,"scoreSource":"saved_profile"');
    expect(context).toContain('Do not recalculate or replace the saved score');
    expect(profile.fitScore).toBe(56);
  });
  it('does not count empty strings, arrays or objects as supplied fields', () => {
    expect(getIcpCompleteness({ primaryRegions: [], budgetRange: {}, industry: '  ' }).score).toBe(0);
  });
  it('acknowledges a saved draft without claiming approval, prospects or predicted results', () => {
    const receipt = icpDraftReceipt({ revision: 2, fitScore: 81 });
    expect(receipt).toContain('Saved ICP draft revision 2');
    expect(receipt).toContain('81% completeness');
    expect(receipt).toContain('before approving');
    expect(receipt).toContain('has not started a lead search or outreach');
    expect(receipt).not.toMatch(/locked in|high.precision target list|strong engagement/);
  });
});
