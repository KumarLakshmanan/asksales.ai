import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { CampaignModel } from "../models/campaigns/functions";
import { InsertCampaign } from "../models/campaigns/schema";
import { LLMProviderFactory } from "../services/agents/LLMProviderFactory.js";
import { NotificationService } from '../services/NotificationService.js';
import { ContentTextGenerationError, respondToGenerationFailure } from '../services/content/ContentTextGenerationError.js';
import { z } from 'zod';

const generatedCampaignPlanSchema = z.object({
  campaignName: z.string().min(1).max(500),
  description: z.string().max(5000),
  duration: z.string().max(200),
  platforms: z.array(z.string().max(100)).max(20),
  targetAudience: z.string().max(5000),
  postingFrequency: z.array(z.object({ platform: z.string().max(100), frequency: z.string().max(500) })).max(100),
  formats: z.array(z.object({ platform: z.string().max(100), formats: z.array(z.string().max(100)).max(50) })).max(100),
  contentPillars: z.array(z.object({ name: z.string().max(500), description: z.string().max(5000) })).max(100),
  sampleCalendar: z.array(z.object({
    week: z.number().int().positive(),
    date: z.string().max(50),
    contentType: z.string().max(200),
    contentTheme: z.string().max(1000),
  })).max(366),
  keyMessages: z.array(z.string().max(2000)).max(100),
  themes: z.array(z.string().max(500)).max(100),
  successMetrics: z.array(z.string().max(1000)).max(100),
  notes: z.string().max(5000),
}).strict();

export const getCampaigns = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const campaigns = await CampaignModel.findAll({ userId });
    res.json(campaigns);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[CampaignController] Error fetching campaigns');
    res.status(500).json({ error: "Unable to retrieve campaigns. Please try again." });
  }
};

export const getCampaign = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const campaign = await CampaignModel.findByIdForUser(id, userId);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    res.json(campaign);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Controller] Unhandled error');
    res.status(500).json({ error: "Unable to retrieve the campaign. Please try again." });
  }
};

export const createCampaign = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { startDate, endDate, ...requestedData } = req.body;
    const campaignData: InsertCampaign = {
      ...requestedData,
      userId,
      status: requestedData.status || 'draft',
      spent: requestedData.spent ?? 0,
      metrics: requestedData.metrics ?? {},
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : null,
    };
    const campaign = await CampaignModel.create(campaignData);

    // Deduct credits for campaign creation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (userId) {
      try {
        const { creditService } = await import('../services/CreditService.js');
        await creditService.deductForEvent({
          userId,
          eventKey: 'campaign_creation',
          description: 'Campaign created',
          service: 'CampaignController',
          referenceType: 'campaign',
          referenceId: campaign?.id?.toString(),
        });
      } catch (_creditErr) { /* non-blocking */ }
      // Save in-app notification
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      NotificationService.campaignCreated(userId, (campaign as any)?.name || 'Untitled');
    }

    res.status(201).json(campaign);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Controller] Unhandled error');
    res.status(500).json({ error: "Unable to create the campaign. Please try again." });
  }
};

export const updateCampaign = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { startDate, endDate, ...requestedData } = req.body;
    const campaignData: Partial<InsertCampaign> = {
      ...requestedData,
      ...(startDate !== undefined && { startDate: new Date(startDate) }),
      ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
      updatedAt: new Date(),
    };
    delete (campaignData as Partial<InsertCampaign> & { userId?: number }).userId;

    const campaign = await CampaignModel.updateForUser(id, userId, campaignData);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    res.json(campaign);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Controller] Unhandled error');
    res.status(500).json({ error: "Unable to update the campaign. Please try again." });
  }
};

export const archiveCampaign = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const campaign = await CampaignModel.updateForUser(id, userId, {
      status: 'archived',
      updatedAt: new Date(),
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    return res.json({ success: true, campaign, message: 'Campaign archived' });
  } catch (error) {
    logger.error({ err: error }, '[CampaignController] Error archiving campaign');
    return res.status(500).json({ error: 'Unable to archive the campaign. Please try again.' });
  }
};

/**
 * Save campaign plan from AI response
 * POST /api/campaigns/:id/plan
 */
