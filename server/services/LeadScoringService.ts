/**
 * Lead Scoring Service
 * Uses LLM to score leads from 0-100 based on their data quality and potential fit
 * Falls back to rule-based scoring when LLM is disabled
 */

import { LLMProviderFactory } from './agents/LLMProviderFactory';
import { classifyLLMProviderFailure, isProviderResponseError, LLMProviderResponseError, safeLLMProviderFailureMessage } from './agents/LLMProviderErrors.js';
import type { LeadRecord } from '../models/leads/schema';
import { logger } from '../utils/logger.js';
import {
  classifyJevLeadSemanticsBatch,
  JEV_LEAD_BATCH_SIZE,
  JEV_LEAD_MAX_BATCHES,
} from './lead-generation/JevLeadSemanticService.js';
import type { ReviewedLeadConstraints, SemanticLeadQualification } from './lead-generation/LeadGenerationQualityService.js';

export interface LeadData {
  id?: string | number;
  name?: string;
  company?: string;
  role?: string;
  email: string;
  phone?: string;
  linkedin?: string;
  source: string;
  location?: string;
  companySize?: string;
  industry?: string;
  technologies?: string[];
  fundingStage?: string;
  hiringActivity?: boolean;
  // Extended fields from LeadRecord
  fullName?: string;
  companyName?: string;
  seniority?: string;
  followersCount?: number;
  connectionsCount?: number;
  decisionMaker?: boolean;
  verified?: boolean;
  headline?: string;
  bio?: string;
  rating?: string | number;
  reviewCount?: number;
  budgetRange?: string;
  intentScore?: number;
  engagementRate?: string | number;
  rawData?: Record<string, unknown>;
}

export interface LLMScoreResult {
  score: number;
  reasoning: string;
  qualityScore: number;
  relevanceScore: number;
  engagementScore: number;
  fitScore: number;
}

export interface ScoringResult {
  warning?: string;
  leadId: string | number;
  score: number;
  breakdown: {
    roleFit: number;
    companyFit: number;
    engagementSignals: number;
    dataCompleteness: number;
  };
  grade: 'A' | 'B' | 'C' | 'D';
  insights: string[];
  llmScore?: LLMScoreResult;
  semanticFit?: SemanticLeadQualification;
}

const SEMANTIC_FIT_ADJUSTMENTS: Record<SemanticLeadQualification['band'], number> = {
  strong_fit: 6,
  qualified_fit: 3,
  limited_fit: 0,
  poor_fit: -6,
  unknown: 0,
};

export class LeadScoringService {
  private isLLMScoringEnabled: boolean;

  constructor() {
    // Provider will be obtained per-user when needed
    this.isLLMScoringEnabled = (process.env.LEAD_SCORING || '').toLowerCase() === 'true';

    if (this.isLLMScoringEnabled) {
      logger.info('[LeadScoringService] LLM-based lead scoring is enabled');
    }
  }

  private async getLLMProvider(userId: number) {
    const provider = await LLMProviderFactory.createProviderForUser(userId);
    if (!provider) {
      throw new Error('No LLM provider configured for this user. Please add credentials in Settings > Integrations.');
    }
    return provider;
  }

  /**
   * Check if LLM lead scoring is enabled
   */
  isLLMAvailable(): boolean {
    return this.isLLMScoringEnabled;
  }

