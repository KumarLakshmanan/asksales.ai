import { FailureCooldown } from '../utils/failureCooldown.js';
import { assertContextFits } from '../mastra/utils/contextBudget.js';
import { conversationSummarySchema, CONVERSATION_SUMMARY_PROMPT, summaryExecutionEvidence } from '../mastra/utils/conversationSummary.js';
/**
 * Conversation Compaction Service
 * 
 * Produces a structured summary of older messages in a chat thread,
 * stores it in chat_summaries, and marks metadata on the thread.
 * Uses the admin LLM provider so token usage is tracked.
 */

import { logger } from '../utils/logger.js';
import { LLMProviderFactory } from './agents/LLMProviderFactory';
import {
  createChatSummary,
  getLatestSummaryByThreadId,
} from '../models/chatSummaries/functions';
import {
  getChatThreadMetadata,
  updateChatThreadMetadata,
} from '../models/chatThreads/functions';
import type { ChatMessageRecord } from '../models/chatMessages/schema';
import { chatHistoryManager } from './ChatHistoryManager';
import {
  COMPACTION_THRESHOLD,
  RECENT_MESSAGES_TO_KEEP,
  COMPACTION_LLM_TEMPERATURE,
  MAX_COMPACTED_IDS_PER_CATEGORY,
} from '../utils/chatConstants';

// Re-export for backward compatibility
export { COMPACTION_THRESHOLD };

export interface CompactionResult {
  summaryId: number;
  summaryText: string;
  keyEntities: string[];
  timeline: string[];
  messageCount: number;
  fromMessageId: number;
  toMessageId: number;
  version: number;
  tokenCounts: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

class ConversationCompactionService {
  private static instance: ConversationCompactionService;
  private readonly cooldown = new FailureCooldown();
  private readonly inFlight = new Map<string, Promise<CompactionResult>>();

  static getInstance(): ConversationCompactionService {
    if (!this.instance) this.instance = new ConversationCompactionService();
    return this.instance;
  }

  /**
   * Check whether a thread should be compacted based on message count.
   */
  async shouldCompact(threadId: number): Promise<boolean> {
    const messages = await chatHistoryManager.getMessages(threadId, 'all');
    return messages.length >= COMPACTION_THRESHOLD;
  }

