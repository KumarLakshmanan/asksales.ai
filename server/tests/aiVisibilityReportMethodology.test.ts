import { describe, expect, it } from '@jest/globals';
import { buildReportMethodology, reportPillarDisplay } from '../services/aiVisibility/ReportMethodologyService.js';

const base = {
  generatedAt: '2026-08-29T00:00:00.000Z',
  scoringProfile: 'general',
  scoringVersion: 1,
  inputFingerprint: 'fingerprint',
  overallScore: 71,
  pillarStatuses: { seo: 'scored', aeo: 'scored', geo: 'unavailable', commerce: 'not_applicable' } as const,
  pillarScores: { seo: 87, aeo: 48, geo: null, commerce: null },
  normalizedWeights: { seo: 0.5833, aeo: 0.4167, geo: 0, commerce: 0 },
  completedBrandPages: 4,
  failedBrandPages: 2,
  seoIssues: 17,
  aeoQuestions: 3,
  providerRuns: [
    { provider: 'gemini', model: 'gemini-test', fidelity: 'live_api', status: 'failed', citations: [], brandMentioned: null, extractionStatus: 'failed', error: 'Billing denied', extractionError: null },
    { provider: 'openai', model: 'unconfigured', fidelity: 'live_api', status: 'failed', citations: [], brandMentioned: null, extractionStatus: 'failed', error: 'Credential is not configured.', extractionError: null },
  ],
  trackedCompetitors: 0,
  competitorSnapshots: 0,
  commerceSnapshot: null,
};

describe('AI Visibility report methodology', () => {
  it('explains unavailable GEO, not-applicable Commerce, provider failures, and absent competitors without placeholder scores', () => {
    const result = buildReportMethodology(base);

    expect(result.methodologyVersion).toBe(2);
    expect(result.pillars.find((pillar) => pillar.key === 'geo')).toEqual(expect.objectContaining({
      status: 'unavailable', score: null, reason: expect.stringContaining('no live provider/API observation'),
    }));
    expect(result.pillars.find((pillar) => pillar.key === 'commerce')).toEqual(expect.objectContaining({
      status: 'not_applicable', score: null, reason: expect.stringContaining('no real CSV, JSON, XML, or Shopify'),
    }));
    expect(result.providers.find((provider) => provider.provider === 'gemini')?.failureReasons).toEqual(['Billing denied']);
    expect(result.competitors).toEqual(expect.objectContaining({ status: 'not_applicable', tracked: 0, analyzed: 0 }));
    expect(reportPillarDisplay(result.pillars.find((pillar) => pillar.key === 'geo')!)).toBe('Unavailable');
    expect(reportPillarDisplay(result.pillars.find((pillar) => pillar.key === 'commerce')!)).toBe('Not applicable');
  });

  it('records real GEO citations, competitor analysis, and catalog provenance when measured', () => {
    const result = buildReportMethodology({
      ...base,
      pillarStatuses: { seo: 'scored', aeo: 'scored', geo: 'scored', commerce: 'scored' },
      pillarScores: { seo: 87, aeo: 48, geo: 66, commerce: 91 },
      providerRuns: [{ provider: 'gemini', model: 'gemini-test', fidelity: 'live_api', status: 'completed', citations: [{ url: 'https://source.test' }], brandMentioned: true, extractionStatus: 'completed', error: null, extractionError: null }],
      trackedCompetitors: 1,
      competitorSnapshots: 1,
      commerceSnapshot: { sourceType: 'shopify', sourceName: 'store.test', itemCount: 20, validItemCount: 18, inputFingerprint: 'catalog-fingerprint' },
    });

    expect(result.coverage).toEqual(expect.objectContaining({ successfulProviderAnswers: 1, extractedProviderAnswers: 1, citations: 1 }));
    expect(result.competitors).toEqual(expect.objectContaining({ status: 'measured', tracked: 1, analyzed: 1, extractedMentions: 1 }));
    expect(result.commerce).toEqual(expect.objectContaining({ status: 'measured', sourceType: 'shopify', itemCount: 20, validItemCount: 18 }));
    expect(reportPillarDisplay(result.pillars.find((pillar) => pillar.key === 'geo')!)).toBe('66');
  });
});
