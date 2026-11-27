/**
 * Mastra Orchestrator
 * Replaces server/langgraph/graph.ts
 *
 * Instead of a LangGraph StateGraph compiled into a streaming graph,
 * this module uses a simple async while-loop that calls agent runner
 * functions directly. All external contracts (processMessage,
 * handleApproval, switchAgent, getConversationState) have the same
 * signatures so the chatController can swap imports transparently.
 */

import type { AgentState, AgentType, Message, ActionButton } from './state.js';
import { ConversationRequestError } from '../services/ConversationRequestCoordinator.js';
import { createInitialState, normalizeMessage } from './state.js';
import { startPersistentApprovalReaper } from './approvalExpiry.js';

// Agent runners
import { runIcpAgent } from './agents/icpAgent.js';
import { isReviewedLeadApprovalTurn, runLeadAgent } from './agents/leadAgent.js';
import { runContentAgent } from './agents/contentAgent.js';
import { runOutreachAgent } from './agents/outreachAgent.js';
import { runPerformanceAgent } from './agents/performanceAgent.js';
import { routerOutputSchema } from './routerSchema.js';
import { runUnifiedRouter } from './unifiedRouter.js';

// Shared infrastructure (existing — no changes)
import { AGENT_INFO } from './state.js';
import { getDisplayName } from './agentPersonas.js';
import { webSocketEmitter } from '../services/agents/WebSocketEmitter.js';
import { createChatMessage } from '../models/chatMessages/functions.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';
import { normalizeReviewedLeadIds } from './leadReview.js';
import { isCurrentIcpRevisionApproved } from '../models/conversationWorkflow/stateMachine.js';
import { toUserFacingError, userFacingReason } from '../../shared/userFacingError.js';

// ── Constants ──────────────────────────────────────────────────────────

const MAX_AGENT_ITERATIONS = 10;
const AGENT_STALL_TIMEOUT_MS = 120_000; // 2 minutes — force-advance pipeline if agent hangs

// Unit tests import the orchestrator for pure routing helpers. Do not start a
// database-backed daemon or its eager sweep in that environment.
const runningUnderTest = process.env.NODE_ENV === 'test'
  || Boolean(process.env.JEST_WORKER_ID)
  || process.argv.some((argument) => argument.includes('/jest'));
const stopApprovalReaper = runningUnderTest || process.env.DISABLE_BACKGROUND_JOBS === 'true'
  ? () => undefined
  : startPersistentApprovalReaper(60 * 1000);

export function stopOrchestratorBackgroundJobs(): void {
  stopApprovalReaper();
}

const SPECIALIST_AGENTS: AgentType[] = [
  'icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing',
];

const AGENT_RUNNERS: Record<string, (state: AgentState) => Promise<Partial<AgentState>>> = {
  icp_generation: runIcpAgent,
  lead_generation: runLeadAgent,
  content_studio: runContentAgent,
  outreach: runOutreachAgent,
  performance_marketing: runPerformanceAgent,
};

/** A side question can add an answer/receipts, but cannot take over an open review. */
export async function runAndMergeSpecialistTurn(
  state: AgentState,
  runner: (state: AgentState) => Promise<Partial<AgentState>>,
  readOnlyTeamAgent?: AgentType,
): Promise<Partial<AgentState>> {
  const isolatedQuestion = (state.intentAnalysis?.action === 'question'
    && Boolean(state.requiresApproval || state.pendingApproval || (state.intentAnalysis.hiredAgents?.length ?? 0) > 1))
    || state.intentAnalysis?.semanticRequest?.dashboardOperation==='campaign_prepare';
  // Specialist pre-processing hooks may mutate their input, so filtering the
  // returned update alone is insufficient to protect the pending workflow.
  const workingState = isolatedQuestion ? structuredClone(state) : state;
  if(state.intentAnalysis?.semanticRequest?.dashboardOperation==='campaign_prepare')workingState.widgetContinuation=undefined;
  if (readOnlyTeamAgent && isolatedQuestion) {
    for (let index = workingState.messages.length - 1; index >= 0; index--) {
      if (workingState.messages[index].role !== 'user') continue;
      workingState.messages[index].content += `\n\n[Coordinator assignment: You are ${getDisplayName(readOnlyTeamAgent)}. Answer only the part of this read-only question assigned to your specialty. The other specialists will answer their own parts. Do not repeat their answers. Your name is already displayed in the message header; start directly with your answer without a name prefix.]`;
      break;
    }
  }
  const update = await runner(workingState);
  state.messages.push(...(update.messages || []));
  if (isolatedQuestion) {
    if (update.toolResults !== undefined) state.toolResults = update.toolResults;
    if (update.lastResponseId !== undefined) state.lastResponseId = update.lastResponseId;
  } else {
    const { messages: _drop, ...rest } = update;
    Object.assign(state, rest);
  }
  return update;
}

// ── Unified Analysis Cache & Types ─────────────────────────────────────

interface UnifiedAnalysis {
  suggestAgents: boolean;
  response: string;
  excludedAgents: AgentType[];
  needsClarification: boolean;
  leadSettingsRequested?: boolean;
  leadShortlistRequested?: boolean;
  cancellationScope?: import('./routerSchema.js').RouterOutput['cancellationScope'];
  cancellationReviewId?: string | null;
  contentManagementRequested?: boolean;
  action?: import('./routerSchema.js').RouterOutput['action'];
  intent: 'conversational' | 'task' | 'meta' | 'navigation';
  nextAgent: AgentType | null;
  hiredAgents: AgentType[];
  mode: 'hire_agent' | 'hire_team' | 'none';
  isAffirmative: boolean;
  isDomainMatch: boolean;
  navigationTarget?: {
    tabType: string;
    tabLabel: string;
  } | null;
}

