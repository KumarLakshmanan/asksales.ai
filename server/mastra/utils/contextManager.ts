import { FailureCooldown } from '../../utils/failureCooldown.js';
const inlineCompactionCooldown = new FailureCooldown();
/**
 * Context Manager — Implements the four context engineering strategies
 * from CONTEXT_MANAGEMENT.md for the agent system.
 *
 * Strategies:
 *   1. Write Context  — Scratchpad for agent notes and key decisions
 *   2. Select Context — Agent-specific message filtering and state isolation
 *   3. Compress Context — Message trimming, tool output compression, inline compaction
 *   4. Isolate Context — Each agent sees only relevant messages and state
 */

// ── LangChain-free message types ─────────────────────────────────────────────
// Duck-typed replacements for BaseMessage, AIMessage, SystemMessage, ToolMessage.
// Any object with { role, content } works. _getType() is supported for backward compat.

import { getIcpCompleteness } from '../../utils/icpCompleteness.js';

interface SimpleMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  agentType?: string;
  _getType?: () => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

type BaseMessage = SimpleMessage;

function getMessageType(msg: BaseMessage): string {
  if (typeof msg._getType === 'function') return msg._getType();
  if (msg.role === 'assistant') return 'ai';
  if (msg.role === 'system') return 'system';
  if (msg.role === 'user' || msg.role === 'human') return 'human';
  if (msg.role === 'tool') return 'tool';
  return msg.role || 'unknown';
}

function SystemMessage(content: string): BaseMessage {
  return { role: 'system', content, _getType: () => 'system' };
}

import type { AgentState, AgentType } from '../state';
import {
  AGENT_TOOL_RESULTS_LIMIT,
  TOOL_OUTPUT_INLINE_MAX_CHARS,
  INLINE_COMPACT_KEEP_RECENT,
  PRE_PROCESSING_COMPACT_PERCENT,
  SCRATCHPAD_MAX_ENTRIES,
  SCRATCHPAD_ENTRY_MAX_CHARS,
  SYSTEM_PROMPT_OVERHEAD_TOKENS,
  AGENT_LIMIT_MULTIPLIERS,
  getContextWindowForModel,
} from '../../utils/chatConstants';
import { countMessageTokens } from '../../utils/tokenCounter';
import { getModelContextWindow } from '../../services/GenAIPricingService';
import { logger } from '../../utils/logger.js';
import { compactToolResult, HISTORICAL_RECEIPT_MARKER } from './toolResultContext.js';
import { createCompletionWithProviderFallback } from './providerCompletion.js';
import { conversationSummarySchema, CONVERSATION_SUMMARY_PROMPT } from './conversationSummary.js';

// ─── 1. WRITE CONTEXT (Scratchpad) ──────────────────────────────────────────────

/**
 * Create a scratchpad entry for an agent to persist reasoning notes.
 * Returns state update to merge into AgentState.
 */
export function writeScratchpad(
  agentType: AgentType,
  note: string,
): { scratchpad: Record<string, string[]> } {
  const truncated = note.length > SCRATCHPAD_ENTRY_MAX_CHARS
    ? note.slice(0, SCRATCHPAD_ENTRY_MAX_CHARS) + '…'
    : note;
  return {
    scratchpad: { [agentType]: [truncated] },
  };
}

/**
 * Read scratchpad notes for a specific agent from state.
 */
export function readScratchpad(
  state: AgentState,
  agentType: AgentType,
): string[] {
  return state.scratchpad?.[agentType] ?? [];
}

/**
 * Build a scratchpad context string for an agent's system prompt.
 */
export function buildScratchpadContext(state: AgentState, agentType: AgentType): string {
  const notes = readScratchpad(state, agentType);
  if (notes.length === 0) return '';
  const recentNotes = notes.slice(-SCRATCHPAD_MAX_ENTRIES);
  return `\n[AGENT SCRATCHPAD — your previous notes]\n${recentNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n`;
}

// ─── 2. SELECT CONTEXT (Agent-Specific Message Filtering) ───────────────────────

/**
 * Select chronological turns using measured tokens, never domain keywords.
 * Keep system memory and complete recent user turns; never orphan tool results.
 * Oversized current turns are retained intact and rejected by the caller's budget
 * check instead of silently losing a late constraint.
 */
