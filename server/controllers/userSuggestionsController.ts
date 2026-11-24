 
import type { AuthenticatedRequest } from '../types/express.js';
import { Request, Response } from "express";
import { db } from "../models/db";
import { userSuggestionsTable } from "../models/userSuggestions/schema";
import { brandToolkitsTable } from "../models/brandToolkits/schema";
import { eq } from "drizzle-orm";
import { LLMProviderFactory } from "../services/agents/LLMProviderFactory";
import { logger } from '../utils/logger.js';
import { getBusinessProfileContextByUserId } from '../models/companySettings/functions.js';

export function enforceSmallLeadSuggestionDefaults(suggestions: string[]): string[] {
  return suggestions.map((suggestion) => {
    const trimmed = suggestion.trim();
    const isLeadGenerationSuggestion = (/^(?:find|source)\b/i.test(trimmed)
      && /\b(?:leads?|prospects?|ceos?|ctos?|vps?|directors?|business(?:es)?|companies)\b/i.test(trimmed))
      || (/^(?:generate|build)\b/i.test(trimmed) && /\b(?:leads?|prospects?)\b/i.test(trimmed));
    if (!isLeadGenerationSuggestion) return suggestion;

    return suggestion.replace(/\b(?:exactly\s+)?\d{2,}\b/i, 'exactly 5');
  });
}


/**
 * Get user suggestions (generate if not exists)
 */
export async function getUserSuggestions(req: Request, res: Response) {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Check if user already has suggestions
    const existing = await db
      .select()
      .from(userSuggestionsTable)
      .where(eq(userSuggestionsTable.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      // Return existing suggestions (randomly shuffle and pick 3)
      const allSuggestions = enforceSmallLeadSuggestionDefaults(existing[0].suggestions || []);
      const shuffled = [...allSuggestions].sort(() => Math.random() - 0.5);
      const randomThree = shuffled.slice(0, 3);
      
      return res.json({
        success: true,
        suggestions: randomThree,
        allSuggestions: allSuggestions,
        generatedAt: existing[0].generatedAt,
      });
    }

    // No suggestions exist - generate new ones
    const suggestions = await generateSuggestionsForUser(userId);
    
    return res.json({
      success: true,
      suggestions: suggestions.slice(0, 3),
      allSuggestions: suggestions,
      generatedAt: new Date(),
    });
  } catch (error) {
    logger.error({ err: error }, '[getUserSuggestions] Error');
    return res.status(500).json({ error: "Unable to retrieve suggestions. Please try again." });
  }
}

/**
 * Regenerate suggestions for user
 */
export async function regenerateSuggestions(req: Request, res: Response) {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const suggestions = await generateSuggestionsForUser(userId, true);
    
    return res.json({
      success: true,
      suggestions: suggestions.slice(0, 3),
      allSuggestions: suggestions,
      generatedAt: new Date(),
    });
  } catch (error) {
    logger.error({ err: error }, '[regenerateSuggestions] Error');
    return res.status(500).json({ error: "Unable to regenerate suggestions. Please try again." });
  }
}

/**
 * Generate personalized suggestions based on business profile
 */
