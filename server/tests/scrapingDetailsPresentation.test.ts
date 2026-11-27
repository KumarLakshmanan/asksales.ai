import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../services/apifyCredentialResolver.js', () => ({
  LEAD_PROVIDER_UNAVAILABLE_MESSAGE: 'Lead search isn\'t available right now because the lead data provider isn\'t connected.',
}));
const { presentScrapingDetails } = await import('../services/scrapingDetailsPresentation.js');

const RAW = 'Workflow failed before any leads were saved (linkedin_company_search: Actor execution failed: No Apify API key available for actor harvestapi/linkedin-company-search)';

describe('lead search rows shown in the Leads tab', () => {
  it('replaces an old raw provider error and hides Retry when no provider can run it', async () => {
    const [row] = await presentScrapingDetails([{ platform: 'linkedin_company_search', status: 'failed', error: RAW }], async () => true);
    expect(row.error).toContain("lead data provider isn't connected");
    expect(row.error).not.toMatch(/linkedin_company_search|Apify|harvestapi/);
    expect(row.retryAvailable).toBe(false);
  });

  it('keeps Retry when a provider is available and explains the failure in plain words', async () => {
    const [row] = await presentScrapingDetails([{ platform: 'linkedin', status: 'error', error: RAW }], async () => false);
    expect(row.error).toBe('The lead search could not run, so no leads were saved. The lead data provider is not available right now. Please try again later, or contact support if this continues.');
    expect(row.retryAvailable).toBe(true);
  });

  it('does not check providers when nothing failed', async () => {
    const check = jest.fn(async () => true);
    const rows = await presentScrapingDetails([{ platform: 'linkedin', status: 'completed', error: null }], check);
    expect(check).not.toHaveBeenCalled();
    expect(rows[0]).not.toHaveProperty('retryAvailable');
  });
});