  /**
   * Compact a conversation thread: summarise older messages and persist.
   */
  async compact(userId: number, threadId: number): Promise<CompactionResult> {
    const key = `${userId}:${threadId}`;
    if (this.cooldown.blocked(key)) {
      logger.info({ event: 'conversation_compaction', userId, threadId, status: 'cooldown' }, '[ConversationCompactionService] Repeated failures; retaining original history');
      throw new Error('Conversation summary temporarily unavailable; preserving original history.');
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const startedAt = Date.now();
    const work = this.compactOnce(userId, threadId);
    this.inFlight.set(key, work);
    try { const result = await work; this.cooldown.succeeded(key); return result; }
    catch (error) {
      this.cooldown.failed(key);
      logger.warn({ event: 'conversation_compaction', userId, threadId, status: 'failed', durationMs: Date.now() - startedAt,
        cooldown: this.cooldown.blocked(key) }, '[ConversationCompactionService] Summary failed; retaining original history');
      throw error;
    }
    finally { if (this.inFlight.get(key) === work) this.inFlight.delete(key); }
  }

  private async compactOnce(userId: number, threadId: number): Promise<CompactionResult> {
    const startTime = Date.now();

    // Fetch ALL messages for the thread (returned DESC — newest first)
    const allMessages = await chatHistoryManager.getMessages(threadId, 'all');
    if (allMessages.some(m => m.userId !== userId || m.threadId !== threadId)) {
      throw new Error('Conversation ownership mismatch');
    }
    // Reverse to chronological order
    const chronological = [...allMessages].reverse();

    // Keep recent messages, summarise the rest
    const recentCount = Math.min(RECENT_MESSAGES_TO_KEEP, chronological.length - 1);
    const messagesToSummarise = chronological.slice(0, chronological.length - recentCount);
    if (messagesToSummarise.length === 0) {
      throw new Error('Not enough messages to compact');
    }
    const fromMessageId = messagesToSummarise[0].id;
    const toMessageId = messagesToSummarise[messagesToSummarise.length - 1].id;
    const latestSummary = await getLatestSummaryByThreadId(threadId);
    if (latestSummary && latestSummary.userId !== userId) throw new Error('Summary ownership mismatch');
    if (latestSummary?.userId === userId
      && latestSummary.fromMessageId === fromMessageId
      && latestSummary.toMessageId === toMessageId
      && latestSummary.messageCount === messagesToSummarise.length) {
      return {
        summaryId: latestSummary.id, summaryText: latestSummary.summaryText,
        keyEntities: latestSummary.keyEntities ?? [], timeline: latestSummary.timeline ?? [],
        messageCount: latestSummary.messageCount, fromMessageId, toMessageId,
        version: latestSummary.version ?? 1, tokenCounts: latestSummary.tokenCounts ?? {},
      };
    }

    const delta = latestSummary
      ? messagesToSummarise.filter(m => m.id > (latestSummary.toMessageId ?? 0))
      : messagesToSummarise;
    if (!delta.length) throw new Error('No new messages to compact');
    const conversationText = JSON.stringify({
      previousSummary: latestSummary ? {
        summary: latestSummary.summaryText, keyEntities: latestSummary.keyEntities, timeline: latestSummary.timeline,
      } : null,
      executionEvidence: summaryExecutionEvidence(messagesToSummarise),
      newMessages: delta.map(m => ({
        id: m.id, role: m.role, agentType: m.agentType, content: m.content,
        toolReceipt: summaryExecutionEvidence([m])[0],
      })),
    });
    const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
    const systemPrompt = CONVERSATION_SUMMARY_PROMPT;

    assertContextFits(llmProvider.defaultModel, [{ role: 'system', content: systemPrompt }, { role: 'user', content: conversationText }]);
    const response = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Summarise this conversation:\n\n${conversationText}` },
      ],
      response_format: { type: 'json_object' },
      temperature: COMPACTION_LLM_TEMPERATURE,
      loggingContext: {
        userId,
        threadId,
        purpose: 'content_generation',
        service: 'ConversationCompactionService',
        action: 'compact_conversation',
      },
    });

    if (!response.success || !response.content) {
      throw new Error(`LLM summarisation failed: ${response.error || 'no content'}`);
    }

    // Invalid summaries never replace durable memory or modify thread metadata.
    const parsed = conversationSummarySchema.parse(JSON.parse(response.content));

    // Determine version
    const newVersion = latestSummary ? latestSummary.version! + 1 : 1;

    const tokenCounts = {
      promptTokens: response.usage?.promptTokens,
      completionTokens: response.usage?.completionTokens,
      totalTokens: response.usage?.totalTokens,
    };

    // Save summary
    const saved = await createChatSummary({
      threadId,
      userId,
      summaryText: parsed.summary,
      keyEntities: parsed.keyEntities || [],
      timeline: parsed.timeline || [],
      fromMessageId,
      toMessageId,
      messageCount: messagesToSummarise.length,
      tokenCounts,
      version: newVersion,
    });

    await this.extractAndSaveActionableIds(userId, threadId, delta);

    // Update thread metadata with pointer to latest summary
    const existingMeta = (await getChatThreadMetadata(threadId)) || {};
    await updateChatThreadMetadata(threadId, {
      ...existingMeta,
      latestSummaryId: saved.id,
      lastCompactedAt: new Date().toISOString(),
    });

    // The provider already recorded and billed this call once.
    const durationMs = Date.now() - startTime;

    logger.info({
      threadId,
      userId,
      version: newVersion,
      messagesCompacted: messagesToSummarise.length,
      durationMs,
    }, '[ConversationCompactionService] Compaction completed');

    return {
      summaryId: saved.id,
      summaryText: parsed.summary,
      keyEntities: parsed.keyEntities || [],
      timeline: parsed.timeline || [],
      messageCount: messagesToSummarise.length,
      fromMessageId,
      toMessageId,
      version: newVersion,
      tokenCounts,
    };
  }

  /**
   * Get the latest summary for a thread (or null).
   */
  async getLatestSummary(threadId: number) {
    return getLatestSummaryByThreadId(threadId);
  }

  /**
   * Before compacting messages, extract structured IDs (leads, content assets, templates)
   * and persist them in thread metadata so downstream agents can still reference them.
   */
  private async extractAndSaveActionableIds(
    userId: number,
    threadId: number,
    messages: ChatMessageRecord[],
  ): Promise<void> {
    try {
      const leadIdSet      = new Set<number>();
      const assetIdSet     = new Set<number>();
      const templateIdSet  = new Set<number>();

      const collect = (value: unknown, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return;
        for (const [key, item] of Object.entries(value)) {
          const target = ['leadId', 'leadIds'].includes(key) ? leadIdSet
            : ['assetId', 'assetIds', 'contentAssetId', 'contentAssetIds'].includes(key) ? assetIdSet
            : ['templateId', 'templateIds'].includes(key) ? templateIdSet : null;
          if (target) for (const id of Array.isArray(item) ? item : [item]) {
            if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) target.add(id);
          }
          collect(item, depth + 1);
        }
      };
      for (const msg of messages) {
        const metadata = msg.metadata as Record<string, unknown> | null;
        // Only persisted server tool receipts, never numbers mentioned in prose.
        if (metadata?.isToolResult === true && metadata.success === true) collect(metadata.toolOutput);
      }

      if (leadIdSet.size === 0 && assetIdSet.size === 0 && templateIdSet.size === 0) return;

      const existingMeta = (await getChatThreadMetadata(threadId)) || {};
      const mergeIds = (existing: number[] | undefined, extracted: Set<number>): number[] => {
        const combined = new Set([...(existing || []), ...extracted]);
        return [...combined].slice(0, MAX_COMPACTED_IDS_PER_CATEGORY);
      };

      await updateChatThreadMetadata(threadId, {
        ...existingMeta,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compactedLeadIds:    mergeIds((existingMeta as any).compactedLeadIds, leadIdSet),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compactedAssetIds:   mergeIds((existingMeta as any).compactedAssetIds, assetIdSet),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compactedTemplateIds: mergeIds((existingMeta as any).compactedTemplateIds, templateIdSet),
      });

      logger.info({
        threadId,
        leads: leadIdSet.size,
        assets: assetIdSet.size,
        templates: templateIdSet.size,
      }, '[ConversationCompactionService] Saved actionable IDs before compaction');
    } catch (err) {
      logger.warn({ err, threadId }, '[ConversationCompactionService] extractAndSaveActionableIds failed (non-blocking)');
    }
  }
}

export const conversationCompactionService = ConversationCompactionService.getInstance();
