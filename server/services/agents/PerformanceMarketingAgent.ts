/**
 * Performance Marketing Agent
 * Generates budget plans, ad campaigns, creatives, and optimization strategies
 */

import { LLMProviderFactory } from './LLMProviderFactory';
import { ContentTextGenerationError } from '../content/ContentTextGenerationError.js';
import { db } from '../../models/db';
import { and, eq, sql } from 'drizzle-orm';
import { icpProfilesTable } from '../../models/icpData/schema.js';
import type { ICPProfile } from '../ICPGenerationService';
import { createMetaAdsService, type MetaCredentials } from '../ads/MetaAdsService';
import { logger } from '../../utils/logger.js';
import { z } from 'zod';

const expectedMetricsSchema = z.object({
  impressions: z.number().nonnegative().optional(),
  clicks: z.number().nonnegative().optional(),
  conversions: z.number().nonnegative().optional(),
  cpa: z.number().nonnegative().optional(),
  roas: z.number().nonnegative().optional(),
}).strip();

const generatedBudgetPlanSchema = z.object({
  channel_allocation: z.array(z.object({
    channel: z.string().min(1).max(100),
    budget: z.number().nonnegative(),
    percentage: z.number().min(0).max(100),
    rationale: z.string().max(2000),
    expected_metrics: expectedMetricsSchema,
  }).strip()).min(1).max(20),
  recommendations: z.array(z.string().max(2000)).max(100),
}).strip();

const generatedAdCampaignSchema = z.object({
  campaign_name: z.string().min(1).max(500),
  campaign_objective: z.string().min(1).max(500),
  targeting: z.object({
    locations: z.array(z.string().max(200)).max(100).default([]),
    age_range: z.string().max(50).optional(),
    interests: z.array(z.string().max(200)).max(100).default([]),
    job_titles: z.array(z.string().max(200)).max(100).optional(),
    company_sizes: z.array(z.string().max(100)).max(50).optional(),
    industries: z.array(z.string().max(200)).max(100).optional(),
  }).strip(),
  ad_sets: z.array(z.object({
    name: z.string().min(1).max(500),
    budget: z.number().positive(),
    bidding_strategy: z.string().min(1).max(200),
    placements: z.array(z.string().max(100)).max(50),
    ads: z.array(z.object({
      ad_name: z.string().min(1).max(500),
      format: z.string().min(1).max(100),
      headline: z.string().min(1).max(500),
      description: z.string().min(1).max(5000),
      call_to_action: z.string().min(1).max(100),
      landing_page_url: z.string().url().max(2000).optional(),
      image_requirements: z.string().max(2000).optional(),
    }).strip()).min(1).max(20),
  }).strip()).min(1).max(20),
  kpis: z.object({
    target_impressions: z.number().nonnegative(),
    target_clicks: z.number().nonnegative(),
    target_conversions: z.number().nonnegative(),
    target_ctr: z.number().nonnegative(),
    target_cpa: z.number().nonnegative(),
    target_roas: z.number().nonnegative(),
  }).strip(),
}).strip();

const generatedOptimizationSchema = z.object({
  recommendations: z.array(z.object({
    priority: z.enum(['high', 'medium', 'low']),
    category: z.string().max(500),
    recommendation: z.string().max(5000),
    expected_impact: z.string().max(2000),
    action_required: z.string().max(2000),
  }).strip()).max(100),
  budget_adjustments: z.array(z.object({
    channel: z.string().max(500),
    current_budget: z.number().nonnegative(),
    recommended_budget: z.number().nonnegative(),
    reason: z.string().max(2000),
  }).strip()).max(100),
  targeting_suggestions: z.array(z.string().max(2000)).max(100),
  creative_insights: z.array(z.string().max(2000)).max(100),
}).strip();