  /**
   * Score a single lead using LLM (if enabled) + rule-based scoring
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async scoreLead(userId: number, lead: LeadData, icpCriteria: any): Promise<ScoringResult> {
    const constraints = this.getSemanticConstraints(icpCriteria);
    const semanticResults = this.isLLMScoringEnabled
      ? await classifyJevLeadSemanticsBatch(userId, [lead], constraints)
      : new Map<number, SemanticLeadQualification>();
    return this.scoreLeadWithSemantic(userId, lead, icpCriteria, semanticResults.get(0));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async scoreLeadWithSemantic(
    userId: number,
    lead: LeadData,
    icpCriteria: any,
    semanticFit?: SemanticLeadQualification,
  ): Promise<ScoringResult> {
    const breakdown = this.calculateBreakdown(lead, icpCriteria);
    const deterministicScore = Object.values(breakdown).reduce((sum, score) => sum + score, 0);
    const totalScore = this.adjustScoreForSemanticFit(deterministicScore, semanticFit);
    const grade = this.calculateGrade(totalScore);
    const insights = this.generateInsights(lead, breakdown, icpCriteria);

    const result: ScoringResult = {
      leadId: lead.id || lead.email,
      score: totalScore,
      breakdown,
      grade,
      insights,
      ...(semanticFit ? { semanticFit } : {}),
    };
    if (semanticFit) {
      result.insights.push(`Semantic relevance band: ${semanticFit.band.replace('_', ' ')}.`);
    }

    // Add LLM scoring if enabled
    if (this.isLLMScoringEnabled) {
      try {
        const llmScore = await this.scoreLeadWithLLM(userId, lead, icpCriteria);
        result.llmScore = llmScore;
        // Use LLM score as the primary score (0-100 scale)
        result.score = this.adjustScoreForSemanticFit(llmScore.score, semanticFit);
        result.grade = this.calculateGrade(result.score);
        if (llmScore.reasoning) {
          result.insights.unshift(`AI Analysis: ${llmScore.reasoning}`);
        }

        // Deduct credits for LLM-based lead scoring
        try {
          const { deductCreditsForLead } = await import('./CreditDeductionHooks.js');
          await deductCreditsForLead(userId, 'scoring', { leadId: typeof lead.id === 'number' ? lead.id : undefined, service: 'LeadScoringService' });
        } catch (_creditErr) { /* non-blocking */ }
      } catch (error) {
        logger.warn({ err: error }, '[LeadScoringService] LLM scoring failed, using rule-based score');
        if (isProviderResponseError(error) && classifyLLMProviderFailure(error).category === 'insufficient_credits') {
          result.warning = safeLLMProviderFailureMessage(error, error.provider);
        }
      }
    }

    return result;
  }

  private adjustScoreForSemanticFit(score: number, semanticFit?: SemanticLeadQualification): number {
    const adjustment = semanticFit ? SEMANTIC_FIT_ADJUSTMENTS[semanticFit.band] : 0;
    return Math.round(Math.min(100, Math.max(0, score + adjustment)));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getSemanticConstraints(icpCriteria: any): ReviewedLeadConstraints | undefined {
    if (!icpCriteria || typeof icpCriteria !== 'object') return undefined;
    const asText = (value: unknown): string | undefined => {
      if (typeof value === 'string') return value.trim() || undefined;
      if (Array.isArray(value)) {
        const items = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
        return items.length > 0 ? items.join(', ') : undefined;
      }
      return undefined;
    };
    const industry = asText(icpCriteria.industry);
    const subIndustry = asText(icpCriteria.subIndustry || icpCriteria.sub_industry);
    const targetAudience = asText(
      icpCriteria.targetAudience || icpCriteria.target_audience || icpCriteria.primary_job_titles,
    );
    if (!industry && !subIndustry && !targetAudience) return undefined;
    return { industry, subIndustry, targetAudience };
  }

  /**
   * Score a lead using LLM
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async scoreLeadWithLLM(userId: number, lead: LeadData, icpCriteria?: any): Promise<LLMScoreResult> {
    const prompt = this.buildLLMScoringPrompt(lead, icpCriteria);
    
    const llmProvider = await this.getLLMProvider(userId);

    const response = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { 
          role: 'system', 
          content: `You are a lead scoring expert. Analyze the lead data and provide a comprehensive score from 0-100.

Scoring criteria:
1. Data Quality (0-25): Completeness of contact info, profile data, company info
2. Relevance Score (0-25): Match to ICP if provided, industry fit, role seniority
3. Engagement Potential (0-25): Social presence, follower count, engagement metrics
4. Conversion Fit (0-25): Decision-maker status, budget signals, pain points match

Response MUST be valid JSON with this structure:
{
  "score": <overall 0-100>,
  "qualityScore": <0-25>,
  "relevanceScore": <0-25>,
  "engagementScore": <0-25>,
  "fitScore": <0-25>,
  "reasoning": "<brief explanation>"
}`
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      loggingContext: {
        userId,
        purpose: 'lead_scoring',
        service: 'LeadScoringService',
        action: 'score_lead_with_llm',
      },
    });

    if (response.success && response.content) {
      const result = JSON.parse(response.content);
      return {
        score: Math.min(100, Math.max(0, result.score || 0)), 
        reasoning: result.reasoning || '',
        qualityScore: Math.min(25, Math.max(0, result.qualityScore || 0)),
        relevanceScore: Math.min(25, Math.max(0, result.relevanceScore || 0)),
        engagementScore: Math.min(25, Math.max(0, result.engagementScore || 0)),
        fitScore: Math.min(25, Math.max(0, result.fitScore || 0)),
      };
    }

    throw new LLMProviderResponseError(response.error || 'LLM response was unsuccessful', llmProvider.getProviderName(), llmProvider.defaultModel);
  }

  /**
   * Build LLM scoring prompt from lead data
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildLLMScoringPrompt(lead: LeadData, icpCriteria?: any): string {
    const leadData = {
      name: lead.fullName || lead.name || 'Unknown',
      role: lead.role || 'Unknown',
      seniority: lead.seniority || this.extractSeniority(lead.role || ''),
      hasEmail: !!lead.email,
      hasPhone: !!lead.phone,
      company: lead.companyName || lead.company || 'Unknown',
      industry: lead.industry || 'Unknown',
      companySize: lead.companySize || 'Unknown',
      source: lead.source || 'Unknown',
      followersCount: lead.followersCount || 0,
      connectionsCount: lead.connectionsCount || 0,
      verified: lead.verified || false,
      hasLinkedIn: !!lead.linkedin,
      hasHeadline: !!lead.headline,
      hasBio: !!lead.bio,
      decisionMaker: lead.decisionMaker || false,
      budgetRange: lead.budgetRange || 'Unknown',
      intentScore: lead.intentScore || 0,
      rating: lead.rating || null,
      reviewCount: lead.reviewCount || 0,
    };

    let prompt = `Score this lead (0-100):\n\n${JSON.stringify(leadData, null, 2)}`;

    if (icpCriteria) {
      prompt += `\n\nTarget ICP:\n${JSON.stringify(icpCriteria, null, 2)}`;
    }

    return prompt;
  }

  /**
   * Score multiple leads and rank them
   *
   * Phase 5.9 / PERF-007: replaced sequential chunked Promise.all (batch of
   * 5) with a true p-limit(4) worker pool. The chunked approach had a
   * "stair-step" effect — the longest lead in each batch held up the
   * whole batch, and the next batch couldn't start until the previous
   * one finished. p-limit allows a new lead to be picked up as soon as
   * any slot frees, which is closer to the optimal throughput.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async scoreAndRankLeads(userId: number, leads: LeadData[], icpCriteria: any): Promise<ScoringResult[]> {
    const semanticByIndex = new Map<number, SemanticLeadQualification>();
    const constraints = this.getSemanticConstraints(icpCriteria);
    const semanticLimit = JEV_LEAD_BATCH_SIZE * JEV_LEAD_MAX_BATCHES;
    if (constraints && this.isLLMScoringEnabled) {
      for (let offset = 0; offset < Math.min(leads.length, semanticLimit); offset += JEV_LEAD_BATCH_SIZE) {
        const decisions = await classifyJevLeadSemanticsBatch(
          userId,
          leads.slice(offset, offset + JEV_LEAD_BATCH_SIZE),
          constraints,
        );
        for (const [batchIndex, semantic] of decisions) {
          semanticByIndex.set(offset + batchIndex, semantic);
        }
      }
    }

    const CONCURRENCY = 4;
    const scoredLeads: ScoringResult[] = new Array(leads.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < leads.length) {
        const myIdx = cursor++;
        scoredLeads[myIdx] = await this.scoreLeadWithSemantic(
          userId,
          leads[myIdx],
          icpCriteria,
          semanticByIndex.get(myIdx),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leads.length) }, () => worker()));
    // Sort by score descending
    return scoredLeads.sort((a, b) => b.score - a.score);
  }

  /**
   * Score leads from LeadRecord format (used during lead import)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async scoreLeadRecords(userId: number, leads: Partial<LeadRecord>[], icpCriteria?: any): Promise<Map<number, LLMScoreResult>> {
    const results = new Map<number, LLMScoreResult>();

    if (!this.isLLMScoringEnabled) {
      // Use rule-based scoring for all leads
      for (const lead of leads) {
        if (lead.id) {
          results.set(lead.id, this.getRuleBasedScore(lead));
        }
      }
      return results;
    }

    // Score leads in parallel with concurrency limit
    const BATCH_SIZE = 5;
    for (let i = 0; i < leads.length; i += BATCH_SIZE) {
      const batch = leads.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (lead) => {
        try {
          const score = await this.scoreLeadWithLLM(userId, this.convertLeadRecordToLeadData(lead), icpCriteria);
          if (lead.id) {
            results.set(lead.id, score);
          }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
          // Fall back to rule-based score
          if (lead.id) {
            results.set(lead.id, this.getRuleBasedScore(lead));
          }
        }
      });
      await Promise.all(batchPromises);
    }

    return results;
  }

  /**
   * Convert LeadRecord to LeadData format
   */
  private convertLeadRecordToLeadData(lead: Partial<LeadRecord>): LeadData {
    return {
      id: lead.id,
      name: lead.name || undefined,
      fullName: lead.fullName || undefined,
      company: lead.company || undefined,
      companyName: lead.companyName || undefined,
      role: lead.role || undefined,
      email: lead.email || '',
      phone: lead.phone || undefined,
      linkedin: lead.linkedin || lead.linkedinUrl || undefined,
      source: lead.source || '',
      location: typeof lead.location === 'object' ? JSON.stringify(lead.location) : undefined,
      companySize: lead.companySize || undefined,
      industry: lead.industry || undefined,
      seniority: lead.seniority || undefined,
      followersCount: lead.followersCount || undefined,
      connectionsCount: lead.connectionsCount || undefined,
      decisionMaker: lead.decisionMaker || undefined,
      verified: lead.verified || undefined,
      headline: lead.headline || undefined,
      bio: lead.bio || undefined,
      rating: lead.rating ? String(lead.rating) : undefined,
      reviewCount: lead.reviewCount || undefined,
      budgetRange: lead.budgetRange || undefined,
      intentScore: lead.intentScore || undefined,
      engagementRate: lead.engagementRate ? String(lead.engagementRate) : undefined,
      rawData: lead.rawData && typeof lead.rawData === 'object' ? lead.rawData as Record<string, unknown> : undefined,
    };
  }

  /**
   * Rule-based fallback scoring for LeadRecord
   */
  private getRuleBasedScore(lead: Partial<LeadRecord>): LLMScoreResult {
    let qualityScore = 0;
    let relevanceScore = 0;
    let engagementScore = 0;
    let fitScore = 0;
    const reasons: string[] = [];

    // Quality Score (0-25) - Data completeness
    if (lead.email) qualityScore += 5;
    if (lead.phone) qualityScore += 3;
    if (lead.fullName || lead.name) qualityScore += 3;
    if (lead.company || lead.companyName) qualityScore += 3;
    if (lead.role) qualityScore += 3;
    if (lead.linkedin || lead.linkedinUrl) qualityScore += 2;
    if (lead.profilePicture || lead.photo) qualityScore += 2;
    if (lead.headline || lead.bio) qualityScore += 2;
    if (lead.website) qualityScore += 2;
    qualityScore = Math.min(25, qualityScore);

    // Relevance Score (0-25) - Industry and role fit
    if (lead.industry) relevanceScore += 5;
    if (lead.companySize) relevanceScore += 5;
    if (lead.seniority && ['c-level', 'vp', 'director', 'manager'].includes(lead.seniority.toLowerCase())) {
      relevanceScore += 10;
      reasons.push('Senior role');
    }
    if (lead.decisionMaker) {
      relevanceScore += 5;
      reasons.push('Decision maker');
    }
    relevanceScore = Math.min(25, relevanceScore);

    // Engagement Score (0-25) - Social presence
    const followers = lead.followersCount || 0;
    if (followers > 10000) engagementScore += 10;
    else if (followers > 1000) engagementScore += 6;
    else if (followers > 100) engagementScore += 3;

    const connections = lead.connectionsCount || 0;
    if (connections > 500) engagementScore += 8;
    else if (connections > 100) engagementScore += 4;

    if (lead.verified) {
      engagementScore += 5;
      reasons.push('Verified profile');
    }
    engagementScore = Math.min(25, engagementScore);

    // Fit Score (0-25) - Conversion potential
    if (lead.budgetRange) fitScore += 5;
    if (lead.intentScore && lead.intentScore > 50) fitScore += 10;
    if (lead.rating && parseFloat(String(lead.rating)) >= 4.0) fitScore += 5;
    if (lead.reviewCount && lead.reviewCount > 50) fitScore += 5;
    fitScore = Math.min(25, fitScore);

    const totalScore = qualityScore + relevanceScore + engagementScore + fitScore;
    
    if (reasons.length === 0) {
      reasons.push('Scored based on available data');
    }

    return {
      score: totalScore,
      qualityScore,
      relevanceScore,
      engagementScore,
      fitScore,
      reasoning: reasons.join(', '),
    };
  }

  // ============ Original Rule-Based Methods ============

  /**
   * Calculate detailed scoring breakdown
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private calculateBreakdown(lead: LeadData, icpCriteria: any): ScoringResult['breakdown'] {
    return {
      roleFit: this.scoreRoleFit(lead, icpCriteria),
      companyFit: this.scoreCompanyFit(lead, icpCriteria),
      engagementSignals: this.scoreEngagementSignals(lead),
      dataCompleteness: this.scoreDataCompleteness(lead),
    };
  }

  /**
   * Score role fit (0-40 points)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scoreRoleFit(lead: LeadData, icpCriteria: any): number {
    let score = 0;
    const targetRoles = icpCriteria?.primary_job_titles || [];
    const seniorityLevels = icpCriteria?.seniority_levels || [];

    // Exact role match (25 points)
    if (lead.role && targetRoles.some((role: string) => lead.role!.toLowerCase().includes(role.toLowerCase()))) {
      score += 25;
    }

    // Seniority match (10 points)
    if (seniorityLevels.length > 0 && lead.role) {
      const leadSeniority = this.extractSeniority(lead.role);
      if (seniorityLevels.some((level: string) => leadSeniority.includes(level.toLowerCase()))) {
        score += 10;
      }
    }

    // Department match (5 points)
    if (icpCriteria?.department && lead.role?.toLowerCase().includes(icpCriteria.department.toLowerCase())) {
      score += 5;
    }

    return Math.min(score, 40);
  }

  /**
   * Score company fit (0-30 points)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scoreCompanyFit(lead: LeadData, icpCriteria: any): number {
    let score = 0;

    // Company size match (10 points)
    if (icpCriteria?.company_size_range && lead.companySize) {
      if (this.isCompanySizeMatch(lead.companySize, icpCriteria.company_size_range)) {
        score += 10;
      }
    }

    // Industry match (10 points)
    if (icpCriteria?.industry && lead.industry) {
      if (lead.industry.toLowerCase().includes(icpCriteria.industry.toLowerCase())) {
        score += 10;
      }
    }

    // Technology stack match (5 points)
    if (icpCriteria?.tech_stack && lead.technologies) {
      const matchingTech = lead.technologies.filter((tech: string) =>
        icpCriteria.tech_stack.some((icpTech: string) => tech.toLowerCase().includes(icpTech.toLowerCase()))
      );
      if (matchingTech.length > 0) {
        score += 5;
      }
    }

    // Funding stage match (5 points)
    if (icpCriteria?.funding_stage && lead.fundingStage) {
      if (lead.fundingStage.toLowerCase() === icpCriteria.funding_stage.toLowerCase()) {
        score += 5;
      }
    }

    return Math.min(score, 30);
  }

  /**
   * Score engagement signals (0-20 points)
   */
  private scoreEngagementSignals(lead: LeadData): number {
    let score = 0;

    // LinkedIn profile (5 points)
    if (lead.linkedin) {
      score += 5;
    }

    // Phone number (5 points)
    if (lead.phone) {
      score += 5;
    }

    // Hiring activity signal (5 points)
    if (lead.hiringActivity) {
      score += 5;
    }

    // Premium source (5 points for LinkedIn vs others)
    if (lead.source === 'linkedin') {
      score += 5;
    }

    return Math.min(score, 20);
  }

  /**
   * Score data completeness (0-10 points)
   */
  private scoreDataCompleteness(lead: LeadData): number {
    let score = 0;
    const fields = [
      lead.name || lead.fullName,
      lead.company || lead.companyName,
      lead.role,
      lead.email,
      lead.phone,
      lead.linkedin,
      lead.location,
    ];

    const filledFields = fields.filter(field => field && String(field).trim() !== '').length;
    score = (filledFields / fields.length) * 10;

    return Math.round(score);
  }

  /**
   * Calculate grade based on total score
   */
  private calculateGrade(score: number): 'A' | 'B' | 'C' | 'D' {
    if (score >= 80) return 'A';
    if (score >= 60) return 'B';
    if (score >= 40) return 'C';
    return 'D';
  }

  /**
   * Generate insights for the lead
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  private generateInsights(lead: LeadData, breakdown: ScoringResult['breakdown'], icpCriteria: any): string[] {
    const insights: string[] = [];

    if (breakdown.roleFit >= 25) {
      insights.push(`Strong role match: ${lead.role}`);
    }

    if (breakdown.companyFit >= 20) {
      insights.push(`Good company fit in ${lead.industry || 'target industry'}`);
    }

    if (breakdown.engagementSignals >= 15) {
      insights.push('High engagement potential with complete contact info');
    }

    if (breakdown.dataCompleteness >= 8) {
      insights.push('Excellent data completeness for outreach');
    }

    if (breakdown.roleFit < 10) {
      insights.push('Consider if role alignment is sufficient for your campaign goals');
    }

    return insights;
  }

  /**
   * Extract seniority level from role title
   */
  private extractSeniority(role: string): string {
    const lowerRole = role.toLowerCase();

    if (lowerRole.includes('vp') || lowerRole.includes('vice president') || lowerRole.includes('director')) {
      return 'executive';
    }
    if (lowerRole.includes('senior') || lowerRole.includes('sr.') || lowerRole.includes('lead') || lowerRole.includes('principal')) {
      return 'senior';
    }
    if (lowerRole.includes('manager') || lowerRole.includes('supervisor')) {
      return 'mid';
    }

    return 'junior';
  }

  /**
   * Check if company size matches criteria
   */
  private isCompanySizeMatch(leadSize: string, icpSize: string): boolean {
    // Simple size matching logic
    const normalizeSize = (size: string) => size.toLowerCase().replace(/[^0-9-]/g, '');

    const leadNormalized = normalizeSize(leadSize);
    const icpNormalized = normalizeSize(icpSize);

    // Check for range overlap or exact match
    return leadNormalized.includes(icpNormalized) || icpNormalized.includes(leadNormalized);
  }
}

// Export singleton instance
export const leadScoringService = new LeadScoringService();
