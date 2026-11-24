import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { redactPiiWithStableTokens } from '../agents/orchestration/PrivacyVaultService.js';
import { embeddingService } from '../embeddings/EmbeddingService.js';
import { withTenantSupportMediaTransaction } from './SupportMediaTenantTransaction.js';
import type { MediaEvidence, MediaQuery, MediaRetrievalResult, SupportMediaDecision, VerifiedSupportMedia } from './types.js';
import { publishedMediaAssetAccess, type SupportMediaAccessContext } from './SupportMediaAccess.js';
import { selectRelevantMediaCandidates } from './MediaRelevanceSelector.js';
import { resultRows } from '../../utils/queryRows.js';

function textArrayExpression(value: string[], max = 100) {
  const clean = [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, max);
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(clean)}::jsonb))`;
}

type MediaCandidateRow = Record<string, unknown> & {
  asset_id: unknown;
  evidence_id: unknown;
  gallery_id: unknown;
  gallery_version_id: unknown;
  name: unknown;
  owner_description: unknown;
  alt_text: unknown;
  owner_tags: unknown;
  entity_tags: unknown;
  gallery_title: unknown;
  score: unknown;
};

const MEDIA_STOP_WORDS = new Set([
  'a','an','and','are','can','could','for','from','have','how','i','image','images','look','me','of','or',
  'photo','photos','picture','pictures','please','see','send','share','show','the','this','to','view','what','with','you',
]);

export function buildMediaLexicalTsQuery(text: string): string {
  const terms = redactPiiWithStableTokens(text).redactedText.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  return [...new Set(terms.filter((term) => !MEDIA_STOP_WORDS.has(term)))].slice(0, 16).map((term) => `${term}:*`).join(' | ');
}

export function diversifyMediaCandidates<T extends { gallery_id: unknown }>(rows: T[], limit: number): T[] {
  const boundedLimit = Math.max(0, Math.min(limit, 5));
  if (!boundedLimit || !rows.length) return [];
  const byGallery = new Map<number, T[]>();
  for (const row of rows) {
    const galleryId = Number(row.gallery_id);
    const group = byGallery.get(galleryId) || [];
    group.push(row);
    byGallery.set(galleryId, group);
  }
  const selected: T[] = [];
  for (let round = 0; selected.length < boundedLimit; round++) {
    let added = false;
    for (const group of byGallery.values()) {
      const candidate = group[round];
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length >= boundedLimit) break;
    }
    if (!added) break;
  }
  return selected;
}

export class MediaGateway {
  async retrieve(query: MediaQuery): Promise<MediaRetrievalResult> {
    const started = Date.now();
    const entityText = Object.values(query.entities || {}).flatMap((value) => Array.isArray(value) ? value : [value]).join(' ');
    const cleanQuery = redactPiiWithStableTokens(`${query.redactedText}\n${entityText}`).redactedText.slice(0, 2_000);
    const lexicalQuery = buildMediaLexicalTsQuery(cleanQuery);
    const queryFingerprint = crypto.createHash('sha256').update(`${query.tenantId}:${cleanQuery}`).digest('hex');
    if (process.env.SUPPORT_MEDIA_V1_ENABLED === 'false' || query.mediaIntent === 'none') {
      return { intent: query.mediaIntent, status: 'none', evidence: [], reason: 'Media retrieval is disabled or not needed.', diagnostics: { queryFingerprint, candidateCount: 0, latencyMs: Date.now() - started } };
    }
    if (!lexicalQuery) {
      return { intent: query.mediaIntent, status: 'insufficient', evidence: [], reason: 'The visual request did not identify an entity to retrieve.', diagnostics: { queryFingerprint, candidateCount: 0, latencyMs: Date.now() - started } };
    }
    try {
      let vectorSearch: { indexId: number; dimensions: number; literal: string } | null = null;
      try {
        const indexResult = await db.execute(sql`
          SELECT iv.id,iv.provider,iv.model,iv.dimensions FROM knowledge_runtime_settings rs
          JOIN knowledge_index_versions iv ON iv.id=rs.active_index_version_id AND iv.state='active'
          WHERE rs.id=1 LIMIT 1
        `);
        const index = indexResult.rows[0] as Record<string, unknown> | undefined;
        if (index) {
          const generated = await embeddingService.generateEmbedding({ text: cleanQuery,
            provider: String(index.provider) as 'openai' | 'gemini', model: String(index.model), userId: query.tenantId });
          if (generated.dimensions === Number(index.dimensions) && generated.vector.every(Number.isFinite)) {
            vectorSearch = { indexId: Number(index.id), dimensions: generated.dimensions, literal: `[${generated.vector.join(',')}]` };
          }
        }
      } catch { /* lexical retrieval remains authoritative during embedding outages */ }
      const raw = await withTenantSupportMediaTransaction(query.tenantId, async (tx) => {
        const lexicalRows = resultRows(await tx.execute(sql`
          WITH candidates AS (
            SELECT a.id AS asset_id,a.evidence_id,a.gallery_id,a.gallery_version_id,a.name,g.title AS gallery_title,
                   a.owner_description,a.alt_text,a.owner_tags,g.entity_tags,
                   GREATEST(
                     ts_rank_cd(a.search_tsv, to_tsquery('simple', ${lexicalQuery})),
                     CASE WHEN a.name ILIKE ${`%${cleanQuery.slice(0, 180)}%`} THEN 1 ELSE 0 END,
                     CASE WHEN a.owner_tags && regexp_split_to_array(lower(${cleanQuery}), '\\s+') THEN 0.9 ELSE 0 END,
                     CASE WHEN g.entity_tags && regexp_split_to_array(lower(${cleanQuery}), '\\s+') THEN 0.85 ELSE 0 END
                   ) AS score
            FROM support_media_assets a
            JOIN support_media_galleries g ON g.id=a.gallery_id AND g.user_id=a.user_id
            JOIN support_media_gallery_versions v ON v.id=a.gallery_version_id AND v.user_id=a.user_id
            WHERE ${publishedMediaAssetAccess(query)}
              AND (${query.mediaIntent}='explicit' OR g.helpful_auto_attach=TRUE)
              AND (a.search_tsv @@ to_tsquery('simple', ${lexicalQuery})
                OR a.name ILIKE ${`%${cleanQuery.slice(0, 180)}%`}
                OR a.owner_tags && regexp_split_to_array(lower(${cleanQuery}), '\\s+')
                OR g.entity_tags && regexp_split_to_array(lower(${cleanQuery}), '\\s+'))
              AND NOT EXISTS (
                SELECT 1 FROM support_media_delivery_parts sent
                WHERE sent.user_id=a.user_id AND sent.conversation_id=${query.conversationId || null}
                  AND sent.asset_id=a.id AND sent.status IN ('sent','provider_acknowledged')
                  AND ${query.mediaIntent}<>'explicit'
              )
          ), diversified AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY gallery_id ORDER BY score DESC, asset_id) AS gallery_rank
            FROM candidates
          )
          SELECT * FROM diversified ORDER BY CASE WHEN gallery_rank<=3 THEN 0 ELSE 1 END, score DESC, asset_id LIMIT 20
        `)) as MediaCandidateRow[];
        let vectorRows: MediaCandidateRow[] = [];
        if (vectorSearch) {
          const distance = vectorSearch.dimensions === 3072
            ? sql.raw(`e.embedding::halfvec(3072) <=> '${vectorSearch.literal}'::halfvec(3072)`)
            : vectorSearch.dimensions === 1536
              ? sql.raw(`e.embedding::vector(1536) <=> '${vectorSearch.literal}'::vector(1536)`)
              : vectorSearch.dimensions === 768
                ? sql.raw(`e.embedding::vector(768) <=> '${vectorSearch.literal}'::vector(768)`)
                : sql.raw(`e.embedding <=> '${vectorSearch.literal}'::vector`);
          vectorRows = resultRows(await tx.execute(sql`
            SELECT a.id AS asset_id,a.evidence_id,a.gallery_id,a.gallery_version_id,a.name,g.title AS gallery_title,
                   a.owner_description,a.alt_text,a.owner_tags,g.entity_tags,1-(${distance}) AS score
            FROM support_media_asset_embeddings e
            JOIN support_media_assets a ON a.id=e.asset_id AND a.user_id=e.user_id
            JOIN support_media_galleries g ON g.id=a.gallery_id AND g.user_id=a.user_id
            JOIN support_media_gallery_versions v ON v.id=a.gallery_version_id AND v.user_id=a.user_id
            WHERE ${publishedMediaAssetAccess(query)}
              AND e.user_id=${query.tenantId} AND e.index_version_id=${vectorSearch.indexId}
              AND (${query.mediaIntent}='explicit' OR g.helpful_auto_attach=TRUE)
              AND 1-(${distance})>=0.40
            ORDER BY score DESC,a.id LIMIT 20
          `)) as MediaCandidateRow[];
        }
        const fused = new Map<number, MediaCandidateRow & { fusion_score: number }>();
        lexicalRows.forEach((row, rank) => fused.set(Number(row.asset_id), { ...row, fusion_score: 1 / (60 + rank + 1) }));
        vectorRows.forEach((row, rank) => {
          const assetId = Number(row.asset_id);
          const existing = fused.get(assetId);
          fused.set(assetId, { ...(existing || row), score: Math.max(Number(existing?.score || 0), Number(row.score || 0)),
            fusion_score: Number(existing?.fusion_score || 0) + 1 / (60 + rank + 1) });
        });
        return [...fused.values()].sort((a, b) => b.fusion_score - a.fusion_score || Number(b.score) - Number(a.score));
      });
      const threshold = query.mediaIntent === 'explicit' ? 0.01 : 0.08;
      const eligible = raw.filter((row) => Number(row.score) >= threshold);
      // Do not hold a tenant DB connection while waiting for the model. Current
      // publication/channel authorization is checked again by verify before use.
      const entityScoped = await selectRelevantMediaCandidates({
        userId: query.tenantId, request: query.redactedText, rows: eligible,
      });
      const evidence: MediaEvidence[] = diversifyMediaCandidates(entityScoped, query.limit).map((row) => ({
          evidenceId: String(row.evidence_id), galleryId: Number(row.gallery_id), galleryVersionId: Number(row.gallery_version_id),
          assetId: Number(row.asset_id), name: String(row.name),
          ownerDescription: row.owner_description ? String(row.owner_description) : undefined,
          altText: String(row.alt_text),
          entityTags: [...(Array.isArray(row.owner_tags) ? row.owner_tags : []), ...(Array.isArray(row.entity_tags) ? row.entity_tags : [])].map(String),
          score: Number(row.score),
      }));
      await withTenantSupportMediaTransaction(query.tenantId, async (tx) => {
        await tx.execute(sql`
          INSERT INTO support_media_retrieval_audits(user_id,business_profile_id,conversation_id,purpose,channel,media_intent,
            query_fingerprint,candidate_count,selected_evidence_ids,decision_reason,latency_ms)
          VALUES (${query.tenantId},${query.businessProfileId || null},${query.conversationId || null},${query.purpose},${query.channel},${query.mediaIntent},
            ${queryFingerprint},${raw.length},${textArrayExpression(evidence.map((item) => item.evidenceId), 5)},${evidence.length ? 'AI-relevant published media selected.' : 'No relevant published media passed selection.'},${Date.now() - started})
        `);
      });
      return { intent: query.mediaIntent, status: evidence.length ? 'selected' : 'insufficient', evidence,
        reason: evidence.length ? 'Published owner media passed authorization filters and AI relevance selection.' : 'No relevant published media was found.',
        diagnostics: { queryFingerprint, candidateCount: raw.length, latencyMs: Date.now() - started } };
    } catch {
      return { intent: query.mediaIntent, status: 'unavailable', evidence: [], reason: 'Media retrieval is unavailable.', diagnostics: { queryFingerprint, candidateCount: 0, latencyMs: Date.now() - started } };
    }
  }

  buildDecision(result: MediaRetrievalResult): SupportMediaDecision {
    return {
      intent: result.intent,
      reason: result.reason,
      selections: result.evidence.map((item, order) => ({
        evidenceId: item.evidenceId,
        caption: item.ownerDescription || item.name,
        order,
      })),
    };
  }

  async verify(userId: number, channel: string, decision: SupportMediaDecision,
    context: Omit<SupportMediaAccessContext, 'tenantId' | 'channel'>): Promise<VerifiedSupportMedia[]> {
    if (!context || !decision.selections.length || decision.intent === 'none') return [];
    const verifiedIntent: 'helpful' | 'explicit' = decision.intent;
    const ids = decision.selections.slice(0, 5).map((item) => item.evidenceId);
    return withTenantSupportMediaTransaction(userId, async (tx) => {
      const rows = resultRows(await tx.execute(sql`
        SELECT a.id,a.evidence_id,a.gallery_id,a.gallery_version_id,a.name,a.owner_description,a.alt_text,
               a.checksum,a.derivative_storage_file_id,a.mime_type
        FROM support_media_assets a
        JOIN support_media_galleries g ON g.id=a.gallery_id AND g.user_id=a.user_id
        JOIN support_media_gallery_versions v ON v.id=a.gallery_version_id AND v.user_id=a.user_id
        WHERE ${publishedMediaAssetAccess({ ...context, tenantId: userId, channel })}
          AND a.evidence_id=ANY(${textArrayExpression(ids, 5)})
          AND (${decision.intent} = 'explicit' OR g.helpful_auto_attach = TRUE)
      `));
      const byId = new Map(rows.map((row) => [String(row.evidence_id), row]));
      return decision.selections.slice(0, 5).flatMap((selection) => {
        const row = byId.get(selection.evidenceId);
        if (!row) return [];
        return [{ evidenceId: String(row.evidence_id), assetId: Number(row.id), galleryId: Number(row.gallery_id),
          galleryVersionId: Number(row.gallery_version_id), name: String(row.name),
          // Captions are owner-authored only; model-provided caption text is ignored.
          caption: row.owner_description ? String(row.owner_description) : String(row.name), altText: String(row.alt_text),
          checksum: String(row.checksum), derivativeStorageFileId: Number(row.derivative_storage_file_id),
          mimeType: String(row.mime_type), intent: verifiedIntent } satisfies VerifiedSupportMedia];
      });
    });
  }
}

export const mediaGateway = new MediaGateway();
