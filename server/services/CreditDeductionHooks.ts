/**
 * Credit Deduction Hooks
 * Hooks into existing usage tracking to automatically deduct credits
 * 
 * This module patches the existing usage tracking functions to also deduct
 * credits from user wallets when API calls or events are tracked.
 */

import { creditService } from './CreditService.js';
import { logger } from '../utils/logger.js';
import { getUsageRate } from '../models/creditPricing/functions.js';
import { getUsdToInrRate, meteredCreditsFromInr, roundCurrency, usdCentsToInr } from '../utils/currency.js';
import { currentUsageContext } from './insights/UsageContext.js';

// Map LLM purpose strings to meaningful referenceType values
const PURPOSE_TO_REFERENCE_TYPE: Record<string, string> = {
  icp_generation: 'icp',
  content_generation: 'content',
  content_studio: 'content',
  lead_generation: 'lead_gen',
  lead_enrichment: 'lead_gen',
  lead_scoring: 'lead_gen',
  outreach: 'outreach',
  outreach_personalization: 'outreach',
  email_generation: 'content',
  sms_generation: 'content',
  social_generation: 'content',
  ad_copy_generation: 'content',
  strategy_generation: 'content',
  campaign: 'campaign',
  analytics: 'analytics',
};

function deriveReferenceType(purpose?: string): string | undefined {
  if (!purpose) return undefined;
  return PURPOSE_TO_REFERENCE_TYPE[purpose] || undefined;
}

/**
 * Calculate credits to deduct based on actual API cost
 * Formula: costCents → USD → INR → credits
 * Accepts fractional cents to avoid premature rounding.
 * 
 * Example for 400 tokens at $2.50/1M input + $10/1M output:
 * - promptCost = (300/1M) × $2.50 = $0.00075
 * - completionCost = (100/1M) × $10 = $0.001
 * - Total = $0.00175 = 0.175 cents
 * - Convert to INR: $0.00175 * 100 = ₹0.175
 * - Credits: ₹0.175 * 10 = 1.75 → ceil → 2 credits
 * 
 * For larger requests like 10K tokens at $2.50/1M input + $10/1M output:
 * - promptCost = (8000/1M) × $2.50 = $0.02
 * - completionCost = (2000/1M) × $10 = $0.02
 * - Total = $0.04 = 4 cents
 * - Convert to INR: $0.04 * 100 = ₹4.0
 * - Credits: ₹4.0 * 10 = 40 credits
 */
/** Credits the metered usage rate charges for a provider cost, for estimates. */
export async function estimateCreditsFromCostCents(costCents: number): Promise<number> {
  return calculateCreditsFromCost(costCents);
}

async function calculateCreditsFromCost(costCents: number): Promise<number> {
  const snapshot=currentUsageContext()?.pricing;
  const costInINR = (costCents / 100) * (snapshot?.usdToInr ?? getUsdToInrRate());
  // Older snapshots carry only the purchase rate, which was the usage rate then.
  const creditsPerINR = snapshot?.usageCreditsPerInr ?? snapshot?.creditsPerInr ?? await getUsageRate();
  return meteredCreditsFromInr(costInINR, creditsPerINR);
}

/**
 * Deduct credits for an OpenAI/LLM API call based on actual token cost
 * Credits are calculated from the estimated cost in cents, converted to INR, then to credits
 */
