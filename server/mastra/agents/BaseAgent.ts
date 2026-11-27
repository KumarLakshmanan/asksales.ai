import { currentConversationRequest, ConversationRequestError } from '../../services/ConversationRequestCoordinator.js';
import { ContextBudgetExceededError } from '../utils/contextBudget.js';
/**
 * BaseAgent — Abstract base class for all Mastra specialist agents.
 *
 * Eliminates ~470 lines of copy-pasted boilerplate across the 5 specialist agents:
 *  - emitFinalResponse (duplicated in every agent ~25 lines × 5)
 *  - Pipeline status prompt block (~25 lines × 3)
 *  - Agent switch detection + user intent extraction (~12 lines × 3)
 *  - Conversation message preparation (~30 lines × 3)
 *  - Error handling pattern (~15 lines × 3)
 *  - Return state shape construction (structural duplication across all agents)
 *
 * Each specialist agent only needs to implement:
 *  1. agentType: AgentType           — e.g. 'lead_generation'
 *  2. buildSystemPrompt(state)       — the agent's unique system prompt
 *  3. getTools()                     — the Mastra tools this agent can use
 *  4. Optional: preProcess(state)    — pre-LLM logic (e.g. brand toolkit check)
 *  5. Optional: postProcess(result)  — post-LLM enrichment (e.g. analytics insights)
 *  6. Optional: buildActionButtons() — compute action buttons from tool results
 *  7. Optional: buildReturnState()   — augment the returned partial state
 */

 
import type { AgentState, ActionButton } from '../state.js';
import type { AgentType } from '../state.js';
import type { ToolContext } from '../tools/toolRegistry.js';
import { readOnlyCampaignTools } from '../tools/readOnlyCampaignTools.js';
import {dashboardOperationTools} from '../dashboardOperationPolicy.js';
import {operationCardsFromReceipts} from '../utils/dashboardCards.js';
import {requireBusinessScope} from '../../tenancy/businessContext.js';
import type {DashboardOperationResult} from '../../../shared/dashboardOperations.js';
import { runToolCallingLoop, type ToolCallResult } from '../utils/toolCallingLoop.js';
import { bindApprovalActions } from '../approvalActions.js';
import { webSocketEmitter } from '../../services/agents/WebSocketEmitter.js';
import { prepareContextForAgent } from '../utils/contextManager.js';
import {
  classifyLLMProviderFailure,
  LLMProviderResponseError,
  safeLLMProviderFailureMessage,
} from '../../services/agents/LLMProviderErrors.js';
import { cleanResponseText } from '../utils/cleanResponseText.js';
import { groundAgentResponse } from '../utils/responseGrounding.js';
import { logger } from '../../utils/logger.js';
import { getPersona } from '../agentPersonas.js';
import { CAMPAIGN_AGENT_MENTIONS } from '../../../shared/campaignAgentMentions.js';
import { selectCampaignSpeakerReply, stripCampaignSpeakerLabel } from '../../../shared/campaignAgentReply.js';

const replySpeakers = CAMPAIGN_AGENT_MENTIONS.map(({ agent }) => {
  const persona = getPersona(agent);
  return { id: agent, names: [persona.firstName, persona.fullName, persona.displayName] };
});

// ── Pre-process result shape ───────────────────────────────────────────

export interface PreProcessResult {
  /** If set, the agent run is skipped entirely and this text is emitted as the response. */
  earlyResponse?: string;
  /** Action buttons to attach to the early response. */
  earlyActionButtons?: ActionButton[];
  /** Additional partial state to return with the early response. */
  earlyState?: Partial<AgentState>;
  /** Injected intent text to replace/augment the last user message. */
  resolvedUserIntent?: string;
}

// ── Agent run result shape ─────────────────────────────────────────────

export interface AgentRunResult {
  text: string;
  toolResults: ToolCallResult[];
  /**
   * Set by postProcess when it replaced the model's text with a fixed,
   * server-written message. Such text contains no model claims, so the
   * action-claim audit is skipped for it.
   */
  serverAuthored?: boolean;
}

