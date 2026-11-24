import type {
  CampaignReport,
  CampaignReportFilters,
} from "./campaignReporting.js";
import type {
  CampaignCustomer,
  CampaignHistoryMessage,
} from "./campaignEngagement.js";
import type { DashboardOperationResult } from "./dashboardOperations.js";
export const campaignExportFormats = ["pdf", "docx", "xlsx", "html"] as const;
export type CampaignExportFormat = (typeof campaignExportFormats)[number];
export interface CampaignReportSnapshot {
  version: 1;
  name: string;
  businessProfileId: number;
  checkedAt: string;
  report: CampaignReport;
  customers: CampaignCustomer[];
  history: CampaignHistoryMessage[];
  notes: string[];
}
export interface CampaignExportOperation {
  id: string;
  businessProfileId: number;
  name: string;
  status:
    | "queued"
    | "running"
    | "ready"
    | "completed"
    | "failed"
    | "review"
    | "cancelled";
  createdAt: string;
  expiresAt: string;
  snapshotAt: string | null;
  snapshotHash: string | null;
  filters: CampaignReportFilters;
  progress: { completed: number; total: number };
  error: string | null;
  files: Array<{ format: CampaignExportFormat; name: string; bytes: number }>;
  card: DashboardOperationResult;
}
