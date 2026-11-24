export interface OutreachImportBatch {
  id: number;
  fileName: string;
  createdAt: string;
  count: number;
  status?: string;
}

export interface OutreachCampaignImports {
  id: number | null;
  name: string;
  uploads: OutreachImportBatch[];
  historicalCount: number;
}

export interface OutreachImportSources {
  campaigns: OutreachCampaignImports[];
  crmImports: OutreachImportBatch[];
}
