/**
 * BaseOutreachAgent.ts
 *
 * Shared interfaces and abstract base for all outreach agents.
 * Every typed agent (HotelSalesAgent, TechSupportAgent, etc.) implements
 * the `handle(input)` method and returns an `AgentResult`.
 *
 * The AgentRouter calls `handle()` and then runs post-processing based
 * on the returned `AgentResult` signals (CRM pipeline, reminders, alerts).
 */

import type { AgentConfigLike } from '../../utils/agentPromptBuilder.js';
import type { NLUResult } from './NLUService.js';
import type { CrmStageDecision } from '../../../shared/crmPipeline.js';
import { subAgentRegistry } from './subagents/index.js';
import type { SubAgentContext, SubAgentResult } from './subagents/index.js';
import {
  isToolExposed,
  OWNER_ADVISORY_READ_SUPPORT_TOOLS,
  safeToolExecutor,
  supportToolScopeError,
} from './orchestration/SafeToolExecutor.js';
import type { GroundedKnowledgeSource } from '../KnowledgeBaseService.js';
import { supportAgentRuntime } from './orchestration/SupportAgentRuntime.js';
import type {
  ClaimEvidence,
  KnowledgeContextLanes,
  KnowledgeRetrievalResult,
  VerifiedKnowledgeAnswer,
} from '../knowledge/types.js';
import type { SupportMediaDecision } from '../supportMedia/types.js';
import type { SupportChoiceManifest } from '../../models/supportOrchestration/schema.js';
import type { VerifiedSupportMedia } from '../supportMedia/types.js';

// ── Agent Input ────────────────────────────────────────────────────────

export interface AgentInput {
  /** Authenticated widget capability; never include in model messages. */
  widgetSession?: { id: number; token: string };
  userId: number;
  conversationId: number;
  channel: string;                        // 'whatsapp' | 'instagram' | 'facebook' | 'email'
  phoneNumberId: string | null;           // WhatsApp phone number ID (null for social/email)
  inboundText: string;                    // The customer's latest message
  /** Canonical inbound event identity. Provider replays keep the same value;
   * a genuinely new customer message receives a new value. */
  rawMessageId?: string | null;
  messageId?: number | null;
  leadId?: number | null;
  leadName?: string | null;
  leadCompany?: string | null;
  recipientPhone?: string | null;         // WhatsApp phone / IGSID / PSID / email address
  /** Server-only identifiers for authorized DB/tool adapters; never interpolate
   * this object into prompts, logs, traces, or model-visible context. */
  operationalIdentity?: {
    leadName?: string | null;
    leadCompany?: string | null;
    recipientPhone?: string | null;
  };
  sentiment?: {
    sentiment: string;
    score: number;
    keywords: string[];
  };
  /** Shared classification computed once by the canonical runtime. */
  nlu?: NLUResult;
  /** Shared grounded context computed once; agents must not retrieve it again when present. */
  kbContext?: string[];
  /** Typed, isolated context lanes. Only `knowledge` contributes to KB grounding. */
  contextLanes?: KnowledgeContextLanes;
  historyUnavailable?: boolean;
  businessProfileId?: number | null;
  /** Redacted, bounded history supplied by the invoking surface. */
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Platform-owned output contract for preview/advisory surfaces. */
  platformInstructions?: string;
  /** Deterministic instruction emitted by the active published playbook node. */
  playbookDirective?: {
    playbookId: number;
    version: number;
    runId: number;
    nodeId: string;
    nodeType: string;
    instruction?: string;
    requiredAction?: string;
    actionArgs?: Record<string, unknown>;
    capability?: {
      name: string;
      kind: 'tool' | 'effect' | 'context' | 'handoff';
      args: Record<string, unknown>;
      effectType?: string;
      validationErrors?: string[];
    };
    journey?: {
      schemaVersion: 2;
      fields: Record<string, { value?: unknown; status: string; source: string; vaultRef?: number }>;
      missingFields: string[];
    };
  } | null;
  /** The DB agent config record (loaded by AgentRouter before dispatch). */
  agentConfig?: AgentConfigLike | null;
  /** Optional flag indicating this is a test support chat session rather than a real outreach channel. */
  isSupportChat?: boolean;
  /** True for the owner simulator; all external and persistent side effects are suppressed. */
  dryRun?: boolean;
  executionMode?: 'customer' | 'preview' | 'advisory';
}

// ── Agent Result ───────────────────────────────────────────────────────

export type SupportGroundingStatus = 'grounded' | 'insufficient_knowledge' | 'retrieval_unavailable'
  | 'conflict_detected' | 'stale_only' | 'access_denied' | 'not_required';

export type ToolOutcomeStatus =
  | 'success'
  | 'failed'
  | 'pending_approval'
  | 'suppressed'
  | 'requires_reconciliation';