export function selectMessagesForAgent(
  messages: BaseMessage[], agentType: AgentType, modelName?: string,
): BaseMessage[] {
  const clean = messages.flatMap(msg => {
    const metadata = msg.additional_kwargs?.metadata || msg.metadata;
    if (metadata?.isToolResult && metadata.toolOutput !== undefined) {
      return [{ role: 'assistant', content: HISTORICAL_RECEIPT_MARKER + ' ' + compactToolResult({
        toolName: metadata.toolName, success: metadata.success, output: metadata.toolOutput,
      }) }];
    }
    return metadata?.isToolCall || metadata?.isToolResult || metadata?.partialIterationText ? [] : [msg];
  });
  const pinned = clean.filter(m => getMessageType(m) === 'system');
  const turns: BaseMessage[][] = [];
  for (const msg of clean.filter(m => getMessageType(m) !== 'system')) {
    if (!turns.length || getMessageType(msg) === 'human') turns.push([]);
    turns[turns.length - 1].push(msg);
  }
  const budget = contextBudget(agentType, modelName);
  let used = countMessageTokens(pinned);
  const selected: BaseMessage[][] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = countMessageTokens(turns[i]);
    if (selected.length && used + cost > budget) break;
    selected.unshift(turns[i]);
    used += cost;
  }
  if (selected.length < turns.length) {
    logger.warn({ event: 'context_constraint_retention_risk', agentType, omittedTurns: turns.length - selected.length,
      retainedTurns: selected.length, tokenBudget: budget, usedTokens: used }, '[ContextManager] Context limit requires checking historical constraints');
    pinned.push(SystemMessage(
      '[CONTEXT LIMIT] Some older turns are omitted. Historical memory may be incomplete. Ask for missing constraints before dependent actions; do not infer approval.',
    ));
  }
  return [...pinned, ...selected.flat()];
}

// ─── 3. COMPRESS CONTEXT (Tool Output & Message Trimming) ───────────────────────

/**
 * Compress verbose tool output messages in the message array.
 * Tool outputs (ToolMessage or AI messages with tool results) that exceed
 * TOOL_OUTPUT_INLINE_MAX_CHARS are truncated with a summary marker.
 */
export function compressToolOutputs(messages: BaseMessage[]): BaseMessage[] {
  return messages.map(msg => {
    if (getMessageType(msg) !== 'tool' || typeof msg.content !== 'string') return msg;
    try { return { ...msg, content: compactToolResult(JSON.parse(msg.content), TOOL_OUTPUT_INLINE_MAX_CHARS) }; }
    catch { return msg; } // Never corrupt non-JSON receipts by slicing them.
  });
}

/**
 * Estimate token count for a message array.
 * Uses proper BPE tokenization via js-tiktoken for accurate counts.
 */
export function estimateTokens(messages: BaseMessage[]): number {
  return countMessageTokens(messages) + SYSTEM_PROMPT_OVERHEAD_TOKENS;
}

/**
 * Check if pre-processing compaction is needed before running the graph.
 * Returns true if estimated token usage exceeds PRE_PROCESSING_COMPACT_PERCENT
 * of the model's context window.
 */
export function shouldCompactBeforeProcessing(
  messages: BaseMessage[],
  modelName: string,
): boolean {
  const contextWindow = getContextWindowForModel(modelName);
  const estimatedTokens = estimateTokens(messages);
  const usagePercent = (estimatedTokens / contextWindow) * 100;

  if (usagePercent >= PRE_PROCESSING_COMPACT_PERCENT || estimatedTokens >= contextBudget('supervisor', modelName) * 0.85) {
    logger.info({
      estimatedTokens,
      contextWindow,
      usagePercent: Math.round(usagePercent),
      threshold: PRE_PROCESSING_COMPACT_PERCENT,
    }, '[ContextManager] Pre-processing compaction recommended');
    return true;
  }
  return false;
}

/** Legacy synchronous API: no heuristic summaries or invented tool outcomes. */
export function compactMessagesInline(messages: BaseMessage[]): BaseMessage[] {
  return compressToolOutputs(messages);
}

