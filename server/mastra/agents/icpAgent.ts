/**
 * Mastra ICP Agent
 * Replaces server/langgraph/nodes/icpAgent.ts
 *
 * Uses the shared provider-fallback path with OpenAI-format function calling
 * (tools parameter). This bypasses the broken Mastra Agent.generate() flow and
 * keeps ICP generation available when one configured provider is unavailable.
 *
 * Preserves ALL system prompt text, business logic, auto-chaining,
 * action buttons, and websocket emission.
 */

import { createCompletionWithProviderFallback } from '../utils/providerCompletion.js';
import { executeGenerateIcp, executeCrawlWebsite } from '../tools/executors/icpExecutor.js';
 
import type { AgentState, ICPProfile, ActionButton } from '../state.js';
import { webSocketEmitter } from '../../services/agents/WebSocketEmitter.js';
import { buildAgentContext, prepareContextForAgent } from '../utils/contextManager.js';
import { checkpointConversationRequest, ConversationRequestError } from '../../services/ConversationRequestCoordinator.js';
import { getToolDescriptionsForAgent } from '../tools/toolRegistry.js';
import { logger } from '../../utils/logger.js';
import { cleanResponseText } from '../utils/cleanResponseText.js';
import {
  classifyLLMProviderFailure,
  isProviderResponseError,
  safeLLMProviderFailureMessage,
} from '../../services/agents/LLMProviderErrors.js';
import type { ToolContext } from '../tools/toolRegistry.js';
import { TAB_TYPES, TAB_LABELS } from '../tabConfig.js';
import {
  AI_SERVICE_UNAVAILABLE_MESSAGE,
  isProviderInfrastructureError,
  toUserFacingError,
} from '../../../shared/userFacingError.js';
import { isCurrentIcpRevisionApproved } from '../../models/conversationWorkflow/stateMachine.js';
import { ICP_CHANNEL_SELECTION_POLICY } from '../../utils/icpChannelPolicy.js';

export function buildIcpSystemPrompt(state: AgentState): string {
  const toolDescriptions = getToolDescriptionsForAgent('icp_generation');

  let prompt = `You are the Orchestrator - a specialist focused ONLY on helping businesses define their Ideal Customer Profile.

RULES:
1. Your ONLY job is to create and refine the ICP. DO NOT generate content, posts, scripts, ad copy, or marketing materials.
2. When user provides customer info, call the "generate_icp" tool.
3. After ICP is complete, present it for explicit client approval. Only after the exact current revision is approved may you present agent recommendations.
4. ICP is auto-saved via generate_icp — never say you "can't save."
5. If user describes their business, acknowledge it and use it as ICP context.

YOUR TOOLS:
${toolDescriptions}

WEBSITE CRAWLING STRATEGY (CRITICAL — FOLLOW THIS EXACTLY):
1. ALWAYS check if a website URL is available from:
   a. The business profile (provided in the system context below)
   b. The user's chat message (URL mentioned or linked)
2. If a website is available AND no ICP exists yet, your FIRST action MUST be to call crawl_website with that URL.
3. The crawl_website tool intelligently crawls multiple pages (about, products, services, contact, case studies, docs, support, etc.) to gather comprehensive business data.
4. After calling crawl_website, DO NOT call generate_icp yourself. The system will AUTOMATICALLY chain crawl_website → generate_icp for you. Just call crawl_website alone.
5. If no website is available, proceed with generating the ICP from conversation context directly using generate_icp.

IMPORTANT: crawl_website now crawls up to 10 business-critical pages automatically. You do NOT need to call it multiple times for the same domain.
IMPORTANT: When calling crawl_website, call ONLY crawl_website in that turn. Do NOT also call generate_icp — the auto-chain handles it.

QUESTION POLICY:
- DO NOT ASK QUESTIONS if you have enough context to generate. If you have business name OR industry OR description OR website data, GENERATE THE ICP IMMEDIATELY using generate_icp tool.
- Ask AT MOST 1 question total across the entire conversation, and ONLY if you have absolutely zero context about the business.
- Auto-generate campaignName from user intent. Auto-generate campaignObjective. NEVER ask for these.
- Infer everything possible: targetBusinessModel, targetAudience, industry, primaryJobTitles, targetCompanySizeRange, primaryPainPoint, primaryValueProposition, channels/platforms. NEVER ask about these.
- Use business location as default primaryRegions. Only ask if no location is mentioned.
- Prefer generating a "good enough" ICP over asking questions. Let the user REFINE afterwards.
- After generating, say "Here's your ICP. Let me know if you'd like to adjust anything."
- If user provides any update (e.g., "use only google maps"), call generate_icp immediately with the updated fields — do NOT ask follow-up questions.

DATA QUERIES:
- If the user asks about existing Ideal Customer Profiles (ICPs), target audiences, or campaign criteria, call the "query_icp_profiles" tool.
- NEVER generate a new ICP when the user is asking about an existing ICP.
- Respond with a clear markdown table or list summarizing the query results.

ICP DATA FORMAT (required for parsing — use EXACTLY these camelCase keys):
<icp_data>
{
  "campaignName": "string — auto-generated campaign name",
  "campaignObjective": "string — main goal of the campaign",
  "targetBusinessModel": "string — exactly 'B2B' or 'B2C'",
  "targetAudience": "string — description of who they want to reach",
  "industry": "string — target industry vertical",
  "subIndustry": "string — sub-industry if applicable (optional)",
  "primaryRegions": ["string array — list of geographic regions"],
  "targetCompanySizeRange": "string — employee count range like '11-50' or '51-200'",
  "targetRevenueRange": "string — revenue range like '$1M-$10M' (optional)",
  "primaryJobTitles": ["string array — target job titles/roles"],
  "primaryPainPoint": "string — main challenge/pain point to solve",
  "primaryValueProposition": "string — primary value offered (optional)",
  "primaryChannels": ["string array — ONLY from: linkedin, google_maps, justdial, instagram, facebook, twitter"]
}
</icp_data>

KEY FORMAT: Use ONLY these exact camelCase keys (e.g., "campaignName" NOT "campaign_name", "primaryRegions" NOT "geography_locations"). Array fields MUST be JSON arrays, NOT comma-separated strings.

primaryChannels RULES:
- ONLY populate when intent is outreach/lead generation/prospecting. For content/analytics/strategy, set to [].
${ICP_CHANNEL_SELECTION_POLICY}
- Supported platforms: linkedin, google_maps, justdial, instagram, facebook, twitter. NO others.
- If user requests an unsupported platform (reddit, youtube, tiktok, etc.), inform them and list supported platforms. Do NOT proceed.

IMPROVE/REFINE: If user says "improve/refine/update ICP": review what's known, identify 1-2 improvable fields, ask at most 1 question, then regenerate.

FIRST MESSAGE RULE: If first message in conversation contains business/campaign information (company details, target audience, industry, location, service/product info, website URL, or campaign goal), use it to generate/update ICP via generate_icp. EXCEPTION: If the first message is ONLY a greeting or short filler (e.g., "Hello", "Hi", "Hey", "Good morning"), respond warmly by name, briefly introduce yourself as the ICP specialist, and ask what kind of campaign or business they'd like to work on — do NOT call any tools for a pure greeting.

AFTER ICP IS GENERATED (when generate_icp tool was called):
- Write ONLY 1-2 sentences. Do NOT list ICP fields (tool card shows them).
- Acknowledge the saved draft and its completeness score, then request review of the exact revision. The score is the percentage of filled profile fields, not confidence, lead quality, conversion probability, or evidence of a target list.
- Never describe an unapproved draft as "locked in", imply outreach may start, or claim leads were generated. For missing information, use the supplied completeness facts rather than inventing gaps.
- Do NOT call suggest_switch_agents here. Wait for the user to say "start campaign" first.
- Do NOT generate content, posts, or scripts. NEVER say "Here's a sample post."
- STOP after the summary.

WHEN THE USER WANTS TO CONTINUE:
- If the exact current ICP revision is not approved, ask them to approve it using its review card. Natural-language agreement never approves a revision.
- Only after current-revision approval, suggest agents appropriate to the user's stated goal; do not automatically assign a default team.
- Recommendations are choices, not permission to send, publish, or spend.`;

  // Append dynamic context (business profile, user info, existing ICP)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextInfo = buildAgentContext(state as any, {
    businessInstruction: 'Use this business information as context for ICP generation.',
    icpInstruction: 'This is the CURRENT ICP. When asked to improve, build on this data.',
    includeBrandToolkit: false,
    userInstruction: 'Address the user by their first name.',
  });

  if (contextInfo) {
    prompt += `\n\n--- CONTEXT ---${contextInfo}`;
  }

  // Explicitly highlight website URL for auto-crawl trigger
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const website = (state.companyProfile as any)?.website || (state as any).businessProfile?.website;
  if (website) {
    prompt += `\n\nBUSINESS WEBSITE: ${website}\nIMPORTANT: If no ICP exists yet, crawl this website FIRST using crawl_website tool before generating ICP.`;
  }

  // If existing ICP, show it
  if (state.icpProfile) {
    prompt += `\n\nEXISTING ICP DATA:\n${JSON.stringify(state.icpProfile, null, 2)}`;
  }

  const pipelineIndex = state.agentPipelineIndex || 0;
  const prerequisiteTarget = state.agentPipeline?.[pipelineIndex] === 'icp_generation'
    ? state.agentPipeline[pipelineIndex + 1]
    : null;
  if (prerequisiteTarget) {
    prompt += `\n\nPREREQUISITE MODE (MANDATORY):
The user's requested destination agent is "${prerequisiteTarget}". Your only task in this step is to satisfy the ICP prerequisite without losing the pending request.
- Do NOT refuse the request because the eventual task is ad creation, content, outreach, or performance marketing.
- Do NOT ask permission to create the ICP when business name, product, audience, industry, campaign goal, or website context is available.
- If EXISTING ICP DATA contains a saved profile with fitScore >= 50, do not crawl or regenerate it merely because approval is missing. Explain that the existing profile needs approval before the requested specialist can continue, and present its current saved revision. Only revise it when the user requests changes.
- If no usable saved ICP exists, call crawl_website first when a business website is available; otherwise call generate_icp immediately with inferred, good-enough values.
- After the ICP tool succeeds, stop and present the exact saved revision for client approval. The requested specialist remains paused until that approval is durable.
- Do NOT call suggest_switch_agents or resume the requested specialist before the ICP approval gate succeeds.`;
  }

  return prompt;
}

