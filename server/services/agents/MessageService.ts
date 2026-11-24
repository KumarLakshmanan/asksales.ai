import { LLMProviderFactory } from './LLMProviderFactory.js';
import { logger } from '../../utils/logger.js';
import { createChatMessage } from '../../models/chatMessages/functions.js';
import type { LLMConfig } from '../../mastra/state.js';
import { withPromiseTimeout } from '../../utils/promiseTimeout.js';
import { createHash } from 'node:crypto';
import type { RouterOutput } from '../../mastra/routerSchema.js';

export type PendingApprovalDecision = 'approve' | 'reject' | 'modify_or_unclear';

const approvalDecisionCache = new Map<string, { decision: PendingApprovalDecision; ts: number }>();
const APPROVAL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Cleanup cache periodically without keeping tests, workers, or graceful
// shutdown alive when this cache is the only remaining resource.
const approvalCacheCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - APPROVAL_CACHE_TTL_MS;
  for (const [key, val] of approvalDecisionCache) {
    if (val.ts < cutoff) approvalDecisionCache.delete(key);
  }
}, APPROVAL_CACHE_TTL_MS);
approvalCacheCleanupTimer.unref?.();

export class MessageService {
  /** A labelled ID is a reference, not authorization to replace recipients. */
  static async resolveExplicitLeadSelection(params: {
    userId: number;
    message: string;
    candidateIds: number[];
    selectedLeadIds?: number[];
  }): Promise<number[] | null> {
    if (!params.candidateIds.length) return null;
    try {
      const provider = await LLMProviderFactory.createProviderForUser(params.userId);
      const result = await withPromiseTimeout(provider.createChatCompletion({
        model: provider.defaultModel,
        messages: [{ role: 'system', content: `Determine whether the latest user message explicitly selects an exact recipient set for an outreach draft.
Return JSON only: {"action":"replace_selection"|"not_selection","leadIds":[]}.
Use replace_selection only for a clear present instruction to use/select/review these recipients. Include only the positively selected IDs, never IDs mentioned as excluded, examples, quotes, hypothetical choices, questions, or historical references. Questions about why a lead was excluded or what would happen must return not_selection. Sending authorization is separate and never granted here. If the exact complete intended selection is unclear, return not_selection. Do not infer additional IDs from existing selection.
Allowed explicitly mentioned IDs: ${JSON.stringify(params.candidateIds)}.
Current selection (reference only): ${JSON.stringify(params.selectedLeadIds || [])}.` },
        { role: 'user', content: params.message }],
        temperature: 0,
        response_format: { type: 'json_object' },
      }), 10000, 'Recipient selection interpretation timed out');
      if (!result.success) return null;
      const parsed = JSON.parse(result.content || '');
      if (parsed?.action !== 'replace_selection' || !Array.isArray(parsed.leadIds) || !parsed.leadIds.length) return null;
      if (!parsed.leadIds.every((id: unknown) => typeof id === 'number' && Number.isInteger(id) && params.candidateIds.includes(id))) return null;
      return [...new Set<number>(parsed.leadIds)];
    } catch (error) {
      logger.warn({ err: error }, '[MessageService] Could not verify explicit recipient selection');
      return null;
    }
  }

  /**
   * Interpret approval semantically against its exact review and recent question.
   */
  static async resolvePendingApprovalDecision(params: {
    userId: number;
    threadId: number;
    llmConfig: LLMConfig | null;
    message: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pendingApproval: any;
    currentAgent?: string;
    recentMessages?: Array<{ role: string; content: string }>;
    turnIntent?: RouterOutput;
  }): Promise<PendingApprovalDecision | null> {
    const { userId, threadId, llmConfig, message, pendingApproval, currentAgent } = params;
    if (!llmConfig || !pendingApproval || !message.trim()) {
      return null;
    }

    // The full turn has already been interpreted. A side question or a
    // different specialist's task is not a decision on this exact review.
    // In particular, "do not run" in an advice request must not cancel it.
    const intent = params.turnIntent;
    if (intent && (intent.needsClarification || intent.intent === 'navigation'
      || ['question', 'revise', 'clarify', 'switch_agent'].includes(intent.action || '')
      || (intent.action === 'cancel' && intent.cancellationScope !== 'review')
      || intent.hiredAgents.some(agent => agent !== currentAgent)
      || (intent.nextAgent && intent.nextAgent !== currentAgent))) {
      return 'modify_or_unclear';
    }

    const trimmed = message.trim();
    const recentMessages = (params.recentMessages || []).slice(-8);
    const cacheKey = createHash('sha256').update(JSON.stringify({ userId, threadId, message: trimmed, pendingApproval, currentAgent, recentMessages })).digest('hex');
    const cached = approvalDecisionCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < APPROVAL_CACHE_TTL_MS) {
      logger.debug({ userId, threadId, decision: cached.decision }, '[MessageService] Approval decision served from cache');
      return cached.decision;
    }

