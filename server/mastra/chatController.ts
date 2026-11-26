import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { isPostgresIntegerId } from '../utils/postgresIntegerId.js';
import { AI_SETUP_UNAVAILABLE } from '../../shared/aiSetupMessage.js';
import { INBOX_CHANNELS, type InboxChannel } from '../../shared/outreachInbox.js';
import { conversationRequests, currentConversationRequest, bindConversationRequest, bindConversationWorkflow, checkpointConversationRequest, ConversationRequestError } from '../services/ConversationRequestCoordinator.js';
import { createConversationClarification, readPendingClarification, answersPendingClarification } from './conversationClarification.js';
/**
 * LangGraph Chat Controller
 * Refactored to delegate heavy lifting to ThreadService and MessageService (Phase 3 service decomposition).
 */

import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { buildLeadStrategySelectionMessage } from './utils/leadStrategyActionMessage.js';
import { buildLeadRetryActionMessage } from './utils/leadRetryAction.js';
import { buildApprovedIcpAgentSelection, icpAgentRecommendationSentence } from './agentSelection.js';
import { loadSelectableLeadStrategies, resolveLeadStrategyIntent } from './leadStrategyIntent.js';
import { resolveOriginalLeadInputRequest } from './tools/executors/leadRequestConstraints.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { shouldCompactBeforeProcessing, compactMessagesWithAI, estimateTokens } from './utils/contextManager.js';
import { logger } from '../utils/logger.js';
import { withPromiseTimeout } from '../utils/promiseTimeout.js';
import {
  processMessage,
  handleApproval,
  switchAgent,
  getConversationState,
  createInitialState,
  type AgentState,
} from './index.js';
import { webSocketEmitter } from '../services/agents/WebSocketEmitter.js';
import { TAB_TYPES, TAB_LABELS } from './tabConfig.js';
import { ThreadService } from '../services/agents/ThreadService.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { MessageService, type PendingApprovalDecision } from '../services/agents/MessageService.js';
import { compactToolResult } from './utils/toolResultContext.js';
import { getUserLLMConfig, getModelFallbackConfig } from '../services/LLMConfigService.js';
import {
  claimChatMessageAction,
  finalizeChatMessageAction,
  hasUserMessageInThread,
  getChatMessagesByThreadId,
} from '../models/chatMessages/functions.js';
import {
  getChatTabConfigs,
  saveChatTabConfig,
} from '../models/chatTabConfigs/functions.js';
import {
  getChatThreadById,
  createChatThread,
  updateChatThread,
  updateChatThreadTimestamp,
  updateChatThreadMetadata,
  getChatThreadMetadata,
  clearPendingApprovalIfMatches,
} from '../models/chatThreads/functions.js';
import { getCompanySettingsByUserId, getCompanySettingsById } from '../models/companySettings/functions.js';
import { LeadModel } from '../models/leads/functions.js';
import {
  ConversationToolApprovalModel,
  isRetrySafeExecutionResult,
} from '../models/conversationToolApprovals/functions.js';
import {
  pendingApprovalMatchesRequest,
  mergePendingApprovalArguments,
  requiredModuleForApprovalTool,
  validatePendingApprovalArguments,
} from './approvalRequest.js';
import {
  appendConversationAttachmentContext,
  persistConversationUserMessageWithAttachments,
  prepareConversationAttachments,
  publicConversationMessage,
  type ConversationAttachmentReference,
} from '../services/ConversationAttachmentService.js';
import { extractExplicitLeadIds } from './leadSelection.js';
import { sanitizeAssistantContent, sanitizeErrorFields, toUserFacingError } from '../../shared/userFacingError.js';
import { WidgetStateModel } from '../models/widgetStates/functions.js';
import { getCompletedLeadOutreachGate } from './leadReview.js';
import { buildCampaignActionStatus, type PendingExecutionApprovalLedger } from './campaignActionStatus.js';
import { runUnifiedRouter } from './unifiedRouter.js';
import { storedOutreachStatusForReviews } from './campaignActionDelivery.js';
import { recoverEmptyAssistantTurn } from './turnResponseRecovery.js';
import {
  approveIcpRevision,
  approveLeadInputSet,
  createLeadSelectionSnapshot,
  createLeadStrategySelection,
  ensureConversationWorkflowRun,
  transitionConversationWorkflowRun,
  createConversationWorkflowAction,
  setConversationWorkflowActionStatus,
} from '../models/conversationWorkflow/functions.js';
import { workflowAfterRecipientSelection, isCurrentIcpRevisionApproved, InvalidWorkflowTransitionError, type ConversationWorkflowStage, type ConversationWorkflowStatus } from '../models/conversationWorkflow/stateMachine.js';
import { isRecord as isPlainRecord } from '../../shared/records.js';

// Re-export for backward compatibility (graph.ts/index.ts imports from here)
export { getUserLLMConfig, getModelFallbackConfig };

type WorkflowOutcome = NonNullable<AgentState['workflowOutcome']>;

/** Say that a provider ran out of credits when that is why no AI key is on. */
async function noAIProviderMessage(): Promise<string> {
  try {
    const { quotaDisabledAIProviders } = await import('../services/assistants/AssistantModelCatalogService.js');
    const providers = await quotaDisabledAIProviders();
    if (providers.length) {
      const { platformAIQuotaMessage } = await import('../../shared/assistantModelCatalog.js');
      return platformAIQuotaMessage(providers);
    }
  } catch (error) {
    logger.warn({ err: error }, '[chatController] Could not read switched-off AI keys');
  }
  return AI_SETUP_UNAVAILABLE;
}

async function persistLeadResultsTab(
  threadId: number,
  leadIds: number[],
  status: string,
): Promise<boolean> {
  if (leadIds.length === 0) return true;

  try {
    const existingTabs = await getChatTabConfigs(threadId);
    const existingLeadsTab = existingTabs.find((tab: {
      tabType: string;
      tabId: string;
      tabOrder: number;
    }) => tab.tabType === TAB_TYPES.LEADS);
    const tabId = existingLeadsTab?.tabId || `leads-${threadId}`;
    const tabOrder = existingLeadsTab?.tabOrder ?? existingTabs.length;

    await saveChatTabConfig(
      threadId,
      tabId,
      TAB_TYPES.LEADS,
      TAB_LABELS[TAB_TYPES.LEADS],
      tabOrder,
      true,
      {
        resourceType: 'lead_collection',
        resourceId: `thread-${threadId}-generated-leads`,
        revision: Date.now(),
        leadIds,
        totalLeads: leadIds.length,
        status,
      },
    );
    return true;
  } catch (error) {
    logger.warn({ err: error, threadId, leadIds }, '[Workflow] Lead results were stored but their tab could not be persisted');
    return false;
  }
}

async function approveBoundLeadInputSet(
  state: AgentState,
  userId: number,
  threadId: number,
): Promise<void> {
  if (state.pendingApproval?.toolName !== 'execute_lead_workflow') return;
  const args = state.pendingApproval.args || {};
  const inputSetId = typeof args.leadInputSetId === 'string' ? args.leadInputSetId : undefined;
  const revision = Number(args.leadInputSetRevision);
  const runId = typeof args.workflowRunId === 'string'
    ? args.workflowRunId
    : state.runContext?.runId;
  if (!inputSetId || !runId || !Number.isInteger(revision)) {
    throw new Error('This lead approval is not bound to an exact saved input revision. Prepare fresh settings and review them before execution.');
  }
  await approveLeadInputSet({ id: inputSetId, runId, userId, threadId, revision });
  await transitionConversationWorkflowRun({
    runId,
    userId,
    threadId,
    toStage: 'lead_executing',
    status: 'running',
    contextPatch: { leadInputSetId: inputSetId, leadInputSetRevision: revision },
  });
}

async function persistApprovedLeadSelection(input: {
  userId: number;
  threadId: number;
  leadIds: number[];
  originalRequest?: string;
}): Promise<void> {
  const run = await ensureConversationWorkflowRun({
    userId: input.userId,
    threadId: input.threadId,
    originalRequest: input.originalRequest,
    stage: 'agent_selection',
  });
  const snapshot = await createLeadSelectionSnapshot({
    runId: run.id,
    userId: input.userId,
    threadId: input.threadId,
    leadIds: input.leadIds,
  });
  await transitionConversationWorkflowRun({
    runId: run.id,
    userId: input.userId,
    threadId: input.threadId,
    // Selecting recipients must not abandon another specialist's pending
    // review or running action. Keep that stage while recording the snapshot.
    ...workflowAfterRecipientSelection(run.stage as ConversationWorkflowStage, run.status as ConversationWorkflowStatus),
    expectedVersion: run.version,
    contextPatch: { leadSelectionSnapshotId: snapshot.id, leadSelectionRevision: snapshot.revision },
  });
}

async function finalizeLeadWorkflowStage(
  state: AgentState,
  result: AgentState,
  userId: number,
  threadId: number,
): Promise<void> {
  if (state.pendingApproval?.toolName !== 'execute_lead_workflow') return;
  const args = state.pendingApproval.args || {};
  if (typeof args.leadInputSetId !== 'string') {
    // Legacy approvals did not bind execution to a durable input-set revision.
    // Their execution result remains visible, but it must not mutate the new
    // workflow state machine because no prerequisite transition was recorded.
    return;
  }
  const runId = typeof args.workflowRunId === 'string' ? args.workflowRunId : state.runContext?.runId;
  if (!runId) return;
  const toolResult = [...(result.toolResults || [])].reverse()
    .find(candidate => candidate.toolName === 'execute_lead_workflow');
  if (!toolResult) return;
  const selectedLeadIds = Array.isArray(toolResult.output?.leadIds)
    ? toolResult.output.leadIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  const workflowStatus = String(toolResult.output?.status || '').toLowerCase() || (toolResult.success ? 'succeeded' : 'failed');
  if (toolResult.success && selectedLeadIds.length > 0) {
    const tabPersisted = await persistLeadResultsTab(Number(threadId), selectedLeadIds, workflowStatus);
    await transitionConversationWorkflowRun({
      runId, userId, threadId,
      toStage: 'leads_awaiting_review',
      status: 'awaiting_input',
      contextPatch: {
        generatedLeadIds: selectedLeadIds,
        generatedLeadCount: selectedLeadIds.length,
        leadResultsTab: tabPersisted ? 'persisted' : 'needs_attention',
      },
    });
    return;
  }
  if (toolResult.success && selectedLeadIds.length === 0) {
    await transitionConversationWorkflowRun({
      runId, userId, threadId,
      toStage: 'completed',
      status: 'succeeded_empty',
      contextPatch: { generatedLeadIds: [], generatedLeadCount: 0 },
    });
    return;
  }
  await transitionConversationWorkflowRun({
    runId, userId, threadId,
    toStage: 'needs_attention',
    status: workflowStatus === 'partial_success' ? 'partial_success' : 'failed',
    contextPatch: { leadGenerationError: toolResult.error || toolResult.output?.message || 'Lead generation failed' },
  });
}

/** ICP match score (0-100) per specialist for an approved ICP, or null when
 * scoring is unavailable. Read-only: it never selects or starts an agent. */
async function scoreAgentsForApprovedIcp(userId: number, threadId: number, state: Partial<AgentState>): Promise<Record<string, number> | null> {
  if (!state.icpProfile) return null;
  try {
    const { executeSuggestAgents } = await import('./tools/executors/icpExecutor.js');
    const result = await withPromiseTimeout(executeSuggestAgents(
      { icpProfile: state.icpProfile, fitScore: Number(state.icpProfile.fitScore) || 1 },
      { userId, threadId, icpProfile: state.icpProfile, conversationHistory: state.messages } as never,
    ), 20_000, 'Agent suggestion timed out');
    const scores = result.success ? (result.output as { recommendedAgentScores?: Record<string, number> } | undefined)?.recommendedAgentScores : undefined;
    return scores && Object.values(scores).some(score => Number(score) > 0) ? scores : null;
  } catch (error) {
    logger.warn({ err: error, userId, threadId }, '[chatController] ICP agent suggestion unavailable; showing every specialist');
    return null;
  }
}

