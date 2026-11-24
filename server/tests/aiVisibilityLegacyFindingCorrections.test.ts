import { describe, expect, it } from '@jest/globals';
import {
  alertRecommendationIds,
  isWithdrawnGapFix,
  withoutWithdrawnFixes,
  isWithdrawnLegacyRecommendation,
  isWithdrawnLegacyRobotsFinding,
} from '../services/aiVisibility/LegacyFindingCorrections.js';

// The rules a WordPress/WooCommerce robots.txt stored in an older audit (aimplifylabs.com).
const wordpress = {
  robotsDisallow: [
    '/wp-content/uploads/wc-logs/',
    '/wp-content/uploads/woocommerce_transient_files/',
    '/wp-content/uploads/woocommerce_uploads/',
    '/*?add-to-cart=',
    '/*?*add-to-cart=',
    '/wp-admin/',
  ],
};

describe('withdrawing robots findings from the pre-version-4 check', () => {
  it('withdraws pages the stored rules never blocked', () => {
    for (const url of ['https://aimplifylabs.com/', 'https://aimplifylabs.com/about-us/', 'https://aimplifylabs.com/service/agent/'])
      expect(isWithdrawnLegacyRobotsFinding('robots.disallowed_page', url, wordpress)).toBe(true);
  });

  it('keeps pages the stored rules do block', () => {
    expect(isWithdrawnLegacyRobotsFinding('robots.disallowed_page', 'https://aimplifylabs.com/wp-admin/options.php', wordpress)).toBe(false);
    expect(isWithdrawnLegacyRobotsFinding('robots.disallowed_page', 'https://aimplifylabs.com/shop/?add-to-cart=5', wordpress)).toBe(false);
    expect(isWithdrawnLegacyRobotsFinding('robots.disallowed_page', 'https://example.com/private', { robotsDisallow: ['/'] })).toBe(false);
  });

  it('leaves current-engine findings, other rules and findings without stored rules alone', () => {
    expect(isWithdrawnLegacyRobotsFinding('robots.disallowed_page', 'https://aimplifylabs.com/', { ...wordpress, matchedRule: 'Disallow: /' })).toBe(false);
    expect(isWithdrawnLegacyRobotsFinding('robots.disallowed_page', 'https://aimplifylabs.com/', {})).toBe(false);
    expect(isWithdrawnLegacyRobotsFinding('schema.missing', 'https://aimplifylabs.com/', wordpress)).toBe(false);
    expect(isWithdrawnLegacyRobotsFinding('robots.disallowed_page', null, wordpress)).toBe(false);
  });

  it('withdraws the fixes made from those findings, including fixes with only the old generated title', () => {
    const fix = { module: 'seo', title: 'robots · disallowed page', affectedUrl: 'https://aimplifylabs.com/', evidence: wordpress };
    expect(isWithdrawnLegacyRecommendation(fix)).toBe(true);
    expect(isWithdrawnLegacyRecommendation({ ...fix, title: 'Page blocked', evidence: { ...wordpress, ruleId: 'robots.disallowed_page' } })).toBe(true);
    expect(isWithdrawnLegacyRecommendation({ ...fix, affectedUrl: 'https://aimplifylabs.com/wp-admin/' })).toBe(false);
    expect(isWithdrawnLegacyRecommendation({ ...fix, module: 'aeo' })).toBe(false);
  });

  it('withdraws content-brief fixes whose competitor gap the current comparison no longer shows', () => {
    const current = new Map([[1, new Set(['1:contact'])]]);
    const brief = (key: string, competitorId = 1) => ({
      module: 'competitor',
      evidence: { competitorId, competitorGapKey: key, pageType: key.split(':')[1] },
    });
    expect(isWithdrawnGapFix(brief('1:blog'), current)).toBe(true);
    expect(isWithdrawnGapFix(brief('1:contact'), current)).toBe(false);
    // A competitor missing from the comparison (disabled since) keeps its fixes.
    expect(isWithdrawnGapFix(brief('2:blog', 2), current)).toBe(false);
    expect(isWithdrawnGapFix({ module: 'seo', evidence: { competitorId: 1, competitorGapKey: '1:blog' } }, current)).toBe(false);
  });

  it('recounts the open high-impact fixes alert without the withdrawn fixes', () => {
    const alert = {
      id: 7,
      type: 'unresolved_high_impact_fixes',
      message: '14 high-impact recommendations remain open after this analysis.',
      evidence: { count: 14, recommendationIds: [184, 187, 188, 190], titles: ['h1', 'links', 'robots', 'robots'] },
    };
    expect(alertRecommendationIds(alert)).toEqual([184, 187, 188, 190]);
    const corrected = withoutWithdrawnFixes(alert, new Set([188, 190]));
    expect(corrected?.message).toBe('12 high-impact recommendations remain open after this analysis.');
    expect(corrected?.evidence).toMatchObject({ count: 12, titles: ['h1', 'links'], recommendationIds: [184, 187], withdrawnRecommendationIds: [188, 190] });
    expect(withoutWithdrawnFixes(alert, new Set([999]))).toBe(alert);
    const onlyWithdrawn = { ...alert, evidence: { count: 1, recommendationIds: [188] } };
    expect(withoutWithdrawnFixes(onlyWithdrawn, new Set([188]))).toBeNull();
    const other = { type: 'score_decline', message: 'Score fell', evidence: { recommendationIds: [188] } };
    expect(withoutWithdrawnFixes(other, new Set([188]))).toBe(other);
  });
});
