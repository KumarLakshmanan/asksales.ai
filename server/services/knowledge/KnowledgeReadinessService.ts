import { sql } from 'drizzle-orm';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { withTenantKnowledgeTransaction } from './KnowledgeTenantTransaction.js';
import { knowledgeIntegerArray, knowledgeTextArray } from './KnowledgeSql.js';
import { retrievalScopesForPurpose } from './KnowledgeRetrievalPolicy.js';
import type { KnowledgeQuery } from './types.js';

type Row = Record<string, unknown>;
const permittedPrivacy = new Set(['public', 'business', 'internal']);

/** Owner diagnostics only. Never use this as retrieval authorization. */
export function describeKnowledgeReadiness(row: Row) {
  const chunkCount = Number(row.chunk_count || 0);
  const embeddedChunkCount = Number(row.embedded_chunk_count || 0);
  const privacyBlocked = !permittedPrivacy.has(String(row.privacy_classification))
    || (chunkCount > 0 && Number(row.privacy_blocked_chunks) === chunkCount);
  const usable = Number(row.usable_chunks || 0);
  const published = ['published', 'published_degraded'].includes(String(row.status));
  const status = privacyBlocked ? 'privacy_blocked'
    : chunkCount > 0 && usable === 0 ? 'safety_blocked'
    : !row.is_live || !published ? 'not_published'
    : row.expired ? 'expired' : row.scheduled ? 'scheduled'
    : !chunkCount || row.lexical_index_status !== 'completed' ? 'not_indexed'
    : usable < chunkCount ? 'partially_blocked' : 'available';
  return {
    status, versionId: Number(row.id), versionNo: Number(row.version_no), isLive: Boolean(row.is_live),
    privacyClassification: String(row.privacy_classification), chunkCount, embeddedChunkCount,
    activeIndexId: row.active_index_id == null ? null : Number(row.active_index_id),
    embeddingModel: row.active_model == null ? null : String(row.active_model),
    lexicalIndexStatus: String(row.lexical_index_status || 'pending'),
    semanticIndexStatus: !row.active_index_id ? 'unavailable'
      : chunkCount > 0 && embeddedChunkCount === chunkCount ? 'completed' : 'incomplete',
  };
}

// Correlated with d and v; count actual embeddings in the active index, never
// legacy content JSON or another index's embeddings.
function readinessColumns() {
  return sql`v.id, v.version_no, v.status, v.privacy_classification, v.lexical_index_status,
    v.id = d.current_published_version_id AS is_live,
    v.expires_at <= NOW() AS expired, v.effective_at > NOW() AS scheduled,
    iv.id AS active_index_id, iv.model AS active_model,
    (SELECT count(*)::int FROM knowledge_chunks c WHERE c.version_id=v.id AND c.document_id=d.id AND c.user_id=d.user_id) AS chunk_count,
    (SELECT count(*)::int FROM knowledge_chunks c WHERE c.version_id=v.id AND c.document_id=d.id AND c.user_id=d.user_id
      AND c.sensitivity NOT IN ('public','business','internal')) AS privacy_blocked_chunks,
    (SELECT count(*)::int FROM knowledge_chunks c WHERE c.version_id=v.id AND c.document_id=d.id AND c.user_id=d.user_id
      AND c.sensitivity IN ('public','business','internal') AND cardinality(c.injection_flags)=0) AS usable_chunks,
    (SELECT count(*)::int FROM knowledge_chunks c WHERE c.version_id=v.id AND c.document_id=d.id AND c.user_id=d.user_id
      AND EXISTS (SELECT 1 FROM knowledge_chunk_embeddings e WHERE e.chunk_id=c.id AND e.user_id=c.user_id
        AND e.index_version_id=iv.id AND e.dimensions=iv.dimensions AND e.model=iv.model AND e.provider=iv.provider)) AS embedded_chunk_count`;
}
function activeIndexJoin() {
  return sql`LEFT JOIN knowledge_runtime_settings rs ON rs.id=1
    LEFT JOIN knowledge_index_versions iv ON iv.id=rs.active_index_version_id AND iv.state='active'`;
}

