/**
 * ChatHistoryManager — Centralised chat history management.
 *
 * All agents, tool executors, controllers, and services should use this
 * instead of calling getChatMessagesByThreadId directly. It is compaction-aware:
 * when a thread has a compacted summary, the returned history includes
 * the summary as a system message followed by the most recent messages.
 */

/** Plain message type for LLM consumption */
interface PlainMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  agentType?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any;
}
import { logger } from '../utils/logger.js';
import { getChatMessagesByThreadId as _fetchMessages } from '../models/chatMessages/functions';
import { getLatestSummaryByThreadId } from '../models/chatSummaries/functions';
import type { ChatMessageRecord } from '../models/chatMessages/schema';
import {
  LANGGRAPH_CONTEXT_MESSAGE_LIMIT,
  ICP_GENERATION_MESSAGE_LIMIT,
  ICP_AGENT_CONTEXT_MESSAGE_LIMIT,
  ICP_SERVICE_CONTEXT_MESSAGE_LIMIT,
  EXISTING_MESSAGES_CHECK_LIMIT,
  ALL_MESSAGES_LIMIT,
  DEFAULT_MESSAGE_FETCH_LIMIT,
  BUDGET_MESSAGE_OVERHEAD,
  USER_MESSAGE_FETCH_MULTIPLIER,
} from '../utils/chatConstants';
import { countTokens } from '../utils/tokenCounter';
import { getModelContextWindow } from './GenAIPricingService';
import { getContextWindowForModel } from '../utils/chatConstants';
import {
  appendConversationAttachmentContext,
  type ConversationAttachmentMetadata,
} from './ConversationAttachmentService.js';

// ─── Public types ───────────────────────────────────────────────────────────────

export type HistoryPurpose =
  | 'agent_context'           // Loading state into Mastra agent     (limit: AGENT_CONTEXT_MESSAGE_LIMIT)
  | 'langgraph_context'       // @deprecated — use 'agent_context'
  | 'icp_generation'          // Generating ICP from a thread        (limit: ICP_GENERATION_MESSAGE_LIMIT)
  | 'icp_agent_context'       // ICP agent conversation context      (limit: ICP_AGENT_CONTEXT_MESSAGE_LIMIT)
  | 'icp_service_context'     // ICP service conversation context    (limit: ICP_SERVICE_CONTEXT_MESSAGE_LIMIT)
  | 'existing_check'          // Checking if a thread has messages   (limit: EXISTING_MESSAGES_CHECK_LIMIT)
  | 'all'                     // Full thread history                 (limit: ALL_MESSAGES_LIMIT)
  | 'default';                // General purpose                     (limit: DEFAULT_MESSAGE_FETCH_LIMIT)

const PURPOSE_LIMITS: Record<HistoryPurpose, number> = {
  agent_context: LANGGRAPH_CONTEXT_MESSAGE_LIMIT,
  langgraph_context: LANGGRAPH_CONTEXT_MESSAGE_LIMIT, // @deprecated alias
  icp_generation: ICP_GENERATION_MESSAGE_LIMIT,
  icp_agent_context: ICP_AGENT_CONTEXT_MESSAGE_LIMIT,
  icp_service_context: ICP_SERVICE_CONTEXT_MESSAGE_LIMIT,
  existing_check: EXISTING_MESSAGES_CHECK_LIMIT,
  all: ALL_MESSAGES_LIMIT,
  default: DEFAULT_MESSAGE_FETCH_LIMIT,
};

export function contentWithAttachmentContext(message: ChatMessageRecord): string {
  if (message.role !== 'user') return message.content;
  const metadata = message.metadata as { attachments?: unknown } | null;
  if (!Array.isArray(metadata?.attachments)) return message.content;

  const attachments = metadata.attachments.filter((item): item is ConversationAttachmentMetadata => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    return Number.isSafeInteger(Number(record.fileId))
      && typeof record.name === 'string'
      && typeof record.mimeType === 'string'
      && typeof record.contextText === 'string';
  });
  return appendConversationAttachmentContext(message.content, attachments);
}

// ─── Service ────────────────────────────────────────────────────────────────────

class ChatHistoryManagerService {
  private static instance: ChatHistoryManagerService;

  static getInstance(): ChatHistoryManagerService {
    if (!this.instance) this.instance = new ChatHistoryManagerService();
    return this.instance;
  }

  // ── Raw message records ──────────────────────────────────────────────────