export async function deductCreditsForLLMUsage(userId: number, data: {
  model?: string;
  provider?: string;
  purpose?: string;
  service?: string;
  estimatedCostCents?: number;
  originalCostCents?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  threadId?: number | null;
}): Promise<void> {
  try {
    const eventKey = (data.provider === 'openrouter') ? 'api_openrouter' 
      : (data.provider === 'gemini' || data.provider === 'vertex_ai') ? 'api_gemini'
      : (data.provider === 'custom_ai') ? 'api_custom_ai'
      : 'api_openai';
    
    // Calculate credits based on actual API cost, not fixed pricing
    const creditsToDeduct = data.estimatedCostCents 
      ? await calculateCreditsFromCost(data.estimatedCostCents)
      : 0;

    // Skip deduction if no cost
    if (creditsToDeduct <= 0) {
      logger.debug({ userId, model: data.model, purpose: data.purpose }, 'LLM call with zero cost, no credits deducted');
      return;
    }
    
    const deduction = await creditService.deductForEvent({
      userId,
      eventKey,
      description: `LLM API call: ${data.purpose || 'unknown'} (${data.model || 'unknown'}) - ${data.totalTokens || 0} tokens`,
      service: data.service,
      apiProvider: data.provider || 'openai',
      apiCostCents: data.originalCostCents != null && data.originalCostCents > 0 ? data.originalCostCents : (data.estimatedCostCents != null && data.estimatedCostCents > 0 ? data.estimatedCostCents : undefined),
      // Use overrideAmount to use cost-based credits instead of fixed pricing
      overrideAmount: creditsToDeduct,
      // The call already happened: bill it in full even on a low balance.
      allowOverdraft: true,
      // Link to conversation thread when available, or derive from purpose
      referenceType: (data.threadId != null && data.threadId > 0) ? 'chat_thread' : deriveReferenceType(data.purpose),
      referenceId: (data.threadId != null && data.threadId > 0) ? String(data.threadId) : undefined,
      metadata: {
        model: data.model,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        totalTokens: data.totalTokens,
        threadId: data.threadId,
        costCents: data.estimatedCostCents,
        costINR: roundCurrency(usdCentsToInr(data.estimatedCostCents || 0)),
        originalCostCents: data.originalCostCents,
        creditsDeducted: creditsToDeduct,
      },
    });
    if(!deduction.success)throw new Error(deduction.error||'LLM credit deduction was not recorded.');
    
    logger.info({ 
      userId, 
      model: data.model, 
      tokens: data.totalTokens, 
      costINR: roundCurrency(usdCentsToInr(data.estimatedCostCents || 0)),
      creditsDeducted: creditsToDeduct 
    }, 'LLM credits deducted based on token cost');
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for LLM usage');
  }
}

/**
 * Deduct credits for an Apify scraping run based on actual cost
 */
export async function deductCreditsForApifyUsage(userId: number, data: {
  actorName?: string;
  runId?: string;
  itemsScraped?: number;
  estimatedCostCents?: number;
  threadId?: number | null;
}): Promise<void> {
  try {
    // Calculate credits based on actual API cost
    const creditsToDeduct = data.estimatedCostCents 
      ? await calculateCreditsFromCost(data.estimatedCostCents)
      : 0;

    // Always log the event for tracking, even if 0 credits
    const deductionOptions = {
      userId,
      eventKey: 'api_apify',
      description: `Apify scraping: ${data.actorName || 'unknown'} (${data.itemsScraped || 0} items)`,
      service: 'ApifyService',
      apiProvider: 'apify',
      apiCostCents: data.estimatedCostCents != null && data.estimatedCostCents > 0 ? data.estimatedCostCents : undefined,
      overrideAmount: creditsToDeduct,
      allowOverdraft: true,
      referenceType: data.runId ? 'apify_run' : 'chat_thread',
      referenceId: data.runId || (data.threadId != null && data.threadId > 0 ? String(data.threadId) : undefined),
      metadata: { 
        actorName: data.actorName, 
        runId: data.runId,
        itemsScraped: data.itemsScraped,
        costCents: data.estimatedCostCents,
        costINR: roundCurrency(usdCentsToInr(data.estimatedCostCents || 0)),
        creditsDeducted: creditsToDeduct,
        threadId: data.threadId,
      },
    };
    const deduction = data.runId
      ? await creditService.deductOnceForResource({ ...deductionOptions, referenceType: 'apify_run', referenceId: data.runId })
      : await creditService.deductForEvent(deductionOptions);
    if(!deduction.success)throw new Error(deduction.error||'Apify credit deduction was not recorded.');

    logger.info({ 
      userId, 
      actorName: data.actorName, 
      items: data.itemsScraped,
      costINR: roundCurrency(usdCentsToInr(data.estimatedCostCents || 0)),
      creditsDeducted: deduction.alreadyCharged ? 0 : creditsToDeduct,
      alreadyCharged: deduction.alreadyCharged === true,
    }, 'Apify credits deducted based on API cost');
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for Apify usage');
  }
}