export const saveCampaignPlan = async (req: Request, res: Response) => {
  try {
    const campaignId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!campaignId || isNaN(campaignId)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const { planData, status = 'approved' } = req.body;

    if (!planData) {
      return res.status(400).json({ error: "Plan data is required" });
    }

    // Update campaign with plan data stored in metrics
    // This stores the AI-generated campaign plan for reference
    const existingCampaign = await CampaignModel.findByIdForUser(campaignId, userId);
    if (!existingCampaign) return res.status(404).json({ error: "Campaign not found" });

    const campaign = await CampaignModel.updateForUser(campaignId, userId, {
      metrics: {
        ...((existingCampaign.metrics as Record<string, unknown> | null) || {}),
        aiPlan: planData,
        planStatus: status,
        planSavedAt: new Date().toISOString(),
        userId,
      },
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    return res.json({
      success: true,
      message: "Campaign plan saved successfully",
      data: campaign,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[saveCampaignPlan]');
    return res.status(500).json({
      success: false,
      error: "Unable to save the campaign plan. Please try again.",
    });
  }
};

/**
 * Regenerate campaign plan with AI
 * POST /api/campaigns/:id/regenerate-plan
 */
export const regenerateCampaignPlan = async (req: Request, res: Response) => {
  try {
    const campaignId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!campaignId || isNaN(campaignId)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const { previousPlan, context = [] } = req.body;
    const campaign = await CampaignModel.findByIdForUser(campaignId, userId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const previousPlanSummary = JSON.stringify(previousPlan ?? campaign.metrics ?? {}).slice(0, 12_000);
    req.body = {
      message: `Regenerate this campaign plan. Preserve useful details, correct weak assumptions, and return a complete replacement plan. Previous plan: ${previousPlanSummary}`,
      context,
    };
    return requestAICampaignPlan(req, res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[regenerateCampaignPlan]');
    return res.status(500).json({
      success: false,
      error: "Unable to regenerate the campaign plan. Please try again.",
    });
  }
};

/**
 * Request AI campaign plan
 * POST /api/campaigns/:id/ai-plan-request
 */
export const requestAICampaignPlan = async (req: Request, res: Response) => {
  try {
    const campaignId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!campaignId || isNaN(campaignId)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const { message, context = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Fetch campaign details for context
    const campaign = await CampaignModel.findByIdForUser(campaignId, userId);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // Generate campaign plan using LLM
    const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
    const contextMessages = Array.isArray(context)
      ? context.map((c: { role: string; content: string }) => `${c.role}: ${c.content}`).join('\n')
      : '';

    const systemPrompt = `You are an expert marketing campaign strategist. Generate a structured campaign plan based on the user's request.
Return ONLY a valid JSON object (no markdown, no code fences) with these fields:
{
  "campaignName": "string",
  "description": "string",
  "duration": "string (e.g. '4 weeks')",
  "platforms": ["string array of platforms"],
  "targetAudience": "string",
  "postingFrequency": [{"platform": "string", "frequency": "string"}],
  "formats": [{"platform": "string", "formats": ["string"]}],
  "contentPillars": [{"name": "string", "description": "string"}],
  "sampleCalendar": [{"week": number, "date": "YYYY-MM-DD", "contentType": "string", "contentTheme": "string"}],
  "keyMessages": ["string"],
  "themes": ["string"],
  "successMetrics": ["string"],
  "notes": "string"
}`;

    const userPrompt = `Campaign: ${campaign.name || 'Unnamed Campaign'}
${campaign.goal ? `Goal: ${campaign.goal}` : ''}
${contextMessages ? `\nPrevious conversation:\n${contextMessages}` : ''}

User request: ${message}`;

    const llmResponse = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      loggingContext: {
        userId,
        purpose: 'campaign_planning',
        service: 'CampaignController',
        action: 'request_ai_campaign_plan',
      },
    });

    if (!llmResponse.success || !llmResponse.content) {
      throw new ContentTextGenerationError(llmResponse.error || 'No message content returned', 'a campaign plan');
    }

    // Parse the LLM response as JSON
    let parsedPlan: unknown;
    try {
      const cleanContent = llmResponse.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsedPlan = JSON.parse(cleanContent);
    } catch {
      return res.status(502).json({
        success: false,
        error: 'The AI provider returned an invalid campaign plan. Please regenerate it.',
      });
    }

    const validatedPlan = generatedCampaignPlanSchema.safeParse(parsedPlan);
    if (!validatedPlan.success) {
      logger.warn({ campaignId, issues: validatedPlan.error.issues }, '[requestAICampaignPlan] Invalid structured plan');
      return res.status(502).json({
        success: false,
        error: 'The AI provider returned an incomplete campaign plan. Please regenerate it.',
      });
    }
    const planData = validatedPlan.data;

    return res.json({
      success: true,
      response: `Here's your campaign plan for "${planData.campaignName || campaign.name}".`,
      planData,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToGenerationFailure(res, error, 'a campaign plan', logger, 'CampaignController')) return;
    logger.error({ err: error }, '[requestAICampaignPlan]');
    return res.status(500).json({
      success: false,
      code: 'CAMPAIGN_PLAN_GENERATION_FAILED',
      error: "The campaign plan could not be generated. Your request is kept; please try again.",
    });
  }
};