export async function getUnifiedMessageAnalysis(
  content: string,
  currentAgent: AgentType | undefined,
  userId: number,
  state?: AgentState,
): Promise<UnifiedAnalysis> {
  const targetState = state || {
    userId,
    threadId: 0,
    messages: [{ role: 'user', content }],
    currentAgent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const analysis = targetState.intentAnalysis || await runUnifiedRouter(targetState);
  return {
    suggestAgents: analysis.suggestAgents,
    response: analysis.response,
    excludedAgents: analysis.excludedAgents,
    needsClarification: analysis.needsClarification,
    leadSettingsRequested: analysis.leadSettingsRequested,
    leadShortlistRequested: analysis.leadShortlistRequested,
    cancellationScope: analysis.cancellationScope,
    cancellationReviewId: analysis.cancellationReviewId,
    contentManagementRequested: analysis.contentManagementRequested,
    action: analysis.action,
    intent: analysis.intent,
    nextAgent: analysis.nextAgent,
    hiredAgents: analysis.hiredAgents,
    mode: analysis.mode,
    isAffirmative: analysis.isAffirmative,
    isDomainMatch: analysis.isDomainMatch,
    navigationTarget: analysis.navigationTarget,
  };
}

export async function detectHiredAgentsWithLLM(
  content: string,
  userId: number,
  currentAgent?: AgentType,
): Promise<{ hiredAgents: AgentType[]; mode: 'hire_agent' | 'hire_team' | 'none' }> {
  const analysis = await getUnifiedMessageAnalysis(content, currentAgent, userId);
  return {
    hiredAgents: analysis.hiredAgents,
    mode: analysis.mode,
  };
}

export function getPendingPipelineAgent(state: AgentState): AgentType | null {
  const pendingIndex = state.agentPipelineIndex ?? -1;
  const latestMessage = state.messages?.[state.messages.length - 1];
  if (latestMessage?.role === 'user'
    || pendingIndex < 0
    || !state.agentPipeline?.length
    || pendingIndex >= state.agentPipeline.length) {
    return null;
  }
  const pendingAgent = state.agentPipeline[pendingIndex];
  return pendingAgent && SPECIALIST_AGENTS.includes(pendingAgent) ? pendingAgent : null;
}

export function shouldAdvancePipelineIndex(
  state: Pick<AgentState, 'agentPipeline' | 'agentPipelineIndex'>,
  completedAgent: AgentType,
): boolean {
  const currentIndex = state.agentPipelineIndex ?? 0;
  return state.agentPipeline?.[currentIndex] === completedAgent;
}

/** Read-only team questions run within one turn without replacing an existing
 * approval or durable execution pipeline. */
export function getNextReadOnlyTeamAgent(state: AgentState, completedAgent: AgentType): AgentType | null {
  if (state.intentAnalysis?.action !== 'question') return null;
  const agents = [...new Set(state.intentAnalysis.hiredAgents ?? [])];
  if (agents.length < 2) return null;
  const index = agents.findIndex(agent => agent === completedAgent);
  return index >= 0 ? agents[index + 1] ?? null : null;
}

export function getPendingPipelineAgentAfterCompletion(
  state: Pick<AgentState, 'agentPipeline' | 'agentPipelineIndex'>,
  completedAgent: AgentType,
): AgentType | null {
  const currentIndex = state.agentPipelineIndex ?? 0;
  const pendingAgent = state.agentPipeline?.[currentIndex];
  if (!pendingAgent || pendingAgent === completedAgent || !SPECIALIST_AGENTS.includes(pendingAgent)) {
    return null;
  }
  return pendingAgent;
}

export function sanitizeLeadReviewPipeline(state: AgentState, agents: AgentType[]): AgentType[] {
  const selectedLeadIds = normalizeReviewedLeadIds(state.selectedLeadIds);
  const hasValidReviewedApproval = state.leadReviewApproved === true && selectedLeadIds.length > 0;
  if (!hasValidReviewedApproval) state.leadReviewApproved = false;
  const requiresReviewedLeadApproval = !hasValidReviewedApproval
    && (state.leadWorkflowExecuted === true || agents.includes('lead_generation'));
  if (requiresReviewedLeadApproval && agents.includes('outreach')) {
    state.deferredLeadReviewPipeline = [...agents];
    return agents.filter(agent => agent !== 'outreach');
  }

  if (hasValidReviewedApproval && state.deferredLeadReviewPipeline?.length) {
    const restoredPipeline = [...state.deferredLeadReviewPipeline];
    state.deferredLeadReviewPipeline = [];
    return restoredPipeline;
  }

  return agents;
}

export function filterExplicitlyExcludedAgents(excludedAgents: AgentType[], agents: AgentType[]): AgentType[] {
  const excluded = new Set(excludedAgents);
  return agents.filter(agent => !excluded.has(agent));
}

export function blockPrematureOutreach(state: AgentState, nextAgent: AgentType): Message | null {
  // Read-only inspection uses BaseAgent's restricted tool set and remains
  // available before selecting/approving recipients for an actual send review.
  if (state.intentAnalysis?.action === 'question' || state.intentAnalysis?.semanticRequest?.dashboardOperation==='campaign_prepare') return null;
  const requiresReviewedLeadApproval = state.leadWorkflowExecuted === true
    || state.agentPipeline?.includes('lead_generation') === true;
  const selectedLeadIds = normalizeReviewedLeadIds(state.selectedLeadIds);
  const hasValidReviewedApproval = state.leadReviewApproved === true && selectedLeadIds.length > 0;
  if (nextAgent !== 'outreach' || !requiresReviewedLeadApproval || hasValidReviewedApproval) {
    return null;
  }

  state.nextAgent = null;
  if (selectedLeadIds.length === 0) {
    state.leadReviewApproved = false;
    return {
      role: 'assistant',
      content: 'No persisted lead IDs are available for outreach. Generate or import leads before continuing.',
      agentType: 'orchestrator',
      metadata: { workflowOutcome: 'gated', needsAttention: true },
    };
  }
  return {
    role: 'assistant',
    content: 'Review and explicitly approve the persisted leads before outreach handoff.',
    agentType: 'orchestrator',
    metadata: { workflowOutcome: 'awaiting_lead_review', needsAttention: true },
  };
}

export function prepareLeadReviewPipeline(state: AgentState, message: string): void {
  const selectedLeadIds = normalizeReviewedLeadIds(state.selectedLeadIds);
  if (selectedLeadIds.length === 0) {
    state.leadReviewApproved = false;
  } else if (state.leadWorkflowExecuted === true && isReviewedLeadApprovalTurn(message, state.intentAnalysis)) {
    state.leadReviewApproved = true;
  }
  state.agentPipeline = sanitizeLeadReviewPipeline(state, state.agentPipeline || []);
  if ((state.agentPipelineIndex ?? 0) >= state.agentPipeline.length) {
    state.agentPipelineIndex = Math.max(0, state.agentPipeline.length - 1);
  }
}

/** Normalize legacy ICP receipts and BaseAgent loop envelopes at one boundary. */
export function successfulToolOutput(results: unknown[], toolName: string): Record<string, unknown> | null {
  for (const value of results) {
    if (!value || typeof value !== 'object') continue;
    const receipt = value as Record<string, unknown>;
    if (receipt.toolName !== toolName || receipt.success !== true) continue;
    const payload = receipt.result && typeof receipt.result === 'object' && !Array.isArray(receipt.result)
      ? receipt.result as Record<string, unknown>
      : receipt;
    if (payload.success === false || payload.requiresApproval || payload.pendingWidget) continue;
    const output = payload.output;
    if (output && typeof output === 'object' && !Array.isArray(output)) return output as Record<string, unknown>;
  }
  return null;
}

export function validToolHandoff(state: AgentState, output: Record<string, unknown> | null): AgentType | null {
  const target = output?.target_agent;
  if (typeof target !== 'string' || !SPECIALIST_AGENTS.includes(target as AgentType) || state.requiresApproval || state.pendingApproval) return null;
  const targetAgent = target as AgentType;
  if (targetAgent !== 'icp_generation' && !isCurrentIcpRevisionApproved(state.icpProfile)) return null;
  return targetAgent;
}

export async function runSupervisor(state: AgentState) {
  if (state.routingDecisionConsumed && (state.intentAnalysis?.contentManagementRequested || state.intentAnalysis?.leadShortlistRequested || ['question', 'cancel'].includes(state.intentAnalysis?.action || ''))) {
    return { response: '', nextAgent: null, suggestAgents: false, recommendedAgents: [] };
  }
  if (!state.requiresApproval && !state.pendingApproval && state.nextAgent
    && state.nextAgent !== state.currentAgent
    && validToolHandoff(state, { target_agent: state.nextAgent })) {
    const target = state.nextAgent;
    state.nextAgent = null;
    return { response: '', nextAgent: target, suggestAgents: false, recommendedAgents: [] };
  }
  const pendingAgent = getPendingPipelineAgent(state);
  if (pendingAgent) {
    return {
      response: '',
      nextAgent: pendingAgent,
      suggestAgents: false,
      recommendedAgents: [pendingAgent],
    };
  }
  // Once dispatched, the original intent is not a new instruction to rerun it.
  if (state.routingDecisionConsumed) return { response: '', nextAgent: null, suggestAgents: false, recommendedAgents: [] };
  const analysis = state.intentAnalysis || await runUnifiedRouter(state);
  return {
    response: analysis.response,
    nextAgent: analysis.nextAgent,
    suggestAgents: analysis.suggestAgents,
    recommendedAgents: analysis.recommendedAgents,
  };
}


// ── Transition emission helper ─────────────────────────────────────────

export function getIcpApprovalContinuationAgent(state: Pick<AgentState, 'icpProfile' | 'icpApprovalContinuation' | 'agentPipeline' | 'agentPipelineIndex'>): AgentType | null {
  const hint = state.icpApprovalContinuation;
  if (!hint || !isCurrentIcpRevisionApproved(state.icpProfile) || (state.icpProfile?.fitScore ?? 0) < 50
    || state.icpProfile?.id !== hint.icpId || state.icpProfile.revision !== hint.revision
    || !['lead_generation', 'content_studio', 'performance_marketing'].includes(hint.agent)
    || state.agentPipeline?.[state.agentPipelineIndex ?? 0] !== hint.agent) return null;
  return hint.agent;
}

export function getHandoffMessage(targetAgent: AgentType, hasExistingIcp = false): string | null {
  const handoffPhrases: Record<AgentType, string[]> = {
    lead_generation: [
      "Let's get Marcus, our Lead Generation Specialist, to help you find prospects. Marcus, over to you to recommend the best extraction strategies.",
      "I will loop in Marcus, our Lead Generation Specialist, to help with your request. A search requires separate review and approval."
    ],
    content_studio: [
      "I'm handing this over to Alex in the Content Studio to help draft your templates, copy, and creative assets. Alex, please take a look.",
      "Let's bring in Alex, our Content Studio Director, to help craft the creative assets and templates for this campaign."
    ],
    outreach: [
      "I'll bring in Emily, our Outreach Coordinator, to help with your request. This handoff does not send any messages.",
      "Let's get Emily, our Outreach Coordinator, to check the requested outreach next step. Sending requires separate review and approval."
    ],
    performance_marketing: [
      "I'm looping in Sarah, our Performance Marketing Manager, to set up the ad campaigns and check the analytics. Sarah, please look over the budgets.",
      "Let's hand this to Sarah to manage the ad budgets and configure the advertising settings."
    ],
    icp_generation: [
      "First, let's gather your business details and build a solid Ideal Customer Profile (ICP) so we can target your audience accurately.",
      "Let me start by analyzing your product website and target audience to outline your Ideal Customer Profile (ICP)."
    ],
    orchestrator: [],
    supervisor: []
  };

  const phrases = handoffPhrases[targetAgent];
  if (!phrases || phrases.length === 0) return null;

  return targetAgent === 'icp_generation' && hasExistingIcp
    ? 'Before the requested specialist can continue, review and approve the current saved ICP. Your request is waiting behind this approval step; approval does not authorize ad publication or outreach delivery.'
    : phrases[Math.floor(Math.random() * phrases.length)];
}

function emitHandoffMessage(userId: number, threadId: number, targetAgent: AgentType, hasExistingIcp = false) {
  const phrase = getHandoffMessage(targetAgent, hasExistingIcp);
  if (!phrase) return;
  const responseId = `handoff-${randomUUID()}`;
  const metadata = { responseId };

  webSocketEmitter.emitChatResponse(userId, threadId, {
    role: 'assistant',
    content: phrase,
    agentType: 'orchestrator',
    metadata,
  });

  createChatMessage({
    userId,
    threadId,
    role: 'assistant',
    content: phrase,
    agentType: 'orchestrator',
    metadata,
  }).catch(err => logger.error({ err, targetAgent }, '[Orchestrator] Failed to save handoff message'));
}

function emitTransition(
  userId: number,
  threadId: number,
  targetAgent: AgentType,
  currentAgent: string | undefined,
  readOnly = false,
) {
  const agentInfo = AGENT_INFO[targetAgent];
  const displayName = agentInfo?.displayName || targetAgent.replace(/_/g, ' ');

  if (targetAgent !== currentAgent && targetAgent !== 'supervisor' && targetAgent !== 'icp_generation') {
    const transitionContent = readOnly ? `Asking ${displayName}` : `Hiring ${displayName}`;
    const transitionMetadata = {
      responseId: `transition-${randomUUID()}`,
      isTransition: true,
      isTransitionMessage: true,
      readOnlyHandoff: readOnly,
      fromAgent: currentAgent || 'router',
      toAgent: targetAgent,
      toAgentName: displayName,
    };

    webSocketEmitter.emitChatResponse(userId, threadId, {
      role: 'assistant',
      content: transitionContent,
      agentType: 'orchestrator',
      metadata: transitionMetadata,
    });

    // Persist (fire-and-forget)
    createChatMessage({
      userId,
      threadId,
      role: 'assistant',
      content: transitionContent,
      agentType: 'orchestrator',
      metadata: transitionMetadata,
    }).catch(err => logger.error({ err, targetAgent: displayName }, '[Orchestrator] Failed to save transition'));
  }

  webSocketEmitter.emitAgentStatus(userId, targetAgent, 'thinking', `${displayName} is working...`, undefined, threadId);
}

// ── Router Logic ───────────────────────────────────────────────────────
// Adapted from routerNode in graph.ts — pure function, same decisions.

interface RouterResult {
  nextAgent: AgentType | null;
  stateUpdates: Partial<AgentState>;
}

export function buildIcpPrerequisiteState(
  targetAgent: AgentType,
  pipelineRequest = '',
): Partial<AgentState> {
  return {
    agentPipeline: ['icp_generation', targetAgent],
    agentPipelineIndex: 0,
    pipelineRequest,
  };
}

/** A saved, complete draft needs a review, not another billable generation call. */
export function pauseForSavedIcpApproval(state: AgentState, prerequisite: Partial<AgentState>): RouterResult | null {
  const profile = state.icpProfile;
  if (!profile || !Number.isInteger(profile.id) || (profile.id ?? 0) <= 0
    || !Number.isInteger(profile.revision) || (profile.revision ?? 0) <= 0
    || !Number.isFinite(profile.fitScore) || (profile.fitScore ?? 0) < 50
    || isCurrentIcpRevisionApproved(profile)) return null;

  const actionButtons: ActionButton[] = [
    { id: 'improve_icp', label: 'Improve ICP', action: 'IMPROVE_ICP', type: 'secondary' },
    { id: `approve_icp_${profile.id}_${profile.revision}`, label: 'Approve ICP', action: 'APPROVE_ICP',
      type: 'primary', data: { icpId: profile.id, revision: profile.revision } },
  ];
  state.messages.push({
    role: 'assistant', agentType: 'orchestrator',
    content: 'Before the requested specialist can continue, review and approve the current saved ICP. Your request is waiting behind this approval step; approval does not authorize ad publication or outreach delivery.',
    metadata: { actionButtons, workflowOutcome: 'awaiting_approval' },
  });
  return { nextAgent: null, stateUpdates: { ...prerequisite, actionButtons,
    currentAgent: 'icp_generation', tasksCompleted: false, workflowOutcome: 'awaiting_approval', routingDecisionConsumed: true } };
}

const WIDGET_CONTINUATION_PREFIX = '[WIDGET_EXECUTION_COMPLETE — INTERNAL WORKFLOW CONTINUATION]';

/**
 * Widget completions are internal resumptions of an already-routed campaign,
 * not fresh user requests. Re-running intent detection over the continuation
 * payload can mistake words inside generated copy (for example, "ad
 * performance") for a new specialist request and replace the durable
 * pipeline. Resume the exact paused pipeline step instead.
 */
export function getWidgetContinuationAgent(state: Pick<
  AgentState,
  'messages' | 'agentPipeline' | 'agentPipelineIndex' | 'widgetContinuation'
>): AgentType | null {
  const latestMessage = state.messages[state.messages.length - 1];
  if (
    latestMessage?.role !== 'user'
    || !latestMessage.content?.startsWith(WIDGET_CONTINUATION_PREFIX)
    || !state.widgetContinuation
    || !state.agentPipeline?.length
  ) {
    return null;
  }

  const pipelineIndex = state.agentPipelineIndex ?? 0;
  const pendingAgent = state.agentPipeline[pipelineIndex];
  return pendingAgent && SPECIALIST_AGENTS.includes(pendingAgent)
    ? pendingAgent
    : null;
}

/**
 * Scoped cancellation. Each scope stops only what it names: one review, one
 * running operation, or the whole campaign plan. Returns null when the turn is
 * not a cancellation this function settles (for example a scheduled post,
 * which Content Studio owns).
 */
const RUNNING_ACTION_STATUSES = ['running', 'queued', 'provider_succeeded'];

/** "Cancel that search" while only an unstarted review exists cannot mean a
 * running operation: nothing is running. The router may still label it an
 * operation; the only thing the user can be cancelling is that review. */
export function cancellationTargetsUnstartedReview(state: Pick<AgentState, 'pendingApproval' | 'savedToolActions'>): boolean {
  const actions = state.savedToolActions || [];
  if (actions.some(action => RUNNING_ACTION_STATUSES.includes(action.status))) return false;
  return Boolean(state.pendingApproval) || actions.some(action => ['active', 'draft'].includes(action.status));
}

async function routeCancellation(state: AgentState, routed: UnifiedAnalysis): Promise<RouterResult | null> {
  if (routed.action !== 'cancel') return null;
  const { userId, threadId } = state;
  const analysis: UnifiedAnalysis = routed.cancellationScope === 'operation' && routed.nextAgent !== 'performance_marketing'
    && cancellationTargetsUnstartedReview(state) ? { ...routed, cancellationScope: 'review' } : routed;
  if (analysis.action === 'cancel' && (analysis.needsClarification
    || !analysis.cancellationScope || analysis.cancellationScope === 'unspecified'
    || (!['campaign', 'review'].includes(analysis.cancellationScope) && !analysis.nextAgent && !analysis.hiredAgents.length))) {
    state.messages.push({ role: 'assistant', agentType: 'orchestrator', content:
      'Which item should I cancel? Please identify the post, review, or operation, or say explicitly if you want to stop the entire campaign plan. Nothing has been cancelled.' });
    return { nextAgent: null, stateUpdates: {} };
  }
  if (analysis.action === 'cancel' && analysis.cancellationScope === 'review') {
    const { cancelCampaignReviews, cancelPendingCampaignApproval } = await import('./cancelCampaignReviews.js');
    const reviews = (state.savedToolActions || []).filter(action => ['active', 'draft'].includes(action.status));
    const pendingId = state.pendingApproval?.executionId || state.pendingApproval?.toolCallId;
    const candidates = [...reviews.map(action => `widget:${action.widgetId}`), ...(pendingId ? [`approval:${pendingId}`] : [])];
    const target = analysis.cancellationReviewId || (candidates.length === 1 ? candidates[0] : null);
    if (!target || !candidates.includes(target)) {
      state.messages.push({ role: 'assistant', agentType: 'orchestrator', content:
        candidates.length ? `Which review should I cancel? Available review IDs: ${candidates.join(', ')}. Nothing has been cancelled.`
          : 'There is no identifiable unstarted review to cancel here. Nothing has been cancelled.' });
      return { nextAgent: null, stateUpdates: {} };
    }
    if (target.startsWith('widget:')) {
      const cancelledIds = await cancelCampaignReviews(userId, threadId, Number(target.slice(7)));
      state.savedToolActions = state.savedToolActions?.map(action => cancelledIds.includes(action.widgetId) ? { ...action, status: 'cancelled' } : action);
      state.messages.push({ role: 'assistant', agentType: 'orchestrator', content: cancelledIds.length
        ? `Cancelled review ${target}. Other reviews and the campaign plan are unchanged.`
        : `Review ${target} could not be cancelled; it may already have started or changed. Other reviews are unchanged.` });
      return { nextAgent: null, stateUpdates: {} };
    }
    const cancelledApproval = await cancelPendingCampaignApproval(userId, threadId, state.pendingApproval);
    state.messages.push({ role: 'assistant', agentType: 'orchestrator', metadata: cancelledApproval ? { cancelledApproval } : undefined,
      content: cancelledApproval ? 'Cancelled that pending review. Other reviews and the campaign plan are unchanged.'
        : 'That review could not be cancelled; it may already have been accepted. No other review was changed.' });
    return { nextAgent: null, stateUpdates: cancelledApproval ? { pendingApproval: null, requiresApproval: false, actionButtons: [] } : {} };
  }
  if (analysis.action === 'cancel' && analysis.cancellationScope === 'operation') {
    if (analysis.nextAgent === 'performance_marketing') {
      // Paid-ad stops have an existing exact-campaign review/receipt flow.
      // The specialist exposes only lookup and stop-review tools for this turn.
      return { nextAgent: 'performance_marketing', stateUpdates: {} };
    }
    const actions = state.savedToolActions || [];
    if (!state.pendingApproval && !actions.some(action => [...RUNNING_ACTION_STATUSES, 'active', 'draft'].includes(action.status))) {
      state.messages.push({ role: 'assistant', agentType: 'orchestrator', content:
        'There is nothing running or waiting for review here to cancel. Nothing has been changed.' });
      return { nextAgent: null, stateUpdates: {} };
    }
    state.messages.push({ role: 'assistant', agentType: 'orchestrator', content:
      'I have not stopped this operation. Running or provider-queued work needs its specific stop control and a confirmed result. Open the operation in its workspace to stop it; cancelling a review or campaign plan does not stop work already in progress.' });
    return { nextAgent: null, stateUpdates: {} };
  }
  if (analysis.action === 'cancel' && analysis.cancellationScope === 'campaign') {
    const { cancelCampaignReviews, cancelPendingCampaignApproval } = await import('./cancelCampaignReviews.js');
    const cancelledIds = await cancelCampaignReviews(userId, threadId);
    const cancelledApproval = await cancelPendingCampaignApproval(userId, threadId, state.pendingApproval);
    const cancelledSet = new Set(cancelledIds);
    state.savedToolActions = state.savedToolActions?.map(action => cancelledSet.has(action.widgetId) ? { ...action, status: 'cancelled' } : action);
    const cancellationDetail = cancelledIds.length ? ` Cancelled ${cancelledIds.length} unrun review ${cancelledIds.length === 1 ? 'card' : 'cards'}; they cannot execute.` : '';
    const runningDetail = state.savedToolActions?.some(action => RUNNING_ACTION_STATUSES.includes(action.status))
      ? ' Already-running or queued operations require a separate stop/reconciliation; I have not claimed to cancel them.' : '';
    state.messages.push({ role: 'assistant', agentType: 'orchestrator', metadata: cancelledApproval ? { cancelledApproval } : undefined, content:
      'I stopped the campaign plan. No further plan steps will run.' + cancellationDetail + runningDetail
      + (cancelledApproval ? ' The pending action approval was also cancelled.' : state.pendingApproval ? ' The separate action could not be revoked; it may already have been accepted and needs review.' : '') });
    return { nextAgent: null, stateUpdates: { agentPipeline: [], deferredLeadReviewPipeline: [], agentPipelineIndex: 0, pipelineRequest: undefined, tasksCompleted: false, workflowOutcome: 'cancelled', actionButtons: [], ...(cancelledApproval ? { pendingApproval: null, requiresApproval: false } : {}) } };
  }
  return null;
}

export async function routerLogic(
  state: AgentState,
  explicitSwitchTarget?: AgentType,
  forceTarget?: AgentType,
): Promise<RouterResult> {
  const { userId, threadId } = state;

  // If nextAgent already set (from switch_agent tool), use it
  if (state.nextAgent) {
    emitTransition(userId, threadId, state.nextAgent, state.currentAgent);
    return { nextAgent: state.nextAgent, stateUpdates: {} };
  }

  const widgetContinuationAgent = getWidgetContinuationAgent(state);
  if (widgetContinuationAgent) {
    if (state.widgetContinuation?.success === false) {
      state.messages.push({ role: 'assistant', content: 'The reviewed action failed. Its error is shown in the task card. I have not retried it, prepared a replacement card, or advanced the campaign. Ask me to revise the settings when you are ready.', agentType: widgetContinuationAgent });
      return { nextAgent: null, stateUpdates: { workflowOutcome: 'failed', tasksCompleted: false, routingDecisionConsumed: true } };
    }
    logger.info(
      {
        threadId,
        pipelineIndex: state.agentPipelineIndex ?? 0,
        pendingAgent: widgetContinuationAgent,
      },
      '[Orchestrator] Resuming widget completion on the existing pipeline',
    );
    return { nextAgent: widgetContinuationAgent, stateUpdates: {} };
  }

  // An ICP is ready only when the client approved the exact current revision.
  // Fit score measures completeness; it is not authorization to continue.
  const icpComplete = !!(
    state.icpProfile &&
    state.icpProfile.fitScore != null &&
    state.icpProfile.fitScore >= 50 &&
    state.icpProfile.approved === true &&
    state.icpProfile.revision != null &&
    state.icpProfile.approvedRevision === state.icpProfile.revision
  );

  if (forceTarget) {
    if (!SPECIALIST_AGENTS.includes(forceTarget)) throw new Error('Invalid forced agent target');
    if ((state.requiresApproval || state.pendingApproval) && state.currentAgent !== forceTarget) {
      state.messages.push({ role: 'assistant', agentType: 'orchestrator', content:
        `There is an unfinished review in this campaign. Finish or cancel that review first, then I can switch to ${getDisplayName(forceTarget)}.` });
      return { nextAgent: null, stateUpdates: {} };
    }
    if (forceTarget !== 'icp_generation' && !icpComplete) {
      const latestUserRequest = [...state.messages].reverse().find(message => message.role === 'user')?.content || '';
      const paused = pauseForSavedIcpApproval(state, buildIcpPrerequisiteState(forceTarget, latestUserRequest));
      if (paused) return paused;
      emitHandoffMessage(userId, threadId, 'icp_generation', !!state.icpProfile && (state.icpProfile.fitScore || 0) >= 50);
      emitTransition(userId, threadId, 'icp_generation', state.currentAgent);
      return {
        nextAgent: 'icp_generation',
        stateUpdates: buildIcpPrerequisiteState(forceTarget, latestUserRequest),
      };
    }
    return { nextAgent: forceTarget, stateUpdates: {} };
  }

  const hasIcpData = !!(
    state.icpProfile &&
    (state.icpProfile.summary ||
      state.icpProfile.targetAudience ||
      state.icpProfile.primaryChannels?.length)
  );

  const icpContinuationAgent = getIcpApprovalContinuationAgent(state);
  if (icpContinuationAgent) {
    return { nextAgent: icpContinuationAgent, stateUpdates: { icpApprovalContinuation: undefined } };
  }

  // Check last user message
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage && lastMessage.role === 'user') {
    const messageContent = lastMessage.content || '';

    // LLM-powered agent intent detection (replaces legacy regex and name inclusion checks)
    if (explicitSwitchTarget) {
      if (!SPECIALIST_AGENTS.includes(explicitSwitchTarget)) throw new Error('Invalid switch target');
      state.intentAnalysis = routerOutputSchema.parse({
        intent: 'task', action: 'switch_agent', hiredAgents: [explicitSwitchTarget], mode: 'hire_agent',
        isAffirmative: false, isDomainMatch: false, navigationTarget: null,
        response: '', nextAgent: explicitSwitchTarget, suggestAgents: false, recommendedAgents: [],
      });
    }
    const analysis = await getUnifiedMessageAnalysis(messageContent, state.currentAgent as AgentType, userId, state);
    const cancellation = await routeCancellation(state, analysis);
    if (cancellation) return cancellation;
    if (analysis.suggestAgents && !analysis.needsClarification && !analysis.nextAgent && !analysis.hiredAgents.length) {
      return { nextAgent: 'supervisor', stateUpdates: {} };
    }
    if ((analysis.action === 'cancel' && analysis.cancellationScope === 'scheduled_post')
      || (analysis.contentManagementRequested && !analysis.needsClarification && analysis.nextAgent === 'content_studio')) {
      // A scoped publication cancellation is independent of campaign planning,
      // ICP readiness and another specialist's pending approval.
      return { nextAgent: 'content_studio', stateUpdates: {} };
    }
    if (analysis.leadShortlistRequested && !analysis.needsClarification && analysis.nextAgent === 'lead_generation') {
      return { nextAgent: 'lead_generation', stateUpdates: {} };
    }
    if (analysis.needsClarification
      || (analysis.action === 'question' && !analysis.nextAgent && !analysis.hiredAgents.length)
      || ((analysis.intent === 'conversational' || analysis.intent === 'meta')
        && !analysis.nextAgent && !analysis.hiredAgents.length && analysis.action !== 'continue')) {
      state.messages.push({ role: 'assistant', content: analysis.response, agentType: 'orchestrator' });
      return { nextAgent: null, stateUpdates: {} };
    }
    if (analysis.action === 'continue' && !analysis.leadSettingsRequested) {
      // "Save draft" deliberately shelves a review without authorizing it. A
      // saved draft must remain editable, but it must not block a later task or
      // agent handoff as though the user still had an active approval prompt.
      const unrunReviews = state.savedToolActions?.filter(action => action.status === 'active') ?? [];
      if (unrunReviews.length) {
        const labels = unrunReviews.map(action => action.toolName.replace(/_/g, ' ')).join(', ');
        state.messages.push({ role: 'assistant', agentType: state.currentAgent || 'orchestrator', content:
          `These actions are still awaiting review: ${labels}. Use Confirm and run on the specific review card you want to authorize, or tell me which settings to change. No action has run and I have not started a later step.` });
        return { nextAgent: null, stateUpdates: { tasksCompleted: false, workflowOutcome: 'awaiting_approval' } };
      }
    }
    if(state.intentAnalysis?.semanticRequest?.dashboardOperation==='campaign_prepare' && !analysis.needsClarification) {
      return {nextAgent:analysis.nextAgent || 'outreach',stateUpdates:{}};
    }
    // Read-only specialist questions are side turns, not ownership transfers.
    // BaseAgent restricts their tools to reads; the runner merge isolates the
    // review/pipeline from both pre-processing mutations and returned defaults.
    if (analysis.action === 'question' && analysis.intent !== 'navigation') {
      const target = analysis.nextAgent || analysis.hiredAgents[0] || state.currentAgent;
      if (target && SPECIALIST_AGENTS.includes(target)) {
        return { nextAgent: target, stateUpdates: {} };
      }
    }
    // Navigation is also allowed while a review is open. Mutating handoffs
    // still require the user to finish or cancel that review first.
    if ((state.requiresApproval || state.pendingApproval) && analysis.intent !== 'navigation') {
      const target = analysis.nextAgent || analysis.hiredAgents[0];
      if (target && target !== state.currentAgent) {
        state.messages.push({ role: 'assistant', agentType: 'orchestrator', content:
          'There is an unfinished review in this campaign. Finish or cancel that review first, then I can switch to ' + getDisplayName(target) + '.' });
        return { nextAgent: null, stateUpdates: {} };
      }
      if (state.currentAgent && SPECIALIST_AGENTS.includes(state.currentAgent)) {
        return { nextAgent: state.currentAgent, stateUpdates: {} };
      }
    }
    if (analysis.action === 'new_task' || analysis.action === 'switch_agent') {
      state.deferredLeadReviewPipeline = [];
    }
    const hiredAgents = sanitizeLeadReviewPipeline(
      state,
      filterExplicitlyExcludedAgents(analysis.excludedAgents, analysis.hiredAgents),
    );
    const mode = hiredAgents.length > 1 ? 'hire_team' : hiredAgents.length === 1 ? 'hire_agent' : 'none';
    const { intent, navigationTarget } = analysis;

    // Handle UI Navigation and View Intents
    if (intent === 'navigation' && navigationTarget) {
      const { tabType } = navigationTarget;
      const tabLabel = tabType === 'search' ? 'Explore Tabs' : navigationTarget.tabLabel;
      webSocketEmitter.emitOpenTab(userId, tabType, tabLabel, undefined, threadId);

      const responseText = `I've opened the **${tabLabel}** tab for you! Let me know if you need help with anything else.`;

      // Let the normal response pipeline stream and persist this exactly once.
      // Persisting here as well caused navigation commands to produce duplicate
      // replies and could leave the user's command as the final state message.
      state.messages.push({
        role: 'assistant',
        content: responseText,
        agentType: 'orchestrator',
      });

      return { nextAgent: null, stateUpdates: {} };
    }

    // A bare "continue" after a paused hand-over starts the waiting step,
    // not the specialist that already finished.
    const resumedStep = continuationPipelineAgent(state, analysis);
    if (resumedStep && icpComplete) {
      emitTransition(userId, threadId, resumedStep, state.currentAgent);
      return { nextAgent: resumedStep, stateUpdates: {} };
    }

    // Continuations/refinements preserve the plan and original request.
    if (['continue', 'revise', 'question'].includes(analysis.action || '')) {
      const target = analysis.nextAgent || (SPECIALIST_AGENTS.includes(state.currentAgent as AgentType) ? state.currentAgent : null);
      if (target && (target === 'icp_generation' || icpComplete || analysis.action === 'question')) {
        return { nextAgent: target, stateUpdates: {} };
      }
    }

    // Multi-agent hire
    if (mode === 'hire_team' && hiredAgents.length > 1) {
      let pipelineAgents = [...hiredAgents];
      if (!icpComplete) {
        pipelineAgents = pipelineAgents.filter(a => a !== 'icp_generation');
        pipelineAgents.unshift('icp_generation');
        const paused = pauseForSavedIcpApproval(state, {
          agentPipeline: pipelineAgents, agentPipelineIndex: 0, pipelineRequest: messageContent, tasksCompleted: false,
        });
        if (paused) return paused;
      }

      const firstAgent = pipelineAgents[0];
      const agentNames = pipelineAgents
        .filter(a => a !== 'icp_generation')
        .map(a => AGENT_INFO[a]?.displayName || a);

      const teamContent = `🎯 **Team Assembled!** I've brought in ${agentNames.join(' & ')} to work together on your campaign. Let me start by coordinating with ${AGENT_INFO[firstAgent]?.displayName || firstAgent}.`;
      const teamMetadata = {
        isTransition: true,
        isTransitionMessage: true,
        isTeamAssembled: true,
        fromAgent: 'router',
        toAgent: firstAgent,
        toAgentName: AGENT_INFO[firstAgent]?.displayName || firstAgent,
        pipelineStep: 1,
        pipelineTotal: pipelineAgents.length,
        pipelineAgents: pipelineAgents.filter(a => a !== 'icp_generation'),
      };

      webSocketEmitter.emitChatResponse(userId, threadId, {
        role: 'assistant', content: teamContent, agentType: 'orchestrator', metadata: teamMetadata,
      });
      createChatMessage({
        userId, threadId, role: 'assistant', content: teamContent, agentType: 'orchestrator', metadata: teamMetadata,
      }).catch(err => logger.error({ err }, '[Orchestrator] Failed to save team message'));

      webSocketEmitter.emitAgentStatus(userId, firstAgent, 'thinking',
        `${AGENT_INFO[firstAgent]?.displayName || firstAgent} is working...`, undefined, threadId);

      return {
        nextAgent: firstAgent,
        stateUpdates: { agentPipeline: pipelineAgents, agentPipelineIndex: 0, pipelineRequest: messageContent, tasksCompleted: false },
      };
    }

    // Single agent hire
    if (mode === 'hire_agent' && hiredAgents.length === 1) {
      const hiredAgent = hiredAgents[0];
      // All specialist agents require ICP to function properly
      if (hiredAgent !== 'icp_generation' && !icpComplete) {
        const paused = pauseForSavedIcpApproval(state, buildIcpPrerequisiteState(hiredAgent, messageContent));
        if (paused) return paused;
        emitHandoffMessage(userId, threadId, 'icp_generation', !!state.icpProfile && (state.icpProfile.fitScore || 0) >= 50);
        emitTransition(userId, threadId, 'icp_generation', state.currentAgent);
        return {
          nextAgent: 'icp_generation',
          // Preserve the user's requested destination while the ICP agent
          // satisfies the prerequisite. Without this durable pipeline the
          // request is lost and the ICP specialist treats the original ad,
          // content, or outreach request as out of scope.
          stateUpdates: buildIcpPrerequisiteState(hiredAgent, messageContent),
        };
      }
      if (icpComplete || hiredAgent === 'icp_generation') {
        const isInPipeline = state.agentPipeline && state.agentPipeline.length > 1;
        if (!isInPipeline) {
          emitHandoffMessage(userId, threadId, hiredAgent);
          emitTransition(userId, threadId, hiredAgent, state.currentAgent);
        } else {
          webSocketEmitter.emitAgentStatus(userId, hiredAgent, 'thinking',
            `${AGENT_INFO[hiredAgent]?.displayName || hiredAgent} is working...`, undefined, threadId);
        }
        return { nextAgent: hiredAgent, stateUpdates: analysis.action === 'new_task' || analysis.action === 'switch_agent'
          ? { agentPipeline: [hiredAgent], agentPipelineIndex: 0, pipelineRequest: messageContent, tasksCompleted: false }
          : {} };
      }
    }

    // The unified router's explicit handoff is authoritative when it is valid.
    // Previously it was discarded unless the model also selected a hire mode,
    // which trapped cross-domain follow-ups with the current specialist.
    if (analysis.nextAgent && analysis.nextAgent !== state.currentAgent) {
      const targetAgent = analysis.nextAgent;
      if (targetAgent !== 'icp_generation' && !icpComplete) {
        const paused = pauseForSavedIcpApproval(state, buildIcpPrerequisiteState(targetAgent, messageContent));
        if (paused) return paused;
        emitHandoffMessage(userId, threadId, 'icp_generation', !!state.icpProfile && (state.icpProfile.fitScore || 0) >= 50);
        emitTransition(userId, threadId, 'icp_generation', state.currentAgent);
        return {
          nextAgent: 'icp_generation',
          stateUpdates: buildIcpPrerequisiteState(targetAgent, messageContent),
        };
      }
      emitHandoffMessage(userId, threadId, targetAgent);
      emitTransition(userId, threadId, targetAgent, state.currentAgent);
      return { nextAgent: targetAgent, stateUpdates: {} };
    }

    // First message in thread — use AI to detect greeting vs task
    const isFirstMessage = !state.messages.some(m => m.role === 'assistant');
    if (isFirstMessage) {
      if (intent === 'conversational' || intent === 'meta') {
        return { nextAgent: 'supervisor', stateUpdates: {} };
      }

      // Clarification Guard: if task maps to none of our agents, ask for clarification
      if (hiredAgents.length === 0) {
        logger.info(
          { messageContent, threadId },
          '[Migration Tracking] [Orchestrator] Unclear/unsupported task plan detected — prompting for clarification'
        );
        // Preserve the contextual model answer and let the normal response
        // path persist it once. No assigned specialist is not an unsupported
        // request, and a planning answer must not trigger automatic ICP work.
        state.messages.push({ role: 'assistant', agentType: 'orchestrator',
          content: analysis.response || 'What outcome would you like this campaign to achieve?' });
        
        return { nextAgent: null, stateUpdates: {} };
      }

      emitHandoffMessage(userId, threadId, 'icp_generation');
      emitTransition(userId, threadId, 'icp_generation', state.currentAgent);
      return { nextAgent: 'icp_generation', stateUpdates: {} };
    }
  }

  // No ICP data
  if (!hasIcpData) {
    logger.info(
      { threadId, legacyFallback: 'icp_generation' },
      '[Migration Tracking] [Orchestrator] Fallback: No ICP data, routing to icp_generation'
    );
    emitTransition(userId, threadId, 'icp_generation', state.currentAgent);
    return { nextAgent: 'icp_generation', stateUpdates: {} };
  }

  // Pipeline pause check
  const pendingPipelineIndex = state.agentPipelineIndex || 0;
  const hasPendingPipelineStep = !!(
    state.agentPipeline?.length && state.agentPipeline.length > 1 &&
    pendingPipelineIndex > 0 && pendingPipelineIndex < state.agentPipeline.length
  );
  if (hasPendingPipelineStep) {
    return { nextAgent: 'supervisor', stateUpdates: {} };
  }

  // Stay with current specialist agent (unless conversational/meta message → route to supervisor)
  const currentAgent = state.currentAgent as AgentType;
  if (currentAgent && SPECIALIST_AGENTS.includes(currentAgent)) {
    const latestContent = state.messages[state.messages.length - 1]?.content || '';
    const specialistAnalysis = await getUnifiedMessageAnalysis(
      latestContent,
      currentAgent,
      state.userId,
      state,
    );
    const intent = specialistAnalysis.intent;

    if (intent === 'meta') {
      if (specialistAnalysis.isAffirmative || specialistAnalysis.isDomainMatch) {
        return { nextAgent: currentAgent, stateUpdates: {} };
      }
    }

    if (intent === 'conversational' || intent === 'meta') {
      return { nextAgent: 'supervisor', stateUpdates: {} };
    }
    return { nextAgent: currentAgent, stateUpdates: {} };
  }

  // Default: supervisor
  logger.info(
    { threadId, legacyFallback: 'supervisor' },
    '[Migration Tracking] [Orchestrator] Fallback: Defaulting routing to supervisor'
  );
  return { nextAgent: 'supervisor', stateUpdates: {} };
}

