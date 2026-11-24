import { requireBusinessScope } from '../../../tenancy/businessContext.js';
/**
 * ICP Tool Executor
 * Handles ICP generation tool execution
 */

import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult, ActionButton } from '../../state';
import { logger } from '../../../utils/logger.js';
import { icpDraftReceipt } from '../../../utils/icpCompleteness.js';
import { TAB_TYPES, TAB_LABELS } from '../../tabConfig';
import { AGENT_DESC_MAP } from '../../agentPersonas';

export async function executeGenerateIcp(
  input: { user_message?: string },
  context: ToolContext
): Promise<ToolResult> {
  const { userId, threadId, workflowId, conversationHistory } = context;
  
  // Convert to numbers for service calls
  const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : userId;
  const threadIdNum = typeof threadId === 'string' ? parseInt(threadId, 10) : threadId;
  
  // Ensure we have a user message - fallback to last conversation message
  let userMessage = input?.user_message;
  if (!userMessage && conversationHistory && conversationHistory.length > 0) {
    // Find the last user message from conversation history
    const lastUserMsg = [...conversationHistory].reverse().find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any) => msg.role === 'user' || msg._getType?.() === 'human'
    );
    if (lastUserMsg) {
      userMessage = typeof lastUserMsg.content === 'string' 
        ? lastUserMsg.content 
        : JSON.stringify(lastUserMsg.content);
    }
  }
  
  if (!userMessage) {
    return {
      success: false,
      toolName: 'generate_icp',
      error: 'No user message provided for ICP generation. Please describe your target audience.',
    };
  }
  
  try {
    // Import WebSocket emitter for progress updates
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    
    // Emit progress: Starting ICP generation
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'icp_extracting', 'Extracting customer profile data...', 'icp_generation');
    
    // Import ICP service
    const { ICPGenerationService } = await import('../../../services/ICPGenerationService');
    const icpService = new ICPGenerationService();
    
    // Emit progress: Processing with AI
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'icp_processing', 'Processing profile with AI...', 'icp_generation');
    
    const result = await icpService.generateICP({
      routerDecision: context.intentAnalysis,
      userMessage,
      conversationHistory: conversationHistory || [],
      userId: userIdNum,
      threadId: threadIdNum,
      workflowId,
    });

    if (!result.success) {
      return {
        success: false,
        toolName: 'generate_icp',
        error: result.error || 'ICP generation failed',
      };
    }

    // Emit progress: Calculating fit score
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'icp_scoring', 'Calculating fit score...', 'icp_generation');

    // If ICP is complete, save it
    if (result.icp && !result.needsMoreClarificationFields?.length) {
      // Emit progress: Saving profile
      webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'icp_saving', 'Saving customer profile...', 'icp_generation');
      
      const icpId = await icpService.saveICP(userIdNum, result.icp, threadIdNum);
      
      // Emit ICP update via WebSocket
      webSocketEmitter.emit(userIdNum, 'icp_update', {
        thread_id: threadIdNum,
        icp_id: icpId,
        fit_score: result.icp.fitScore,
        full_profile: {
          id: icpId,
          campaign_name: result.icp.campaignName,
          target_audience: result.icp.targetAudience,
          target_business_model: result.icp.targetBusinessModel,
          industry: result.icp.industry,
          sub_industry: result.icp.subIndustry,
          geography_locations: result.icp.primaryRegions,
          target_roles_titles: result.icp.primaryJobTitles,
          target_company_size_range: result.icp.targetCompanySizeRange,
          target_revenue_range: result.icp.targetRevenueRange,
          company_growth_stage: result.icp.companyGrowthStage,
          primary_value_proposition: result.icp.primaryValueProposition,
          primary_pain_point: result.icp.primaryPainPoint,
          sources: result.icp.primaryChannels,
          fit_score: result.icp.fitScore,
          summary: result.icp.summary,
        },
        summary: result.icp.summary,
        status: 'completed',
      });
      
      // Open the ICP tab in the sidebar to show the saved profile
      webSocketEmitter.emit(userIdNum, 'open_tab', {
        thread_id: threadIdNum,
        tabType: TAB_TYPES.ICP,
        tabLabel: TAB_LABELS[TAB_TYPES.ICP],
        data: {
          icpId,
          fitScore: result.icp.fitScore,
          campaignName: result.icp.campaignName,
        },
      });

      // A save acknowledgement is an execution receipt, not marketing copy.
      const icpResponse = icpDraftReceipt(result.icp);
      
      return {
        success: true,
        toolName: 'generate_icp',
        output: {
          icp: result.icp,
          icpId,
          fitScore: result.icp.fitScore,
          summary: result.icp.summary,
          message: `ICP Profile "${result.icp.campaignName}" created successfully with a fit score of ${result.icp.fitScore}%.`,
          response: icpResponse,
        },
      };
    }

    // ICP needs more clarification
    return {
      success: true,
      toolName: 'generate_icp',
      output: {
        needsClarification: true,
        missingFields: result.needsMoreClarificationFields,
        partialICP: result.icp,
        icp: result.icp, // Also include as 'icp' for consistency
        icpId: result.icp?.id,
        fitScore: result.icp?.fitScore,
        clarificationMessage: result.clarificationMessage,
        message: result.clarificationMessage || 'Need more information to complete your ICP.',
      },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ICP Executor] Error');
    return {
      success: false,
      toolName: 'generate_icp',
      error: error.message,
    };
  }
}

