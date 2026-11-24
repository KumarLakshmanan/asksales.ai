import { describe, expect, it } from '@jest/globals';
import { buildAiVisibilityCsv } from '../services/aiVisibility/ReportExportService.js';

const base = {
  audit: { id: 17, status: 'completed_with_warnings', trigger: 'manual', actualCredits: '22.50', createdAt: '2026-08-15T00:00:00.000Z', completedAt: '2026-08-15T00:05:00.000Z' },
  project: { name: 'Orbit', domain: 'https://orbit.test', scoringProfile: 'b2b_saas' },
  score: { overallScore: '74', seoScore: '80', aeoScore: '70', geoScore: '72', commerceScore: null, pillarStatuses: { seo: 'scored', aeo: 'scored', geo: 'scored', commerce: 'not_applicable' }, inputFingerprint: 'abc123', scoringVersion: 1 },
  issues: [{ ruleId: 'links.broken', group: 'technical', severity: 'high', affectedUrl: 'https://orbit.test/help', recommendation: 'Repair the verified broken link.', evidence: { statusCode: 404 } }],
  promptRuns: [{ provider: 'openai', model: 'gpt-test', status: 'completed', fidelity: 'live_api', brandMentioned: true, brandRank: 2, sentiment: 'positive', citations: [{ url: 'https://source.test' }], extractionStatus: 'completed', error: null, extractionError: null, promptText: 'Which tools help sales teams?' }],
  recommendations: [{ module: 'seo', title: 'Repair links', status: 'open', severity: 'high', impact: 'high', effort: 'low', affectedUrl: 'https://orbit.test/help', description: 'Replace or remove broken targets.' }],
  competitors: [{ name: 'Rival', domain: 'https://rival.test', metrics: { shareOfVoice: 0.4 }, contentGaps: [{ pageType: 'pricing' }] }],
};

describe('AI Visibility CSV export', () => {
  it('exports scores, verified issues, provider observations, recommendations and competitors', () => {
    const csv = buildAiVisibilityCsv(base);

    expect(csv).toContain('"record_type","section","name"');
    expect(csv).toContain('"score","scores","SEO","scored","80"');
    expect(csv).toContain('"seo_issue","technical","links.broken"');
    expect(csv).toContain('"provider_observation","geo","Which tools help sales teams?"');
    expect(csv).toContain('"recommendation","seo","Repair links"');
    expect(csv).toContain('"competitor","competitive_visibility","Rival"');
  });

  it('retains unavailable pillar status instead of inventing a score', () => {
    const csv = buildAiVisibilityCsv({ ...base, score: { ...base.score, geoScore: null, pillarStatuses: { ...base.score.pillarStatuses, geo: 'unavailable' } }, promptRuns: [{ ...base.promptRuns[0], status: 'failed', brandMentioned: null, extractionStatus: 'failed', error: 'Provider unavailable' }] });

    expect(csv).toContain('"score","scores","GEO","unavailable",""');
    expect(csv).toContain('No live provider/API observation returned an answer.');
  });

  it('exports provider failure evidence and an explicit competitor measurement state', () => {
    const csv = buildAiVisibilityCsv({ ...base, promptRuns: [{ ...base.promptRuns[0], status: 'failed', brandMentioned: null, error: 'Billing denied', extractionStatus: 'failed' }], competitors: [] });

    expect(csv).toContain('Billing denied');
    expect(csv).toContain('"competitor_status","competitive_visibility","Competitor analysis","not_measured"');
  });

  it('neutralizes spreadsheet formulas in customer-controlled fields', () => {
    const csv = buildAiVisibilityCsv({ ...base, project: { ...base.project, name: '=HYPERLINK("https://bad.test")' }, recommendations: [{ ...base.recommendations[0], title: '-2+3', description: '+SUM(1,1)' }] });

    expect(csv).toContain('"\'=HYPERLINK(""https://bad.test"")"');
    expect(csv).toContain('"\'-2+3"');
    expect(csv).toContain('"\'+SUM(1,1)"');
    expect(csv).not.toContain(',"=HYPERLINK');
  });
});