export async function recordConfirmedLeadStrategy(input: {
  userId: number;
  threadId: number;
  workflowIds: string[];
  platforms: string[];
  originalRequest?: string;
  state?: Partial<Pick<AgentState, 'icpProfile' | 'pendingApproval'>>;
  runId?: string;
  source?: 'conversation_action' | 'semantic_conversation';
}): Promise<boolean> {
  if (input.workflowIds.length === 0) return false;
  const state = input.state || await ThreadService.loadThreadState(input.userId, input.threadId);
  if (!isCurrentIcpRevisionApproved(state.icpProfile)) {
    throw new Error('Approve the current ICP revision before selecting lead platforms');
  }
  if (state.pendingApproval && state.pendingApproval.toolName !== 'execute_lead_workflow') {
    throw new Error('Finish or cancel the other pending review before changing the lead strategy.');
  }
  const { retireLeadStrategyApproval } = await import('./cancelCampaignReviews.js');
  const retiredApproval = await retireLeadStrategyApproval(input.userId, input.threadId, state.pendingApproval);
  if (retiredApproval) {
    const content = 'The previous search approval was retired. Selecting a strategy only prepares new settings for review; it does not run a search.';
    const saved = await MessageService.saveMessage({ userId: input.userId, threadId: input.threadId, role: 'assistant', agentType: 'lead_generation', content, metadata: { cancelledApproval: retiredApproval } });
    webSocketEmitter.emitChatMessage(input.userId, input.threadId, { id: saved.id, role: 'assistant', agentType: 'lead_generation', content, metadata: saved.metadata, timestamp: new Date(saved.createdAt).getTime() });
  }
  let run: { id: string } = input.runId ? { id: input.runId } : await ensureConversationWorkflowRun({
    userId: input.userId,
    threadId: input.threadId,
    originalRequest: input.originalRequest,
    stage: 'agent_selection',
  });
  const toLeadStrategy = () => transitionConversationWorkflowRun({
    runId: run.id,
    userId: input.userId,
    threadId: input.threadId,
    toStage: 'lead_strategy_awaiting_approval',
    status: 'awaiting_approval',
  });
  try {
    run = await toLeadStrategy();
  } catch (error) {
    if (!(error instanceof InvalidWorkflowTransitionError)) throw error;
    // The campaign moved on (for example to outreach) before this new lead
    // search, such as a retry after a failed provider run. Go back through
    // agent selection, the only route the workflow allows from those stages.
    try {
      await transitionConversationWorkflowRun({
        runId: run.id,
        userId: input.userId,
        threadId: input.threadId,
        toStage: 'agent_selection',
        status: 'awaiting_input',
      });
    } catch (hopError) {
      if (!(hopError instanceof InvalidWorkflowTransitionError)) throw hopError;
      throw new Error('Finish or cancel the current campaign step before starting a new lead search.');
    }
    run = await toLeadStrategy();
  }
  const selection = await createLeadStrategySelection({
    runId: run.id,
    userId: input.userId,
    threadId: input.threadId,
    platforms: input.platforms,
    workflowIds: input.workflowIds,
    selection: { source: input.source || 'conversation_action' },
  });
  await transitionConversationWorkflowRun({
    runId: run.id,
    userId: input.userId,
    threadId: input.threadId,
    toStage: 'lead_inputs_generating',
    status: 'running',
    contextPatch: { leadStrategySelectionId: selection.id, leadStrategyRevision: selection.revision },
  });
  return !!retiredApproval;
}

function deriveWorkflowOutcome(state: AgentState): WorkflowOutcome {
  if (state.requiresApproval) return 'awaiting_approval';
  if (
    state.workflowOutcome
    && state.workflowOutcome !== 'running'
    && state.workflowOutcome !== 'awaiting_approval'
  ) return state.workflowOutcome;

  const results = state.toolResults || [];
  if (results.length === 0) return 'succeeded';

  const reportedStatuses = results.map(actionStatusForToolResult);
  if (reportedStatuses.includes('awaiting_approval')) return 'awaiting_approval';
  if (reportedStatuses.includes('gated')) return 'gated';
  if (reportedStatuses.includes('queued')) return 'queued';
  if (reportedStatuses.includes('timed_out')) return 'timed_out';
  if (reportedStatuses.includes('partial_success')) return 'partial_success';
  if (reportedStatuses.includes('succeeded_empty')) return 'succeeded_empty';

  const succeeded = results.filter(result => result.success).length;
  if (succeeded === 0) return 'failed';
  if (succeeded < results.length) return 'partial_success';
  return 'succeeded';
}

function actionStatusForToolResult(result: AgentState['toolResults'][number]): WorkflowOutcome {
  if (result.requiresApproval) return 'awaiting_approval';
  const toolResult = (result as typeof result & {
    result?: { pendingWidget?: boolean; output?: Record<string, unknown> };
  }).result;
  if (toolResult?.pendingWidget || toolResult?.output?.awaitingSubmission === true) {
    return 'awaiting_approval';
  }
  const reported = result.output?.status || toolResult?.output?.status;
  if (reported === 'blocked') return 'gated';
  if (
    reported === 'awaiting_input'
    || reported === 'awaiting_approval'
    || reported === 'running'
    || reported === 'queued'
    || reported === 'partial_success'
    || reported === 'succeeded'
    || reported === 'succeeded_empty'
    || reported === 'failed'
    || reported === 'cancelled'
    || reported === 'gated'
    || reported === 'timed_out'
  ) return reported;
  return result.success ? 'succeeded' : 'failed';
}

async function persistWorkflowRunState(
  threadId: number,
  state: AgentState,
  forcedOutcome?: WorkflowOutcome,
): Promise<void> {
  const runContext = state.runContext;
  if (!runContext?.runId) return;

  const outcome = forcedOutcome || deriveWorkflowOutcome(state);
  state.workflowOutcome = outcome;
  const now = new Date().toISOString();
  const metadata = await getChatThreadMetadata(threadId) || {};
  const existingRuns = Array.isArray(metadata.workflowRuns)
    ? metadata.workflowRuns.filter(run => run && typeof run === 'object') as Array<Record<string, unknown>>
    : [];
  const existingRun = existingRuns.find(run => run.runId === runContext.runId);
  const actions = (state.toolResults || []).map((result, index) => {
    const typedResult = result as typeof result & { toolCallId?: string };
    return {
      actionId: typedResult.toolCallId || `${runContext.runId}:${result.toolName}:${index + 1}`,
      toolName: result.toolName,
      status: actionStatusForToolResult(result),
      success: result.success,
      error: result.error ? toUserFacingError(result.error) : undefined,
      updatedAt: now,
    };
  });
  const runRecord = {
    ...(existingRun || {}),
    runId: runContext.runId,
    threadId,
    turnId: runContext.turnId,
    actionId: runContext.actionId,
    status: outcome,
    startedAt: existingRun?.startedAt || now,
    updatedAt: now,
    // A previous terminal snapshot may be resumed for review. Explicitly
    // clear its completion timestamp for every non-terminal state instead of
    // retaining the stale value through the existing-record spread above.
    completedAt: outcome === 'running' || outcome === 'awaiting_input'
      || outcome === 'awaiting_approval' || outcome === 'queued'
      ? null
      : now,
    actions,
  };
  const awaitingAction = actions.find(action => action.status === 'awaiting_approval');
  const persistedRunContext = awaitingAction
    ? { ...runContext, actionId: awaitingAction.actionId }
    : runContext;
  state.runContext = persistedRunContext;
  runRecord.actionId = persistedRunContext.actionId;
  const workflowRuns = [
    ...existingRuns.filter(run => run.runId !== runContext.runId),
    runRecord,
  ].slice(-25);

  await updateChatThreadMetadata(threadId, {
    ...metadata,
    pendingApproval: state.pendingApproval ?? null,
    pendingApprovalOwner: state.pendingApproval ? {
      requestId: state.pendingApproval.executionId || state.pendingApproval.toolCallId,
      agentType: state.currentAgent,
    } : null,
    requiresApproval: state.requiresApproval === true,
    ...(state.leadWorkflowExecuted !== undefined ? { leadWorkflowExecuted: state.leadWorkflowExecuted } : {}),
    ...(state.leadReviewApproved !== undefined ? { leadReviewApproved: state.leadReviewApproved } : {}),
    ...(state.deferredLeadReviewPipeline !== undefined
      ? { deferredLeadReviewPipeline: state.deferredLeadReviewPipeline }
      : {}),
    ...(state.selectedLeadIds !== undefined ? { selectedLeadIds: state.selectedLeadIds } : {}),
    runContext: persistedRunContext,
    workflowOutcome: outcome,
    workflowRun: runRecord,
    workflowRuns,
  });
  webSocketEmitter.emit(state.userId, 'workflow_run_status', {
    thread_id: threadId,
    run_id: runContext.runId,
    turn_id: runContext.turnId,
    action_id: persistedRunContext.actionId,
    status: outcome,
    updated_at: now,
  });
}

type TurnResponse = { agentType: string; content: string; metadata?: Record<string, unknown> };

/**
 * Save every specialist reply of a turn except the last, which the caller saves
 * as the turn's response. A turn that ran several specialists (a pipeline step
 * plus its handoff) streams each reply live; without this, every reply but the
 * last disappears when the conversation is reloaded.
 */
export async function saveIntermediateResponses(
  userId: number,
  threadId: number,
  responses: ReadonlyArray<TurnResponse>,
  extraMetadata: Record<string, unknown> = {},
): Promise<void> {
  for (const response of responses.slice(0, -1)) {
    if (!response.content?.trim()) continue;
    try {
      await MessageService.saveMessage({
        userId, threadId, role: 'assistant', content: response.content,
        agentType: response.agentType, metadata: { ...(response.metadata || {}), ...extraMetadata },
      });
    } catch (err) {
      logger.error({ err, threadId }, '[chatController] Failed to save intermediate response');
    }
  }
}

/**
 * Convert Agent state to API response format
 */