// ── Post-Agent Conditional Edge ────────────────────────────────────────
// Same logic as agentConditionalEdge in graph.ts

export function checkAfterAgent(agentName: string, state: AgentState): 'supervisor' | 'end' {
  if (state.intentAnalysis?.contentManagementRequested || state.intentAnalysis?.leadShortlistRequested || ['question', 'cancel'].includes(state.intentAnalysis?.action || '')) return 'end';
  if (state.workflowOutcome === 'failed' || state.workflowOutcome === 'cancelled') return 'end';
  if (state.requiresApproval) return 'end';

  const isReady = agentName === 'icp_generation'
    ? (state.icpProfile?.fitScore || 0) >= 50 && isCurrentIcpRevisionApproved(state.icpProfile)
    : !!state.tasksCompleted;

  // A timeout is an explicit terminal outcome, never proof of completion.
  if (!isReady && state.agentStartedAt) {
    const elapsed = Date.now() - state.agentStartedAt;
    if (elapsed > AGENT_STALL_TIMEOUT_MS) {
      logger.warn({ agent: agentName, elapsedMs: elapsed }, '[Orchestrator] Agent timed out; pipeline remains paused');
      state.workflowOutcome = 'timed_out';
      state.error = `${agentName} timed out before completing its workflow.`;
      webSocketEmitter.emitProgressStep(
        state.userId,
        state.threadId,
        'timed_out',
        'This workflow timed out before completion. Review the last completed step and retry.',
        agentName,
        { outcome: 'timed_out' },
      );
      return 'end';
    }
  }

  if (isReady && state.agentPipeline && state.agentPipeline.length > 0) {
    const currentIndex = state.agentPipelineIndex || 0;
    const pendingAgent = getPendingPipelineAgentAfterCompletion(state, agentName as AgentType);
    if (pendingAgent) {
      logger.info({ pendingAgent, completedAgent: agentName, currentIndex },
        '[Orchestrator] Completed off-pipeline prerequisite; resuming pending pipeline agent');
      return 'supervisor';
    }
    const nextIndex = currentIndex + 1;
    if (nextIndex < state.agentPipeline.length) {
      logger.info({ nextPipelineAgent: state.agentPipeline[nextIndex], nextIndex, agent: agentName },
        '[Orchestrator] Pipeline advancing to next agent');
      return 'supervisor';
    }
  }

  if (state.nextAgent && state.nextAgent !== agentName) return 'supervisor';

  return 'end';
}