export interface ToolOutcome {
  name: string;
  toolCallId?: string;
  durationMs?: number;
  args: Record<string, unknown>;
  result: unknown;
  status: ToolOutcomeStatus;
  success: boolean;
  code?: string;
  /** True only when the returned payload proves that a write completed. */
  confirmedSideEffect: boolean;
  reconciliationStatus?: 'not_required' | 'pending' | 'confirmed' | 'failed';
}

export interface SupportEffectProposal {
  type: 'crm_update' | 'lead_identity' | 'lead_score' | 'lead_memory' | 'conversation_state' | 'support_ticket' | 'reminder' | 'sequence' | 'handoff' | 'inquiry' | 'callback' | 'notification' | 'booking' | 'external_booking_referral';
  payload: Record<string, unknown>;
  requiresApproval?: boolean;
  idempotencyKey?: string;
}

export interface ExternalBookingHandoff {
  mode: 'external_booking';
  stage?: 'search' | 'checkout';
  propertyId?: number;
  roomTypeId?: number;
  checkIn: string;
  checkOut: string;
  guests: number;
  adults?: number;
  children?: number;
  rooms: number;
  stayType?: 'overnight' | 'dayuse';
  url: string;
  title: string;
  customerConfirmed: boolean;
}

export interface SupportAgentDecision {
  replyText: string;
  intent?: string;
  outcome?: string;
  confidence?: number;
  confidenceReason?: string;
  groundingStatus?: SupportGroundingStatus;
  citations?: GroundedKnowledgeSource[];
  knowledgeResult?: KnowledgeRetrievalResult;
  claimEvidence?: ClaimEvidence[];
  answerVerification?: VerifiedKnowledgeAnswer;
  /** Separate visual-evidence lane. Media never contributes to textual grounding. */
  mediaDecision?: SupportMediaDecision;
  toolCallsExecuted?: ToolOutcome[];
  effectProposals?: SupportEffectProposal[];
  /** Deterministically validated external checkout handoff. The delivery layer owns URL rendering. */
  externalBookingHandoff?: ExternalBookingHandoff;
  handoff?: {
    required: boolean;
    type?: 'sales' | 'support';
    reason?: string;
  };
  followUp?: {
    eligible: boolean;
    consent: 'granted' | 'denied' | 'unknown';
    cooldownUntil?: Date;
  };
}

export interface AgentResult extends SupportAgentDecision {
  /** Server-validated NLU decision carried through deferred delivery commits. */
  crmStageDecision?: CrmStageDecision;
  /** Server-built shared-pipeline sentiment; async channels must reuse it. */
  classifiedSentiment?: { sentiment: string; score: number; keywords: string[] };
  /** Server-owned withdrawal receipt; permits only its static acknowledgement. */
  optOutApplied?: boolean;
  /** Fixed acknowledgement of a server-verified decline; never a sentiment substitution. */
  handoffDeclineAcknowledged?: boolean;
  /** The reply text to send back to the customer. */
  replyText: string;
  /** Server-built owner-approved choices for deferred web/email renderers. */
  choiceManifest?: SupportChoiceManifest;
  /** Whether the conversation was escalated to a human. */
  escalated: boolean;
  escalationReason?: string;
  escalationType?: 'sales' | 'support';
  /** NLU intent detected (for analytics). */
  intent?: string;
  /**
   * Specialist stage hint; resolved against the saved configuration and
   * validated customer/tool evidence at commit. Then contains the actual key.
   */
  crmPipelineStatus?: string;
  /**
   * If set, the AgentRouter will create an activity reminder via
   * ReminderService.createActivityReminder().
   */
  scheduleReminder?: {
    dueAt: Date;
    title: string;
    description: string;
    reminderType: string;         // 'followup' | 'custom' | etc.
  };
  confidence?: number;
  kbSourcesUsed?: GroundedKnowledgeSource[];
  /** Canonical runtime outcome metadata used by async channels such as email. */
  deliveryOutcome?: 'auto_sent' | 'drafted' | 'ready_for_channel_delivery' | 'pending_approval' | 'human_handoff' | 'blocked' | 'no_op' | 'error';
  approvalRequired?: boolean;
  /** Internal, PII-free context used to commit deferred-channel effects. */
  deferredEffectContext?: {
    assistantProvenance?: import('../../../shared/outreachAssistants.js').AssistantProvenance;
    userId: number;
    conversationId: number;
    channel: string;
    leadId?: number | null;
    rawMessageId?: string | null;
    messageId?: number | null;
    sentiment?: { sentiment: string; score: number; keywords: string[] };
    playbookRunId?: number | null;
    playbookCapabilityName?: string | null;
    playbookCapabilityKind?: string | null;
    playbookRequiredAction?: string | null;
    /** True only for a server-validated, explicit callback-consent refusal. */
    callbackDeclined?: boolean;
    auditLogId?: number | null;
    /** Preserves the canonical pipeline's ownership boundary until the
     * deferred channel acknowledges delivery. */
    suppressBusinessEffects?: boolean;
  };
  generationMetadata?: {
    provider: string;
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Server-only authorized media manifest; URLs and storage keys are never model-visible. */
  verifiedMedia?: VerifiedSupportMedia[];
  approvedDocument?: import('../supportDocuments/ApprovedSupportDocuments.js').ApprovedSupportDocument;
  widgetDocumentReceipt?: { sessionId: number; messageId: number; documentId: number };
  provenance?: Record<string, unknown>;
  mediaDeliveryAssertionRequired?: boolean;
  mediaDeliverySucceeded?: boolean;
}

// ── Abstract Base ──────────────────────────────────────────────────────

export abstract class BaseOutreachAgent {
  /** Human-readable name for logging. */
  abstract readonly agentName: string;

