import { sql } from 'drizzle-orm';
import { withTenantKnowledgeTransaction } from './KnowledgeTenantTransaction.js';
import { knowledgeGovernanceService } from './KnowledgeGovernanceService.js';
import { isPositiveSafeInteger as validId } from '../../../shared/numbers.js';

interface SupportKnowledgeMember { id: number; userId: number; teamId: number; businessProfileId?: number | null }
interface ListOptions { page: number; limit: number; search: string; type: string }
interface PublishedRow {
  id: number; source_type: string; created_at: string; body: string;
  published_title?: string; published_source_url?: string; version_no?: number; audience?: string;
  allowed_channels?: string[]; locale?: string; vector_index_status?: string;
}
interface DisplayChunk {
  ordinal: number; display_text: string; char_start: number | null;
  char_end: number | null; token_count: number;
}

const TEXT_LIMIT = 250_000;
const CHUNK_LIMIT = 200;
const validMember = (member: SupportKnowledgeMember) => member
  && validId(member.id) && validId(member.userId) && validId(member.teamId);

function membership(member: SupportKnowledgeMember) {
  return sql`EXISTS (
    SELECT 1 FROM team_members m
    JOIN support_teams t ON t.id = m.team_id AND t.user_id = m.user_id
    WHERE m.id = ${member.id} AND m.user_id = ${member.userId}
      AND m.team_id = ${member.teamId} AND m.is_active = TRUE AND t.is_active = TRUE
  )`;
}

/** A member has tenant staff access, but no business-profile authorization context.
 * Metadata on knowledge_documents is mutable during ingestion, so only version
 * display chunks supply user-visible text. Never fall back to legacy/raw content.
 */
function visibleKnowledge(member: SupportKnowledgeMember) {
  return sql`
    WITH visible_documents AS (
      SELECT d.id AS document_id, d.legacy_entry_id AS id, d.source_type,
             v.id AS version_id, v.version_no, v.created_at, v.vector_index_status,
             v.diagnostics->'publicationMetadata'->>'title' AS published_title,
             v.diagnostics->'publicationMetadata'->>'sourceUrl' AS published_source_url,
             d.audience, d.allowed_channels, d.locale
      FROM knowledge_documents d
      JOIN knowledge_document_versions v
        ON v.id = d.current_published_version_id AND v.document_id = d.id AND v.user_id = d.user_id
      WHERE d.user_id = ${member.userId} AND ${membership(member)}
        AND d.legacy_entry_id IS NOT NULL
        AND v.status IN ('published', 'published_degraded')
        AND (v.effective_at IS NULL OR v.effective_at <= NOW())
        AND (v.expires_at IS NULL OR v.expires_at > NOW())
        AND v.privacy_classification IN ('public', 'business', 'internal')
        AND d.audience IN ('customer', 'internal')
        AND ${member.businessProfileId == null ? sql`d.access_scope IN ('tenant', 'staff_only') AND d.business_profile_id IS NULL`
          : sql`d.access_scope IN ('tenant', 'staff_only', 'business_profile') AND (d.business_profile_id IS NULL OR d.business_profile_id = ${member.businessProfileId})`}
        AND d.usage_scopes && ARRAY['support_answer', 'internal_assist']::text[]
        AND (cardinality(d.allowed_channels) = 0 OR 'support_portal' = ANY(d.allowed_channels))
    ), visible_chunks AS (
      SELECT c.* FROM knowledge_chunks c
      JOIN visible_documents d ON d.document_id = c.document_id AND d.version_id = c.version_id
      WHERE c.user_id = ${member.userId}
        AND ${member.businessProfileId == null ? sql`c.access_scope IN ('tenant', 'staff_only')` : sql`c.access_scope IN ('tenant', 'staff_only', 'business_profile')`}
        AND c.sensitivity IN ('public', 'business', 'internal')
        AND cardinality(c.injection_flags) = 0
    )
  `;
}