export const CONTINUE_PIPELINE_MESSAGE = 'Continue with the next step of this campaign.';

/**
 * When a turn reaches its time limit right after a specialist finished and
 * handed over (the next hop is the supervisor and the pipeline points at a
 * different specialist), return an honest pause instead of a timeout failure.
 */
export function pipelinePauseAtTimeLimit(
  state: AgentState,
  nextAgent: AgentType | null,
  lastAgent: string | null,
): { message: Message; actionButtons: ActionButton[]; pendingAgent: AgentType } | null {
  if (nextAgent !== 'supervisor' || state.error || state.requiresApproval || state.pendingApproval
    || ['failed', 'cancelled', 'timed_out'].includes(state.workflowOutcome || '')) return null;
  const pendingAgent = getPendingPipelineAgent(state);
  if (!pendingAgent || pendingAgent === lastAgent) return null;
  const finished = lastAgent && lastAgent !== 'supervisor' ? getDisplayName(lastAgent) : 'The previous step';
  const next = getDisplayName(pendingAgent);
  return {
    pendingAgent,
    actionButtons: [{ id: `continue_pipeline_${pendingAgent}`, label: `Continue with ${next}`, action: 'RESUME_PIPELINE_STEP',
      type: 'primary', data: { message: CONTINUE_PIPELINE_MESSAGE, agentType: pendingAgent } }],
    message: {
      role: 'assistant', agentType: 'orchestrator',
      content: `${finished} has finished. ${next} has not started yet because this turn reached its time limit. Nothing was lost; continue when you're ready.`,
      metadata: { workflowOutcome: 'awaiting_input', pausedPipelineAgent: pendingAgent },
    },
  };
}