export function automaticPipelineRequest(state: AgentState): string | null {
  const request = state.pipelineRequest?.trim();
  const latestMessage = state.messages?.[state.messages.length - 1];
  // A user's bare "continue" resumes a paused step; the step still needs the
  // original request. Any other new instruction takes precedence.
  const continuesPipeline = state.intentAnalysis?.action === 'continue' && !state.intentAnalysis.needsClarification;
  if (!request || (state.agentPipelineIndex ?? 0) <= 0 || (latestMessage?.role === 'user' && !continuesPipeline)) {
    return null;
  }
  return request;
}

export function hasSuccessfulWidgetContinuation(
  state: Pick<AgentState, 'widgetContinuation'>,
  toolNames: readonly string[],
): boolean {
  return state.widgetContinuation?.success === true
    && toolNames.includes(state.widgetContinuation.toolName);
}

const WIDGET_CONTINUATION_PREFIX = '[WIDGET_EXECUTION_COMPLETE — INTERNAL WORKFLOW CONTINUATION]';

/**
 * Return the exact widget-backed tool that has already executed for this
 * internal continuation turn. The LLM is told not to repeat it, but removing
 * it from the turn's tool registry makes that once-only contract deterministic
 * while leaving every remaining workflow tool available.
 */
export function completedWidgetToolToSuppress(
  state: Pick<AgentState, 'messages' | 'pipelineRequest' | 'widgetContinuation'>,
): string | null {
  const latestMessage = state.messages?.[state.messages.length - 1];
  if (
    state.widgetContinuation?.success !== true
    || latestMessage?.role !== 'user'
    || !latestMessage.content?.startsWith(WIDGET_CONTINUATION_PREFIX)
  ) {
    return null;
  }

  if (state.widgetContinuation.toolName === 'generate_ad') {
    const request = state.pipelineRequest || '';
    const requestedPlatforms = ['meta', 'google', 'linkedin']
      .filter(platform => new RegExp(`\\b${platform}\\b`, 'i').test(request));
    const completedPlatforms = new Set(
      (state.widgetContinuation.completedToolInputs || [])
        .map(input => typeof input.platform === 'string' ? input.platform.toLowerCase() : '')
        .filter(Boolean),
    );
    if (requestedPlatforms.some(platform => !completedPlatforms.has(platform))) {
      return null;
    }
  }

  return state.widgetContinuation.toolName;
}

export function shouldAutoCompleteWidgetContinuation(
  state: Pick<AgentState, 'widgetContinuation' | 'agentPipeline' | 'agentPipelineIndex'>,
  toolNames: readonly string[],
  toolResults: ToolCallResult[],
): boolean {
  const currentIndex = state.agentPipelineIndex ?? 0;
  const hasNextAgent = Array.isArray(state.agentPipeline)
    && currentIndex < state.agentPipeline.length - 1;
  const openedAnotherGate = toolResults.some(toolResult => {
    const result = toolResult.result as Record<string, unknown> | null | undefined;
    return result?.pendingWidget === true || result?.requiresApproval === true;
  });
  return hasNextAgent
    && !openedAnotherGate
    && hasSuccessfulWidgetContinuation(state, toolNames);
}

// ── BaseAgent ──────────────────────────────────────────────────────────

export abstract class BaseAgent {
  // ── Abstract: each agent MUST implement ──────────────────────────

  /** Agent type identifier, e.g. 'lead_generation' */
  abstract readonly agentType: AgentType;

  /** Agent's thinking status message shown while processing */
  abstract readonly thinkingMessage: string;

  /** Build the LLM system prompt for this agent. */
  abstract buildSystemPrompt(state: AgentState): string;

  /**
   * Return the Mastra tool registry for this agent (key = tool name, value = Mastra tool object).
   * These are converted to OpenAI function calling format internally by runToolCallingLoop.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract getTools(toolContext: ToolContext): Record<string, any>;

  /** Widget tools whose verified completion finishes this specialist step. */
  protected readonly widgetCompletionTools: readonly string[] = [];

  // ── Optional hooks: agents can override as needed ─────────────────

  /**
   * Called before the main LLM loop. Returns an optional early response to short-circuit
   * the LLM call entirely, or a resolved user intent string to inject.
   */
  protected async preProcess(_state: AgentState): Promise<PreProcessResult> {
    return {};
  }

