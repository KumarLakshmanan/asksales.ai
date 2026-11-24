import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { LLMProviderFactory } from './agents/LLMProviderFactory';
import { logger } from '../utils/logger.js';

/**
 * Outreach Channel Decision Engine
 * Picks the best outreach channel per lead based on available data
 */

export type OutreachChannel = 'email' | 'linkedin' | 'instagram' | 'twitter' | 'phone' | 'sms';

export interface ChannelAvailability {
  email: boolean;
  linkedin: boolean;
  instagram: boolean;
  twitter: boolean;
  phone: boolean;
  sms: boolean;
}

export interface ChannelScore {
  channel: OutreachChannel;
  score: number;
  reasoning: string;
  available: boolean;
}

export interface ChannelDecision {
  recommendedChannel: OutreachChannel;
  alternativeChannels: OutreachChannel[];
  channelScores: ChannelScore[];
  reasoning: string;
  leadId: number;
}

const CHANNEL_BASE_SCORES: Record<OutreachChannel, number> = {
  email: 85,      // Most professional, highest reach
  linkedin: 90,   // Best for B2B, high engagement
  phone: 75,      // Direct but intrusive
  twitter: 60,    // Good for tech/startup
  instagram: 50,  // Better for B2C/creative
  sms: 40,        // Only for warm leads
};

const INDUSTRY_CHANNEL_BOOST: Record<string, Record<OutreachChannel, number>> = {
  technology: { linkedin: 15, twitter: 10, email: 5, instagram: 0, phone: 0, sms: 0 },
  software: { linkedin: 15, twitter: 10, email: 5, instagram: 0, phone: 0, sms: 0 },
  saas: { linkedin: 15, twitter: 10, email: 5, instagram: 0, phone: 0, sms: 0 },
  finance: { email: 10, linkedin: 10, phone: 5, twitter: 0, instagram: 0, sms: 0 },
  marketing: { linkedin: 10, instagram: 15, twitter: 10, email: 5, phone: 0, sms: 0 },
  creative: { instagram: 20, twitter: 10, linkedin: 5, email: 0, phone: 0, sms: 0 },
  retail: { email: 10, phone: 10, sms: 10, instagram: 5, linkedin: 0, twitter: 0 },
  healthcare: { email: 10, phone: 10, linkedin: 5, twitter: 0, instagram: 0, sms: 0 },
  education: { email: 15, linkedin: 10, twitter: 5, instagram: 0, phone: 0, sms: 0 },
  consulting: { linkedin: 15, email: 10, phone: 5, twitter: 0, instagram: 0, sms: 0 },
};

// Role-based adjustments
const ROLE_CHANNEL_BOOST: Record<string, Record<OutreachChannel, number>> = {
  ceo: { linkedin: 10, email: 5, phone: 0, twitter: 0, instagram: 0, sms: 0 },
  cto: { linkedin: 15, twitter: 10, email: 5, instagram: 0, phone: 0, sms: 0 },
  cmo: { linkedin: 10, instagram: 10, twitter: 10, email: 5, phone: 0, sms: 0 },
  founder: { linkedin: 10, twitter: 10, email: 5, instagram: 0, phone: 0, sms: 0 },
  developer: { twitter: 15, linkedin: 10, email: 5, instagram: 0, phone: 0, sms: 0 },
  designer: { instagram: 15, twitter: 10, linkedin: 5, email: 0, phone: 0, sms: 0 },
  sales: { phone: 15, linkedin: 10, email: 5, twitter: 0, instagram: 0, sms: 5 },
  marketing: { linkedin: 10, instagram: 10, twitter: 10, email: 5, phone: 0, sms: 0 },
};

class OutreachChannelDecisionEngine {

