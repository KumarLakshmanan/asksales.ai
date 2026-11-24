import { describe, expect, it } from '@jest/globals';
import { deriveVisibilityAlerts } from '../services/aiVisibility/AlertDetectionService.js';

describe('AI Visibility alert detection', () => {
  it('detects every verified regression and actionable high-impact gap', () => {
    const alerts = deriveVisibilityAlerts({
      currentScore: 61,
      previousScore: 72,
      currentRuns: [{ brandMentioned: true, competitors: ['New Rival', 'Audited Brand'] }],
      previousRuns: [{ brandMentioned: true, competitors: ['Existing Rival'] }, { brandMentioned: true, competitors: [] }],
      currentIssues: [{ ruleId: 'schema.invalid_json_ld' }, { ruleId: 'schema.missing' }],
      previousIssues: [{ ruleId: 'schema.missing' }],
      highImpactRecommendations: [{ id: 4, title: 'Repair structured data' }],
      auditedNames: ['Audited Brand'],
      hasPreviousAudit: true,
    });

    expect(alerts.map((alert) => alert.type).sort()).toEqual([
      'mention_loss', 'new_competitor', 'schema_regression', 'score_decline', 'unresolved_high_impact_fixes',
    ]);
    expect(alerts.find((alert) => alert.type === 'new_competitor')?.evidence).toEqual({ competitors: ['New Rival'] });
  });

  it('does not report a regression when the SEO rule set itself changed between audits', () => {
    const alerts = deriveVisibilityAlerts({
      currentScore: 60,
      previousScore: 72,
      currentRuns: [],
      previousRuns: [],
      currentIssues: [{ ruleId: 'schema.missing', ruleVersion: 4 }, { ruleId: 'schema.incomplete', ruleVersion: 4 }],
      previousIssues: [{ ruleId: 'schema.missing', ruleVersion: 3 }],
      highImpactRecommendations: [],
      auditedNames: ['Brand'],
      hasPreviousAudit: true,
    });
    expect(alerts.map((alert) => alert.type)).not.toEqual(expect.arrayContaining(['schema_regression']));
    expect(alerts.map((alert) => alert.type)).not.toContain('score_decline');
  });

  it('compares schema findings only on pages both analyses crawled', () => {
    const page = (path: string) => `https://example.com${path}`;
    const base = {
      currentRuns: [],
      previousRuns: [],
      highImpactRecommendations: [],
      auditedNames: ['Brand'],
      hasPreviousAudit: true,
    };
    // 4 pages before, 25 now: more pages, more findings, no regression.
    const grown = deriveVisibilityAlerts({
      ...base,
      currentScore: 60,
      previousScore: 72,
      currentPageUrls: Array.from({ length: 25 }, (_, index) => page(`/p${index}/`)),
      previousPageUrls: ['/p0', '/p1', '/p2', '/p3'].map(page),
      currentIssues: Array.from({ length: 25 }, (_, index) => ({ ruleId: 'schema.missing', affectedUrl: page(`/p${index}/`) })),
      previousIssues: ['/p0', '/p1', '/p2', '/p3'].map((path) => ({ ruleId: 'schema.missing', affectedUrl: page(path) })),
    });
    expect(grown.map((alert) => alert.type)).toEqual([]);

    // Same pages, one more page without schema: a real regression.
    const pages = ['/a', '/b', '/c'].map(page);
    const regressed = deriveVisibilityAlerts({
      ...base,
      currentPageUrls: pages,
      previousPageUrls: pages.map((url) => `${url}/`),
      currentIssues: [{ ruleId: 'schema.missing', affectedUrl: pages[0] }, { ruleId: 'schema.missing', affectedUrl: pages[1] }],
      previousIssues: [{ ruleId: 'schema.missing', affectedUrl: `${pages[0]}/` }],
    });
    expect(regressed.find((alert) => alert.type === 'schema_regression')?.evidence).toEqual({ previous: 1, current: 2 });
  });

  it('does not create comparison alerts for the first audit or unchanged evidence', () => {
    const firstAudit = deriveVisibilityAlerts({
      currentScore: 50,
      currentRuns: [{ brandMentioned: false, competitors: ['Observed Rival'] }],
      currentIssues: [{ ruleId: 'schema.missing' }],
      highImpactRecommendations: [],
      auditedNames: ['Brand'],
      hasPreviousAudit: false,
    });
    const unchanged = deriveVisibilityAlerts({
      currentScore: 70,
      previousScore: 70,
      currentRuns: [{ brandMentioned: true, competitors: ['Existing Rival'] }],
      previousRuns: [{ brandMentioned: true, competitors: ['Existing Rival'] }],
      currentIssues: [{ ruleId: 'schema.missing' }],
      previousIssues: [{ ruleId: 'schema.missing' }],
      highImpactRecommendations: [],
      auditedNames: ['Brand'],
      hasPreviousAudit: true,
    });

    expect(firstAudit).toEqual([]);
    expect(unchanged).toEqual([]);
  });
});
