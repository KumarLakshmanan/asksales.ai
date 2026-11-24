export interface ThreadReportingSummary {
  leads: number;
  contentAssets: number;
  messages: number;
  sent: number;
  pending: number;
  contactedLeads: number;
  engagedLeads: number;
  convertedContacts: number | null;
  crmContacts: number | null;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  byChannel: Record<string, number>;
  channels: Array<{ name: string; outreach: number; replied: number }>;
  timeline: Array<{ week: string; outreached: number }>;
}
