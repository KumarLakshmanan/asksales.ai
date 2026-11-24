/**
 * Knowledge Base Service
 * Retrieves and formats Knowledge Base data for use in AI content generation and reply drafting
 */

import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import type { KnowledgeAudience, KnowledgePurpose, KnowledgeRisk } from './knowledge/types.js';

export interface GroundedKnowledgeSource {
  sourceId: number;
  citation: string;
  title: string;
  excerpt: string;
  similarity: number;
  sourceUrl?: string;
}

export interface GroundedKnowledgeResult {
  context: string;
  sources: GroundedKnowledgeSource[];
  status: 'grounded' | 'insufficient_knowledge' | 'retrieval_unavailable';
}

export interface KnowledgeBaseContext {
  entries: Array<{
    id: number;
    title: string;
    content: string;
    type: string;
    category?: string;
    tags?: string[];
  }>;
  formattedContext: string;
  relevantFacts: string[];
  faqs: Array<{ question: string; answer: string }>;
}

class KnowledgeBaseService {
  private static instance: KnowledgeBaseService;

  private constructor() {}

  public static getInstance(): KnowledgeBaseService {
    if (!KnowledgeBaseService.instance) {
      KnowledgeBaseService.instance = new KnowledgeBaseService();
    }
    return KnowledgeBaseService.instance;
  }

  // Raw entry listings and FAQ dumps were removed: they returned unpublished
  // and internal-only knowledge_base content without governance. Use the
  // grounded methods below, which go through KnowledgeGateway.

  /**
   * Find best matching FAQ for a given question using embedding-based semantic search.
   */
  async findMatchingFAQ(userId: number, question: string): Promise<{ question: string; answer: string } | null> {
    try {
      const grounded = await this.getGroundedContext(userId, question, { limit: 3 });
      for (const source of grounded.sources) {
        const qMatch = source.excerpt.match(/^Q:\s*(.+?)\nA:\s*(.+)$/s);
        if (qMatch) {
          return { question: qMatch[1].trim(), answer: qMatch[2].trim() };
        }
      }
      return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[KnowledgeBaseService] Error finding matching FAQ via embeddings');
      return null;
    }
  }

  // ── Embedding-enhanced RAG methods ──────────────────────────────────────────

  /**
   * Index a knowledge-base entry into the governed review workflow.
   * Call this when a KB entry is created/updated.
   */
  async indexEntry(userId: number, entryId: number, text: string): Promise<void> {
    if (!text.trim()) throw new Error('Cannot index an empty knowledge-base entry.');
    let indexedRevision: Date | null = null;
    try {
      const [{ KnowledgeBaseModel }, { knowledgeIngestionService }] = await Promise.all([
        import('../models/knowledgeBase/functions.js'),import('./knowledge/KnowledgeIngestionService.js'),
      ]);
      const entry = await KnowledgeBaseModel.findById(entryId,userId);
      if (!entry) throw new Error('Knowledge-base entry is unavailable during indexing.');
      indexedRevision = entry.updatedAt ?? null;
      const result = await knowledgeIngestionService.indexLegacyEntry(entry,{autoPublish:false});
      if (result.status === 'quarantined') throw new Error('Knowledge content requires privacy review.');
    } catch (error) {
      await db.execute(sql`
        UPDATE knowledge_base
        SET processing_status = 'failed', updated_at = NOW()
        WHERE id = ${entryId} AND user_id = ${userId}
          AND ${indexedRevision ? sql`date_trunc('milliseconds',updated_at)=${indexedRevision}` : sql`TRUE`}
      `);
      throw error;
    }
  }

  /**
   * Remove embeddings when a KB entry is deleted.
   */
  async removeEntryEmbeddings(userId: number, entryId: number): Promise<void> {
    try {
      const { embeddingService } = await import('./embeddings/EmbeddingService');
      await embeddingService.deleteBySource(userId, 'knowledge_base', entryId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.warn({ err: error, userId, entryId }, '[KnowledgeBaseService] Failed to remove entry embeddings');
    }
  }

  /**
   * Retrieve approved KB context through the governed gateway. Vector outages
   * and rollback mode retain published lexical evidence without consulting raw
   * legacy content or bypassing current publication and privacy restrictions.
   */
  async getSemanticContext(
    userId: number,
    query: string,
    options?: {
      limit?: number; threshold?: number; businessProfileId?: number | null;
      purpose?: KnowledgePurpose; channel?: string; audience?: KnowledgeAudience; risk?: KnowledgeRisk;
    },
  ): Promise<string> {
    return (await this.getGroundedContext(userId, query, options)).context;
  }

  async getGroundedContext(
    userId: number,
    query: string,
    options?: {
      limit?: number; threshold?: number; businessProfileId?: number | null;
      purpose?: KnowledgePurpose; channel?: string; audience?: KnowledgeAudience; risk?: KnowledgeRisk; lexicalOnly?: boolean;
    },
  ): Promise<GroundedKnowledgeResult> {
    const { knowledgeGateway } = await import('./knowledge/KnowledgeGateway.js');
    const result = await knowledgeGateway.retrieve({
      tenantId: userId,
      businessProfileId: options?.businessProfileId ?? null,
      purpose: options?.purpose || 'support_answer',
      channel: options?.channel || 'internal',
      audience: options?.audience || 'internal',
      redactedText: query,
      redactedHistory: [],
      entities: {},
      risk: options?.risk || 'low',
    }, { lexicalOnly: options?.lexicalOnly });
    const sources: GroundedKnowledgeSource[] = result.evidence.map((evidence) => ({
      sourceId: evidence.documentId,
      citation: evidence.evidenceId,
      title: evidence.title,
      sourceUrl: evidence.sourceUrl,
      excerpt: evidence.excerpt,
      similarity: evidence.scores.reranker || evidence.scores.vector || evidence.scores.fused,
    }));
    return {
      context: result.status === 'sufficient' ? knowledgeGateway.formatEvidence(result) : '',
      sources,
      status: result.status === 'sufficient' ? 'grounded'
        : result.status === 'unavailable' ? 'retrieval_unavailable' : 'insufficient_knowledge',
    };
  }

  /** Compatibility entry point: old unversioned text/embeddings cannot prove
   * approval. Use the current published lexical index, including when V2 is off.
   * Truly ungoverned legacy entries remain unavailable until reviewed/published.
   */
  async getLegacyGroundedContext(
    userId: number,
    query: string,
    options?: {
      limit?: number; threshold?: number; businessProfileId?: number | null;
      purpose?: KnowledgePurpose; channel?: string; audience?: KnowledgeAudience; risk?: KnowledgeRisk;
    },
  ): Promise<GroundedKnowledgeResult> {
    return this.getGroundedContext(userId, query, { ...options, lexicalOnly: true });
  }
}

export const knowledgeBaseService = KnowledgeBaseService.getInstance();
