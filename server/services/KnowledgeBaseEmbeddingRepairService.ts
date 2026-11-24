import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { embeddingService } from './embeddings/EmbeddingService.js';
import { logger } from '../utils/logger.js';

interface KnowledgeRow {
  id: number;
  user_id: number;
  title: string;
  type: string;
  content: string | null;
  question: string | null;
  answer: string | null;
  source_url: string | null;
  processing_status: string;
}

export interface KnowledgeEmbeddingVerification {
  entriesChecked: number;
  entriesWithContent: number;
  entriesWithEmbeddings: number;
  missingEntryIds: number[];
  invalidDimensionEntryIds: number[];
  missingCitationEntryIds: number[];
}

export function extractKnowledgeBaseEmbeddingChunks(row: Pick<
  KnowledgeRow,
  'id' | 'title' | 'type' | 'content' | 'question' | 'answer'
>): string[] {
  if (row.type === 'qa' || row.question || row.answer) {
    const text = [
      row.question ? `Question: ${row.question.trim()}` : '',
      row.answer ? `Answer: ${row.answer.trim()}` : '',
    ].filter(Boolean).join('\n');
    return text ? [text] : [];
  }
  if (!row.content?.trim()) return [];
  try {
    const parsed = JSON.parse(row.content) as {
      chunks?: Array<{ text?: unknown }>;
      extractedText?: unknown;
    };
    const chunks = Array.isArray(parsed.chunks)
      ? parsed.chunks
        .map((chunk) => typeof chunk?.text === 'string' ? chunk.text.trim() : '')
        .filter(Boolean)
      : [];
    if (chunks.length > 0) return [...new Set(chunks)];
    if (typeof parsed.extractedText === 'string' && parsed.extractedText.trim()) {
      return [parsed.extractedText.trim()];
    }
  } catch {
    // Plain-text knowledge entries are expected and need no JSON wrapper.
  }
  return [row.content.trim()];
}

export async function verifyKnowledgeBaseEmbeddings(userId?: number): Promise<KnowledgeEmbeddingVerification> {
  const result = await db.execute(sql`
    SELECT kb.id,
      CASE
        WHEN kb.question IS NOT NULL OR kb.answer IS NOT NULL OR NULLIF(BTRIM(kb.content), '') IS NOT NULL
          THEN TRUE ELSE FALSE
      END AS has_content,
      COUNT(e.id)::int AS embedding_count,
      BOOL_OR(e.dimensions IS NULL OR e.embedding IS NULL OR vector_dims(e.embedding) <> e.dimensions) AS invalid_dimensions,
      BOOL_OR(
        e.id IS NOT NULL
        AND (
          COALESCE(e.metadata->>'title', '') = ''
          OR COALESCE(e.metadata->>'citation', '') = ''
        )
      ) AS missing_citation
    FROM knowledge_base kb
    LEFT JOIN embeddings e
      ON e.user_id = kb.user_id
      AND e.source_type = 'knowledge_base'
      AND e.source_id = kb.id
    WHERE kb.processing_status = 'completed'
      ${userId ? sql`AND kb.user_id = ${userId}` : sql``}
    GROUP BY kb.id
    ORDER BY kb.id
  `);
  const rows = result.rows as Array<{
    id: number;
    has_content: boolean;
    embedding_count: number;
    invalid_dimensions: boolean | null;
    missing_citation: boolean | null;
  }>;
  const withContent = rows.filter((row) => row.has_content);
  return {
    entriesChecked: rows.length,
    entriesWithContent: withContent.length,
    entriesWithEmbeddings: withContent.filter((row) => Number(row.embedding_count) > 0).length,
    missingEntryIds: withContent.filter((row) => Number(row.embedding_count) === 0).map((row) => Number(row.id)),
    invalidDimensionEntryIds: rows.filter((row) => row.invalid_dimensions).map((row) => Number(row.id)),
    missingCitationEntryIds: rows.filter((row) => row.missing_citation).map((row) => Number(row.id)),
  };
}

export async function rebuildKnowledgeBaseEmbeddings(options: {
  userId?: number;
  onlyMissing?: boolean;
} = {}) {
  const result = await db.execute(sql`
    SELECT id, user_id, title, type, content, question, answer, source_url, processing_status
    FROM knowledge_base
    WHERE processing_status = 'completed'
      ${options.userId ? sql`AND user_id = ${options.userId}` : sql``}
    ORDER BY user_id, id
  `);
  let rebuiltEntries = 0;
  let storedChunks = 0;
  const skippedEntryIds: number[] = [];
  const failed: Array<{ entryId: number; error: string }> = [];

  for (const row of result.rows as unknown as KnowledgeRow[]) {
    try {
      if (options.onlyMissing) {
        const existing = await db.execute(sql`
          SELECT 1 FROM embeddings
          WHERE user_id = ${row.user_id}
            AND source_type = 'knowledge_base'
            AND source_id = ${row.id}
            AND embedding IS NOT NULL
          LIMIT 1
        `);
        if (existing.rows[0]) {
          skippedEntryIds.push(row.id);
          continue;
        }
      }
      const chunks = extractKnowledgeBaseEmbeddingChunks(row);
      if (chunks.length === 0) {
        skippedEntryIds.push(row.id);
        continue;
      }
      const generated = await embeddingService.generateEmbeddingsBatch(chunks, row.user_id);
      if (generated.vectors.length !== chunks.length) {
        throw new Error(`Provider returned ${generated.vectors.length} vectors for ${chunks.length} chunks.`);
      }
      await embeddingService.deleteBySource(row.user_id, 'knowledge_base', row.id);
      for (let index = 0; index < chunks.length; index += 1) {
        await embeddingService.storePrecomputedEmbedding({
          userId: row.user_id,
          text: chunks[index],
          sourceType: 'knowledge_base',
          sourceId: row.id,
          provider: generated.provider as 'openai' | 'gemini',
          model: generated.model,
          vector: generated.vectors[index],
          metadata: {
            chunkIndex: index,
            title: row.title,
            sourceUrl: row.source_url,
            citation: `KB-${row.id}`,
          },
        });
        storedChunks += 1;
      }
      await db.execute(sql`
        UPDATE knowledge_base
        SET indexing_status = 'completed', updated_at = NOW()
        WHERE id = ${row.id} AND user_id = ${row.user_id}
      `);
      rebuiltEntries += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown embedding rebuild failure';
      failed.push({ entryId: row.id, error: message });
      logger.error({ err: error, userId: row.user_id, entryId: row.id }, '[KnowledgeEmbeddingRepair] Rebuild failed');
    }
  }

  return {
    rebuiltEntries,
    storedChunks,
    skippedEntryIds,
    failed,
    verification: await verifyKnowledgeBaseEmbeddings(options.userId),
  };
}