/**
 * Save business profile from chat conversation
 */
export async function executeSaveBusinessProfile(
  input: {
    company_name: string;
    industry?: string;
    city?: string;
    country?: string;
    description?: string;
  },
  context: ToolContext
): Promise<ToolResult> {
  const { userId, threadId } = context;
  
  const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : userId;
  const threadIdNum = typeof threadId === 'string' ? parseInt(threadId, 10) : threadId;
  
  if (!input.company_name) {
    return {
      success: false,
      toolName: 'save_business_profile',
      error: 'Company name is required to save business profile.',
    };
  }
  
  try {
    const { db } = await import('../../../models/db');
    const { companySettings } = await import('../../../models/companySettings/schema');
    const { eq } = await import('drizzle-orm');
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    
    // Emit progress
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'saving_business', 'Saving business profile...', 'icp_generation');
    
    // A conversation belongs to one business for its lifetime. This tool edits
    // that business; adding another workspace is handled by profile management.
    const scope = requireBusinessScope();
    if (scope.userId !== userIdNum) throw new Error('Business account mismatch');
    const [profile] = await db.update(companySettings).set({
      name: input.company_name, companyName: input.company_name, businessName: input.company_name,
      industry: input.industry, city: input.city, country: input.country, description: input.description,
      updatedAt: new Date(),
    }).where(eq(companySettings.id, scope.businessProfileId)).returning();
    if (!profile) throw new Error('The selected business profile is unavailable');

    // Emit business profile update via WebSocket
    webSocketEmitter.emit(userIdNum, 'business_profile_created', {
      thread_id: threadIdNum,
      profile_id: profile.id,
      company_name: input.company_name,
      profile,
    });
    
    // Open the ICP tab to show the updated state (business is linked to ICP)
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: threadIdNum,
      tabType: TAB_TYPES.ICP,
      tabLabel: TAB_LABELS[TAB_TYPES.ICP],
      data: {
        businessId: profile.id,
        businessName: input.company_name,
      },
    });
    
    return {
      success: true,
      toolName: 'save_business_profile',
      output: {
        profileId: profile.id,
        companyName: input.company_name,
        message: `Business profile "${input.company_name}" has been saved successfully. You can view and edit it in the Business Settings page.`,
      },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Save Business Profile Executor] Error');
    return {
      success: false,
      toolName: 'save_business_profile',
      error: error.message,
    };
  }
}

/**
 * Crawl a website URL and extract business information for ICP enrichment
 */
