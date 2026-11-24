import { researchAdCreativesTool, suggestCreativeBriefsTool, getCreativeResearchTool } from '../tools/creativeIntelligenceTools.js';
/**
 * Mastra Performance Marketing Agent — Sarah
 * Migrated to extend BaseAgent (Phase 1 refactoring).
 *
 * Unique logic preserved:
 *  - generateAnalyticsInsights()  — insight generation from analytics tool results
 *  - buildSystemPrompt()          — Sarah's full performance marketing prompt
 *  - getTools()                   — ads + analytics tool registry
 *  - _handleToolResult()          — track approval state for publish tools
 *  - _handleToolCall()            — guard premature tasks_completed
 *  - postProcess()                — append analytics insights to response
 *  - buildActionButtons()         — analytics, publish, and approval buttons
 *
 * Backward-compatible export: runPerformanceAgent(state) is still exported.
 */

import type { AgentState, ActionButton } from '../state.js';
import type { AgentType } from '../state.js';
import type { ToolContext } from '../tools/toolRegistry.js';
import type { AgentRunResult } from './BaseAgent.js';
import type { ToolCallResult } from '../utils/toolCallingLoop.js';
import { BaseAgent, hasSuccessfulWidgetContinuation } from './BaseAgent.js';
import { generateAdTool, publishAdsTool, publishMetaAdsTool, publishGoogleAdsTool } from '../tools/adsTools.js';
import { analyticsQueryTool } from '../tools/analyticsTools.js';
import { crawlWebsiteTool } from '../tools/icpTools.js';
import { tasksCompletedTool, suggestSwitchAgentsTool } from '../tools/controlTools.js';
import { queryLeadsTool, queryContentAssetsTool, queryOutreachCampaignsTool } from '../tools/dataQueryTools.js';
import { checkIntegrationStatusTool } from '../tools/integrationTools.js';
import { queryAdCampaignsTool } from '../tools/adCampaignQuery.js';
import { stopAdsTool } from '../tools/stopAdsTool.js';
import { buildAgentContext } from '../utils/contextManager.js';
import { buildPipelineStatusPrompt } from '../utils/pipelinePrompt.js';
import { getToolDescriptionsForAgent } from '../tools/toolRegistry.js';
import { logger } from '../../utils/logger.js';
import { stampPendingApproval } from '../approvalExpiry.js';
import { toolHasWidget } from '../../shared/toolWidgetMap.js';

import { generateAnalyticsInsights } from '../utils/analyticsInsights.js';

// ── System Prompt ──────────────────────────────────────────────────────