// CTA display-text to Meta API value mapping
const CTA_DISPLAY_MAP: Record<string, string> = {
  'Learn More': 'LEARN_MORE', 'Shop Now': 'SHOP_NOW', 'Sign Up': 'SIGN_UP',
  'Download': 'DOWNLOAD', 'Contact Us': 'CONTACT_US', 'Get Quote': 'GET_QUOTE',
  'Get a Quote': 'GET_QUOTE', 'Book Now': 'BOOK_NOW', 'Subscribe': 'SUBSCRIBE',
  'Get Offer': 'GET_OFFER', 'Apply Now': 'APPLY_NOW', 'Buy Now': 'BUY_NOW',
  'Watch Video': 'WATCH_VIDEO', 'Order Now': 'ORDER_NOW', 'Call Now': 'CALL_NOW',
  'Get Started': 'LEARN_MORE', 'Start Now': 'LEARN_MORE', 'Try Now': 'TRY_NOW',
  'See More': 'SEE_MORE', 'Explore More': 'EXPLORE_MORE', 'Register Now': 'REGISTER_NOW',
};

/**
 * Normalize CTA value for Meta API — accepts display text or API constant.
 * Falls back to LEARN_MORE for unknown values.
 */
function normalizeCtaValue(cta: string | undefined): string {
  if (!cta) return 'LEARN_MORE';
  // Already a valid API constant (e.g. 'LEARN_MORE', 'SHOP_NOW')
  const upper = cta.toUpperCase().replace(/\s+/g, '_');
  if (CTA_DISPLAY_MAP[cta]) return CTA_DISPLAY_MAP[cta];
  // If it looks like a valid constant (all uppercase, underscored), pass through
  if (/^[A-Z_]+$/.test(upper) && upper.length > 1) return upper;
  logger.warn({ cta }, '[PerformanceMarketingAgent] Unknown CTA, defaulting to LEARN_MORE');
  return 'LEARN_MORE';
}

/**
 * Load an ICP through the typed table so its fields are camelCased
 * (userId, targetAudience, ...). A raw `SELECT *` returns snake_case
 * columns, which left `icp.userId` undefined and failed every plan.
 */
