/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Content Studio Agent
 * Generates content plans, ad copies, content pieces, creative prompts, images, and videos
 */

import { LLMProviderFactory } from './LLMProviderFactory';
import type { LLMChatOptions, LLMResponse } from './LLMProvider';
import { db } from '../../models/db';
import { sql } from 'drizzle-orm';
import type { ICPProfile } from '../ICPGenerationService';
import {
  createImageGenerationWorker,
  createVideoGenerationWorker,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type VideoGenerationRequest,
  type VideoGenerationResult,
} from '../media/MediaGenerationWorkerFactory';
import { logger } from '../../utils/logger.js';
import { eventBus } from '../../events/EventBus.js';

export interface ContentPlan {
  id?: number;
  icp_id: number;
  duration_days: number;
  themes: string[];
  content_types: string[];
  frequency: string;
  calendar: ContentCalendarItem[];
  created_at?: Date;
}

export interface ContentCalendarItem {
  day: number;
  date: string;
  content_type: string;
  theme: string;
  title: string;
  description: string;
  platform: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface AdCopy {
  id?: number;
  icp_id: number;
  platform: 'google' | 'facebook' | 'linkedin' | 'twitter' | 'instagram';
  headline: string;
  body: string;
  call_to_action: string;
  target_keywords?: string[];
  tags?: string[];  // Tags for categorizing ads (e.g., "promotional", "awareness")
  character_counts: {
    headline: number;
    body: number;
  };
  variations?: AdCopyVariation[];
  created_at?: Date;
}

export interface AdCopyVariation {
  headline: string;
  body: string;
  call_to_action: string;
  tags?: string[];  // Tags for this variation
  // Meta Ads specific fields
  primaryText?: string;      // Main text above the image
  description?: string;      // Link description
  displayUrl?: string;       // Display URL (e.g., yoursite.com/offer)
  callToActionType?: string; // LEARN_MORE, SHOP_NOW, SIGN_UP, etc.
}

export interface ContentPiece {
  id?: number;
  icp_id: number;
  content_type: 'blog' | 'whitepaper' | 'case_study' | 'email' | 'social_post' | 'video_script';
  title: string;
  content: string;
  meta_description?: string;
  keywords?: string[];
  word_count: number;
  tone: 'professional' | 'casual' | 'technical' | 'friendly';
  created_at?: Date;
}

export interface CreativePrompt {
  id?: number;
  icp_id: number;
  creative_type: 'image' | 'video' | 'infographic' | 'carousel';
  prompt: string;
  style_guide: string;
  dimensions?: string;
  color_palette?: string[];
  key_elements: string[];
  created_at?: Date;
}

export interface OutreachCopy {
  id?: number;
  lead_id: number | null;
  lead_name: string;
  lead_company: string;
  outreach_type: 'email' | 'sms' | 'dm';
  tone: string;
  purpose: string;
  subject_line?: string | null;
  preview_text?: string | null;
  opening_hook?: string | null;
  body: string;
  cta: string;
  created_at?: Date;
}

export class ContentStudioAgent {
  constructor() {
    // Provider will be obtained dynamically per-method with userId
  }

  /**
   * Use the configured provider fallback chain for every legacy studio draft.
   */
  private async createTextCompletion(userId: number, options: Pick<LLMChatOptions, 'messages' | 'temperature' | 'max_tokens' | 'response_format' | 'loggingContext'>): Promise<LLMResponse> {
    const response = await LLMProviderFactory.createChatCompletionWithFallback(userId, { ...options, model: '' });
    if (!response.success) {
      throw new Error(response.error || 'All configured text-generation providers failed.');
    }
    return response;
  }