export function stateToResponse(state: AgentState) {
  // A routing-only turn may leave the newly persisted user message at the end
  // of state.messages. Only an assistant message created after that latest
  // user turn is eligible; selecting an older reply would duplicate it.
  let lastUserIndex = -1;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  const lastMessage = state.messages
    .slice(lastUserIndex + 1)
    .reverse()
    .find(message => message.role === 'assistant');
  let content: string = '';
  if (typeof lastMessage?.content === 'string') {
    content = lastMessage.content;
  } else if (lastMessage?.content != null) {
    content = JSON.stringify(lastMessage.content);
  }
  
  const recommendedAgents: string[] = [];
  if (state.icpProfile?.recommendedAgentScores) {
    const scores = state.icpProfile.recommendedAgentScores;
    Object.entries(scores)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .forEach(([agent]) => {
        recommendedAgents.push(agent);
      });
  }
  
  const responseId = state.lastResponseId || `response-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  
  const safeContent = sanitizeAssistantContent(content);
  return {
    role: 'assistant',
    content: safeContent,
    agentType: lastMessage?.agentType || state.currentAgent || 'supervisor',
    icpId: state.icpProfile?.id,
    fitScore: state.icpProfile?.fitScore,
    recommendedAgents,
    metadata: sanitizeErrorFields({
      ...(lastMessage?.metadata || {}),
      responseId,
      icpId: state.icpProfile?.id,
      fitScore: state.icpProfile?.fitScore,
      requiresApproval: state.requiresApproval,
      pendingApproval: state.pendingApproval,
      actionButtons: state.actionButtons,
      workflowOutcome: state.workflowOutcome,
      runId: state.runContext?.runId,
      turnId: state.runContext?.turnId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolResults: (state.toolResults || []).map((tr: any) => ({
        toolName: tr.toolName,
        toolCallId: tr.toolCallId,
        success: tr.success,
        error: tr.error ? toUserFacingError(tr.error) : undefined,
        // Saved on the reply and sent to the browser, which only needs the
        // receipt. Full outputs (crawled pages, lead lists, catalogs) stay in
        // the tool's own receipt message.
        result: typeof tr.result === 'string' ? tr.result.slice(0, 2000)
          : tr.result === undefined ? undefined : JSON.parse(compactToolResult(tr.result, 4000)),
      })),
      recommendedAgents,
    }),
    messageId: undefined as number | undefined,
    createdAt: undefined as Date | undefined,
  };
}

function approvalReplayResponse(
  res: Response,
  approval: {
    status: string;
    decision: string;
    executionResult: unknown;
    executionError: string | null;
  },
) {
  if (approval.status === 'running') {
    return res.status(202).json({ success: true, replayed: true, status: 'running' });
  }
  if (approval.status === 'failed') {
    return res.status(422).json({
      success: false,
      replayed: true,
      status: 'failed',
      error: approval.executionError || 'Approved tool execution failed',
      result: approval.executionResult,
    });
  }
  return res.json({
    success: approval.status === 'succeeded' || approval.status === 'rejected',
    replayed: true,
    status: approval.status,
    approved: approval.decision === 'approve',
    result: approval.executionResult,
  });
}

/**
 * Core message processing function — no Express dependency.
 */
export async function processMessageDirect(
  userId: number, content: string, providedThreadId?: number | null, businessProfileId?: number,
  attachments?: ConversationAttachmentReference[], onThreadResolved?: (threadId: number) => void,
  routeToAgent?: 'lead_generation', requestId?: string,
): Promise<Awaited<ReturnType<typeof processMessageDirectUncoordinated>>> {
  if (providedThreadId && !isPostgresIntegerId(providedThreadId)) {
    return { message: null, response: null, threadId: 0, error: 'Invalid thread ID', code: 400 };
  }
  const execute = () => processMessageDirectUncoordinated(userId, content, providedThreadId, businessProfileId, attachments,
    threadId => { const turn = currentConversationRequest(); if (turn) turn.conversationId = threadId; onThreadResolved?.(threadId); }, routeToAgent);
  // Unit callers keep their injected stores. All real API and WS paths acquire
  // the durable turn claim, including legacy clients without an explicit ID.
  if (!requestId) return execute();
  if (providedThreadId) {
    const owned = await getChatThreadById(Number(providedThreadId));
    if (!owned || owned.userId !== userId) return { message: null, response: null, threadId: 0, error: 'Thread not found', code: 404 };
  }
  return conversationRequests.run({ userId, kind: providedThreadId ? 'campaign' : 'campaign_init', conversationId: Number(providedThreadId || 0),
    requestId: requestId || randomUUID(), input: { content, businessProfileId, attachments, routeToAgent } }, execute);
}

async function processMessageDirectUncoordinated(
  userId: number,
  content: string,
  providedThreadId?: number | null,
  businessProfileId?: number,
  attachments?: ConversationAttachmentReference[],
  onThreadResolved?: (threadId: number) => void,
  routeToAgent?: 'lead_generation',
): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any;
  threadId: number;
  fitScore?: number;
  currentAgent?: string;
  requiresApproval?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actionButtons?: any;
  error?: string;
  code?: number;
}> {
  if (!content) {
    return { message: null, response: null, threadId: 0, error: 'content is required', code: 400 };
  }

  const MAX_CONTENT_BYTES = 10 * 1024; // 10 KB
  if (Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES) {
    logger.warn({ userId }, '[chatController] Message rejected: exceeds 10KB limit');
    return {
      message: null, response: null, threadId: 0,
      error: `Message too large. Maximum allowed size is ${MAX_CONTENT_BYTES} bytes.`,
      code: 413,
    };
  }

  const normalizedThreadId = providedThreadId == null ? undefined : Number(providedThreadId);
  if (normalizedThreadId !== undefined && (!Number.isInteger(normalizedThreadId) || normalizedThreadId <= 0)) {
    return { message: null, response: null, threadId: 0, error: 'Invalid thread ID', code: 400 };
  }
  if (normalizedThreadId !== undefined) {
    const existingThread = await getChatThreadById(normalizedThreadId);
    if (!existingThread || existingThread.userId !== userId) {
      return { message: null, response: null, threadId: 0, error: 'Thread not found', code: 404 };
    }
  }

  let validatedBusinessProfileId: number | undefined;
  if (businessProfileId !== undefined) {
    const parsedBusinessProfileId = Number(businessProfileId);
    if (!Number.isInteger(parsedBusinessProfileId) || parsedBusinessProfileId <= 0) {
      return { message: null, response: null, threadId: 0, error: 'Invalid business profile ID', code: 400 };
    }
    const businessProfile = await getCompanySettingsById(parsedBusinessProfileId);
    if (!businessProfile || businessProfile.userId !== userId) {
      return { message: null, response: null, threadId: 0, error: 'Business profile not found', code: 404 };
    }
    validatedBusinessProfileId = parsedBusinessProfileId;
  }

  const { checkUserCredits } = await import('../middleware/creditCheck.js');
  const creditCheck = await checkUserCredits(userId);
  if (!creditCheck.allowed) {
    const errorText = creditCheck.error || 'Insufficient credits. Please recharge your wallet to continue.';
    let savedThreadId = normalizedThreadId || 0;
    try {
      let threadIdToUse = normalizedThreadId;
      if (!threadIdToUse) {
        const newThread = await createChatThread(userId, undefined, validatedBusinessProfileId);
        threadIdToUse = newThread.id;
        savedThreadId = newThread.id;
        await updateChatThread(threadIdToUse, content.length > 50 ? content.substring(0, 47) + '...' : content);
      }
      await MessageService.saveMessage({ userId, threadId: threadIdToUse, role: 'user', content, agentType: 'user' });
      await MessageService.saveMessage({ userId, threadId: threadIdToUse, role: 'system', content: errorText, agentType: 'orchestrator', metadata: { isError: true, errorCode: 402 } });
    // eslint-disable-next-line no-empty
    } catch (_) {}
    return { message: null, response: null, threadId: savedThreadId, error: errorText, code: 402 };
  }

  let threadId = normalizedThreadId;
  let isFirstMessage = false;

  if (!threadId) {
    let assignBusinessId = validatedBusinessProfileId;
    if (!assignBusinessId) {
      const businessProfile = await getCompanySettingsByUserId(userId);
      if (businessProfile) assignBusinessId = businessProfile.id;
    }
    const newThread = await createChatThread(userId, undefined, assignBusinessId);
    threadId = newThread.id;
    isFirstMessage = true;
  } else {
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return { message: null, response: null, threadId: 0, error: 'Thread not found or access denied', code: 403 };
    }
    await updateChatThreadTimestamp(threadId);
    // The in-memory history cache is empty after an API restart. Determine
    // first-message status from the durable conversation rows so a later
    // approval or recovery message cannot overwrite the campaign title.
    isFirstMessage = !(await hasUserMessageInThread(threadId));
  }

  await bindConversationRequest(threadId);
  const performTurn = async () => {
  onThreadResolved?.(threadId);
  const { release: releaseMutex } = await ThreadService.acquireThreadMutex(userId, threadId);
  let activeTurnState: AgentState | undefined;

  try {
    let preparedAttachments;
    try {
      preparedAttachments = await prepareConversationAttachments({
        userId,
        threadId,
        attachments,
      });
    } catch (error) {
      return {
        message: null,
        response: null,
        threadId,
        error: error instanceof Error ? error.message : 'Unable to prepare attachments',
        code: 400,
      };
    }
    const agentContent = appendConversationAttachmentContext(content, preparedAttachments);
    const userMessage = preparedAttachments.length > 0
      ? await persistConversationUserMessageWithAttachments({
          userId,
          threadId,
          content,
          attachments: preparedAttachments,
        })
      : await MessageService.saveMessage({
          userId,
          threadId,
          role: 'user',
          content,
          agentType: 'user',
        });
    const browserUserMessage = publicConversationMessage(userMessage);

    if (isFirstMessage) {
      await updateChatThread(threadId, content.length > 50 ? content.substring(0, 47) + '...' : content);
    }

    const llmConfig = await getUserLLMConfig(userId);
    if (!llmConfig) {
      const errorText = await noAIProviderMessage();
      await MessageService.saveMessage({ userId, threadId, role: 'system', content: errorText, agentType: 'orchestrator', metadata: { isError: true, errorCode: 400 } });
      return { message: browserUserMessage, response: null, threadId, error: errorText, code: 400 };
    }

    const existingState = await ThreadService.loadThreadState(userId, threadId, {
      excludeMessageId: userMessage.id,
    });
    // Classify once with full conversation/state. No English phrase shortcut.
    // This result is passed only through the server-side control for this turn.
    const turnIntent = await runUnifiedRouter({
      ...createInitialState(userId, threadId), ...existingState, llmConfig,
      messages: [...(existingState.messages || []), { role: 'user', content: agentContent }],
    });
    await checkpointConversationRequest();
    if (turnIntent.semanticRequest?.status === 'campaign_actions'
      && turnIntent.action === 'question' && !turnIntent.needsClarification
      && preparedAttachments.length === 0) {
      const widgets = await WidgetStateModel.findByThreadForUser(userId, threadId);
      const outreachReviewIds = widgets.filter(widget => widget.toolName === 'send_outreach_messages').map(widget => widget.id);
      const storedOutreach = outreachReviewIds.length ? await storedOutreachStatusForReviews(userId, threadId, outreachReviewIds) : undefined;
      let pendingExecutionApproval: PendingExecutionApprovalLedger = { status: 'unavailable' };
      try {
        pendingExecutionApproval = { status: 'available', metadata: await getChatThreadMetadata(threadId) };
      } catch {
        logger.warn({ userId, threadId }, '[chatController] Pending approval status read unavailable');
      }
      const statusContent = buildCampaignActionStatus(widgets, storedOutreach, pendingExecutionApproval, existingState.icpProfile);
      const savedResponse = await MessageService.saveMessage({
        userId, threadId, role: 'assistant', content: statusContent, agentType: 'orchestrator',
        metadata: { statusSource: 'durable_widgets', widgetIds: widgets.map(widget => widget.id) },
      });
      webSocketEmitter.emitChatMessage(userId, threadId, {
        id: savedResponse.id, role: savedResponse.role, content: savedResponse.content,
        agentType: savedResponse.agentType || 'orchestrator', metadata: savedResponse.metadata,
        timestamp: new Date(savedResponse.createdAt).getTime(),
      });
      return { message: browserUserMessage, response: publicConversationMessage(savedResponse), threadId };
    }

    if (turnIntent.needsClarification) {
      const clarification = createConversationClarification(existingState, turnIntent, userMessage.id);
      const metadata = await getChatThreadMetadata(threadId) || {};
      await updateChatThreadMetadata(threadId, { ...metadata, pendingClarification: clarification });
      const savedResponse = await MessageService.saveMessage({ userId, threadId, role: 'assistant',
        content: turnIntent.response, agentType: 'orchestrator', metadata: { clarification } });
      webSocketEmitter.emitChatMessage(userId, threadId, {
        id: savedResponse.id, role: savedResponse.role, content: savedResponse.content,
        agentType: 'orchestrator', timestamp: new Date(savedResponse.createdAt).getTime(),
      });
      return { message: browserUserMessage, response: publicConversationMessage(savedResponse), threadId };
    }
    const clarificationMeta = await getChatThreadMetadata(threadId) || {};
    const pendingClarification = readPendingClarification(clarificationMeta.pendingClarification);
    if (pendingClarification && answersPendingClarification(pendingClarification, turnIntent)) {
      await updateChatThreadMetadata(threadId, { ...clarificationMeta,
        pendingClarification: null, lastClarification: { ...pendingClarification,
          status: 'answered', answerMessageId: userMessage.id, answeredAt: new Date().toISOString(), answer: content.slice(0, 12000) } });
      existingState.pendingClarification = undefined;
    }
    if (routeToAgent === 'lead_generation') existingState.currentAgent = routeToAgent;
    // Include preprocessing in failure reconciliation too: ownership checks,
    // recipient snapshots and workflow setup can fail before processMessage.
    activeTurnState = { ...createInitialState(userId, threadId), ...existingState };
    const candidateLeadIds = extractExplicitLeadIds(content);
    const explicitLeadIds = await MessageService.resolveExplicitLeadSelection({
      userId, message: content, candidateIds: candidateLeadIds,
      selectedLeadIds: existingState.selectedLeadIds,
    }) || [];
    if (explicitLeadIds.length > 0) {
      const ownedLeads = await Promise.all(
        explicitLeadIds.map((leadId) => LeadModel.findByIdForUser(leadId, userId)),
      );
      const missingLeadIds = explicitLeadIds.filter((_leadId, index) => !ownedLeads[index]);
      if (missingLeadIds.length > 0) {
        const errorText = `I couldn't prepare outreach because these lead IDs were not found in your account: ${missingLeadIds.join(', ')}.`;
        const savedResponse = await MessageService.saveMessage({
          userId,
          threadId,
          role: 'assistant',
          content: errorText,
          agentType: 'outreach',
          metadata: { isError: true, errorCode: 400, missingLeadIds },
        });
        webSocketEmitter.emitChatMessage(userId, threadId, {
          id: savedResponse.id,
          role: savedResponse.role,
          content: savedResponse.content,
          agentType: savedResponse.agentType || 'outreach',
          metadata: savedResponse.metadata,
          timestamp: new Date(savedResponse.createdAt).getTime(),
        });
        return {
          message: browserUserMessage,
          response: publicConversationMessage(savedResponse),
          threadId,
        };
      }

      if (isCurrentIcpRevisionApproved(existingState.icpProfile)) {
        await persistApprovedLeadSelection({ userId, threadId, leadIds: explicitLeadIds, originalRequest: content });
      }
      const previousSelection = existingState.selectedLeadIds || [];
      const selectionChanged = previousSelection.length !== explicitLeadIds.length
        || explicitLeadIds.some(id => !previousSelection.includes(id));
      if (selectionChanged) existingState.leadReviewApproved = false;
      existingState.selectedLeadIds = explicitLeadIds;
      const existingMetadata = await getChatThreadMetadata(threadId) || {};
      await updateChatThreadMetadata(threadId, {
        ...existingMetadata,
        selectedLeadIds: explicitLeadIds,
        ...(selectionChanged ? { leadReviewApproved: false } : {}),
        selectedLeadSelection: {
          leadIds: explicitLeadIds,
          selectedAt: new Date().toISOString(),
          source: 'explicit_chat_message',
        },
      });
    }
    existingState.llmConfig = llmConfig;
    const durableRun = await ensureConversationWorkflowRun({
      userId,
      threadId,
      originalRequest: content,
      stage: isCurrentIcpRevisionApproved(existingState.icpProfile) ? 'agent_selection' : 'icp_draft',
    });
    existingState.runContext = {
      userId,
      threadId,
      runId: durableRun.id,
      turnId: randomUUID(),
    };
    bindConversationWorkflow(existingState.runContext.runId, existingState.runContext.turnId);
    if (turnIntent.semanticRequest?.lead.strategySelection?.status === 'selected'
      && isCurrentIcpRevisionApproved(existingState.icpProfile)) {
      const choice = resolveLeadStrategyIntent(turnIntent, await loadSelectableLeadStrategies());
      if (choice.kind === 'clarify') throw new Error(choice.response);
      if (choice.kind === 'selected') {
        const retiredApproval = await recordConfirmedLeadStrategy({
          userId, threadId, workflowIds: choice.workflowIds, platforms: choice.platforms,
          originalRequest: content, state: existingState, runId: durableRun.id, source: 'semantic_conversation',
        });
        const metadata = await getChatThreadMetadata(threadId) || {};
        await updateChatThreadMetadata(threadId, { ...metadata, selectedWorkflows: choice.workflowIds });
        existingState.selectedWorkflows = choice.workflowIds;
        if (retiredApproval) {
          existingState.pendingApproval = null;
          existingState.requiresApproval = false;
        }
      }
    }
    existingState.workflowOutcome = 'running';
    const startingState = createInitialState(userId, threadId);
    Object.assign(startingState, existingState);
    activeTurnState = startingState;
    await persistWorkflowRunState(threadId, startingState, 'running');

    const approvalDecision = existingState.requiresApproval && existingState.pendingApproval
      ? await MessageService.resolvePendingApprovalDecision({
          userId, threadId, llmConfig, message: content,
          pendingApproval: existingState.pendingApproval, currentAgent: existingState.currentAgent,
          turnIntent,
          recentMessages: (existingState.messages || []).filter(message => message.role === 'user' || message.role === 'assistant').slice(-8).map(message => ({ role: message.role, content: message.content })),
        })
      : null;

    if (approvalDecision === 'approve' || approvalDecision === 'reject') {
      const fullState = createInitialState(userId, threadId);
      Object.assign(fullState, existingState);
      fullState.workflowOutcome = 'running';

      const approved = approvalDecision === 'approve';
      const pending = fullState.pendingApproval;
      const requestId = pending?.executionId || pending?.toolCallId;
      if (!pending || !requestId) {
        logger.warn({ userId, threadId }, '[chatController] Refusing unbound natural-language approval');
        return {
          message: browserUserMessage,
          response: {
            role: 'assistant',
            content: 'That approval request is no longer valid. Please ask the agent to prepare the action again.',
            agentType: fullState.currentAgent || 'supervisor',
            metadata: { isError: true, errorCode: 409 },
          },
          threadId,
          error: 'Pending approval is missing a request identity',
          code: 409,
        };
      }

      const claim = await ConversationToolApprovalModel.claim({
        userId,
        threadId,
        requestId,
        toolName: pending.toolName,
        toolArgs: pending.args,
        approved,
        runId: typeof pending.args?.workflowRunId === 'string' ? pending.args.workflowRunId : fullState.runContext?.runId,
        resourceType: typeof pending.args?.leadInputSetId === 'string' ? 'lead_input_set' : undefined,
        resourceId: typeof pending.args?.leadInputSetId === 'string' ? pending.args.leadInputSetId : undefined,
        resourceRevision: Number.isInteger(Number(pending.args?.leadInputSetRevision)) ? Number(pending.args.leadInputSetRevision) : undefined,
      });
      if (!claim.claimed) {
        const content = claim.approval.status === 'running'
          ? 'That approved action is already running.'
          : `That approval has already been ${claim.approval.status}.`;
        const response = {
          role: 'assistant',
          content,
          agentType: fullState.currentAgent || 'supervisor',
          metadata: {
            approvalStatus: claim.approval.status,
            approvalRequestId: requestId,
            replayed: true,
          },
        };
        const savedMessage = await MessageService.saveMessage({
          userId,
          threadId,
          role: 'assistant',
          content,
          agentType: response.agentType,
          metadata: response.metadata,
        });
        webSocketEmitter.emitChatMessage(userId, threadId, {
          id: savedMessage.id,
          ...response,
          metadata: { ...response.metadata, persisted: true },
        });
        return {
          message: browserUserMessage,
          response,
          threadId,
          currentAgent: fullState.currentAgent,
          requiresApproval: false,
          actionButtons: [],
        };
      }

      await clearPendingApprovalIfMatches(threadId, userId, requestId, pending.toolName);

      let result: AgentState;
      try {
        if (approved) await approveBoundLeadInputSet(fullState, userId, threadId);
        result = await handleApproval(userId, threadId, approved, fullState);
        if (approved) await finalizeLeadWorkflowStage(fullState, result, userId, threadId);
      } catch (error: unknown) {
        if (approved) {
          await ConversationToolApprovalModel.complete(
            claim.approval.id,
            claim.approval.leaseToken || '',
            false,
            undefined,
            error instanceof Error ? error.message : 'Approved tool execution failed',
          );
        }
        throw error;
      }
      if (!approved) result.workflowOutcome = 'cancelled';

      if (approved) {
        const matchingToolResult = [...(result.toolResults || [])]
          .reverse()
          .find((toolResult) => toolResult.toolName === pending.toolName);
        const completedApproval = await ConversationToolApprovalModel.complete(
          claim.approval.id,
          claim.approval.leaseToken || '',
          matchingToolResult?.success === true,
          matchingToolResult,
          matchingToolResult?.success === true
            ? undefined
            : matchingToolResult?.error || `Approved tool "${pending.toolName}" did not complete successfully`,
        );
        if (!completedApproval) {
          throw new Error('Approval execution lease is no longer current; the result requires reconciliation.');
        }
      }
      await persistWorkflowRunState(threadId, result);
      const response = stateToResponse(result);

      const savedMessage = await MessageService.saveMessage({
        userId, threadId, role: 'assistant', content: response.content,
        agentType: response.agentType, metadata: response.metadata,
      });

      webSocketEmitter.emitChatMessage(userId, threadId, {
        id: savedMessage.id, role: 'assistant', content: response.content,
        agentType: response.agentType, metadata: { ...response.metadata, persisted: true },
      });

      webSocketEmitter.emitAgentStatus(userId, result.currentAgent || 'supervisor', 'completed', undefined, undefined, threadId);

      try {
        const existingMetadata = await getChatThreadMetadata(threadId) || {};
        const metadataPendingApproval = isPlainRecord(existingMetadata.pendingApproval)
          ? existingMetadata.pendingApproval as unknown as AgentState['pendingApproval']
          : undefined;
        if (pendingApprovalMatchesRequest(
          metadataPendingApproval,
          requestId,
          pending.toolName,
        )) {
          delete existingMetadata.pendingApproval;
        }
        if (approved && result.leadWorkflowExecuted) {
          existingMetadata.leadWorkflowExecuted = true;
          existingMetadata.leadReviewApproved = false;
          delete existingMetadata.selectedWorkflows;
        }
        await updateChatThreadMetadata(threadId, existingMetadata);
      } catch (err) {
        logger.error({ err, threadId }, '[chatController] Failed to update thread metadata after resolved approval');
      }

      return {
        message: browserUserMessage, response, threadId, fitScore: result.icpProfile?.fitScore,
        currentAgent: result.currentAgent, requiresApproval: result.requiresApproval, actionButtons: result.actionButtons,
      };
    }
    // Natural-language workflow selection belongs to Marcus and the real
    // workflow catalog. Only bound UI actions persist selected workflow IDs.

    const previousAgent = existingState.currentAgent || 'supervisor';
    webSocketEmitter.emitAgentStatus(userId, previousAgent, 'thinking', undefined, undefined, threadId);

    if (existingState.messages && shouldCompactBeforeProcessing(existingState.messages, existingState.llmConfig?.modelName)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      existingState.messages = await compactMessagesWithAI(existingState.messages, userId, threadId) as any;
    }

    const result = await processMessage(
      userId,
      threadId,
      agentContent,
      existingState,
      { ...(routeToAgent ? { forceTarget: routeToAgent } : {}), turnIntent },
    );
    if (result.requiresApproval && result.pendingApproval) {
      const pendingRequestId = result.pendingApproval.executionId || result.pendingApproval.toolCallId;
      if (!pendingRequestId) {
        result.pendingApproval = {
          ...result.pendingApproval,
          executionId: `approval-${threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          createdAt: result.pendingApproval.createdAt || Date.now(),
        };
      }
    }
    await persistWorkflowRunState(threadId, result);
    await checkpointConversationRequest();
    const response = stateToResponse(result);

    const intermediateResponses = result._intermediateResponses || [];
    await saveIntermediateResponses(userId, threadId, intermediateResponses);

    let alreadyPersistedResponse = false;
    if (!response.content.trim()) {
      const recovery = recoverEmptyAssistantTurn(
        userMessage.id,
        await getChatMessagesByThreadId(threadId, 30),
        intermediateResponses,
      );
      response.content = sanitizeAssistantContent(recovery.content);
      if (recovery.agentType) response.agentType = recovery.agentType;
      if (recovery.persistedMessage) {
        response.messageId = recovery.persistedMessage.id;
        response.createdAt = recovery.persistedMessage.createdAt;
        const persistedMetadata = recovery.persistedMessage.metadata;
        if (persistedMetadata && typeof persistedMetadata === 'object' && !Array.isArray(persistedMetadata)) {
          response.metadata = {
            ...response.metadata,
            ...(persistedMetadata as Record<string, unknown>),
          };
        }
        alreadyPersistedResponse = true;
      }
    }

    if (response.content && !alreadyPersistedResponse) {
      const savedResponse = await MessageService.saveMessage({
        userId, threadId, role: 'assistant', content: response.content,
        agentType: response.agentType, metadata: response.metadata,
      });
      response.messageId = savedResponse.id;
      response.createdAt = savedResponse.createdAt;
      webSocketEmitter.emitChatMessage(userId, threadId, {
        id: savedResponse.id,
        role: savedResponse.role,
        content: savedResponse.content,
        agentType: savedResponse.agentType || response.agentType,
        metadata: savedResponse.metadata,
        timestamp: new Date(savedResponse.createdAt).getTime(),
      });
    }

    webSocketEmitter.emitAgentStatus(userId, result.currentAgent || 'supervisor', 'completed', undefined, undefined, threadId);

    if (result.requiresApproval && result.pendingApproval) {
      try {
        const existingMetadata = await getChatThreadMetadata(threadId) || {};
        await updateChatThreadMetadata(threadId, { ...existingMetadata, pendingApproval: result.pendingApproval });
      // eslint-disable-next-line no-empty
      } catch (_) {}
    }

    if (result.agentPipeline && result.agentPipeline.length > 0) {
      try {
        const existingMetadata = await getChatThreadMetadata(threadId) || {};
        await updateChatThreadMetadata(threadId, {
          ...existingMetadata,
          agentPipeline: result.agentPipeline,
          deferredLeadReviewPipeline: result.deferredLeadReviewPipeline || [],
          agentPipelineIndex: result.agentPipelineIndex || 0,
          pipelineRequest: result.pipelineRequest || existingMetadata.pipelineRequest,
        });
      // eslint-disable-next-line no-empty
      } catch (_) {}
    } else if (result.agentPipeline && result.agentPipeline.length === 0) {
      try {
        const existingMetadata = await getChatThreadMetadata(threadId) || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (existingMetadata as any).agentPipeline;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (existingMetadata as any).agentPipelineIndex;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (existingMetadata as any).pipelineRequest;
        await updateChatThreadMetadata(threadId, existingMetadata);
      // eslint-disable-next-line no-empty
      } catch (_) {}
    }

    if (result.selectedWorkflows && result.selectedWorkflows.length > 0) {
      try {
        const existingMetadata = await getChatThreadMetadata(threadId) || {};
        await updateChatThreadMetadata(threadId, { ...existingMetadata, selectedWorkflows: result.selectedWorkflows });
      // eslint-disable-next-line no-empty
      } catch (_) {}
    } else if (result.selectedWorkflows && result.selectedWorkflows.length === 0) {
      try {
        const existingMetadata = await getChatThreadMetadata(threadId) || {};
        if (existingMetadata.selectedWorkflows) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (existingMetadata as any).selectedWorkflows;
          await updateChatThreadMetadata(threadId, existingMetadata);
        }
      // eslint-disable-next-line no-empty
      } catch (_) {}
    }

    ThreadService.scheduleAutoCompaction(userId, threadId);

    return {
      message: browserUserMessage, response, threadId, fitScore: result.icpProfile?.fitScore,
      currentAgent: result.currentAgent, requiresApproval: result.requiresApproval, actionButtons: result.actionButtons,
    };
  } catch (error) {
    // An exception before the orchestrator's normal completion must not leave
    // the durable turn and every connected composer permanently "running".
    if (activeTurnState) {
      try {
        const currentState = await ThreadService.loadThreadState(userId, threadId);
        const failedState = { ...activeTurnState, ...currentState, runContext: activeTurnState.runContext };
        await persistWorkflowRunState(threadId, failedState, 'failed');
        webSocketEmitter.emitAgentStatus(userId, failedState.currentAgent || 'orchestrator', 'error', 'This turn could not complete. Review the action status before retrying.', undefined, threadId);
      } catch (reportError) {
        logger.error({ err: reportError, threadId }, '[chatController] Could not finalize failed turn status');
      }
    }
    throw error;
  } finally {
    releaseMutex();
  }
  };
  const initial = currentConversationRequest();
  if (initial?.kind === 'campaign_init') return conversationRequests.run({
    userId, kind: 'campaign', conversationId: threadId, requestId: initial.requestId, input: initial.input,
  }, performTurn);
  return performTurn();
}

const NON_RESUMING_WIDGET_TOOLS = new Set(['generate_lead_inputs']);
const OPEN_WIDGET_STATUSES = new Set(['active', 'draft', 'running', 'queued', 'provider_succeeded']);

function compactWidgetResult(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compactWidgetResult(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['imageData', 'videoData', 'content', 'base64'].includes(key))
      .slice(0, 40)
      .map(([key, nested]) => [key, compactWidgetResult(nested, depth + 1)]),
  );
}

export async function resumeAfterIcpApproval(input: { userId: number; threadId: number; runId: string; icpId: number; revision: number }): Promise<boolean> {
  const { release } = await ThreadService.acquireThreadMutex(input.userId, input.threadId);
  let actionId: string | undefined;
  try {
    const state = await ThreadService.loadThreadState(input.userId, input.threadId);
    const index = state.agentPipelineIndex ?? 0;
    const target = state.agentPipeline?.[index + 1];
    if (state.agentPipeline?.[index] !== 'icp_generation' || !target
      || !['lead_generation', 'content_studio', 'performance_marketing'].includes(target)
      || !state.pipelineRequest?.trim() || state.pendingApproval
      || state.runContext?.runId !== input.runId
      || !isCurrentIcpRevisionApproved(state.icpProfile)
      || state.icpProfile?.id !== input.icpId || state.icpProfile.revision !== input.revision) return false;
    const proposedId = randomUUID();
    const action = await createConversationWorkflowAction({
      actionId: proposedId, runId: input.runId, userId: input.userId, threadId: input.threadId,
      actionType: 'resume_after_icp', status: 'running',
      idempotencyKey: `resume_after_icp:${input.icpId}:${input.revision}`,
      payload: { target, request: state.pipelineRequest },
    });
    if (action.id !== proposedId) {
      if (action.status === 'failed') throw new Error('ICP is approved, but its pending workflow continuation failed and needs review. It was not rerun.');
      return true; // Another attempt owns the durable continuation.
    }
    actionId = action.id;
    await transitionConversationWorkflowRun({ runId: input.runId, userId: input.userId, threadId: input.threadId,
      toStage: 'agent_running', status: 'running' });
    const result = await processMessage(input.userId, input.threadId,
      `Continue the pending request after approval of ICP ${input.icpId} revision ${input.revision}: ${state.pipelineRequest}\nOnly the ICP was approved. Preserve every platform, input, outreach, creative, publication, activation and spend approval gate.`, {
        ...state, requiresApproval: false, agentPipelineIndex: index + 1,
        currentAgent: target,
        icpApprovalContinuation: { agent: target, icpId: input.icpId, revision: input.revision },
        runContext: { userId: input.userId, threadId: input.threadId, runId: input.runId, turnId: randomUUID(), actionId },
      });
    await persistWorkflowRunState(input.threadId, result);
    await saveIntermediateResponses(input.userId, input.threadId, result._intermediateResponses || [],
      { resumedFromIcpId: input.icpId, workflowResumed: true });
    const continuationFailed = ['failed', 'timed_out', 'cancelled'].includes(result.workflowOutcome || '');
    await transitionConversationWorkflowRun({ runId: input.runId, userId: input.userId, threadId: input.threadId,
      onlyFromStage: 'agent_running',
      toStage: continuationFailed ? 'needs_attention' : target === 'performance_marketing' ? 'ad_draft'
        : target === 'content_studio' ? 'content_awaiting_review'
        : result.pendingApproval?.toolName === 'execute_lead_workflow' ? 'lead_inputs_awaiting_approval' : 'lead_strategy_awaiting_approval',
      status: continuationFailed ? 'failed' : result.requiresApproval ? 'awaiting_approval' : 'awaiting_input',
    });
    const metadata = await getChatThreadMetadata(input.threadId) || {};
    await updateChatThreadMetadata(input.threadId, { ...metadata,
      agentPipeline: result.agentPipeline, agentPipelineIndex: result.agentPipelineIndex,
      pipelineRequest: result.pipelineRequest || state.pipelineRequest,
    });
    const response = stateToResponse(result);
    if (response.content) {
      const saved = await MessageService.saveMessage({ userId: input.userId, threadId: input.threadId,
        role: 'assistant', content: response.content, agentType: response.agentType,
        metadata: { ...response.metadata, resumedFromIcpId: input.icpId, workflowResumed: true } });
      webSocketEmitter.emitChatMessage(input.userId, input.threadId, {
        id: saved.id, role: saved.role, content: saved.content, agentType: saved.agentType || response.agentType,
        metadata: saved.metadata, timestamp: new Date(saved.createdAt).getTime(),
      });
    }
    await setConversationWorkflowActionStatus({ actionId, runId: input.runId, userId: input.userId,
      threadId: input.threadId, status: continuationFailed ? 'failed' : 'succeeded', output: { outcome: result.workflowOutcome, target } });
    return true;
  } catch (error) {
    if (actionId) {
      await setConversationWorkflowActionStatus({ actionId, runId: input.runId, userId: input.userId,
        threadId: input.threadId, status: 'failed', error: toUserFacingError(error) });
      await transitionConversationWorkflowRun({ runId: input.runId, userId: input.userId, threadId: input.threadId,
        onlyFromStage: 'agent_running', toStage: 'needs_attention', status: 'failed' });
    }
    throw error;
  } finally { release(); }
}

export function canResumeWidgetPipeline(
  state: Partial<AgentState>,
  toolName: string,
  hasOpenSibling: boolean,
): boolean {
  return !NON_RESUMING_WIDGET_TOOLS.has(toolName)
    && !hasOpenSibling
    && typeof state.pipelineRequest === 'string'
    && state.pipelineRequest.trim().length > 0
    && Array.isArray(state.agentPipeline)
    && state.agentPipeline.length > 0;
}

export function widgetContinuationInstruction(
  toolName: string,
  success: boolean,
  result: unknown,
  pipelineRequest: string,
): string {
  const durableResult = JSON.stringify(compactWidgetResult(result)).slice(0, 6000);
  return [
    '[WIDGET_EXECUTION_COMPLETE — INTERNAL WORKFLOW CONTINUATION]',
    `The user-approved ${toolName} action has already executed exactly once with status ${success ? 'succeeded' : 'failed'}.`,
    `Durable execution result: ${durableResult}`,
    `Continue the already-active campaign request without asking the user to restate it: ${pipelineRequest}`,
    `Do not invoke ${toolName} again for the completed action. Reuse every durable resource ID from the result.`,
    'Continue only the remaining workflow steps. Preserve every send, publish, activation, account, and spend approval gate; do not perform an external mutation automatically.',
    success
      ? 'If this completes your specialist step, hand off to the next agent in the existing pipeline.'
      : 'Do not retry the failed action automatically. Report the failure truthfully and prepare only a corrected review step if one is safe and necessary.',
  ].join('\n');
}

/**
 * Resume the exact pipeline that was paused when a widget-backed tool was
 * created. The continuation message exists only in orchestration memory, so a
 * user never has to restate the request and no synthetic user bubble is saved.
 */
interface WidgetCompletionInput {
  widgetId: number;
  userId: number;
  threadId: number;
  toolName: string;
  runId?: string | null;
  success: boolean;
  result: unknown;
}

export async function resumeWorkflowAfterWidgetCompletion(input: WidgetCompletionInput): Promise<boolean> {
  return await resumeDurableWidgetCompletion(input) === 'resumed';
}

export async function resumeDurableWidgetCompletion(input: WidgetCompletionInput): Promise<'resumed' | 'waiting' | 'obsolete' | 'completed' | 'failed'> {
  const { release } = await ThreadService.acquireThreadMutex(input.userId, input.threadId);
  try {
    const widgets = await WidgetStateModel.findByThreadForUser(input.userId, input.threadId);
    const completedWidget = widgets.find(widget => widget.id === input.widgetId);
    // A worker callback is only a notification. Re-read its durable identity
    // and terminal outcome before allowing it to advance any pipeline.
    if (!completedWidget
      || completedWidget.userId !== input.userId
      || completedWidget.threadId !== input.threadId
      || completedWidget.toolName !== input.toolName
      || !input.runId
      || completedWidget.runId !== input.runId
      || !['succeeded', 'failed'].includes(completedWidget.status)) return 'obsolete';
    const hasOpenSibling = widgets.some(widget =>
      widget.id !== input.widgetId
      && (!input.runId || widget.runId === input.runId)
      && OPEN_WIDGET_STATUSES.has(widget.status),
    );
    const state = await ThreadService.loadThreadState(input.userId, input.threadId);
    if (state.runContext?.runId !== input.runId) return 'obsolete';
    if (!canResumeWidgetPipeline(state, input.toolName, false)) return 'obsolete';
    if (hasOpenSibling) return 'waiting';

    const metadata = await getChatThreadMetadata(input.threadId) || {};
    const continuationRecords = isPlainRecord(metadata.widgetContinuations)
      ? metadata.widgetContinuations
      : {};
    const continuationKey = String(input.widgetId);
    const existingContinuation = isPlainRecord(continuationRecords[continuationKey])
      ? continuationRecords[continuationKey]
      : undefined;
    if (existingContinuation?.status === 'running') return 'waiting';
    if (existingContinuation?.status === 'completed') return 'completed';

    await updateChatThreadMetadata(input.threadId, {
      ...metadata,
      widgetContinuations: {
        ...continuationRecords,
        [continuationKey]: {
          status: 'running',
          toolName: input.toolName,
          runId: input.runId,
          startedAt: new Date().toISOString(),
        },
      },
    });

    const instruction = widgetContinuationInstruction(
      input.toolName,
      completedWidget.status === 'succeeded',
      completedWidget.executionResult,
      state.pipelineRequest || '',
    );
    const completedToolInputs = widgets
      .filter(widget =>
        widget.toolName === input.toolName
        && (!input.runId || widget.runId === input.runId)
        && ['succeeded', 'provider_succeeded'].includes(widget.status)
      )
      .map(widget => widget.submittedValues || widget.formValues || {})
      .filter(values => values && typeof values === 'object' && !Array.isArray(values));
    const result = await processMessage(input.userId, input.threadId, instruction, {
      ...state,
      widgetContinuation: {
        widgetId: input.widgetId,
        toolName: input.toolName,
        success: completedWidget.status === 'succeeded',
        executionResult: completedWidget.executionResult,
        completedToolInputs,
      },
    });
    await persistWorkflowRunState(input.threadId, result);
    await saveIntermediateResponses(input.userId, input.threadId, result._intermediateResponses || [],
      { workflowResumed: true, resumedFromWidgetId: input.widgetId, resumedToolName: input.toolName });
    const response = stateToResponse(result);

    if (response.content) {
      const savedResponse = await MessageService.saveMessage({
        userId: input.userId,
        threadId: input.threadId,
        role: 'assistant',
        content: response.content,
        agentType: response.agentType,
        metadata: {
          ...response.metadata,
          workflowResumed: true,
          resumedFromWidgetId: input.widgetId,
          resumedToolName: input.toolName,
        },
      });
      webSocketEmitter.emitChatMessage(input.userId, input.threadId, {
        id: savedResponse.id,
        role: savedResponse.role,
        content: savedResponse.content,
        agentType: savedResponse.agentType || response.agentType,
        metadata: savedResponse.metadata,
        timestamp: new Date(savedResponse.createdAt).getTime(),
      });
    }
    webSocketEmitter.emitAgentStatus(
      input.userId,
      result.currentAgent || 'supervisor',
      'completed',
      undefined,
      undefined,
      input.threadId,
    );

    const latestMetadata = await getChatThreadMetadata(input.threadId) || {};
    const latestContinuations = isPlainRecord(latestMetadata.widgetContinuations)
      ? latestMetadata.widgetContinuations
      : {};
    await updateChatThreadMetadata(input.threadId, {
      ...latestMetadata,
      ...(result.agentPipeline && result.agentPipeline.length > 0 ? {
        agentPipeline: result.agentPipeline,
        agentPipelineIndex: result.agentPipelineIndex || 0,
        pipelineRequest: result.pipelineRequest || state.pipelineRequest,
        deferredLeadReviewPipeline: result.deferredLeadReviewPipeline || [],
      } : {}),
      widgetContinuations: {
        ...latestContinuations,
        [continuationKey]: {
          ...(isPlainRecord(latestContinuations[continuationKey]) ? latestContinuations[continuationKey] : {}),
          status: 'completed',
          completedAt: new Date().toISOString(),
        },
      },
    });
    return 'resumed';
  } catch (error) {
    const metadata = await getChatThreadMetadata(input.threadId) || {};
    const continuationRecords = isPlainRecord(metadata.widgetContinuations)
      ? metadata.widgetContinuations
      : {};
    await updateChatThreadMetadata(input.threadId, {
      ...metadata,
      widgetContinuations: {
        ...continuationRecords,
        [String(input.widgetId)]: {
          status: 'failed',
          toolName: input.toolName,
          runId: input.runId,
          failedAt: new Date().toISOString(),
          error: error instanceof Error ? toUserFacingError(error.message) : 'Workflow continuation failed',
        },
      },
    });
    logger.error({ err: error, widgetId: input.widgetId }, '[chatController] Widget workflow continuation failed');
    return 'failed';
  } finally {
    release();
  }
}

/**
 * POST /api/chat/langgraph/message
 */
export async function langGraphMessageHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { content, message, threadId: providedThreadId, businessProfileId, idempotencyKey, attachments } = req.body;
    const routeToAgent = req.body.routeToAgent === 'lead_generation' ? 'lead_generation' : undefined;
    const normalizedContent = typeof content === 'string' ? content : message;
    const rawIdemKey: string | undefined = (req.headers['idempotency-key'] as string | undefined) || idempotencyKey;
    if (rawIdemKey && !/^[A-Za-z0-9:_-]{1,200}$/.test(rawIdemKey)) {
      return res.status(400).json({ error: 'Invalid idempotency key' });
    }
    // Every replay must recheck owned thread and durable input identity. Legacy
    // Redis receipts do not attest either and cannot bypass the coordinator.
    const result = await processMessageDirect(
      userId,
      normalizedContent,
      providedThreadId,
      businessProfileId,
      attachments,
      undefined,
      routeToAgent,
      req.body.requestId || rawIdemKey || randomUUID(),
    );
    if (result.error) {
      return res.status(result.code || 500).json({ error: result.error });
    }

    const responseBody = {
      message: result.message, response: result.response, threadId: result.threadId,
      fitScore: result.fitScore, currentAgent: result.currentAgent,
      requiresApproval: result.requiresApproval, actionButtons: result.actionButtons,
    };

    res.status(201).json(responseBody);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[chatController] Error processing message');
    if (error instanceof ConversationRequestError) return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    res.status(500).json({ error: error.message || 'Failed to process message' });
  }
}

/**
 * POST /api/chat/langgraph/approve
 */
export async function langGraphApproveHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { threadId, approved, overrides, requestId, toolName } = req.body as {
      threadId: number;
      approved: boolean;
      overrides?: Record<string, unknown>;
      requestId: string;
      toolName: string;
    };
    
    if (
      typeof threadId !== 'number' ||
      typeof approved !== 'boolean' ||
      typeof requestId !== 'string' ||
      typeof toolName !== 'string'
    ) {
      return res.status(400).json({ error: 'threadId, approved, requestId, and toolName are required' });
    }
    
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(403).json({ error: 'Thread not found or access denied' });
    }
    await ConversationToolApprovalModel.expireStaleRunning();
    const existingReceipt = await ConversationToolApprovalModel.findByRequest(
      userId,
      threadId,
      requestId,
      toolName,
    );
    const retryingSafeFailure = Boolean(
      approved &&
      existingReceipt?.status === 'failed' &&
      isRetrySafeExecutionResult(existingReceipt.executionResult),
    );
    if (existingReceipt && !retryingSafeFailure) {
      return approvalReplayResponse(res, existingReceipt);
    }

    const existingState = await ThreadService.loadThreadState(userId, threadId);
    if (
      !retryingSafeFailure &&
      (
        !existingState.requiresApproval ||
        !pendingApprovalMatchesRequest(existingState.pendingApproval ?? null, requestId, toolName)
      )
    ) {
      return res.status(409).json({
        error: 'This approval request is stale, missing, or does not match the pending tool.',
      });
    }
    
    const fullState = createInitialState(userId, threadId);
    Object.assign(fullState, existingState);
    fullState.workflowOutcome = 'running';
    const durableRun = await ensureConversationWorkflowRun({ userId, threadId, originalRequest: `Approval for ${toolName}` });
    fullState.runContext = { userId, threadId, runId: durableRun.id, turnId: randomUUID() };
    await persistWorkflowRunState(threadId, fullState, 'running');
    if (retryingSafeFailure && existingReceipt) {
      fullState.requiresApproval = true;
      fullState.pendingApproval = {
        toolName,
        args: existingReceipt.toolArgs,
        executionId: requestId,
        message: 'Retrying a verified pre-side-effect failure.',
        createdAt: Date.now(),
      };
    }
    
    let mergedArgs: Record<string, unknown>;
    try {
      mergedArgs = mergePendingApprovalArguments(
        toolName,
        fullState.pendingApproval?.args || {},
        overrides,
      );
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Approval overrides are invalid',
        code: 'INVALID_APPROVAL_OVERRIDES',
      });
    }
    const correlationArgs = fullState.pendingApproval?.args || {};
    let validatedArgs: Record<string, unknown>;
    try {
      validatedArgs = {
        ...validatePendingApprovalArguments(toolName, mergedArgs),
        ...(typeof correlationArgs.workflowRunId === 'string' ? { workflowRunId: correlationArgs.workflowRunId } : {}),
        ...(typeof correlationArgs.leadInputSetId === 'string' ? { leadInputSetId: correlationArgs.leadInputSetId } : {}),
        ...(Number.isInteger(Number(correlationArgs.leadInputSetRevision))
          ? { leadInputSetRevision: Number(correlationArgs.leadInputSetRevision) }
          : {}),
      };
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Approval overrides are invalid',
        code: 'INVALID_APPROVAL_OVERRIDES',
      });
    }
    if (fullState.pendingApproval) {
      fullState.pendingApproval = {
        ...fullState.pendingApproval,
        args: validatedArgs,
      };
    }

    if (approved) {
      const { getEffectiveModuleAccess } = await import('../models/platformAccess/functions.js');
      const requiredModule = requiredModuleForApprovalTool(toolName);
      const moduleAccess = (await getEffectiveModuleAccess(userId))
        .find(module => module.key === requiredModule);
      if (!moduleAccess?.enabled) {
        return res.status(moduleAccess?.status === 'maintenance' ? 503 : 403).json({
          success: false,
          error: moduleAccess?.message || 'This tool is not available for this account.',
          code: moduleAccess?.status === 'maintenance' ? 'MODULE_MAINTENANCE' : 'MODULE_UNAVAILABLE',
          module: requiredModule,
        });
      }
      const { checkUserCredits } = await import('../middleware/creditCheck.js');
      const creditCheck = await checkUserCredits(userId);
      if (!creditCheck.allowed) {
        return res.status(402).json({
          success: false,
          error: creditCheck.error || 'Insufficient credits',
          code: 'INSUFFICIENT_CREDITS',
        });
      }
    }

    const claim = await ConversationToolApprovalModel.claim({
      userId,
      threadId,
      requestId,
      toolName,
      toolArgs: validatedArgs,
      overrides,
      approved,
      runId: typeof validatedArgs.workflowRunId === 'string' ? validatedArgs.workflowRunId : fullState.runContext.runId,
      resourceType: typeof validatedArgs.leadInputSetId === 'string' ? 'lead_input_set' : undefined,
      resourceId: typeof validatedArgs.leadInputSetId === 'string' ? validatedArgs.leadInputSetId : undefined,
      resourceRevision: Number.isInteger(Number(validatedArgs.leadInputSetRevision)) ? Number(validatedArgs.leadInputSetRevision) : undefined,
    });
    if (!claim.claimed) {
      return approvalReplayResponse(res, claim.approval);
    }

    await clearPendingApprovalIfMatches(threadId, userId, requestId, toolName);

    let result: AgentState;
    try {
      if (approved) await approveBoundLeadInputSet(fullState, userId, threadId);
      result = await handleApproval(userId, threadId, approved, fullState);
      if (approved) await finalizeLeadWorkflowStage(fullState, result, userId, threadId);
    } catch (error: unknown) {
      if (approved) {
        await ConversationToolApprovalModel.complete(
          claim.approval.id,
          claim.approval.leaseToken || '',
          false,
          undefined,
          error instanceof Error ? error.message : 'Approved tool execution failed',
        );
      }
      // The approval request has already been claimed and removed from the
      // thread metadata. Persist a terminal run outcome as well; otherwise a
      // guarded pre-execution failure (for example, a superseded input-set
      // revision) leaves the campaign looking permanently active after reload
      // and the composer remains disabled even though no tool is running.
      fullState.requiresApproval = false;
      fullState.pendingApproval = null;
      fullState.actionButtons = [];
      await persistWorkflowRunState(threadId, fullState, 'failed').catch((persistError) => {
        logger.error({ err: persistError, threadId, requestId }, '[chatController] Failed to finalize rejected approval run');
      });
      throw error;
    }
    if (!approved) result.workflowOutcome = 'cancelled';
    await persistWorkflowRunState(threadId, result);
    const response = stateToResponse(result);
    const matchingToolResult = approved
      ? [...(result.toolResults || [])].reverse().find((toolResult) => toolResult.toolName === toolName)
      : undefined;
    const executionSucceeded = !approved || matchingToolResult?.success === true;
    const executionError = approved && !executionSucceeded
      ? matchingToolResult?.error || `Approved tool "${toolName}" did not complete successfully`
      : undefined;

    if (approved) {
      const completedApproval = await ConversationToolApprovalModel.complete(
        claim.approval.id,
        claim.approval.leaseToken || '',
        executionSucceeded,
        matchingToolResult,
        executionError,
      );
      if (!completedApproval) {
        throw new Error('Approval execution lease is no longer current; the result requires reconciliation.');
      }
    }
    
    await MessageService.saveMessage({
      userId, threadId, role: 'assistant', content: response.content,
      agentType: response.agentType, metadata: response.metadata,
    });
    
    webSocketEmitter.emitChatResponse(userId, threadId, response);
    webSocketEmitter.emitAgentStatus(userId, result.currentAgent || 'supervisor', 'completed', undefined, undefined, threadId);
    
    try {
      const existingMetadata = await getChatThreadMetadata(threadId) || {};
      const metadataPendingApproval = isPlainRecord(existingMetadata.pendingApproval)
        ? existingMetadata.pendingApproval as unknown as AgentState['pendingApproval']
        : undefined;
      if (pendingApprovalMatchesRequest(
        metadataPendingApproval,
        requestId,
        toolName,
      )) {
        delete existingMetadata.pendingApproval;
      }
      if (approved && result.leadWorkflowExecuted) {
        existingMetadata.leadWorkflowExecuted = true;
        existingMetadata.leadReviewApproved = false;
      }
      await updateChatThreadMetadata(threadId, existingMetadata);
    // eslint-disable-next-line no-empty
    } catch (_) {}
    
    if (approved && !executionSucceeded) {
      return res.status(422).json({
        success: false,
        response,
        approved,
        status: 'failed',
        error: executionError,
      });
    }
    return res.json({
      success: true,
      response,
      approved,
      status: approved ? 'succeeded' : 'rejected',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[chatController] Error handling approval');
    res.status(500).json({ error: error.message || 'Failed to handle approval' });
  }
}

/**
 * POST /api/chat/langgraph/switch-agent
 */
export async function langGraphSwitchAgentHandler(req: Request, res: Response) {
  let releaseMutex: (() => void) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { threadId, targetAgent } = req.body;
    
    if (!threadId || !targetAgent) {
      return res.status(400).json({ error: 'threadId and targetAgent are required' });
    }
    
    const validAgents = ['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'];
    if (!validAgents.includes(targetAgent)) {
      return res.status(400).json({ error: `Invalid agent.` });
    }
    
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(403).json({ error: 'Thread not found or access denied' });
    }
    ({ release: releaseMutex } = await ThreadService.acquireThreadMutex(userId, threadId));
    if (targetAgent === 'outreach') {
      const metadata = await getChatThreadMetadata(threadId) || {};
      const leadGate = getCompletedLeadOutreachGate(metadata);
      if (leadGate) {
        return res.status(409).json({
          success: false,
          status: leadGate.status,
          error: leadGate.error,
        });
      }
    }
    
    const existingState = await ThreadService.loadThreadState(userId, threadId);
    if ((existingState.requiresApproval || existingState.pendingApproval) && existingState.currentAgent !== targetAgent) {
      return res.status(409).json({ success: false, currentAgent: existingState.currentAgent,
        error: 'Finish or cancel the pending action review before switching agents. Saved draft cards can remain open.' });
    }
    if (targetAgent !== 'icp_generation' && !isCurrentIcpRevisionApproved(existingState.icpProfile)) {
      return res.status(409).json({
        error: 'Approve the current ICP revision before switching to a specialist agent.',
        action: 'APPROVE_ICP',
        icpId: existingState.icpProfile?.id,
        revision: existingState.icpProfile?.revision,
      });
    }
    
    const fullState = createInitialState(userId, threadId);
    Object.assign(fullState, existingState);
    
    // The orchestrator owns transition messages and their response IDs. Saving
    // a second uncorrelated "Hiring" message here duplicated live handoffs.
    const result = await switchAgent(userId, threadId, targetAgent, fullState);
    const response = stateToResponse(result);
    await persistWorkflowRunState(threadId, result);
    const latestMetadata = await getChatThreadMetadata(threadId) || {};
    await updateChatThreadMetadata(threadId, { ...latestMetadata,
      agentPipeline: result.agentPipeline || [], agentPipelineIndex: result.agentPipelineIndex || 0,
      pipelineRequest: result.pipelineRequest || existingState.pipelineRequest,
      deferredLeadReviewPipeline: result.deferredLeadReviewPipeline || [],
    });
    
    await MessageService.saveMessage({
      userId, threadId, role: 'assistant', content: response.content,
      agentType: response.agentType, metadata: response.metadata,
    });
    
    const switched = result.currentAgent === targetAgent && !result.error;
    webSocketEmitter.emitAgentStatus(userId, result.currentAgent || 'orchestrator', 'completed', undefined, undefined, threadId);
    if (switched) await updateChatThread(threadId, thread.title || '', targetAgent.replace(/_/g, ' '));
    res.status(switched ? 200 : 409).json({ success: switched, response, currentAgent: result.currentAgent,
      ...(!switched ? { error: result.error || response.content || 'The agent switch could not complete.' } : {}) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[chatController] Error switching agent');
    res.status(500).json({ error: error.message || 'Failed to switch agent' });
  } finally {
    releaseMutex?.();
  }
}

/**
 * GET /api/chat/langgraph/state/:threadId
 */
export async function langGraphGetStateHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.threadId);
    
    if (isNaN(threadId)) {
      return res.status(400).json({ error: 'Invalid threadId' });
    }
    
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(403).json({ error: 'Thread not found or access denied' });
    }
    
    let state = await getConversationState(threadId, userId);
    if (!state) {
      state = createInitialState(userId, threadId);
      const existingState = await ThreadService.loadThreadState(userId, threadId);
      Object.assign(state, existingState);
    }
    
    res.json({
      threadId, currentAgent: state.currentAgent, icpProfile: state.icpProfile,
      brandToolkit: state.brandToolkit, requiresApproval: state.requiresApproval,
      pendingApproval: state.pendingApproval, actionButtons: state.actionButtons,
      leadWorkflowExecuted: state.leadWorkflowExecuted,
      leadReviewApproved: state.leadReviewApproved,
      messageCount: state.messages?.length || 0,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[chatController] Error getting state');
    res.status(500).json({ error: error.message || 'Failed to get state' });
  }
}

/**
 * POST /api/chat/langgraph/action
 */
export async function langGraphActionHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { threadId, action, value, data, sourceMessageId, buttonId } = req.body;
    let approvalReference = isPlainRecord(data) ? data : undefined;
    
    if (!threadId || !action) {
      return res.status(400).json({ error: 'threadId and action are required' });
    }
    
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(403).json({ error: 'Thread not found or access denied' });
    }

    if ((sourceMessageId && !buttonId) || (!sourceMessageId && buttonId)) {
      return res.status(400).json({ error: 'sourceMessageId and buttonId must be provided together' });
    }

    if (sourceMessageId && buttonId) {
      const outcome = action === 'reject_tool'
        ? 'rejected'
        : action === 'approve_tool' || action === 'LEAD_AGENT_APPROVE' || action === 'APPROVE_ICP'
          ? 'approved'
          : 'selected';
      const claim = await claimChatMessageAction({
        messageId: Number(sourceMessageId),
        userId,
        threadId: Number(threadId),
        buttonId,
        action,
        outcome,
      });
      if (claim.state === 'not_found') {
        return res.status(404).json({ error: 'The source message is unavailable' });
      }
      if (claim.state === 'invalid_button') {
        return res.status(400).json({ error: 'The selected action is not available on this message' });
      }
      if (claim.state === 'conflict') {
        return res.status(409).json({ error: 'A different choice was already recorded for this message' });
      }
      if (claim.state === 'selected') {
        return res.json({ success: true, idempotent: true, actionResolution: claim.resolution });
      }
      if (claim.state === 'processing') {
        return res.status(202).json({ success: true, processing: true, actionResolution: claim.resolution });
      }
      // For a rendered message, trust only that message's saved review identity.
      approvalReference = claim.state === 'claimed' && claim.approvalReference
        ? { ...claim.approvalReference }
        : undefined;

      let actionFailureMessage: string | undefined;
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 400 && body && typeof body === 'object' && 'error' in body) {
          actionFailureMessage = toUserFacingError((body as { error?: unknown }).error);
        }
        return originalJson(body as never);
      }) as typeof res.json;

      res.once('finish', () => {
        res.json = originalJson as typeof res.json;
        const succeeded = res.statusCode < 400;
        void finalizeChatMessageAction({
          messageId: Number(sourceMessageId),
          userId,
          threadId: Number(threadId),
          buttonId,
          action,
          succeeded,
          failure: succeeded ? undefined : actionFailureMessage || 'The action failed before it was accepted. You can retry safely.',
        }).catch((error) => {
          logger.error({ err: error, sourceMessageId, buttonId }, '[Action] Failed to persist action resolution');
        });
      });
    }

    const actionExecutionId = sourceMessageId && buttonId
      ? `lead-action-${threadId}-${sourceMessageId}-${buttonId}`
      : undefined;
    const sendMessage = (content: string, routeToAgent?: 'lead_generation') => {
      req.body.content = content;
      if (routeToAgent) req.body.routeToAgent = routeToAgent;
      if (actionExecutionId && !req.body.idempotencyKey) {
        req.body.idempotencyKey = actionExecutionId;
      }
      return langGraphMessageHandler(req, res);
    };

    const emitUI = (eventType: string, payload: Record<string, unknown>) => {
      webSocketEmitter.emit(userId, eventType, { thread_id: Number(threadId), ...payload });
      return res.json({ success: true, action: eventType, ...payload });
    };

    const requireReviewedLeadApproval = async () => {
      const metadata = await getChatThreadMetadata(threadId) || {};
      const leadGate = getCompletedLeadOutreachGate(metadata);
      if (leadGate) {
        res.status(409).json({
          success: false,
          status: leadGate.status,
          error: leadGate.error,
        });
        return false;
      }
      return true;
    };
    
    switch (action) {
      case 'switch_agent':
        req.body.targetAgent = value;
        return langGraphSwitchAgentHandler(req, res);
        
      case 'approve_tool':
      case 'reject_tool': {
        // Keep the identity from the clicked review. Looking up the latest
        // pending request here lets an old button approve an unrelated action.
        if (typeof approvalReference?.requestId !== 'string' || typeof approvalReference?.toolName !== 'string') {
          return res.status(409).json({
            error: 'This approval has no review identity. Ask the agent to prepare a fresh review.',
          });
        }
        req.body.requestId = approvalReference.requestId;
        req.body.toolName = approvalReference.toolName;
        req.body.approved = action === 'approve_tool';
        return langGraphApproveHandler(req, res);
      }

      case 'HIRE_ICP_AGENT':
        return sendMessage('Build an Ideal Customer Profile');

      case 'IMPROVE_ICP':
        return sendMessage('I want to improve my ICP');

      case 'HIRE_LEAD_GEN':
        return sendMessage('Hire Marcus for lead generation');

      case 'HIRE_CONTENT_STUDIO':
        return sendMessage('Hire Alex for content creation');

      case 'HIRE_OUTREACH':
        if (!(await requireReviewedLeadApproval())) return;
        return sendMessage('Hire Emily for outreach campaigns');

      case 'HIRE_PERFORMANCE':
        return sendMessage('Hire Sarah for performance marketing');

      case 'HIRE_AGENT': {
        const agentType = data?.agentType || value;
        if (!agentType) return res.status(400).json({ error: 'No agent type specified' });
        if (agentType === 'outreach' && !(await requireReviewedLeadApproval())) return;
        const agentNames: Record<string, string> = {
          lead_generation: 'Marcus for lead generation',
          content_studio: 'Alex for content creation',
          outreach: 'Emily for outreach campaigns',
          performance_marketing: 'Sarah for performance marketing',
          icp_generation: 'the ICP specialist',
        };
        return sendMessage(`Hire ${agentNames[agentType] || agentType.replace(/_/g, ' ')}`);
      }

      case 'HIRE_ALL':
      case 'HIRE_TEAM': {
        const agentTypes = data?.agentTypes || [];
        const agentNamesList = data?.agentNames as string[] || [];
        const includesOutreach = action === 'HIRE_ALL'
          || agentTypes.includes('outreach')
          || agentNamesList.some((name) => /outreach|emily/i.test(name));
        if (includesOutreach && !(await requireReviewedLeadApproval())) return;
        if (agentTypes.length > 0) {
          const names = agentTypes.map((a: string) => a.replace(/_/g, ' ')).join(', ');
          return sendMessage(`Hire team: ${names}. Start the campaign pipeline.`);
        }
        if (agentNamesList.length > 0) {
          return sendMessage(`Start my campaign with the team: ${agentNamesList.filter(Boolean).join(', ')}. Begin working on your tasks.`);
        }
        return sendMessage('Start my campaign with all recommended agents. Begin working on your tasks.');
      }

      case 'APPROVE_ICP': {
        const loadedState = await ThreadService.loadThreadState(userId, Number(threadId));
        const icpId = Number(data?.icpId ?? loadedState.icpProfile?.id);
        const revision = Number(data?.revision ?? loadedState.icpProfile?.revision);
        if (!Number.isInteger(icpId) || !Number.isInteger(revision)) {
          return res.status(409).json({ error: 'The ICP approval is missing its resource revision. Reload the conversation and try again.' });
        }

        try {
          const approved = await approveIcpRevision({
            userId,
            threadId: Number(threadId),
            icpId,
            revision,
            runId: loadedState.runContext?.runId,
          });
          if (await resumeAfterIcpApproval({ userId, threadId: Number(threadId), runId: approved.run.id, icpId, revision })) {
            return res.json({ success: true, resumed: true, message: 'ICP approved. Continuation of the pending specialist request was accepted; separate execution approvals still apply.' });
          }
          if (approved.replayed) {
            return res.json({ success: true, replayed: true, status: approved.run.status, stage: approved.run.stage,
              message: 'This ICP revision is already approved. The existing workflow state has been preserved.' });
          }
          // Show the already selected team if present. Do not re-interpret the
          // original request with keyword exclusions after a durable approval.
          // Without a selected team, match the specialists to the approved ICP
          // so the chooser leads with the best fit. A failure keeps the plain list.
          const agentScores = loadedState.agentPipeline?.length ? null
            : await scoreAgentsForApprovedIcp(userId, Number(threadId), loadedState);
          const { actionButtons, recommendedAgents } = buildApprovedIcpAgentSelection(loadedState, agentScores);
          const recommendation = icpAgentRecommendationSentence(agentScores);
          const content = `ICP approved. ${recommendation ? `${recommendation} ` : ''}Choose the agent you want to work with next. Selecting an agent does not authorize searches, sending, publishing, or ad spend; those actions still require their own review.`;
          const savedResponse = await MessageService.saveMessage({
            userId,
            threadId: Number(threadId),
            role: 'assistant',
            content,
            agentType: 'orchestrator',
            metadata: {
              actionButtons,
              recommendedAgents,
              ...(agentScores ? { recommendedAgentScores: agentScores } : {}),
              workflowRunId: approved.run.id,
              workflowStage: approved.run.stage,
              icpId,
              icpRevision: revision,
            },
          });
          webSocketEmitter.emitChatMessage(userId, Number(threadId), {
            id: savedResponse.id,
            role: savedResponse.role,
            content: savedResponse.content,
            agentType: savedResponse.agentType || 'orchestrator',
            metadata: savedResponse.metadata,
            timestamp: new Date(savedResponse.createdAt).getTime(),
          });
          webSocketEmitter.emitOpenTab(userId, TAB_TYPES.AGENT_CHOOSE, TAB_LABELS[TAB_TYPES.AGENT_CHOOSE], {
            recommendedAgents,
            recommendedAgentScores: agentScores || loadedState.icpProfile?.recommendedAgentScores,
          }, Number(threadId));
          return res.json({ success: true, status: 'awaiting_input', stage: 'agent_selection', message: content, actionButtons, recommendedAgents });
        } catch (error) {
          logger.warn({ err: error, userId, threadId, icpId, revision }, '[Action] ICP approval rejected');
          return res.status(409).json({ error: toUserFacingError(error) });
        }
      }

      case 'START_CAMPAIGN': {
        const loadedState = await ThreadService.loadThreadState(userId, Number(threadId));
        if (!isCurrentIcpRevisionApproved(loadedState.icpProfile)) {
          return res.status(409).json({
            error: 'Approve the current ICP revision before choosing campaign agents.',
            action: 'APPROVE_ICP',
            icpId: loadedState.icpProfile?.id,
            revision: loadedState.icpProfile?.revision,
          });
        }
        return sendMessage('Start campaign and suggest agents');
      }

      case 'CONTINUE_PIPELINE': {
        const pipelineAgentType = data?.agentType as string || '';
        if (pipelineAgentType === 'outreach' && !(await requireReviewedLeadApproval())) return;
        const agentHireMessages: Record<string, string> = {
          lead_generation: 'Hire Marcus for lead generation',
          content_studio: 'Hire Alex for content creation',
          outreach: 'Hire Emily for outreach campaigns',
          performance_marketing: 'Hire Sarah for performance marketing',
        };
        return sendMessage(agentHireMessages[pipelineAgentType] || `Continue with ${data?.agentName || pipelineAgentType}`);
      }

      case 'LEAD_AGENT_RUN':
        return sendMessage('Run lead generation now with the current search parameters.', 'lead_generation');

      case 'LEAD_AGENT_RETRY': {
        const retryState = await ThreadService.loadThreadState(userId, Number(threadId));
        return sendMessage(buildLeadRetryActionMessage({
          failedToolName: data?.toolName as string | undefined,
          selectedWorkflows: retryState.selectedWorkflows || [],
          originalRequest: resolveOriginalLeadInputRequest(undefined, retryState.messages || []),
        }), 'lead_generation');
      }

      case 'LEAD_AGENT_START': {
        if (data?.selectedWorkflows && Array.isArray(data.selectedWorkflows)) {
          const workflowIds = (data.selectedWorkflows as unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0);
          const platforms = Array.isArray(data.platforms)
            ? (data.platforms as unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0)
            : [];
          await recordConfirmedLeadStrategy({ userId, threadId: Number(threadId), workflowIds, platforms, originalRequest: data?.message as string | undefined });
          try {
            const existingMetadata = await getChatThreadMetadata(threadId) || {};
            existingMetadata.selectedWorkflows = workflowIds;
            await updateChatThreadMetadata(threadId, existingMetadata);
          // eslint-disable-next-line no-empty
          } catch (_) {}
        }
        return sendMessage(Array.isArray(data?.selectedWorkflows) && data.selectedWorkflows.length > 0
          ? 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.'
          : (data?.message as string) || 'I need new search parameters for lead generation. Please regenerate the lead inputs based on my ICP.', 'lead_generation');
      }

      case 'LEAD_AGENT_USE_WORKFLOW': {
        const workflowId = data?.workflowId as string | undefined;
        const workflowTitle = data?.workflowTitle as string | undefined;
        if (workflowId) {
          const platform = typeof data?.platform === 'string'
            ? data.platform
            : workflowId.split('_')[0];
          await recordConfirmedLeadStrategy({
            userId,
            threadId: Number(threadId),
            workflowIds: [workflowId],
            platforms: [platform],
            originalRequest: data?.message as string | undefined,
          });
          try {
            const existingMetadata = await getChatThreadMetadata(threadId) || {};
            existingMetadata.selectedWorkflows = [workflowId];
            await updateChatThreadMetadata(threadId, existingMetadata);
          // eslint-disable-next-line no-empty
          } catch (_) {}
        }
        const workflowMsg = data?.message as string || (workflowId
          ? `Use workflow ${workflowId}${workflowTitle ? ` (${workflowTitle})` : ''} for lead generation and generate the lead inputs now.`
          : 'Use the recommended workflow for lead generation and generate the lead inputs now.');
        return sendMessage(buildLeadStrategySelectionMessage(workflowId, workflowMsg), 'lead_generation');
      }

      case 'LEAD_AGENT_APPROVE': {
        // Schema-version adapter for historical messages. New messages use
        // approve_tool; both paths now resume the same durable approval lease.
        if (typeof approvalReference?.requestId !== 'string' || approvalReference?.toolName !== 'execute_lead_workflow') {
          return res.status(409).json({
            error: 'This legacy approval is no longer active. Regenerate the lead inputs and approve the new review card.',
          });
        }
        req.body.requestId = approvalReference.requestId;
        req.body.toolName = approvalReference.toolName;
        req.body.approved = true;
        return langGraphApproveHandler(req, res);
      }

      case 'VIEW_LEADS':
        return sendMessage('Show me the leads generated');

      case 'VIEW_SEARCH_PARAMS':
      case 'EDIT_LEAD_INPUTS':
        return emitUI('open_tab', { tabType: TAB_TYPES.LEAD_INPUTS, tabLabel: TAB_LABELS[TAB_TYPES.LEAD_INPUTS] });

      case 'SWITCH_TO_OUTREACH':
        {
          const metadata = await getChatThreadMetadata(threadId) || {};
          const leadGate = getCompletedLeadOutreachGate(metadata);
          if (leadGate) {
            return res.status(409).json({
              success: false,
              status: leadGate.status,
              error: leadGate.error,
            });
          }
        }
        return sendMessage('Hire Outreach agent to start outreach campaigns with my leads');

      case 'CREATE_OUTREACH_MESSAGE': {
        const metadata = await getChatThreadMetadata(threadId) || {};
        const leadGate = getCompletedLeadOutreachGate(metadata);
        if (leadGate) {
          return res.status(409).json({
            success: false,
            status: leadGate.status,
            error: leadGate.error,
          });
        }
        const leadIds = Array.isArray(data?.leadIds)
          ? [...new Set((data.leadIds as unknown[]).map(Number).filter((id) => Number.isInteger(id) && id > 0))]
          : [];
        const leadNames = Array.isArray(data?.leadNames) ? (data.leadNames as string[]).filter(Boolean) : [];
        const channel = INBOX_CHANNELS.includes(data?.channel as InboxChannel) ? data?.channel as InboxChannel : null;
        if (leadIds.length > 0) {
          const existingMetadata = metadata;
          await updateChatThreadMetadata(threadId, {
            ...existingMetadata,
            selectedLeadIds: leadIds,
            selectedLeadSelection: {
              leadIds,
              leadNames,
              selectedAt: new Date().toISOString(),
              ...(channel ? { channel } : {}),
            },
          });
          return sendMessage(`Prepare ${channel ? `${channel} ` : ''}outreach for my ${leadIds.length} selected leads. Use exactly these lead IDs: ${leadIds.join(', ')}. Open the shared outreach composer so I can review the account, approved content, schedule and per-outreach follow-up times before confirming. Do not send yet.`);
        }
        return emitUI('open_modal', { modalType: 'leadSelection' });
      }

      case 'GENERATE_EMAIL_CAMPAIGN':
        return sendMessage('Generate a personalized email campaign for my outreach campaign');

      case 'SELECT_LEADS_FOR_OUTREACH':
      case 'OPEN_LEADS_TAB':
      case 'OPEN_LEAD_SELECTOR':
        return emitUI('open_modal', { modalType: 'leadSelection' });

      case 'OPEN_CSV_UPLOAD':
        return emitUI('open_tab', { tabType: TAB_TYPES.LEADS, tabLabel: TAB_LABELS[TAB_TYPES.LEADS], intent: 'upload' });

      case 'OPEN_ADD_LEAD':
        return emitUI('open_tab', { tabType: TAB_TYPES.LEADS, tabLabel: TAB_LABELS[TAB_TYPES.LEADS], intent: 'create' });

      case 'GENERATE_CONTENT':
        return sendMessage((data?.prompt as string) || 'Generate content');

      case 'REGENERATE_TEMPLATE':
        return sendMessage((data?.prompt as string) || 'Regenerate the template');

      case 'GENERATE_SOCIAL_POST':
        return sendMessage((data?.prompt as string) || 'Create a social media post');

      case 'GENERATE_EMAIL_TEMPLATE':
        return sendMessage((data?.prompt as string) || 'Create an email template');

      case 'GENERATE_SMS_TEMPLATE':
        return sendMessage((data?.prompt as string) || 'Create an SMS template');

      case 'GENERATE_AD_COPY':
        return sendMessage((data?.prompt as string) || 'Create an ad copy');

      case 'GENERATE_IMAGE':
        return sendMessage((data?.prompt as string) || 'Generate a marketing image');

      case 'GENERATE_SOCIAL_MESSAGE':
        return sendMessage((data?.prompt as string) || 'Create a social media DM template');

      case 'GENERATE_BLOG_POST':
        return sendMessage((data?.prompt as string) || 'Create a blog post');

      case 'GENERATE_VIDEO':
        return sendMessage((data?.prompt as string) || 'Generate a marketing video');

      case 'CONTENT_AD':
        return sendMessage('Create more ad creative variations');

      case 'analytics_query': {
        const queryType = data?.queryType as string || value || 'overview';
        const queryMap: Record<string, string> = {
          campaign: 'Show me campaign analytics and performance data',
          lead: 'Show me lead generation metrics and statistics',
          outreach: 'Show me outreach email and message statistics',
          overview: 'Give me a full overview of all marketing performance',
        };
        return sendMessage(queryMap[queryType] || `Show me ${queryType} analytics`);
      }

      case 'ANALYTICS_CAMPAIGN':
        return sendMessage('Show me campaign analytics and performance data');

      case 'ANALYTICS_LEAD':
        return sendMessage('Show me lead generation metrics and statistics');

      case 'ANALYTICS_OUTREACH':
        return sendMessage('Show me outreach email and message statistics');

      case 'ANALYTICS_OVERVIEW':
        return sendMessage('Give me a full overview of all marketing performance');

      case 'generate_more': {
        const platform = data?.platform as string || '';
        return sendMessage(`Create more ad variations${platform ? ` for ${platform}` : ''}`);
      }

      case 'publish_ad':
      case 'PUBLISH_ADS': {
        const pubPlatform = data?.platform as string || '';
        return sendMessage(`I'm ready to publish the ad campaign${pubPlatform ? ` to ${pubPlatform}` : ''}`);
      }

      case 'select_toolkit':
        return sendMessage(`Select brand toolkit ${value}`);

      case 'skip_toolkit':
        return sendMessage('Skip brand toolkit selection and use generic styling');

      case 'create_toolkit':
        return emitUI('open_tab', { tabType: TAB_TYPES.BRAND_TOOLKIT, tabLabel: TAB_LABELS[TAB_TYPES.BRAND_TOOLKIT], data: { mode: 'create' } });

      case 'SELECT_BRAND_TOOLKIT':
        if (data?.action === 'select' && data?.toolkit_id) {
          return sendMessage(`Select brand toolkit with ID ${data.toolkit_id}`);
        }
        return emitUI('open_tab', { tabType: TAB_TYPES.BRAND_TOOLKIT, tabLabel: TAB_LABELS[TAB_TYPES.BRAND_TOOLKIT] });

      case 'CREATE_BRAND_TOOLKIT':
        return emitUI('open_tab', { tabType: TAB_TYPES.BRAND_TOOLKIT, tabLabel: TAB_LABELS[TAB_TYPES.BRAND_TOOLKIT], data: { mode: 'create' } });

      case 'SKIP_BRAND_TOOLKIT':
        return sendMessage('Skip brand toolkit for now. Continue without brand guidelines.');

      case 'SELECT_BUSINESS':
      case 'SELECT_EXISTING_BUSINESS':
        return res.json({ success: true, action: 'noop' });

      case 'BUSINESS_SELECTED':
        return sendMessage(data?.businessName
          ? `I've selected my business "${data.businessName}". Let's proceed with creating my ICP.`
          : "I've selected my business profile. Let's proceed with creating my ICP.");

      case 'SELECT_ICP':
        return emitUI('open_tab', { tabType: 'icp', tabLabel: 'ICP Profile' });

      case 'CREATE_ICP':
        return sendMessage('Create a new ICP profile for lead generation.');

      case 'OPEN_TAB': {
        const tabType = data?.tabType as string;
        const tabTypeMap: Record<string, string> = {
          leadInputs: 'leadInputs', leadinputs: 'leadInputs', 'lead-inputs': 'leadInputs',
          icp: 'icp', agents: 'agentchoose', agentchoose: 'agentchoose',
          brandtoolkit: TAB_TYPES.BRAND_TOOLKIT,
        };
        const mappedTab = tabTypeMap[tabType || ''] || tabType;
        return emitUI('open_tab', { tabType: mappedTab, tabLabel: tabType });
      }

      case 'OPEN_OUTREACH_TAB':
        return emitUI('open_tab', { tabType: 'outreach', tabLabel: 'Outreach' });

      case 'export_ad': {
        const exportPlatform = (data?.platform as string || '').toLowerCase();
        const exportRoutes: Record<string, string> = {
          google: 'https://ads.google.com', google_ads: 'https://ads.google.com',
          linkedin: 'https://linkedin.com/ad/accounts', linkedin_ads: 'https://linkedin.com/ad/accounts',
        };
        const uploadUrl = exportRoutes[exportPlatform];
        if (uploadUrl) {
          webSocketEmitter.emit(userId, 'toast', { title: 'Export Ad Creatives', description: `Your ad creatives are saved in Content Studio. Download them and upload at ${uploadUrl}` });
        }
        return emitUI('navigate', { path: '/dashboard/saved-templates/ads' });
      }

      default:
        if (value) return sendMessage(`${action}: ${value}`);
        if (data?.message) return sendMessage(data.message as string);
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[chatController] Error handling action');
    res.status(500).json({ error: error.message || 'Failed to handle action' });
  }
}