export async function executeCrawlWebsite(
  input: { url: string; extract_focus?: string },
  context: ToolContext
): Promise<ToolResult> {
  const { userId, threadId } = context;

  const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : userId;
  const threadIdNum = typeof threadId === 'string' ? parseInt(threadId, 10) : threadId;

  if (!input.url) {
    return {
      success: false,
      toolName: 'crawl_website',
      error: 'No URL provided. Please provide a website URL to crawl.',
    };
  }

  // Normalize URL
  let url = input.url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');

    // Check governed, published evidence for existing crawled content.
    const hostname = new URL(url).hostname;
    const { knowledgeGateway } = await import('../../../services/knowledge/KnowledgeGateway.js');
    const kbResult = await knowledgeGateway.retrieve({
      tenantId: userIdNum, purpose: 'internal_assist', channel: 'internal', audience: 'internal',
      redactedText: `website content ${url} ${hostname}`, redactedHistory: [], entities: {}, risk: 'low',
    });
    const matchingEvidence = kbResult.evidence.filter((evidence) => {
      if (!evidence.sourceUrl) return false;
      try { return new URL(evidence.sourceUrl).hostname === hostname; } catch { return false; }
    });
    if (matchingEvidence.length > 0) {
      const kbContent = matchingEvidence.map((evidence) => evidence.excerpt).join('\n\n');
      if (kbContent.length > 100) {
        logger.info({ url, evidenceCount: matchingEvidence.length }, '[Crawl Website] Found published KB evidence — using cached content');
        webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'website_crawl_cached', `Found website content in knowledge base — using cached data for ${hostname}`, 'icp_generation');
        webSocketEmitter.emitToolExecution(userIdNum, threadIdNum, {
          toolName: 'crawl_website',
          args: { url },
          status: 'completed',
          agentType: 'icp_generation',
          durationMs: 0,
        });

        return {
          success: true,
          toolName: 'crawl_website',
          output: {
            url,
            contentLength: kbContent.length,
            pagesExtracted: 1,
            pagesCrawled: [url],
            pageDetails: [{ url, category: 'knowledge_base', title: matchingEvidence[0].title || hostname, contentLength: kbContent.length }],
            discoveredLinks: [],
            websiteContent: kbContent,
            source: 'knowledge_base',
            message: `Found existing content for ${url} in knowledge base (${kbContent.length} chars). Using cached data instead of re-crawling. This content should be used to generate the ICP profile.`,
          },
        };
      }
    }

    const { WebsiteCrawlerService } = await import('../../../services/WebsiteCrawlerService');

    // Step 1: Starting crawl
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'website_crawl_starting', `Starting website crawl: ${url}`, 'icp_generation');
    webSocketEmitter.emitToolExecution(userIdNum, threadIdNum, {
      toolName: 'crawl_website',
      args: { url: url },
      status: 'started',
      agentType: 'icp_generation',
    });

    // Step 2: Crawling in progress
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'website_crawl_running', `Crawling website content from ${new URL(url).hostname}...`, 'icp_generation');

    const startTime = Date.now();
    const crawler = new WebsiteCrawlerService({
      maxPages: 12,
      maxContentLength: 20000,
      timeoutMs: 30000,
      onLinksAnalyzed: (links) => {
        const categories = [...new Set(links.filter(l => l.priority <= 3).map(l => l.category))];
        webSocketEmitter.emitProgressStep(
          userIdNum, threadIdNum,
          'website_links_analyzed',
          `Found ${links.length} links — prioritized categories: ${categories.join(', ')}`,
          'icp_generation'
        );
      },
      onPageCrawled: (page, index, total) => {
        const label = page.category ? page.category.charAt(0).toUpperCase() + page.category.slice(1) : 'Page';
        const status = page.success ? `✓ ${label}` : `✗ ${label} (failed)`;
        const title = page.title ? ` — ${page.title}` : '';
        webSocketEmitter.emitProgressStep(
          userIdNum, threadIdNum,
          'website_page_crawled',
          `[${index + 1}/${total}] ${status}${title}: ${page.url}`,
          'icp_generation'
        );
      },
    });
    const { pages, combinedContent, discoveredLinks } = await crawler.crawl(url);

    const successfulPages = pages.filter(p => p.success);

    if (successfulPages.length === 0 || !combinedContent) {
      const firstError = pages[0]?.error || 'No content extracted';
      webSocketEmitter.emitToolExecution(userIdNum, threadIdNum, {
        toolName: 'crawl_website',
        status: 'failed',
        agentType: 'icp_generation',
        error: firstError,
        durationMs: Date.now() - startTime,
      });
      return {
        success: false,
        toolName: 'crawl_website',
        error: `Failed to crawl website: ${firstError}`,
      };
    }

    // Step 3: Extracting data — show which page categories were crawled
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const categories = [...new Set(successfulPages.map(p => (p as any).category).filter(Boolean))];
    const categoryLabel = categories.length > 0 ? ` (${categories.join(', ')})` : '';
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'website_crawl_extracting', `Extracting business information from ${successfulPages.length} page(s)${categoryLabel}...`, 'icp_generation');

    // Step 4: Done
    const pageUrls = successfulPages.map(p => p.url);
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'website_crawl_complete', `Website crawl complete — intelligently crawled ${successfulPages.length} page(s)${categoryLabel}, extracted ${combinedContent.length} chars`, 'icp_generation');
    webSocketEmitter.emitToolExecution(userIdNum, threadIdNum, {
      toolName: 'crawl_website',
      status: 'completed',
      agentType: 'icp_generation',
      durationMs: Date.now() - startTime,
    });

    return {
      success: true,
      toolName: 'crawl_website',
      output: {
        url,
        contentLength: combinedContent.length,
        pagesExtracted: successfulPages.length,
        pagesCrawled: pageUrls,
        pageDetails: successfulPages.map(p => ({
          url: p.url,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          category: (p as any).category || 'unknown',
          title: p.title || '',
          contentLength: (p.text || p.markdown || '').length,
        })),
        discoveredLinks: discoveredLinks.slice(0, 30),
        websiteContent: combinedContent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        message: `Successfully crawled ${url} — intelligently analyzed and deep-crawled ${successfulPages.length} page(s)${categoryLabel}. Extracted ${combinedContent.length} characters. Pages: ${successfulPages.map(p => `${(p as any).category || 'page'}(${p.url})`).join(', ')}. This content should be used to generate the ICP profile.`,
      },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, url }, '[Crawl Website Executor] Error');

    // Emit failure
    try {
      const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
      webSocketEmitter.emitToolExecution(userIdNum, threadIdNum, {
        toolName: 'crawl_website',
        status: 'failed',
        agentType: 'icp_generation',
        error: error.message,
      });
    } catch { /* non-blocking */ }

    return {
      success: false,
      toolName: 'crawl_website',
      error: `Failed to crawl website: ${error.message}`,
    };
  }
}

