import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { embeddingService } from '../embeddings/EmbeddingService.js';
import type { EmbeddingProvider } from '../embeddings/BaseEmbeddingProvider.js';
import { withKnowledgeAdminTransaction, withTenantKnowledgeTransaction } from './KnowledgeTenantTransaction.js';

interface ActiveIndex {
  id: number;
  versionKey: string;
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
}

async function activeIndex(): Promise<ActiveIndex | null> {
  const result = await db.execute(sql`
    SELECT iv.id, iv.version_key, iv.provider, iv.model, iv.dimensions
    FROM knowledge_runtime_settings rs
    JOIN knowledge_index_versions iv ON iv.id = rs.active_index_version_id AND iv.state = 'active'
    WHERE rs.id = 1
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? {
    id: Number(row.id), versionKey: String(row.version_key),
    provider: String(row.provider) as EmbeddingProvider,
    model: String(row.model), dimensions: Number(row.dimensions),
  } : null;
}

class KnowledgeMaintenanceService {
  async run(): Promise<Record<string, unknown>> {
    const index = await activeIndex();
    if (!index) {
      const expired = await withKnowledgeAdminTransaction(tx => tx.execute(sql`
        DELETE FROM knowledge_retrieval_audits WHERE expires_at <= NOW() RETURNING id
      `)) as {rows:unknown[]};
      return {
        indexVersion: null,
        maintenanceSkipped: true,
        skipReason: 'active_index_missing',
        repairedVersions: 0,
        repairedChunks: 0,
        failures: [],
        expiredAuditsDeleted: expired.rows.length,
        actionRequired: [{
          required_action: 'configure_active_knowledge_index',
          message: 'Select and activate a knowledge embedding index before running document maintenance.',
        }],
      };
    }
    const tenantResult = await withKnowledgeAdminTransaction((tx) => tx.execute(sql`
      SELECT DISTINCT user_id FROM knowledge_documents ORDER BY user_id
    `)) as { rows: unknown[] };
    const tenants = tenantResult.rows.map((row: unknown) => Number((row as Record<string, unknown>).user_id));
    let repairedVersions = 0;
    let repairedChunks = 0;
    const failures: Array<{ userId: number; versionId: number; error: string }> = [];

    for (const userId of tenants) {
      const candidates = await withTenantKnowledgeTransaction(userId, (tx) => tx.execute(sql`
        SELECT v.id AS version_id,
               json_agg(json_build_object('chunkId', c.id, 'searchText', c.search_text) ORDER BY c.ordinal) AS chunks
        FROM knowledge_document_versions v
        JOIN knowledge_chunks c ON c.version_id = v.id AND c.user_id = v.user_id
        LEFT JOIN knowledge_chunk_embeddings e
          ON e.chunk_id = c.id AND e.user_id = c.user_id AND e.index_version_id = ${index.id}
        WHERE v.user_id = ${userId}
          AND v.status IN ('ready_for_review', 'published', 'published_degraded')
          AND e.id IS NULL
        GROUP BY v.id
        ORDER BY v.id
        LIMIT 100
      `)) as { rows: unknown[] };
      for (const candidate of candidates.rows as Array<Record<string, unknown>>) {
        const versionId = Number(candidate.version_id);
        const chunks = Array.isArray(candidate.chunks)
          ? candidate.chunks as Array<{ chunkId: number; searchText: string }>
          : [];
        if (!chunks.length) continue;
        try {
          const generated = await embeddingService.generateEmbeddingsBatch(
            chunks.map((chunk) => String(chunk.searchText)), userId, index.provider, index.model,
          );
          if (generated.dimensions !== index.dimensions || generated.vectors.length !== chunks.length) {
            throw new Error('Embedding repair response does not match the active index.');
          }
          await withTenantKnowledgeTransaction(userId, async (tx) => {
            for (let offset = 0; offset < chunks.length; offset += 1) {
              const vector = generated.vectors[offset];
              if (!vector.every(Number.isFinite)) throw new Error('Embedding repair returned a non-finite vector.');
              const vectorLiteral = `[${vector.join(',')}]`;
              await tx.execute(sql`
                INSERT INTO knowledge_chunk_embeddings(
                  user_id, chunk_id, index_version_id, provider, model,
                  dimensions, content_hash, embedding, metadata
                ) VALUES (
                  ${userId}, ${chunks[offset].chunkId}, ${index.id}, ${index.provider}, ${index.model},
                  ${index.dimensions}, ${crypto.createHash('sha256').update(chunks[offset].searchText).digest('hex')},
                  ${sql.raw(`'${vectorLiteral}'::vector`)},
                  ${JSON.stringify({ repaired: true, indexVersion: index.versionKey })}::jsonb
                )
                ON CONFLICT (chunk_id, index_version_id) DO NOTHING
              `);
            }
            await tx.execute(sql`
              UPDATE knowledge_document_versions
              SET vector_index_status = 'completed',
                  status = CASE WHEN status = 'published_degraded' THEN 'published' ELSE status END,
                  diagnostics = COALESCE(diagnostics, '{}'::jsonb) || ${JSON.stringify({ repairedIndexVersion: index.versionKey })}::jsonb
              WHERE id = ${versionId} AND user_id = ${userId}
            `);
          });
          repairedVersions += 1;
          repairedChunks += chunks.length;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ userId, versionId, error: message });
          logger.warn({ err: error, userId, versionId }, '[KnowledgeMaintenance] Index repair failed');
        }
      }
    }

    const operations = await withKnowledgeAdminTransaction(async (tx) => {
      // A failed historical attempt is retained but explicitly classified when
      // the stable document has a newer published version. Current failures and
      // quarantines remain visible for human review and are never auto-published.
      const superseded = await tx.execute(sql`
        UPDATE knowledge_document_versions v
        SET diagnostics = COALESCE(v.diagnostics, '{}'::jsonb) || jsonb_build_object(
          'maintenanceDisposition', 'superseded_failed_version',
          'maintenanceReviewedAt', NOW()
        )
        FROM knowledge_documents d
        WHERE v.document_id = d.id AND v.user_id = d.user_id
          AND v.status = 'failed'
          AND d.current_published_version_id IS NOT NULL
          AND d.current_published_version_id <> v.id
          AND COALESCE(v.diagnostics->>'maintenanceDisposition', '') <> 'superseded_failed_version'
        RETURNING v.id
      `);
      const reviewable = await tx.execute(sql`
        UPDATE knowledge_document_versions v
        SET status = 'ready_for_review',
            diagnostics = COALESCE(v.diagnostics, '{}'::jsonb) || jsonb_build_object(
              'maintenanceDisposition', 'recovered_requires_review',
              'maintenanceReviewedAt', NOW()
            )
        WHERE v.status = 'failed'
          AND v.extraction_status = 'completed'
          AND v.lexical_index_status = 'completed'
          AND EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.version_id = v.id AND c.user_id = v.user_id)
        RETURNING v.id
      `);
      const actionRequired = await tx.execute(sql`
        SELECT v.id, v.user_id, v.status,
               CASE WHEN v.status = 'quarantined' THEN 'privacy_or_integrity_review'
                    ELSE 'extraction_or_index_repair' END AS required_action
        FROM knowledge_document_versions v
        JOIN knowledge_documents d ON d.id = v.document_id AND d.user_id = v.user_id
        WHERE v.status IN ('failed', 'quarantined')
          AND (v.status = 'quarantined' OR d.current_published_version_id IS NULL OR d.current_published_version_id = v.id)
        ORDER BY v.id
        LIMIT 500
      `);
      const diagnostics = await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::int AS stale_versions,
          COUNT(*) FILTER (WHERE review_due_at IS NOT NULL AND review_due_at <= NOW())::int AS review_due_versions,
          COUNT(*) FILTER (WHERE vector_index_status = 'failed')::int AS failed_vector_versions
        FROM knowledge_document_versions
        WHERE status IN ('ready_for_review', 'published', 'published_degraded')
      `);
      const deleted = await tx.execute(sql`
        DELETE FROM knowledge_retrieval_audits WHERE expires_at <= NOW() RETURNING id
      `);
      return {
        ...(diagnostics.rows[0] as Record<string, unknown>),
        expiredAuditsDeleted: deleted.rows.length,
        supersededFailuresClassified: superseded.rows.length,
        recoveredVersionsReadyForReview: reviewable.rows.length,
        actionRequired: actionRequired.rows,
      };
    });

    return { indexVersion: index.versionKey, tenants: tenants.length, repairedVersions, repairedChunks, failures, ...operations };
  }
}

export const knowledgeMaintenanceService = new KnowledgeMaintenanceService();