// ── Intent Helpers ─────────────────────────────────────────────────────

function determineActionButtons(icpProfile: ICPProfile | null): ActionButton[] {
  if (!icpProfile) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitScore = (icpProfile as any).fitScore ?? 0;

  if (fitScore >= 50) {
    const revision = icpProfile.revision ?? 1;
    const isApproved = icpProfile.approved === true && icpProfile.approvedRevision === revision;
    return [
      { id: 'improve_icp', label: 'Improve ICP', action: 'IMPROVE_ICP', type: 'secondary' as const },
      isApproved
        ? { id: 'start_campaign', label: 'Choose Agents', action: 'START_CAMPAIGN', type: 'primary' as const }
        : {
            id: `approve_icp_${icpProfile.id || 'current'}_${revision}`,
            label: 'Approve ICP',
            action: 'APPROVE_ICP',
            data: { icpId: icpProfile.id, revision },
            type: 'primary' as const,
          },
    ];
  }
  if (fitScore > 0) {
    return [{ id: 'improve_icp', label: 'Improve ICP', action: 'IMPROVE_ICP', type: 'primary' as const }];
  }
  return [];
}

// ── ICP Data Parsing & Auto-Save ──────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseIcpDataFromResponse(responseContent: string): Record<string, any> | null {
  // Primary: look for <icp_data> tags
  try {
    const startIdx = responseContent.indexOf('<icp_data>');
    const endIdx = responseContent.indexOf('</icp_data>');
    if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
      const jsonStr = responseContent.slice(startIdx + '<icp_data>'.length, endIdx).trim();
      return JSON.parse(jsonStr);
    }
  } catch (e) {
    logger.warn({ err: e }, '[ICP Agent] Failed to parse ICP data from <icp_data> tags');
  }
  // Fallback: <param name="icp_data"> XML
  try {
    const paramMatch = responseContent.match(/<param\s+name="icp_data">\s*([\s\S]*?)\s*<\/param>/i);
    if (paramMatch?.[1]) return JSON.parse(paramMatch[1].trim());
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) { /* ignore */ }
  return null;
}