  /**
   * Called after the main LLM loop completes. Can modify the agent run result
   * (e.g., inject analytics insights into the response text).
   */
  protected async postProcess(
    _state: AgentState,
    result: AgentRunResult,
  ): Promise<AgentRunResult> {
    return result;
  }

  /**
   * Compute action buttons to attach to the final response based on tool results.
   * Override in each agent to provide agent-specific buttons.
   */
  protected buildActionButtons(
    _state: AgentState,
    _toolResults: ToolCallResult[],
  ): ActionButton[] {
    return [];
  }

  /**
   * Augment the returned partial AgentState beyond the base fields.
   * Override to return agent-specific state (e.g., leadInputs, leadWorkflowExecuted).
   */
  protected buildReturnState(
    _state: AgentState,
    _result: AgentRunResult,
  ): Partial<AgentState> {
    return {};
  }

  /**
   * The intent domain for this agent, used in extractUserIntent() when the agent
   * is entered via agent switch. Override if non-default.
   */
  protected get intentDomain(): string {
    return `tasks related to ${this.agentType.replace(/_/g, ' ')}`;
  }

  // ── Core execution (shared — NOT overridden by agents) ─────────────

  /**
   * Main agent runner. Called by the orchestrator with the current AgentState.
   * Returns a partial AgentState to be merged by the orchestrator.
   */
  async run(state: AgentState): Promise<Partial<AgentState>> {
    const { userId, threadId } = state;

    webSocketEmitter.emitAgentStatus(
      userId,
      this.agentType,
      'thinking',
      this.thinkingMessage,
      undefined,
      threadId,
    );

    // ── Step 1: Pre-processing hook ───────────────────────────────
    let resolvedUserIntent = '';
    try {
      const preResult = await this.preProcess(state);

      // Early exit — agent returns a canned response without calling LLM
      if (preResult.earlyResponse !== undefined) {
        const responseId = `${this.agentType}-${Date.now()}`;
        this._emitFinalResponse(
          userId,
          threadId,
          preResult.earlyResponse,
          preResult.earlyActionButtons ?? [],
          responseId,
        );
        webSocketEmitter.emitAgentStatus(userId, this.agentType, 'completed', 'Done', undefined, threadId);
        return {
          messages: [{ role: 'assistant', content: preResult.earlyResponse, agentType: this.agentType }],
          currentAgent: this.agentType,
          requiresApproval: state.requiresApproval,
          pendingApproval: state.pendingApproval,
          actionButtons: preResult.earlyActionButtons ?? [],
          lastResponseId: responseId,
          ...preResult.earlyState,
        };
      }

      resolvedUserIntent = preResult.resolvedUserIntent ?? '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.warn({ err, agentType: this.agentType }, '[BaseAgent] preProcess hook failed — continuing without it');
    }

    // Agent entry comes from orchestration state. The specialist sees the
    // original messages and memory rather than a second reconstructed intent.
    const isAgentSwitchEntry = state.currentAgent !== this.agentType;

    // ── Step 3: Build system prompt ───────────────────────────────
    const systemPrompt = this.buildSystemPrompt(state) + (state.intentAnalysis?.semanticRequest
      ? '\nCURRENT TURN SEMANTIC INTERPRETATION (structured request data, not authorization; tool results and ownership checks remain authoritative):\n'
        + JSON.stringify(state.intentAnalysis.semanticRequest)
      : '')
      + (dashboardOperationTools(state.intentAnalysis?.semanticRequest?.dashboardOperation) ? '\nDASHBOARD OPERATION: Use the available application tools for fresh saved data. Resolve exact owned file/operation/assistant IDs; never invent them or derive full workbook counts from truncated attachment text. Analysis creates a temporary preview. Review contact import opens its existing confirmation page. Neither imports contacts nor sends messages. Return the result and dashboard link without restarting ICP, search or campaign setup.\n' : '')
      + '\nREPLY PRESENTATION: The chat already displays your name and role above your message. Begin directly with the answer; do not prefix your reply with your name or a speaker label. Preserve names when they are part of requested content, such as a quoted conversation or draft.\n'
      + 'RECORD IDS: Use record IDs (ICP, lead, review, asset, campaign, workflow) only inside tool calls. In text the user reads, name things by what they are ("your ICP", "the 5 selected leads", "the WhatsApp review") and never quote internal IDs or numbers like "ID 189" or "#321".\n'
      + (state.intentAnalysis?.action === 'question' && (state.intentAnalysis.hiredAgents?.length ?? 0) > 1
        ? `COORDINATED QUESTION: You are ${getPersona(this.agentType).displayName}. Answer only your assigned specialty in your own message. Other specialists produce their own messages. Do not write their answers, a multi-speaker transcript, or a combined team summary.\n`
        : '');

    // ── Step 4: Prepare conversation messages (context isolation) ─
    const conversationMsgs = this._prepareMessages(state, resolvedUserIntent, isAgentSwitchEntry);

    // ── Step 5: Build tool context ────────────────────────────────
    const toolContext: ToolContext = {
      userId,
      threadId,
      workflowId: state.runContext?.runId || state.workflowId || undefined,
      runContext: state.runContext,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icpProfile: state.icpProfile as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      brandToolkit: state.brandToolkit as any,
      companyProfile: state.companyProfile,
      // ContentAgent attaches these after mandatory tenant-scoped resolution.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      brandContextPrompt: (state.brandToolkit as any)?.__brandContextPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      brandContextSnapshot: (state.brandToolkit as any)?.__brandContextSnapshot,
      leadInputs: state.leadInputs,
      selectedWorkflows: state.selectedWorkflows,
      selectedLeadIds: state.selectedLeadIds,
      pendingApproval: state.pendingApproval,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conversationHistory: state.messages as any[],
      savedToolActions: state.savedToolActions,
      intentAnalysis: state.intentAnalysis,
    };

    // ── Step 6: Main tool-calling loop ────────────────────────────
    try {
      const tools = { ...this.getTools(toolContext) };
      const operationTools=dashboardOperationTools(state.intentAnalysis?.semanticRequest?.dashboardOperation);
      if(operationTools)for(const name of Object.keys(tools))if(!operationTools.includes(name))delete tools[name];
      if (state.intentAnalysis?.action === 'question') {
        for (const name of Object.keys(tools)) if (!readOnlyCampaignTools.has(name)) delete tools[name];
      }
      if (this.agentType === 'lead_generation' && state.intentAnalysis?.leadSettingsRequested) {
        // Preparation is not execution consent, even if the model asks for an
        // execution tool. Keep only reads and search-settings generation.
        for (const name of Object.keys(tools)) {
          if (!readOnlyCampaignTools.has(name) && name !== 'generate_lead_inputs') delete tools[name];
        }
      }
      if (this.agentType === 'lead_generation' && state.intentAnalysis?.leadShortlistRequested) {
        for (const name of Object.keys(tools)) {
          if (!['get_lead_shortlist', 'query_leads', 'revise_lead_shortlist'].includes(name)) delete tools[name];
        }
      }
      const completedWidgetTool = completedWidgetToolToSuppress(state);
      if (completedWidgetTool && completedWidgetTool in tools) {
        delete tools[completedWidgetTool];
        logger.info(
          { agentType: this.agentType, toolName: completedWidgetTool, threadId },
          '[BaseAgent] Suppressed already-completed widget tool for continuation turn',
        );
      }
      const rawResult = await runToolCallingLoop({
        userId,
        threadId,
        systemPrompt,
        messages: conversationMsgs,
        agentType: this.agentType,
        tools,
        toolContext,
        temperature: 0.5,
        loggingContext: {
          purpose: this.agentType,
          service: `Mastra${this._toPascalCase(this.agentType)}Agent`,
        },
        onToolResult: (toolName, result) => this._handleToolResult(toolName, result, state, toolContext),
        signal: currentConversationRequest()?.signal,
        onToolCall: (toolName, args) => this._handleToolCall(toolName, args, state),
      });

      let result: AgentRunResult = {
        text: cleanResponseText(rawResult.text || '') || this._fallbackResponse(),
        toolResults: rawResult.toolResults,
      };

      // ── Step 7: Post-processing hook ──────────────────────────
      try {
        result = await this.postProcess(state, result);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.warn({ err, agentType: this.agentType }, '[BaseAgent] postProcess hook failed — using original result');
      }

      // Free-form action claims must be checked before they reach either the
      // stream or persisted state. Keep this outside the fail-open enrichment
      // hook above; a verifier failure must never restore the unchecked draft.
      const isUnchangedServerReceipt = rawResult.responseSource === 'server'
        && result.text === cleanResponseText(rawResult.text || '');
      if (!isUnchangedServerReceipt && !result.serverAuthored && ['content_studio', 'outreach', 'performance_marketing'].includes(this.agentType)) {
        result.text = await groundAgentResponse(state, result.text, result.toolResults, true, this.agentType);
      }

      if (
        !result.toolResults.some(toolResult => toolResult.toolName === 'tasks_completed' && toolResult.success)
        && shouldAutoCompleteWidgetContinuation(state, this.widgetCompletionTools, result.toolResults)
      ) {
        result = {
          ...result,
          toolResults: [
            ...result.toolResults,
            {
              toolName: 'tasks_completed',
              toolCallId: `widget-continuation-${state.widgetContinuation!.widgetId}`,
              result: {
                success: true,
                completed: true,
                summary: `Completed after verified ${state.widgetContinuation!.toolName} widget execution.`,
              },
              success: true,
            },
          ],
        };
      }

      // ── Step 8: Build action buttons ──────────────────────────
      const agentSpecificState = this.buildReturnState(state, result);
      // Only the controller's bound durable resolution clears an existing review.
      // Q&A/no-op turns must not erase it through specialist default false/nulls.
      if (state.pendingApproval && !agentSpecificState.pendingApproval) {
        agentSpecificState.pendingApproval = state.pendingApproval;
        agentSpecificState.requiresApproval = true;
        agentSpecificState.tasksCompleted = false;
      }
      const actionButtons = bindApprovalActions(
        state.intentAnalysis?.action === 'question' ? [] : this.buildActionButtons(state, result.toolResults),
        agentSpecificState.pendingApproval,
      );

      // ── Step 9: Emit final response via WebSocket ─────────────
      const team = state.intentAnalysis?.action === 'question' ? state.intentAnalysis.hiredAgents ?? [] : [];
      if (team.length > 1) {
        result.text = selectCampaignSpeakerReply(result.text, this.agentType, replySpeakers.filter(speaker => team.some(agent => agent === speaker.id)));
      }
      const speaker = replySpeakers.find(candidate => candidate.id === this.agentType);
      if (speaker) result.text = stripCampaignSpeakerLabel(result.text, speaker, replySpeakers);
      const responseId = `${this.agentType}-${Date.now()}`;
      const operationResults=result.toolResults.some(receipt=>receipt.success && receipt.result?.output?.card)
        ? operationCardsFromReceipts(result.toolResults,requireBusinessScope().businessProfileId) : [];
      this._emitFinalResponse(userId, threadId, result.text, actionButtons, responseId,operationResults);

      webSocketEmitter.emitAgentStatus(userId, this.agentType, rawResult.outcome ? 'error' : 'completed',
        rawResult.outcome ? result.text : 'Done', undefined, threadId);

      // ── Step 10: Build and return merged partial state ────────
      const tasksCompleted = result.toolResults.some(
        r => r.toolName === 'tasks_completed' && r.success,
      );

      return {
        messages: [{ role: 'assistant', content: result.text, agentType: this.agentType,metadata:{operationResults} }],
        currentAgent: this.agentType,
        requiresApproval: false,
        pendingApproval: null,
        actionButtons,
        toolResults: result.toolResults,
        lastResponseId: responseId,
        tasksCompleted,
        ...(rawResult.outcome ? { workflowOutcome: rawResult.outcome } : {}),
        ...agentSpecificState,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error instanceof ConversationRequestError) throw error;
      return this._handleError(error, userId, threadId, state);
    }
  }