async function detectUserMarketingNeedsWithLLM(
  conversationContext: string,
  recentMessages: string,
  userId: number,
): Promise<{
  wantsAds: boolean;
  wantsContentOnly: boolean;
  wantsLeadsOnly: boolean;
  wantsOutreach: boolean;
  wantsEndToEnd: boolean;
}> {
  try {
    const { LLMProviderFactory } = await import('../../../services/agents/LLMProviderFactory');
    const provider = await LLMProviderFactory.createProviderForUser(userId);
    if (!provider) {
      return { wantsAds: false, wantsContentOnly: false, wantsLeadsOnly: false, wantsOutreach: false, wantsEndToEnd: false };
    }

    const systemPrompt = `Analyze the user's conversation history and classify their marketing needs:
1. "wantsAds": user wants paid ads, Meta ads, Facebook/Google ads, ad copies, performance marketing.
2. "wantsContentOnly": user wants content studio, writing blogs, content generation, images/videos, with no mention of leads, outreach, or ads.
3. "wantsLeadsOnly": user wants only scraping/finding leads, B2B prospects, Google Maps/LinkedIn search, with no mention of outreach, content, or ads.
4. "wantsOutreach": user wants outreach campaigns, sending emails/SMS, sequences, or messaging leads.
5. "wantsEndToEnd": user wants a comprehensive strategy, end-to-end setup, or all agents to run together.

Return a JSON object in this exact format:
{
  "wantsAds": boolean,
  "wantsContentOnly": boolean,
  "wantsLeadsOnly": boolean,
  "wantsOutreach": boolean,
  "wantsEndToEnd": boolean
}`;

    const userPrompt = `RECENT CONTEXT:\n${recentMessages}\n\nFULL CONVERSATION CONTEXT:\n${conversationContext}`;

    const result = await provider.createChatCompletion({
      model: provider.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      temperature: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response_format: { type: 'json_object' as any },
    });

    if (result.success && result.content) {
      const parsed = JSON.parse(result.content);
      return {
        wantsAds: !!parsed.wantsAds,
        wantsContentOnly: !!parsed.wantsContentOnly,
        wantsLeadsOnly: !!parsed.wantsLeadsOnly,
        wantsOutreach: !!parsed.wantsOutreach,
        wantsEndToEnd: !!parsed.wantsEndToEnd,
      };
    }
  } catch (err) {
    logger.warn({ err }, '[detectUserMarketingNeedsWithLLM] LLM classification failed');
  }
  return { wantsAds: false, wantsContentOnly: false, wantsLeadsOnly: false, wantsOutreach: false, wantsEndToEnd: false };
}