  /**
   * Generate a 30-day content plan based on ICP
   */
  async generateContentPlan(userId: number, icp: ICPProfile, durationDays: number = 30): Promise<ContentPlan> {
    try {
      logger.info('[ContentStudioAgent] Generating content plan for ICP');

      const systemPrompt = `You are an expert content strategist. Generate a comprehensive content calendar for a marketing campaign.

ICP Details:
- Target Audience: ${icp.targetAudience}
- Industry: ${icp.industry}
- Company Size: ${icp.targetCompanySizeRange}
- Pain Points: ${JSON.stringify(icp.primaryPainPoint ? [icp.primaryPainPoint] : [])}
- Primary Channels: ${JSON.stringify(icp.primaryChannels || [])}

Generate a ${durationDays}-day content calendar with:
1. 3-5 main content themes based on pain points and value propositions
2. Mix of content types: blogs, social posts, videos, whitepapers, case studies
3. Platform-specific content for each channel
4. Daily posting schedule with priorities
5. Balance of educational, promotional, and engaging content

Return JSON with this structure:
{
  "themes": ["theme1", "theme2", "theme3"],
  "content_types": ["blog", "social_post", "video"],
  "frequency": "2-3 posts per day",
  "calendar": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "content_type": "blog",
      "theme": "theme1",
      "title": "Content title",
      "description": "Brief description",
      "platform": ["linkedin", "website"],
      "priority": "high"
    }
  ]
}`;

      const completionResp = await this.createTextCompletion(userId, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate a ${durationDays}-day content calendar starting from today.` },
        ],
        temperature: 0.7,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'content_generation',
          service: 'ContentStudioAgent',
          action: 'generate_content_plan',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      const parsedData = JSON.parse(rawResponse);

      const contentPlan: ContentPlan = {
        icp_id: icp.id!,
        duration_days: durationDays,
        themes: parsedData.themes || [],
        content_types: parsedData.content_types || [],
        frequency: parsedData.frequency || '2-3 posts per day',
        calendar: parsedData.calendar || [],
      };

      logger.info({ count: contentPlan.calendar.length }, '[ContentStudioAgent] Generated content plan with items');
       
      eventBus.publish({ channel: 'events:content:generated' as any, userId: icp.userId!, timestamp: new Date().toISOString(), data: { type: 'content_plan' } }).catch(() => {});
      return contentPlan;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error generating content plan');
      throw error;
    }
  }

  /**
   * Generate ad copy for specific platform
   */
  async generateAdCopy(
    userId: number,
    icp: ICPProfile,
    platform: 'google' | 'facebook' | 'linkedin' | 'twitter' | 'instagram',
    variations: number = 3,
    businessWebsite?: string
  ): Promise<AdCopy> {
    try {
      logger.info({ platform: platform }, '[ContentStudioAgent] Generating ad copy for');

      const platformSpecs = this.getPlatformSpecs(platform);
      const isMetaPlatform = platform === 'facebook' || platform === 'instagram';
      
      // Determine display URL to use
      const displayUrlExample = businessWebsite 
        ? businessWebsite.replace(/^https?:\/\//, '').split('/')[0] 
        : 'yoursite.com';

      // Build platform-specific system prompt with Meta regulations
      const metaAdFields = isMetaPlatform ? `
For Meta Ads (Facebook/Instagram), generate the following fields for each variation:
- headline: The main ad headline (max ${platformSpecs.headlineMax} chars) - appears below the image
- primaryText: The engaging text that appears above the image (max 125 chars recommended, 500 max)
- description: Link description shown below headline (max 30 chars recommended)
- displayUrl: A shortened display URL like "${displayUrlExample}/offer" (use the actual domain, not a placeholder)
- callToActionType: MUST be EXACTLY one of these values (no variations, pick the most appropriate):
  * LEARN_MORE - For informational content, articles, details
  * SHOP_NOW - For e-commerce, products, shopping
  * SIGN_UP - For registration, newsletters, membership
  * DOWNLOAD - For apps, ebooks, resources
  * CONTACT_US - For services, inquiries
  * GET_QUOTE - For pricing, estimates, custom services
  * BOOK_NOW - For appointments, reservations
  * SUBSCRIBE - For subscriptions, recurring services
  * GET_OFFER - For promotions, discounts, deals
  * APPLY_NOW - For jobs, applications, credit
  * BUY_NOW - For direct purchases
  * WATCH_MORE - For video content
  * ORDER_NOW - For food, delivery services
  * CALL_NOW - For phone-based services
  * TRY_NOW - For free trials, demos

CRITICAL: Use ONLY the exact CTA values listed above. Do not create custom CTAs.

META ADVERTISING POLICIES - MUST FOLLOW:
1. NO misleading or deceptive content - claims must be truthful and verifiable
2. NO discriminatory content based on race, ethnicity, gender, religion, age, disability
3. NO sensational or shocking language designed to provoke emotional responses
4. NO personal attributes - don't reference or imply user's personal characteristics (e.g., "Are you overweight?")
5. NO prohibited content: illegal products, adult content, tobacco, drugs, weapons
6. NO before/after images for weight loss, cosmetic procedures without proper disclaimers
7. NO unrealistic promises or guaranteed results
8. NO clickbait or engagement bait tactics
9. NO excessive capitalization or symbols (!!!, ???, $$$)
10. Landing page MUST match ad content and be functional
11. Clear disclosure if content is sponsored or promotional
12. Respect privacy - don't collect personal data inappropriately
` : '';

      const systemPrompt = `You are an expert digital advertising copywriter. Generate compelling ad copy for ${platform}.

ICP Details:
- Target Audience: ${icp.targetAudience}
- Industry: ${icp.industry}
- Pain Points: ${JSON.stringify(icp.primaryPainPoint ? [icp.primaryPainPoint] : [])}
- Value Proposition: ${icp.primaryValueProposition || 'Innovative solution'}
- Budget Range: ${icp.budgetRange || 'Not specified'}

Platform Specifications (${platform}):
- Headline max length: ${platformSpecs.headlineMax} characters
- Body max length: ${platformSpecs.bodyMax} characters
- CTA requirements: ${platformSpecs.ctaGuidelines}
${metaAdFields}

Generate ${variations} variations of ad copy that:
1. Hook attention immediately with clear value proposition
2. Address specific pain points professionally
3. Highlight unique value proposition
4. Include strong call-to-action
5. Stay within character limits
6. Use platform-appropriate professional tone
7. Are compliant with all advertising regulations and platform policies
${isMetaPlatform ? '8. Include all Meta Ads fields (primaryText, headline, description, displayUrl, callToActionType)' : ''}

Return JSON:
{
  "headline": "Main headline",
  "body": "Ad body text",
  "call_to_action": "CTA text",
  "target_keywords": ["keyword1", "keyword2"],
  "tags": ["promotional", "awareness", "seasonal"],
  "variations": [
    {
      "headline": "Short punchy headline",
      "body": "Ad body text with value proposition",
      "call_to_action": "CTA text",
      "tags": ["tag1", "tag2"]${isMetaPlatform ? `,
      "primaryText": "Engaging text above the image that hooks attention",
      "description": "Short link description",
      "displayUrl": "${displayUrlExample}/offer",
      "callToActionType": "LEARN_MORE"` : ''}
    }
  ]
}

IMPORTANT: Include 3-5 descriptive "tags" for each variation to categorize the ad (e.g., "promotional", "product-launch", "seasonal", "awareness", "retargeting", "brand", "conversion", "engagement", "lead-gen", etc.)`;

      const completionResp = await this.createTextCompletion(userId, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate ${variations} variations of ${platform} ad copy.` },
        ],
        temperature: 0.8,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'ad_copy_generation',
          service: 'ContentStudioAgent',
          action: 'generate_ad_copy',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      const parsedData = JSON.parse(rawResponse);

      const adCopy: AdCopy = {
        icp_id: icp.id!,
        platform,
        headline: parsedData.headline || '',
        body: parsedData.body || '',
        call_to_action: parsedData.call_to_action || 'Learn More',
        target_keywords: parsedData.target_keywords || [],
        tags: parsedData.tags || [],
        character_counts: {
          headline: parsedData.headline?.length || 0,
          body: parsedData.body?.length || 0,
        },
        variations: parsedData.variations || [],
      };

      logger.info({ count: adCopy.variations?.length || 0 }, '[ContentStudioAgent] Generated ad copy with variations');
       
      eventBus.publish({ channel: 'events:content:generated' as any, userId, timestamp: new Date().toISOString(), data: { type: 'ad_copy', platform } }).catch(() => {});
      return adCopy;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error generating ad copy');
      throw error;
    }
  }