  /**
   * Get available channels for a lead
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChannelAvailability(lead: any): ChannelAvailability {
    const hasEmail = Boolean(lead.email);
    return {
      email: hasEmail,
      linkedin: Boolean(lead.linkedinUrl || lead.linkedin_url || lead.linkedin || lead.linkedinId),
      instagram: Boolean(lead.instagramId || lead.instagram_id || lead.instagram),
      twitter: Boolean(lead.twitterId || lead.twitter_id || lead.twitter || lead.twitterHandle),
      phone: Boolean(lead.phone || lead.phoneNumber),
      sms: Boolean(lead.phone || lead.phoneNumber),
    };
  }

  /**
   * Calculate channel scores for a lead
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calculateChannelScores(lead: any, availability: ChannelAvailability): ChannelScore[] {
    const scores: ChannelScore[] = [];
    const industry = (lead.industry || '').toLowerCase();
    const role = (lead.role || lead.jobTitle || lead.title || '').toLowerCase();

    for (const channel of Object.keys(CHANNEL_BASE_SCORES) as OutreachChannel[]) {
      let score = CHANNEL_BASE_SCORES[channel];
      const reasons: string[] = [`Base score: ${CHANNEL_BASE_SCORES[channel]}`];

      // Check availability
      if (!availability[channel]) {
        scores.push({
          channel,
          score: 0,
          reasoning: 'Not available - missing contact info',
          available: false,
        });
        continue;
      }

      // Industry boost
      for (const [ind, boosts] of Object.entries(INDUSTRY_CHANNEL_BOOST)) {
        if (industry.includes(ind)) {
          const boost = boosts[channel] || 0;
          if (boost > 0) {
            score += boost;
            reasons.push(`Industry (${ind}): +${boost}`);
          }
          break;
        }
      }

      // Role boost
      for (const [r, boosts] of Object.entries(ROLE_CHANNEL_BOOST)) {
        if (role.includes(r)) {
          const boost = boosts[channel] || 0;
          if (boost > 0) {
            score += boost;
            reasons.push(`Role (${r}): +${boost}`);
          }
          break;
        }
      }

      // Lead status adjustments
      if (lead.status === 'hot' || lead.status === 'warm') {
        if (channel === 'phone' || channel === 'sms') {
          score += 10;
          reasons.push('Warm/hot lead: +10');
        }
      }

      // Previous engagement boost
      if (lead.replied_emails && lead.replied_emails > 0) {
        if (channel === 'email') {
          score += 15;
          reasons.push('Previous email replies: +15');
        }
      }

      // Lead score adjustment
      if (lead.lead_score) {
        const leadScore = Number(lead.lead_score);
        if (leadScore >= 80 && (channel === 'phone' || channel === 'linkedin')) {
          score += 10;
          reasons.push('High lead score: +10');
        }
      }

      // Company size adjustment for LinkedIn
      if (lead.companySize || lead.company_size) {
        const size = (lead.companySize || lead.company_size || '').toLowerCase();
        if ((size.includes('enterprise') || size.includes('1000+')) && channel === 'linkedin') {
          score += 10;
          reasons.push('Enterprise company: +10 for LinkedIn');
        }
      }

      scores.push({
        channel,
        score: Math.min(100, Math.max(0, score)),
        reasoning: reasons.join(', '),
        available: true,
      });
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    return scores;
  }

  /**
   * Get the recommended channel for a lead
   */
  async getRecommendedChannel(leadId: number): Promise<ChannelDecision> {
    try {
      const leadResult = await db.execute(sql`
        SELECT * FROM leads WHERE id = ${leadId}
      `);

      if (leadResult.rows.length === 0) {
        throw new Error('Lead not found');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = leadResult.rows[0] as any;
      const availability = this.getChannelAvailability(lead);
      const channelScores = this.calculateChannelScores(lead, availability);

      // Get available channels sorted by score
      const availableChannels = channelScores.filter((c) => c.available && c.score > 0);

      if (availableChannels.length === 0) {
        return {
          recommendedChannel: 'email',
          alternativeChannels: [],
          channelScores,
          reasoning: 'No outreach channels available for this lead',
          leadId,
        };
      }

      const recommended = availableChannels[0].channel;
      const alternatives = availableChannels.slice(1, 3).map((c) => c.channel);

      return {
        recommendedChannel: recommended,
        alternativeChannels: alternatives,
        channelScores,
        reasoning: availableChannels[0].reasoning,
        leadId,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[ChannelDecisionEngine] Error:');
      throw error;
    }
  }

  /**
   * Get recommended channels for multiple leads
   */
  async getRecommendedChannelsBulk(leadIds: number[]): Promise<ChannelDecision[]> {
    const decisions: ChannelDecision[] = [];

    for (const leadId of leadIds) {
      try {
        const decision = await this.getRecommendedChannel(leadId);
        decisions.push(decision);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        logger.error({ err: error }, `[ChannelDecisionEngine] Error for lead ${leadId}:`);
      }
    }

    return decisions;
  }

  /**
   * Use AI to get a more nuanced channel recommendation
   */
  async getAIRecommendedChannel(leadId: number, userId?: number): Promise<ChannelDecision> {
    try {
      const leadResult = await db.execute(sql`
        SELECT * FROM leads WHERE id = ${leadId}
      `);

      if (leadResult.rows.length === 0) {
        throw new Error('Lead not found');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = leadResult.rows[0] as any;
      const leadUserId = userId || lead.user_id;
      
      if (!leadUserId) {
        // Fall back to rule-based decision if no userId available
        return this.getRecommendedChannel(leadId);
      }
      
      const availability = this.getChannelAvailability(lead);
      const channelScores = this.calculateChannelScores(lead, availability);

      // Build context for AI
      const leadContext = {
        name: lead.name || lead.full_name,
        company: lead.company || lead.company_name,
        role: lead.role || lead.title || lead.job_title,
        industry: lead.industry,
        status: lead.status,
        leadScore: lead.lead_score,
        location: lead.location,
        availableChannels: Object.entries(availability)
          .filter(([_, available]) => available)
          .map(([channel]) => channel),
        previousContacts: lead.messages_sent || 0,
        previousReplies: lead.replied_emails || 0,
      };

      const provider = await LLMProviderFactory.createProviderForUser(leadUserId);
      const model = await LLMProviderFactory.getDefaultModelForUser(leadUserId) || 'gpt-5.2';

      const response = await provider.createChatCompletion({
        model: model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId: leadUserId,
          purpose: 'channel_decision',
          service: 'OutreachChannelDecisionEngine'
        },
        messages: [
          {
            role: 'system',
            content: `You are an expert sales strategist helping to choose the best outreach channel.
Based on the lead information, recommend the best channel to contact them.

Consider:
- Industry norms and preferences
- Role and seniority
- Available contact methods
- Previous engagement history
- Lead status (hot/warm/cold)

Respond with JSON:
{
  "recommendedChannel": "email" | "linkedin" | "twitter" | "instagram" | "phone" | "sms",
  "reasoning": "Brief explanation",
  "alternativeChannels": ["second", "third"],
  "tips": "Any specific tips for reaching out via this channel"
}`,
          },
          {
            role: 'user',
            content: `Recommend the best outreach channel for this lead:

${JSON.stringify(leadContext, null, 2)}`,
          },
        ],
      });

      const content = response.content || '{}';
      const aiRecommendation = JSON.parse(content);

      return {
        recommendedChannel: aiRecommendation.recommendedChannel || channelScores[0]?.channel || 'email',
        alternativeChannels: aiRecommendation.alternativeChannels || [],
        channelScores,
        reasoning: `${aiRecommendation.reasoning || ''} ${aiRecommendation.tips || ''}`.trim(),
        leadId,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[ChannelDecisionEngine] AI recommendation error:');
      // Fall back to rule-based decision
      return this.getRecommendedChannel(leadId);
    }
  }

  /**
   * Get channel statistics for all leads
   */
  async getChannelStats(userId?: number): Promise<{
    totalLeads: number;
    channelAvailability: Record<OutreachChannel, number>;
    recommendedDistribution: Record<OutreachChannel, number>;
  }> {
    try {
      const query = userId
        ? sql`SELECT * FROM leads WHERE user_id = ${userId}`
        : sql`SELECT * FROM leads`;

      const result = await db.execute(query);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const leads = result.rows as any[];

      const stats = {
        totalLeads: leads.length,
        channelAvailability: {
          email: 0,
          linkedin: 0,
          instagram: 0,
          twitter: 0,
          phone: 0,
          sms: 0,
        } as Record<OutreachChannel, number>,
        recommendedDistribution: {
          email: 0,
          linkedin: 0,
          instagram: 0,
          twitter: 0,
          phone: 0,
          sms: 0,
        } as Record<OutreachChannel, number>,
      };

      for (const lead of leads) {
        const availability = this.getChannelAvailability(lead);
        const scores = this.calculateChannelScores(lead, availability);

        // Count availability
        for (const [channel, available] of Object.entries(availability)) {
          if (available) {
            stats.channelAvailability[channel as OutreachChannel]++;
          }
        }

        // Count recommended
        const recommended = scores.find((s) => s.available && s.score > 0);
        if (recommended) {
          stats.recommendedDistribution[recommended.channel]++;
        }
      }

      return stats;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[ChannelDecisionEngine] Stats error:');
      return {
        totalLeads: 0,
        channelAvailability: { email: 0, linkedin: 0, instagram: 0, twitter: 0, phone: 0, sms: 0 },
        recommendedDistribution: { email: 0, linkedin: 0, instagram: 0, twitter: 0, phone: 0, sms: 0 },
      };
    }
  }
}

export const channelDecisionEngine = new OutreachChannelDecisionEngine();
