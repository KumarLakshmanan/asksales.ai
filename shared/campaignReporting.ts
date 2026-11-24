import type {DashboardOperationResult} from './dashboardOperations.js';
export const outreachReportChannels = ['email','sms','whatsapp','instagram','facebook','linkedin','twitter'] as const;
export interface CampaignReportFilters {
  workspaceId?: number; campaignId?: number; importId?: number; importSource?: 'crm' | 'campaign';
  preparedOutreachId?:string;
  channel?: typeof outreachReportChannels[number]; accountId?: string; from?: string; to?: string;
  messageKind: 'outreach' | 'follow_up' | 'all';
}
export interface CampaignReportOptions {
  campaigns: Array<{id: number; name: string}>;
  workspaces: Array<{id: number; name: string}>;
  imports: Array<{id: number; source: 'crm' | 'campaign'; name: string}>;
  accounts: Array<{channel: string; id: string}>;
  preparedCampaigns?:Array<{id:string;name:string}>;
}
export interface CampaignDeliveryCounts {
  total: number;
  accepted: number;
  delivered: number;
  awaitingConfirmation: number;
  read: number;
  opened: number;
  clicked: number;
  queued: number;
  retrying: number;
  processing: number;
  failed: number;
  review: number;
  cancelled: number;
}
export interface CampaignReport {
  version: 1;
  source: 'canonical_outreach';
  checkedAt: string;
  filters: CampaignReportFilters;
  counts: CampaignDeliveryCounts;
  channels: Array<CampaignDeliveryCounts & {
    channel: string; nextAttemptAt: string | null; respondingCustomers: number;
    waiting: Array<{id: string; reason: string | null; nextAttemptAt: string | null; error: string | null}>;
  }>;
  timeline: Array<{date: string; sent: number; opened: number; clicked: number; replied: number}>;
  activeSequences: number;
  pendingFollowUps: number;
  sentiment: {positive: number; neutral: number; negative: number; urgent: number; total: number};
  uniqueRecipients: number;
  engagement: {
    respondingCustomers: number;
    inboundResponses: number;
    typedReplies: number;
    quickReplies: number;
    menuSelections: number;
    otherResponses: number;
    assistantReplies: number;
    responseRate: number;
    callButtonClicks: null;
    callButtonClickAvailability: 'unavailable';
  };
  failures: Array<{channel: string; code: string | null; reason: string; count: number}>;
  nextAttemptAt: string | null;
  definitions: { accepted: string; delivered: string; responseRate: string; attribution: string; clicks: string; history: string };
  links: { report: string; campaign?: string; contacts: string };
}
export function campaignReportUrl(filters: Partial<CampaignReportFilters> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key,String(value));
  return '/dashboard/outreach/reports' + (params.size ? `?${params}` : '');
}
export function campaignReportCard(report:CampaignReport):DashboardOperationResult {
  return {title:'Campaign delivery report',status:'ready',checkedAt:report.checkedAt,
    description:`${report.uniqueRecipients} distinct recipients. Accepted includes delivered and awaiting confirmation.`,
    metrics:[{label:'Accepted',value:report.counts.accepted},{label:'Confirmed delivered',value:report.counts.delivered},{label:'Awaiting confirmation',value:report.counts.awaitingConfirmation},
      {label:'Queued',value:report.counts.queued},{label:'Failed',value:report.counts.failed},{label:'Responding customers',value:report.engagement.respondingCustomers}],
    actions:[{label:'View report',href:report.links.report},{label:'Open contacts',href:report.links.contacts},...(report.links.campaign ? [{label:'View campaign',href:report.links.campaign}] : [])]};
}
