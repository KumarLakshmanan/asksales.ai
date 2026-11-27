/**
 * Mastra Lead Generation Agent — Marcus Johnson
 * Migrated to extend BaseAgent (Phase 1 refactoring).
 * All shared boilerplate (emitFinalResponse, message prep, error handling,
 * pipeline prompt, agent switch detection) is now handled by BaseAgent.
 *
 * This file only contains what's unique to lead generation:
 *  - buildSystemPrompt()  — Marcus's full system prompt
 *  - getTools()           — lead generation tool registry
 *  - preProcess()         — initialize invocation-scoped state
 *  - _handleToolResult()  — track leadInputs, approval state, workflow execution
 *  - _handleToolCall()    — guards against premature tool calls
 *  - buildActionButtons() — approval, satisfaction, and strategy buttons
 *  - buildReturnState()   — return leadInputs, leadWorkflowExecuted, selectedWorkflows
 *
 * Backward-compatible export: runLeadAgent(state) is still exported for the orchestrator.
 */

import type { AgentState, ActionButton, PendingApproval } from '../state.js';
import type { AgentType } from '../state.js';
import type { ToolContext } from '../tools/toolRegistry.js';
import type { AgentRunResult } from './BaseAgent.js';
import type { ToolCallResult } from '../utils/toolCallingLoop.js';
import { BaseAgent, type PreProcessResult } from './BaseAgent.js';
import {
  listAvailableWorkflowsTool,
  estimateLeadSearchCostTool,
  generateLeadInputsTool,
  executeLeadWorkflowTool,
} from '../tools/leadTools.js';
import { crawlWebsiteTool } from '../tools/icpTools.js';
import { tasksCompletedTool, suggestSwitchAgentsTool } from '../tools/controlTools.js';
import { analyticsQueryTool, createCrmReminderTool, updatePipelineStatusTool } from '../tools/analyticsTools.js';
import {dashboardContactTools} from '../tools/dashboardOperationTools.js';
import { queryLeadsTool, queryIcpProfilesTool } from '../tools/dataQueryTools.js';
import { checkIntegrationStatusTool } from '../tools/integrationTools.js';
import { webSocketEmitter } from '../../services/agents/WebSocketEmitter.js';
import { stampPendingApproval } from '../approvalExpiry.js';
import { TAB_TYPES, TAB_LABELS } from '../tabConfig.js';
import { buildAgentContext } from '../utils/contextManager.js';
import { buildPipelineStatusPrompt } from '../utils/pipelinePrompt.js';
import { getToolDescriptionsForAgent } from '../tools/toolRegistry.js';
import { logger } from '../../utils/logger.js';
import { normalizeReviewedLeadIds } from '../leadReview.js';
import { createLeadShortlistTools } from '../tools/leadShortlistTools.js';
import { resolveOriginalLeadInputRequest } from '../tools/executors/leadRequestConstraints.js';

function leadChannelKey(channel: string): string {
  return channel.startsWith('google_maps') ? 'google_maps' : channel.split('_')[0];
}

export function leadStrategyChannelsChanged(requested: string[], confirmed: string[]): boolean {
  const requestedChannelKeys = new Set(requested.map(leadChannelKey));
  const confirmedChannelKeys = new Set(confirmed.map(leadChannelKey));
  return requestedChannelKeys.size > 0
    && confirmedChannelKeys.size > 0
    && (requestedChannelKeys.size !== confirmedChannelKeys.size
      || [...requestedChannelKeys].some(channel => !confirmedChannelKeys.has(channel)));
}