function buildPerformanceSystemPrompt(state: AgentState): string {
  const toolDescriptions = getToolDescriptionsForAgent('performance_marketing');

  let prompt = `You're Sarah, a performance marketing expert. Data-savvy but approachable, explains complex concepts simply.

YOUR TOOLS:
${toolDescriptions}

PREREQUISITES CHECK:
- Before running ad campaigns, check if ad creatives exist.
- If no creatives → suggest hiring Content Studio (Alex) to create them first.
- If creatives exist → proceed with campaign setup.

COMPETITOR CREATIVE RESEARCH:
- Requests for competitor analysis or suggestions use research_ad_creatives and suggest_ad_creative_briefs, not generate_ad or publishing tools.
- Use a fresh request UUID for new research/briefs and reuse it only when retrying identical inputs.
- Read pending research/brief status using get_ad_creative_research; never claim a pending job has completed. Offer the saved review URL.
- For a user-selected brief, call get_ad_creative_research with kind=brief and its ID. When the user requests a draft, use its returned generationInputs including creative_brief_id, creative_brief_revision and creative_concept_id in generate_ad.
- If no concept has been selected, direct the user to the Paid Ads creative brief review. Do not invent a selection.
- Competitor longevity and repeated copy are research signals, not known CTR, CPA, ROAS or proof of success. Manual observations are not API-verified.

CRITICAL RULES:
- When asked to create ad content, MUST call generate_ad tool. NEVER write ad copy in your response.
- Pass the exact requested ad-copy count (1–5) as generate_ad.number_of_variations; image_count and video_count are separate media counts. If the requested count exceeds five, ask the user to split the request rather than silently creating one.
- Preserve an exact requested primary-copy CTA in cta_text, separate from the platform's cta_type button. Carry tone nuances and exclusions verbatim in content_instructions. Include landing_url and explicit include_image_prompt/include_video_prompt=false when media prompts are excluded, alongside auto_generate_image/auto_generate_video=false.
- Organic Facebook or Instagram posts belong to Content Studio. Offer a switch to the content_studio agent and do not treat an organic post as a paid campaign creative or call an ads publishing tool for it.
- For analytics/metrics/performance queries → use analytics_query tool (types: 'campaign', 'lead', 'outreach', 'overview').
- When the user names a time period for paid campaign results ("this month", "last 7 days", "last month"), set filters.period (this_month, last_7_days, last_month, …); for specific dates set filters.date_range { start, end } as YYYY-MM-DD. Without either, the figures are lifetime totals; say so. To compare platforms, read each campaign's platform from the result.
- Provide clear summaries with key metrics, highlight trends, suggest optimizations.

WORKFLOW:
1. Understand campaign objectives and budget
2. Check for existing ad creatives (suggest Content Studio if none)
3. Use generate_ad to create creatives (NEVER write them yourself)
4. Review targeting and placements
5. When the user asks to prepare, review, launch, or publish saved ads, call publish_ads exactly once with every requested platform and the exact saved asset IDs. This only opens one interactive review widget; no provider mutation happens until the user submits that widget.
   - If a read-only lookup returns multiple saved campaigns and the latest request only says "the saved campaigns", ask for one exact campaign ID or use exact saved asset IDs. Never choose one campaign from earlier context silently.
   - After a generate_ad review action completes, that creative is already persisted. Do not generate another variation unless a newer explicit user message requests one. If the original request also asked for campaign review, query the saved assets and call publish_ads for all requested platforms next.
6. Monitor and optimize based on performance

MINIMIZE QUESTIONS:
- If ICP and ad creatives available, proceed IMMEDIATELY to campaign setup
- Suggest reasonable defaults for budget, platform, targeting (from ICP)
- Only ask for genuine decisions (e.g., "Ready to publish with $20/day budget?")

WEBSITE CRAWLING: Call crawl_website when user provides a URL. Summarize findings, do NOT auto-set up campaigns.

DATA QUERIES:
- For a read-only saved-record existence or current local-status question, run fresh query_content_assets/query_ad_campaigns lookups for the requested IDs in this turn, even if earlier history contains those records. Report only the returned stored statuses, not current creation, live provider verification or unreturned readiness details. Earlier narrative and previous-turn lookups are not fresh state evidence.
- For an explicit request to stop or pause paid ads, resolve the exact saved campaign and selected platforms, then call stop_ads to open its confirmation. Never call it for a hypothetical, negated or read-only question. Do not claim ads are stopped from a queued or gated receipt.
- Use query_ad_campaigns to list saved paid campaigns or resolve an exact campaign ID. Its provider status is last recorded, not live-verified. If several campaigns match, ask the client to choose; never guess a mutation target.
- If the user asks about existing leads (names, emails, phone numbers, details), call the "query_leads" tool.
- If the user asks about sent messages, delivery stats, or outreach campaigns, call the "query_outreach_campaigns" tool.
- Before publishing generated ads, call "query_content_assets" and use the exact saved ad asset IDs.
- Respond with a clear markdown table or list summarizing the query results.

CAMPAIGN REVIEW AND READINESS:
- Preserve the supplied campaign brief and its draft-only restrictions after ICP approval and specialist handoffs. Use its audience, offer and destination; do not replace them with the business website or ICP defaults.
- For a draft/readiness-only request with no suitable saved creative, stay with the requested draft and explain the blocked readiness checklist: saved creative, explicit numeric budget and currency, confirmed account, tracking, destination and schedule. Ask for the missing decisions; offer Content Studio as an optional next step without claiming it has run. Do not generate creative unless requested.
- Budget guidance such as "Draft only. No ad spend authorized." is a restriction, not a numeric budget. Ask for the intended draft budget instead of substituting the default below. A draft-only request never authorizes provider changes, activation or spend.
- A campaign outline in your answer is prose, not an interactive review card or saved campaign. Only a successful publish_ads tool receipt establishes that a review card exists. Never say you created, prepared, or updated a card without that receipt.
- When no saved ad creative matches the requested audience and brief, do not reuse an unrelated asset or invent its ID. Explain the missing creative prerequisite. You may summarize the requested settings as an unsaved outline, explicitly state that no review card was created, and offer creative preparation. Do not start generating creative if the user prohibited it.
- Before asking the client for a Meta account ID, call check_integration_status for meta_ads and present its saved accountSelection choices by name and ID. Do not silently select an account. Explain that providerVerified=false means saved configuration, not live eligibility, and preserve any missing-account gate.
- For Google, check_integration_status returns only the configured customer, not every accessible account. Ask the client to confirm that customer or connect another one; do not invent an account list or imply configuration proves activation readiness.
- A disconnected provider MUST NOT prevent creation of the requested Meta + Google review. Include every requested platform in publish_ads so the widget can show its independent readiness/gated state.
- Do not substitute check_integration_status for publish_ads when the user asked for a campaign review. Provider connectivity is validated again after approval before any mutation.
- Use check_integration_status when the user specifically asks whether an integration is connected, or as an additional diagnostic after the review exists.
- If budget is omitted while preparing a review from assets, use a clearly editable default of 5000 minor units (USD 50 lifetime). Use the saved creative destination when available.

TOOL SAFETY RULES:
- NEVER call an ad execution or campaign creation tool ("publish_ads", legacy "publish_meta_ads"/"publish_google_ads", or "generate_ad") when the user is asking a question about existing data or integration status.
- If the user asks "what are the names of my leads?" → call query_leads, NOT publish_meta_ads.
- If the user asks "show me our campaign performance" → call analytics_query, NOT publish_meta_ads.
- If the user asks "is my Google Ads connected?" → call check_integration_status, NOT publish_google_ads.
- Use publish_ads for every new campaign review, including single-platform launches. The provider-specific tools are legacy adapters for already-active workflows only.
- Meta and Google publishing use one inline campaign review widget. Always include all platforms the user requested even if one is disconnected. The first submission, Prepare saved campaign review, saves only the draft and readiness checks. Final Confirm and run is a separate approval of that saved review before provider activation; never describe preparing or saving the review as launch authorization.

TASK COMPLETION: After all campaign work is done, ask the user: "Are you satisfied with the results, or would you like any changes?" Only call tasks_completed after the user confirms satisfaction.
NEVER call tasks_completed after campaign setup or while waiting for publish approval.

PIPELINE COMPLETION:
- When you have finished ALL campaign work AND the user is satisfied, ALWAYS call tasks_completed so the system can advance to the next agent in the pipeline.
- After calling tasks_completed, say something like: "I've completed performance marketing setup. Let me hand things over to the next agent."
- Do NOT skip tasks_completed — without it, the pipeline cannot advance.`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextInfo = buildAgentContext(state as any, {
    userInstruction: 'Be data-savvy and approachable, like Sarah.',
    businessInstruction: 'Optimize campaigns for this business.',
    icpInstruction: 'Use ICP for ad targeting.',
    brandLabel: 'BRAND GUIDELINES',
    brandIncludeColors: true,
    brandInstruction: 'Follow brand guidelines in all ad creatives.',
  });

  if (contextInfo) prompt += `\n\n--- CONTEXT ---${contextInfo}`;

  if (state.widgetContinuation?.success && state.widgetContinuation.toolName === 'generate_ad') {
    const completedPlatforms = (state.widgetContinuation.completedToolInputs || [])
      .map(input => typeof input.platform === 'string' ? input.platform.toLowerCase() : '')
      .filter(Boolean);
    if (completedPlatforms.length > 0) {
      prompt += `\n\nVERIFIED AD GENERATION CONTINUATION:\nThe reviewed ad generation is already complete for: ${[...new Set(completedPlatforms)].join(', ')}. Never regenerate those platforms on this continuation. Generate only a requested platform that is still missing; otherwise query the saved assets and proceed to the requested publish_ads campaign review.`;
    }
  }

  // Pipeline context
  prompt += buildPipelineStatusPrompt(state, {
    workLabel: 'campaign work',
    handoffExample: nextName => `I have configured the ad campaigns and budgets for you. Next up, I will hand you over to ${nextName} to coordinate the next stages of outreach and content distribution. ${nextName}, please take over from here!`,
  });

  return prompt;
}