/**
 * A bare "continue" resumes the paused pipeline step. Returns that step's
 * agent, or null when the router named a different specialist or there is no
 * later step waiting.
 */
export function continuationPipelineAgent(
  state: Pick<AgentState, 'agentPipeline' | 'agentPipelineIndex' | 'currentAgent'>,
  analysis: Pick<UnifiedAnalysis, 'action' | 'needsClarification' | 'nextAgent'>,
): AgentType | null {
  if (analysis.action !== 'continue' || analysis.needsClarification) return null;
  const index = state.agentPipelineIndex ?? 0;
  const pending = state.agentPipeline?.[index];
  if (index <= 0 || !pending || !SPECIALIST_AGENTS.includes(pending) || pending === state.currentAgent) return null;
  if (analysis.nextAgent && analysis.nextAgent !== pending) return null;
  return pending;
}

// ── processMessage ─────────────────────────────────────────────────────

type IntermediateResponse = {
  agentType: string;
  content: string;
  responseId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
};

export async function processMessage(
  userId: number,
  threadId: number,
  message: string,
  existingState?: Partial<AgentState>,
  control?: { switchTarget?: AgentType; forceTarget?: AgentType; turnIntent?: import('./routerSchema.js').RouterOutput },
): Promise<AgentState & { _intermediateResponses?: IntermediateResponse[] }> {
  logger.info({ userId, threadId, message: message.substring(0, 100) }, '[Orchestrator] Starting processMessage');

  const emitter = webSocketEmitter;

  // ── Build normalised state ───────────────────────────────────────────
  const initialState = createInitialState(userId, threadId);

  // Normalize existing messages (may contain LangChain BaseMessage objects)
  const normalizedExistingMessages: Message[] =
    (existingState?.messages || []).map(normalizeMessage);

  const state: AgentState = {
    ...initialState,
    ...(existingState || {}),
    messages: [
      ...normalizedExistingMessages,
      { role: 'user', content: message },
    ],
    nextAgent: null,
    requiresApproval: existingState?.requiresApproval ?? false,
    pendingApproval: existingState?.pendingApproval ?? null,
    runContext: {
      userId,
      threadId,
      runId: existingState?.runContext?.runId || initialState.runContext!.runId,
      turnId: existingState?.runContext?.turnId || randomUUID(),
      ...(existingState?.runContext?.actionId
        ? { actionId: existingState.runContext.actionId }
        : {}),
    },
    workflowOutcome: 'running',
    // Only this invocation's server-classified result is reusable. Never use
    // an intent loaded from an earlier turn's persisted state.
    intentAnalysis: control?.turnIntent,
    routingDecisionConsumed: false,
  };
  prepareLeadReviewPipeline(state, message);

  // ── Progress steps ───────────────────────────────────────────────────
  const willGoToSupervisor = !state.currentAgent || state.currentAgent === 'supervisor';
  if (willGoToSupervisor) {
    emitter.emitProgressStep(userId, threadId, 'analyzing', 'Analyzing your message...', 'orchestrator');
    emitter.emitProgressStep(userId, threadId, 'intent', 'Detecting message intent...', 'orchestrator');
  } else {
    const displayName = AGENT_INFO[state.currentAgent as AgentType]?.displayName || state.currentAgent;
    emitter.emitProgressStep(userId, threadId, 'processing', `${displayName} is working on your request...`, state.currentAgent);
  }

  const icpScore = existingState?.icpProfile?.fitScore || 0;
  if (icpScore > 0) {
    emitter.emitProgressStep(userId, threadId, 'icp_check', `Checking ICP status (${icpScore}% complete)...`, 'orchestrator');
  }

  try {
    // ── Router ─────────────────────────────────────────────────────────
    const routeResult = await routerLogic(state, control?.switchTarget, control?.forceTarget);
    Object.assign(state, routeResult.stateUpdates);
    let nextAgent: AgentType | null = routeResult.nextAgent;

    const intermediateResponses: IntermediateResponse[] = [];
    let lastAgent: string | null = existingState?.currentAgent || null;
    let iterations = 0;

    // ── Agent loop ─────────────────────────────────────────────────────
    const startTime = Date.now();
    const timeoutMs = 120000; // 2 minutes (120 seconds) limit
    let terminalTimedOut = false;
    while (nextAgent && iterations < MAX_AGENT_ITERATIONS) {
      iterations++;

      if (Date.now() - startTime > timeoutMs) {
        // The previous specialist finished and the pipeline already points at
        // the next one. Nothing failed: stop before starting new work and let
        // the user continue, instead of reporting the whole turn as timed out.
        const pause = pipelinePauseAtTimeLimit(state, nextAgent, lastAgent);
        if (pause) {
          state.messages.push(pause.message);
          state.actionButtons = pause.actionButtons;
          state.workflowOutcome = 'awaiting_input';
          state.tasksCompleted = false;
          intermediateResponses.push({ agentType: 'orchestrator', content: pause.message.content,
            metadata: { ...pause.message.metadata, actionButtons: pause.actionButtons } });
          logger.info({ userId, threadId, pendingAgent: pause.pendingAgent }, '[Orchestrator] Paused between pipeline steps at the turn time limit');
          break;
        }
        logger.warn(
          { userId, threadId, iterations },
          '[Migration Tracking] [Orchestrator] Agent execution loop timed out'
        );
        state.workflowOutcome = 'timed_out';
        state.error = 'Agent execution timed out before the workflow reached a terminal result.';
        state.messages.push({
          role: 'assistant',
          content: 'This workflow timed out before completion. Review the last completed step and retry.',
          agentType: state.currentAgent || 'orchestrator',
          metadata: { workflowOutcome: 'timed_out', needsAttention: true },
        });
        emitter.emitProgressStep(
          userId,
          threadId,
          'timed_out',
          'This workflow timed out before completion. Review the last completed step and retry.',
          state.currentAgent || 'orchestrator',
          { outcome: 'timed_out', needsAttention: true },
        );
        terminalTimedOut = true;
        break;
      }

      if (nextAgent === 'supervisor') {
        const supervisorResult = await runSupervisor(state);

        // Track supervisor response
        if (supervisorResult.response) {
          const supMsg: Message = { role: 'assistant', content: supervisorResult.response, agentType: 'supervisor' };
          state.messages.push(supMsg);
          state.currentAgent = 'supervisor';
        }

        // Generate agent suggestion buttons when supervisor recommends it
        if (supervisorResult.suggestAgents) {
          // Use recommended agents from supervisor (contextual), fallback to defaults
          const recommended = supervisorResult.recommendedAgents?.length
            ? supervisorResult.recommendedAgents
            : ['lead_generation', 'content_studio', 'outreach'] as AgentType[];

          const agentButtonConfig: Record<string, { icon: string; label: string }> = {
            lead_generation: { icon: '🎯', label: 'Lead Generation (Marcus)' },
            content_studio: { icon: '✍️', label: 'Content Studio (Alex)' },
            outreach: { icon: '📧', label: 'Outreach (Emily)' },
            performance_marketing: { icon: '📊', label: 'Performance Marketing (Sarah)' },
            icp_generation: { icon: '🧠', label: 'ICP Profile' },
          };

          const suggestButtons: ActionButton[] = recommended.map((agent, index) => {
            const config = agentButtonConfig[agent] || { icon: '🔧', label: agent };
            return {
              id: `hire_${agent}`,
              label: `${config.icon} ${config.label}`,
              action: 'HIRE_AGENT',
              type: (index === 0 ? 'primary' : 'secondary') as 'primary' | 'secondary',
              data: { agentType: agent },
            };
          });

          // Add "Hire Team" button if multiple agents recommended — creates a pipeline
          if (recommended.length >= 2) {
            suggestButtons.push({
              id: 'hire_team',
              label: `🚀 Hire Team — ${recommended.length} Agents`,
              action: 'HIRE_TEAM',
              type: 'primary' as const,
              data: { agentTypes: recommended },
            });
          }

          state.actionButtons = suggestButtons;

          if (supervisorResult.response) {
            intermediateResponses.push({
              agentType: 'supervisor',
              content: supervisorResult.response,
              metadata: { actionButtons: suggestButtons },
            });
          }
          break;
        }

        if (supervisorResult.nextAgent) {
          emitTransition(userId, threadId, supervisorResult.nextAgent, 'supervisor');
          nextAgent = supervisorResult.nextAgent;
        } else {
          // Supervisor did not route — conversation complete
          if (supervisorResult.response) {
            intermediateResponses.push({ agentType: 'supervisor', content: supervisorResult.response });
          }
          break;
        }

        lastAgent = 'supervisor';
        continue;
      }

      // ── Specialist agent ─────────────────────────────────────────────
      const outreachGateMessage = blockPrematureOutreach(state, nextAgent);
      if (outreachGateMessage) {
        state.messages.push(outreachGateMessage);
        intermediateResponses.push({
          agentType: 'orchestrator',
          content: outreachGateMessage.content,
          metadata: outreachGateMessage.metadata,
        });
        break;
      }

      const runner = AGENT_RUNNERS[nextAgent];
      if (!runner) {
        logger.error({ agent: nextAgent }, '[Orchestrator] No runner found for agent');
        break;
      }

      // Track when this agent started for stall detection
      state.agentStartedAt = Date.now();

      // Emit progress step for this agent
      const agentDisplayName = AGENT_INFO[nextAgent]?.displayName || nextAgent;
      emitter.emitProgressStep(userId, threadId, `node_${nextAgent}`, `Processing with ${agentDisplayName}...`, nextAgent);

      // Complete previous agent status
      if (lastAgent && lastAgent !== 'supervisor' && lastAgent !== nextAgent) {
        emitter.emitAgentStatus(userId, lastAgent, 'completed', undefined, undefined, threadId);
      }

      // Run the agent
      state.routingDecisionConsumed = true;
      const readOnlyTeamAgent = state.intentAnalysis?.action === 'question'
        && (state.intentAnalysis.hiredAgents?.length ?? 0) > 1 ? nextAgent : undefined;
      const agentUpdate = await runAndMergeSpecialistTurn(state, runner, readOnlyTeamAgent);

      const newMessages: Message[] = agentUpdate.messages || [];

      // ── Capture switch_agent / suggest_switch_agents from tool results ──
      if (agentUpdate.toolResults?.length) {
        const switchOutput = successfulToolOutput(agentUpdate.toolResults, 'switch_agent');
        const switchTarget = validToolHandoff(state, switchOutput);
        if (switchTarget) state.nextAgent = switchTarget;
        const suggestOutput = successfulToolOutput(agentUpdate.toolResults, 'suggest_switch_agents');
        if (suggestOutput) {
          const suggestButtons: ActionButton[] = [];

          if (suggestOutput.primary_agent) {
            const primaryDisplay = AGENT_INFO[suggestOutput.primary_agent as AgentType]?.displayName || suggestOutput.primary_agent;
            suggestButtons.push({
              id: `hire_${suggestOutput.primary_agent}`,
              label: `Hire ${primaryDisplay}`,
              action: 'HIRE_AGENT',
              type: 'primary' as const,
              data: { agentType: suggestOutput.primary_agent },
            });
          }

          const alternativeAgents = Array.isArray(suggestOutput.alternative_agents)
            ? suggestOutput.alternative_agents.filter((agent): agent is string => typeof agent === 'string')
            : [];
          if (alternativeAgents.length) {
            for (const alt of alternativeAgents) {
              const altDisplay = AGENT_INFO[alt as AgentType]?.displayName || alt;
              suggestButtons.push({
                id: `hire_${alt}`,
                label: `Hire ${altDisplay}`,
                action: 'HIRE_AGENT',
                type: 'secondary' as const,
                data: { agentType: alt },
              });
            }
          }

          if (suggestButtons.length) {
            state.actionButtons = suggestButtons;
          }
        }
      }

      // Track intermediate responses
      for (const msg of newMessages) {
        if (msg.content?.trim()) {
          intermediateResponses.push({
            agentType: msg.agentType || agentUpdate.currentAgent || nextAgent,
            content: msg.content,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            responseId: (agentUpdate as any).lastResponseId,
            metadata: {
              ...msg.metadata,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              responseId: (agentUpdate as any).lastResponseId,
              actionButtons: agentUpdate.actionButtons,
              fitScore: agentUpdate.icpProfile?.fitScore || state.icpProfile?.fitScore,
            },
          });
        }
      }

      // ICP update notification
      if (agentUpdate.icpProfile) {
        const newFitScore = agentUpdate.icpProfile.fitScore || 0;
        emitter.emitProgressStep(userId, threadId, 'icp_update', `Updating ICP profile (${newFitScore}% complete)...`, nextAgent);
      }

      // Tool results notification
      if (agentUpdate.toolResults?.length) {
        emitter.emitProgressStep(userId, threadId, 'tool_execution', 'Processing tool results...', nextAgent);
      }

      lastAgent = nextAgent;
      if(state.intentAnalysis?.semanticRequest?.dashboardOperation==='campaign_prepare')break;

      const nextReadOnlyAgent = getNextReadOnlyTeamAgent(state, nextAgent);
      if (nextReadOnlyAgent && newMessages.some(msg => msg.content?.trim())
        && !agentUpdate.toolResults?.some(result => result.requiresApproval)
        && !agentUpdate.error && !['failed', 'cancelled', 'timed_out'].includes(agentUpdate.workflowOutcome || '')
        && state.workflowOutcome !== 'failed' && state.workflowOutcome !== 'cancelled') {
        state.nextAgent = null;
        emitTransition(userId, threadId, nextReadOnlyAgent, nextAgent, true);
        nextAgent = nextReadOnlyAgent;
        continue;
      }

      // ── Conditional edge ─────────────────────────────────────────────
      // If switch_agent set a target, go directly to that agent
      if (state.requiresApproval || state.pendingApproval) {
        state.nextAgent = null;
        nextAgent = null;
      } else if (state.nextAgent && state.nextAgent !== nextAgent) {
        emitTransition(userId, threadId, state.nextAgent, nextAgent);
        nextAgent = state.nextAgent;
        state.nextAgent = null; // consumed
      } else {
        const edgeResult = checkAfterAgent(nextAgent, state);
        if (edgeResult === 'supervisor') {
          // Advance pipeline index and reset tasksCompleted for the next agent
          if (state.agentPipeline?.length && state.agentPipelineIndex != null) {
            if (shouldAdvancePipelineIndex(state, nextAgent as AgentType)) {
              state.agentPipelineIndex = (state.agentPipelineIndex || 0) + 1;
            } else {
              logger.info({
                completedAgent: nextAgent,
                pendingPipelineAgent: state.agentPipeline[state.agentPipelineIndex || 0],
                pipelineIndex: state.agentPipelineIndex,
              }, '[Orchestrator] Preserving pipeline index after off-pipeline prerequisite');
            }
            state.tasksCompleted = false;
            logger.info({ pipelineIndex: state.agentPipelineIndex, nextPipelineAgent: state.agentPipeline[state.agentPipelineIndex] },
              '[Orchestrator] Pipeline continuation prepared — tasksCompleted reset');
          }
          nextAgent = 'supervisor';
        } else {
          nextAgent = null; // END
        }
      }
    }

    // ── Complete ───────────────────────────────────────────────────────
    if (!terminalTimedOut) {
      emitter.emitProgressStep(userId, threadId, 'complete', 'Response ready', lastAgent || 'orchestrator');
    }

    return { ...state, _intermediateResponses: intermediateResponses };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof ConversationRequestError) throw error;
    logger.error({ err: error }, '[Orchestrator] Error processing message');

    // Provider retries belong inside an individual completion. Re-running this
    // orchestration loop could repeat tools or advance an unapproved review.

    emitter.emitProgressStep(userId, threadId, 'error', toUserFacingError(error), 'orchestrator');

    return {
      ...state,
      workflowOutcome: 'failed',
      error: error.message || 'Agent execution failed.',
      messages: [
        ...state.messages,
        { role: 'assistant' as const, content: 'I encountered an error processing your request. Please try again.' },
      ],
    };
  }
}


