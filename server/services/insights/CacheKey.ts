import type { InsightsQuery } from '../../../shared/insights.js';

/** Every authorization and filter dimension that can change an aggregate belongs in the key. */
export function insightsCacheKey(
  scope: { businessProfileId: number; userId: number; actorUserId?: number },
  organizationId: number | undefined,
  billingAllowed: boolean,
  permissions: string[],
  query: InsightsQuery,
): string {
  return `workspace-insights:v1:${scope.businessProfileId}:${scope.userId}:${scope.actorUserId || scope.userId}`
    + `:${organizationId || 0}:${billingAllowed}:${[...permissions].sort().join(',')}:${JSON.stringify(query)}`;
}
