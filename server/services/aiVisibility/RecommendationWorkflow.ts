import { createHash } from 'node:crypto';
import type { aiVisibilityRecommendationsTable } from '../../models/aiVisibility/schema.js';

type Recommendation = typeof aiVisibilityRecommendationsTable.$inferInsert;

export function recommendationKey(
  item: Pick<Recommendation, 'module' | 'title' | 'affectedUrl' | 'evidence'>,
): string {
  const evidence = item.evidence || {};
  // Historical SEO titles were generated from the rule ID, so use the same
  // normalized representation to carry status across the migration.
  const identity =
    item.module === 'seo'
      ? item.title
          .toLowerCase()
          .replace(/[·._]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : item.module === 'competitor'
        ? evidence.competitorGapKey
        : [evidence.prompt || item.title, evidence.provider || null];
  const url = (item.affectedUrl || '').replace(/\/$/, '');
  return createHash('sha256')
    .update(JSON.stringify([item.module, identity, url]))
    .digest('hex');
}

export function reconcileRecommendations(
  current: Recommendation[],
  previous: Recommendation[],
  context: {
    auditId: number;
    completedUrls: string[];
    siteChecksComplete: boolean;
    pageEvidence?: Array<{
      url: string;
      finalUrl?: string | null;
      internalLinks: string[];
      externalLinks: string[];
      linkChecks: Array<{ url: string; status: string; redirectCount: number }>;
    }>;
    now?: Date;
  },
): Recommendation[] {
  const previousByKey = new Map(
    previous.map((item) => [item.issueKey || recommendationKey(item), item]),
  );
  const currentKeys = new Set<string>();
  const normalizedUrls = new Set(context.completedUrls.map((url) => url.replace(/\/$/, '')));
  const result = current.map((item): Recommendation => {
    const issueKey = recommendationKey(item);
    currentKeys.add(issueKey);
    const old = previousByKey.get(issueKey);
    return {
      ...item,
      issueKey,
      status: old?.status === 'resolved' ? 'open' : old?.status || 'open',
      assigneeUserId: old?.assigneeUserId,
      dueDate: old?.dueDate,
      resolutionEvidence: old?.resolutionEvidence,
      verificationStatus: old?.status === 'resolved' ? 'still_present' : 'unverified',
      verifiedAt: null,
    };
  });
  for (const [issueKey, old] of previousByKey) {
    if (currentKeys.has(issueKey)) continue;
    let verified =
      old.module === 'seo' &&
      (old.affectedUrl
        ? normalizedUrls.has(old.affectedUrl.replace(/\/$/, ''))
        : context.siteChecksComplete);
    const rule = String(old.evidence?.ruleId || old.title.replaceAll(' ', '.'));
    if (
      verified &&
      ['links.broken', 'links.redirecting', 'links.redirect_chain', 'links.unverified'].includes(
        rule,
      )
    ) {
      const page = context.pageEvidence?.find(
        (page) =>
          (page.finalUrl || page.url).replace(/\/$/, '') ===
          (old.affectedUrl || '').replace(/\/$/, ''),
      );
      const checks = Array.isArray(old.evidence?.checks)
        ? (old.evidence.checks as Array<{ url: string }>)
        : [];
      const targets = checks.length
        ? checks.map((check) => check.url)
        : Array.isArray(old.evidence?.links)
          ? (old.evidence.links as string[])
          : [];
      const currentLinks = new Set([
        ...(page?.internalLinks || []),
        ...(page?.externalLinks || []),
      ]);
      verified = Boolean(
        page &&
        targets.length &&
        targets.every((url) => {
          if (!currentLinks.has(url)) return true; // Removed destination was verified from parsed HTML.
          const check = page.linkChecks.find((check) => check.url === url);
          if (!check || check.status !== 'ok') return false;
          return rule === 'links.redirecting'
            ? check.redirectCount === 0
            : rule === 'links.redirect_chain'
              ? check.redirectCount <= 1
              : true;
        }),
      );
    }
    // Missing from a limited crawl is not proof of resolution.
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = old;
    result.push({
      ...copy,
      auditId: context.auditId,
      issueKey,
      status: verified ? 'resolved' : old.status,
      verificationStatus: verified ? 'verified' : 'not_rechecked',
      verifiedAt: verified ? context.now || new Date() : old.verifiedAt,
    });
  }
  return result;
}
