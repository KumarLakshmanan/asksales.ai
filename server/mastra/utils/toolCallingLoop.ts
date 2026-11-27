import { orderedToolCalls, parseToolArguments, type FunctionToolCall } from '../../utils/orderedToolCalls.js';
import { checkpointConversationRequest, ConversationRequestError } from '../../services/ConversationRequestCoordinator.js';
import { assertContextFits } from './contextBudget.js';
import { compactToolResult, hasHistoricalReceiptEcho } from './toolResultContext.js';
import {preparedOutreachEvidence} from './dashboardOperationEvidence.js';
import { applyEmailReviewDefaults, enforceSocialPostMediaConstraints, scopeGenerationRequest } from './contentRequestConstraints.js';
import { enforceAdRequestConstraints, removeAmbiguousSavedCampaignSelection } from './adRequestConstraints.js';
/**
 * Tool Calling Loop Utility
 * Uses LLMProviderFactory directly with OpenAI-format function calling.
 *
 * This bypasses Mastra's Agent.generate() which has model resolution issues.
 * Instead, it uses our existing LLMProviderFactory (OpenAI/OpenRouter/Custom)
 * with manual tool execution loop — the same pattern the original LangGraph agents used.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { LLMProviderFactory } from '../../services/agents/LLMProviderFactory.js';
import { LLMProviderResponseError } from '../../services/agents/LLMProviderErrors.js';
import { webSocketEmitter } from '../../services/agents/WebSocketEmitter.js';
import { createChatMessage } from '../../models/chatMessages/functions.js';
import { logger } from '../../utils/logger.js';
import { userFacingReason } from '../../../shared/userFacingError.js';
import { humanizeToolName } from './technicalTerms.js';
import { toolMetadata, type ToolContext } from '../tools/toolRegistry.js';
import { toolHasWidget, getWidgetTypeForTool } from '../../shared/toolWidgetMap.js';
import { WidgetStateModel } from '../../models/widgetStates/functions.js';
import { normalizeToolExecutionResult } from '../../utils/toolExecutionResult.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface ToolCallResult {
  toolName: string;
  toolCallId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  success: boolean;
  error?: string;
}

export interface ToolLoopOptions {
  userId: number;
  threadId: number;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  /** Dict of Mastra createTool objects (same format used by agents) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  toolContext: ToolContext;
  agentType: string;
  maxIterations?: number;
  /** A caller may lower, but never raise, the server's per-turn call ceiling. */
  maxToolCalls?: number;
  temperature?: number;
  /** Called when a tool result is received */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onToolResult?: (toolName: string, result: any) => void | Promise<void>;
  /** Called when a tool is about to be called. Return false to block the tool call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onToolCall?: (toolName: string, args: any) => boolean | void | Promise<boolean | void>;
  /** Checked before generation and each uncommitted tool boundary. */
  signal?: AbortSignal;
  /** Logging context for LLM calls */
  loggingContext?: { purpose: string; service: string };
}

export interface ToolLoopResult {
  /** Final text response from the LLM */
  text: string;
  /** All tool results from the conversation */
  toolResults: ToolCallResult[];
  /** Full message history including tool calls and results */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  /** Explicit terminal outcome when the loop could not reach a final model response. */
  outcome?: 'gated' | 'timed_out' | 'failed' | 'cancelled';
  /** Only server-authored status receipts may bypass model-claim grounding. */
  responseSource?: 'model' | 'server';
  stopReason?: 'deadline' | 'call_limit' | 'iteration_limit' | 'cancelled' | 'invalid_tool_calls' | 'repeated_failure';
}