function preview(row: PublishedRow) {
  const body = row.body || '';
  const faq = row.source_type === 'qa' ? /^Q:\s*([\s\S]*?)\nA:\s*([\s\S]*)$/.exec(body) : null;
  return {
    id: Number(row.id),
    title: (row.published_title || faq?.[1] || body.split('\n')[0] || 'Published knowledge').replace(/^#{1,6}\s+/, '').slice(0, 255),
    description: null,
    type: row.source_type,
    processingStatus: 'completed',
    fileName: null, fileType: null, fileSize: null, sourceUrl: row.published_source_url || null,
    versionNo: row.version_no, audience: row.audience, allowedChannels: row.allowed_channels || [],
    locale: row.locale, vectorIndexStatus: row.vector_index_status,
    question: faq?.[1] || null,
    answer: row.source_type === 'qa' ? (faq?.[2] || body) : null,
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

class SupportMemberKnowledgeService {
  async list(member: SupportKnowledgeMember, options: ListOptions) {
    if (!validMember(member)) return null;
    if (!validId(options.page) || options.page > 100_000 || !validId(options.limit) || options.limit > 100
      || options.search.length > 200 || !['all', 'document', 'file', 'qa', 'url'].includes(options.type)) {
      throw new Error('Invalid knowledge-base query');
    }
    return withTenantKnowledgeTransaction(member.userId, async (tx) => {
      await knowledgeGovernanceService.activateDuePublications(member.userId, tx);
      const result = await tx.execute(sql`
        ${visibleKnowledge(member)}, matched AS (
          SELECT d.* FROM visible_documents d
          WHERE EXISTS (SELECT 1 FROM visible_chunks c WHERE c.document_id = d.document_id)
            AND ${options.type === 'all' ? sql`TRUE` : sql`d.source_type = ${options.type}`}
            AND ${options.search ? sql`(d.published_title ILIKE ${`%${options.search.replace(/[\\%_]/g, '\\$&')}%`} OR EXISTS (
              SELECT 1 FROM visible_chunks c WHERE c.document_id = d.document_id
                AND c.display_text ILIKE ${`%${options.search.replace(/[\\%_]/g, '\\$&')}%`}
            ))` : sql`TRUE`}
        ), page_rows AS (
          SELECT d.id, d.source_type, d.created_at, d.published_title, d.published_source_url, d.version_no,
                 d.audience, d.allowed_channels, d.locale, d.vector_index_status,
                 (SELECT left(string_agg(preview.display_text, E'\n\n' ORDER BY preview.ordinal), 12000)
                  FROM (SELECT c.display_text, c.ordinal FROM visible_chunks c
                        WHERE c.document_id = d.document_id ORDER BY c.ordinal LIMIT 4) preview) AS body
          FROM matched d ORDER BY d.created_at DESC, d.id DESC
          LIMIT ${options.limit} OFFSET ${(options.page - 1) * options.limit}
        )
        SELECT ${membership(member)} AS authorized,
          (SELECT count(*)::int FROM matched) AS total,
          COALESCE((SELECT jsonb_agg(p ORDER BY p.created_at DESC, p.id DESC) FROM page_rows p), '[]'::jsonb) AS entries
      `);
      const row = result.rows[0] as { authorized: boolean; total: number; entries: PublishedRow[] } | undefined;
      if (!row?.authorized) return null;
      return {
        entries: row.entries.map(preview), total: Number(row.total), page: options.page,
        totalPages: Math.max(1, Math.ceil(Number(row.total) / options.limit)),
      };
    });
  }

  async extractedText(member: SupportKnowledgeMember, entryId: number) {
    if (!validMember(member) || !validId(entryId)) return null;
    return withTenantKnowledgeTransaction(member.userId, async (tx) => {
      await knowledgeGovernanceService.activateDuePublications(member.userId, tx);
      const result = await tx.execute(sql`
        ${visibleKnowledge(member)}
        SELECT d.id, d.source_type, d.vector_index_status,
          (SELECT count(*)::int FROM visible_chunks c WHERE c.document_id = d.document_id) AS total_chunks,
          (SELECT jsonb_agg(p ORDER BY p.ordinal) FROM (
            SELECT c.ordinal, left(c.display_text, ${TEXT_LIMIT}) AS display_text,
                   c.char_start, c.char_end, c.token_count,
                   length(c.display_text) > ${TEXT_LIMIT} AS truncated,
                   EXISTS (SELECT 1 FROM knowledge_chunk_embeddings e
                           WHERE e.chunk_id = c.id AND e.user_id = ${member.userId}) AS has_embedding
            FROM visible_chunks c WHERE c.document_id = d.document_id
            ORDER BY c.ordinal LIMIT ${CHUNK_LIMIT}
          ) p) AS chunks
        FROM visible_documents d WHERE d.id = ${entryId}
          AND EXISTS (SELECT 1 FROM visible_chunks c WHERE c.document_id = d.document_id)
        LIMIT 1
      `);
      const row = result.rows[0] as {
        id: number; source_type: string; total_chunks: number; vector_index_status: string;
        chunks: Array<DisplayChunk & { truncated: boolean; has_embedding: boolean }>;
      } | undefined;
      if (!row) return null;
      let remaining = TEXT_LIMIT;
      let truncated = Number(row.total_chunks) > CHUNK_LIMIT;
      const chunks = row.chunks.flatMap((chunk) => {
        if (remaining <= 0) { truncated = true; return []; }
        const text = chunk.display_text.slice(0, remaining);
        remaining -= text.length;
        truncated ||= chunk.truncated || text.length < chunk.display_text.length;
        return [{ index: Number(chunk.ordinal), text,
          charStart: chunk.char_start ?? 0, charEnd: chunk.char_end ?? text.length,
          tokenEstimate: Number(chunk.token_count), hasEmbedding: Boolean(chunk.has_embedding) }];
      });
      const body = chunks.map((chunk) => chunk.text).join('\n\n');
      return {
        entryId: Number(row.id), fileName: null, type: row.source_type, processingStatus: 'completed',
        extractedText: body.slice(0, TEXT_LIMIT), chunks, totalChunks: Number(row.total_chunks),
        truncated: truncated || body.length > TEXT_LIMIT,
        embeddingsGenerated: row.vector_index_status === 'completed', embeddingModel: null,
        extractionSource: 'published_version', extractionWarnings: [],
      };
    });
  }
}

export const supportMemberKnowledgeService = new SupportMemberKnowledgeService();
