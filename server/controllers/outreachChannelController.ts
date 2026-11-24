import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import { channelDecisionEngine } from '../services/channelDecisionEngine';
import { analyzeEmailForReply as analyzeEmail } from '../services/EmailReplyAnalysisService.js';
import { logger } from '../utils/logger.js';
import { respondToGenerationFailure } from '../services/content/ContentTextGenerationError.js';
import { generateConfiguredReplyPreview } from '../services/agents/ConfiguredReplyPreviewService.js';

/**
 * Channel Decision & Smart Reply Controller
 */

/**
 * Get recommended outreach channel for a lead
 * GET /api/outreach-channel/recommend/:leadId
 */
export async function getRecommendedChannel(req: Request, res: Response) {
  try {
    const { leadId } = req.params;
    const useAI = req.query.ai === 'true';

    const decision = useAI
      ? await channelDecisionEngine.getAIRecommendedChannel(parseInt(leadId))
      : await channelDecisionEngine.getRecommendedChannel(parseInt(leadId));

    return res.json({
      success: true,
      decision,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.message === 'Lead not found') return res.status(404).json({ success: false, error: 'Lead not found' });
    logger.error({ err: error }, '[OutreachChannelController] Error getting recommendation');
    return res.status(500).json({ success: false, error: 'Unable to recommend a channel. Please try again.' });
  }
}

/**
 * Get recommended channels for multiple leads
 * POST /api/outreach-channel/recommend-bulk
 */
export async function getRecommendedChannelsBulk(req: Request, res: Response) {
  try {
    const { leadIds } = req.body;

    if (!leadIds || !Array.isArray(leadIds)) {
      return res.status(400).json({ success: false, error: 'leadIds array is required' });
    }

    const decisions = await channelDecisionEngine.getRecommendedChannelsBulk(leadIds);

    return res.json({
      success: true,
      decisions,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachChannelController] Error getting bulk recommendations');
    return res.status(500).json({ success: false, error: 'Unable to recommend channels. Please try again.' });
  }
}

/**
 * Get channel statistics
 * GET /api/outreach-channel/stats
 */
export async function getChannelStats(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const stats = await channelDecisionEngine.getChannelStats(userId);

    return res.json({
      success: true,
      stats,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachChannelController] Error getting stats');
    return res.status(500).json({ success: false, error: 'Unable to load channel statistics. Please try again.' });
  }
}

// ===== Smart Reply Endpoints =====

/**
 * Generate a smart reply to an email
 * POST /api/smart-reply/generate
 */
export async function generateSmartReply(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { subject, body, leadId, tone, maxLength } = req.body;

    if (!body) {
      return res.status(400).json({ success: false, error: 'Email body is required' });
    }

    const reply = await generateConfiguredReplyPreview({
      userId,
      subject: subject || '',
      inboundText: body,
      leadId: leadId ? parseInt(leadId) : undefined,
      tone,
      maxLength,
      sourceConversationId: req.body.conversationId ? Number(req.body.conversationId) : undefined,
    });

    return res.json({
      success: true,
      reply,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToGenerationFailure(res, error, 'a reply', logger, 'SmartReplyController')) return;
    logger.error({ err: error }, '[SmartReplyController] Error generating reply');
    return res.status(500).json({ success: false, error: 'Unable to generate a reply. Please try again.' });
  }
}

/**
 * Generate multiple reply variations
 * POST /api/smart-reply/variations
 */
export async function generateReplyVariations(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { subject, body, leadId, count } = req.body;

    if (!body) {
      return res.status(400).json({ success: false, error: 'Email body is required' });
    }

    const tones = ['professional', 'friendly', 'casual'].slice(0, Math.max(1, Math.min(Number(count || 3), 3)));
    const variations = await Promise.all(tones.map((tone) => generateConfiguredReplyPreview({
        userId,
        subject: subject || '',
        inboundText: body,
        leadId: leadId ? parseInt(leadId) : undefined,
        tone,
      sourceConversationId: req.body.conversationId ? Number(req.body.conversationId) : undefined,
      })));

    return res.json({
      success: true,
      variations,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToGenerationFailure(res, error, 'a reply', logger, 'SmartReplyController')) return;
    logger.error({ err: error }, '[SmartReplyController] Error generating variations');
    return res.status(500).json({ success: false, error: 'Unable to generate reply variations. Please try again.' });
  }
}

/**
 * Analyze an email and suggest approach
 * POST /api/smart-reply/analyze
 */
export async function analyzeEmailForReply(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { subject, body } = req.body;

    if (!body) {
      return res.status(400).json({ success: false, error: 'Email body is required' });
    }

    const analysis = await analyzeEmail(
      subject || '',
      body,
      userId,
    );

    return res.json({
      success: true,
      analysis,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[SmartReplyController] Error analyzing email');
    return res.status(500).json({ success: false, error: 'Unable to analyze this email. Please try again.' });
  }
}

/**
 * Enhance an existing draft reply
 * POST /api/smart-reply/enhance
 */
export async function enhanceReply(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { draft, tone, shortenBy, addCallToAction, addPersonalization, leadId } = req.body;

    if (!draft) {
      return res.status(400).json({ success: false, error: 'Draft is required' });
    }

    const enhanced = await generateConfiguredReplyPreview({
      userId,
      inboundText: draft,
      editingDraft: true,
      tone,
      leadId: leadId ? parseInt(leadId) : undefined,
      sourceConversationId: req.body.conversationId ? Number(req.body.conversationId) : undefined,
      extraInstructions: [
        shortenBy ? `Shorten the draft by approximately ${Number(shortenBy)} percent.` : '',
        addCallToAction ? 'Include a clear call to action.' : '',
        addPersonalization ? 'Personalize only with verified lead data.' : '',
      ].filter(Boolean),
    });

    return res.json({
      success: true,
      enhancedBody: enhanced.body,
      changes: ['Applied the resolved assistant configuration and requested email edits.'],
      confidence: enhanced.confidence,
      sourcesUsed: enhanced.sourcesUsed,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToGenerationFailure(res, error, 'a reply', logger, 'SmartReplyController')) return;
    logger.error({ err: error }, '[SmartReplyController] Error enhancing reply');
    return res.status(500).json({ success: false, error: 'Unable to improve this reply. Please try again.' });
  }
}