export async function loadPlanningIcp(icpId: unknown, ownerUserId?: number): Promise<ICPProfile | null> {
  const id = Number(icpId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const where = ownerUserId === undefined
    ? eq(icpProfilesTable.id, id)
    : and(eq(icpProfilesTable.id, id), eq(icpProfilesTable.userId, ownerUserId));
  const [row] = await db.select().from(icpProfilesTable).where(where).limit(1);
  return (row as unknown as ICPProfile | undefined) ?? null;
}

export interface BudgetPlan {
  id?: number;
  icp_id: number;
  total_budget: number;
  duration_days: number;
  currency: string;
  channel_allocation: ChannelBudget[];
  daily_budget: number;
  recommendations: string[];
  created_at?: Date;
}

export interface ChannelBudget {
  channel: string;
  budget: number;
  percentage: number;
  rationale: string;
  expected_metrics: {
    impressions?: number;
    clicks?: number;
    conversions?: number;
    cpa?: number;
    roas?: number;
  };
}

export interface AdCampaign {
  id?: number;
  icp_id: number;
  campaign_name: string;
  platform: 'google' | 'facebook' | 'linkedin' | 'twitter' | 'instagram';
  currency: string;
  campaign_objective: string;
  budget: number;
  duration_days: number;
  targeting: CampaignTargeting;
  ad_sets: AdSet[];
  kpis: CampaignKPIs;
  created_at?: Date;
}

export interface CampaignTargeting {
  locations: string[];
  age_range?: string;
  interests: string[];
  job_titles?: string[];
  company_sizes?: string[];
  industries?: string[];
  behaviors?: string[];
  custom_audiences?: string[];
}

export interface AdSet {
  name: string;
  budget: number;
  bidding_strategy: string;
  placements: string[];
  ads: Ad[];
}

export interface Ad {
  ad_name: string;
  format: string;
  headline: string;
  description: string;
  call_to_action: string;
  landing_page_url?: string;
  image_requirements?: string;
}

export interface CampaignKPIs {
  target_impressions: number;
  target_clicks: number;
  target_conversions: number;
  target_ctr: number;
  target_cpa: number;
  target_roas: number;
}

export interface CampaignOptimization {
  campaign_id: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  current_metrics: any;
  recommendations: OptimizationRecommendation[];
  budget_adjustments: BudgetAdjustment[];
  targeting_suggestions: string[];
  creative_insights: string[];
}

export interface OptimizationRecommendation {
  priority: 'high' | 'medium' | 'low';
  category: string;
  recommendation: string;
  expected_impact: string;
  action_required: string;
}

export interface BudgetAdjustment {
  channel: string;
  current_budget: number;
  recommended_budget: number;
  reason: string;
}

export class PerformanceMarketingAgent {
  constructor() {
    // LLM provider will be obtained per-request based on ICP's userId
  }

  /**
   * Generate budget plan for ICP
   */
  async generateBudgetPlan(
    icp: ICPProfile,
    totalBudget: number,
    durationDays: number = 30,
    currency: string = 'USD'
  ): Promise<BudgetPlan> {
    try {
      logger.info('[PerformanceMarketingAgent] Generating budget plan for ICP');

      const systemPrompt = `You are an expert performance marketing strategist specializing in budget allocation and channel planning.

ICP Details:
- Target Audience: ${icp.targetAudience}
- Industry: ${icp.industry}
- Company Size: ${icp.targetCompanySizeRange}
- Budget Range: ${icp.budgetRange || 'Flexible'}
- Primary Channels: ${JSON.stringify(icp.primaryChannels || [])}
- Campaign Objective: ${icp.campaignObjective || 'Lead Generation'}

Total Budget: ${totalBudget} ${currency}
Duration: ${durationDays} days

Generate a comprehensive budget allocation plan that:
1. Distributes budget across appropriate channels (Facebook, LinkedIn, Instagram, etc.)
2. Considers the ICP's industry, audience, and objectives
3. Allocates higher budgets to proven channels for this audience
4. Provides rationale for each allocation
5. Estimates expected metrics (impressions, clicks, conversions, CPA, ROAS)
6. Includes recommendations for optimization

Return JSON:
{
  "channel_allocation": [
    {
      "channel": "Facebook Ads",
      "budget": 15000,
      "percentage": 50,
      "rationale": "High-intent search traffic for B2B",
      "expected_metrics": {
        "impressions": 500000,
        "clicks": 10000,
        "conversions": 500,
        "cpa": 30,
        "roas": 4.0
      }
    }
  ],
  "recommendations": [
    "Start with 70% of budget in proven channels",
    "Reserve 20% for testing new channels",
    "Keep 10% for mid-campaign optimizations"
  ]
}`;

      const llmProvider = icp.userId ? await LLMProviderFactory.createProviderForUser(icp.userId) : null;
      if (!llmProvider) throw new Error('No LLM provider configured for this user. Please configure OpenAI or OpenRouter in Settings > Integrations.');

      const completionResp = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate budget allocation plan for ${totalBudget} ${currency} over ${durationDays} days.` },
        ],
        temperature: 0.5,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId: icp.userId!,
          purpose: 'performance_marketing',
          service: 'PerformanceMarketingAgent',
          action: 'generate_budget_plan',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      const parsedData = generatedBudgetPlanSchema.parse(JSON.parse(rawResponse));

      const budgetPlan: BudgetPlan = {
        icp_id: icp.id!,
        total_budget: totalBudget,
        duration_days: durationDays,
        currency,
        channel_allocation: parsedData.channel_allocation || [],
        daily_budget: Math.round(totalBudget / durationDays),
        recommendations: parsedData.recommendations || [],
      };

      logger.info({ count: budgetPlan.channel_allocation.length }, `[PerformanceMarketingAgent] Budget plan generated with ${budgetPlan.channel_allocation.length} channels`);
      return budgetPlan;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[PerformanceMarketingAgent] Error generating budget plan');
      throw error;
    }
  }

  /**
   * Generate ad campaign for specific platform
   */
  async generateAdCampaign(
    icp: ICPProfile,
    platform: 'google' | 'facebook' | 'linkedin' | 'twitter' | 'instagram',
    budget: number,
    durationDays: number = 30,
    currency: string = 'USD',
  ): Promise<AdCampaign> {
    try {
      logger.info({ platform: platform }, '[PerformanceMarketingAgent] Generating ad campaign');

      const platformSpecs = this.getPlatformCampaignSpecs(platform);

      const systemPrompt = `You are an expert ${platform} advertising strategist. Generate a complete ad campaign structure.

ICP Details:
- Target Audience: ${icp.targetAudience}
- Industry: ${icp.industry}
- Geography: ${JSON.stringify(icp.primaryRegions || [])}
- Job Titles: ${JSON.stringify(icp.primaryJobTitles || [])}
- Company Sizes: ${icp.targetCompanySizeRange || 'All'}
- Pain Points: ${JSON.stringify(icp.primaryPainPoint ? [icp.primaryPainPoint] : [])}
- Value Proposition: ${icp.primaryValueProposition || 'Solution'}
- Campaign Objective: ${icp.campaignObjective || 'Lead Generation'}

Platform: ${platform}
Budget: ${budget} ${currency}
Duration: ${durationDays} days

Platform Specifications:
${JSON.stringify(platformSpecs, null, 2)}

Generate a complete campaign structure with:
1. Campaign targeting (locations, demographics, interests, job titles, etc.)
2. 2-3 ad sets with different strategies
3. 3-5 ads per ad set with variations
4. Bidding strategies optimized for platform
5. Placements recommendations
6. KPI targets (impressions, clicks, conversions, CTR, CPA, ROAS)

Return JSON:
{
  "campaign_name": "Campaign name",
  "campaign_objective": "Lead Generation / Brand Awareness / Conversions",
  "targeting": {
    "locations": ["US", "Canada"],
    "age_range": "25-54",
    "interests": ["Marketing", "SaaS"],
    "job_titles": ["Marketing Manager", "CMO"],
    "company_sizes": ["50-200", "201-500"],
    "industries": ["Technology", "Finance"]
  },
  "ad_sets": [
    {
      "name": "Ad Set 1 - Warm Audience",
      "budget": 5000,
      "bidding_strategy": "Target CPA",
      "placements": ["Feed", "Stories"],
      "ads": [
        {
          "ad_name": "Ad 1 - Pain Point Focus",
          "format": "Single Image",
          "headline": "Headline text",
          "description": "Description text",
          "call_to_action": "Learn More",
          "image_requirements": "1200x628, professional, show product"
        }
      ]
    }
  ],
  "kpis": {
    "target_impressions": 500000,
    "target_clicks": 10000,
    "target_conversions": 500,
    "target_ctr": 2.0,
    "target_cpa": 50,
    "target_roas": 3.0
  }
}`;

      const llmProvider = icp.userId ? await LLMProviderFactory.createProviderForUser(icp.userId) : null;
      if (!llmProvider) throw new Error('No LLM provider configured for this user. Please configure OpenAI or OpenRouter in Settings > Integrations.');

      const completionResp = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate complete ${platform} ad campaign structure.` },
        ],
        temperature: 0.6,
        max_tokens: 3500,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId: icp.userId!,
          purpose: 'performance_marketing',
          service: 'PerformanceMarketingAgent',
          action: 'generate_ad_campaign',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new ContentTextGenerationError('No message content returned', 'a campaign');
      }

      const parsedData = generatedAdCampaignSchema.parse(JSON.parse(rawResponse));

      const adCampaign: AdCampaign = {
        icp_id: icp.id!,
        campaign_name: parsedData.campaign_name || `${platform} - ${icp.campaignName || 'Campaign'}`,
        platform,
        currency,
        campaign_objective: parsedData.campaign_objective || 'Lead Generation',
        budget,
        duration_days: durationDays,
        targeting: parsedData.targeting || {},
        ad_sets: parsedData.ad_sets || [],
        kpis: parsedData.kpis || {},
      };

      logger.info({ count: adCampaign.ad_sets.length }, '[PerformanceMarketingAgent] Generated campaign with ad sets');
      return adCampaign;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[PerformanceMarketingAgent] Error generating ad campaign');
      throw error;
    }
  }

  /**
   * Generate campaign optimization recommendations
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async optimizeCampaign(campaignId: number, currentMetrics: any): Promise<CampaignOptimization> {
    try {
      logger.info({ campaignId: campaignId }, '[PerformanceMarketingAgent] Generating optimization recommendations for campaign');

      const systemPrompt = `You are an expert performance marketing analyst specializing in campaign optimization.

Current Campaign Metrics:
${JSON.stringify(currentMetrics, null, 2)}

Analyze the campaign performance and provide:
1. High-impact optimization recommendations
2. Budget reallocation suggestions
3. Targeting refinements
4. Creative improvements
5. Bidding strategy adjustments

Focus on:
- Underperforming ad sets (high CPA, low CTR, low conversions)
- Budget waste (high spend, low ROAS)
- Scaling opportunities (winning ads, high ROAS)
- A/B testing suggestions

Return JSON:
{
  "recommendations": [
    {
      "priority": "high",
      "category": "Budget Allocation",
      "recommendation": "Increase budget for Ad Set 1 by 30%",
      "expected_impact": "+50 conversions, -20% CPA",
      "action_required": "Adjust daily budget from $100 to $130"
    }
  ],
  "budget_adjustments": [
    {
      "channel": "Meta Ads - Ad Set 1",
      "current_budget": 5000,
      "recommended_budget": 7000,
      "reason": "Best performing ad set with 5.0 ROAS"
    }
  ],
  "targeting_suggestions": [
    "Expand to similar interests: AI, Automation",
    "Narrow age range to 30-50 for better conversion rate"
  ],
  "creative_insights": [
    "Pain-point focused headlines perform 40% better",
    "Video ads have 2x higher engagement than static images"
  ]
}`;

      // Load campaign and ICP to determine owner and user credentials
      const campaignResult = await db.execute(sql`
        SELECT * FROM performance_ad_campaigns WHERE id = ${campaignId}
      `);
      if (campaignResult.rows.length === 0) {
        throw new Error(`Campaign ${campaignId} not found`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const campaign = campaignResult.rows[0] as any;

      const icp = await loadPlanningIcp(campaign.icp_id);
      if (!icp) {
        throw new Error(`ICP ${campaign.icp_id} not found`);
      }

      const llmProvider = icp.userId ? await LLMProviderFactory.createProviderForUser(icp.userId) : null;
      if (!llmProvider) throw new Error('No LLM provider configured for this user. Please configure OpenAI or OpenRouter in Settings > Integrations.');

      const completionResp = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Analyze current campaign metrics and provide optimization recommendations.' },
        ],
        temperature: 0.4,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId: icp.userId!,
          purpose: 'performance_marketing',
          service: 'PerformanceMarketingAgent',
          action: 'optimize_campaign',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      const parsedData = generatedOptimizationSchema.parse(JSON.parse(rawResponse));

      const optimization: CampaignOptimization = {
        campaign_id: campaignId,
        current_metrics: currentMetrics,
        recommendations: parsedData.recommendations || [],
        budget_adjustments: parsedData.budget_adjustments || [],
        targeting_suggestions: parsedData.targeting_suggestions || [],
        creative_insights: parsedData.creative_insights || [],
      };

      logger.info({ count: optimization.recommendations.length }, `[PerformanceMarketingAgent] Generated ${optimization.recommendations.length} optimization recommendations`);
      return optimization;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[PerformanceMarketingAgent] Error optimizing campaign');
      throw error;
    }
  }

  /**
   * Save budget plan to database
   */
  async saveBudgetPlan(budgetPlan: BudgetPlan): Promise<number> {
    try {
      const result = await db.execute(sql`
        INSERT INTO performance_budget_plans (
          icp_id,
          total_budget,
          duration_days,
          currency,
          channel_allocation,
          daily_budget,
          recommendations,
          created_at
        ) VALUES (
          ${budgetPlan.icp_id},
          ${budgetPlan.total_budget},
          ${budgetPlan.duration_days},
          ${budgetPlan.currency},
          ${JSON.stringify(budgetPlan.channel_allocation)}::jsonb,
          ${budgetPlan.daily_budget},
          ${JSON.stringify(budgetPlan.recommendations)}::jsonb,
          NOW()
        )
        RETURNING id
      `);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = (result.rows[0] as any).id;
      logger.info({ id: id }, '[PerformanceMarketingAgent] Budget plan saved with ID');
      return id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[PerformanceMarketingAgent] Failed to persist budget plan');
      throw error;
    }
  }

  /**
   * Save ad campaign to database
   */
  async saveAdCampaign(adCampaign: AdCampaign, userId: number): Promise<number> {
    try {
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + Math.max(1, adCampaign.duration_days));
      const result = await db.execute(sql`
        INSERT INTO performance_ad_campaigns (
          user_id,
          name,
          objective,
          ad_platform,
          budget_type,
          budget_amount,
          currency,
          targeting,
          ad_creatives,
          start_date,
          end_date,
          status,
          is_active,
          settings,
          created_at
        ) VALUES (
          ${userId},
          ${adCampaign.campaign_name},
          ${adCampaign.campaign_objective},
          ${adCampaign.platform === 'facebook' || adCampaign.platform === 'instagram' ? 'meta' : adCampaign.platform},
          'lifetime',
          ${adCampaign.budget},
          ${adCampaign.currency},
          ${JSON.stringify(adCampaign.targeting)}::jsonb,
          ${JSON.stringify(adCampaign.ad_sets)}::jsonb,
          ${startDate},
          ${endDate},
          'draft',
          false,
          ${JSON.stringify({
            icpId: adCampaign.icp_id,
            durationDays: adCampaign.duration_days,
            kpis: adCampaign.kpis,
          })}::jsonb,
          NOW()
        )
        RETURNING id
      `);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = (result.rows[0] as any).id;
      logger.info({ id: id }, '[PerformanceMarketingAgent] Ad campaign saved with ID');
      return id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[PerformanceMarketingAgent] Failed to persist ad campaign');
      throw error;
    }
  }

  /**
   * Get platform-specific campaign specifications
   */
  private getPlatformCampaignSpecs(platform: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const specs: Record<string, any> = {
      facebook: {
        campaign_types: ['Traffic', 'Conversions', 'Lead Generation', 'Brand Awareness'],
        bidding_strategies: ['Lowest Cost', 'Cost Cap', 'Bid Cap'],
        ad_formats: ['Single Image', 'Video', 'Carousel', 'Collection'],
        targeting: ['Interests', 'Behaviors', 'Demographics', 'Custom Audiences'],
        placements: ['Feed', 'Stories', 'Reels', 'Marketplace', 'Audience Network'],
      },
      linkedin: {
        campaign_types: ['Sponsored Content', 'Sponsored InMail', 'Text Ads', 'Dynamic Ads'],
        bidding_strategies: ['Maximum Delivery', 'Target CPA', 'Manual Bidding'],
        ad_formats: ['Single Image', 'Video', 'Carousel', 'Event Ads'],
        targeting: ['Job Titles', 'Company Size', 'Industry', 'Skills', 'Groups'],
      },
      twitter: {
        campaign_types: ['Promoted Tweets', 'Promoted Accounts', 'Promoted Trends'],
        bidding_strategies: ['Automatic', 'Maximum Bid', 'Target Cost'],
        ad_formats: ['Image', 'Video', 'Carousel', 'Text Only'],
        targeting: ['Interests', 'Keywords', 'Followers', 'Demographics'],
      },
      instagram: {
        campaign_types: ['Traffic', 'Conversions', 'Brand Awareness', 'Reach'],
        bidding_strategies: ['Lowest Cost', 'Cost Cap'],
        ad_formats: ['Photo', 'Video', 'Stories', 'Reels', 'Carousel'],
        targeting: ['Interests', 'Behaviors', 'Demographics', 'Lookalike Audiences'],
        placements: ['Feed', 'Stories', 'Reels', 'Explore'],
      },
    };

    return specs[platform] || specs.facebook;
  }

  /**
   * Publish campaign to Meta (Facebook/Instagram)
   */
  async publishToMeta(
    campaignId: number,
    userId: number,
    metaCredentials: MetaCredentials,
    pageId: string
  ): Promise<{ success: boolean; metaCampaignId?: string; error?: string }> {
    let createdMetaCampaignId: string | undefined;
    try {
      logger.info({ campaignId: campaignId }, '[PerformanceMarketingAgent] Publishing campaign to Meta');

      // Fetch campaign from database
      const campaignResult = await db.execute(sql`
        SELECT * FROM performance_ad_campaigns WHERE id = ${campaignId} AND user_id = ${userId}
      `);

      if (campaignResult.rows.length === 0) {
        throw new Error(`Campaign ${campaignId} not found`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const campaign = campaignResult.rows[0] as any;
      const metaService = createMetaAdsService(metaCredentials);

      // Map campaign objective
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const objectiveMap: Record<string, any> = {
        'Traffic': 'OUTCOME_TRAFFIC',
        'Conversions': 'OUTCOME_SALES',
        'Lead Generation': 'OUTCOME_LEADS',
        'Brand Awareness': 'OUTCOME_AWARENESS',
        'Engagement': 'OUTCOME_ENGAGEMENT',
      };

      const rawObjective = campaign.objective || campaign.campaign_objective || '';
      const objective = String(rawObjective).startsWith('OUTCOME_')
        ? rawObjective
        : objectiveMap[rawObjective] || 'OUTCOME_TRAFFIC';

      const settings = campaign.settings || {};
      const durationDays = Math.max(1, Number(settings.durationDays || campaign.duration_days || 30));
      const budgetAmount = Number(campaign.budget_amount || campaign.budget || 0);
      const dailyBudget = campaign.budget_type === 'lifetime'
        ? budgetAmount / durationDays
        : budgetAmount;

      // Validate the complete local definition before creating any external object.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adSets = (campaign.ad_creatives || campaign.ad_sets || []) as any[];
      if (!Array.isArray(adSets) || adSets.length === 0) {
        throw new Error('Campaign has no ad sets to publish');
      }

      // Create Meta campaign
      const metaCampaignResult = await metaService.createCampaign({
        name: campaign.name || campaign.campaign_name,
        objective,
        status: 'PAUSED', // Start paused for review
        dailyBudget: Math.round(dailyBudget * 100), // Convert to cents
      });

      if (!metaCampaignResult.success) {
        throw new Error(metaCampaignResult.error);
      }

      const metaCampaignId = metaCampaignResult.campaignId!;
      createdMetaCampaignId = metaCampaignId;

      // Create ad sets
      const metaAdSetIds: string[] = [];

      for (const adSet of adSets) {
        // Map targeting
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const targeting: any = {
          geoLocations: {
            countries: campaign.targeting?.locations || ['US'],
          },
        };

        if (campaign.targeting.age_range) {
          const [min, max] = campaign.targeting.age_range.split('-').map(Number);
          targeting.ageMin = min;
          targeting.ageMax = max;
        }

        if (campaign.targeting.interests) {
          // Note: In production, you'd need to map interest names to Meta interest IDs
          targeting.interests = campaign.targeting.interests.map((i: string) => ({ id: i, name: i }));
        }

        const metaAdSetResult = await metaService.createAdSet({
          campaignId: metaCampaignId,
          name: adSet.name,
          status: 'PAUSED',
          dailyBudget: Math.round(adSet.budget * 100), // Convert to cents
          billingEvent: 'IMPRESSIONS',
          optimizationGoal: objective.includes('TRAFFIC') ? 'LINK_CLICKS' : 'REACH',
          targeting,
        });

        if (!metaAdSetResult.success) {
          logger.error({ error: metaAdSetResult.error }, 'Failed to create ad set');
          continue;
        }

        const metaAdSetId = metaAdSetResult.adSetId!;
        metaAdSetIds.push(metaAdSetId);

        // Create ads in this ad set
        for (const ad of adSet.ads) {
          let imageHash: string | undefined;

          const metaAdResult = await metaService.createAd({
            adSetId: metaAdSetId,
            name: ad.ad_name,
            status: 'PAUSED',
            creative: {
              name: `${ad.ad_name} Creative`,
              objectStorySpec: {
                pageId: pageId,
                linkData: {
                  link: ad.landing_page_url || 'https://example.com',
                  message: ad.description,
                  name: ad.headline,
                  callToAction: {
                    type: normalizeCtaValue(ad.call_to_action),
                  },
                  imageHash: imageHash,
                },
              },
            },
          });

          if (!metaAdResult.success) {
            logger.error({ error: metaAdResult.error }, 'Failed to create ad');
          }
        }
      }

      if (metaAdSetIds.length === 0) {
        throw new Error('Meta created the campaign, but every ad set failed. Review the campaign before retrying.');
      }

      // Update campaign status in database
      await db.execute(sql`
        UPDATE performance_ad_campaigns
        SET status = 'published',
            platform_campaign_id = ${metaCampaignId},
            updated_at = NOW()
        WHERE id = ${campaignId} AND user_id = ${userId}
      `);

      logger.info({ metaCampaignId: metaCampaignId }, '[PerformanceMarketingAgent] Campaign published to Meta');

      return {
        success: true,
        metaCampaignId,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[PerformanceMarketingAgent] Error publishing to Meta');
      return {
        success: false,
        metaCampaignId: createdMetaCampaignId,
        error: error.message || 'Unknown error',
      };
    }
  }
}