  /** Sub-agents composed by this main agent. */
  protected subAgentIds: string[] = [];

  /**
   * Process an inbound message and return an AI-generated reply plus
   * any post-processing signals (CRM stage, reminders, sequences).
   */
  abstract handle(input: AgentInput): Promise<AgentResult>;

  /**
   * Default fallback reply when the agent can't generate a response.
   */
  protected fallbackReply(): string {
    return "Thanks for reaching out! We've received your message and will get back to you shortly.";
  }

  /**
   * Get tool definitions from all composed sub-agents.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected getComposedTools(agentConfig?: AgentConfigLike | null): any[] {
    return subAgentRegistry.getToolsForSubAgents([...this.subAgentIds, 'chat_history'])
      .filter((tool) => isToolExposed(tool.function?.name || '', agentConfig?.toolsEnabled));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected toolsForInput(input: AgentInput): any[] {
    const tools = this.getComposedTools(input.agentConfig);
    if (input.historyUnavailable) return [];
    if (input.executionMode === 'advisory') {
      if (!input.isSupportChat) return [];
      return tools.filter((tool) => OWNER_ADVISORY_READ_SUPPORT_TOOLS.has(tool.function?.name || '')
        && !supportToolScopeError(tool.function?.name || '', input.playbookDirective, input.agentConfig?.agentType));
    }
    return tools.filter((tool) => !supportToolScopeError(tool.function?.name || '', input.playbookDirective, input.agentConfig?.agentType));
  }

  /** A published capability is executed at most once per agent decision. After
   * its governed tool outcome is present, generation continues without tools
   * so a forced tool choice cannot repeat the same business operation. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected toolsForGenerationTurn(input: AgentInput, tools: any[], executedCount: number): any[] {
    return input.playbookDirective?.requiredAction && executedCount > 0 ? [] : tools;
  }

  /** Execute published actions without depending on a provider honoring tool_choice. */
  protected requiredToolResponse(input: AgentInput, tools: any[], executedCount: number): any | null {
    const name = input.playbookDirective?.requiredAction;
    if (!name || executedCount || !tools.some(tool => tool.function?.name === name)) return null;
    return { success: true, content: '', completion: { choices: [{ message: {
      role: 'assistant', content: null, tool_calls: [{ id: `required_${input.playbookDirective!.nodeId}`, type: 'function',
        function: { name, arguments: JSON.stringify(input.playbookDirective?.actionArgs || {}) } }],
    } }] } };
  }

  /**
   * Dispatch a tool call to the appropriate composed sub-agent.
   */
  protected async dispatchToSubAgent(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any,
    ctx: SubAgentContext,
    offeredToolNames?: readonly string[],
  ): Promise<SubAgentResult> {
    if (offeredToolNames && !offeredToolNames.includes(toolName)) {
      return {
        escalated: true, escalationType: 'support', escalationReason: 'The model requested a tool outside this generation turn.',
        toolResults: [{ name: toolName, result: { success: false, code: 'tool_not_offered_current_turn', wouldExecute: false } }],
      };
    }
    const supplied = args && typeof args === 'object' ? args : {};
    if (ctx.playbookDirective?.requiredAction === toolName && ctx.playbookDirective.actionArgs) {
      // A published playbook binding is the complete trusted argument set for
      // its required action. Discard model-supplied extras, then mutate the
      // caller's plain parsed object so the audit records exactly what the
      // executor received rather than the model's attempted arguments.
      for (const key of Object.keys(supplied)) delete supplied[key];
      Object.assign(supplied, ctx.playbookDirective.actionArgs);
    }
    const effectiveArgs = supplied;
    return safeToolExecutor.execute(
      toolName,
      effectiveArgs,
      ctx,
      () => subAgentRegistry.dispatch(toolName, effectiveArgs, ctx, [...this.subAgentIds, 'chat_history']),
    );
  }

  protected recordToolOutcome(
    toolName: string,
    args: Record<string, unknown>,
    result: SubAgentResult,
  ): ToolOutcome {
    return supportAgentRuntime.recordToolOutcome(toolName, args, result);
  }
}