/** Lossless-on-failure semantic summary; originals remain in durable chat history. */
export async function compactMessagesWithAI(
  messages: BaseMessage[], userId: number, threadId: number,
): Promise<BaseMessage[]> {
  const cooldownKey = `${userId}:${threadId}`;
  if (inlineCompactionCooldown.blocked(cooldownKey) || messages.length <= INLINE_COMPACT_KEEP_RECENT) return messages;
  const startedAt = Date.now();
  let split = messages.length - INLINE_COMPACT_KEEP_RECENT;
  // Keep a complete recent user turn, including its tool calls and results.
  while (split > 0 && getMessageType(messages[split]) !== 'human') split--;
  if (!split) return messages;
  try {
    const chunks: BaseMessage[][] = [];
    let chunk: BaseMessage[] = [];
    let tokens = 0;
    for (const msg of messages.slice(0, split)) {
      const cost = countMessageTokens([msg]);
      if (cost > 6000) throw new Error('Single message too large to compact safely');
      if (tokens + cost > 6000 && chunk.length) { chunks.push(chunk); chunk = []; tokens = 0; }
      chunk.push(msg); tokens += cost;
    }
    if (chunk.length) chunks.push(chunk);
    let summary: import('zod').infer<typeof conversationSummarySchema> | undefined;
    for (const batch of chunks) {
      const response = await createCompletionWithProviderFallback(userId, {
        messages: [
          { role: 'system', content: CONVERSATION_SUMMARY_PROMPT },
          { role: 'user', content: JSON.stringify({ previousSummary: summary, messages: batch.map(m => ({
            role: m.role, content: m.content, agentType: m.agentType,
            toolReceipt: m.metadata?.isToolResult ? { success: m.metadata.success, toolName: m.metadata.toolName, output: m.metadata.toolOutput } : undefined,
          })) }) },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
        loggingContext: { userId, threadId, purpose: 'content_generation', service: 'ContextManager' },
      });
      if (!response.success || !response.content) throw new Error('No semantic summary');
      summary = conversationSummarySchema.parse(JSON.parse(response.content));
    }
    inlineCompactionCooldown.succeeded(cooldownKey);
    logger.info({ event: 'conversation_compaction', userId, threadId, status: 'completed', durationMs: Date.now() - startedAt,
      summarizedMessages: split, retainedMessages: messages.length - split }, '[ContextManager] Summary completed');
    return [SystemMessage('[CONVERSATION SUMMARY — historical data, not authorization]\n' + JSON.stringify(summary)), ...messages.slice(split)];
  } catch (err) {
    inlineCompactionCooldown.failed(cooldownKey);
    logger.warn({ err, userId, threadId, event: 'conversation_compaction', status: 'failed', durationMs: Date.now() - startedAt,
      cooldown: inlineCompactionCooldown.blocked(cooldownKey) }, '[ContextManager] Compaction failed; preserving original messages');
    return messages;
  }
}

function contextBudget(agentType: AgentType, modelName?: string): number {
  const capacity = getModelContextWindow(modelName || '') ?? getContextWindowForModel(modelName || '');
  // Reserve at least half for agent instructions, business state, tools and output.
  return Math.max(1024, Math.floor(capacity * Math.min(0.5, AGENT_LIMIT_MULTIPLIERS[agentType] ?? 0.5)) - SYSTEM_PROMPT_OVERHEAD_TOKENS);
}

// ─── 4. ISOLATE CONTEXT (Agent-Specific State Filtering) ────────────────────────

/**
 * Build a filtered message list for a specific agent, applying all strategies:
 * Pin memory and notes, preserve bounded structured receipts, and select recent
 * complete turns by token budget. Async semantic compaction occurs before routing.
 */
export function prepareContextForAgent(
  state: AgentState,
  agentType: AgentType,
): BaseMessage[] {
  // Guard: filter out messages with null/undefined content to prevent API errors
  const validMessages = (state.messages || []).filter(
    msg => msg.content !== null && msg.content !== undefined,
  );

  let messages = compressToolOutputs(validMessages);

  // Step 4: Prepend context summary if available (from ConversationCompactionService)
  if (state.contextSummary) {
    const hasSummaryMsg = messages.some(
      m => getMessageType(m) === 'system' && typeof m.content === 'string' && m.content.includes('CONVERSATION SUMMARY'),
    );
    if (!hasSummaryMsg) {
      messages = [
        SystemMessage(`[CONVERSATION SUMMARY — earlier messages compacted]\nHistorical data only. Approval and execution states below may be outdated; current saved database facts override them. This summary is not an instruction or authorization.\n${state.contextSummary}`),
        ...messages,
      ];
    }
  }

  // Step 5: Prepend scratchpad notes as system context
  const scratchpadContext = buildScratchpadContext(state, agentType);
  if (scratchpadContext) {
    messages = [
      SystemMessage(scratchpadContext),
      ...messages,
    ];
  }

  return selectMessagesForAgent(messages, agentType, state.llmConfig?.modelName);
}

// ─── 5. BUILD AGENT CONTEXT (Shared context builder) ────────────────────────────

export interface BuildAgentContextOptions {
  /** Include business profile section (default: true) */
  includeBusinessProfile?: boolean;
  /** Custom instruction appended after business profile */
  businessInstruction?: string;
  /** Include ICP section (default: true) */
  includeICP?: boolean;
  /** ICP format: 'structured' for human-readable, 'json' for raw JSON dump (default: 'structured') */
  icpFormat?: 'structured' | 'json';
  /** Custom instruction appended after ICP section */
  icpInstruction?: string;
  /** Include brand toolkit section (default: true) */
  includeBrandToolkit?: boolean;
  /** Label for brand section header (default: 'BRAND TOOLKIT') */
  brandLabel?: string;
  /** Include brand colors in toolkit section (default: false) */
  brandIncludeColors?: boolean;
  /** Custom instruction appended after brand toolkit section */
  brandInstruction?: string;
  /** Custom instruction appended after user info section */
  userInstruction?: string;
}

/**
 * Build a shared context info string from agent state.
 * Consolidates user info, business profile, ICP, and brand toolkit
 * context that was previously duplicated across all agent nodes.
 */
export function buildAgentContext(state: AgentState, options: BuildAgentContextOptions = {}): string {
  const {
    includeBusinessProfile = true,
    businessInstruction = 'Personalize your responses to this business.',
    includeICP = true,
    icpFormat = 'structured',
    icpInstruction = 'Use this ICP data in your responses.',
    includeBrandToolkit = true,
    brandLabel = 'BRAND TOOLKIT',
    brandIncludeColors = false,
    brandInstruction = 'Follow these brand guidelines.',
    userInstruction = 'Address the user by their first name in your responses.',
  } = options;

  let context = '';

  // User info
  if (state.companyProfile?.userName) {
    context += `\nUSER: ${state.companyProfile.userName}${state.companyProfile.userEmail ? ` (${state.companyProfile.userEmail})` : ''}\n${userInstruction}`;
  }

  // Business profile
  if (includeBusinessProfile && state.companyProfile) {
    context += `\nBUSINESS PROFILE:`;
    context += `\n- Company: ${state.companyProfile.companyName || 'Not set'}`;
    if (state.companyProfile.workspaceType) context += `\n- Workspace type: ${state.companyProfile.workspaceType}`;
    if (state.companyProfile.applicationUses?.length) context += `\n- Application uses: ${state.companyProfile.applicationUses.join(', ')}`;
    if (state.companyProfile.setupGoal) context += `\n- First goal: ${state.companyProfile.setupGoal}`;
    if (state.companyProfile.currentTools) context += `\n- Current tools: ${state.companyProfile.currentTools}`;
    if (state.companyProfile.industry) context += `\n- Industry: ${state.companyProfile.industry}`;
    if (state.companyProfile.description) context += `\n- Description: ${state.companyProfile.description}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((state.companyProfile as any).website) context += `\n- Website: ${(state.companyProfile as any).website}`;
    if (state.companyProfile.customerType) context += `\n- Customer Type: ${state.companyProfile.customerType}`;
    if (state.companyProfile.primaryMarket) context += `\n- Primary Market: ${state.companyProfile.primaryMarket}`;
    if (state.companyProfile.targetRegions?.length) context += `\n- Target Regions: ${state.companyProfile.targetRegions.join(', ')}`;
    if (state.companyProfile.businessGoals?.length) context += `\n- Business Goals: ${state.companyProfile.businessGoals.join(', ')}`;
    if (state.companyProfile.brandTone) context += `\n- Brand Tone: ${state.companyProfile.brandTone}`;
    context += `\n\nIMPORTANT: ${businessInstruction}`;
  }

  // ICP
  if (includeICP && state.icpProfile) {
    const icp = state.icpProfile;
    const approved = icp.approved === true && icp.revision != null && icp.approvedRevision === icp.revision;
    context += `\nCURRENT SAVED ICP STATUS: id=${icp.id ?? 'unknown'}, revision=${icp.revision ?? 'unknown'}, approvedRevision=${icp.approvedRevision ?? 'none'}, approval=${approved ? 'approved' : 'not approved'}. This current record supersedes older summary claims; ICP approval does not authorize content or outreach.`;
    const completeness = getIcpCompleteness(icp);
    const savedScore = typeof icp.fitScore === 'number' && Number.isFinite(icp.fitScore) ? icp.fitScore : completeness.score;
    context += `\nICP COMPLETENESS FACTS: ${JSON.stringify({ ...completeness, score: savedScore, scoreSource: 'saved_profile' })}. The fit score measures filled fields, not conversion likelihood or target quality. The saved score is authoritative for this revision; older revisions may use a legacy scoring formula. Explain only missing fields from this list; never describe filled fields as missing. Do not recalculate or replace the saved score during a question.`;
    if (icpFormat === 'json') {
      context += `\nCURRENT ICP PROFILE:\n${JSON.stringify(state.icpProfile, null, 2)}\n\n${icpInstruction}`;
    } else {
      context += `\nTARGET AUDIENCE (ICP):`;
      context += `\n- Industry: ${state.icpProfile.industry || 'Not specified'}`;
      context += `\n- Target: ${state.icpProfile.targetAudience || 'Not specified'}`;
      if (state.icpProfile.primaryJobTitles?.length) context += `\n- Job Titles: ${state.icpProfile.primaryJobTitles.join(', ')}`;
      if (state.icpProfile.primaryRegions?.length) context += `\n- Locations: ${state.icpProfile.primaryRegions.join(', ')}`;
      context += `\n- Pain Points: ${state.icpProfile.primaryPainPoint || 'Not specified'}`;
      context += `\n- Value Prop: ${state.icpProfile.primaryValueProposition || 'Not specified'}`;
      context += `\n\n${icpInstruction}`;
    }
  }

  // Brand toolkit
  if (includeBrandToolkit && state.brandToolkit) {
    context += `\n\n${brandLabel}:`;
    context += `\n- Brand: ${state.brandToolkit.name}`;
    if (brandIncludeColors) {
      context += `\n- Primary Color: ${state.brandToolkit.primaryBrandColor || 'Not set'}`;
      context += `\n- Secondary Color: ${state.brandToolkit.secondaryBrandColor || 'Not set'}`;
    }
    context += `\n- Voice/Tone: ${state.brandToolkit.voiceType || 'Professional'}`;
    context += `\n- CTAs: ${state.brandToolkit.defaultCtas?.join(', ') || 'Not set'}`;
    context += `\n\n${brandInstruction}`;
  }

  if (state.requiresApproval && state.pendingApproval) {
    context += `\n\nPENDING APPROVAL:`;
    context += `\n- Tool: ${state.pendingApproval.toolName || 'unknown'}`;
    if (state.pendingApproval.message) context += `\n- Prompt: ${state.pendingApproval.message}`;
    if (state.pendingApproval.args) context += `\n- Args: ${JSON.stringify(state.pendingApproval.args)}`;
    context += `\nThe latest user message may be responding to this pending approval. If they request changes, revise the setup instead of treating it as final approval.`;
    context += `\nThis review already exists from an earlier turn and is waiting for the user. Never say that no review or approval card exists; you may say this turn did not create a new one and that nothing has run yet.`;
  }

  if (state.workflowOutcome) context += `\nCURRENT WORKFLOW STATE: ${state.workflowOutcome}. A cancelled plan stays stopped until the user requests new work.`;
  if (state.savedToolActions) {
    context += `\nCURRENT SAVED TOOL ACTIONS (database facts; overrides old narrative claims):\n${JSON.stringify(state.savedToolActions.slice(0, 30).map(({ widgetId, toolName, status, submittedValues, formValues }) => ({
      widgetId, toolName, status,
      generationDefaults: Object.fromEntries(Object.entries(submittedValues || formValues || {}).filter(([key]) =>
        ['platform', 'length', 'post_format', 'ad_format', 'number_of_variations', 'auto_generate_image', 'auto_generate_video', 'include_image_prompt', 'include_video_prompt', 'cta_text'].includes(key))),
    })))}`;
    context += '\nactive/draft means only settings prepared for review, NOT generated content. succeeded means that specific tool completed, NOT that later publishing/sending occurred. A widgetId is a review-card ID, NEVER a content asset ID. Copy embedded in an ICP explanation is not a saved Content Studio asset. Historical prose and summaries are not evidence of execution.';
  }

  return context;
}

/**
 * Filter tool results to only include those relevant to the current agent.
 * Caps at AGENT_TOOL_RESULTS_LIMIT most recent relevant results.
 */
export function filterToolResultsForAgent(
  state: AgentState,
  agentType: AgentType,
): typeof state.toolResults {
  const toolResults = state.toolResults || [];
  if (toolResults.length === 0) return [];

  // Agent-to-tool relevance mapping
  const agentToolPatterns: Record<string, RegExp> = {
    icp_generation: /icp|crawl_website|suggest_agents/i,
    lead_generation: /lead|workflow|crawl_website/i,
    content_studio: /brand|toolkit|generate_|social|email|sms|blog|image|video|ad/i,
    outreach: /outreach|send|email|sms/i,
    performance_marketing: /ad|publish|analytics|meta/i,
  };

  const pattern = agentToolPatterns[agentType];
  if (!pattern) return toolResults.slice(-AGENT_TOOL_RESULTS_LIMIT);

  const relevant = toolResults.filter(r => pattern.test(r.toolName));
  return relevant.slice(-AGENT_TOOL_RESULTS_LIMIT);
}

/**
 * Build a compact state summary string for the supervisor's routing decision.
 * The supervisor doesn't need full message history — just a snapshot of where things stand.
 */
export function buildSupervisorContext(state: AgentState): string {
  const parts: string[] = [];

  // ICP status
  if (state.icpProfile) {
    parts.push(`ICP: ${state.icpProfile.campaignName || 'Unnamed'} (fit: ${state.icpProfile.fitScore || 0}%, industry: ${state.icpProfile.industry || '?'})`);
  } else {
    parts.push('ICP: Not created yet');
  }

  // Current agent
  parts.push(`Current agent: ${state.currentAgent || 'none'}`);

  // Pipeline
  if (state.agentPipeline?.length) {
    parts.push(`Pipeline: ${state.agentPipeline.join(' → ')} (step ${(state.agentPipelineIndex || 0) + 1}/${state.agentPipeline.length})`);

    const pendingPipelineIndex = state.agentPipelineIndex || 0;
    if (pendingPipelineIndex > 0 && pendingPipelineIndex < state.agentPipeline.length) {
      parts.push(`Pending pipeline agent: ${state.agentPipeline[pendingPipelineIndex]}`);
    }
  }

  if (state.requiresApproval && state.pendingApproval) {
    parts.push(`Pending approval: ${state.pendingApproval.toolName || 'unknown'} (${state.pendingApproval.message || 'awaiting user response'})`);
  }

  // Recent tool actions
  const recentTools = (state.toolResults || []).slice(-3);
  if (recentTools.length > 0) {
    parts.push(`Recent tools: ${recentTools.map(t => `${t.toolName}(${t.success ? '✓' : '✗'})`).join(', ')}`);
  }

  // Brand toolkit
  if (state.brandToolkit) {
    parts.push(`Brand toolkit: ${state.brandToolkit.name}`);
  }

  return parts.join('\n');
}
