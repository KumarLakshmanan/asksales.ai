import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { ToolApprovalModel } from '../../../models/toolApprovals/functions.js';
import { supportToolExecutionsTable } from '../../../models/supportOrchestration/schema.js';
import { toolApprovalsTable } from '../../../models/toolApprovals/schema.js';
import type { SubAgentContext, SubAgentResult } from '../subagents/SubAgentBase.js';
import {
  encryptRestrictedPayload,
  redactPiiWithStableTokens,
  restrictedBindingDigest,
  MODEL_SECRET_KEY,
} from './PrivacyVaultService.js';
import { withPromiseTimeout } from '../../../utils/promiseTimeout.js';
import { validateSupportToolArgs } from './SupportToolSchemas.js';
import { isSupportCapability, SUPPORT_CAPABILITIES } from './SupportCapabilityRegistry.js';
import { supportAgentRuntime } from './SupportAgentRuntime.js';
import { redactKnowledgeText } from '../../knowledge/KnowledgePrivacyService.js';
import { assertSupportTurnFresh, sealSupportTurn } from './SupportConversationTurn.js';
import { currentAssistant } from '../../assistants/AssistantContext.js';
import { assertAssistantFresh } from '../../assistants/AssistantFreshness.js';
import { canonicalJson } from '../../../utils/canonicalJson.js';

export type ToolRisk = 'read' | 'write' | 'high';
type RecoveryAction = 'wait' | 'retry' | 'reconcile';
const MAX_AUTOMATIC_READ_ATTEMPTS = 3;
const STUCK_EXECUTION_MS = 2 * 60 * 1000;

export const READ_SUPPORT_TOOLS = new Set([
  'get_customer_chat_history',
  'answer_from_knowledge_base',
  'check_payment_status',
  'check_room_availability',
  'get_hotel_info',
  'get_payment_methods',
  'get_ticket_status',
  'get_conversation_proposals',
]);

/** Read-only tools that are safe to run in the authenticated owner simulator.
 * Keep this narrower than READ_SUPPORT_TOOLS: status and proposal lookups may
 * expose customer-specific records, while these tools only return published
 * knowledge or the workspace's public hotel catalogue/availability. */
export const OWNER_ADVISORY_READ_SUPPORT_TOOLS = new Set([
  'answer_from_knowledge_base',
  'check_room_availability',
  'get_hotel_info',
  'get_payment_methods',
]);

export const HIGH_RISK_SUPPORT_TOOLS = new Set([
  'create_booking',
  'send_payment_link',
  'resolve_complaint',
  'quote_or_negotiate_price',
]);

export const SUPPORT_TOOL_NAMES = new Set([
  ...READ_SUPPORT_TOOLS,
  ...HIGH_RISK_SUPPORT_TOOLS,
  'handle_objection',
  'escalate_to_human',
  'create_support_ticket',
  'qualify_lead',
  'update_lead_score',
  'continue_external_booking',
  'save_booking_details',
  'create_conversation_proposal_draft',
  'request_proposal_revision',
]);

export function isToolExposed(toolName: string, configuredTools: unknown): boolean {
  return SUPPORT_TOOL_NAMES.has(toolName)
    && Array.isArray(configuredTools)
    && configuredTools.includes(toolName);
}

/** The model's offered schema is not an execution authorization. Recheck the
 * current server-owned playbook scope at the last boundary before any effect. */
export function supportToolScopeError(toolName: string, directive: unknown, agentType?: unknown): string | null {
  if (directive === null || directive === undefined) return null; // Established unscoped agent allowlist.
  if (!directive || typeof directive !== 'object' || Array.isArray(directive)) return 'invalid_tool_scope';
  const scope = directive as Record<string, unknown>;
  if (typeof scope.nodeType !== 'string'
    || !['action', 'capability', 'collect', 'message', 'question', 'condition', 'trigger', 'knowledge', 'media', 'handoff', 'escalation', 'complete'].includes(scope.nodeType)) return 'invalid_tool_scope';
  const required = scope.requiredAction;
  if (required !== undefined && (typeof required !== 'string' || !SUPPORT_TOOL_NAMES.has(required))) return 'invalid_tool_scope';
  if (required && !['action', 'capability'].includes(scope.nodeType)) return 'invalid_tool_scope';
  if (scope.capability !== undefined) {
    if (!scope.capability || typeof scope.capability !== 'object' || Array.isArray(scope.capability)) return 'invalid_tool_scope';
    const capability = scope.capability as Record<string, unknown>;
    if (!isSupportCapability(capability.name)) return 'invalid_tool_scope';
    const definition = SUPPORT_CAPABILITIES[capability.name];
    if (capability.kind !== definition.kind
      || (capability.validationErrors !== undefined && (!Array.isArray(capability.validationErrors) || capability.validationErrors.length > 0))
      || (definition.allowedAgentTypes && !definition.allowedAgentTypes.includes(String(agentType || '')))) return 'invalid_tool_scope';
    if (definition.kind !== 'tool') return 'tool_outside_current_capability';
    if (required !== definition.toolName) return 'invalid_tool_scope';
  } else if (scope.nodeType === 'capability') return 'invalid_tool_scope';
  if (required) return toolName === required ? null : 'tool_outside_current_capability';
  if (toolName === 'get_customer_chat_history') return null;
  // Published knowledge interruptions are a separate read-only decision. No
  // booking/helper write gains authority merely because the agent owns it.
  if (scope.nodeType === 'knowledge' && toolName === 'answer_from_knowledge_base') return null;
  return ['collect', 'message', 'question', 'condition', 'trigger', 'knowledge', 'media', 'handoff', 'escalation', 'complete'].includes(String(scope.nodeType))
    ? 'tool_outside_current_capability' : 'invalid_tool_scope';
}