async function autoSaveIcpFromResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icpData: Record<string, any>,
  userId: number,
  threadId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existingProfile: any,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ icpId?: number; fitScore?: number; updatedProfile: any }> {
  try {
    const { ICPGenerationService } = await import('../../services/ICPGenerationService.js');
    const icpService = new ICPGenerationService();

    // Map field variations: camelCase, snake_case, and common alternatives
    const icpToSave = {
      ...existingProfile,
      campaignName: icpData.campaignName || icpData.campaign_name || icpData.name || existingProfile?.campaignName,
      campaignObjective: icpData.campaignObjective || icpData.campaign_objective || icpData.objective || existingProfile?.campaignObjective,
      targetAudience: icpData.targetAudience || icpData.target_audience || icpData.audience || existingProfile?.targetAudience,
      summary: icpData.summary || existingProfile?.summary,
      industry: icpData.industry || icpData.industryVertical || icpData.industry_vertical || existingProfile?.industry,
      subIndustry: icpData.subIndustry || icpData.sub_industry || icpData.subindustry || existingProfile?.subIndustry,
      targetCompanySizeRange: icpData.targetCompanySizeRange || icpData.target_company_size_range || icpData.companySizeRange || icpData.company_size_range || icpData.companySize || icpData.company_size || existingProfile?.targetCompanySizeRange,
      targetRevenueRange: icpData.targetRevenueRange || icpData.target_revenue_range || icpData.revenueRange || icpData.revenue_range || existingProfile?.targetRevenueRange,
      targetBusinessModel: icpData.targetBusinessModel || icpData.target_business_model || icpData.businessModel || icpData.business_model || existingProfile?.targetBusinessModel,
      primaryRegions: icpData.primaryRegions || icpData.primary_regions || icpData.regions || icpData.geography_locations || icpData.geographyLocations || icpData.locations || existingProfile?.primaryRegions || [],
      primaryJobTitles: icpData.primaryJobTitles || icpData.primary_job_titles || icpData.jobTitles || icpData.job_titles || icpData.target_roles_titles || icpData.targetRolesTitles || icpData.roles || icpData.titles || existingProfile?.primaryJobTitles || [],
      budgetRange: icpData.budgetRange || icpData.budget_range || icpData.budget || existingProfile?.budgetRange,
      primaryChannels: icpData.primaryChannels || icpData.primary_channels || icpData.channels || icpData.sources || icpData.platforms || existingProfile?.primaryChannels || [],
      primaryValueProposition: icpData.primaryValueProposition || icpData.primary_value_proposition || icpData.valueProposition || icpData.value_proposition || existingProfile?.primaryValueProposition,
      primaryPainPoint: icpData.primaryPainPoint || icpData.primary_pain_point || icpData.painPoint || icpData.pain_point || icpData.painPoints?.[0] || icpData.pain_points?.[0] || existingProfile?.primaryPainPoint,
      businessId: existingProfile?.businessId,
    };

    // Ensure array fields are actually arrays (AI might return comma-separated strings)
    for (const key of ['primaryRegions', 'primaryJobTitles', 'primaryChannels'] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (icpToSave as any)[key] === 'string') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (icpToSave as any)[key] = ((icpToSave as any)[key] as string).split(',').map((s: string) => s.trim()).filter(Boolean);
      }
    }

    const enrichedIcp = await icpService.enrichAndScore(icpToSave);
    const icpId = await icpService.saveICP(userId, enrichedIcp, threadId);
    logger.info({ icpId, userId, threadId }, '[ICP Agent] Auto-saved ICP from response tags');

    // Emit ICP update + open tab via WebSocket
    webSocketEmitter.emit(userId, 'icp_update', {
      thread_id: threadId, icp_id: icpId, fit_score: enrichedIcp.fitScore,
      full_profile: {
        id: icpId, campaign_name: enrichedIcp.campaignName, target_audience: enrichedIcp.targetAudience,
        target_business_model: enrichedIcp.targetBusinessModel, industry: enrichedIcp.industry,
        sub_industry: enrichedIcp.subIndustry, geography_locations: enrichedIcp.primaryRegions,
        target_roles_titles: enrichedIcp.primaryJobTitles, target_company_size_range: enrichedIcp.targetCompanySizeRange,
        target_revenue_range: enrichedIcp.targetRevenueRange, primary_value_proposition: enrichedIcp.primaryValueProposition,
        primary_pain_point: enrichedIcp.primaryPainPoint, sources: enrichedIcp.primaryChannels,
        fit_score: enrichedIcp.fitScore, summary: enrichedIcp.summary,
      },
      summary: enrichedIcp.summary, status: 'completed',
    });
    webSocketEmitter.emit(userId, 'open_tab', {
      thread_id: threadId,
      tabType: TAB_TYPES.ICP, tabLabel: TAB_LABELS[TAB_TYPES.ICP],
      data: { icpId, fitScore: enrichedIcp.fitScore, campaignName: enrichedIcp.campaignName },
    });

    return { icpId, fitScore: enrichedIcp.fitScore, updatedProfile: { ...enrichedIcp, id: icpId } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, userId, threadId }, '[ICP Agent] Failed to auto-save ICP from response tags');
    return { updatedProfile: existingProfile };
  }
}

// ── OpenAI-format Tool Definitions ─────────────────────────────────────
// These match the exact schemas from langgraph/tools/index.ts but in
// OpenAI function calling format for direct use with the provider's
// chat.completions.create() API.

const OPENAI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'generate_icp',
      description: 'Generate an Ideal Customer Profile (ICP) based on user requirements. Use this when the user wants to define their target audience or start a new campaign.',
      parameters: {
        type: 'object',
        properties: {
          user_message: { type: 'string', description: "The user's message containing campaign requirements or target audience details." },
        },
        required: ['user_message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'crawl_website',
      description: 'Crawl a website URL to extract comprehensive business information from multiple pages. After crawling, IMMEDIATELY use the data to generate an ICP profile.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The website URL to crawl (e.g., https://example.com)' },
          extract_focus: { type: 'string', description: 'Optional focus area for extraction' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'save_business_profile',
      description: 'Save business profile information provided by the user during conversation.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string', description: 'The company/business name' },
          industry: { type: 'string', description: 'Industry the company operates in' },
          city: { type: 'string', description: 'City/location of the company' },
          country: { type: 'string', description: 'Country of the company' },
          description: { type: 'string', description: 'Brief description of what the company does' },
        },
        required: ['company_name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'suggest_switch_agents',
      description: 'After completing ICP generation, suggest the next agents the user should hire. Call this AFTER generate_icp succeeds to recommend lead_generation and content_studio as next steps.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'A helpful message explaining the next steps the user can take' },
          primary_agent: { type: 'string', enum: ['lead_generation', 'content_studio', 'outreach', 'performance_marketing'], description: 'The most important next agent' },
          alternative_agents: { type: 'array', items: { type: 'string', enum: ['lead_generation', 'content_studio', 'outreach', 'performance_marketing'] }, description: 'Other agents the user could choose' },
          reason: { type: 'string', description: 'Why these agents are recommended as next steps' },
        },
        required: ['message', 'primary_agent', 'reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_icp_profiles',
      description: 'Query existing Ideal Customer Profiles (ICPs) created by the user. Use this when the user asks about previously defined target audiences or campaign criteria.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text query to search ICPs by campaign name, industry, or target audience details.' },
          filters: {
            type: 'object',
            properties: {
              status: { type: 'string', description: 'Filter by status (e.g., active, archived).' },
              limit: { type: 'number', description: 'Maximum number of ICPs to return.' }
            }
          }
        }
      }
    }
  },
];

