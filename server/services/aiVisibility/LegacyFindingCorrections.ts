import { parseRobotsPolicy, robotsAllows } from './RobotsPolicy.js';

/**
 * Corrections for findings stored by older SEO checks that are known to be wrong.
 *
 * Before rule version 4 the robots check cut each Disallow rule at its first "*", so a
 * WordPress rule such as `/*?add-to-cart=` became `/` and every page was reported as
 * "blocked by robots.txt". Those findings stored the Disallow rules they relied on
 * (`evidence.robotsDisallow`), so the current robots engine can re-check them exactly.
 * Allow rules were not stored, and they can only unblock a page, so a page the stored
 * Disallow rules don't block was never blocked. Only those findings are withdrawn; the
 * stored rows are left as they are.
 */
const AUDIT_AGENT = 'Googlebot';
const LEGACY_ROBOTS_TITLE = 'robots · disallowed page';

export function isWithdrawnLegacyRobotsFinding(
  ruleId: string | null | undefined,
  url: string | null | undefined,
  evidence: unknown,
): boolean {
  if (ruleId !== 'robots.disallowed_page' || !url) return false;
  const stored = (evidence || {}) as Record<string, unknown>;
  // Version 4 findings name the rule that matched; they come from the current engine.
  if (stored.matchedRule !== undefined || !Array.isArray(stored.robotsDisallow)) return false;
  const rules = stored.robotsDisallow.filter(
    (rule): rule is string => typeof rule === 'string' && !/[\r\n]/.test(rule),
  );
  const groups = parseRobotsPolicy(
    ['User-agent: *', ...rules.map((rule) => `Disallow: ${rule}`)].join('\n'),
  );
  return robotsAllows(url, groups, AUDIT_AGENT);
}

/** The SEO rule behind a fix: stored on newer fixes, or recoverable from an older generated title. */
function recommendationRuleId(item: { module: string; title: string; evidence: unknown }) {
  if (item.module !== 'seo') return null;
  const stored = (item.evidence || {}) as Record<string, unknown>;
  if (typeof stored.ruleId === 'string') return stored.ruleId;
  return item.title === LEGACY_ROBOTS_TITLE ? 'robots.disallowed_page' : null;
}

export function isWithdrawnLegacyRecommendation(item: {
  module: string;
  title: string;
  affectedUrl: string | null;
  evidence: unknown;
}): boolean {
  return isWithdrawnLegacyRobotsFinding(recommendationRuleId(item), item.affectedUrl, item.evidence);
}

/**
 * A content-brief fix made from a competitor content gap that the analysis's current
 * comparison no longer shows (older page types missed /blogs/ and similar sections).
 * Fixes for a competitor that is not in the comparison are left alone.
 */
export function isWithdrawnGapFix(
  item: { module: string; evidence: unknown },
  currentGapKeys: ReadonlyMap<number, ReadonlySet<string>>,
): boolean {
  if (item.module !== 'competitor') return false;
  const stored = (item.evidence || {}) as Record<string, unknown>;
  if (typeof stored.competitorGapKey !== 'string' || typeof stored.competitorId !== 'number') return false;
  const keys = currentGapKeys.get(stored.competitorId);
  return Boolean(keys) && !keys!.has(stored.competitorGapKey);
}

/** Fix ids an "open high-impact fixes" alert counted, from its stored evidence. */
export function alertRecommendationIds(alert: { type: string; evidence: unknown }): number[] {
  if (alert.type !== 'unresolved_high_impact_fixes') return [];
  const ids = ((alert.evidence || {}) as Record<string, unknown>).recommendationIds;
  return Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id)) : [];
}

/**
 * The same alert without the withdrawn fixes it counted: recounted and reworded, or null
 * when nothing it counted is left. Other alerts are returned unchanged.
 */
export function withoutWithdrawnFixes<
  T extends { type: string; message: string; evidence: unknown },
>(alert: T, withdrawnIds: ReadonlySet<number>): T | null {
  const ids = alertRecommendationIds(alert);
  const removed = ids.filter((id) => withdrawnIds.has(id));
  if (!removed.length) return alert;
  const stored = (alert.evidence || {}) as Record<string, unknown>;
  const before = typeof stored.count === 'number' ? stored.count : ids.length;
  const count = Math.max(0, before - removed.length);
  if (!count) return null;
  // `titles` holds the titles of the first ids, in the same order.
  const titles = Array.isArray(stored.titles)
    ? stored.titles.filter((_, index) => !withdrawnIds.has(ids[index]))
    : stored.titles;
  return {
    ...alert,
    message: `${count} high-impact recommendation${count === 1 ? '' : 's'} remain open after this analysis.`,
    evidence: {
      ...stored,
      count,
      titles,
      recommendationIds: ids.filter((id) => !withdrawnIds.has(id)),
      withdrawnRecommendationIds: removed,
    },
  };
}