  /**
   * Fetch raw ChatMessageRecords from the DB.
   * @param purpose determines the limit — callers never need to hard-code limits.
   * @param explicitLimit override the purpose-based limit if needed (e.g. user-supplied).
   * @returns messages in DESC order (newest first) — same as getChatMessagesByThreadId.
   */
  async getMessages(
    threadId: number,
    purpose: HistoryPurpose = 'default',
    explicitLimit?: number,
  ): Promise<ChatMessageRecord[]> {
    const limit = explicitLimit ?? PURPOSE_LIMITS[purpose];
    return _fetchMessages(threadId, limit);
  }

  /**
   * M2: Calculate the appropriate message fetch limit for a given model and plan tier.
   * Enterprise plans get higher context windows; free plans get the default.
   *
   * @param modelName   The LLM model name (e.g., 'gpt-4o') — used to look up its native context window.
   * @param tierMaxMessages  Plan-tier override (null = use model default; 0 = unlimited).
   * @returns the number of messages to fetch.
   */
  calculateContextLimit(modelName?: string, tierMaxMessages?: number | null): number {
    // If the caller explicitly sets 0 or null, use the all-messages limit (unlimited up to DB capacity).
    if (tierMaxMessages === 0 || tierMaxMessages === null) return ALL_MESSAGES_LIMIT;
    // If the caller provides a positive number, use it.
    if (tierMaxMessages && tierMaxMessages > 0) return tierMaxMessages;
    // Otherwise, use the model's native context window to estimate how many messages fit.
    // (Each message averages ~200 tokens; the model's context window is in tokens.)
    try {
      const modelWindow = getModelContextWindow(modelName || 'gpt-4o') ?? getContextWindowForModel(modelName || 'gpt-4o');
      const estimatedMessages = Math.floor((modelWindow * 0.8) / 200); // 80% of context, ~200 tokens/msg
      return Math.min(Math.max(estimatedMessages, 50), ALL_MESSAGES_LIMIT);
    } catch {
      return PURPOSE_LIMITS.agent_context;
    }
  }

  /**
   * Fetch messages in chronological order (oldest first).
   */
  async getMessagesChronological(
    threadId: number,
    purpose: HistoryPurpose = 'default',
    explicitLimit?: number,
  ): Promise<ChatMessageRecord[]> {
    const msgs = await this.getMessages(threadId, purpose, explicitLimit);
    return [...msgs].reverse();
  }

  // ── LangChain messages (compaction-aware) ────────────────────────────────

  /**
   * Build a LangChain PlainMessage[] suitable for feeding into an LLM.
   *
   * If the thread has a compacted summary, the returned array starts with
   * a SystemMessage containing the summary, followed by the most recent
   * un-compacted messages. This keeps the effective context small while
   * preserving historical knowledge.
   *
   * Messages with null / empty content are filtered out.
   * Returned in chronological order (oldest first).
   */
  async buildLangChainMessages(
    threadId: number,
    purpose: HistoryPurpose = 'agent_context',
  ): Promise<PlainMessage[]> {
    const limit = PURPOSE_LIMITS[purpose];
    const rawMessages = await _fetchMessages(threadId, limit);

    // Reverse to chronological
    const chronological = [...rawMessages].reverse();

    // Filter out empty / null content
    const valid = chronological.filter(
      (m) => m.content != null && m.content !== '',
    );

    const langchainMsgs: PlainMessage[] = [];
    let summarizedThrough = 0;

    // Prepend compacted summary if available
    try {
      const summary = await getLatestSummaryByThreadId(threadId);
      if (summary?.summaryText) {
        summarizedThrough = summary.toMessageId ?? 0;
        langchainMsgs.push({
          role: 'system',
          content: `[CONVERSATION SUMMARY — earlier messages compacted]\n${summary.summaryText}`,
        });
      }
    } catch (err) {
      logger.warn({ err, threadId }, '[ChatHistoryManager] Could not load summary');
    }

    // Map DB records to plain messages
    for (const msg of valid) {
      if (msg.id <= summarizedThrough) continue;
      if (msg.role === 'user') {
        langchainMsgs.push({ role: 'user', content: contentWithAttachmentContext(msg) });
      } else {
        langchainMsgs.push({
          role: 'assistant',
          content: msg.content,
          agentType: msg.agentType,
          metadata: msg.metadata,
        });
      }
    }

    return langchainMsgs;
  }

