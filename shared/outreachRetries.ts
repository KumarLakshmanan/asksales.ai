import type { CampaignReportFilters } from "./campaignReporting.js";
import type { DashboardOperationResult } from "./dashboardOperations.js";
export interface OutreachRetryPreview {
  id: string;
  businessProfileId: number;
  checkedAt: string;
  reviewExpiresAt: string;
  fingerprint: string;
  error:string|null;
  status:
    | "ready"
    | "queued"
    | "running"
    | "completed"
    | "review"
    | "failed"
    | "cancelled";
  filters: CampaignReportFilters;
  counts: {
    selected: number;
    eligible: number;
    waiting: number;
    excluded: number;
    registered: number;
    changed: number;
  };
  reasons: Array<{
    reason: string;
    count: number;
    nextAttemptAt: string | null;
  }>;
  items: Array<{
    id: string;
    channel: string;
    state: string;
    eligible: boolean;
    reason: string;
    nextAttemptAt: string | null;
  }>;
  progress: { completed: number; total: number };
  card: DashboardOperationResult;
}