/** Same step, same error, twice in one turn: a third try will not help. */
export function findRepeatedFailure(results: Array<{ toolName: string; success: boolean; error?: string }>): { toolName: string; error: string } | null {
  const seen = new Set<string>();
  for (const result of results) {
    if (result.success || !result.error) continue;
    const key = `${result.toolName}|${String(result.error).toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) return { toolName: result.toolName, error: result.error };
    seen.add(key);
  }
  return null;
}

class ToolLoopStop extends Error {
  constructor(readonly outcome: NonNullable<ToolLoopResult['outcome']>,
    readonly stopReason: NonNullable<ToolLoopResult['stopReason']>, message: string) { super(message); }
}

// ── Convert Mastra createTool dict → OpenAI function calling format ────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mastraToolsToOpenAI(tools: Record<string, any>) {
  return Object.entries(tools).map(([name, tool]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parameters: any = { type: 'object', properties: {}, required: [] };
    try {
      const schema = tool.inputSchema || tool.schema;
      if (schema) {
        // These are non-strict function tools. The converter's openAi target
        // emits draft-4 boolean exclusive bounds (rejected by providers) and
        // turns optional inputs into required nullable values that Zod rejects.
        // Draft 7 preserves the runtime contract and emits numeric bounds.
        const jsonSchema = '_zod' in schema
          ? z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' })
          : zodToJsonSchema(schema, { target: 'jsonSchema7' });
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
        const { $schema, ...rest } = jsonSchema as any;
        parameters = rest;
      }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      logger.warn({ toolName: name }, '[ToolLoop] Failed to convert tool schema');
    }
    return {
      type: 'function' as const,
      function: {
        name,
        description: tool.description || `Execute ${name}`,
        parameters,
      },
    };
  });
}

// ── Execute a single tool call ─────────────────────────────────────────

async function executeTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any,
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parsedArgs: any,
  toolContext: ToolContext,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  // Build a minimal mastra-like object that the tool execute functions expect
  const fakeMastra = { __toolContext: toolContext };
  return tool.execute(parsedArgs, { mastra: fakeMastra });
}

/** Unstarted outreach reviews that a new draft for the same channel and
 * exact recipient set replaces. Different channels or recipients are separate
 * campaigns and keep their own cards. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sameOutreachReviews(widgets: any[], toolName: string, userId: number, threadId: number, args: any): any[] {
  if (toolName !== 'send_outreach_messages') return [];
  const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(Number).filter(Number.isSafeInteger))].sort((a, b) => a - b).join(',') : '';
  const recipients = ids(args?.lead_ids);
  const channel = String(args?.channel || '');
  if (!recipients || !channel) return [];
  return widgets.filter(widget => widget.toolName === toolName && widget.userId === userId && widget.threadId === threadId
    && ['active', 'draft'].includes(widget.status)
    && String(widget.formValues?.channel || '') === channel && ids(widget.formValues?.lead_ids) === recipients);
}

const GENERATED_LABELS: Record<string, string> = {
  generate_email_template: 'email', generate_sms_template: 'SMS message', generate_whatsapp_template: 'WhatsApp message',
  generate_social_media_post: 'social post', generate_social_chat_template: 'social message', generate_blog_post: 'blog post',
  generate_image: 'image', generate_image_from_image: 'image', generate_video: 'video', generate_video_from_image: 'video',
};
const CHANNEL_LABELS: Record<string, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', twitter: 'X (Twitter)' };

/** One plain sentence about what a review card holds, from its saved form
 * values. Never claims the action ran. Null when the tool has no summary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reviewCardSummary(toolName: string, card?: { args?: any; replacedWidgetId?: number }): string | null {
  const args = card?.args || {};
  const quote = (value: unknown) => typeof value === 'string' && value.trim() ? `"${value.trim().replace(/\s+/g, ' ').slice(0, 90)}"` : null;
  if (toolName === 'send_outreach_messages') {
    const count = Array.isArray(args.lead_ids) ? new Set(args.lead_ids).size : 0;
    const channel = CHANNEL_LABELS[String(args.channel)] || 'Outreach';
    const parts = [`${channel} outreach to ${count} selected ${count === 1 ? 'lead' : 'leads'} is ready for review in the card below`];
    const subject = args.channel === 'email' ? quote(args.subject) : null;
    if (subject) parts[0] += `, with the subject ${subject}`;
    const when = typeof args.scheduled_for === 'string' && !Number.isNaN(Date.parse(args.scheduled_for)) ? new Date(args.scheduled_for).toUTCString().replace(' GMT', ' UTC') : null;
    return `${parts[0]}.${card?.replacedWidgetId ? ' It replaces the earlier draft for the same recipients.' : ''} Check the recipients and message, then select **Confirm and run** to ${when ? `schedule it for ${when}` : 'send it'}. Nothing has been sent yet.`;
  }
  const label = GENERATED_LABELS[toolName];
  if (label) {
    const count = Number(args.variation_count ?? args.count ?? args.number_of_images ?? args.number_of_videos);
    const what = Number.isInteger(count) && count > 1 ? `${count} ${label}${label.endsWith('s') ? '' : 's'}` : `the ${label}`;
    return `The settings for ${what} are ready for review in the card below. Select **Confirm and run** to generate ${Number.isInteger(count) && count > 1 ? 'them' : 'it'}. Nothing has been generated yet.`;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pendingWidgetResponse(toolNames: string[], cards: Array<{ args?: any; replacedWidgetId?: number }> = []): string {
  if (toolNames.length === 1 && toolNames[0] === 'stop_ads') {
    return 'Check the exact campaign and platforms in the Stop ads card. Select **Confirm and run** to cancel their queued launches and request provider pauses. No ads have been stopped by creating this card.';
  }
  if (toolNames.length === 1 && toolNames[0] === 'publish_ads') {
    return 'Review the campaign settings in the card and select **Prepare saved campaign review**. Check the saved draft and readiness results before giving final approval with **Confirm and run**. No ads have been published or activated by creating this card.';
  }
  if (toolNames.length === 1 && toolNames[0] === 'generate_ad') {
    return 'The ad settings are ready for review in the Create Ad Copy card below. Select **Confirm and run** to generate and save the ad creative. No ad creative has been generated yet.';
  }
  if (toolNames.length === 1) {
    const summary = reviewCardSummary(toolNames[0], cards[0]);
    if (summary) return summary;
    return 'The settings are ready for review in the task card below. Select **Confirm and run** to start the action. The action has not run yet.';
  }
  return 'The requested settings are ready in the review cards below. Confirm each card to start its action. None of these actions has run yet.';
}

/**
 * Models occasionally describe a review card in prose after a read-only
 * prerequisite lookup instead of calling the widget-backed tool. Give that
 * protocol mistake one bounded correction inside the tool loop so the caller
 * can still create the real durable review. The response-grounding guard
 * remains the final fail-closed boundary if the corrected response repeats the
 * claim or no applicable tool is available.
 */
function assertsPreparedReview(text: string): boolean {
  const prose = text.replace(/[*_`]/g, '');
  const artifact = '(?:review\\s+card|(?:interactive\\s+)?(?:review\\s+)?widget)';
  const newReview = new RegExp(`\\b(?:I|we)(?:['’]ve|\\s+have)?\\s+(?:prepared|created|generated|saved|updated|opened)\\b[^.!?\\n]{0,160}\\b${artifact}\\b`, 'i');
  const readyReview = new RegExp(`\\b${artifact}\\s+(?:is|has\\s+been|was)\\s+(?:now\\s+)?(?:ready|prepared|created|saved|updated|available)\\b`, 'i');
  const claimedSavedWork = /\b(?:I|we)(?:['’]ve|\s+have)?\s+(?:prepared|created|generated|saved|updated|opened)\b[^.!?\n]{0,160}\b(?:draft|campaign|publication|publishing|review)\b/i;
  return newReview.test(prose) || readyReview.test(prose) || claimedSavedWork.test(prose);
}

function latestUserRequestsPublicationReview(
  messages: Array<{ role: string; content: string }>,
): boolean {
  const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content || '';
  return /\b(?:publish(?:ing)?|publication|schedule|scheduling)\b/i.test(latestUserMessage)
    && /\b(?:prepare|create|open|review|card)\b/i.test(latestUserMessage);
}

function explicitAssetIdsFromMessages(messages: Array<{ role: string; content: string }>): Set<number> {
  const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content || '';
  const ids = new Set<number>();
  for (const match of latestUserMessage.matchAll(/\basset(?:id)?\s*[:#]?\s*(\d+)\b/gi)) {
    ids.add(Number(match[1]));
  }
  for (const match of latestUserMessage.matchAll(/\bassets\s+((?:#?\d+[\s,]*(?:and\s+)?)+)/gi)) {
    for (const value of match[1].match(/\d+/g) || []) ids.add(Number(value));
  }
  return ids;
}

function verifiedQueriedAssetIds(results: ToolCallResult[]): Set<number> {
  const ids = new Set<number>();
  for (const result of results) {
    if (result.toolName !== 'query_content_assets' || !result.success) continue;
    const assets = result.result?.output?.assets;
    if (!Array.isArray(assets)) continue;
    for (const asset of assets) {
      const id = Number(asset?.id);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  }
  return ids;
}

function verifiedQueriedCampaignIds(results: ToolCallResult[]): Set<string> {
  const ids = new Set<string>();
  for (const result of results) {
    if (result.toolName !== 'query_ad_campaigns' || !result.success) continue;
    const campaigns = result.result?.output?.campaigns;
    if (!Array.isArray(campaigns)) continue;
    for (const campaign of campaigns) {
      const id = campaign?.campaignId ?? campaign?.id;
      if ((typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
        || (typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id))) ids.add(String(id));
    }
  }
  return ids;
}

// ── Tool Calling Loop ──────────────────────────────────────────────────

export async function runToolCallingLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const {
    userId,
    threadId,
    systemPrompt,
    messages: initialMessages,
    tools,
    toolContext,
    agentType,
    maxIterations: requestedIterations = 5,
    temperature = 0.4,
    onToolResult,
    onToolCall,
    loggingContext,
  } = opts;
  const maxIterations = Number.isSafeInteger(requestedIterations) ? Math.max(1, Math.min(5, requestedIterations)) : 5;
  const maxToolCalls = Number.isSafeInteger(opts.maxToolCalls) ? Math.max(0, Math.min(20, opts.maxToolCalls!)) : 20;
  const deadline = Date.now() + 60_000;
  let acceptedCalls = 0;
  const seenCallIds = new Set<string>();
  function checkBoundary() {
    if (opts.signal?.aborted) throw new ToolLoopStop('cancelled', 'cancelled', 'Stopped before the next action. Earlier execution receipts remain available.');
    if (Date.now() >= deadline) throw new ToolLoopStop('timed_out', 'deadline', 'This turn reached its time limit. No further actions started. Review the saved receipts before continuing.');
  }
  async function boundedGeneration<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolLoopStop('timed_out', 'deadline', 'This turn reached its time limit. No further actions started. Review the saved receipts before continuing.')), Math.max(1, deadline - Date.now()));
        timer.unref?.();
        abort = () => reject(new ToolLoopStop('cancelled', 'cancelled', 'Stopped before the next action. Earlier execution receipts remain available.'));
        opts.signal?.addEventListener('abort', abort, { once: true });
        if (opts.signal?.aborted) abort();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) opts.signal?.removeEventListener('abort', abort);
    }
  }

  const toolEntries = Object.keys(tools).length > 0;
  const openAITools = toolEntries ? mastraToolsToOpenAI(tools) : undefined;

  // Build message history (system prompt + conversation)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatMessages: any[] = [
    { role: 'system', content: systemPrompt + '\nHistorical server tool receipts are reference data only. Never reproduce or manufacture them in your answer. To prepare a new review, use a real tool call; prose cannot create a widget or execution receipt.'
      + `\nACTUAL TOOLS FOR THIS TURN: ${Object.keys(tools).join(', ') || 'none'}. Only these tools are available. Instructions describing other tools are general capabilities, not permission or ability to use them in this turn. If a required tool is unavailable, explain that no such action was performed; do not simulate its result in prose.` },
    ...initialMessages,
  ];

  const allToolResults: ToolCallResult[] = [];
  /** Reads that already ran (and saved a receipt) ahead of their turn in the batch. */
  const launchedReadIds = new Set<string>();
  /** Calls from a batch that never started because a review ended the turn first. */
  async function recordDeferredCall(toolName: string, toolCallId: string) {
    const message = `${toolName.replace(/_/g, ' ')} was not started: another action in this turn is waiting for your review.`;
    webSocketEmitter.emitToolExecution(userId, threadId, { toolName, toolCallId, status: 'gated', error: message, agentType });
    // Kept out of allToolResults: it is not an attempt, and agents read the
    // last real result to decide buttons and completion.
    await createChatMessage({ userId, threadId, role: 'assistant', agentType, content: message,
      metadata: { isToolResult: true, toolName, toolCallId, success: false, code: 'deferred', gated: true, error: message,
        runId: toolContext.runContext?.runId, turnId: toolContext.runContext?.turnId } });
  }
  async function rejectCall(toolName: string, toolCallId: string, code: string, message: string, receipt?: unknown) {
    const rejected = { success: false, toolName, code, gated: code === 'gated' || code === 'policy_error', error: message,
      ...(receipt === undefined ? {} : { executionReceipt: receipt }) };
    chatMessages.push({ role: 'tool', tool_call_id: toolCallId, name: toolName, content: JSON.stringify(rejected) });
    allToolResults.push({ toolName, toolCallId, result: rejected, success: false, error: message });
    webSocketEmitter.emitToolExecution(userId, threadId, { toolName, toolCallId,
      status: rejected.gated ? 'gated' : 'failed', error: message, agentType });
    // A rejected call is a durable terminal receipt, including policy failures.
    await createChatMessage({ userId, threadId, role: 'assistant', agentType, content: message,
      metadata: { isToolResult: true, toolName, toolCallId, success: false, code, gated: rejected.gated,
        error: message, toolOutput: rejected, runId: toolContext.runContext?.runId, turnId: toolContext.runContext?.turnId } });
  }
  async function recordToolStart(toolName: string, toolCallId: string, args: Record<string, unknown>) {
    await checkpointConversationRequest();
    checkBoundary();
    const metadata = { isToolCall: true, toolName, toolCallId, toolArgs: args,
      runId: toolContext.runContext?.runId, turnId: toolContext.runContext?.turnId };
    await createChatMessage({ userId, threadId, role: 'assistant', agentType, content: `🔧 ${toolName}`, metadata });
    try { checkBoundary(); } catch (error) {
      if (error instanceof ToolLoopStop) await rejectCall(toolName, toolCallId, error.stopReason, error.message);
      throw error;
    }
    webSocketEmitter.emitToolExecution(userId, threadId, { toolName, toolCallId, args, status: 'started', agentType });
  }
  const canOverlap = (call: FunctionToolCall) => Boolean(tools[call.function?.name]
    && toolMetadata[call.function.name]?.effect === 'read' && toolMetadata[call.function.name]?.concurrencySafe
    && !toolHasWidget(call.function.name));
  async function prepareRead(call: FunctionToolCall) {
    if (!canOverlap(call)) return undefined;
    const name = call.function.name;
    let args: Record<string, unknown>;
    try { args = parseToolArguments(call.function.arguments); args = (tools[name].inputSchema || tools[name].schema)?.parse(args) || args; }
    catch { return { rejected: 'invalid_arguments', message: 'Tool arguments must match the declared schema. No action was taken.' }; }
    try {
      if (await onToolCall?.(name, args) === false) return { rejected: 'gated', message: 'This read is not authorized in the current workflow.' };
    } catch { return { rejected: 'policy_error', message: 'The read could not be authorized. No action was taken.' }; }
    await recordToolStart(name, call.id, args);
    launchedReadIds.add(call.id);
    let result;
    try { result = await executeTool(tools[name], name, args, toolContext); }
    catch (error) {
      if (error instanceof ConversationRequestError) throw error;
      result = { success: false, error: error instanceof Error ? error.message : 'Read failed', toolName: name };
    }
    result = normalizeToolExecutionResult(name, result);
    const success = result.success === true;
    // Every launched read leaves a receipt, even if another read's workflow
    // hook later fails. Model results are still consumed in declared order.
    try { await createChatMessage({ userId, threadId, role: 'assistant', agentType,
      content: `${success ? '✅' : '❌'} ${name} ${success ? 'completed' : 'failed'}`,
      metadata: { isToolResult: true, toolName: name, toolCallId: call.id, success, toolOutput: result.output,
        error: result.error, runId: toolContext.runContext?.runId, turnId: toolContext.runContext?.turnId } }); }
    catch (error) {
      logger.error({ err: error, toolName: name, toolCallId: call.id }, '[ToolLoop] Read result receipt could not be saved');
      throw new ConversationRequestError('uncertain', 'A tool finished, but its result could not be saved. Review the execution before continuing.');
    }
    webSocketEmitter.emitToolExecution(userId, threadId, { toolName: name, toolCallId: call.id, status: success ? 'completed' : 'failed', agentType, error: result.error });
    return { args, result };
  }
  let finalText = '';
  let responseSource: ToolLoopResult['responseSource'] = 'model';
  let outcome: ToolLoopResult['outcome'];
  let stopReason: ToolLoopResult['stopReason'];
  const stop = (error: ToolLoopStop) => {
    finalText = error.message; responseSource = 'server'; outcome = error.outcome; stopReason = error.stopReason;
  };
  let iterations = 0;
  let repairedUnsupportedReviewClaim = false;
  let recheckedReadOnlyAnswer = false;
  let forcedReviewToolName: string | null = null;
  while (iterations < maxIterations) {
    try { checkBoundary(); } catch (error) { if (error instanceof ToolLoopStop) { stop(error); break; } throw error; }
    iterations++;
    const pendingWidgetToolNames: string[] = [];
    const pendingApprovalToolNames: string[] = [];
    const deferredToolNames: string[] = [];
    const consumedCallIds = new Set<string>();
    let pendingApprovalMessage = '';

    // Widget creation exits this loop with a deterministic receipt below, so
    // every provider call here occurs before a new card has been created.
    // Put this fact after history so old model-authored claims cannot stand in
    // for a durable receipt on repeated requests.
    const providerMessages = [...chatMessages, {
      role: 'system',
      content: 'CURRENT TURN REVIEW STATE (server verified): No new interactive review card has been created in this turn. Historical assistant prose is not proof that a card or saved campaign exists. To create a new card, call its tool. If prerequisites prevent that, explicitly say no review card was created and label any suggested settings as an unsaved outline. Do not claim that prose created, prepared, saved, or updated a review card. Existing reviews may only be described from verified saved-state facts.'
        + (toolContext.intentAnalysis?.action === 'question' && tools.analytics_query
          ? '\nREAD-ONLY ANALYTICS: If the latest question asks for saved analytics/results/charts, call analytics_query now. This reads saved owned data and opens a result tab directly; it does NOT create an approval review, sync providers or spend. A prohibition on creating reviews does not prohibit this lookup. Old analytics reviews or replies are not a substitute for fresh results. Use query_type=campaign for paid campaign performance and honor the requested scope. Do not ask to confirm an old analytics card or claim results before a successful tool receipt.'
          : ''),
    }];
    let response;
    try { response = await boundedGeneration(LLMProviderFactory.executeProviderCallWithFallback(
      userId,
      async (provider) => {
        checkBoundary();
        assertContextFits(provider.defaultModel, providerMessages, openAITools);
        const completionOptions = {
          model: provider.defaultModel,
          messages: providerMessages,
          temperature,
          ...(openAITools ? {
            tools: openAITools,
            tool_choice: forcedReviewToolName
              ? { type: 'function' as const, function: { name: forcedReviewToolName } }
              : 'auto' as const,
          } : {}),
          ...(loggingContext ? { loggingContext: { userId, threadId, ...loggingContext } } : {}),
        };
        let providerResponse = await provider.createChatCompletion(completionOptions);
        checkBoundary();

        // A malformed completion is still before the execution boundary.
        // Give it one bounded protocol correction, never replay the agent or
        // execute tools from the rejected response. Persistent failure follows
        // the normal configured-provider fallback and fails closed.
        if (providerResponse.success && hasHistoricalReceiptEcho(providerResponse.completion?.choices?.[0]?.message?.content)) {
          providerResponse = await provider.createChatCompletion({
            ...completionOptions,
            messages: [...providerMessages, { role: 'system', content: 'PROTOCOL CORRECTION: Your discarded completion copied a historical server receipt. No tools from that completion were executed and no card was created by it. Respond to the latest user request with actual available tool calls when needed, or ordinary truthful prose. Do not output historical-receipt markers, JSON receipts, or invented action results. Preserve every review and execution approval gate.' }],
          });
          checkBoundary();
        }

        if (!providerResponse.success) {
          throw new LLMProviderResponseError(
            providerResponse.error || 'The provider could not process the request.',
            provider.getProviderName(),
            provider.defaultModel,
          );
        }

        const providerMessage = providerResponse.completion?.choices?.[0]?.message;
        if (hasHistoricalReceiptEcho(providerMessage?.content)) {
          throw new LLMProviderResponseError(
            'The provider echoed a historical tool receipt instead of issuing a valid response.',
            provider.getProviderName(),
            provider.defaultModel,
          );
        }
        const hasToolCalls = Array.isArray(providerMessage?.tool_calls)
          && providerMessage.tool_calls.length > 0;
        const hasText = typeof providerMessage?.content === 'string'
          && providerMessage.content.trim().length > 0;
        if (!providerMessage || (!hasText && !hasToolCalls)) {
          throw new LLMProviderResponseError(
            'The provider returned an empty response.',
            provider.getProviderName(),
            provider.defaultModel,
          );
        }

        return providerResponse;
      },
    )); checkBoundary(); }
    catch (error) { if (error instanceof ToolLoopStop) { stop(error); break; } throw error; }

    const choice = response.completion?.choices?.[0];
    const message = choice?.message;
    if (!message) {
      logger.warn({ userId }, '[ToolLoop] No message in completion response');
      finalText = response.content || '';
      break;
    }

    const toolCalls = message.tool_calls;
    const textContent = message.content || '';
    if (toolCalls?.length) {
      if (acceptedCalls + toolCalls.length > maxToolCalls) {
        stop(new ToolLoopStop('failed', 'call_limit', 'This turn reached its action limit. This batch did not run. Earlier execution receipts remain available.'));
        break;
      }
      const ids = toolCalls.map((call: FunctionToolCall) => call?.id);
      if (ids.some((id: unknown) => typeof id !== 'string' || !id || seenCallIds.has(id)) || new Set(ids).size !== ids.length) {
        stop(new ToolLoopStop('failed', 'invalid_tool_calls', 'The model returned invalid or repeated action identities. This batch did not run. Review earlier receipts before continuing.'));
        break;
      }
      acceptedCalls += toolCalls.length;
      for (const id of ids) seenCallIds.add(id);
    }

    // If no tool calls, this is the final response
    if (!toolCalls || toolCalls.length === 0) {
      // A read-only specialist can mistakenly echo old result claims instead
      // of retrieving evidence. Recheck once, before any tool has executed;
      // never force a read for a purely explanatory question or replay writes.
      if (!recheckedReadOnlyAnswer && iterations < maxIterations
        && toolContext.intentAnalysis?.action === 'question'
        // The router already judged this a pure advice/explanation question
        // that needs no stored fact, so there is no lookup to recheck for and
        // the first answer stands. Unknown or missing keeps the recheck.
        && toolContext.intentAnalysis.savedDataLookup !== false
        && tools.analytics_query && allToolResults.length === 0) {
        recheckedReadOnlyAnswer = true;
        chatMessages.push({ role: 'assistant', content: textContent });
        chatMessages.push({ role: 'system', content: 'READ-ONLY EVIDENCE CHECK: No tool ran in this turn. The preceding draft is discarded, not evidence of a lookup. Re-read the latest user question. If it asks for saved analytics or charts, issue an analytics_query FUNCTION CALL now, not a narrative claiming you queried data. It runs directly without an approval card. If the question only asks for explanation, answer without claiming a lookup or current results. Historical answers and empty-result claims also require fresh evidence when current data is requested.' });
        continue;
      }
      const publicationReviewNeedsTool = Boolean(tools.publish_social_post)
        && latestUserRequestsPublicationReview(initialMessages)
        && allToolResults.some(result => result.toolName === 'query_content_assets' && result.success)
        && !allToolResults.some(result => result.toolName === 'publish_social_post');
      if (!repairedUnsupportedReviewClaim
        && iterations < maxIterations
        && ((assertsPreparedReview(textContent) && !allToolResults.some(receipt=>receipt.toolName==='prepare_outreach_campaign' && receipt.success && preparedOutreachEvidence(receipt.result?.output))) || publicationReviewNeedsTool)) {
        repairedUnsupportedReviewClaim = true;
        forcedReviewToolName = publicationReviewNeedsTool ? 'publish_social_post' : null;
        chatMessages.push({ role: 'assistant', content: textContent });
        chatMessages.push({
          role: 'system',
          content: publicationReviewNeedsTool
            ? 'PROTOCOL CORRECTION: The latest user explicitly requested a publication review and the saved-asset lookup succeeded, but no publish_social_post review receipt exists in this turn. Complete any remaining read-only prerequisite, then call publish_social_post with the verified asset and destination to create the review. If a required prerequisite is missing, state it plainly and do not claim a review was created.'
            : 'PROTOCOL CORRECTION: Your discarded response claimed that a review card or widget was prepared, but no review-creation tool receipt exists in this turn. If the latest user requested a review and the required widget-backed tool is available, call that tool now with the verified settings. Otherwise state plainly that no review card was created and explain the exact missing prerequisite. Do not repeat the unsupported claim.',
        });
        continue;
      }
      finalText = textContent;
      break;
    }

    // Append assistant message WITH tool_calls to history
    chatMessages.push({
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls,
    });

    // Execute each tool call
    try { for await (const { call: tc, result: prefetched } of orderedToolCalls<FunctionToolCall, Awaited<ReturnType<typeof prepareRead>>>(toolCalls, canOverlap, prepareRead)) {
      const fnName = tc.function?.name;
      const fnArgs = tc.function?.arguments;
      const toolCallId = tc.id;
      consumedCallIds.add(toolCallId);

      if (prefetched?.rejected) {
        await rejectCall(fnName, toolCallId, prefetched.rejected, prefetched.message!);
        if (prefetched.rejected !== 'invalid_arguments') {
          finalText = prefetched.message!; responseSource = 'server'; outcome = 'gated'; break;
        }
        continue;
      }
      // Parse args early so we can use them in persistence
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsedArgs: any = {};
      try {
        parsedArgs = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : fnArgs;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch {
        await rejectCall(fnName, toolCallId, 'invalid_arguments', 'Tool arguments must be valid JSON. No action was taken.');
        continue;
      }
      if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
        await rejectCall(fnName, toolCallId, 'invalid_arguments', 'Tool arguments must be a JSON object. No action was taken.');
        continue;
      }

      const constraintMessages = toolContext.conversationHistory?.length
        ? toolContext.conversationHistory.filter(message => typeof message?.content === 'string')
        : initialMessages;
      let constraintContext = toolContext;
      if (['analytics_query', 'query_content_assets', 'query_scheduled_posts'].includes(fnName)
        && toolContext.intentAnalysis?.semanticRequest?.scope
        && toolContext.intentAnalysis.semanticRequest.scope !== 'unspecified') {
        parsedArgs = { ...parsedArgs, scope: toolContext.intentAnalysis.semanticRequest.scope };
      }
      if (['generate_social_media_post', 'generate_ad'].includes(fnName)
        && toolContext.savedToolActions?.some(action => action.toolName === fnName
          && !Object.prototype.hasOwnProperty.call(action, 'submittedValues'))
        && toolContext.intentAnalysis?.semanticRequest?.taskRelation === 'follow_up') {
        try {
          // Older ThreadService snapshots omit submittedValues. Recover the
          // reviewed form from the existing owned read, without executing it.
          const ownedWidgets = await WidgetStateModel.findByThreadForUser(userId, threadId);
          constraintContext = { ...toolContext, savedToolActions: toolContext.savedToolActions.map(action => {
            const owned = ownedWidgets.find(widget => widget.id === action.widgetId
              && widget.userId === userId && widget.threadId === threadId);
            return owned ? { ...action, status: owned.status, formValues: owned.formValues || {},
              submittedValues: owned.submittedValues, userId, threadId } : action;
          }) };
        } catch (error) {
          logger.warn({ err: error }, '[ToolLoop] Could not refresh saved generation defaults');
        }
      }

      if (['generate_social_media_post', 'generate_social_chat_template', 'generate_email_template', 'generate_sms_template', 'generate_blog_post'].includes(fnName) && parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
        const scoped = scopeGenerationRequest(fnName, constraintMessages, constraintContext);
        parsedArgs = enforceSocialPostMediaConstraints(parsedArgs, scoped.messages, scoped.defaults, constraintContext);
        if (fnName === 'generate_email_template') {
          const profile = (toolContext.brandContextSnapshot as { businessProfile?: { businessName?: string | null; companyName?: string | null } } | undefined)?.businessProfile;
          parsedArgs = applyEmailReviewDefaults(parsedArgs, scoped.defaults, profile?.businessName || profile?.companyName);
        }
        if (fnName === 'generate_sms_template' && typeof parsedArgs.cta_text === 'string') {
          parsedArgs.call_to_action = parsedArgs.cta_text;
          delete parsedArgs.cta_text;
        }
      }

      if (['generate_ad', 'publish_ads', 'publish_meta_ads', 'publish_google_ads'].includes(fnName)
        && parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
        const proposedCampaignId = parsedArgs.campaign_id;
        const queriedCampaigns = verifiedQueriedCampaignIds(allToolResults);
        parsedArgs = enforceAdRequestConstraints(fnName, parsedArgs,
          fnName === 'generate_ad' ? constraintMessages : initialMessages, constraintContext);
        if (fnName !== 'generate_ad') {
          if (constraintContext.intentAnalysis?.semanticRequest?.paidCampaignSelection.kind === 'unspecified'
            && queriedCampaigns.size === 1 && queriedCampaigns.has(String(proposedCampaignId))) {
            parsedArgs.campaign_id = String(proposedCampaignId);
            delete parsedArgs.asset_ids;
          }
          parsedArgs = removeAmbiguousSavedCampaignSelection(
            parsedArgs, initialMessages, queriedCampaigns.size, constraintContext,
          );
        }
      }

      if (fnName === 'query_content_assets' && Array.isArray(parsedArgs?.assetIds)) {
        const groundedIds = explicitAssetIdsFromMessages(initialMessages);
        for (const id of verifiedQueriedAssetIds(allToolResults)) groundedIds.add(id);
        const requestedIdCount = parsedArgs.assetIds.length;
        const verifiedIds = parsedArgs.assetIds.filter((id: unknown) => groundedIds.has(Number(id)));
        if (verifiedIds.length !== requestedIdCount) {
          parsedArgs = { ...parsedArgs };
          if (verifiedIds.length > 0) parsedArgs.assetIds = verifiedIds;
          else delete parsedArgs.assetIds;
          logger.info(
            { toolName: fnName, removedCount: requestedIdCount - verifiedIds.length },
            '[ToolLoop] Removed ungrounded content asset IDs from search',
          );
        }
      }

      const tool = tools[fnName];
      if (!tool) {
        logger.warn({ toolName: fnName }, '[ToolLoop] Unknown tool requested by LLM');
        await rejectCall(fnName, toolCallId, 'unknown_tool', `Unknown tool: ${fnName}`);
        continue;
      }

      // Validate LLM output (parsedArgs) against tool schema
      const schema = tool.inputSchema || tool.schema;
      if (schema) {
        try {
          if (['publish_meta_ads', 'publish_google_ads'].includes(fnName) && Array.isArray(parsedArgs.platforms)) {
            const platform = fnName === 'publish_meta_ads' ? 'meta' : 'google';
            if (parsedArgs.platforms.length !== 1 || parsedArgs.platforms[0] !== platform) {
              throw new Error('Use publish_ads with the exact requested platforms before preparing approval.');
            }
          }
          parsedArgs = schema.parse(parsedArgs);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (validationError: any) {
          logger.warn(
            { toolName: fnName, err: validationError, args: parsedArgs },
            '[Migration Tracking] [ToolLoop] LLM output validation failed for tool args'
          );
          
          webSocketEmitter.emitToolExecution(userId, threadId, {
            toolName: fnName,
            toolCallId,
            status: 'failed',
            error: `Invalid tool arguments: ${validationError.message}`,
            agentType,
          });

          const errorContent = JSON.stringify({
            success: false,
            error: `Invalid tool arguments: ${validationError.message}`,
            validationErrors: validationError.issues || validationError.errors || validationError.message
          });

          chatMessages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: errorContent,
          });

          allToolResults.push({
            toolName: fnName,
            toolCallId,
            result: null,
            success: false,
            error: `Invalid tool arguments: ${validationError.message}`,
          });

          // Persist validation failure
          try {
            const failContent = `❌ ${fnName} failed validation`;
            await createChatMessage({
              userId, threadId, role: 'assistant',
              content: failContent, agentType,
              metadata: {
                isToolResult: true, toolName: fnName, toolCallId, success: false,
                error: `Invalid tool arguments: ${validationError.message}`,
              },
            });
            webSocketEmitter.emitChatResponse(userId, threadId, {
              role: 'assistant', content: failContent, agentType,
              metadata: {
                isToolResult: true, toolName: fnName, toolCallId, success: false,
                error: `Invalid tool arguments: ${validationError.message}`,
                responseId: `tool-result-val-${fnName}-${Date.now()}`,
              },
            });
          } catch (e) {
            logger.warn({ err: e, toolName: fnName }, '[ToolLoop] Failed to persist validation failure');
          }

          continue;
        }
      }

      if (!prefetched && opts.signal?.aborted) {
        await rejectCall(fnName, toolCallId, 'cancelled', 'Stopped before this tool started.');
        finalText = 'Stopped before the next action. Earlier execution receipts remain available.';
        responseSource = 'server'; outcome = 'cancelled'; break;
      }
      let allowed = true;
      let policyError = false;
      try { allowed = prefetched ? true : await onToolCall?.(fnName, parsedArgs) !== false; }
      catch (error) {
        logger.error({ err: error, toolName: fnName, toolCallId }, '[ToolLoop] Policy evaluation failed');
        allowed = false; policyError = true;
      }
      if (!allowed) {
        const message = policyError
          ? 'The action could not be authorized. No action was taken. Please retry when the policy check is available.'
          : `${fnName.replace(/_/g, ' ')} is not ready because its required work or approval is still outstanding. No action was taken.`;
        await rejectCall(fnName, toolCallId, policyError ? 'policy_error' : 'gated', message);
        finalText = message; responseSource = 'server'; outcome = 'gated'; break;
      }

      if (!prefetched) await recordToolStart(fnName, toolCallId, parsedArgs);

      // Widget-backed tools are review/confirmation requests. Create the
      // durable widget first and defer the canonical implementation until the
      // user submits it. Executing here and again from /api/widgets/:id/submit
      // previously doubled provider cost and repeated data mutations.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let createdWidget: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any = prefetched?.result;
      // The lead platform/strategy decision is already a durable approval.
      // Its executor enforces that prerequisite and stores the next input
      // review; do not insert a second platform-confirmation card between them.
      const usesDurableLeadStrategy = fnName === 'generate_lead_inputs' && Boolean(toolContext.runContext?.runId);
      // Analytics reads saved owned data and emits a result tab. An answer-only
      // question must not create an execution review merely because the tool
      // also has a form UI. Keep all other widget-backed actions gated.
      const isAnalyticsAnswer = fnName === 'analytics_query'
        && toolContext.intentAnalysis?.action === 'question'
        && !toolContext.intentAnalysis.needsClarification;
      if (!prefetched && toolHasWidget(fnName) && !usesDurableLeadStrategy && !isAnalyticsAnswer) {
        try {
          if (fnName === 'generate_ad' && !parsedArgs.landing_url) {
            const snapshot = toolContext.brandContextSnapshot as { businessProfile?: { website?: string }; brandToolkit?: { website?: string } } | undefined;
            let destination = snapshot?.businessProfile?.website || snapshot?.brandToolkit?.website;
            if (!destination) {
              const { getCompanySettingsByUserId } = await import('../../models/companySettings/functions.js');
              destination = (await getCompanySettingsByUserId(userId))?.website || undefined;
            }
            if (destination) parsedArgs = { ...parsedArgs, landing_url: destination };
          }
          if (fnName === 'publish_social_post') {
            const { ContentAssetModel } = await import('../../models/contentAssets/functions.js');
            const asset = await ContentAssetModel.findByIdForUser(Number(parsedArgs.content_asset_id), userId);
            if (!asset) throw new Error('A saved, owned content asset is required before preparing publication; a review-card ID is not an asset ID.');
          }
          if (['generate_video', 'generate_video_from_image'].includes(fnName)) {
            const { prepareVideoReview } = await import('../../services/media/VideoReviewPolicy.js');
            parsedArgs = await prepareVideoReview(parsedArgs || {}, userId);
          }
          if (parsedArgs?.auto_generate_video === true && !['generate_video', 'generate_video_from_image'].includes(fnName)) {
            const { prepareVideoReview } = await import('../../services/media/VideoReviewPolicy.js');
            const media = await prepareVideoReview({ aspect_ratio: parsedArgs.video_aspect_ratio, resolution: parsedArgs.video_resolution, duration_seconds: parsedArgs.video_duration_seconds, number_of_videos: parsedArgs.video_count }, userId);
            parsedArgs = { ...parsedArgs, video_aspect_ratio: media.aspect_ratio, video_resolution: media.resolution, video_duration_seconds: media.duration_seconds, video_count: media.number_of_videos, video_provider: media.provider, video_model: media.model, video_capabilities: media.video_capabilities };
          }
          if (fnName === 'send_outreach_messages' && parsedArgs?.channel === 'email' && typeof parsedArgs.body === 'string') {
            const { normalizeOutreachEmailBody } = await import('../../services/content/TextContentGenerationService.js');
            parsedArgs = { ...parsedArgs, body: normalizeOutreachEmailBody(parsedArgs.body, toolContext.companyProfile?.companyName) };
          }
          const widgetType = getWidgetTypeForTool(fnName);
          let replacedWidgetId: number | undefined;
          if (widgetType) {
            const pendingWidgets = await WidgetStateModel.findByThreadForUser(userId, threadId);
            const revision = toolContext.intentAnalysis?.semanticRequest;
            const revisesGeneration = revision?.contentOperation === 'revise_review';
            const revisionTarget = revisesGeneration ? pendingWidgets.find(widget =>
              widget.id === revision.generationReviewId && widget.toolName === fnName
              && widget.userId === userId && widget.threadId === threadId
              && ['active', 'draft'].includes(widget.status)) : undefined;
            if (revisesGeneration && !revisionTarget) {
              throw new Error('The selected review is no longer editable or does not match this tool.');
            }
            const widgetData = {
              userId, threadId, toolName: fnName, widgetType,
              runId: toolContext.runContext?.runId, actionId: toolCallId,
              idempotencyKey: toolContext.runContext?.runId ? `${toolContext.runContext.runId}:${toolCallId}` : undefined,
              formValues: (parsedArgs || {}) as Record<string, unknown>,
              status: 'active', agentType: agentType || null,
            };
            if (revisionTarget) {
              createdWidget = await WidgetStateModel.replacePendingReviewForUser(revisionTarget.id, widgetData);
              webSocketEmitter.emitWidgetUpdate(userId, threadId, {
                id: revisionTarget.id, status: 'cancelled',
              });
            } else createdWidget = pendingWidgets.find((widget) =>
              widget.toolName === fnName
              && (!widget.runId || (
                widget.runId === toolContext.runContext?.runId
                && widget.actionId === toolCallId
              ))
              && (widget.status === 'active' || widget.status === 'draft')
              && isDeepStrictEqual(widget.formValues || {}, parsedArgs || {}),
            );
            if (createdWidget && !revisionTarget) {
              if (!createdWidget.runId && toolContext.runContext?.runId) {
                createdWidget = await WidgetStateModel.bindRunActionForUser(
                  createdWidget.id,
                  userId,
                  toolContext.runContext.runId,
                  toolCallId,
                ) || createdWidget;
              }
              logger.info(
                { toolName: fnName, widgetId: createdWidget.id, threadId },
                '[ToolLoop] Reusing matching pending widget',
              );
            } else if (!createdWidget) {
              // A redraft of the same outreach (same channel and recipients)
              // replaces its unstarted card, so only one version can be sent.
              const superseded = sameOutreachReviews(pendingWidgets, fnName, userId, threadId, parsedArgs);
              if (superseded.length === 1) {
                try {
                  createdWidget = await WidgetStateModel.replacePendingReviewForUser(superseded[0].id, widgetData);
                  replacedWidgetId = superseded[0].id;
                  webSocketEmitter.emitWidgetUpdate(userId, threadId, { id: superseded[0].id, status: 'cancelled' });
                  logger.info({ toolName: fnName, widgetId: createdWidget.id, replacedWidgetId: superseded[0].id, threadId }, '[ToolLoop] Replaced the earlier draft of the same outreach review');
                } catch (error) {
                  logger.warn({ err: error, toolName: fnName, widgetId: superseded[0].id, threadId }, '[ToolLoop] Earlier outreach review is no longer editable; creating a new one');
                }
              }
              if (!createdWidget) {
                createdWidget = await WidgetStateModel.create(widgetData);
                logger.info({ toolName: fnName, widgetId: createdWidget.id, threadId }, '[ToolLoop] Created interactive widget in Mastra tool loop');
              }
            }
            result = {
              success: true,
              toolName: fnName,
              pendingWidget: true,
              output: {
                awaitingSubmission: true,
                widgetId: createdWidget.id,
                reusedWidget: createdWidget.messageId != null,
                ...(replacedWidgetId ? { replacedWidgetId } : {}),
                args: parsedArgs || {},
                message: 'Review the interactive widget and confirm to run this tool.',
              },
            };
            pendingWidgetToolNames.push(fnName);
          }
        } catch (widgetError) {
          if (widgetError instanceof ConversationRequestError) throw widgetError;
          logger.error({ err: widgetError, toolName: fnName, threadId }, '[ToolLoop] Failed to create widget in Mastra tool loop');
          result = {
            success: false,
            toolName: fnName,
            error: 'Unable to create the required review widget. The tool was not executed.',
          };
        }
      } else if (!prefetched) {
        try {
          result = await executeTool(tool, fnName, parsedArgs, toolContext);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (err instanceof ConversationRequestError) throw err;
          logger.error({ err, toolName: fnName }, '[ToolLoop] Tool execution failed');
          result = { success: false, error: err.message, toolName: fnName };
        }
      }

      result = normalizeToolExecutionResult(fnName, result);
      const success = result.success === true;
      allToolResults.push({ toolName: fnName, toolCallId, result, success, error: result?.error });

      // A created widget is pending, not completed. Its execution lifecycle is
      // emitted by the submission route after the atomic claim.
      if (!createdWidget && !prefetched) {
        webSocketEmitter.emitToolExecution(userId, threadId, {
          toolName: fnName, toolCallId, status: success ? 'completed' : 'failed',
          error: result?.error, agentType,
        });
      }

      // Persist tool result to DB
      if (!prefetched) try {
        const resultContent = createdWidget
          ? `⏸️ ${fnName} awaiting confirmation`
          : success
            ? `✅ ${fnName} completed`
            : `❌ ${fnName} failed`;
        const chatMsg = await createChatMessage({
          userId,
          threadId,
          role: 'assistant',
          content: resultContent,
          agentType,
          metadata: {
            isToolResult: true,
            toolName: fnName,
            toolCallId,
            runId: toolContext.runContext?.runId,
            turnId: toolContext.runContext?.turnId,
            success,
            toolOutput: result?.output,
            error: result?.error,
            ...(createdWidget ? { widgetMessageId: null } : {}), // placeholder to be filled
          },
        });

        if (createdWidget && chatMsg?.id) {
          // Link widget to message
          await WidgetStateModel.updateMessageId(createdWidget.id, chatMsg.id);
          createdWidget.messageId = chatMsg.id;

          // Update chat message metadata with widgetMessageId
          const { chatMessagesTable } = await import('../../models/chatMessages/schema.js');
          const { db } = await import('../../models/db.js');
          const { eq } = await import('drizzle-orm');

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const currentMeta = chatMsg.metadata as Record<string, any> || {};
          await db.update(chatMessagesTable)
            .set({
              metadata: {
                ...currentMeta,
                widgetMessageId: chatMsg.id,
              }
            })
            .where(eq(chatMessagesTable.id, chatMsg.id));

          chatMsg.metadata = {
            ...currentMeta,
            widgetMessageId: chatMsg.id,
          };
        }

        // Emit widget_created event only after linkage is completed
        if (createdWidget) {
          webSocketEmitter.emitWidgetCreated(userId, threadId, {
            id: createdWidget.id,
            toolName: fnName,
            widgetType: createdWidget.widgetType,
            formValues: createdWidget.formValues,
            status: createdWidget.status || 'active',
            agentType: agentType || undefined,
            messageId: chatMsg.id,
          });
        }

        webSocketEmitter.emitChatResponse(userId, threadId, {
          role: 'assistant',
          content: resultContent,
          agentType,
          metadata: {
            isToolResult: true,
            toolName: fnName,
            toolCallId,
            runId: toolContext.runContext?.runId,
            turnId: toolContext.runContext?.turnId,
            success,
            toolOutput: result?.output,
            error: result?.error,
            responseId: `tool-result-${fnName}-${Date.now()}`,
            ...(createdWidget ? { widgetMessageId: chatMsg.id } : {}),
          },
        });
      } catch (e) {
        logger.error({ err: e, toolName: fnName }, '[ToolLoop] Failed to persist tool result; reconciliation required');
        throw new ConversationRequestError('uncertain', 'A tool finished, but its result could not be saved. Review the execution before continuing.');
      }

      if (onToolResult) {
        try { await onToolResult(fnName, result); }
        catch (error) {
          logger.error({ err: error, toolName: fnName, toolCallId }, '[ToolLoop] Result state update failed');
          try {
            await rejectCall(fnName, toolCallId, 'reconciliation_required',
              'The tool returned a result, but its workflow state could not be updated. Check the saved receipt before retrying.', result);
          } catch (receiptError) {
            logger.error({ err: receiptError, toolName: fnName, toolCallId }, '[ToolLoop] Reconciliation receipt could not be saved');
          }
          // This must reach the request coordinator even if the extra receipt
          // fails. A normal failed response would release dependent queued work.
          throw new ConversationRequestError('uncertain', 'A tool result was saved, but its workflow update needs review before this conversation can continue.');
        }
      }

      if (result?.requiresApproval) {
        pendingApprovalToolNames.push(fnName);
        pendingApprovalMessage = result?.output?.message
          || result?.message
          || `Approval is required before ${fnName.replace(/_/g, ' ')} can run.`;
      }

      // Preserve typed receipts and bounded catalog samples as valid JSON.
      const resultStr = compactToolResult(result);
      chatMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name: fnName,
        content: resultStr,
      });

      // Approval is a turn boundary. Do not execute later tool calls or ask the
      // model to invoke the same gated tool again in this turn.
      if (pendingApprovalToolNames.length > 0 || pendingWidgetToolNames.length > 0) break;
    }
    // A review ends the turn. Any later call in the same batch never started;
    // say so durably instead of dropping it without a trace.
    if (pendingApprovalToolNames.length > 0 || pendingWidgetToolNames.length > 0) {
      for (const call of toolCalls as FunctionToolCall[]) {
        if (consumedCallIds.has(call.id) || launchedReadIds.has(call.id)) continue;
        const name = call.function?.name || 'unknown_tool';
        deferredToolNames.push(name);
        try { await recordDeferredCall(name, call.id); }
        catch (error) { logger.warn({ err: error, toolName: name, toolCallId: call.id }, '[ToolLoop] Could not save deferred call receipt'); }
      }
    } } catch (error) { if (error instanceof ToolLoopStop) stop(error); else throw error; }
    const deferredNote = deferredToolNames.length > 0
      ? `\n\nNot started in this turn: ${[...new Set(deferredToolNames)].map(name => name.replace(/_/g, ' ')).join(', ')}. Only one review can be opened at a time. Finish the review above, then ask me for the remaining items if I do not continue with them automatically.`
      : '';

    // A deterministic guard rejection is a terminal turn boundary. Asking the
    // model again makes it repeat the same prohibited tool until maxIterations.
    if (outcome) break;

    // A widget-backed tool has not executed yet. Stop here with truthful,
    // deterministic copy instead of asking the LLM to summarize a successful
    // tool result and risk claiming that content was already generated.
    if (pendingWidgetToolNames.length > 0) {
      finalText = pendingWidgetResponse(pendingWidgetToolNames, allToolResults
        .filter(toolResult => toolResult.result?.pendingWidget === true)
        .map(toolResult => ({ args: toolResult.result?.output?.args, replacedWidgetId: toolResult.result?.output?.replacedWidgetId })));
      responseSource = 'server';
      const failedBeforeReview = [...new Set(
        allToolResults
          .filter(toolResult => !toolResult.success)
          .map(toolResult => toolResult.toolName),
      )];
      if (failedBeforeReview.length > 0) {
        // Attempts are not actions: another call of the same tool may have
        // produced the pending review. Keep failures visible without declaring
        // them resolved (or unresolved) solely by matching the tool name.
        finalText += `\n\n⚠️ Earlier attempts failed for: ${failedBeforeReview.map(name => name.replace(/_/g, ' ')).join(', ')}. The review above applies only to the settings in its card; it does not mean every requested action completed. Failed attempts remain visible in the execution details.`;
      }
      finalText += deferredNote;
      break;
    }

    if (pendingApprovalToolNames.length > 0) {
      finalText = pendingApprovalMessage + deferredNote;
      responseSource = 'server';
      break;
    }

    const repeatedFailure = findRepeatedFailure(allToolResults);
    if (repeatedFailure) {
      stop(new ToolLoopStop('failed', 'repeated_failure',
        `I tried ${humanizeToolName(repeatedFailure.toolName)} twice and it failed the same way both times: ${userFacingReason(repeatedFailure.error)}. `
        + "I've stopped retrying it so nothing runs twice. Tell me what to change, or ask me to try again later."));
      break;
    }

    // Continue loop — LLM will see tool results and either call more tools or generate text
  }

  if (!finalText && iterations >= maxIterations) {
    logger.warn({ userId, iterations }, '[ToolLoop] Max iterations reached without final text');
    stop(new ToolLoopStop('failed', 'iteration_limit', 'This turn reached its reasoning limit before finishing. Earlier execution receipts remain available; completed actions were not repeated.'));
  }

  return {
    text: finalText,
    responseSource,
    toolResults: allToolResults,
    messages: chatMessages,
    ...(outcome ? { outcome } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}