export function supportToolRisk(toolName: string): ToolRisk {
  if (READ_SUPPORT_TOOLS.has(toolName)) return 'read';
  if (HIGH_RISK_SUPPORT_TOOLS.has(toolName)) return 'high';
  return 'write';
}

export function isHighRiskSupportTool(toolName: string): boolean {
  return supportToolRisk(toolName) === 'high';
}

function subAgentResultSucceeded(result: SubAgentResult): boolean {
  const name = result.toolResults?.[0]?.name || '';
  return supportAgentRuntime.recordToolOutcome(name, {}, result).success;
}

export function decideToolRecovery(
  execution: {
    status: string;
    riskLevel: string;
    attemptCount?: number | null;
    lastAttemptAt?: Date | string | null;
    startedAt?: Date | string | null;
    reconciliationStatus?: string | null;
  },
  now = new Date(),
): RecoveryAction {
  if (execution.reconciliationStatus === 'confirmed_not_executed') return 'retry';
  const attemptCount = Math.max(1, Number(execution.attemptCount || 1));
  const lastAttempt = new Date(execution.lastAttemptAt || execution.startedAt || 0).getTime();
  const stale = !Number.isFinite(lastAttempt) || now.getTime() - lastAttempt >= STUCK_EXECUTION_MS;
  if (execution.status === 'running' && !stale) return 'wait';
  if (execution.riskLevel === 'read' && attemptCount < MAX_AUTOMATIC_READ_ATTEMPTS) return 'retry';
  return 'reconcile';
}

const DIRECT_IDENTIFIER_FIELD_PATTERN = /(?:^|_)(?:email|phone|mobile|full_?name|first_?name|last_?name|guest_?name|customer_?name|lead_?name|contact_?name|person_?name|sender_?name|recipient_?name|address)(?:$|_)/i;
const NON_PERSON_NAME_CONTAINER = /^(?:tools?|tool_results?|options?|rooms?|room_types?|products?|galleries?|assets?|media|hotels?|properties?|services?)$/i;

export function sanitizeSupportToolData(value: unknown, key = '', parentKey = ''): unknown {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (value !== null && value !== undefined && MODEL_SECRET_KEY.test(normalizedKey)) return '[REDACTED_SECRET]';
  if (typeof value === 'string') {
    const normalizedParent = parentKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (DIRECT_IDENTIFIER_FIELD_PATTERN.test(normalizedKey)
      || (normalizedKey === 'name' && !NON_PERSON_NAME_CONTAINER.test(normalizedParent))) return '[REDACTED_PII]';
    return redactPiiWithStableTokens(value).redactedText;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeSupportToolData(item, key, parentKey));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, sanitizeSupportToolData(child, childKey, key)]));
  }
  return value;
}

