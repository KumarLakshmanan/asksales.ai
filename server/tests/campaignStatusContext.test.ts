import { describe, expect, it } from '@jest/globals';
import { campaignNextStepButtons, describeCampaignStatus } from '../mastra/utils/campaignStatusContext.js';

describe('campaign status for the Coordinator', () => {
  it('reports a failed lead search in plain words and offers to open the leads', () => {
    const run = { stage: 'needs_attention', status: 'failed', context: { leadGenerationError: 'linkedin_company_search: Actor execution failed: No Apify API key available' } };
    const text = describeCampaignStatus(run);
    expect(text).toContain('Needs attention: The lead search could not run, so no leads were saved.');
    expect(text).not.toMatch(/linkedin_company_search|Apify/);
    expect(campaignNextStepButtons(run)).toEqual([
      { id: 'next_step_leads', label: 'Open leads', action: 'OPEN_TAB', type: 'secondary', data: { tabType: 'leads' } },
    ]);
  });

  it('tells the router selected leads are the audience', () => {
    const text = describeCampaignStatus({ stage: 'outreach_ready', status: 'awaiting_input' }, 3);
    expect(text).toContain('Leads are chosen; the next step is preparing outreach.');
    expect(text).toContain('already selected 3 existing leads');
    expect(text).toContain('do not ask them to import or upload an audience');
  });

  it('adds nothing when there is no campaign step and no selection', () => {
    expect(describeCampaignStatus(null)).toBe('');
    expect(campaignNextStepButtons(null)).toEqual([]);
    expect(campaignNextStepButtons({ stage: 'lead_executing', status: 'running' })).toEqual([]);
  });
});
