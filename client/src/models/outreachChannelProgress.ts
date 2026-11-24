// Outreach Channel Progress
export interface OutreachChannelProgress {
  channelName: string; // "Calls", "Emails", "LinkedIn", "Instagram", "Facebook", "Twitter"
  icon: string;
  status: "pending" | "outreaching" | "completed";
  progress: number;
  leadsOutreached: number;
  totalLeads: number;
  successRate?: number; // percentage of successful outreaches
}