export function sanitizeSupportToolResult(toolName: string, result: SubAgentResult): SubAgentResult {
  const sanitized = sanitizeSupportToolData(result) as SubAgentResult;
  // This adapter reads only the tenant's public property catalog. Preserve its
  // explicit business fields; never exempt arbitrary customer/tool strings.
  if (toolName === 'get_hotel_info') {
    const raw = result.toolResults?.find(item => item.name === toolName)?.result;
    const safe = sanitized.toolResults?.find(item => item.name === toolName)?.result;
    if (raw?.success === true && safe) for (const key of ['name', 'phone', 'email', 'address', 'city']) {
      if (typeof raw[key] === 'string') safe[key] = raw[key];
    }
  }
  if (toolName === 'answer_from_knowledge_base') {
    const raw = result.toolResults?.find(item => item.name === toolName)?.result;
    const safe = sanitized.toolResults?.find(item => item.name === toolName)?.result;
    if (raw?.success === true && safe && Array.isArray(raw.sources)) {
      const sources = raw.sources as Array<{ excerpt?: string; verifiedBusinessContacts?: string[] }>;
      const contacts = sources.flatMap(source => (source.verifiedBusinessContacts || [])
        .filter(value => typeof value === 'string' && source.excerpt?.includes(value)));
      if (typeof raw.knowledge === 'string') safe.knowledge = redactKnowledgeText(raw.knowledge, contacts);
      if (Array.isArray(safe.sources)) (safe.sources as Array<Record<string, unknown>>).forEach((source, index) => {
        if (typeof sources[index]?.excerpt === 'string') source.excerpt = redactKnowledgeText(sources[index].excerpt!, contacts);
      });
    }
  }
  return sanitized;
}

export function supportToolArgumentDigest(userId: number, args: unknown): string {
  return restrictedBindingDigest(userId, 'support-tool-arguments', canonicalJson(args));
}

export function supportToolIdempotencyKey(toolName: string, args: unknown, ctx: SubAgentContext): string {
  const playbook = ctx.playbookDirective
    ? `${ctx.playbookDirective.runId}:${ctx.playbookDirective.nodeId}`
    : 'no-playbook';
  const inboundEvent = ctx.rawMessageId
    || (ctx.messageId ? `message:${ctx.messageId}` : null)
    || `legacy-text:${ctx.inboundText}`;
  const stable = canonicalJson({
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    toolName,
    args,
    inboundEvent,
    playbook,
    ...(currentAssistant() ? { assistant: currentAssistant()!.provenance } : {}),
  });
  return `support-tool:${restrictedBindingDigest(ctx.userId, 'support-tool-idempotency', stable)}`;
}

