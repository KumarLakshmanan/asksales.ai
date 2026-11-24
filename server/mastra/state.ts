/**
 * Mastra Agent State
 * Same shape as LangGraph AgentState but with plain Message objects instead of BaseMessage.
 * All interfaces are defined inline — no dependency on langgraph/.
 */

import { AGENT_PERSONAS } from './agentPersonas.js';
import { randomUUID } from 'crypto';

// ── Shared type definitions ────────────────────────────────────

export interface ICPProfile {
  id?: number;
  campaignName?: string;
  campaignObjective?: string;
  targetAudience?: string;
  targetBusinessModel?: string;
  industry?: string;
  subIndustry?: string;
  primaryRegions?: string[];
  primaryJobTitles?: string[];
  targetCompanySizeRange?: string;
  targetRevenueRange?: string;
  companyGrowthStage?: string;
  primaryValueProposition?: string;
  primaryPainPoint?: string;
  primaryChannels?: string[];
  fitScore?: number;
  summary?: string;
  recommendedAgentScores?: Record<string, number>;
  businessId?: number;
  businessName?: string;
  businessIndustry?: string;
  businessDescription?: string;
  approved?: boolean;
  approvedBy?: number;
  approvedAt?: Date | string;
  revision?: number;
  approvedRevision?: number;
}

export interface ToolResult {
  success: boolean;
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output?: any;
  error?: string;
  requiresApproval?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  approvalData?: any;
  executionId?: string;
  durationMs?: number;
}

export interface ActionButton {
  id: string;
  label: string;
  action: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
  type?: 'primary' | 'secondary' | 'danger';
}

export interface BrandToolkit {
  id: number;
  name: string;
  primaryBrandColor?: string;
  secondaryBrandColor?: string;
  fontFamily?: string;
  voiceType?: string;
  brandValues?: string[];
  defaultCtas?: string[];
  defaultHashtags?: string[];
}

export interface CompanyProfile {
  id: number;
  companyName: string;
  workspaceType?: string;
  timezone?: string;
  applicationUses?: string[];
  setupGoal?: string;
  currentTools?: string;
  industry?: string;
  website?: string;
  description?: string;
  employees?: string;
  companySize?: string;
  primaryMarket?: string;
  targetRegions?: string[];
  customerType?: string;
  keyBuyerRoles?: string[];
  businessGoals?: string[];
  preferredChannels?: string[];
  brandTone?: string;
  platforms?: string[];
  userName?: string;
  userEmail?: string;
}

export interface LeadInput {
  platform: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputs: Record<string, any>;
  actorId?: string;
  actorName?: string;
  category?: string;
}

export type LeadInputs = LeadInput[];

export interface PendingApproval {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  executionId: string;
  message: string;
  toolCallId?: string;
  /**
   * Phase 7.11 / MASTRA-002: timestamp (ms since epoch) when this
   * approval was first requested. The reaper in `approvalHandlers.ts`
   * uses this with `APPROVAL_TIMEOUT_MS` to decide when to escalate.
   * Optional for backward compat with approvals persisted before
   * the field existed — those default to "never expires" and the
   * reaper skips them.
   */
  createdAt?: number;
}

export interface LLMConfig {
  apiKey: string;
  modelName: string;
  provider: 'openai' | 'openrouter' | 'custom_ai' | 'gemini' | 'vertex_ai';
  baseURL?: string;
}

export interface RunContext {
  userId: number;
  threadId: number;
  runId: string;
  turnId?: string;
  actionId?: string;
  idempotencyKey?: string;
}

// Phase 9.5: re-exported from `server/shared/agents/state.ts` so the
// `tabConfig.ts` there can use the type without depending on either
// runtime. The local definition was identical.
import { AgentType } from '../shared/agents/state.js';
export type { AgentType };
export { AGENT_TYPES } from '../shared/agents/state.js';

export const AGENT_INFO: Record<AgentType, {
  displayName: string;
  description: string;
  color: string;
  avatar?: string;
  requiredIcpScore: number;
}> = Object.fromEntries(
  Object.entries(AGENT_PERSONAS).map(([key, p]) => [
    key,
    {
      displayName: p.displayName,
      description: p.description,
      color: p.color,
      avatar: p.avatar,
      requiredIcpScore: p.requiredIcpScore,
    },
  ]),
) as Record<AgentType, { displayName: string; description: string; color: string; avatar?: string; requiredIcpScore: number }>;

// ── Message & AgentState ───────────────────────────────────────

/**
 * Plain message type replacing LangChain BaseMessage.
 * Compatible with LLMProvider.createChatCompletion() messages format.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  agentType?: string;
  name?: string;
  tool_call_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Agent State interface — same fields as LangGraph AgentState,
 * but messages are plain objects instead of BaseMessage.
 */