export const knowledgeReadinessService = {
  async entries(userId: number, entryIds: number[]): Promise<Map<number, ReturnType<typeof describeKnowledgeReadiness>>> {
    if (!entryIds.length) return new Map<number, ReturnType<typeof describeKnowledgeReadiness>>();
    return withTenantKnowledgeTransaction(userId, async tx => {
      const result = await tx.execute(sql`SELECT d.legacy_entry_id, ${readinessColumns()}
        FROM knowledge_documents d JOIN LATERAL (
          SELECT v.* FROM knowledge_document_versions v WHERE v.document_id=d.id AND v.user_id=d.user_id
          ORDER BY COALESCE(v.id=d.current_published_version_id,FALSE) DESC, v.version_no DESC LIMIT 1
        ) v ON TRUE ${activeIndexJoin()}
        WHERE d.user_id=${userId} AND d.deleted_at IS NULL AND d.legacy_entry_id=ANY(${knowledgeIntegerArray(entryIds)})`);
      return new Map(result.rows.map((row: Row) => [Number(row.legacy_entry_id), describeKnowledgeReadiness(row)]));
    });
  },

  async versions(userId: number, entryId: number): Promise<Map<number, ReturnType<typeof describeKnowledgeReadiness>>> {
    return withTenantKnowledgeTransaction(userId, async tx => {
      const result = await tx.execute(sql`SELECT ${readinessColumns()}
        FROM knowledge_documents d JOIN knowledge_document_versions v ON v.document_id=d.id AND v.user_id=d.user_id
        ${activeIndexJoin()} WHERE d.user_id=${userId} AND d.legacy_entry_id=${entryId} AND d.deleted_at IS NULL`);
      return new Map(result.rows.map((row: Row) => [Number(row.id), describeKnowledgeReadiness(row)]));
    });
  },

  async extractedText(userId: number, entryId: number) {
    return withTenantKnowledgeTransaction(userId, async tx => {
      const result = await tx.execute(sql`SELECT ${readinessColumns()}, v.normalized_content,
        COALESCE((SELECT jsonb_agg(preview ORDER BY preview.ordinal) FROM (
          SELECT c.ordinal, left(c.display_text,250000) AS text, c.char_start, c.char_end, c.token_count,
            EXISTS (SELECT 1 FROM knowledge_chunk_embeddings e WHERE e.chunk_id=c.id AND e.user_id=c.user_id
              AND e.index_version_id=iv.id AND e.dimensions=iv.dimensions AND e.model=iv.model AND e.provider=iv.provider) AS has_embedding
          FROM knowledge_chunks c WHERE c.version_id=v.id AND c.document_id=d.id AND c.user_id=d.user_id
          ORDER BY c.ordinal LIMIT 200
        ) preview),'[]'::jsonb) AS chunks
        FROM knowledge_documents d JOIN LATERAL (
          SELECT v.* FROM knowledge_document_versions v WHERE v.document_id=d.id AND v.user_id=d.user_id
          ORDER BY COALESCE(v.id=d.current_published_version_id,FALSE) DESC, v.version_no DESC LIMIT 1
        ) v ON TRUE ${activeIndexJoin()}
        WHERE d.user_id=${userId} AND d.legacy_entry_id=${entryId} AND d.deleted_at IS NULL`);
      const row = result.rows[0] as Row | undefined;
      if (!row) return null;
      const readiness = describeKnowledgeReadiness(row);
      let remaining = 250000;
      const chunks = (row.chunks as Row[]).flatMap(chunk => {
        if (remaining <= 0) return [];
        const text = String(chunk.text).slice(0, remaining);
        remaining -= text.length;
        return [{ index: Number(chunk.ordinal), text, charStart: Number(chunk.char_start || 0),
          charEnd: Number(chunk.char_end || text.length), tokenEstimate: Number(chunk.token_count),
          hasEmbedding: Boolean(chunk.has_embedding) }];
      });
      return { extractedText: String(row.normalized_content || '').slice(0,250000), chunks,
        readiness, versionId: readiness.versionId, versionNo: readiness.versionNo,
        embeddingsGenerated: readiness.semanticIndexStatus === 'completed', embeddingModel: readiness.embeddingModel,
        extractionSource: readiness.isLive ? 'published_version' : 'latest_version',
        extractionWarnings: readiness.chunkCount > chunks.length || remaining === 0 ? ['Preview truncated.'] : [] };
    });
  },

  /** Scope-level counts, deliberately independent of the question. No blocked
   * source titles, excerpts, identifiers or match claims leave this method. */
  async retrievalDiagnostics(query: KnowledgeQuery) {
    const profileId = query.businessProfileId ?? currentBusinessScope()?.businessProfileId ?? null;
    const customer = query.audience === 'customer';
    return withTenantKnowledgeTransaction(query.tenantId, async tx => {
      const result = await tx.execute(sql`SELECT ${readinessColumns()}
        FROM knowledge_documents d JOIN knowledge_document_versions v
          ON v.id=d.current_published_version_id AND v.document_id=d.id AND v.user_id=d.user_id
        ${activeIndexJoin()} WHERE d.user_id=${query.tenantId} AND d.deleted_at IS NULL
          AND v.status IN ('published','published_degraded')
          AND (v.effective_at IS NULL OR v.effective_at<=NOW()) AND (v.expires_at IS NULL OR v.expires_at>NOW())
          AND d.usage_scopes && ${knowledgeTextArray(retrievalScopesForPurpose(query.purpose))}
          AND (cardinality(d.allowed_channels)=0 OR ${query.channel}=ANY(d.allowed_channels))
          AND (${customer}=FALSE OR (d.audience='customer' AND d.access_scope<>'staff_only'))
          AND (${customer}=TRUE OR d.audience IN ('customer','internal'))
          AND (${query.entities?.locale || null}::text IS NULL OR d.locale IS NULL OR d.locale=${query.entities?.locale || null})
          AND ${profileId === null ? sql`d.business_profile_id IS NULL AND d.access_scope<>'business_profile'`
            : sql`(d.business_profile_id IS NULL OR d.business_profile_id=${profileId})`}`);
      const states: ReturnType<typeof describeKnowledgeReadiness>[] = result.rows.map((row: Row) => describeKnowledgeReadiness(row));
      return { scopeOnly: true, privacyBlockedSources: states.filter(item => item.status === 'privacy_blocked').length,
        safetyBlockedSources: states.filter(item => item.status === 'safety_blocked').length,
        indexingBlockedSources: states.filter(item => item.status === 'not_indexed').length };
    });
  },
};