export const ICP_OPENAI_TOOL_NAMES = Object.freeze(
  OPENAI_TOOLS.map(tool => tool.function.name),
);

// ── callSuggestAgentsTool ─────────────────────────────────────────────
// Full suggest_agents flow: emits tool cards, runs executeSuggestAgents,
// emits suggestion chat message with hire buttons + opens AGENT_CHOOSE tab.
async function callSuggestAgentsTool(
  userId: number,
  threadId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icpProfile: Record<string, any>,
  fitScore: number,
  toolContext: ToolContext,
): Promise<void> {
  const suggestionResponseId = `icp-suggestion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // --- Tool call card ---
  const toolCallResponseId = `tool-call-suggest_agents-${Date.now()}`;
  webSocketEmitter.emitToolExecution(userId, threadId, {
    toolName: 'suggest_agents', args: { fitScore }, status: 'started', agentType: 'icp_generation',
  });
  try {
    const { createChatMessage } = await import('../../models/chatMessages/functions.js');
    await createChatMessage({
      userId, threadId, role: 'assistant', content: '🔧 suggest_agents', agentType: 'icp_generation',
      metadata: { isToolCall: true, toolName: 'suggest_agents', toolArgs: { fitScore }, responseId: toolCallResponseId },
    });
  } catch (e) { logger.warn({ err: e }, '[ICP Agent] Failed to log suggest_agents tool call'); }
  webSocketEmitter.emitChatResponse(userId, threadId, {
    role: 'assistant', content: '🔧 suggest_agents', agentType: 'icp_generation',
    metadata: { isToolCall: true, toolName: 'suggest_agents', toolArgs: { fitScore }, responseId: toolCallResponseId },
  });

  // --- Execute suggest_agents ---
  const startTime = Date.now();
  const { executeSuggestAgents } = await import('../tools/executors/icpExecutor.js');
  const suggestResult = await executeSuggestAgents({ icpProfile, fitScore }, toolContext);

  // --- Tool result card ---
  const toolResultResponseId = `tool-result-suggest_agents-${Date.now()}`;
  webSocketEmitter.emitToolExecution(userId, threadId, {
    toolName: 'suggest_agents', args: { fitScore },
    status: suggestResult.success ? 'completed' : 'failed',
    agentType: 'icp_generation', error: suggestResult.error,
    durationMs: Date.now() - startTime,
  });
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const resultMsg = suggestResult.success ? `✅ suggest_agents completed (${durationSec}s)` : `❌ suggest_agents failed (${durationSec}s)`;
  try {
    const { createChatMessage } = await import('../../models/chatMessages/functions.js');
    await createChatMessage({
      userId, threadId, role: 'assistant', content: resultMsg, agentType: 'icp_generation',
      metadata: {
        isToolResult: true, toolName: 'suggest_agents', success: suggestResult.success,
        toolArgs: { fitScore }, toolOutput: suggestResult.output ? { recommendedAgentKeys: suggestResult.output.recommendedAgentKeys } : undefined,
        responseId: toolResultResponseId,
      },
    });
  } catch (e) { logger.warn({ err: e }, '[ICP Agent] Failed to log suggest_agents tool result'); }
  webSocketEmitter.emitChatResponse(userId, threadId, {
    role: 'assistant', content: resultMsg, agentType: 'icp_generation',
    metadata: {
      isToolResult: true, toolName: 'suggest_agents', success: suggestResult.success,
      toolArgs: { fitScore }, toolOutput: suggestResult.output ? { recommendedAgentKeys: suggestResult.output.recommendedAgentKeys } : undefined,
      responseId: toolResultResponseId,
    },
  });

  if (!suggestResult.success || !suggestResult.output?.suggestionContent) return;

  // --- Suggestion chat message with hire buttons ---
  const hireButtons: ActionButton[] = suggestResult.output.hireButtons || [];

  webSocketEmitter.emitChatResponseChunk(userId, threadId, {
    responseId: suggestionResponseId, role: 'assistant', agentType: 'icp_generation',
    chunk: suggestResult.output.suggestionContent, sequence: 1, done: false,
    metadata: { responseId: suggestionResponseId },
  });
  webSocketEmitter.emitChatResponseChunk(userId, threadId, {
    responseId: suggestionResponseId, role: 'assistant', agentType: 'icp_generation',
    chunk: '', sequence: 2, done: true,
    metadata: { responseId: suggestionResponseId, actionButtons: hireButtons },
  });
  try {
    const { createChatMessage } = await import('../../models/chatMessages/functions.js');
    await createChatMessage({
      userId, threadId, role: 'assistant',
      content: suggestResult.output.suggestionContent, agentType: 'icp_generation',
      metadata: { responseId: suggestionResponseId, actionButtons: hireButtons, isSuggestionMessage: true },
    });
  } catch (e) { logger.error({ err: e }, '[ICP Agent] Failed to persist suggestion message'); }

  // --- Open AGENT_CHOOSE tab ---
  if (suggestResult.output.recommendedAgentScores) {
    webSocketEmitter.emit(userId, 'open_tab', {
      thread_id: threadId,
      tabType: TAB_TYPES.AGENT_CHOOSE, tabLabel: TAB_LABELS[TAB_TYPES.AGENT_CHOOSE],
      data: {
        recommendedAgentScores: suggestResult.output.recommendedAgentScores,
        agentDescriptions: suggestResult.output.agentDescriptions || {},
      },
    });
  }
}

// ── Agent Runner ───────────────────────────────────────────────────────

export async function runIcpAgent(state: AgentState): Promise<Partial<AgentState>> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { userId, threadId, llmConfig } = state;

  webSocketEmitter.emitAgentStatus(userId, 'icp_generation', 'thinking',
    'Analyzing your business profile...', undefined, threadId);

  // Get the last user message
  const lastMsg = [...state.messages].reverse().find(m => m.role === 'user');
  const userContent = lastMsg?.content || '';

  // Shared semantic decision can request continuation, never grant approval.
  const effectiveUserIntent = userContent || state.pipelineRequest || '';
  const isStartCampaign = state.intentAnalysis?.action === 'continue'
    && !state.intentAnalysis.needsClarification
    && isCurrentIcpRevisionApproved(state.icpProfile);
  if (isStartCampaign) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fitScore = (state.icpProfile as any).fitScore || 0;
    const icpProfile = state.icpProfile || {};

    const minimalToolContext: ToolContext = {
      userId, threadId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icpProfile: icpProfile as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      brandToolkit: state.brandToolkit as any,
      selectedWorkflows: state.selectedWorkflows,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conversationHistory: state.messages as any[],
      intentAnalysis: state.intentAnalysis,
    };

    // Call the full suggest_agents flow
    await callSuggestAgentsTool(userId, threadId, icpProfile, fitScore, minimalToolContext);

    webSocketEmitter.emitAgentStatus(userId, 'icp_generation', 'completed', 'Ready for next steps', undefined, threadId);

    return {
      messages: [{ role: 'assistant', content: '', agentType: 'icp_generation' }],
      icpProfile: state.icpProfile,
      currentAgent: 'icp_generation',
    };
  }

  // ── Build LLM provider and tool context ────────────────────────
  const toolContext: ToolContext = {
    userId,
    threadId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    icpProfile: state.icpProfile as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    brandToolkit: state.brandToolkit as any,
    selectedWorkflows: state.selectedWorkflows,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversationHistory: state.messages as any[],
    // generate_icp reuses this turn's routing decision instead of asking a
    // model to classify the same message again.
    intentAnalysis: state.intentAnalysis,
  };

  const systemPrompt = buildIcpSystemPrompt(state);

  // Build messages in OpenAI chat format
  const llmMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];
  // Same token-budgeted, receipt-compacting selection the other specialists
  // use, so a long campaign keeps its summary and whole recent turns instead of
  // an arbitrary last-20 slice that can exceed the model's context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const msg of prepareContextForAgent(state as any, 'icp_generation')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const role = typeof (msg as any).role === 'string' ? (msg as any).role as string : 'user';
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content) continue;
    llmMessages.push({ role: role === 'tool' ? 'assistant' : role, content });
  }
  if (llmMessages.length === 1) {
    for (const msg of state.messages.slice(-20)) {
      if (msg.role === 'system' || !msg.content) continue;
      llmMessages.push({ role: msg.role === 'tool' ? 'assistant' : (msg.role as string), content: msg.content });
    }
  }

  const responseId = `icp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    const allowedTools = state.intentAnalysis?.action === 'question'
      ? OPENAI_TOOLS.filter(tool => tool.function.name === 'query_icp_profiles')
      : OPENAI_TOOLS;
    logger.info({ messageCount: llmMessages.length, toolCount: allowedTools.length }, '[MastraICP] Calling LLM with tools');

    // Call LLM with tool definitions
    const llmResponse = await createCompletionWithProviderFallback(userId, {
      messages: llmMessages,
      temperature: 0.7,
      ...(allowedTools.length ? { tools: allowedTools, tool_choice: 'auto' } : {}),
      loggingContext: { userId, threadId, purpose: 'icp_generation', service: 'MastraICPAgent' },
    });

    // Extract content and tool calls from raw completion
    const choice = llmResponse.completion?.choices?.[0]?.message;
    const fullContent = choice?.content || '';
    const toolCalls = choice?.tool_calls || [];

    logger.info({ contentLength: fullContent.length, toolCallCount: toolCalls.length }, '[MastraICP] Response received');

    // ── Mutable state for tool results ──────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let updatedIcpProfile = state.icpProfile || {} as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = [];

    // ── Manual tool execution loop ──────────────────────────────
    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const fnName = toolCall.function?.name;
        if (!allowedTools.some(tool => tool.function.name === fnName)) {
          logger.warn({ toolName: fnName }, '[MastraICP] Ignored tool not allowed for this turn');
          continue;
        }
        const fnArgs = (() => {
          try { return JSON.parse(toolCall.function?.arguments || '{}'); }
          catch { return {}; }
        })();
        // Honour Stop and lost turn ownership before each billable action.
        await checkpointConversationRequest();

        if (fnName === 'generate_icp') {
          const toolStartTime = Date.now();
          webSocketEmitter.emitToolExecution(userId, threadId, {
            toolName: 'generate_icp', args: fnArgs,
            status: 'started', agentType: 'icp_generation',
          });

          // Persist tool call to chat history
          try {
            const { createChatMessage } = await import('../../models/chatMessages/functions.js');
            await createChatMessage({
              userId, threadId, role: 'assistant', content: '🔧 generate_icp', agentType: 'icp_generation',
              metadata: { isToolCall: true, toolName: 'generate_icp', toolArgs: fnArgs },
            });
            webSocketEmitter.emitChatResponse(userId, threadId, {
              role: 'assistant', content: '🔧 generate_icp', agentType: 'icp_generation',
              metadata: { isToolCall: true, toolName: 'generate_icp', toolArgs: fnArgs, responseId: `tool-call-generate_icp-${Date.now()}` },
            });
          } catch (e) { logger.error({ err: e, threadId }, '[MastraICP] Failed to persist tool call'); }

          const result = await executeGenerateIcp(fnArgs, toolContext);
          toolResults.push(result);

          const safeToolError = result.success ? undefined : toUserFacingError(result.error);
          webSocketEmitter.emitToolExecution(userId, threadId, {
            toolName: 'generate_icp', args: fnArgs,
            status: result.success ? 'completed' : 'failed', agentType: 'icp_generation',
            error: safeToolError, durationMs: Date.now() - toolStartTime,
          });

          // Persist tool result
          try {
            const { createChatMessage } = await import('../../models/chatMessages/functions.js');
            const dur = ((Date.now() - toolStartTime) / 1000).toFixed(1);
            const resultContent = result.success ? `✅ generate_icp completed (${dur}s)` : `❌ generate_icp failed (${dur}s)`;
            const fitScore = result.output?.fitScore || 0;
            const actionBtns: ActionButton[] = [];
            if (result.success) {
              if (fitScore >= 50) {
                actionBtns.push({ id: 'improve_icp', label: 'Improve ICP', action: 'IMPROVE_ICP', type: 'secondary' });
                actionBtns.push({ id: 'start_campaign', label: 'Start Campaign', action: 'START_CAMPAIGN', type: 'primary' });
              } else if (fitScore > 0) {
                actionBtns.push({ id: 'improve_icp', label: 'Improve ICP', action: 'IMPROVE_ICP', type: 'primary' });
              }
            }
            await createChatMessage({
              userId, threadId, role: 'assistant', content: resultContent, agentType: 'icp_generation',
              metadata: { isToolResult: true, toolName: 'generate_icp', success: result.success, error: safeToolError, toolArgs: fnArgs, toolOutput: result.output, actionButtons: actionBtns, fitScore },
            });
            webSocketEmitter.emitChatResponse(userId, threadId, {
              role: 'assistant', content: resultContent, agentType: 'icp_generation',
              metadata: { isToolResult: true, toolName: 'generate_icp', success: result.success, error: safeToolError, toolArgs: fnArgs, toolOutput: result.output, responseId: `tool-result-generate_icp-${Date.now()}`, actionButtons: actionBtns, fitScore },
            });
          } catch (e) { logger.error({ err: e, threadId }, '[MastraICP] Failed to persist tool result'); }

          if (result.success && result.output) {
            const icpData = result.output.icp || result.output.partialICP;
            if (icpData) {
              updatedIcpProfile = { ...icpData, id: result.output.icpId || icpData.id, fitScore: result.output.fitScore || icpData.fitScore };
            }
          }
        } else if (fnName === 'crawl_website') {
          const crawlStartTime = Date.now();

          webSocketEmitter.emitToolExecution(userId, threadId, {
            toolName: 'crawl_website', args: fnArgs, status: 'started', agentType: 'icp_generation',
          });

          const crawlResult = await executeCrawlWebsite(fnArgs, toolContext);
          toolResults.push(crawlResult);

          webSocketEmitter.emitToolExecution(userId, threadId, {
            toolName: 'crawl_website', args: fnArgs,
            status: crawlResult.success ? 'completed' : 'failed',
            agentType: 'icp_generation', error: crawlResult.error,
            durationMs: Date.now() - crawlStartTime,
          });

          // Persist crawl tool messages
          try {
            const { createChatMessage } = await import('../../models/chatMessages/functions.js');
            await createChatMessage({
              userId, threadId, role: 'assistant', content: '🔧 crawl_website', agentType: 'icp_generation',
              metadata: { isToolCall: true, toolName: 'crawl_website', toolArgs: fnArgs },
            });
            webSocketEmitter.emitChatResponse(userId, threadId, {
              role: 'assistant', content: '🔧 crawl_website', agentType: 'icp_generation',
              metadata: { isToolCall: true, toolName: 'crawl_website', toolArgs: fnArgs, responseId: `tool-call-crawl_website-${Date.now()}` },
            });
            const crawlDur = ((Date.now() - crawlStartTime) / 1000).toFixed(1);
            const crawlResultContent = crawlResult.success
              ? `✅ crawl_website completed (${crawlDur}s) — ${crawlResult.output?.pagesExtracted || 0} page(s) crawled`
              : `❌ crawl_website failed (${crawlDur}s)`;
            await createChatMessage({
              userId, threadId, role: 'assistant', content: crawlResultContent, agentType: 'icp_generation',
              metadata: { isToolResult: true, toolName: 'crawl_website', success: crawlResult.success, toolArgs: fnArgs, toolOutput: crawlResult.output ? { pagesExtracted: crawlResult.output.pagesExtracted, contentLength: crawlResult.output.websiteContent?.length } : undefined },
            });
            webSocketEmitter.emitChatResponse(userId, threadId, {
              role: 'assistant', content: crawlResultContent, agentType: 'icp_generation',
              metadata: { isToolResult: true, toolName: 'crawl_website', success: crawlResult.success, toolArgs: fnArgs, responseId: `tool-result-crawl_website-${Date.now()}` },
            });
          } catch (e) { logger.error({ err: e, threadId }, '[MastraICP] Failed to persist crawl tool messages'); }

          if (crawlResult.success && crawlResult.output?.websiteContent) {
            logger.info({ contentLength: crawlResult.output.websiteContent.length, pages: crawlResult.output.pagesExtracted }, '[MastraICP] Website crawl successful');

            // Emit a natural language summary of the crawled website
            // Also store it for use in the auto-chain ICP generation
            try {
              const crawlSummaryResp = await createCompletionWithProviderFallback(userId, {
                messages: [
                  { role: 'system', content: 'You are a business analyst. Write a brief 2-3 sentence summary of what this business does based on the crawled website data. Be concise and informative. Start with the company name if found.' },
                  { role: 'user', content: `Website: ${fnArgs.url}\nPages crawled: ${crawlResult.output.pagesExtracted || 1}\n\nContent:\n${crawlResult.output.websiteContent.substring(0, 3000)}` },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ] as any,
                temperature: 0.3,
                max_tokens: 200,
                loggingContext: { userId, threadId, purpose: 'crawl_summary', service: 'MastraICPAgent' },
              });
              const crawlSummaryText = crawlSummaryResp.content?.trim();
              if (crawlSummaryText) {
                // Store summary for auto-chain use
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (crawlResult as any)._summary = crawlSummaryText;

                const crawlSummaryId = `icp-crawl-summary-${Date.now()}`;
                const pagesCount = crawlResult.output.pagesExtracted || 1;
                const crawlSummaryContent = `🌐 **Website Analysis** (${pagesCount} page${pagesCount > 1 ? 's' : ''} crawled)\n\n${crawlSummaryText}\n\nNow generating your ICP profile based on this data...`;
                webSocketEmitter.emitChatResponseChunk(userId, threadId, {
                  responseId: crawlSummaryId, role: 'assistant', agentType: 'icp_generation',
                  chunk: crawlSummaryContent, sequence: 1, done: false,
                });
                webSocketEmitter.emitChatResponseChunk(userId, threadId, {
                  responseId: crawlSummaryId, role: 'assistant', agentType: 'icp_generation',
                  chunk: '', sequence: 2, done: true,
                });
                const { createChatMessage: createMsg } = await import('../../models/chatMessages/functions.js');
                await createMsg({
                  userId, threadId, role: 'assistant', content: crawlSummaryContent, agentType: 'icp_generation',
                  metadata: { isCrawlSummary: true, url: fnArgs.url, pagesExtracted: pagesCount },
                });
              }
            } catch (summaryErr) {
              logger.warn({ err: summaryErr }, '[MastraICP] Failed to generate crawl summary');
            }
          }
        } else if (fnName === 'save_business_profile') {
          // Handle save_business_profile tool
          try {
            const { executeSaveBusinessProfile } = await import('../tools/executors/icpExecutor.js');
            const result = await executeSaveBusinessProfile(fnArgs, toolContext);
            toolResults.push(result);
            logger.info({ success: result.success }, '[MastraICP] save_business_profile executed');
          } catch (e) { logger.warn({ err: e }, '[MastraICP] save_business_profile failed'); }
        } else if (fnName === 'suggest_switch_agents') {
          // Return as a tool result so the orchestrator converts it to action buttons
          toolResults.push({
            success: true,
            toolName: 'suggest_switch_agents' as const,
            output: {
              message: fnArgs.message || 'Here are the recommended next steps:',
              primary_agent: fnArgs.primary_agent,
              alternative_agents: fnArgs.alternative_agents || [],
              reason: fnArgs.reason || 'Next steps after ICP generation',
            },
          });
          logger.info({ primary: fnArgs.primary_agent, alternatives: fnArgs.alternative_agents }, '[MastraICP] suggest_switch_agents captured');
        } else if (fnName === 'query_icp_profiles') {
          try {
            const { executeQueryIcpProfiles } = await import('../tools/executors/dataQueryExecutor.js');
            const result = await executeQueryIcpProfiles(fnArgs, toolContext);
            toolResults.push(result);
            logger.info({ success: result.success }, '[MastraICP] query_icp_profiles executed');
          } catch (e) { logger.warn({ err: e }, '[MastraICP] query_icp_profiles failed'); }
        }
      }

      // ── Auto-chain: crawl_website → generate_icp ──────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const crawlResults = toolResults.filter((r: any) => r.toolName === 'crawl_website' && r.success && r.output?.websiteContent);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generateIcpAlreadyCalled = toolResults.some((r: any) => r.toolName === 'generate_icp');

      if (crawlResults.length > 0 && !generateIcpAlreadyCalled) {
        logger.info('[MastraICP] Auto-chaining: crawl_website → generate_icp');
        await checkpointConversationRequest();

        // Prefer the LLM-generated crawl summary (concise, focused) over raw website content
        // to avoid overwhelming smaller LLM models with 10KB+ of raw HTML/text
        const crawlSummary = crawlResults[0]._summary || '';
        const MAX_RAW_CHARS = 3000; // reduced from 10000 — summary carries the key info
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawWebsiteData = crawlResults.map((r: any) => (r.output.websiteContent || '').substring(0, 2000)).join('\n---\n').substring(0, MAX_RAW_CHARS);
        const crawlUrl = crawlResults[0].output.url;

        webSocketEmitter.emitAgentStatus(userId, 'icp_generation', 'thinking', 'Generating ICP profile from website data...', undefined, threadId);

        // Use summary as primary context, raw data as supplementary
        const websiteContext = crawlSummary
          ? `Website summary:\n${crawlSummary}\n\nRaw website data (supplementary):\n${rawWebsiteData}`
          : `Website data from ${crawlUrl}:\n${rawWebsiteData}`;

        const autoMsg = `User campaign request (highest priority):\n${effectiveUserIntent || 'No explicit request provided.'}\n\nUse the website data below only as supporting context to enrich the ICP. Do not replace or change the user intent based on crawl content.\n\n${websiteContext}\n\nIMPORTANT: You MUST populate ALL fields in your JSON response including sources, geography_locations, target_roles_titles, campaign_name, and campaign_objective. Infer them from the user's request and website data.`;

        const autoStartTime = Date.now();
        webSocketEmitter.emitToolExecution(userId, threadId, {
          toolName: 'generate_icp', args: { source: 'auto_from_crawl', url: crawlUrl }, status: 'started', agentType: 'icp_generation',
        });

        // Emit tool call card
        try {
          const { createChatMessage } = await import('../../models/chatMessages/functions.js');
          await createChatMessage({
            userId, threadId, role: 'assistant', content: '🔧 generate_icp', agentType: 'icp_generation',
            metadata: { isToolCall: true, toolName: 'generate_icp', toolArgs: { source: 'auto_from_crawl', url: crawlUrl } },
          });
          webSocketEmitter.emitChatResponse(userId, threadId, {
            role: 'assistant', content: '🔧 generate_icp', agentType: 'icp_generation',
            metadata: { isToolCall: true, toolName: 'generate_icp', toolArgs: { source: 'auto_from_crawl', url: crawlUrl }, responseId: `tool-call-generate_icp-${Date.now()}` },
          });
        } catch (e) { logger.error({ err: e, threadId }, '[MastraICP] Failed to persist tool receipt'); }

        const autoResult = await executeGenerateIcp({ user_message: autoMsg }, toolContext);
        toolResults.push(autoResult);

        const autoGenDur = ((Date.now() - autoStartTime) / 1000).toFixed(1);
        const safeAutoError = autoResult.success ? undefined : toUserFacingError(autoResult.error);
        webSocketEmitter.emitToolExecution(userId, threadId, {
          toolName: 'generate_icp', args: { source: 'auto_from_crawl', url: crawlUrl },
          status: autoResult.success ? 'completed' : 'failed', agentType: 'icp_generation',
          error: safeAutoError, durationMs: Date.now() - autoStartTime,
        });

        // Emit tool result card
        try {
          const { createChatMessage } = await import('../../models/chatMessages/functions.js');
          const fitScore = autoResult.output?.fitScore || 0;
          const autoGenResult = autoResult.success
            ? `✅ generate_icp completed (${autoGenDur}s) — ICP profile created with ${fitScore}% fit score`
            : `❌ generate_icp failed (${autoGenDur}s)`;
          const actionBtns = autoResult.success ? determineActionButtons(autoResult.output?.icp || autoResult.output?.partialICP) : [];
          await createChatMessage({
            userId, threadId, role: 'assistant', content: autoGenResult, agentType: 'icp_generation',
            metadata: { isToolResult: true, toolName: 'generate_icp', success: autoResult.success, toolArgs: { source: 'auto_from_crawl', url: crawlUrl }, toolOutput: autoResult.output, actionButtons: actionBtns, fitScore },
          });
          webSocketEmitter.emitChatResponse(userId, threadId, {
            role: 'assistant', content: autoGenResult, agentType: 'icp_generation',
            metadata: { isToolResult: true, toolName: 'generate_icp', success: autoResult.success, error: safeAutoError, toolArgs: { source: 'auto_from_crawl', url: crawlUrl }, toolOutput: autoResult.output, responseId: `tool-result-generate_icp-${Date.now()}`, actionButtons: actionBtns, fitScore },
          });
        } catch (e) { logger.error({ err: e, threadId }, '[MastraICP] Failed to persist tool receipt'); }

        if (autoResult.success && autoResult.output) {
          const icpData = autoResult.output.icp || autoResult.output.partialICP;
          if (icpData) {
            updatedIcpProfile = { ...icpData, id: autoResult.output.icpId || icpData.id, fitScore: autoResult.output.fitScore || icpData.fitScore };
          }
        }
      }

      // ── Generate follow-up response ───────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generateIcpToolResult = toolResults.find((r: any) => r.toolName === 'generate_icp' && r.success && r.output?.response);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const failedGenerateIcpResult = toolResults.find((r: any) => r.toolName === 'generate_icp' && !r.success);
      const followUpResponseId = `icp-followup-${Date.now()}`;

      let followUpContent: string;
      if (failedGenerateIcpResult) {
        followUpContent = isProviderInfrastructureError(failedGenerateIcpResult.error)
          ? `I couldn't create the ICP profile because ${AI_SERVICE_UNAVAILABLE_MESSAGE.toLowerCase()}`
          : `I couldn't create the ICP profile. ${toUserFacingError(failedGenerateIcpResult.error)}`;
      } else if (generateIcpToolResult) {
        followUpContent = generateIcpToolResult.output.response as string;
      } else {
        // Ask LLM for follow-up
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolResultSummary = toolResults.map((r: any) =>
          r.success ? r.output?.message || 'Tool executed successfully' : `Error: ${r.error}`
        ).join('\n');

        const followUpMessages: Array<{ role: string; content: string }> = [
          { role: 'system', content: systemPrompt },
          ...llmMessages.slice(1), // conversation messages
          { role: 'assistant', content: `[Tool Results]\n${toolResultSummary}` },
          { role: 'user', content: `The ICP has been saved. The fit score is ${updatedIcpProfile?.fitScore || 0}%. Write 1-2 sentences acknowledging this. Do NOT list ICP fields.` },
        ];
        const followUpResp = await createCompletionWithProviderFallback(userId, {
          messages: followUpMessages,
          temperature: 0.7,
          loggingContext: { userId, threadId, purpose: 'icp_followup', service: 'MastraICPAgent' },
        });
        followUpContent = followUpResp.content || '';
      }

      followUpContent = cleanResponseText(followUpContent);

      // Parse <icp_data> from follow-up text and auto-save if tool didn't already save
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generateIcpAlreadySaved = toolResults.some((r: any) => r.toolName === 'generate_icp' && r.success && r.output?.icpId);
      const extractedIcpData = parseIcpDataFromResponse(followUpContent);
      if (extractedIcpData && !generateIcpAlreadySaved && state.intentAnalysis?.action !== 'question') {
        const autoSaveResult = await autoSaveIcpFromResponse(extractedIcpData, userId, threadId, updatedIcpProfile);
        if (autoSaveResult.icpId) {
          updatedIcpProfile = autoSaveResult.updatedProfile;
        }
      }

      const actionButtons = state.intentAnalysis?.action === 'question' ? [] : determineActionButtons(updatedIcpProfile);

      // Emit follow-up in two chunks (content + done signal)
      webSocketEmitter.emitChatResponseChunk(userId, threadId, {
        responseId: followUpResponseId, role: 'assistant', agentType: 'icp_generation',
        chunk: followUpContent, sequence: 1, done: false,
        metadata: { responseId: followUpResponseId },
      });
      webSocketEmitter.emitChatResponseChunk(userId, threadId, {
        responseId: followUpResponseId, role: 'assistant', agentType: 'icp_generation',
        chunk: '', sequence: 2, done: true,
        metadata: { responseId: followUpResponseId, actionButtons, fitScore: updatedIcpProfile?.fitScore || 0 },
      });

      webSocketEmitter.emitAgentStatus(userId, 'icp_generation', 'completed', 'Analysis complete', undefined, threadId);

      return {
        messages: [{ role: 'assistant', content: followUpContent, agentType: 'icp_generation' }],
        icpProfile: updatedIcpProfile,
        currentAgent: 'icp_generation',
        actionButtons,
        toolResults: toolResults.map((result) => ({
          ...result,
          ...(result.error ? { error: toUserFacingError(result.error) } : {}),
        })),
        ...(failedGenerateIcpResult ? {
          workflowOutcome: 'failed' as const,
          error: toUserFacingError(failedGenerateIcpResult.error),
        } : {}),
        lastResponseId: followUpResponseId,
      };
    }

    // ── No tool calls — plain text response ─────────────────────
    const cleanedContent = cleanResponseText(fullContent);

    // Parse <icp_data> from response text and auto-save
    const extractedIcpData = parseIcpDataFromResponse(fullContent);
    if (extractedIcpData && state.intentAnalysis?.action !== 'question') {
      const autoSaveResult = await autoSaveIcpFromResponse(extractedIcpData, userId, threadId, updatedIcpProfile);
      if (autoSaveResult.icpId) {
        updatedIcpProfile = autoSaveResult.updatedProfile;
      }
    }

    const actionButtons = state.intentAnalysis?.action === 'question' ? [] : determineActionButtons(updatedIcpProfile);

    let finalResponseId = responseId;
    if (cleanedContent) {
      finalResponseId = emitFinalResponse(userId, threadId, cleanedContent, 'icp_generation', actionButtons, updatedIcpProfile) || responseId;
    }

    webSocketEmitter.emitAgentStatus(userId, 'icp_generation', 'completed', 'Analysis complete', undefined, threadId);

    return {
      messages: [{ role: 'assistant', content: cleanedContent, agentType: 'icp_generation' }],
      icpProfile: updatedIcpProfile,
      currentAgent: 'icp_generation',
      actionButtons,
      lastResponseId: finalResponseId,
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    // Stop/ownership loss must reach the request coordinator, not be reported
    // to the user as an AI outage.
    if (error instanceof ConversationRequestError) throw error;
    const providerFailure = isProviderResponseError(error);
    const failure = providerFailure ? classifyLLMProviderFailure(error) : undefined;
    logger.error({
      errorType: error instanceof Error ? error.name : typeof error,
      ...(providerFailure ? {
        provider: error.provider,
        failureCategory: failure?.category,
        failureStatus: failure?.status,
      } : {}),
    }, '[MastraICP] Agent execution failed');

    const errorMsg = providerFailure
      ? safeLLMProviderFailureMessage(error, error.provider)
      : "I couldn't analyze the profile because the AI service is temporarily unavailable. Please try again shortly. If it continues, ask an administrator to verify the configured AI providers.";
    emitFinalResponse(userId, threadId, errorMsg, 'icp_generation', [], state.icpProfile);

    return {
      messages: [{ role: 'assistant', content: errorMsg, agentType: 'icp_generation' }],
      currentAgent: 'icp_generation',
      error: errorMsg,
      tasksCompleted: false,
      workflowOutcome: 'failed',
    };
  }
}

// ── WebSocket Helpers ──────────────────────────────────────────────────

function emitFinalResponse(
  userId: number,
  threadId: number,
  content: string,
  agentType: string,
  actionButtons: ActionButton[],
  icpProfile: ICPProfile | null,
): string {
  if (!content?.trim()) return '';
  const responseId = `${agentType}-${Date.now()}`;
  webSocketEmitter.emitChatResponseChunk(userId, threadId, {
    chunk: content,
    sequence: 1,
    done: false,
    role: 'assistant',
    agentType,
    responseId,
  });
  webSocketEmitter.emitChatResponseChunk(userId, threadId, {
    chunk: '',
    sequence: 2,
    done: true,
    role: 'assistant',
    agentType,
    responseId,
    metadata: {
      actionButtons,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...((icpProfile as any)?.fitScore != null ? { fitScore: (icpProfile as any).fitScore } : {}),
    },
  });
  return responseId;
}

/** Re-export isIcpComplete from original */
export { isIcpComplete } from '../approvalHandlers.js';