/**
 * Suggest agents based on the completed ICP profile.
 * Only called when fitScore >= 50. Returns recommendation text + hire buttons via ToolResult.
 * The caller (icpAgent.ts callSuggestAgentsTool) handles WS emit and DB save.
 */
export async function executeSuggestAgents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: { icpProfile: any; fitScore: number; modificationIntent?: string; currentPipeline?: string[] },
  context: ToolContext
): Promise<ToolResult> {
  const { userId, conversationHistory } = context;
  const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : userId;

  if ((input.fitScore || 0) <= 0) {
    return {
      success: false,
      toolName: 'suggest_agents',
      error: 'No ICP data available. Please create an ICP first before viewing agent suggestions.',
    };
  }

  const icp = input.icpProfile || {};

  // Fetch business/company profile for context
  let businessContext = '';
  try {
    const { getBusinessProfileContextByUserId } = await import('../../../models/companySettings/functions');
    const profile = await getBusinessProfileContextByUserId(userIdNum);
    if (profile) {
      const parts = [
        profile.companyName && `Company: ${profile.companyName}`,
        profile.industry && `Industry: ${profile.industry}`,
        profile.description && `Description: ${profile.description}`,
        profile.primaryMarket && `Market: ${profile.primaryMarket}`,
        profile.customerType && `Customer Type: ${profile.customerType}`,
        profile.targetRegions.length > 0 && `Regions: ${profile.targetRegions.join(', ')}`,
        profile.businessGoals.length > 0 && `Goals: ${profile.businessGoals.join(', ')}`,
      ].filter(Boolean);
      if (parts.length > 0) businessContext = parts.join('\n');
    }
  } catch (e) {
    logger.warn({ err: e }, '[Suggest Agents] Failed to fetch business profile');
  }

  const agentDescMap = AGENT_DESC_MAP;

  // Build ICP context string
  const icpSummary = [
    icp.businessName       && `Business: ${icp.businessName}`,
    icp.industry           && `Industry: ${icp.industry}`,
    icp.targetAudience     && `Target Audience: ${icp.targetAudience}`,
    icp.targetBusinessModel && `Business Model: ${icp.targetBusinessModel}`,
    icp.campaignObjective  && `Campaign Objective: ${icp.campaignObjective}`,
    `ICP Fit Score: ${input.fitScore}%`,
  ].filter(Boolean).join('\n');

  // Extract conversation context
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allUserMsgs = ((conversationHistory as any[] | undefined) || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => m.role === 'user' || m._getType?.() === 'human')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => typeof m.content === 'string' ? m.content : '')
    .filter(Boolean)
    .filter((msg: string) => !msg.toLowerCase().includes('start campaign'));
  const originalUserRequest = allUserMsgs[0] || '';
  const recentUserMessages  = allUserMsgs.slice(-5).join('\n');
  // Full conversation context for intent detection (all user messages combined)
  const fullConversationContext = allUserMsgs.join('\n').toLowerCase();

  const agentList = Object.entries(agentDescMap)
    .map(([key, info]) => `- ${key}: ${info.name} (${info.role}) — ${info.desc}`)
    .join('\n');

  // Build modification context if provided
  const modificationSection = input.modificationIntent
    ? `\n\nUSER PIPELINE MODIFICATION REQUEST:\n"${input.modificationIntent}"\nCurrent pipeline: ${(input.currentPipeline || []).join(' → ') || 'none set'}\nIMPORTANT: If the user tries to remove a required dependency (e.g., removing lead_generation when outreach is needed, or removing content_studio when outreach/ads are needed), do NOT allow it. Instead, explain why it is required and suggest the correct minimal pipeline.`
    : '';

  let suggestionContent = '';
  let recommendedAgentKeys: string[] = [];
  const agentScores: Record<string, number> = {};
  const agentDescriptions: Record<string, string> = {};

  try {
    const { LLMProviderFactory } = await import('../../../services/agents/LLMProviderFactory');
    const llmProvider = await LLMProviderFactory.createProviderForUser(userIdNum);

    if (llmProvider) {
      const suggestionPrompt = `Based on the completed ICP profile, business profile, and conversation context below, recommend which agents the user should hire to execute their campaign.

RECENT USER MESSAGES (HIGHEST PRIORITY — defines what the user wants NOW):
${recentUserMessages || 'No recent messages'}

ORIGINAL USER REQUEST (background context — the initial campaign setup):
"${originalUserRequest || 'No original request available'}"

ICP PROFILE:
${icpSummary || 'Profile completed'}
${businessContext ? `\nBUSINESS PROFILE:\n${businessContext}` : ''}${modificationSection}

AVAILABLE AGENTS:
${agentList}

PIPELINE RULES (these are MANDATORY, never violate them):
1. The RECENT USER MESSAGES define the current intent — prioritize them over the original request
2. Pure lead-finding / prospecting requests (e.g. searching/scraping for leads, finding customer profiles) with no mention of campaigns, outreach, or ads → recommend ONLY "lead_generation" (do NOT add content or outreach unless requested)
3. Content creation requests → recommend ONLY "content_studio" (do NOT add lead_generation unless explicitly requested)
4. Outreach requests / direct campaigns → recommend "lead_generation → content_studio → outreach" (all three are REQUIRED — you need leads before you can do outreach, and content to send)
5. Ads / paid campaigns / ad copy / ad generation → recommend "content_studio → performance_marketing" (content is needed to create the ad creatives)
6. Recommend all 4 agents ONLY if the user explicitly asks for a comprehensive/end-to-end marketing setup, strategy campaign, or all agents (e.g., "start campaign and suggest agents")
7. DEPENDENCY ENFORCEMENT: If the pipeline contains outreach → lead_generation MUST be present. If the pipeline contains outreach or performance_marketing → content_studio MUST be present.
8. Assign a relevance % (1-100) to each recommended agent
9. If this is a modification request, evaluate and explain if the requested change is valid or if a dependency would be broken

Message format:
- 1-2 sentence overview tailored to the user request, mention the user's business or industry
- Each recommended agent on its own line: **Name** (XX%) — what they will do for THIS specific campaign/business
- If pipeline has dependencies, briefly mention the order (e.g., "Marcus finds the leads first, then Alex creates the outreach content, then Emily sends them")
- End with a brief call-to-action
- Keep it concise (4-7 lines total)

RESPOND IN THIS EXACT JSON FORMAT (no markdown fencing):
{"message": "Your formatted markdown with \n\n for line breaks", "agents": {"agent_key": 95}, "descriptions": {"agent_key": "1-sentence description of what this agent will do for THIS specific campaign based on the ICP and business profile"}}`;

      const llmResult = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: 'You are a marketing strategy advisor. Respond ONLY with valid JSON, no markdown fencing.' },
          { role: 'user', content: suggestionPrompt },
        ],
        loggingContext: {
          userId: userIdNum,
          threadId: context.threadId,
          purpose: 'icp_generation',
          service: 'IcpExecutor',
          action: 'suggest_agents',
        },
      });

      if (llmResult.success && llmResult.content) {
        const jsonMatch = llmResult.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          suggestionContent = parsed.message || '';
          // Extract per-agent descriptions
          if (parsed.descriptions && typeof parsed.descriptions === 'object') {
            for (const [key, desc] of Object.entries(parsed.descriptions)) {
              if (agentDescMap[key] && typeof desc === 'string') agentDescriptions[key] = desc;
            }
          }
          if (parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)) {
            recommendedAgentKeys = Object.keys(parsed.agents).filter((k: string) => agentDescMap[k]);
            for (const [key, score] of Object.entries(parsed.agents)) {
              if (agentDescMap[key] && typeof score === 'number') agentScores[key] = score;
            }
          } else if (Array.isArray(parsed.agents)) {
            recommendedAgentKeys = (parsed.agents as string[]).filter((k) => agentDescMap[k]);
            recommendedAgentKeys.forEach((k, idx) => { agentScores[k] = Math.max(95 - idx * 15, 50); });
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, '[Suggest Agents Executor] LLM call failed, using rule-based fallback');
  }

  // Post-LLM validation: check if LLM result contradicts clear user intent from full conversation
  if (recommendedAgentKeys.length > 0) {
    const onlyLeadGen = recommendedAgentKeys.length === 1 && recommendedAgentKeys[0] === 'lead_generation';

    if (onlyLeadGen) {
      const needs = await detectUserMarketingNeedsWithLLM(fullConversationContext, recentUserMessages, userIdNum);
      if (needs.wantsAds) {
        logger.warn({ llmResult: recommendedAgentKeys, detectedIntent: 'ads' }, '[Suggest Agents] LLM recommended only lead_generation but user wants ads — overriding');
        recommendedAgentKeys = ['content_studio', 'performance_marketing'];
        agentScores['content_studio'] = 95;
        agentScores['performance_marketing'] = 85;
        suggestionContent = ''; // Force regeneration of message
      } else if (needs.wantsContentOnly) {
        logger.warn({ llmResult: recommendedAgentKeys, detectedIntent: 'content' }, '[Suggest Agents] LLM recommended only lead_generation but user wants content — overriding');
        recommendedAgentKeys = ['content_studio'];
        agentScores['content_studio'] = 95;
        suggestionContent = ''; // Force regeneration of message
      }
    }
  }

  // Rule-based fallback — check recent messages first, then original request
  if (!suggestionContent || recommendedAgentKeys.length === 0) {
    const needs = await detectUserMarketingNeedsWithLLM(fullConversationContext, recentUserMessages, userIdNum);

    if (needs.wantsAds) {
      recommendedAgentKeys = ['content_studio', 'performance_marketing'];
    } else if (needs.wantsContentOnly) {
      recommendedAgentKeys = ['content_studio'];
    } else if (needs.wantsLeadsOnly) {
      recommendedAgentKeys = ['lead_generation'];
    } else if (needs.wantsOutreach) {
      recommendedAgentKeys = ['lead_generation', 'content_studio', 'outreach'];
    } else {
      recommendedAgentKeys = ['lead_generation', 'content_studio', 'outreach', 'performance_marketing'];
    }
    recommendedAgentKeys.forEach((k, idx) => { agentScores[k] = Math.max(90 - idx * 15, 50); });

    const targetAudience = icp.targetAudience || 'your target audience';
    const agentLines = recommendedAgentKeys
      .map(k => `**${agentDescMap[k].name}** (${agentScores[k]}%) — ${agentDescMap[k].desc}`)
      .join('\n\n');
    suggestionContent = `Your ICP for **${targetAudience}** is ready! Here's who I recommend to bring your campaign to life:\n\n${agentLines}\n\nHire them below to get started.`;
  }

  // Enforce content_studio dependency for outreach / performance_marketing
  if ((recommendedAgentKeys.includes('outreach') || recommendedAgentKeys.includes('performance_marketing'))
      && !recommendedAgentKeys.includes('content_studio')) {
    const insertIdx = Math.max(0, recommendedAgentKeys.findIndex(k => k === 'outreach' || k === 'performance_marketing'));
    recommendedAgentKeys.splice(insertIdx, 0, 'content_studio');
    const avgScore = Object.values(agentScores).reduce((a, b) => a + b, 0) / (Object.values(agentScores).length || 1);
    agentScores['content_studio'] = Math.round(avgScore);
  }

  // Enforce lead_generation dependency for outreach
  if (recommendedAgentKeys.includes('outreach') && !recommendedAgentKeys.includes('lead_generation')) {
    recommendedAgentKeys.unshift('lead_generation');
    const avgScore = Object.values(agentScores).reduce((a, b) => a + b, 0) / (Object.values(agentScores).length || 1);
    agentScores['lead_generation'] = Math.round(avgScore);
  }

  // Build hire buttons
  const hireButtons: ActionButton[] = [];
  let isFirst = true;
  for (const key of recommendedAgentKeys) {
    const info = agentDescMap[key];
    if (info) {
      hireButtons.push({
        id: `hire_${key}`,
        label: info.label,
        action: info.action as ActionButton['action'],
        type: isFirst ? 'primary' : 'secondary',
        data: { agentName: info.label.replace('Hire ', ''), agentType: info.agentType },
      });
      isFirst = false;
    }
  }

  const recommendedAgentScores: Record<string, number> = {};
  for (const k of recommendedAgentKeys) recommendedAgentScores[k] = agentScores[k] || 80;

  return {
    success: true,
    toolName: 'suggest_agents',
    output: {
      suggestionContent,
      hireButtons,
      recommendedAgentKeys,
      recommendedAgentScores,
      agentDescriptions,
    },
  };
}