export interface AgentState {
  messages: Message[];
  userId: number;
  threadId: number;
  workflowId: string;
  /** Correlation identity for this isolated orchestration run. */
  runContext?: RunContext;
  selectedWorkflows: string[];
  currentAgent: AgentType;
  nextAgent: AgentType | null;
  icpProfile: ICPProfile | null;
  brandToolkit: BrandToolkit | null;
  companyProfile: CompanyProfile | null;
  leadInputs: LeadInput[];
  /** Exact, user-selected recipients for the next outreach action. */
  selectedLeadIds?: number[];
  toolResults: ToolResult[];
  actionButtons: ActionButton[];
  requiresApproval: boolean;
  pendingApproval: PendingApproval | null;
  finalResponse: string;
  transitionReason: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openTab: { tabType: string; tabLabel?: string; data?: any } | null;
  error: string | null;
  iteration: number;
  maxIterations: number;
  isComplete: boolean;
  lastResponseId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractedIcpData?: Record<string, any> | null;
  llmConfig: LLMConfig | null;
  leadWorkflowExecuted?: boolean;
  /** True only after the user explicitly approves the generated lead set. */
  leadReviewApproved?: boolean;
  agentPipeline?: AgentType[];
  /** Full pipeline retained while outreach is hidden pending reviewed-lead approval. */
  deferredLeadReviewPipeline?: AgentType[];
  agentPipelineIndex?: number;
  /** Original user instruction that every automatic pipeline handoff must continue. */
  pipelineRequest?: string;
  /** Internal-only, one-use routing hint after durable ICP approval. */
  icpApprovalContinuation?: { agent: AgentType; icpId: number; revision: number };
  /** Trusted, in-memory result of a server-executed widget action used to resume a paused specialist. */
  widgetContinuation?: {
    widgetId: number;
    toolName: string;
    success: boolean;
    /** Execution receipt re-read from the owned durable widget, never callback prose. */
    executionResult?: unknown;
    /** Reviewed inputs for successful sibling actions of this tool/run. */
    completedToolInputs?: Record<string, unknown>[];
  };
  tasksCompleted?: boolean;
  agentStartedAt?: number;
  scratchpad?: Record<string, string[]>;
  contextSummary?: string;
  pendingClarification?: import('./conversationClarification.js').ConversationClarification;
  /** Read-only durable action facts, not execution receipts or authorization. */
  savedToolActions?: Array<{
    widgetId: number;
    toolName: string;
    agentType: string | null;
    status: string;
    runId: string | null;
    formValues: Record<string, unknown>;
    submittedValues?: Record<string, unknown> | null;
    userId?: number;
    threadId?: number;
    executionResult?: unknown;
  }>;
  /** Transient: a specialist has consumed this turn's routing decision. */
  routingDecisionConsumed?: boolean;
  /** Current-turn semantic routing result. Never persisted as execution authorization. */
  intentAnalysis?: import('./routerSchema.js').RouterOutput;
  workflowOutcome?: 'awaiting_input' | 'awaiting_approval' | 'running' | 'queued' | 'partial_success' | 'succeeded' | 'succeeded_empty' | 'failed' | 'cancelled' | 'gated' | 'timed_out';
}

/**
 * Create a fresh initial state
 */
export function createInitialState(userId: number, threadId: number): AgentState {
  return {
    messages: [],
    userId,
    threadId,
    workflowId: '',
    runContext: { userId, threadId, runId: randomUUID() },
    selectedWorkflows: [],
    currentAgent: 'orchestrator',
    nextAgent: null,
    icpProfile: null,
    brandToolkit: null,
    companyProfile: null,
    leadInputs: [],
    selectedLeadIds: [],
    toolResults: [],
    actionButtons: [],
    requiresApproval: false,
    pendingApproval: null,
    finalResponse: '',
    transitionReason: '',
    openTab: null,
    error: null,
    iteration: 0,
    maxIterations: 5,
    isComplete: false,
    lastResponseId: null,
    extractedIcpData: null,
    llmConfig: null,
    leadWorkflowExecuted: false,
    leadReviewApproved: false,
    agentPipeline: [],
    deferredLeadReviewPipeline: [],
    agentPipelineIndex: 0,
    pipelineRequest: '',
    tasksCompleted: false,
    scratchpad: {},
    contextSummary: '',
  };
}

/**
 * Normalise any message-like object (including LangChain BaseMessage) into a plain Message.
 * Uses duck typing — no @langchain imports required.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeMessage(msg: any): Message {
  // Already a plain Message
  if (msg && typeof msg === 'object' && typeof msg.role === 'string' && typeof msg.content === 'string' && !msg._getType) {
    return msg as Message;
  }
  // LangChain BaseMessage (duck-typed via _getType)
  if (msg && typeof msg._getType === 'function') {
    const lcType = msg._getType();
    const role: Message['role'] =
      lcType === 'human' ? 'user' :
      lcType === 'ai' ? 'assistant' :
      lcType === 'system' ? 'system' :
      lcType === 'tool' ? 'tool' : 'assistant';
    return {
      role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      ...(msg.name ? { name: msg.name } : {}),
    };
  }
  // Fallback
  return {
    role: (msg?.role as Message['role']) || 'assistant',
    content: typeof msg?.content === 'string' ? msg.content : String(msg?.content ?? ''),
  };
}

/**
 * Helper to add a user message
 */
export function addUserMessage(state: AgentState, content: string): AgentState {
  return {
    ...state,
    messages: [...state.messages, { role: 'user' as const, content }],
  };
}

/**
 * Helper to add an assistant message
 */
export function addAssistantMessage(state: AgentState, content: string, agentType?: string): AgentState {
  return {
    ...state,
    messages: [...state.messages, { role: 'assistant' as const, content, agentType }],
  };
}