  /**
   * Generate full content piece (blog, whitepaper, etc.)
   */
  async generateContentPiece(
    userId: number,
    icp: ICPProfile,
    contentType: 'blog' | 'whitepaper' | 'case_study' | 'email' | 'social_post' | 'video_script',
    topic?: string,
    tone: 'professional' | 'casual' | 'technical' | 'friendly' = 'professional'
  ): Promise<ContentPiece> {
    try {
      logger.info({ contentType: contentType }, '[ContentStudioAgent] Generating content piece');

      const contentSpecs = this.getContentSpecs(contentType);

      const systemPrompt = `You are an expert content writer specializing in B2B/B2C marketing content. Generate high-quality ${contentType} content.

ICP Details:
- Target Audience: ${icp.targetAudience}
- Industry: ${icp.industry}
- Pain Points: ${JSON.stringify(icp.primaryPainPoint ? [icp.primaryPainPoint] : [])}
- Value Proposition: ${icp.primaryValueProposition || 'Innovative solution'}

Content Specifications:
- Type: ${contentType}
- Target word count: ${contentSpecs.wordCount}
- Tone: ${tone}
- Structure: ${contentSpecs.structure}

Generate compelling content that:
1. Opens with a strong hook
2. Addresses specific pain points
3. Provides actionable insights
4. Includes relevant examples
5. Ends with clear next steps
6. Is SEO-optimized with keywords

Return JSON:
{
  "title": "Content title",
  "content": "Full content body with proper formatting",
  "meta_description": "SEO meta description",
  "keywords": ["keyword1", "keyword2"],
  "word_count": 1500
}`;

      const userMessage = topic
        ? `Generate a ${contentType} about: ${topic}`
        : `Generate a ${contentType} addressing the main pain points and value proposition.`;

      const completionResp = await this.createTextCompletion(userId, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'content_generation',
          service: 'ContentStudioAgent',
          action: 'generate_content_piece',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      const parsedData = JSON.parse(rawResponse);

      const contentPiece: ContentPiece = {
        icp_id: icp.id!,
        content_type: contentType,
        title: parsedData.title || `${contentType} - ${icp.targetAudience}`,
        content: parsedData.content || '',
        meta_description: parsedData.meta_description || '',
        keywords: parsedData.keywords || [],
        word_count: parsedData.word_count || parsedData.content?.split(' ').length || 0,
        tone,
      };

      logger.info({ contentType: contentType, word_count: contentPiece.word_count }, '[ContentStudioAgent] Generated with words');
      return contentPiece;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error generating content piece');
      throw error;
    }
  }

  /**
   * Generate creative prompts for visual content
   */
  async generateCreativePrompts(
    userId: number,
    icp: ICPProfile,
    creativeType: 'image' | 'video' | 'infographic' | 'carousel',
    count: number = 3
  ): Promise<CreativePrompt[]> {
    try {
      if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
        throw new Error('Creative prompt count must be an integer from 1 to 20.');
      }
      logger.info({ count: count, creativeType: creativeType }, '[ContentStudioAgent] Generating creative prompts');

      const systemPrompt = `You are an expert creative director specializing in visual content for marketing campaigns. Generate detailed creative prompts for ${creativeType} content.

ICP Details:
- Target Audience: ${icp.targetAudience}
- Industry: ${icp.industry}
- Brand Tone: ${icp.primaryValueProposition || 'Professional and innovative'}

Generate ${count} creative prompts that:
1. Align with brand and audience
2. Are visually compelling
3. Include specific style directions
4. Specify dimensions/formats
5. List color palettes
6. Detail key visual elements

Return a JSON object with exactly ${count} items in its "prompts" array:
{"prompts": [
  {
    "prompt": "Detailed creative prompt for AI image generation or designer brief",
    "style_guide": "Visual style description (e.g., minimalist, bold, corporate)",
    "dimensions": "1200x628 (Facebook), 1080x1080 (Instagram), etc.",
    "color_palette": ["#FF5733", "#3498DB"],
    "key_elements": ["logo", "headline", "CTA button", "product image"]
  }
]}`;

      const completionResp = await this.createTextCompletion(userId, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate ${count} ${creativeType} creative prompts for this campaign.` },
        ],
        temperature: 0.8,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'content_generation',
          service: 'ContentStudioAgent',
          action: 'generate_creative_prompts',
        },
      });

      const rawResponse = completionResp.content;
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      const parsedData = JSON.parse(rawResponse);
      const promptsArray = Array.isArray(parsedData) ? parsedData : parsedData?.prompts ?? parsedData?.creatives;
      if (!Array.isArray(promptsArray) || promptsArray.length !== count) {
        throw new Error(`The provider must return exactly ${count} creative prompts.`);
      }
      if (promptsArray.some((item: unknown) => !item || typeof item !== 'object'
        || typeof (item as { prompt?: unknown }).prompt !== 'string'
        || !(item as { prompt: string }).prompt.trim())) {
        throw new Error('The provider returned an empty or invalid creative prompt.');
      }

       
      const creativePrompts: CreativePrompt[] = promptsArray.map((item: any) => ({
        icp_id: icp.id!,
        creative_type: creativeType,
        prompt: item.prompt.trim(),
        style_guide: item.style_guide || 'Modern and professional',
        dimensions: item.dimensions || '1200x628',
        color_palette: item.color_palette || [],
        key_elements: item.key_elements || [],
      }));

      logger.info({ count: creativePrompts.length }, '[ContentStudioAgent] Generated creative prompts');
      return creativePrompts;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error generating creative prompts');
      throw error;
    }
  }

  /**
   * Save content plan to database
   */
  async saveContentPlan(contentPlan: ContentPlan, userId: number): Promise<number> {
    try {
      const result = await db.execute(sql`
        INSERT INTO content_plans (
          icp_id,
          user_id,
          duration_days,
          themes,
          content_types,
          frequency,
          calendar,
          created_at
        ) VALUES (
          ${contentPlan.icp_id},
          ${userId},
          ${contentPlan.duration_days},
          ${JSON.stringify(contentPlan.themes)}::jsonb,
          ${JSON.stringify(contentPlan.content_types)}::jsonb,
          ${contentPlan.frequency},
          ${JSON.stringify(contentPlan.calendar)}::jsonb,
          NOW()
        )
        RETURNING id
      `);

       
      const id = (result.rows[0] as any).id;
      logger.info({ id: id }, '[ContentStudioAgent] Content plan saved with ID');
      return id;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error saving content plan');
      throw error;
    }
  }

  /**
   * Save ad copy to database
   */
  async saveAdCopy(adCopy: AdCopy, userId: number): Promise<number> {
    try {
      const result = await db.execute(sql`
        INSERT INTO ad_copies (
          icp_id,
          user_id,
          platform,
          headline,
          body,
          call_to_action,
          target_keywords,
          character_counts,
          variations,
          created_at
        ) VALUES (
          ${adCopy.icp_id},
          ${userId},
          ${adCopy.platform},
          ${adCopy.headline},
          ${adCopy.body},
          ${adCopy.call_to_action},
          ${JSON.stringify(adCopy.target_keywords)}::jsonb,
          ${JSON.stringify(adCopy.character_counts)}::jsonb,
          ${JSON.stringify(adCopy.variations)}::jsonb,
          NOW()
        )
        RETURNING id
      `);

       
      const id = (result.rows[0] as any).id;
      logger.info({ id: id }, '[ContentStudioAgent] Ad copy saved with ID');
      return id;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error saving ad copy');
      throw error;
    }
  }

  /**
   * Get platform-specific ad specifications
   */
  private getPlatformSpecs(platform: string) {
     
    const specs: Record<string, any> = {
      google: {
        headlineMax: 30,
        bodyMax: 90,
        ctaGuidelines: 'Clear action verb (Shop, Learn, Sign Up)',
      },
      facebook: {
        headlineMax: 40,
        bodyMax: 125,
        ctaGuidelines: 'Engaging and benefit-focused',
      },
      linkedin: {
        headlineMax: 70,
        bodyMax: 150,
        ctaGuidelines: 'Professional and direct',
      },
      twitter: {
        headlineMax: 280,
        bodyMax: 280,
        ctaGuidelines: 'Concise with hashtags',
      },
      instagram: {
        headlineMax: 2200,
        bodyMax: 2200,
        ctaGuidelines: 'Visual-first with emojis',
      },
    };

    return specs[platform] || specs.google;
  }

  /**
   * Get content type specifications
   */
  private getContentSpecs(contentType: string) {
     
    const specs: Record<string, any> = {
      blog: {
        wordCount: '1200-1800 words',
        structure: 'Introduction, 3-5 main sections with subheadings, conclusion with CTA',
      },
      whitepaper: {
        wordCount: '3000-5000 words',
        structure: 'Executive summary, problem statement, solution, case studies, conclusion',
      },
      case_study: {
        wordCount: '1000-1500 words',
        structure: 'Challenge, solution, implementation, results with metrics',
      },
      email: {
        wordCount: '150-250 words',
        structure: 'Subject line, preheader, body with single CTA',
      },
      social_post: {
        wordCount: '50-150 words',
        structure: 'Hook, value statement, CTA with hashtags',
      },
      video_script: {
        wordCount: '300-500 words',
        structure: 'Hook (5s), problem (15s), solution (30s), CTA (10s)',
      },
    };

    return specs[contentType] || specs.blog;
  }

  /**
   * Generate personalized outreach copy (email, SMS, DM) for leads
   * Templates always include placeholders like {{name}}, {{company}}, {{role}} for personalization
   * If conversationHistory is provided, generates contextual follow-up messages
   */
  async generateOutreachCopy(
    userId: number,
    icp: ICPProfile,
    outreachType: 'email' | 'sms' | 'dm',
    tone: string = 'professional',
    purpose: string = 'introduction',
     
    brandToolkit?: any,
     
    leads?: any[],
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string; subject?: string }>,
    customPrompt?: string
  ): Promise<OutreachCopy[]> {
    try {
      logger.info('[ContentStudioAgent] Generating outreach copy templates');

      const outreachSpecs = this.getOutreachSpecs(outreachType);
      
      // Build brand context if toolkit provided
      let brandContext = '';
      if (brandToolkit) {
        brandContext = `
Brand Guidelines:
- Brand Name: ${brandToolkit.brand_name || brandToolkit.brandName || 'N/A'}
- Tagline: ${brandToolkit.tagline || 'N/A'}
- Voice Traits: ${(brandToolkit.voice_personality_traits || brandToolkit.voicePersonalityTraits || []).join(', ') || 'N/A'}
- Voice Do's: ${(brandToolkit.voice_dos || brandToolkit.voiceDos || []).join(', ') || 'N/A'}
- Voice Don'ts: ${(brandToolkit.voice_donts || brandToolkit.voiceDonts || []).join(', ') || 'N/A'}
- Key CTAs: ${(brandToolkit.ctas || []).join(', ') || 'N/A'}
`;
      }

      // Build conversation history context if provided
      let conversationContext = '';
      if (conversationHistory && conversationHistory.length > 0) {
        conversationContext = `
Previous Conversation (most recent messages):
${conversationHistory.map((msg, i) => {
  const prefix = msg.role === 'assistant' ? 'You (sent)' : 'Lead (received)';
  const subjectLine = msg.subject ? `Subject: ${msg.subject}\n` : '';
  return `${i + 1}. ${prefix}:\n${subjectLine}${msg.content}`;
}).join('\n\n')}

IMPORTANT: This is a follow-up to the above conversation. Generate a contextual reply that:
1. References previous discussion points naturally
2. Continues the conversation thread appropriately
3. Addresses any questions or concerns raised
4. Moves the conversation toward the desired outcome
`;
      }

      // Always generate templates with placeholders for personalization
      const results: OutreachCopy[] = [];
      
      // Get sample lead info if available (to help AI understand context better)
      const sampleLead = leads && leads.length > 0 ? leads[0] : null;
      const leadContext = sampleLead ? `
Example Lead (use this to understand context, but generate templates with placeholders):
- Sample Name: ${sampleLead.name || sampleLead.full_name || 'John'}
- Sample Company: ${sampleLead.company || sampleLead.company_name || 'Acme Inc'}
- Sample Title/Role: ${sampleLead.title || sampleLead.role || sampleLead.job_title || 'Manager'}
` : '';

      // Determine if this is a follow-up based on conversation history
      const isFollowUp = conversationHistory && conversationHistory.length > 0;
      const effectivePurpose = isFollowUp ? 'follow_up' : purpose;

      const systemPrompt = `You are an expert sales copywriter specializing in ${outreachType.toUpperCase()} outreach messages.
Generate compelling ${outreachType} ${isFollowUp ? 'follow-up replies' : 'templates'} ${isFollowUp ? 'that continue the conversation naturally' : 'with personalization placeholders'}.

${brandContext}

ICP Details:
- Target Audience: ${icp.targetAudience || 'Business professionals'}
- Industry: ${icp.industry || 'General'}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
- Pain Points: ${JSON.stringify(icp.primaryPainPoint ? [icp.primaryPainPoint] : ((icp as any).painPoints || []))}
${leadContext}
${conversationContext}

Message Requirements:
- Type: ${outreachType}
- Tone: ${tone}
- Purpose: ${effectivePurpose}
- Character Limit: ${outreachSpecs.characterLimit}
- Structure: ${outreachSpecs.structure}

${isFollowUp ? `IMPORTANT: This is a FOLLOW-UP message. Reference the previous conversation naturally and move the discussion forward.` : `CRITICAL: Always use these EXACT placeholders for personalization (case-sensitive):
- {{name}} - Recipient's full name
- {{first_name}} - Recipient's first name
- {{company}} - Recipient's company name
- {{role}} - Recipient's job title/role
- {{email}} - Recipient's email (if needed)

These placeholders will be replaced with actual lead data when sending. Generate templates that feel personal but use placeholders.`}`;

      const userPrompt = isFollowUp 
        ? `Generate a follow-up ${outreachType} reply that continues the conversation shown above.
The reply should:
1. Acknowledge any points from the previous messages
2. Be natural and conversational, not templated
3. Move toward the next step in the sales process
4. Match the tone and style of the previous conversation

${outreachType === 'email' ? `Return as JSON:
{
  "subject_line": "Re: [appropriate subject continuing the thread]",
  "body": "Natural follow-up email body that references the conversation",
  "cta": "Specific call to action based on conversation context"
}` : outreachType === 'sms' ? `Return as JSON:
{
  "body": "Follow-up SMS under 160 chars",
  "cta": "Short call to action"
}` : `Return as JSON:
{
  "body": "Follow-up DM that continues the conversation naturally",
  "cta": "Call to action"
}`}`
        : `Generate a ${purpose} ${outreachType} template for the ICP.
IMPORTANT: Use placeholders like {{name}}, {{first_name}}, {{company}}, {{role}} - NOT actual names.

Return the response as a JSON object with these fields:
${outreachType === 'email' ? `{
  "subject_line": "Compelling subject line (can include {{name}} or {{company}})",
  "preview_text": "Preview/preheader text",
  "body": "Full email body with {{name}}/{{first_name}}, {{company}}, {{role}} placeholders for personalization",
  "cta": "Call to action text"
}` : outreachType === 'sms' ? `{
  "body": "SMS template under 160 chars with {{first_name}} placeholder",
  "cta": "Short call to action"
}` : `{
  "opening_hook": "Attention-grabbing opener with {{name}} or {{first_name}}",
  "body": "DM body with {{first_name}}, {{company}} placeholders for personalization",
  "cta": "Call to action"
}`}`;

      // Append custom prompt if provided
      const finalUserPrompt = customPrompt
        ? `${userPrompt}\n\nAdditional instructions from user:\n${customPrompt}`
        : userPrompt;

      const response = await this.createTextCompletion(userId, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: finalUserPrompt },
        ],
        temperature: 0.8,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId,
          purpose: 'outreach',
          service: 'ContentStudioAgent',
          action: 'generate_outreach_copy',
        },
      });

      if (!response.success || !response.content) {
        logger.error({ err: response.error }, '[ContentStudioAgent] OpenAI call failed');
        throw new Error(response.error || 'Failed to generate outreach template');
      }

      const content = JSON.parse(response.content || '{}');
      
      results.push({
        lead_id: null,
        lead_name: 'Template',
        lead_company: 'N/A',
        outreach_type: outreachType,
        tone,
        purpose,
        subject_line: content.subject_line || null,
        preview_text: content.preview_text || null,
        opening_hook: content.opening_hook || null,
        body: content.body || '',
        cta: content.cta || '',
        created_at: new Date(),
      });

      logger.info({ count: results.length }, '[ContentStudioAgent] Generated outreach templates');
      return results;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error generating outreach copy');
      throw new Error(`Failed to generate outreach copy: ${error.message}`);
    }
  }

  /**
   * Get character limits and structure for different outreach types
   */
  private getOutreachSpecs(outreachType: 'email' | 'sms' | 'dm'): { characterLimit: string; structure: string } {
    const specs = {
      email: {
        characterLimit: 'Subject: 50-60 chars, Body: 150-300 words',
        structure: 'Subject line, preview text, personalized greeting, value proposition, CTA, signature',
      },
      sms: {
        characterLimit: '160 characters max',
        structure: 'Hook, value, short CTA with link/reply instruction',
      },
      dm: {
        characterLimit: '500 characters recommended',
        structure: 'Personalized opener, connection reason, value offer, soft CTA',
      },
    };

    return specs[outreachType] || specs.email;
  }

  /**
   * Generate an image using the saved or explicitly selected media provider.
   */
  async generateImage(
    prompt: string,
    images?: { base64Data: string; mimeType: string }[],
    userId?: number,
    imageConfig?: ImageGenerationRequest['imageConfig'],
  ): Promise<ImageGenerationResult> {
    try {
      logger.info({ value: prompt.substring(0, 100) + '...' }, '[ContentStudioAgent] Generating image with prompt');

      // Create worker with userId for user-specific API key
      const imageWorker = createImageGenerationWorker(userId);
      
      // Check if worker is configured
      if (!await imageWorker.isConfigured()) {
        const status = await imageWorker.getStatus();
        throw new Error(status.message);
      }

      const request: ImageGenerationRequest = {
        prompt,
        images,
        userId,
        imageConfig,
      };

      const result = await imageWorker.generate(request);

      if (result.success) {
        logger.info({ fileName: result.fileName }, '[ContentStudioAgent] Image generated successfully');
      } else {
        logger.error({ err: result.error }, '[ContentStudioAgent] Image generation failed');
      }

      return result;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error generating image');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Generate an image from text prompt only
   */
  async generateImageFromText(prompt: string, userId?: number): Promise<ImageGenerationResult> {
    return this.generateImage(prompt, undefined, userId);
  }

  /**
   * Generate an image from an existing image + text prompt (image-to-image)
   */
  async generateImageFromImage(
    prompt: string,
    imageBase64: string,
    imageMimeType: string = 'image/jpeg',
    userId?: number
  ): Promise<ImageGenerationResult> {
    return this.generateImage(prompt, [{ base64Data: imageBase64, mimeType: imageMimeType }], userId);
  }

  /**
   * Generate an image by combining multiple images with a text prompt
   */
  async generateImageFromMultipleImages(
    prompt: string,
    images: { base64Data: string; mimeType: string }[],
    userId?: number
  ): Promise<ImageGenerationResult> {
    return this.generateImage(prompt, images, userId);
  }

  /**
   * Generate a video using the saved or explicitly selected media provider.
   */
  async generateVideo(
    prompt: string,
    image?: { base64Data: string; mimeType: string },
    userId?: number,
    videoConfig?: VideoGenerationRequest['videoConfig'],
  ): Promise<VideoGenerationResult> {
    try {
      logger.info({ value: prompt.substring(0, 100) + '...' }, '[ContentStudioAgent] Generating video with prompt');

      // Create worker with userId for user-specific API key
      const videoWorker = createVideoGenerationWorker(userId);

      // Check if worker is configured
      if (!await videoWorker.isConfigured()) {
        const status = await videoWorker.getStatus();
        throw new Error(status.message);
      }

      const request: VideoGenerationRequest = {
        prompt,
        image,
        userId,
        videoConfig,
      };

      const result = await videoWorker.generate(request);

      if (result.success) {
        logger.info({ fileName: result.fileName }, '[ContentStudioAgent] Video generated successfully');
      } else {
        logger.error({ err: result.error }, '[ContentStudioAgent] Video generation failed');
      }

      return result;
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error generating video');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Generate a video from text prompt only
   */
  async generateVideoFromText(prompt: string, userId?: number): Promise<VideoGenerationResult> {
    return this.generateVideo(prompt, undefined, userId);
  }

  /**
   * Generate a video from an image + text prompt (image-to-video)
   */
  async generateVideoFromImage(
    prompt: string,
    imageBase64: string,
    imageMimeType: string = 'image/jpeg',
    userId?: number
  ): Promise<VideoGenerationResult> {
    return this.generateVideo(prompt, { base64Data: imageBase64, mimeType: imageMimeType }, userId);
  }

  /**
   * Start video generation async and return operation name for tracking
   * Use this for async workflows where polling should be done separately
   */
  async startVideoGeneration(
    prompt: string,
    image?: { base64Data: string; mimeType: string },
    userId?: number,
    videoConfig?: VideoGenerationRequest['videoConfig'],
  ): Promise<{ success: boolean; operationName?: string; provider?: 'google' | 'openrouter'; model?: string; error?: string; brandReference?: { logoUrl: string; suppliedToModel: true } }> {
    try {
      logger.info('[ContentStudioAgent] Starting async video generation');

      const videoWorker = createVideoGenerationWorker(userId);
      
      if (!await videoWorker.isConfigured()) {
        const status = await videoWorker.getStatus();
        throw new Error(status.message);
      }

      const request: VideoGenerationRequest = {
        prompt,
        image,
        userId,
        videoConfig,
      };

      return await videoWorker.startGeneration(request);
     
    } catch (error: any) {
      logger.error({ err: error }, '[ContentStudioAgent] Error starting video generation');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check video generation status by operation name
   */
  async checkVideoGenerationStatus(
    operationName: string,
    userId?: number,
    requestedLogoUrl?: string | null,
    selection?: { provider?: 'google' | 'openrouter'; model?: string },
  ): Promise<{
    mediaProbe?: import('../media/MediaTranscodingService.js').MediaProbe;
    done: boolean;
    operationName: string;
    videoUrl?: string;
    provider?: 'google' | 'openrouter';
    model?: string;
    error?: string;
    branding?: { logoApplied: true; logoUrl: string; position: 'bottom-right' };
    brandReference?: { logoUrl: string; suppliedToModel: true };
  }> {
    const videoWorker = createVideoGenerationWorker(userId, undefined, selection);
    return await videoWorker.checkStatus(operationName, requestedLogoUrl);
  }

  /**
   * Get status of image and video generation workers
   */
  async getMediaGenerationStatus(userId?: number): Promise<{
    image: { configured: boolean; message: string };
    video: { configured: boolean; message: string };
  }> {
    const imageWorker = createImageGenerationWorker(userId);
    const videoWorker = createVideoGenerationWorker(userId);
    return {
      image: await imageWorker.getStatus(),
      video: await videoWorker.getStatus(),
    };
  }
}
