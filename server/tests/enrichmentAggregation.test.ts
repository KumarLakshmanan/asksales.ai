import { describe, expect, it, jest } from '@jest/globals';
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {} }));
jest.unstable_mockModule('../services/WebsiteCrawlerService.js', () => ({ WebsiteCrawlerService: class {} }));
const { aggregateResults, mergeExtractedInfos, discoverNewHandles } = await import('../services/enrichment/helpers.js');
const { queueSecondaryActors } = await import('../services/enrichment/platformActors.js');

describe('enrichment source and candidate boundaries', () => {
  it('does not replace the subject with an employer or its follower statistics', () => {
    const result = aggregateResults([
      { isSubject: true, platform: 'linkedin', identifier: 'https://linkedin.com/in/tholiamanan', rawData: {}, extractedInfo: {
        emails: [], phones: [], websites: [], person: { fullName: 'Manan Tholia' }, socialProfiles: { linkedin: 'https://linkedin.com/in/tholiamanan' },
      } },
      { platform: 'website', identifier: 'https://celebaltech.com', rawData: {}, extractedInfo: {
        emails: ['Hiring@celebaltech.com'], phones: ['26.8345538', '+11038733556', '+911414700658'], websites: ['https://lnkd.in/abc'],
        person: { fullName: 'Employer' }, socialProfiles: { linkedin: 'https://linkedin.com/company/celebaltech' }, socialStats: { followersCount: 3327 }, company: { domain: 'linkedin.com' },
      } },
    ]);
    expect(result.person.fullName).toBe('Manan Tholia');
    expect(result.socialProfiles.linkedin).toBe('https://linkedin.com/in/tholiamanan');
    expect(result.socialStats).toEqual({});
    expect(result.phones).toEqual(['+911414700658']);
    expect(result.emails).toEqual(['hiring@celebaltech.com']);
    expect(result.websites).toEqual([]);
    expect(result.company.domain).toBeUndefined();
  });
  it('validates merged LLM arrays before deduplication and preserves URL path case', () => {
    expect(mergeExtractedInfos({ phones: ['26.8345538'] }, { phones: ['268345538'], websites: ['https://site.test/A', 'https://site.test/a'] }))
      .toMatchObject({ phones: ['268345538'], websites: ['https://site.test/A', 'https://site.test/a'] });
  });
  it('does not crawl YouTube legal contacts or short links as company websites', () => {
    const handles = discoverNewHandles({ websites: ['https://lnkd.in/abc'], socialProfiles: { youtube: 'https://youtube.com/@celebaltech', linkedin: 'https://linkedin.com/company/celebaltech' } }, 'website', new Set());
    expect(handles).toEqual([{ platform: 'linkedin', subType: 'company', identifier: 'https://linkedin.com/company/celebaltech', source: 'website_scrape' }]);
  });
  it('does not feed a bare linkedin.com company domain to the company actor', () => {
    expect(queueSecondaryActors('linkedin', 'manan', { company: { domain: 'linkedin.com' } }, new Set())).toEqual([]);
  });
});