  /**
   * Build LangChain messages that fit within a given token budget.
   *
   * Loads messages newest-first and accumulates until the budget is exhausted.
   * This ensures the most recent (and most relevant) messages are always
   * included, unlike a fixed-count approach that may overshoot or undershoot.
   *
   * Returned in chronological order (oldest first).
   */
  async buildLangChainMessagesWithinBudget(
    threadId: number,
    tokenBudget: number,
    modelName?: string,
  ): Promise<PlainMessage[]> {
    // Fetch messages (newest first) up to LANGGRAPH_CONTEXT_MESSAGE_LIMIT
    const rawMessages = await _fetchMessages(threadId, LANGGRAPH_CONTEXT_MESSAGE_LIMIT);

    // Filter out empty / null content
    const valid = rawMessages.filter(
      (m) => m.content != null && m.content !== '',
    );

    let usedTokens = 0;
    let summarizedThrough = 0;
    const selected: PlainMessage[] = [];

    // Prepend compacted summary if available (deduct from budget)
    try {
      const summary = await getLatestSummaryByThreadId(threadId);
      if (summary?.summaryText) {
        const summaryText = `[CONVERSATION SUMMARY — earlier messages compacted]\n${summary.summaryText}`;
        const summaryTokens = countTokens(summaryText, modelName);
        if (summaryTokens < tokenBudget) {
          summarizedThrough = summary.toMessageId ?? 0;
          selected.push({ role: 'system', content: summaryText });
          usedTokens += summaryTokens;
        }
      }
    } catch (err) {
      logger.warn({ err, threadId }, '[ChatHistoryManager] Could not load summary for budget loading');
    }

    // Walk newest→oldest, accumulate messages within remaining budget
    const messagesToPrepend: PlainMessage[] = [];
    for (const msg of valid) {
      if (msg.id <= summarizedThrough) continue;
      const content = contentWithAttachmentContext(msg);
      const msgTokens = countTokens(content, modelName) + BUDGET_MESSAGE_OVERHEAD;
      if (usedTokens + msgTokens > tokenBudget) break;

      const plainMsg: PlainMessage = msg.role === 'user'
        ? { role: 'user', content }
        : {
            role: 'assistant',
            content: msg.content,
            agentType: msg.agentType,
            metadata: msg.metadata,
          };

      messagesToPrepend.push(plainMsg);
      usedTokens += msgTokens;
    }

    // Reverse to chronological order and append after summary
    messagesToPrepend.reverse();
    selected.push(...messagesToPrepend);

    return selected;
  }

  // ── Convenience helpers ──────────────────────────────────────────────────

  /**
   * Extract the most recent N user-message strings (chronological, oldest first).
   */
  async getRecentUserMessages(
    threadId: number,
    count: number,
  ): Promise<string[]> {
    // Fetch enough messages to find `count` user messages
    const raw = await _fetchMessages(threadId, count * USER_MESSAGE_FETCH_MULTIPLIER);
    return raw
      .filter((m) => m.role === 'user' && m.content)
      .slice(0, count)
      .reverse()
      .map((m) => m.content);
  }

  /**
   * Check whether a thread has any user messages.
   */
  async hasUserMessages(threadId: number): Promise<boolean> {
    const msgs = await _fetchMessages(threadId, EXISTING_MESSAGES_CHECK_LIMIT);
    return msgs.some((m) => m.role === 'user');
  }

  /**
   * Get the last assistant message that is not a transition message.
   * Useful for determining the current active agent.
   */
  async getLastAgentMessage(
    threadId: number,
  ): Promise<ChatMessageRecord | undefined> {
    const msgs = await _fetchMessages(threadId, LANGGRAPH_CONTEXT_MESSAGE_LIMIT);
    const lastAssistant = msgs.find(
      (m) =>
        m.role === 'assistant' &&
        m.agentType !== 'user' &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        !(m.metadata as any)?.isTransition &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        !(m.metadata as any)?.isTransitionMessage,
    );
    // Fallback: use the last transition's target agent
    if (!lastAssistant) {
      const lastTransition = msgs.find(
        (m) =>
          m.role === 'assistant' &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((m.metadata as any)?.isTransition || (m.metadata as any)?.isTransitionMessage) &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (m.metadata as any)?.toAgent,
      );
      if (lastTransition) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { ...lastTransition, agentType: (lastTransition.metadata as any).toAgent } as ChatMessageRecord;
      }
    }
    return lastAssistant;
  }
}

export const chatHistoryManager = ChatHistoryManagerService.getInstance();
