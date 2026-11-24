import { z } from "zod";

// ICP (Ideal Customer Profile) - Simplified schema matching backend
export const icpSchema = z.object({
  // Campaign Information
  campaign_name: z.string().optional(),
  campaign_objective: z.string().optional(),
  target_audience: z.string(),

  // Company Information
  industry: z.string().optional(),
  company_size_range: z.string().optional(),
  geography_locations: z.array(z.string()).optional(),

  // Target Buyer Persona
  primary_job_titles: z.array(z.string()).optional(),

  // Pain Points
  pain_points: z.array(z.string()).optional(),
  lead_generation_pain_points: z.array(z.string()).optional(),

  // Lead Source Strategy
  primary_channels: z.array(z.string()).optional(),

  // Budget & Commercial Fit
  budget_range: z.string().optional(),

  // Fit Scoring
  fit_score: z.number().optional(),

  // System fields
  status: z.string().optional(),
  summary: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  messaging_themes: z.array(z.string()).optional(),

  // Legacy compatibility fields
  industry_vertical: z.string().optional(),
  business_type: z.string().optional(),
  target_roles_titles: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  company_size: z.string().optional(),
  revenue_range: z.string().optional(),
  technologies: z.array(z.string()).optional(),
  buying_triggers: z.array(z.string()).optional(),
  decision_makers: z.array(z.string()).optional(),
  location: z.string().optional(),
});

export type ICP = z.infer<typeof icpSchema>;

export interface ICPApiResponse {
  id?: number;
  campaignName?: string;
  campaignObjective?: string;
  targetAudience?: string;
  industry?: string;
  subIndustry?: string;
  businessType?: string;
  primaryRegions?: string[];
  primaryJobTitles?: string[];
  primaryChannels?: string[];
  targetCompanySizeRange?: string;
  targetRevenueRange?: string;
  targetBusinessModel?: string;
  companySizeRange?: string;
  revenueRange?: string;
  budgetRange?: string;
  techStack?: string[];
  primaryPainPoints?: string[];
  decisionMakers?: string[];
  summary?: string;
  keywords?: string[];
  messagingThemes?: string[];
  fitScore?: number;
  businessId?: number;
  businessName?: string;
  companyName?: string;
  companyWebsite?: string;
  companyAddress?: string;
  businessIndustry?: string;
  businessWebsite?: string;
  businessDescription?: string;
  primaryValueProposition?: string;
  userIntent?: string;
  recommendedAgentScores?: {
    lead_generation?: number;
    content_studio?: number;
    performance_marketing?: number;
    outreach?: number;
  };
}