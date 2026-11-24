/**
 * @deprecated Use `client/src/services/workflowApi.ts` instead.
 *
 * This file is kept as a thin re-export shim so the (one) existing
 * importer doesn't break. It now delegates to the React-Query-based
 * `workflowApi` service and the legacy `useWorkflowApi()` hook returns
 * the same surface as before.
 */
export {
  workflowApi,
  useWorkflow,
  useScrapingProgress,
  useApprovals,
  useAnalyzeGoal,
  useBuildIcp,
  useStartScraping,
  useStartOutreach,
  useSubmitApproval,
  useUnreadNotificationCount,
  type WorkflowResponse,
  type ScrapingProgressResponse,
  type StrategyRecommendationsResponse,
  type StartOutreachResponse,
} from '@/services/workflowApi';

// Legacy: a hook that returns plain functions. Provided here so older
// call-sites keep working without changing imports. The returned object
// shape matches the previous `useWorkflowApi()` output.
import { workflowApi } from '@/services/workflowApi';

export function useWorkflowApi() {
  // `workflowApi` is a module-level singleton. Returning it directly keeps the
  // reference stable across renders; returning a new object here caused every
  // effect/callback that depended on this hook to be recreated, including the
  // effect that launches an outreach campaign.
  return workflowApi;
}