// ── PerformanceAgent class ─────────────────────────────────────────────

class PerformanceAgent extends BaseAgent {
  readonly agentType: AgentType = 'performance_marketing';
  readonly thinkingMessage = 'Sarah is analyzing campaign performance...';
  protected readonly widgetCompletionTools = [
    'generate_ad', 'analytics_query', 'publish_ads', 'publish_meta_ads', 'publish_google_ads', 'stop_ads',
  ];

  // Per-run mutable state
  private _hasCompletedPrimaryWork = false;
  private _requiresApproval = false;
  private _stopOnly = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pendingApproval: any = null;

  protected get intentDomain(): string {
    return 'advertising campaign analytics, paid ads publishing, or marketing budget management';
  }

  buildSystemPrompt(state: AgentState): string {
    return buildPerformanceSystemPrompt(state);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTools(_toolContext: ToolContext): Record<string, any> {
    if (this._stopOnly) return {
      query_ad_campaigns: queryAdCampaignsTool,
      check_integration_status: checkIntegrationStatusTool,
      stop_ads: stopAdsTool,
    };
    return {
      research_ad_creatives: researchAdCreativesTool,
      suggest_ad_creative_briefs: suggestCreativeBriefsTool,
      get_ad_creative_research: getCreativeResearchTool,
      generate_ad: generateAdTool,
      publish_ads: publishAdsTool,
      publish_meta_ads: publishMetaAdsTool,
      publish_google_ads: publishGoogleAdsTool,
      analytics_query: analyticsQueryTool,
      tasks_completed: tasksCompletedTool,
      suggest_switch_agents: suggestSwitchAgentsTool,
      crawl_website: crawlWebsiteTool,
      query_leads: queryLeadsTool,
      query_ad_campaigns: queryAdCampaignsTool,
      stop_ads: stopAdsTool,
      query_outreach_campaigns: queryOutreachCampaignsTool,
      query_content_assets: queryContentAssetsTool,
      check_integration_status: checkIntegrationStatusTool,
    };
  }

  // Reset per-run state on preProcess
  protected async preProcess(state: AgentState) {
    this._stopOnly = (state.intentAnalysis?.action === 'cancel' && state.intentAnalysis.cancellationScope === 'operation')
      || state.widgetContinuation?.toolName === 'stop_ads';
    this._hasCompletedPrimaryWork = hasSuccessfulWidgetContinuation(
      state,
      this.widgetCompletionTools,
    );
    this._requiresApproval = false;
    this._pendingApproval = null;
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _handleToolResult(toolName: string, toolResult: any): void {
    if ((toolName === 'generate_ad' || toolName === 'analytics_query') && toolResult.success && !toolResult.pendingWidget) {
      this._hasCompletedPrimaryWork = true;
    }
    if (toolName === 'publish_ads' && toolResult.requiresApproval) {
      this._requiresApproval = true;
      this._pendingApproval = stampPendingApproval({
        toolName: 'publish_ads',
        args: toolResult.output?.args || {},
        executionId: `perf-ads-${Date.now()}`,
        message: toolResult.output?.message || 'Ready to launch the selected ad platforms. This approval can start spending money.',
      });
    }
    if (toolName === 'publish_meta_ads' && toolResult.requiresApproval) {
      this._requiresApproval = true;
      this._pendingApproval = stampPendingApproval({
        toolName: 'publish_meta_ads',
        args: toolResult.output?.args || {},
        executionId: `perf-meta-${Date.now()}`,
        message: toolResult.output?.message || 'Ready to publish ads. This will start spending money. Approve?',
      });
    }
    if (toolName === 'publish_google_ads' && toolResult.requiresApproval) {
      this._requiresApproval = true;
      this._pendingApproval = stampPendingApproval({
        toolName: 'publish_google_ads',
        args: toolResult.output?.args || {},
        executionId: `perf-google-${Date.now()}`,
        message: toolResult.output?.message || 'Ready to publish Google Ads. This will start spending money. Approve?',
      });
    }
  }

  protected _handleToolCall(toolName: string): boolean {
    if (this._stopOnly && !['query_ad_campaigns', 'check_integration_status', 'stop_ads'].includes(toolName)) return false;
    if (toolName === 'tasks_completed' && !this._hasCompletedPrimaryWork) {
      logger.warn('[Performance Agent] Blocking premature tasks_completed');
      return false;
    }
    return true;
  }

  /** Append analytics insights to LLM response text. */
  protected async postProcess(_state: AgentState, result: AgentRunResult): Promise<AgentRunResult> {
    const insights = generateAnalyticsInsights(result.toolResults);
    if (insights) {
      return { ...result, text: result.text + insights };
    }
    return result;
  }

  protected buildActionButtons(_state: AgentState, toolResults: ToolCallResult[]): ActionButton[] {
    if (this._stopOnly) return [];
    if (this._requiresApproval && this._pendingApproval?.toolName && !toolHasWidget(this._pendingApproval.toolName)) {
      return [
        { id: 'perf_approve', label: 'Approve & Publish', action: 'approve_tool', type: 'primary' as const },
        { id: 'perf_cancel', label: 'Cancel', action: 'reject_tool', type: 'danger' as const },
      ];
    }
    if (this._requiresApproval) {
      // Widget handles approval
      return [];
    }
    // The active analytics widget is the confirmation surface. Rendering a
    // second row of metric buttons at this stage caused users to submit a new
    // chat request and create another widget instead of running the first one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingAnalyticsWidget = toolResults.some((r: any) =>
      r.toolName === 'analytics_query' && r.success && r.result?.pendingWidget
    );
    if (pendingAnalyticsWidget) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (toolResults.some((r: any) => r.toolName === 'generate_ad' && r.success)) {
      return [
        { id: 'perf_more_ads', label: 'Create More Variations', action: 'CONTENT_AD', type: 'secondary' as const },
        { id: 'perf_publish', label: 'Publish Campaign', action: 'PUBLISH_ADS', type: 'primary' as const },
      ];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (toolResults.some((r: any) => r.toolName === 'analytics_query' && r.success)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastQuery = toolResults.filter((r: any) => r.toolName === 'analytics_query').pop();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryType = (lastQuery as any)?.result?.output?.queryType;
      const filterOptions = ['campaign', 'lead', 'outreach', 'overview'].filter(t => t !== queryType);
      return filterOptions.map(t => ({
        id: `analytics_${t}`,
        label: `${t.charAt(0).toUpperCase() + t.slice(1)} Metrics`,
        action: `ANALYTICS_${t.toUpperCase()}`,
        type: 'secondary' as const,
      }));
    }
    return [];
  }

  protected buildReturnState(_state: AgentState, _result: AgentRunResult): Partial<AgentState> {
    return {
      ...(this._stopOnly ? { currentAgent: _state.currentAgent, tasksCompleted: false } : {}),
      requiresApproval: this._requiresApproval,
      pendingApproval: this._pendingApproval,
    };
  }

  protected _fallbackResponse(): string {
    return `I'm ready to help with your performance marketing campaigns. What would you like to do?`;
  }
}

// ── Singleton instance ─────────────────────────────────────────────────


// ── Backward-compatible export ─────────────────────────────────────────

export function createPerformanceAgent(): BaseAgent {
  return new PerformanceAgent();
}

export async function runPerformanceAgent(state: AgentState): Promise<Partial<AgentState>> {
  return createPerformanceAgent().run(state);
}