  // ── Optional tool lifecycle hooks (for agents with complex logic) ─────

  /**
   * Called after each tool result is received. Override for per-tool side effects
   * (e.g., track state mutations, build approval objects).
   * Return value is ignored — use instance state to track side effects.
   */
  protected _handleToolResult(
    _toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _result: any,
    _state: AgentState,
    _toolContext: ToolContext,
  ): void {
    // No-op by default
  }

  /**
   * Called before each tool is executed.
   * Return false to block the tool call (e.g., guard against duplicate executions).
   */
  protected _handleToolCall(
    _toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _args: any,
    _state: AgentState,
  ): boolean {
    return true;
  }

  // ── Internal shared helpers ────────────────────────────────────────────

  /**
   * Emit the agent's final text response via WebSocket (the 2-chunk pattern:
   * content chunk + done marker with metadata).
   */
  protected _emitFinalResponse(
    userId: number,
    threadId: number,
    content: string,
    actionButtons: ActionButton[],
    responseId?: string,
    operationResults?:DashboardOperationResult[],
  ): void {
    if (!content?.trim()) return;
    const rid = responseId ?? `${this.agentType}-${Date.now()}`;
    webSocketEmitter.emitChatResponseChunk(userId, threadId, {
      chunk: content,
      role: 'assistant',
      done: false,
      agentType: this.agentType,
      responseId: rid,
      sequence: 1,
    });
    webSocketEmitter.emitChatResponseChunk(userId, threadId, {
      chunk: '',
      role: 'assistant',
      done: true,
      agentType: this.agentType,
      responseId: rid,
      sequence: 2,
      metadata: { actionButtons,...(operationResults?.length ? {operationResults} : {}) },
    });
  }

