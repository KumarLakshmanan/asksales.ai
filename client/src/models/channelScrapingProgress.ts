// Channel Scraping Progress
export interface ChannelScrapingProgress {
  channelName: string;
  icon: string;
  status: "pending" | "scraping" | "completed";
  progress: number;
  leadsFound: number;
  estimatedLeads: number;
}