// ── handleApproval ─────────────────────────────────────────────────────

export async function handleApproval(
  userId: number,
  threadId: number,
  approved: boolean,
  existingState: AgentState,
): Promise<AgentState> {
  const {
    handleLeadWorkflowApproval,
    handleOutreachApproval,
    handleProposalApproval,
    handleAdsApproval,
    handleGoogleAdsApproval,
    handlePublishSocialPostApproval,
  } = await import('./approvalHandlers.js');

  const pendingTool = existingState.pendingApproval?.toolName;

  let stateUpdate: Partial<AgentState>;

  switch (pendingTool) {
    case 'execute_lead_workflow':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateUpdate = await handleLeadWorkflowApproval(existingState as any, approved);
      break;
    case 'send_outreach_messages':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateUpdate = await handleOutreachApproval(existingState as any, approved);
      break;
    case 'send_proposal':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateUpdate = await handleProposalApproval(existingState as any, approved);
      break;
    case 'publish_meta_ads':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateUpdate = await handleAdsApproval(existingState as any, approved);
      break;
    case 'publish_google_ads':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateUpdate = await handleGoogleAdsApproval(existingState as any, approved);
      break;
    case 'publish_social_post':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateUpdate = await handlePublishSocialPostApproval(existingState as any, approved);
      break;
    default:
      stateUpdate = {
        messages: [{ role: 'assistant' as const, content: 'No pending action to approve.' }],
        requiresApproval: false,
        pendingApproval: null,
      };
  }

  // Normalize messages from LangChain format if needed
  const normalizedMsgs = (stateUpdate.messages || []).map(normalizeMessage);

  return {
    ...existingState,
    ...stateUpdate,
    messages: [...existingState.messages, ...normalizedMsgs],
  } as AgentState;
}

