import type { CampaignReportFilters } from "./campaignReporting.js";
import type { DashboardOperationResult } from "./dashboardOperations.js";
export interface CampaignCustomer {
  key: string;
  contactId: number | null;
  name: string;
  email: string | null;
  phone: string | null;
  channels: string[];
  messages: number;
  accepted: number;
  delivered: number;
  awaitingConfirmation: number;
  queued: number;
  failed: number;
  typedReplies: number;
  quickReplies: number;
  menuSelections: number;
  otherResponses: number;
  responded: boolean;
  trackedLinkClicks: number;
  verifiedBookingActions: number;
  lastReplyAt: string | null;
}
export interface CampaignCustomerPage {
  checkedAt: string;
  businessProfileId: number;
  filters: CampaignReportFilters;
  total: number;
  items: CampaignCustomer[];
  nextCursor: string | null;
  availability: {
    callButtonClicks: "unavailable";
    untrackedWhatsAppUrlClicks: "unavailable";
    bookingActions: "verified_records_only";
  };
  attribution: string;
  card: DashboardOperationResult;
}
export interface CampaignHistoryMessage {
  id: string;
  customerKey: string;
  conversationId: number | null;
  channel: string;
  accountId: string;
  direction: "inbound" | "outbound";
  type: string;
  status: string;
  createdAt: string;
  subject: string | null;
  content: string;
  selection: { kind: string; title: string } | null;
}
export interface CampaignHistoryPage {
  checkedAt: string;
  businessProfileId: number;
  filters: CampaignReportFilters;
  customerKey: string | null;
  items: CampaignHistoryMessage[];
  nextCursor: string | null;
  card: DashboardOperationResult;
}