async function generateSuggestionsForUser(userId: number, forceRegenerate = false): Promise<string[]> {
  // Fetch business profile and brand toolkit
  const companyProfile = await getBusinessProfileContextByUserId(userId);

  const [brandToolkit] = await db
    .select()
    .from(brandToolkitsTable)
    .where(eq(brandToolkitsTable.userId, userId))
    .limit(1);

  // Build context from profile
  const profileContext = {
    companyName: companyProfile?.companyName || brandToolkit?.companyName,
    industry: companyProfile?.industry || brandToolkit?.industry,
    goals: brandToolkit?.goals || [],
    platforms: brandToolkit?.platforms || [],
    targetAudience: brandToolkit?.targetAudience,
    description: companyProfile?.description || brandToolkit?.description,
  };

  // Generate suggestions using LLM
  try {
    const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
    
    const prompt = `You are a marketing AI assistant for a Sales & Marketing automation platform. Based on the following business profile, generate exactly 10 specific, actionable task sentences that users can execute on this platform.

The platform supports these capabilities:
- Lead Generation: Find leads using LinkedIn, Google Maps, JustDial, and other sources. Search by job titles, industries, locations.
- Content Creation: Generate social media posts (LinkedIn, Instagram, Twitter), blog content, email copy, SMS messages.
- Email Campaigns: Create and send personalized email outreach campaigns with follow-ups.
- SMS Campaigns: Create and send SMS outreach to leads.
- Instagram Outreach: Send Instagram DMs to prospects.
- Ad Copy: Generate Facebook, Instagram, and Google ad copy and creatives.
- Lead Scoring & ICP: Build Ideal Customer Profiles and score leads based on fit.
- Analytics: Track campaign performance, conversion rates, and ROI.

Business Profile:
- Company: ${profileContext.companyName || 'Not specified'}
- Industry: ${profileContext.industry || 'Not specified'}
- Goals: ${profileContext.goals?.join(', ') || 'Not specified'}
- Platforms: ${profileContext.platforms?.join(', ') || 'Not specified'}
- Target Audience: ${profileContext.targetAudience || 'Not specified'}
- Description: ${profileContext.description || 'Not specified'}

Generate 10 suggestions that are:
1. Complete actionable sentences (10-20 words each)
2. Include specific details like job titles, locations, platforms, and numbers relevant to the business
3. Start with action verbs (Find, Generate, Create, Build, Send, Write, Design, etc.)
4. ONLY suggest tasks that can be done on this platform (lead gen, content, email, SMS, Instagram DM, ads, analytics)
5. Varied across the platform capabilities listed above
6. Tailored to the business profile provided
7. Lead-generation examples must request a small review batch of exactly 5 leads from one provider; never suggest hundreds of leads by default

Return ONLY a JSON array of 10 strings, no other text. Example format:
["Find exactly 5 tech CEOs in San Francisco using LinkedIn", "Create 5 LinkedIn posts highlighting customer success stories", "Draft an email campaign for 5 approved warm leads without sending it"]`;

    const response = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { role: "system", content: "You are a helpful marketing AI. Return only valid JSON arrays." },
        { role: "user", content: prompt },
      ],
    });

    let suggestions: string[] = [];
    
    try {
      // Parse the response
      const content = response.content || response;
      const jsonMatch = typeof content === 'string' 
        ? content.match(/\[[\s\S]*\]/)
        : null;
      
      if (jsonMatch) {
        suggestions = JSON.parse(jsonMatch[0]);
      } else if (typeof content === 'string') {
        suggestions = JSON.parse(content);
      }
    } catch (parseError) {
      logger.error({ err: parseError }, '[generateSuggestionsForUser] Parse error');
      // Fallback suggestions
      suggestions = getDefaultSuggestions(profileContext);
    }

    // Ensure we have valid suggestions
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      suggestions = getDefaultSuggestions(profileContext);
    }

    // Limit to 10
    suggestions = enforceSmallLeadSuggestionDefaults(suggestions.slice(0, 10));

    // Save to database
    if (forceRegenerate) {
      await db
        .delete(userSuggestionsTable)
        .where(eq(userSuggestionsTable.userId, userId));
    }

    await db.insert(userSuggestionsTable).values({
      userId,
      suggestions,
      basedOnProfile: profileContext,
      generatedAt: new Date(),
    });

    return suggestions;
  } catch (error) {
    logger.error({ err: error }, '[generateSuggestionsForUser] LLM error');
    return getDefaultSuggestions(profileContext);
  }
}

/**
 * Get default suggestions based on profile
 */
function getDefaultSuggestions(profile: { industry?: string; goals?: string[]; platforms?: string[] }): string[] {
  const defaults = [
    "Find exactly 5 potential leads using LinkedIn in my target market",
    "Create 5 engaging LinkedIn posts about our product benefits this week",
    "Draft a personalized email campaign for 5 approved warm leads without sending it",
    "Build an outreach sequence targeting decision makers on LinkedIn",
    "Write Instagram ad copy and creatives for our latest product launch",
    "Generate exactly 5 leads from Google Maps for businesses in my target locations",
    "Create an SMS campaign to re-engage cold leads from last quarter",
    "Design email templates for a drip campaign targeting new sign-ups",
    "Draft Instagram DMs for 5 approved prospects without sending them",
    "Analyze campaign performance and conversion rates from this month",
  ];

  // Customize based on industry
  if (profile.industry?.toLowerCase().includes('saas')) {
    defaults[0] = "Find exactly 5 SaaS CTOs and VP Engineering leads using LinkedIn";
    defaults[4] = "Write Facebook ad copy targeting SaaS decision makers";
  } else if (profile.industry?.toLowerCase().includes('ecommerce') || profile.industry?.toLowerCase().includes('retail')) {
    defaults[0] = "Find retail business owners using Google Maps and JustDial";
    defaults[4] = "Create Instagram ad creatives for trending product promotions";
  }

  // Customize based on platforms
  if (profile.platforms?.includes('Instagram')) {
    defaults[1] = "Create 5 Instagram Reels scripts highlighting customer success stories";
  }
  if (profile.platforms?.includes('LinkedIn')) {
    defaults[3] = "Build a LinkedIn outreach sequence for industry professionals";
  }

  return defaults;
}