// ── switchAgent ────────────────────────────────────────────────────────

export async function switchAgent(
  userId: number,
  threadId: number,
  targetAgent: AgentType,
  existingState: AgentState,
): Promise<AgentState> {
  // Find last user context
  let lastUserContext = '';
  for (let i = existingState.messages.length - 1; i >= 0; i--) {
    const msg = existingState.messages[i];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const role = msg.role ?? ((msg as any)._getType?.() === 'human' ? 'user' : 'assistant');
    if (role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!content.toLowerCase().startsWith('switch to ') && content.length > 3) {
        lastUserContext = content;
        break;
      }
    }
  }

  const switchMessage = lastUserContext
    ? `Switch to ${targetAgent} agent. User's request context: "${lastUserContext}"`
    : `Switch to ${targetAgent} agent`;

  const normalizedMessages = existingState.messages.map(normalizeMessage);

  try {
    const result = await processMessage(userId, threadId, switchMessage, {
      ...existingState,
      messages: normalizedMessages,
      nextAgent: targetAgent,
      currentAgent: existingState.currentAgent,
    }, { switchTarget: targetAgent });
    return result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof ConversationRequestError) throw error;
    logger.error({ err: error }, '[Orchestrator] Error switching agent');
    return {
      ...existingState,
      error: error.message || 'Agent switch failed',
      workflowOutcome: 'failed',
      messages: [
        ...normalizedMessages,
        { role: 'assistant' as const, content: `I couldn't hand this to ${getDisplayName(targetAgent)}: ${userFacingReason(error)}.` },
      ],
    } as AgentState;
  }
}

// ── getConversationState ───────────────────────────────────────────────
// No PostgresSaver checkpointer — state is loaded from DB by chatController

export async function getConversationState(
  _threadId: number,
  _userId: number,
): Promise<AgentState | null> {
  return null;
}

// ── Cleanup (no-op — no checkpointer pool) ─────────────────────────────

export async function cleanup(): Promise<void> {
  // Nothing to clean up — no connection pool
}

// Re-export types
export type { AgentState, AgentType };