export class SafeToolExecutor {
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: SubAgentContext,
    executor: () => Promise<SubAgentResult>,
  ): Promise<SubAgentResult> {
    await assertAssistantFresh();
    const assistant = currentAssistant();
    const scopeError = supportToolScopeError(toolName, ctx.playbookDirective, ctx.agentConfig?.agentType);
    if (scopeError) {
      return {
        escalated: true, escalationType: 'support', escalationReason: 'The attempted tool is not authorized by the current support decision.',
        toolResults: [{ name: toolName, result: { success: false, code: scopeError, wouldExecute: false } }],
      };
    }
    const configuredTools = assistant ? assistant.configuration.tools.names : Array.isArray(ctx.agentConfig?.toolsEnabled) ? ctx.agentConfig.toolsEnabled : [];
    if (!isToolExposed(toolName, configuredTools)) {
      return {
        escalated: true, escalationType: 'support', escalationReason: 'The attempted tool is not enabled for this agent.',
        toolResults: [{ name: toolName, result: { success: false, code: 'tool_not_enabled', wouldExecute: false } }],
      };
    }
    const risk = assistant?.configuration.tools.approvalRequired.includes(toolName) ? 'high' : supportToolRisk(toolName);
    const validated = validateSupportToolArgs(toolName, args);
    if (!validated.success) {
      return {
        escalated: risk === 'high',
        escalationType: risk === 'high' ? 'support' : undefined,
        escalationReason: risk === 'high' ? `Invalid arguments for high-risk tool ${toolName}.` : undefined,
        toolResults: [{ name: toolName, result: { success: false, code: 'invalid_tool_arguments', error: validated.error } }],
      };
    }
    args = validated.data;
    const nonCustomerExecution = ctx.dryRun || (ctx.executionMode && ctx.executionMode !== 'customer');
    const authenticatedOwnerRead = ['advisory', 'preview'].includes(ctx.executionMode || '')
      && ctx.isSupportChat === true
      && OWNER_ADVISORY_READ_SUPPORT_TOOLS.has(toolName);
    if (nonCustomerExecution && authenticatedOwnerRead) {
      const result = await executor();
      // Advisory reads may return suggested follow-up effects (for example an
      // external-booking referral). Preserve the verified read result and URL,
      // but never let the simulator persist or deliver those effects.
      return { ...sanitizeSupportToolResult(toolName, result), effectProposals: [] };
    }
    if (nonCustomerExecution) {
      if (ctx.executionMode === 'preview' && ctx.isSupportChat && toolName === 'get_ticket_status') {
        return { toolResults: [{ name: toolName, result: { success: true, confirmedSideEffect: false,
          simulated: true, source: 'preview_fixture', ticket_id: args.ticket_id, status: 'open',
          latest_update: 'Simulated ticket for journey testing. No customer record was accessed.' } }] };
      }
      return {
        toolResults: [{
          name: toolName,
          result: {
            success: false,
            code: 'dry_run_suppressed',
            wouldExecute: true,
            args: sanitizeSupportToolData(args),
          },
        }],
      };
    }

    await assertSupportTurnFresh();
    if (risk !== 'read') await sealSupportTurn();
    const key = supportToolIdempotencyKey(toolName, args, ctx);
    const argumentDigest = supportToolArgumentDigest(ctx.userId, args);
    const [existing] = await db.select().from(supportToolExecutionsTable)
      .where(and(
        eq(supportToolExecutionsTable.userId, ctx.userId),
        eq(supportToolExecutionsTable.idempotencyKey, key),
      ))
      .limit(1);
    if (existing?.status === 'success') return existing.result as SubAgentResult;
    if (existing) {
      const recovery = decideToolRecovery(existing);
      if (recovery !== 'retry') {
        const waiting = recovery === 'wait';
        return {
          escalated: true,
          escalationType: 'support',
          escalationReason: waiting
            ? `The ${toolName} execution is still in progress; a duplicate call was suppressed.`
            : `The ${toolName} outcome requires owner reconciliation before it can be repeated.`,
          toolResults: [{
            name: toolName,
            result: { success: false, code: waiting ? 'execution_in_progress' : 'execution_requires_reconciliation' },
          }],
        };
      }
    }

    const sanitizedArgs = sanitizeSupportToolData(args) as Record<string, unknown>;
    // High-risk tools always require a one-time, argument-bound approval.
    // Owner metadata and playbooks are configuration, not authorization.
    if (risk === 'high') {
      const approvals = await ToolApprovalModel.findByThread(ctx.conversationId, ctx.userId);
      const now = Date.now();
      const sameAssistant = (approval: typeof approvals[number]) => !assistant
        ? !approval.assistantProvenance
        : approval.assistantProvenance?.assistantId === assistant.provenance.assistantId
          && approval.assistantProvenance?.revision === assistant.provenance.revision
          && approval.assistantProvenance?.bindingId === assistant.provenance.bindingId
          && approval.assistantProvenance?.bindingVersion === assistant.provenance.bindingVersion;
      const matchingApproved = approvals.find((approval) =>
        approval.userId === ctx.userId
        && sameAssistant(approval)
        && approval.toolName === toolName
        && approval.status === 'approved'
        && !approval.isExpired
        && (!approval.expiresAt || approval.expiresAt.getTime() > now)
        && approval.argumentDigest === argumentDigest,
      );
      if (matchingApproved) {
        return {
          escalated: true,
          escalationType: 'support',
          escalationReason: `Approved ${toolName} action is queued for governed execution.`,
          toolResults: [{
            name: toolName,
            result: {
              success: false,
              code: 'approval_execution_pending',
              approved: true,
              approvalId: matchingApproved.id,
            },
          }],
        };
      } else {
        const matchingPending = approvals.find((approval) =>
          approval.userId === ctx.userId
          && sameAssistant(approval)
          && approval.toolName === toolName
          && approval.status === 'pending'
          && !approval.isExpired
          && (!approval.expiresAt || approval.expiresAt.getTime() > now)
          && approval.argumentDigest === argumentDigest,
        );
        if (!matchingPending) {
          await ToolApprovalModel.create({
            userId: ctx.userId,
            threadId: ctx.conversationId,
            toolName,
            toolArgs: sanitizedArgs,
            argumentDigest,
            assistantProvenance:assistant?.provenance || null,
            resumePayload: encryptRestrictedPayload(ctx.userId, 'support-tool-resume', {
              idempotencyKey: key,
              argumentDigest,
              toolName,
              args,
              context: ctx,
              assistant: assistant?.provenance,
            }),
            resumeStatus: 'awaiting_decision',
            agentType: ctx.agentConfig?.agentType || null,
            status: 'pending',
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          });
        }
        return {
          escalated: true,
          escalationType: 'support',
          escalationReason: `Tool ${toolName} requires human approval.`,
          toolResults: [{ name: toolName, result: { success: false, code: 'approval_required' } }],
        };
      }
    }

    // High-risk tools return above in either approval state. Only the durable
    // resume worker may consume the encrypted, argument-bound approval.
    const approvalId: number | null = null;

    const [execution] = existing
      ? await db.update(supportToolExecutionsTable).set({
        status: 'running',
        attemptCount: sql`${supportToolExecutionsTable.attemptCount} + 1`,
        lastAttemptAt: new Date(),
        error: null,
        completedAt: null,
        reconciliationStatus: null,
        reconciliationNote: null,
        reconciledBy: null,
        reconciledAt: null,
      }).where(and(
        eq(supportToolExecutionsTable.id, existing.id),
        eq(supportToolExecutionsTable.status, existing.status),
      )).returning()
      : await db.insert(supportToolExecutionsTable).values({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        insightsConversationKind: ctx.widgetSession?.id ? 'widget' : ctx.conversationId > 0 ? 'outreach' : null,
        insightsConversationId: ctx.widgetSession?.id || (ctx.conversationId > 0 ? ctx.conversationId : null),
        toolName,
        idempotencyKey: key,
        riskLevel: risk,
        status: 'running',
        args: sanitizedArgs,
        argumentDigest,
        approvalId,
        attemptCount: 1,
        lastAttemptAt: new Date(),
      }).onConflictDoNothing({ target: supportToolExecutionsTable.idempotencyKey }).returning();
    if (!execution) {
      return {
        escalated: true,
        escalationType: 'support',
        escalationReason: `Concurrent execution of ${toolName} was suppressed.`,
        toolResults: [{ name: toolName, result: { success: false, code: 'duplicate_execution' } }],
      };
    }

    if (approvalId) {
      const [claimedApproval] = await db.update(toolApprovalsTable).set({
        status: 'executing',
        resumeStatus: 'running',
        consumedAt: new Date(),
        consumedExecutionId: execution.id,
        updatedAt: new Date(),
      }).where(and(
        eq(toolApprovalsTable.id, approvalId),
        eq(toolApprovalsTable.userId, ctx.userId),
        eq(toolApprovalsTable.status, 'approved'),
      )).returning();
      if (!claimedApproval) {
        await db.update(supportToolExecutionsTable).set({
          status: 'failed',
          error: 'Approved tool authorization was already consumed.',
          completedAt: new Date(),
        }).where(eq(supportToolExecutionsTable.id, execution.id));
        return {
          escalated: true,
          escalationType: 'support',
          escalationReason: `Approval for ${toolName} was already consumed; execution was suppressed.`,
          toolResults: [{ name: toolName, result: { success: false, code: 'approval_consumed' } }],
        };
      }
    }

    try {
      await assertAssistantFresh();
      const result = await withPromiseTimeout(
        executor(),
        ['create_conversation_proposal_draft', 'request_proposal_revision'].includes(toolName) ? 60_000 : 15_000,
        'Tool execution timed out. Check its recorded outcome before retrying.',
      );
      // The same redacted representation is persisted and returned to the
      // model. Returning the raw tool result here would let CRM/customer PII
      // bypass the inbound privacy stage on a later tool round.
      const sanitizedResult = sanitizeSupportToolResult(toolName, result);
      const succeeded = subAgentResultSucceeded(sanitizedResult);
      await db.update(supportToolExecutionsTable).set({
        status: succeeded ? 'success' : 'failed',
        result: sanitizedResult,
        error: succeeded ? null : 'Tool returned an unsuccessful result.',
        completedAt: new Date(),
      }).where(eq(supportToolExecutionsTable.id, execution.id));
      if (approvalId) {
        await db.update(toolApprovalsTable).set({
          status: 'consumed',
          resumeStatus: succeeded ? 'completed' : 'failed',
          resumedAt: new Date(),
          executionResult: sanitizedResult,
          resumeError: succeeded ? null : 'Tool returned an unsuccessful result.',
          updatedAt: new Date(),
        }).where(eq(toolApprovalsTable.id, approvalId));
      }
      return sanitizedResult;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const sanitizedError = String(sanitizeSupportToolData(String(error?.message || error))).slice(0, 2000);
      await db.update(supportToolExecutionsTable).set({
        status: 'failed',
        error: sanitizedError,
        completedAt: new Date(),
      }).where(eq(supportToolExecutionsTable.id, execution.id));
      if (approvalId) {
        await db.update(toolApprovalsTable).set({
          status: 'executing',
          resumeStatus: 'failed',
          resumeError: sanitizedError,
          executionResult: { success: false, error: sanitizedError },
          updatedAt: new Date(),
        }).where(eq(toolApprovalsTable.id, approvalId));
      }
      if (risk === 'read' && execution.attemptCount < MAX_AUTOMATIC_READ_ATTEMPTS) {
        return this.execute(toolName, args, ctx, executor);
      }
      throw new Error(sanitizedError);
    }
  }
}

export const safeToolExecutor = new SafeToolExecutor();
