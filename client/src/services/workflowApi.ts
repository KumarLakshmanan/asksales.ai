/**
 * Workflow API service (Phase 6.7 / CLIENT-007)
 *
 * Replaces the old `hooks/useWorkflowApi.ts` with a service that exposes
 * plain functions for imperative callers AND React Query hooks for the
 * declarative data layer.
 *
 *   - Plain functions: `workflowApi.analyzeGoal(prompt)`
 *   - React Query hooks: `useWorkflow(workflowId)` etc.
 *
 * The old `useWorkflowApi()` hook is re-exported as a thin wrapper that
 * returns the same surface so existing callers don't break. New code
 * should import the React Query hooks directly.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ICP } from '@/models/icp';
import type { LeadGenStrategy } from '@/models/leadGenStrategy';
import type { Lead } from '@/models/lead';
import type { SentMessage } from '@/models/sentMessage';
import type { ChannelScrapingProgress } from '@/models/channelScrapingProgress';

export interface WorkflowResponse {
  workflowId: string;
  stage: string;
  icp?: ICP;
  strategy?: LeadGenStrategy;
  leads?: Lead[];
  sentMessages?: Record<string, SentMessage[]>;
}

export interface ScrapingProgressResponse {
  workflowId: string;
  channels: ChannelScrapingProgress[];
  totalLeads: number;
  status: 'in_progress' | 'completed' | 'failed';
}

export interface StrategyRecommendationsResponse {
  strategy: LeadGenStrategy;
}

export interface StartOutreachResponse {
  success: boolean;
  campaign_id?: number;
  sequence_id?: number;
  status?: "needs_review";
  review_url?: string;
  message?: string;
}

// ─── Plain functions ──────────────────────────────────────────────────────────

export const workflowApi = {
  analyzeGoal: (prompt: string) =>
    api.post<WorkflowResponse>('/api/orchestrator/analyze-goal', { goal: prompt }),

  getWorkflow: (workflowId: string) =>
    api.get<WorkflowResponse>(`/api/orchestrator/workflows/${workflowId}`),

  buildICP: (workflowId: string, userPrompt: string) =>
    api.post<{ icp: ICP }>('/api/icp/build', { workflowId, userPrompt }),

  getStrategyRecommendations: (workflowId: string) =>
    api.get<StrategyRecommendationsResponse>(`/api/strategies/${workflowId}/recommendations`),

  startScraping: (workflowId: string) =>
    api.post<{ success: boolean }>('/api/scraping/start', { workflowId }),

  getScrapingProgress: (workflowId: string) =>
    api.get<ScrapingProgressResponse>(`/api/scraping/${workflowId}/progress`),

  startOutreach: (
    workflowId: string,
    useContentStudio = false,
    followUpDelayHours?: number
  ) =>
    api.post<StartOutreachResponse>('/api/outreach/start', {
      workflowId,
      useContentStudio,
      followUpDelayHours,
    }),

  getOutreachProgress: (campaignId: string) =>
    api.get<unknown>(`/api/outreach/progress/${campaignId}`),

  submitApproval: (approvalId: string, approved: boolean, feedback?: string) =>
    api.post<{ success: boolean }>(
      `/api/approvals/${approvalId}/${approved ? 'approve' : 'reject'}`,
      { feedback }
    ),

  getNotifications: () => api.get<{
    items: unknown[];
    unreadCount: number;
    pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
  }>('/api/notifications'),
  getUnreadCount: () =>
    api.get<{ count: number }>('/api/notifications/unread/count'),
  markAsRead: (notificationId: number) =>
    api.put(`/api/notifications/${notificationId}/read`),
  markAllAsRead: () => api.put('/api/notifications/read-all'),
};

// ─── React Query hooks ───────────────────────────────────────────────────────

const workflowKey = (workflowId: string) => ['workflow', workflowId] as const;
const scrapingKey  = (workflowId: string) => ['scraping',  workflowId] as const;
const approvalsKey = (workflowId: string) => ['approvals', workflowId] as const;

export function useWorkflow(workflowId: string | undefined) {
  return useQuery({
    queryKey: workflowKey(workflowId ?? '__missing__'),
    queryFn: () => workflowApi.getWorkflow(workflowId!),
    enabled: !!workflowId,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
}

export function useScrapingProgress(workflowId: string | undefined) {
  return useQuery({
    queryKey: scrapingKey(workflowId ?? '__missing__'),
    queryFn: () => workflowApi.getScrapingProgress(workflowId!),
    enabled: !!workflowId,
    // Phase 6.7: scraping is short-lived; poll lightly so the UI feels live
    // without hammering the API.
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
}

export function useApprovals(workflowId: string | undefined) {
  return useQuery({
    queryKey: approvalsKey(workflowId ?? '__missing__'),
    queryFn: async () => {
      // approvals endpoint lives in the same router; re-using `getWorkflow` would
      // over-fetch. We re-use the api helper directly here.
      const { api } = await import('@/lib/api');
      return api.get<unknown[]>(`/api/approvals/${workflowId}`);
    },
    enabled: !!workflowId,
  });
}

export function useAnalyzeGoal() {
  return useMutation({ mutationFn: (prompt: string) => workflowApi.analyzeGoal(prompt) });
}

export function useBuildIcp() {
  return useMutation({
    mutationFn: (args: { workflowId: string; userPrompt: string }) =>
      workflowApi.buildICP(args.workflowId, args.userPrompt),
  });
}

export function useStartScraping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) => workflowApi.startScraping(workflowId),
    onSuccess: (_d, workflowId) => qc.invalidateQueries({ queryKey: scrapingKey(workflowId) }),
  });
}

export function useStartOutreach() {
  return useMutation({
    mutationFn: (args: {
      workflowId: string;
      useContentStudio?: boolean;
      followUpDelayHours?: number;
    }) =>
      workflowApi.startOutreach(
        args.workflowId,
        args.useContentStudio,
        args.followUpDelayHours
      ),
  });
}

export function useSubmitApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { approvalId: string; approved: boolean; feedback?: string }) =>
      workflowApi.submitApproval(args.approvalId, args.approved, args.feedback),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  });
}

export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: ['notifications', 'unread-count'] as const,
    queryFn: () => workflowApi.getUnreadCount(),
    refetchInterval: 30_000,
  });
}