/**
 * Deduct credits for an Embedding API call based on actual cost
 */
export async function deductCreditsForEmbeddingUsage(userId: number, data: {
  model?: string;
  provider?: string;
  purpose?: string;
  estimatedCostCents?: number;
  originalCostCents?: number;
  inputTokens?: number;
  totalTokens?: number;
  threadId?: number | null;
}): Promise<void> {
  try {
    const creditsToDeduct = data.estimatedCostCents
      ? await calculateCreditsFromCost(data.estimatedCostCents)
      : 0;

    if (creditsToDeduct <= 0) {
      logger.debug({ userId, model: data.model, purpose: data.purpose }, 'Embedding call with zero cost, no credits deducted');
      return;
    }

    const eventKey = data.provider === 'gemini' ? 'api_gemini' : 'api_openai';

    const result = await creditService.deductForEvent({
      userId,
      eventKey,
      description: `Embedding API: ${data.purpose || 'embedding'} (${data.model || 'unknown'}) - ${data.totalTokens || 0} tokens`,
      service: 'EmbeddingService',
      apiProvider: `${data.provider || 'openai'}_embedding`,
      apiCostCents: data.originalCostCents != null && data.originalCostCents > 0 ? data.originalCostCents : (data.estimatedCostCents != null && data.estimatedCostCents > 0 ? data.estimatedCostCents : undefined),
      overrideAmount: creditsToDeduct,
      allowOverdraft: true,
      referenceType: (data.threadId != null && data.threadId > 0) ? 'chat_thread' : deriveReferenceType(data.purpose),
      referenceId: (data.threadId != null && data.threadId > 0) ? String(data.threadId) : undefined,
      metadata: {
        model: data.model,
        inputTokens: data.inputTokens,
        totalTokens: data.totalTokens,
        costCents: data.estimatedCostCents,
        costINR: roundCurrency(usdCentsToInr(data.estimatedCostCents || 0)),
        originalCostCents: data.originalCostCents,
        creditsDeducted: creditsToDeduct,
        type: 'embedding',
        threadId: data.threadId,
      },
    });
    if (!result.success) {
      throw new Error(result.error || 'Embedding credit deduction was not recorded.');
    }

    logger.info({
      userId,
      model: data.model,
      tokens: data.totalTokens,
      costINR: roundCurrency(usdCentsToInr(data.estimatedCostCents || 0)),
      creditsDeducted: creditsToDeduct,
    }, 'Embedding credits deducted based on token cost');
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for embedding usage');
    throw error;
  }
}

/**
 * Deduct credits for knowledge base upload
 */