    try {
      const provider = await LLMProviderFactory.createProviderForUser(userId);

      const result = await withPromiseTimeout(
        provider.createChatCompletion({
          model: provider.defaultModel,
          messages: [
            {
              role: 'system',
              content: `You classify a user's latest reply to a pending action.
Return JSON only in this exact shape: {"decision":"approve"|"reject"|"modify_or_unclear"}.

Rules:
- Return "approve" only when the user is clearly authorizing the pending action to proceed now.
- Return "reject" only when the user is clearly declining, canceling, or stopping the pending action.
- A request to cancel a different saved post, another review, or another operation is "modify_or_unclear". Do not reject this pending action merely because the user used cancellation language. Match the exact pending tool and resource identity.
- If the user stops/cancels the entire campaign, plan, or all remaining steps, return "modify_or_unclear" so the coordinator can cancel the whole scope, not only this one approval.
- Return "modify_or_unclear" for any request to change settings, ask a question, postpone, or when the reply is ambiguous.
- The pending tool may spend credits or money, send messages or publish (for example execute_lead_workflow, send_*, publish_*, launch_* or ad creation). For these, a bare acknowledgement that does not itself express going ahead ("ok", "okay", "fine", "noted", "cool", "got it", a thumbs-up, or the same in any language) is "modify_or_unclear". Clear assent to run, send or approve ("yes", "yes run it", "go ahead", "approve it", "send it") is "approve".
- "Keep this review pending; do not run anything" while asking for advice is not rejection. A prohibition on execution does not cancel a saved review.
- A strategy-selection confirmation authorizes only preparation of new parameters, never execution of an older pending search. Interpret bare affirmations against the most recent question; if it was not this exact execution review, return "modify_or_unclear".

Pending agent: ${currentAgent || 'unknown'}
Pending tool: ${pendingApproval.toolName || 'unknown'}
Pending message: ${pendingApproval.message || 'none'}
Pending args: ${JSON.stringify(pendingApproval.args || {})}
Recent conversation (reference only): ${JSON.stringify(recentMessages)}`,
            },
            { role: 'user', content: trimmed },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ] as any,
          temperature: 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          response_format: { type: 'json_object' } as any,
        }),
        10000,
        'Approval classifier timed out',
      );

      if (!result.success) return null;
      const rawContent = result.content || '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any;
      try { parsed = JSON.parse(rawContent); } catch { return null; }

      if (parsed?.decision === 'approve' || parsed?.decision === 'reject' || parsed?.decision === 'modify_or_unclear') {
        if (approvalDecisionCache.size >= 256) approvalDecisionCache.delete(approvalDecisionCache.keys().next().value!);
        approvalDecisionCache.set(cacheKey, { decision: parsed.decision, ts: Date.now() });
        return parsed.decision;
      }
    } catch (error) {
      logger.warn({ err: error, threadId }, '[MessageService] Could not resolve pending approval decision (LLM)');
    }

    return null;
  }

  /**
   * Safe wrapper for DB chat message creation with logs
   */
  static async saveMessage(params: {
    userId: number;
    threadId: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    agentType: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata?: any;
  }) {
    try {
      const saved = await createChatMessage({
        userId: params.userId,
        threadId: params.threadId,
        role: params.role,
        content: params.content,
        agentType: params.agentType,
        metadata: params.metadata,
      });
      return saved;
    } catch (err) {
      logger.error({ err, agentType: params.agentType }, '[MessageService] Failed to save message');
      throw err;
    }
  }
}