export function isExplicitReviewedLeadApproval(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[’‘]/g, "'").trim();
  // This changes an approval gate, so questions, quoted/reported approval,
  // negation and conditional intent must not count as client authorization.
  if (/[?]/.test(normalized)
    || /\b(?:not|never|no|don't|cannot|can't|won't|wouldn't|shouldn't|if|unless|until|maybe|might|later|except|excluding)\b/.test(normalized)) return false;
  return /^(?:yes[,!.\s]+)?(?:i\s+)?(?:explicitly\s+)?approve(?:d)?\s+(?:(?:all|the|these|those|my|reviewed|selected|generated|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)*(?:leads|lead\s+set)(?:\s+for\s+outreach(?:\s+handoff)?)?[.!\s]*$/.test(normalized);
}

/**
 * Whether this turn approves the reviewed lead set. The exact English phrase
 * (what the approval button sends) is accepted directly; any other wording or
 * language relies on the router's validated reading of the latest message. It
 * only releases the lead-review handoff gate: sending still needs its own review.
 */
/** The recommendation's own fit score and reason. A fallback pick was not
 * ranked, so it gets no score. */
const LEAD_CHANNEL_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn', google_maps: 'Google Maps', google: 'Google', instagram: 'Instagram', facebook: 'Facebook',
  twitter: 'X (Twitter)', x: 'X (Twitter)', youtube: 'YouTube', tiktok: 'TikTok', reddit: 'Reddit', web: 'Web', website: 'Websites',
};

/** Customer-facing name of a lead channel key (linkedin -> LinkedIn). */
export function leadChannelLabel(channel: string): string {
  const key = channel.trim().toLowerCase();
  return LEAD_CHANNEL_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

/** The first sentence of a catalog description, so a list stays scannable. */
function firstSentence(text: string): string {
  const sentence = text.trim().match(/^.+?[.!?](?=\s|$)/)?.[0] || text.trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}…` : sentence;
}

export function recommendationFit(entry: { matchPercentage?: unknown; reason?: unknown; fallback?: unknown; onlyOption?: unknown }): string {
  if (entry.fallback === true) return 'Default strategy for this channel; no tailored match was made.';
  // A channel with one saved workflow is not ranked, so a score would overstate fit.
  if (entry.onlyOption === true) return 'Only saved strategy for this channel; not ranked against your request.';
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
  const score = Number(entry.matchPercentage);
  const scoreText = Number.isFinite(score) && score > 0 ? `${Math.round(score)}% match` : '';
  return [scoreText, reason].filter(Boolean).join(': ') || 'Not ranked.';
}

export function isReviewedLeadApprovalTurn(
  message: string,
  intent?: Pick<import('../routerSchema.js').RouterOutput, 'leadReviewApproval' | 'needsClarification' | 'action'> | null,
): boolean {
  if (isExplicitReviewedLeadApproval(message)) return true;
  return intent?.leadReviewApproval === true && !intent.needsClarification
    && !['question', 'cancel', 'clarify'].includes(intent.action || '');
}

// ── System Prompt ──────────────────────────────────────────────────────

function buildLeadSystemPrompt(state: AgentState): string {
  const toolDescriptions = getToolDescriptionsForAgent('lead_generation');

  let prompt = `You are Marcus Johnson, a lead generation specialist. Professional, direct, and results-focused.

YOUR TOOLS:
${toolDescriptions}

TERMINOLOGY:
- ALWAYS say "lead extraction strategy" (or just "strategy") instead of "workflow". Users see strategies, not workflows.
- Example: "Here are the best lead extraction strategies for each channel" — NEVER "Here are the best workflows".

PROCESS:
1. When user requests lead generation or asks to find leads → FIRST call list_available_workflows with the target platforms and user requirements so you can recommend the best strategy for each channel
2. Present only the best matching strategy for each channel, including the match percentage and a short reason. Ask the user to confirm it or request alternatives.
3. After user confirms → Call generate_lead_inputs to set up search parameters (pass the confirmed platforms)
4. Present generated parameters to user, wait for approval
5. User approves → Call execute_lead_workflow with the selected platform
6. Report results with a summary of leads found
7. After reporting results, direct the user to review the exact persisted leads in the Leads tab and ASK them to explicitly approve the reviewed lead set — WAIT for their response
8. Only if the user explicitly says they approve the reviewed leads (for example, "I approve the reviewed leads") → Call tasks_completed with a brief summary. "Looks good", "done", or general satisfaction alone are not approval. Then say: "I've finished my part. Let me hand things over to the next agent."
9. If user says no or requests changes → Help with their new request (re-generate, modify, etc.)

CRITICAL RULES:
- For an existing shortlist change, use get_lead_shortlist, interpret the requested categories against the returned records, and call revise_lead_shortlist with the exact IDs to keep. Do not rerun scraping or change search settings to remove existing leads. Missing category facts are unknown; ask about ambiguous leads. An empty keep list clears only the shortlist. Editing never approves leads or changes recipients in a previously prepared outreach campaign.
- ALWAYS call list_available_workflows FIRST before generate_lead_inputs when starting a new lead generation request. This shows the user what strategies are available for their channels.
- NEVER call generate_lead_inputs without first presenting available strategies and getting user confirmation (unless the user explicitly says "skip strategy selection" or similar).
- When the user confirms one or more specific strategies, call generate_lead_inputs with selected_workflows set to those exact strategy IDs.
- Asking to prepare search settings or show a search plan for review using the selected/recommended strategy authorizes SETTINGS PREPARATION ONLY. When saved strategy IDs are present, use those exact IDs with generate_lead_inputs; do not repeat the catalog or demand execution approval to prepare the review. A prohibition on approving/running the search does not prohibit preparing its settings. If no strategy is recorded, recommend a real matching strategy first; never invent IDs.
- NEVER call execute_lead_workflow before generate_lead_inputs has been completed in a prior turn
- NEVER call execute_lead_workflow and generate_lead_inputs in the same response
- NEVER call execute_lead_workflow unless generate_lead_inputs was completed in a previous turn
- NEVER call tasks_completed after recommending strategies or after generating inputs. The lead task is not complete until extraction has executed AND the user has explicitly approved the reviewed persisted lead set.
- NEVER call tasks_completed immediately after execute_lead_workflow. Always ask the user first if they are satisfied with the results.
- After generating inputs, WAIT for user approval before executing
- NEVER call generate_lead_inputs if "GENERATED LEAD INPUTS" already appears in the context above — those inputs are already ready. Only re-call if the user explicitly asks to regenerate or change the parameters.
- When user asks to MODIFY parameters (e.g., "only 20 leads", "change location to NY", "search restaurants instead"), RE-CALL generate_lead_inputs with user_requirements containing the user's exact request. This regenerates fresh inputs incorporating their changes.
- ALWAYS pass user_requirements when calling generate_lead_inputs if the user has specified any preferences about count, location, industry, platforms, or search criteria

PIPELINE COMPLETION:
- When you have finished ALL lead generation work AND the user explicitly approves the reviewed lead set, call tasks_completed so the system can advance to the next agent in the pipeline (if applicable — see PIPELINE section below for details).
- After calling tasks_completed, say something like: "I've completed lead generation. Let me hand things over to the next agent."

SHOWING ALL STRATEGIES:
- When the user clicks "Show All Strategies" or asks to see all available strategies, call list_available_workflows with show_all set to true plus the target platforms. This returns EVERY strategy for each channel (not just the recommended one).
- Present ALL strategies grouped by channel, with id, title, and description for each. Let the user pick which ones to use.

PASSING PLATFORMS:
- ALWAYS pass ALL platforms from the ICP's "primaryChannels" field in a SINGLE tool call. For example, if ICP has ["google_maps", "linkedin"], pass both: platforms: ["google_maps", "linkedin"]. Do NOT make separate calls per platform.
- When calling list_available_workflows, pass ALL ICP channels at once so strategies for every channel are recommended in one response.
- When calling generate_lead_inputs, pass ALL confirmed platforms at once. The tool handles multi-channel internally.
- If the ICP has no primaryChannels, infer platforms from the business model: B2B → ["linkedin", "google_maps"]; B2C → ["instagram", "facebook", "google_maps"]; Unknown → ["linkedin", "google_maps", "instagram"].
- Valid platforms: linkedin, google_maps, justdial, instagram, facebook, twitter.
- If the user specifies specific platforms, pass exactly those.
- If the user asks for specific people by job title (for example CTOs or Heads of Automation) and names no platform, pass only people-search channels such as linkedin. Do not add google_maps or justdial: they return business listings, not the people requested.
- If the user confirms specific strategy IDs from the list, pass those exact IDs in selected_workflows.

AFTER TOOL EXECUTION - SUMMARY REQUIRED:
- After generate_lead_inputs completes successfully, ALWAYS write a clear text summary explaining what platforms were configured and what the parameters look like.
- Your summary should mention: the platforms searched, approximate lead count parameters, and key targeting criteria.

MINIMIZE QUESTIONS:
- Use ICP data directly — do not re-ask about industry, audience, or platforms
- If user says "find leads", FIRST call list_available_workflows using the ICP platforms, then present recommended strategies and get confirmation before generating inputs
- Only ask if ICP is completely empty AND user gave no context at all
- Prefer action over questions

STRATEGY LISTING RULES:
- Do NOT say strategies are unavailable unless list_available_workflows returns an empty array for that exact channel.
- If list_available_workflows returns one or more strategies, present them directly.
- Set show_all only when the user explicitly asks to see all or every strategy. A question about which strategy to use, or a request for recommendations, uses the default best match per channel.

FORMATTING — STRATEGY TABLES:
When presenting RECOMMENDED strategies (one per platform), format as:

| Platform | Strategy | Description | Match % | Reason |
|----------|----------|-------------|---------|--------|
| Google Maps | Business Finder | ... | 92% | ... |
| LinkedIn | Company Search | ... | 87% | ... |

When presenting ALL strategies (show_all=true), group by platform with a heading:

### 🗺️ Google Maps
| Strategy | Description | Match % |
|----------|-------------|---------|
| Strategy A | ... | 92% |
| Strategy B | ... | 78% |

### 💼 LinkedIn
| Strategy | Description | Match % |
|----------|-------------|---------|
| Strategy A | ... | 87% |

Always use markdown tables — never plain text lists for strategy presentation.

WEBSITE CRAWLING: Call crawl_website when user provides a URL. Summarize findings, do NOT auto-generate lead inputs.

DATA QUERIES:
- When the user asks about existing leads (names, emails, phone numbers, counts, details), call query_leads to retrieve data from the database.
- NEVER start a new lead workflow or LinkedIn search when the user is asking about leads that already exist.
- For questions like "what are the lead names?", "show leads with emails", "leads from LinkedIn" → use query_leads.
- If the user asks about previously defined customer profiles, target audiences, or ICPs → call query_icp_profiles.
- Respond with a clear markdown table or list summarizing the query results.

INTEGRATION STATUS CHECK:
- If the user asks about the connection/integration status of outreach channels or platforms → call "check_integration_status".

TOOL SAFETY RULES:
- NEVER call a campaign or workflow execution tool ("execute_lead_workflow" or "generate_lead_inputs") when the user is asking a question about existing data or integration status.
- When the user asks what a search will cost or how long it will take, call estimate_lead_search_cost and report its numbers and basis exactly. Never guess a price or duration, and never call execute_lead_workflow for this.
- If the user asks "what are the names of my leads?" → call query_leads, NOT execute_lead_workflow.
- If the user asks "show me the leads that have phone numbers" → call query_leads, NOT execute_lead_workflow.
- If the user asks "is my LinkedIn connected?" → call check_integration_status, NOT execute_lead_workflow.
`;

  // Dynamic context
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextInfo = buildAgentContext(state as any, {
    businessInstruction: 'Personalize lead generation strategy to this business.',
    icpFormat: 'json',
    icpInstruction: 'Use ICP primaryChannels for platform selection. Extract targetAudience, industry, primaryJobTitles, primaryRegions for lead targeting.',
    includeBrandToolkit: false,
    userInstruction: 'Address Marcus-style: professional and direct.',
  });

  if (contextInfo) prompt += `\n--- CONTEXT ---${contextInfo}`;

  // Show selected workflows if present
  if (state.selectedWorkflows && state.selectedWorkflows.length > 0) {
    prompt += `\n\nSAVED RECOMMENDED / SELECTED STRATEGIES:\n${state.selectedWorkflows.join(', ')}\nThese are the saved strategy IDs, not execution approval. When the user asks to prepare their settings for review, call generate_lead_inputs with these exact IDs in selected_workflows. Do not re-list or silently substitute strategies unless the user requests alternatives or changes.`;
  }

  if (state.intentAnalysis?.leadSettingsRequested) {
    prompt += '\n\nCURRENT TURN: PREPARE SEARCH SETTINGS FOR REVIEW ONLY. Carry the latest targeting and exclusions into user_requirements. Do not approve, execute a search, complete the lead task, or advance to outreach. If settings are already ready and no change is requested, show the existing review instead of generating duplicates.';
  }

  // Show existing lead inputs if present
  if (state.leadInputs?.length) {
    prompt += `\n\nGENERATED LEAD INPUTS:\n${JSON.stringify(state.leadInputs, null, 2)}\n${state.leadWorkflowExecuted
      ? 'These are historical inputs from an executed search, NOT a fresh approval. A request for another run requires strategy confirmation and fresh generate_lead_inputs; never claim the old review is newly prepared.'
      : 'These inputs are ready. To modify, re-call generate_lead_inputs with user_requirements. To execute, call execute_lead_workflow.'}`;
  }

  // Workflow already executed flag
  if (state.leadWorkflowExecuted) {
    const verifiedLeadIds = normalizeReviewedLeadIds(state.selectedLeadIds);
    if (verifiedLeadIds.length === 0) {
      prompt += `\n\nLEAD WORKFLOW EXECUTED — NO VERIFIED LEAD IDS IN THE CURRENT RESULT: Execution alone is NOT evidence that leads were found or saved. Do not claim that generated leads exist in the database. If the recorded outcome says no matches, report that zero-match result. Do not ask the user to approve an empty set, call tasks_completed, or offer an outreach handoff. Offer to review/refine the search criteria or import leads; a new search still requires the usual approvals. If the user forbids tools, answer only from the recorded outcome and disclose any missing information.`;
    } else {
      prompt += `\n\nVERIFIED CURRENT LEAD IDS (${verifiedLeadIds.length}): ${verifiedLeadIds.join(', ')}. This is the current result/selection, not a count of every lead in the workspace.`;
      prompt += state.leadReviewApproved
        ? `\nREVIEWED LEADS APPROVED: The user explicitly approved this persisted lead set. You may now call tasks_completed and hand off.`
        : `\nLEAD WORKFLOW ALREADY EXECUTED: These verified lead IDs are NOT approved for outreach. Ask the user to inspect these exact records in the Leads tab and explicitly approve that reviewed set. Do not hand off or offer outreach yet.`;
    }
  }

  // Pipeline context
  prompt += buildPipelineStatusPrompt(state, {
    workLabel: 'lead generation',
    handoffExample: nextName => `I have successfully extracted the qualified lead list for you and saved them under your Leads tab. Next up, I will hand you over to ${nextName} to help craft custom copy and design the templates. ${nextName}, take it from here!`,
  });

  return prompt;
}

// ── LeadAgent class ────────────────────────────────────────────────────

class LeadAgent extends BaseAgent {
  readonly agentType: AgentType = 'lead_generation';
  readonly thinkingMessage = 'Marcus is analyzing lead opportunities...';

  // ── Per-run mutable state (reset on each run() call) ────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _updatedLeadInputs: any[] = [];
  private _workflowAlreadyExecuted = false;
  private _leadReviewApproved = false;
  private _reviewedLeadIds: number[] = [];
  private _requiresApproval = false;
  private _pendingApproval: PendingApproval | null = null;
  private _generatedThisRound = false;
  private _unboundExecuteRequest = false;
  private _recommendedStrategyIds: string[] = [];
  private _strategySelectionReady = true;

  protected get intentDomain(): string {
    return 'lead generation, finding B2B prospects, search criteria, scraper parameters, or contact discovery';
  }

  buildSystemPrompt(state: AgentState): string {
    const prompt = buildLeadSystemPrompt(state);
    if (!this._strategySelectionReady) {
      return `${prompt}\n\nCURRENT STRATEGY GATE: generate_lead_inputs is intentionally unavailable in this turn because the current durable campaign run has no confirmed strategy yet. Do not call or mention that tool as available. Call list_available_workflows at most once, then stop and present its real recommendation with the bound strategy action. Strategy confirmation and settings generation must happen in a later user turn.`;
    }
    return prompt;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTools(_toolContext: ToolContext): Record<string, any> {
    return {
      ...dashboardContactTools,
      ...createLeadShortlistTools(_toolContext, () => this._reviewedLeadIds),
      list_available_workflows: listAvailableWorkflowsTool,
      estimate_lead_search_cost: estimateLeadSearchCostTool,
      ...(this._strategySelectionReady ? { generate_lead_inputs: generateLeadInputsTool } : {}),
      execute_lead_workflow: executeLeadWorkflowTool,
      tasks_completed: tasksCompletedTool,
      crawl_website: crawlWebsiteTool,
      suggest_switch_agents: suggestSwitchAgentsTool,
      create_crm_reminder: createCrmReminderTool,
      update_pipeline_status: updatePipelineStatusTool,
      query_leads: queryLeadsTool,
      analytics_query: analyticsQueryTool,
      query_icp_profiles: queryIcpProfilesTool,
      check_integration_status: checkIntegrationStatusTool,
    };
  }

  /** Initialize state that is scoped to this agent invocation. */
  protected async preProcess(state: AgentState): Promise<PreProcessResult> {
    // Reset per-run state
    this._updatedLeadInputs = state.leadInputs || [];
    this._workflowAlreadyExecuted = !!state.leadWorkflowExecuted;
    this._reviewedLeadIds = normalizeReviewedLeadIds(state.selectedLeadIds);
    this._leadReviewApproved = !!state.leadReviewApproved && this._reviewedLeadIds.length > 0;
    this._requiresApproval = state.intentAnalysis?.leadShortlistRequested ? state.requiresApproval ?? false : false;
    this._pendingApproval = state.intentAnalysis?.leadShortlistRequested ? state.pendingApproval ?? null : null;
    this._generatedThisRound = false;
    this._unboundExecuteRequest = false;
    this._recommendedStrategyIds = state.selectedWorkflows || [];
    // A catalog recommendation made during this invocation is not user
    // confirmation. Only expose settings generation on a later turn after the
    // exact strategy IDs have been saved into state by a bound UI/user choice.
    this._strategySelectionReady = false;
    if(state.intentAnalysis?.semanticRequest?.dashboardOperation && state.intentAnalysis.semanticRequest.dashboardOperation!=='none')return {};
    let confirmedStrategyChannels: string[] = [];
    if (state.runContext?.runId) {
      try {
        const { getLatestLeadStrategySelection } = await import('../../models/conversationWorkflow/functions.js');
        const confirmed = await getLatestLeadStrategySelection({
          runId: state.runContext.runId,
          userId: Number(state.userId),
          threadId: Number(state.threadId),
        });
        this._strategySelectionReady = !!confirmed?.workflowIds?.length;
        if (confirmed?.workflowIds?.length) {
          this._recommendedStrategyIds = confirmed.workflowIds;
          confirmedStrategyChannels = confirmed.platforms?.length
            ? confirmed.platforms
            : confirmed.workflowIds;
        }
      } catch (error) {
        logger.warn({ err: error, runId: state.runContext.runId }, '[Lead Agent] Could not verify a confirmed strategy selection');
      }
    } else {
      // Legacy/unit callers without a durable campaign run retain their
      // existing selected-workflow behavior.
      this._strategySelectionReady = (state.selectedWorkflows || []).length > 0;
    }

    // The shared AI intent result requests catalog refresh; no phrase matching.
    const explicitChannels = state.intentAnalysis?.leadChannels || [];
    const changesConfirmedChannels = leadStrategyChannelsChanged(explicitChannels, confirmedStrategyChannels);
    const asksForCatalog = state.intentAnalysis?.leadCatalogRequested === true;
    if (asksForCatalog || changesConfirmedChannels) {
      const profileChannels = state.icpProfile?.primaryChannels || [];
      const channels = explicitChannels.length > 0 ? explicitChannels : profileChannels;
      if (channels.length > 0) {
        const { listWorkflowsForChannels, recommendWorkflowsForChannels, noLeadProviderForChannels } = await import('../tools/executors/leadExecutor.js');
        if (await noLeadProviderForChannels(Number(state.userId) || undefined, channels)) {
          const { LEAD_PROVIDER_UNAVAILABLE_MESSAGE } = await import('../../services/apifyCredentialResolver.js');
          return {
            earlyResponse: LEAD_PROVIDER_UNAVAILABLE_MESSAGE,
            earlyActionButtons: [],
            earlyState: { requiresApproval: state.requiresApproval, pendingApproval: state.pendingApproval },
          };
        }
        // "Which strategy would you recommend?" gets the best match per
        // channel; only an explicit request for every strategy gets the catalog.
        let toolResults: ToolCallResult[];
        if (state.intentAnalysis?.leadCatalogShowAll === true || !asksForCatalog) {
          const catalog = await listWorkflowsForChannels(channels);
          toolResults = [{ toolName: 'list_available_workflows', toolCallId: 'catalog-read', success: catalog.success,
            result: { output: { allStrategies: catalog.workflows } } }];
        } else {
          const requirements = state.intentAnalysis?.semanticRequest?.lead?.requirements
            || [...(state.messages || [])].reverse().find(message => message.role === 'user' && typeof message.content === 'string')?.content as string | undefined;
          const recommended = await recommendWorkflowsForChannels(channels, state.icpProfile, requirements, { userId: state.userId, threadId: state.threadId });
          toolResults = [{ toolName: 'list_available_workflows', toolCallId: 'catalog-recommend', success: recommended.success,
            result: { output: recommended } }];
        }
        const response = await this.postProcess(state, { text: '', toolResults });
        return {
          earlyResponse: response.text,
          earlyActionButtons: this.buildActionButtons(state, toolResults),
          // Reading alternatives neither grants nor revokes execution approval.
          earlyState: { requiresApproval: state.requiresApproval, pendingApproval: state.pendingApproval },
        };
      }
    }

    const userContent = [...state.messages].reverse().find(m => m.role === 'user')?.content || '';
    if (state.leadWorkflowExecuted && this._reviewedLeadIds.length > 0 && userContent) {
      const explicitlyApproved = isReviewedLeadApprovalTurn(userContent, state.intentAnalysis);
      if (explicitlyApproved) this._leadReviewApproved = true;
    }

    // Approval is resolved centrally in chatController and recorded with a
    // durable lease/idempotency receipt before this agent can run again.

    return {};
  }

  protected _handleToolResult(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolResult: any,
    state: AgentState,
    _toolContext: ToolContext,
  ): void {
    const { userId, threadId } = state;

    if (toolName === 'revise_lead_shortlist' && toolResult.success) {
      this._reviewedLeadIds = normalizeReviewedLeadIds(toolResult.output?.leadIds);
      this._leadReviewApproved = false;
      state.selectedLeadIds = this._reviewedLeadIds;
      state.leadReviewApproved = false;
      // Even an imported shortlist must pass the lead-review handoff gate.
      state.leadWorkflowExecuted = true;
      state.tasksCompleted = false;
    }

    if (toolName === 'list_available_workflows' && toolResult.success) {
      const recommendations = toolResult.output?.recommendations || {};
      const recIds = Object.values(recommendations)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((r: any) => r?.id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => (r as any).id);
      if (recIds.length > 0) {
        this._recommendedStrategyIds = recIds;
      }
    }

    if (toolName === 'generate_lead_inputs' && toolResult.success && !toolResult.pendingWidget) {
      this._generatedThisRound = true;
      const schemas = toolResult.output?.schemas || toolResult.output?.leadInputs || [];
      if (schemas.length > 0) {
        this._updatedLeadInputs = schemas;
        // A fresh review replaces the current run state, not the stored leads.
        // Never describe this unexecuted draft as an older completed search.
        this._workflowAlreadyExecuted = false;
        this._leadReviewApproved = false;
        this._reviewedLeadIds = [];
        state.leadWorkflowExecuted = false;
        state.leadReviewApproved = false;
        state.selectedLeadIds = [];
        state.tasksCompleted = false;
      }
      this._requiresApproval = true;
      this._pendingApproval = stampPendingApproval({
        toolName: 'execute_lead_workflow',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: {
          platforms: schemas.map((i: any) => i.platform).filter(Boolean),
          selected_workflows: toolResult.output?.workflowIds,
          ...(toolResult.output?.leadInputSetId ? {
            leadInputSetId: toolResult.output.leadInputSetId,
            leadInputSetRevision: toolResult.output.leadInputSetRevision,
            workflowRunId: toolResult.output.workflowRunId,
          } : {}),
        },
        executionId: toolResult.output?.leadInputSetId
          ? `lead-input-set:${toolResult.output.leadInputSetId}:${toolResult.output.leadInputSetRevision}`
          : `lead-gen-${Date.now()}`,
        message: 'Lead inputs generated. Approve to execute?',
      });
    }

    if (toolName === 'execute_lead_workflow' && toolResult.requiresApproval) {
      // A search runs only against an exact reviewed input revision. Asking
      // again must keep that bound approval (and its button), never replace it
      // with an unbound one that the executor would refuse.
      const reviewed = this._pendingApproval?.toolName === 'execute_lead_workflow' && this._pendingApproval.args?.leadInputSetId
        ? this._pendingApproval
        : state.pendingApproval?.toolName === 'execute_lead_workflow' && state.pendingApproval.args?.leadInputSetId
          ? state.pendingApproval
          : null;
      if (reviewed) {
        this._requiresApproval = true;
        this._pendingApproval = reviewed;
      } else {
        this._unboundExecuteRequest = true;
      }
    }

    if (toolName === 'execute_lead_workflow' && toolResult.success && !toolResult.requiresApproval) {
      this._workflowAlreadyExecuted = true;
      this._leadReviewApproved = false;
      this._reviewedLeadIds = Array.isArray(toolResult.output?.leadIds)
        ? toolResult.output.leadIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
        : [];
      // Open Leads tab
      webSocketEmitter.emit(Number(userId), 'open_tab', {
        thread_id: Number(threadId),
        tabType: TAB_TYPES.LEADS,
        tabLabel: TAB_LABELS[TAB_TYPES.LEADS],
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _handleToolCall(toolName: string, _args: any, state: AgentState): boolean {
    if (state.intentAnalysis?.leadShortlistRequested && !['get_lead_shortlist', 'query_leads', 'revise_lead_shortlist'].includes(toolName)) return false;
    if (state.intentAnalysis?.leadSettingsRequested && ['execute_lead_workflow', 'tasks_completed'].includes(toolName)) return false;
    if (toolName === 'execute_lead_workflow' && this._generatedThisRound) {
      logger.warn('[Lead Agent] Blocking execute_lead_workflow — generate was called in same round');
      return false;
    }
    if (toolName === 'execute_lead_workflow' && !state.leadInputs?.length && !this._updatedLeadInputs.length) {
      logger.warn('[Lead Agent] Blocking execute_lead_workflow — no lead inputs generated yet');
      return false;
    }
    if (toolName === 'generate_lead_inputs' && this._generatedThisRound) {
      logger.warn('[Lead Agent] Blocking duplicate generate_lead_inputs — already generated this round');
      return false;
    }
    if (toolName === 'tasks_completed' && (!this._workflowAlreadyExecuted && !state.leadWorkflowExecuted)) {
      logger.warn('[Lead Agent] Blocking tasks_completed — workflow not yet executed');
      return false;
    }
    if (toolName === 'tasks_completed'
      && this._reviewedLeadIds.length === 0
      && normalizeReviewedLeadIds(state.selectedLeadIds).length === 0) {
      logger.warn('[Lead Agent] Blocking tasks_completed — no persisted lead IDs are available for review');
      return false;
    }
    if (toolName === 'tasks_completed' && !this._leadReviewApproved && !state.leadReviewApproved) {
      logger.warn('[Lead Agent] Blocking tasks_completed — reviewed leads have not been explicitly approved');
      return false;
    }
    return true;
  }

  protected async postProcess(_state: AgentState, result: AgentRunResult): Promise<AgentRunResult> {
    if (this._unboundExecuteRequest && !this._requiresApproval) {
      return { ...result, text: 'There are no reviewed search settings to run yet. Choose a strategy and I will prepare its settings for your review first. No search has run.' };
    }
    if (_state.intentAnalysis?.leadSettingsRequested && _state.leadWorkflowExecuted && result.toolResults.length === 0) {
      return { ...result, text: 'No new search settings or approval card were generated. The previous inputs belong to the completed search. Please select the strategy again to prepare a fresh review; no new search has been executed.' };
    }
    const last = result.toolResults[result.toolResults.length - 1];
    if (last?.toolName !== 'list_available_workflows' || !last.success) return result;
    const output = last.result?.output;
    const catalog = output?.allStrategies;
    const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
    // A recommendation is not a generated input review. Render the tool's
    // actual choices instead of letting historical chat invent extra workflows
    // or claim that settings are already prepared.
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      const recommendations = output?.recommendations;
      if (!recommendations || typeof recommendations !== 'object' || Array.isArray(recommendations)) {
        return { ...result, text: 'I could not read the strategy recommendations. Please list the available strategies again; no new search settings were generated.' };
      }
      const rows: string[] = [];
      for (const [channel, value] of Object.entries(recommendations)) {
        const entry = value as { id?: unknown; title?: unknown; description?: unknown; matchPercentage?: unknown; reason?: unknown; onlyOption?: unknown } | null;
        if (!entry || typeof entry.id !== 'string' || typeof entry.title !== 'string' || typeof entry.description !== 'string') continue;
        rows.push(`| ${cell(leadChannelLabel(channel))} | **${cell(entry.title)}** | ${cell(recommendationFit(entry))} |`);
      }
      if (rows.length === 0) return { ...result, text: 'No available strategy was recommended. Show all strategies to choose another option; no new search settings were generated.' };
      return { ...result, text: `${rows.length === 1 ? 'Recommended strategy' : 'Recommended strategies'} for this campaign:\n\n| Channel | Strategy | Why it fits |\n|---|---|---|\n${rows.join('\n')}\n\nSelect **Prepare Search Settings** and I will prepare the settings for your review, or **Show All Strategies** to compare the others. Nothing has been searched yet.` };
    }
    const sections: string[] = [];
    for (const [channel, entries] of Object.entries(catalog)) {
      if (!Array.isArray(entries)) continue;
      const strategies = entries.filter((entry): entry is { id: string; title: string; description: string } =>
        entry && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.description === 'string');
      sections.push(`**${cell(leadChannelLabel(channel))}** · ${strategies.length} ${strategies.length === 1 ? 'strategy' : 'strategies'}\n\n${strategies.length > 0
        ? strategies.map(entry => `- **${cell(entry.title)}**: ${cell(firstSentence(entry.description))}`).join('\n')
        : 'No available strategies were returned for this channel.'}`);
    }
    if (sections.length === 0) return { ...result, text: 'I could not read the strategy catalog. Please try listing the strategies again.' };
    return { ...result, text: `${sections.join('\n\n')}\n\nChoose a strategy below and I will prepare its search settings for your review. Nothing has been searched yet.` };
  }

  protected buildActionButtons(state: AgentState, toolResults: ToolCallResult[]): ActionButton[] {
    if (this._requiresApproval) {
      if (state.intentAnalysis?.leadShortlistRequested || this._pendingApproval?.toolName !== 'execute_lead_workflow') return [];
      const requestId = this._pendingApproval?.executionId || this._pendingApproval?.toolCallId;
      if (!requestId) return [];
      return [
        {
          id: `approve-${requestId}`, label: 'Approve & Run Search', action: 'approve_tool', type: 'primary' as const,
          data: {
            requestId, toolName: 'execute_lead_workflow',
            inputSetId: this._pendingApproval?.args.leadInputSetId,
            revision: this._pendingApproval?.args.leadInputSetRevision,
          },
        },
        { id: 'lead_edit', label: 'Edit Parameters', action: 'OPEN_TAB', type: 'secondary' as const, data: { tabType: 'lead-inputs' } },
      ];
    }

    const lastToolResult = toolResults[toolResults.length - 1];
    if (state.intentAnalysis?.leadSettingsRequested && state.leadWorkflowExecuted && toolResults.length === 0) {
      return [{
        id: 'lead_choose_fresh_strategy', label: 'Choose strategy for fresh review',
        action: 'LEAD_AGENT_USE_WORKFLOW', type: 'secondary' as const,
        data: { message: 'Show me all available strategies for each channel' },
      }];
    }
    // Unrelated no-tool discussion is not a new review of historical leads.
    if (toolResults.length === 0 && state.intentAnalysis && !state.intentAnalysis.leadShortlistRequested) return [];
    if (lastToolResult?.toolName === 'generate_lead_inputs' && !lastToolResult.success) {
      const selected = this._recommendedStrategyIds.length ? this._recommendedStrategyIds : (state.selectedWorkflows || []);
      const latestRequest = resolveOriginalLeadInputRequest(undefined, state.messages || []) || '';
      return selected.map((workflowId, index) => ({
        id: `lead_retry_settings_${workflowId}`,
        label: selected.length === 1 ? 'Confirm strategy & retry settings' : `Retry selected strategy ${index + 1}`,
        action: 'LEAD_AGENT_USE_WORKFLOW', type: 'secondary' as const,
        data: {
          workflowId,
          platform: workflowId.startsWith('google_maps') ? 'google_maps' : workflowId.split('_')[0],
          message: `Prepare fresh search settings for the selected strategy, for review only. Preserve these requested inputs: ${latestRequest}\nDo not execute a search or approve outreach.`,
        },
      }));
    }
    if (lastToolResult?.toolName === 'list_available_workflows' && lastToolResult?.success) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output = (lastToolResult as any)?.result?.output || {};
      // Bind the human-readable choice to its real catalog ID. The customer
      // should not need to type internal IDs or rely on the LLM to recreate one.
      if (output.allStrategies && typeof output.allStrategies === 'object') {
        return Object.entries(output.allStrategies).flatMap(([platform, entries]) => {
          if (!Array.isArray(entries)) return [];
          return entries.filter(entry => entry && typeof entry.id === 'string' && typeof entry.title === 'string').map(entry => ({
            id: `lead_strategy_${entry.id}`,
            label: entry.title,
            action: 'LEAD_AGENT_USE_WORKFLOW',
            type: 'secondary' as const,
            data: { workflowId: entry.id, workflowTitle: entry.title, platform, message: `Use ${entry.title} and prepare the search settings for my review.` },
          }));
        });
      }
      const recommendations = output?.recommendations || {};
      const recommendedIds = Object.values(recommendations)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((r: any) => r?.id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => (r as any).id);
      return [
        ...(recommendedIds.length > 0 ? [{ id: 'lead_proceed_strategies', label: 'Prepare Search Settings', action: 'LEAD_AGENT_START', type: 'primary' as const, data: { message: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.', selectedWorkflows: recommendedIds, platforms: Object.keys(recommendations) } }] : []),
        { id: 'lead_show_all_strategies', label: 'Show All Strategies', action: 'LEAD_AGENT_USE_WORKFLOW', type: 'secondary' as const, data: { message: 'Show me all available strategies for each channel' } },
      ];
    }

    // A settings-only response must not offer approval of an older lead set.
    if (state.intentAnalysis?.leadSettingsRequested) return [];

    const reviewedLeadIds = this._reviewedLeadIds.length > 0
      ? this._reviewedLeadIds
      : normalizeReviewedLeadIds(state.selectedLeadIds);
    if ((state.leadWorkflowExecuted || this._workflowAlreadyExecuted)
      && reviewedLeadIds.length > 0
      && !state.leadReviewApproved
      && !this._leadReviewApproved) {
      return [
        { id: 'lead_review_approve', label: 'Approve reviewed leads', action: 'LEAD_AGENT_START', type: 'primary' as const, data: { message: 'I approve the reviewed leads.' } },
        { id: 'lead_review_adjust', label: 'Adjust search', action: 'LEAD_AGENT_START', type: 'secondary' as const, data: { message: 'I need to find more leads or change the search parameters.' } },
      ];
    }

    return [];
  }

  protected buildReturnState(state: AgentState, _result: AgentRunResult): Partial<AgentState> {
    const reviewedLeadIds = normalizeReviewedLeadIds(this._reviewedLeadIds);
    return {
      ...(state.intentAnalysis?.leadShortlistRequested ? { currentAgent: state.currentAgent, tasksCompleted: false } : {}),
      leadInputs: this._updatedLeadInputs.length ? this._updatedLeadInputs : state.leadInputs,
      leadWorkflowExecuted: this._workflowAlreadyExecuted || state.leadWorkflowExecuted,
      leadReviewApproved: reviewedLeadIds.length > 0
        && (this._leadReviewApproved || state.leadReviewApproved === true),
      selectedLeadIds: reviewedLeadIds,
      selectedWorkflows: this._recommendedStrategyIds,
      requiresApproval: this._requiresApproval,
      pendingApproval: this._pendingApproval,
    };
  }

  protected _fallbackResponse(): string {
    return `I'm ready to help with lead generation. What would you like to do? I can list available workflows, generate search parameters, or execute lead generation for your ICP channels.`;
  }
}

// ── Backward-compatible export (called by orchestrator) ───────────────

export function createLeadAgent(): BaseAgent {
  return new LeadAgent();
}

export async function runLeadAgent(state: AgentState): Promise<Partial<AgentState>> {
  // Hooks keep transient state while one run is in progress, so concurrent
  // conversations must never share an agent instance.
  return createLeadAgent().run(state);
}