export async function deductCreditsForKnowledgeBase(userId: number, data?: {
  entryId?: number;
  service?: string;
}): Promise<void> {
  try {
    await creditService.deductForEvent({
      userId,
      eventKey: 'knowledge_base_upload',
      description: 'Knowledge base upload',
      service: data?.service || 'KnowledgeBase',
      referenceType: 'knowledge_base',
      referenceId: data?.entryId?.toString(),
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for knowledge base upload');
  }
}

/**
 * Deduct credits for outreach message
 */
export async function deductCreditsForOutreach(userId: number, channel: string, data?: {
  messageId?: string;
  service?: string;
  threadId?: number | null;
}): Promise<void> {
  try {
    const eventKeyMap: Record<string, string> = {
      email: 'outreach_email',
      sms: 'outreach_sms',
      whatsapp: 'outreach_whatsapp',
      instagram: 'outreach_instagram',
      facebook: 'outreach_facebook',
      linkedin: 'outreach_linkedin',
      twitter: 'outreach_twitter',
    };

    const eventKey = eventKeyMap[channel] || 'outreach_email';
    
    await creditService.deductForEvent({
      userId,
      eventKey,
      description: `Outreach message: ${channel}`,
      service: data?.service || 'OutreachService',
      referenceType: (data?.threadId != null && data.threadId > 0) ? 'chat_thread' : 'sent_message',
      referenceId: (data?.threadId != null && data.threadId > 0) ? String(data.threadId) : data?.messageId,
      metadata: data?.threadId ? { messageId: data?.messageId, channel, threadId: data.threadId } : undefined,
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for outreach');
  }
}

/**
 * Deduct credits for lead operations
 */
export async function deductCreditsForLead(userId: number, operation: string, data?: {
  leadId?: number;
  service?: string;
  threadId?: number | null;
}): Promise<void> {
  try {
    const eventKeyMap: Record<string, string> = {
      generation: 'lead_generation',
      enrichment: 'lead_enrichment',
      scoring: 'lead_scoring',
    };

    const eventKey = eventKeyMap[operation] || 'lead_generation';
    
    await creditService.deductForEvent({
      userId,
      eventKey,
      description: `Lead ${operation}`,
      service: data?.service || 'LeadService',
      referenceType: (data?.threadId != null && data.threadId > 0) ? 'chat_thread' : 'lead',
      referenceId: (data?.threadId != null && data.threadId > 0) ? String(data.threadId) : data?.leadId?.toString(),
      metadata: data?.threadId ? { leadId: data?.leadId, operation, threadId: data.threadId } : undefined,
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for lead operation');
  }
}

/**
 * Deduct credits for ICP generation (platform event)
 */
export async function deductCreditsForICPGeneration(userId: number, data?: {
  icpId?: number;
  service?: string;
  threadId?: number | null;
}): Promise<void> {
  try {
    await creditService.deductForEvent({
      userId,
      eventKey: 'icp_generation',
      description: 'ICP profile generated',
      service: data?.service || 'ICPGenerationService',
      referenceType: (data?.threadId != null && data.threadId > 0) ? 'chat_thread' : 'icp',
      referenceId: (data?.threadId != null && data.threadId > 0) ? String(data.threadId) : data?.icpId?.toString(),
      metadata: data?.threadId ? { icpId: data?.icpId, threadId: data.threadId } : undefined,
      // Priced by the admin "ICP Generation" row (inactive by default: the LLM tokens are billed already).
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for ICP generation');
  }
}

/**
 * Deduct credits for knowledge base item creation (Q&A entries)
 */
export async function deductCreditsForKnowledgeBaseItem(userId: number, data?: {
  entryId?: number;
  service?: string;
}): Promise<void> {
  try {
    await creditService.deductForEvent({
      userId,
      eventKey: 'knowledge_base_item',
      description: 'Knowledge base Q&A entry created',
      service: data?.service || 'KnowledgeBase',
      referenceType: 'knowledge_base',
      referenceId: data?.entryId?.toString(),
      // Priced by the admin "Knowledge Base Item" row (inactive by default).
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for knowledge base item');
  }
}

/**
 * Deduct credits for sentiment analysis (LLM-based)
 */
export async function deductCreditsForSentimentAnalysis(userId: number, data?: {
  contactId?: number;
  service?: string;
}): Promise<void> {
  try {
    await creditService.deductForEvent({
      userId,
      eventKey: 'content_generation',
      description: 'Sentiment analysis performed',
      service: data?.service || 'SentimentAnalysisService',
      referenceType: 'crm_contact',
      referenceId: data?.contactId?.toString(),
      overrideAmount: 0,
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for sentiment analysis');
  }
}

/**
 * Deduct credits for support ticket auto-creation from AI
 */
export async function deductCreditsForSupportTicketAI(userId: number, data?: {
  ticketId?: number;
  service?: string;
}): Promise<void> {
  try {
    const result = await creditService.deductForEvent({
      userId,
      eventKey: 'content_generation',
      description: 'Support ticket auto-created from negative sentiment',
      service: data?.service || 'SupportService',
      referenceType: 'support_ticket',
      referenceId: data?.ticketId?.toString(),
      overrideAmount: 0,
    });
    if (!result.success) {
      throw new Error(result.error || 'Support ticket AI credit event was not recorded.');
    }
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to deduct credits for support ticket AI');
    throw error;
  }
}