  /**
   * Prepare conversation messages with context isolation and optional intent injection.
   */
  private _prepareMessages(
    state: AgentState,
    resolvedUserIntent: string,
    isAgentSwitchEntry: boolean,
  ): Array<{ role: string; content: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filtered = prepareContextForAgent(state as any, this.agentType);
    const conversationMsgs: Array<{ role: string; content: string }> = [];

    for (const msg of filtered) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const role = typeof (msg as any).role === 'string' ? (msg as any).role : 'user';
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!content) continue;
      conversationMsgs.push({
        role: role === 'tool' ? 'assistant' : role,
        content,
      });
    }

    // Fallback: last 20 messages if context isolation returned nothing
    if (conversationMsgs.length === 0) {
      for (const msg of state.messages.slice(-20)) {
        if (msg.role === 'system') continue;
        conversationMsgs.push({
          role: msg.role === 'tool' ? 'assistant' : (msg.role as string),
          content: msg.content,
        });
      }
    }

    // Inject resolved intent when entered via agent switch
    if (resolvedUserIntent && isAgentSwitchEntry) {
      conversationMsgs.push({ role: 'system', content: 'Handoff context (not a new approval):\n' + resolvedUserIntent });
    }

    const pipelineRequest = automaticPipelineRequest(state);
    if (pipelineRequest) {
      conversationMsgs.push({
        role: 'user',
        content: `Continue the active campaign by carrying out this original user request:\n${pipelineRequest}`,
      });
    }

    return conversationMsgs;
  }

  /**
   * Handle errors from the main tool-calling loop.
   * Provider fallback already happens inside each completion, preserving receipts.
   */
  private _handleError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    error: any,
    userId: number,
    threadId: number,
    _state: AgentState,
  ): Partial<AgentState> {
    const providerFailure = error instanceof LLMProviderResponseError;
    const failure = providerFailure ? classifyLLMProviderFailure(error) : undefined;
    logger.error(providerFailure
      ? {
        agentType: this.agentType,
        provider: error.provider,
        failureCategory: failure?.category,
        failureStatus: failure?.status,
      }
      : { err: error, agentType: this.agentType },
    `[${this.agentType}] Agent execution failed`);

    const errorMsg = error instanceof ContextBudgetExceededError
      ? error.message
      : providerFailure
        ? safeLLMProviderFailureMessage(error, error.provider)
        : `I encountered an issue. Please try again.`;
    const responseId = `${this.agentType}-${Date.now()}`;
    this._emitFinalResponse(userId, threadId, errorMsg, [], responseId);

    return {
      messages: [{ role: 'assistant', content: errorMsg, agentType: this.agentType }],
      currentAgent: this.agentType,
      lastResponseId: responseId,
      error: errorMsg,
      tasksCompleted: false,
      workflowOutcome: 'failed',
    };
  }

  /** Default fallback when the LLM returns empty text and no tools ran. */
  protected _fallbackResponse(): string {
    return `I'm ready to help. What would you like to do?`;
  }

  /** Convert snake_case to PascalCase for service names (e.g. lead_generation → LeadGeneration). */
  private _toPascalCase(s: string): string {
    return s.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  }
}
