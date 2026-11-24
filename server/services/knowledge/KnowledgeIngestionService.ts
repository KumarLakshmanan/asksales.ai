import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import type { KnowledgeBaseEntry } from '../../models/knowledgeBase/schema.js';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { embeddingService } from '../embeddings/EmbeddingService.js';
import type { EmbeddingProvider } from '../embeddings/BaseEmbeddingProvider.js';
import { chunkStructuredKnowledge } from './KnowledgeChunker.js';
import { scanKnowledgeContent } from './KnowledgePrivacyService.js';
import { knowledgeTextArray } from './KnowledgeSql.js';
import { withTenantKnowledgeTransaction } from './KnowledgeTenantTransaction.js';
import { usageScopesForSourceType } from './KnowledgeRetrievalPolicy.js';
import type { KnowledgePublicationMetadata } from './KnowledgePublicationMetadata.js';
import { loadVerifiedBusinessContacts } from './KnowledgeBusinessContacts.js';
import { knowledgeSourceText } from './KnowledgeSourceText.js';

export interface KnowledgeIndexDescriptor {
  id: number;
  versionKey: string;
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
}

export interface KnowledgeVersionResult {
  documentId: number;
  versionId: number;
  status: string;
  chunkCount: number;
  vectorIndexed: boolean;
  quarantinedReasons: string[];
  skipped?: boolean;
}

async function activeIndexDescriptor(): Promise<KnowledgeIndexDescriptor | null> {
  try {
    const result = await db.execute(sql`
      SELECT iv.id, iv.version_key, iv.provider, iv.model, iv.dimensions
      FROM knowledge_runtime_settings rs
      JOIN knowledge_index_versions iv ON iv.id = rs.active_index_version_id
      WHERE rs.id = 1 AND iv.state = 'active'
      LIMIT 1
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      versionKey: String(row.version_key),
      provider: String(row.provider) as EmbeddingProvider,
      model: String(row.model),
      dimensions: Number(row.dimensions),
    };
  } catch {
    return null;
  }
}

async function ensureIndexDescriptor(input: {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
}): Promise<KnowledgeIndexDescriptor> {
  const versionKey = `${input.provider}:${input.model}:${input.dimensions}:v1`;
  const result = await db.execute(sql`
    INSERT INTO knowledge_index_versions(version_key, provider, model, dimensions, state, activated_at)
    VALUES (${versionKey}, ${input.provider}, ${input.model}, ${input.dimensions}, 'active', NOW())
    ON CONFLICT (version_key) DO UPDATE
      SET state = CASE WHEN knowledge_index_versions.state = 'failed' THEN 'building' ELSE knowledge_index_versions.state END
    RETURNING id, version_key, provider, model, dimensions
  `);
  const row = result.rows[0] as Record<string, unknown>;
  await db.execute(sql`
    UPDATE knowledge_runtime_settings
    SET active_index_version_id = COALESCE(active_index_version_id, ${Number(row.id)}),
        updated_at = NOW()
    WHERE id = 1
  `);
  return {
    id: Number(row.id),
    versionKey: String(row.version_key),
    provider: String(row.provider) as EmbeddingProvider,
    model: String(row.model),
    dimensions: Number(row.dimensions),
  };
}

class KnowledgeIngestionService {
  async indexLegacyEntry(
    entry: KnowledgeBaseEntry,
    options: { autoPublish?: boolean } = {},
  ): Promise<KnowledgeVersionResult> {
    const rawText = knowledgeSourceText(entry).trim();
    if (!rawText) throw new Error('Cannot create a knowledge version without extracted text.');

    const trustedBusinessContacts = await loadVerifiedBusinessContacts(entry.userId, entry.businessProfileId ?? null);
    const bodyPrivacy = scanKnowledgeContent(rawText, { trustedBusinessContacts });
    const metadataPrivacy = scanKnowledgeContent(`${entry.title}\n${entry.sourceUrl || ''}`, { trustedBusinessContacts });
    const privacy = {
      ...bodyPrivacy,
      classification: metadataPrivacy.mustQuarantine ? metadataPrivacy.classification
        : bodyPrivacy.mustQuarantine ? bodyPrivacy.classification
          : metadataPrivacy.containsPersonalData ? 'personal' : bodyPrivacy.classification,
      mustQuarantine: bodyPrivacy.mustQuarantine || metadataPrivacy.mustQuarantine,
      reasons: [...new Set([...bodyPrivacy.reasons, ...metadataPrivacy.reasons.map(reason => `metadata:${reason}`)])],
      injectionFlags: [...new Set([...bodyPrivacy.injectionFlags, ...metadataPrivacy.injectionFlags])],
    };
    const chunks = chunkStructuredKnowledge(rawText, { trustedBusinessContacts });
    if (!chunks.length) throw new Error('Knowledge ingestion produced no searchable chunks.');

    let generated: Awaited<ReturnType<typeof embeddingService.generateEmbeddingsBatch>> | null = null;
    let indexDescriptor = await activeIndexDescriptor();
    if (!privacy.mustQuarantine) {
      try {
        generated = await embeddingService.generateEmbeddingsBatch(
          chunks.map((chunk) => chunk.searchText),
          entry.userId,
          indexDescriptor?.provider,
          indexDescriptor?.model,
        );
        if (generated.vectors.length !== chunks.length) throw new Error('Embedding provider returned an incomplete chunk set.');
        if (generated.vectors.some(vector => vector.length !== generated!.dimensions || !vector.every(Number.isFinite))) {
          throw new Error('Embedding provider returned invalid vectors.');
        }
        if (!indexDescriptor) {
          indexDescriptor = await ensureIndexDescriptor({
            provider: generated.provider,
            model: generated.model,
            dimensions: generated.dimensions,
          });
        }
        if (indexDescriptor.dimensions !== generated.dimensions) {
          throw new Error('Active knowledge index dimensions do not match the embedding provider response.');
        }
      } catch (error) {
        generated = null;
        logger.warn({ err: error, userId: entry.userId, entryId: entry.id }, '[KnowledgeIngestion] Vector indexing degraded');
      }
    }

    return withTenantKnowledgeTransaction(entry.userId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-governance'), ${entry.userId})`);
      // A queued job must never resurrect a deleted entry.
      const liveEntry = await tx.execute(sql`SELECT id FROM knowledge_base WHERE id = ${entry.id} AND user_id = ${entry.userId}
        AND ${entry.updatedAt ? sql`date_trunc('milliseconds',updated_at)=${entry.updatedAt}` : sql`TRUE`} FOR UPDATE`);
      if (!liveEntry.rows.length) throw new Error(entry.updatedAt ? 'KNOWLEDGE_SOURCE_CHANGED' : 'KNOWLEDGE_ENTRY_NOT_FOUND');
      const existingDocument = await tx.execute(sql`
        SELECT * FROM knowledge_documents
        WHERE user_id = ${entry.userId} AND legacy_entry_id = ${entry.id}
        LIMIT 1
      `);
      let documentId = Number((existingDocument.rows[0] as Record<string, unknown> | undefined)?.id || 0);
      if (!documentId) {
        const inserted = await tx.execute(sql`
          INSERT INTO knowledge_documents(
            user_id, business_profile_id, legacy_entry_id, source_type, title,
            description, source_url, owner_user_id, audience, access_scope,
            usage_scopes
          ) VALUES (
            ${entry.userId}, ${entry.businessProfileId ?? null}, ${entry.id}, ${entry.type},
            ${entry.title}, ${entry.description ?? null}, ${entry.sourceUrl ?? null}, ${entry.userId},
            'customer', ${entry.businessProfileId ? 'business_profile' : 'tenant'},
            ${knowledgeTextArray(usageScopesForSourceType(entry.type))}
          )
          RETURNING id
        `);
        documentId = Number((inserted.rows[0] as Record<string, unknown>).id);
      }

      const document = existingDocument.rows[0] as Record<string, unknown> | undefined;
      let publicationMetadata: KnowledgePublicationMetadata = {
        title: metadataPrivacy.mustQuarantine ? 'Knowledge requiring privacy review'
          : scanKnowledgeContent(entry.title, { trustedBusinessContacts }).searchText,
        sourceUrl: metadataPrivacy.containsPersonalData || metadataPrivacy.mustQuarantine ? null : entry.sourceUrl ?? null,
        businessProfileId: entry.businessProfileId ?? null,
        audience: document?.audience === 'internal' ? 'internal' : 'customer',
        accessScope: document?.access_scope === 'staff_only' ? 'staff_only' : entry.businessProfileId ? 'business_profile' : 'tenant',
        usageScopes: Array.isArray(document?.usage_scopes) ? document.usage_scopes.map(String) : usageScopesForSourceType(entry.type),
        allowedChannels: Array.isArray(document?.allowed_channels) ? document.allowed_channels.map(String) : [],
        locale: document?.locale ? String(document.locale) : null,
      };

      const latest = await tx.execute(sql`
        SELECT id, version_no, content_hash, status, vector_index_status, diagnostics
        FROM knowledge_document_versions
        WHERE document_id = ${documentId} AND user_id = ${entry.userId}
        ORDER BY version_no DESC
        LIMIT 1
        FOR UPDATE
      `);
      const latestRow = latest.rows[0] as Record<string, unknown> | undefined;
      const latestMetadata = (latestRow?.diagnostics as Record<string, unknown> | undefined)?.publicationMetadata;
      const priorContacts = (latestRow?.diagnostics as Record<string, unknown> | undefined)?.verifiedBusinessContacts;
      const currentContacts = trustedBusinessContacts.filter(value => rawText.includes(value));
      const sameContacts = JSON.stringify(Array.isArray(priorContacts) ? [...priorContacts].sort() : []) === JSON.stringify([...currentContacts].sort());
      if (latestMetadata && latestRow?.status === 'ready_for_review') {
        publicationMetadata = { ...(latestMetadata as KnowledgePublicationMetadata), title: publicationMetadata.title,
          sourceUrl: publicationMetadata.sourceUrl, businessProfileId: entry.businessProfileId ?? null };
        if (publicationMetadata.accessScope !== 'staff_only') publicationMetadata.accessScope = entry.businessProfileId ? 'business_profile' : 'tenant';
      }
      const sameMetadata = latestMetadata && Object.keys(publicationMetadata).every(key =>
        JSON.stringify((latestMetadata as Record<string, unknown>)[key]) === JSON.stringify(publicationMetadata[key as keyof KnowledgePublicationMetadata]));
      const sameLegacyMetadata = !latestMetadata
        && (document?.title == null || document.title === entry.title)
        && (document?.source_url ?? null) === (entry.sourceUrl ?? null)
        && (document?.business_profile_id ?? null) === (entry.businessProfileId ?? null);
      if (latestRow?.content_hash === privacy.contentHash
        && (sameLegacyMetadata || sameMetadata) && sameContacts) {
        // A retry after provider recovery must persist vectors for the existing
        // approved chunks. It must not publish a draft or revive withdrawn data.
        let vectorIndexed = latestRow.vector_index_status === 'completed';
        if (generated && indexDescriptor && ['ready_for_review', 'published', 'published_degraded'].includes(String(latestRow.status))) {
          const stored = await tx.execute(sql`
            SELECT id, ordinal, search_text FROM knowledge_chunks
            WHERE user_id = ${entry.userId} AND version_id = ${Number(latestRow.id)}
            ORDER BY ordinal
          `);
          const storedChunks = stored.rows as Array<{ id: number; ordinal: number; search_text: string }>;
          if (storedChunks.length === chunks.length && storedChunks.every((chunk, i) => chunk.ordinal === i && chunk.search_text === chunks[i].searchText)) {
            for (let i = 0; i < storedChunks.length; i += 1) {
              const vectorLiteral = `[${generated.vectors[i].join(',')}]`;
              const contentHash = crypto.createHash('sha256').update(chunks[i].searchText).digest('hex');
              await tx.execute(sql`
                INSERT INTO knowledge_chunk_embeddings(user_id, chunk_id, index_version_id, provider, model, dimensions, content_hash, embedding)
                VALUES (${entry.userId}, ${Number(storedChunks[i].id)}, ${indexDescriptor.id}, ${generated.provider}, ${generated.model},
                  ${generated.dimensions}, ${contentHash}, ${sql.raw(`'${vectorLiteral}'::vector`)})
                ON CONFLICT (chunk_id, index_version_id) DO UPDATE
                SET embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash,
                    provider = EXCLUDED.provider, model = EXCLUDED.model, dimensions = EXCLUDED.dimensions
              `);
            }
            await tx.execute(sql`
              UPDATE knowledge_document_versions
              SET vector_index_status = 'completed',
                  status = CASE WHEN status = 'published_degraded' THEN 'published' ELSE status END
              WHERE id = ${Number(latestRow.id)} AND user_id = ${entry.userId}
            `);
            vectorIndexed = true;
          }
        }
        return {
          documentId,
          versionId: Number(latestRow.id),
          status: 'unchanged',
          chunkCount: chunks.length,
          vectorIndexed,
          quarantinedReasons: privacy.reasons,
          skipped: true,
        };
      }

      const versionNo = Number(latestRow?.version_no || 0) + 1;
      // Auto-publication must uphold the same classification boundary as the
      // explicit governance publish action. Personal content stays in review;
      // a newly indexed draft must not replace an already approved version.
      const requestedPublish = options.autoPublish === true
        && Boolean(generated)
        && ['public', 'business', 'internal'].includes(privacy.classification);
      const status = privacy.mustQuarantine
        ? 'quarantined'
        : requestedPublish
          ? (generated ? 'published' : 'published_degraded')
          : 'ready_for_review';
      const versionInsert = await tx.execute(sql`
        INSERT INTO knowledge_document_versions(
          document_id, user_id, version_no, status, content_hash,
          normalized_content, authority, privacy_classification,
          extraction_status, lexical_index_status, vector_index_status, diagnostics
        ) VALUES (
          ${documentId}, ${entry.userId}, ${versionNo}, ${status}, ${privacy.contentHash},
          ${privacy.searchText}, 'owner_authored', ${privacy.classification},
          'completed', 'completed', ${generated ? 'completed' : 'failed'},
          ${JSON.stringify({
            privacyReasons: privacy.reasons,
            injectionFlags: privacy.injectionFlags,
            source: 'legacy_sync',
            publicationMetadata,
            verifiedBusinessContacts: trustedBusinessContacts.filter(value => rawText.includes(value)),
          })}::jsonb
        )
        RETURNING id
      `);
      const versionId = Number((versionInsert.rows[0] as Record<string, unknown>).id);

      const insertedChunkIds: number[] = [];
      for (const chunk of chunks) {
        const evidenceId = `KB-${documentId}-V${versionNo}-C${chunk.ordinal}`;
        const inserted = await tx.execute(sql`
          INSERT INTO knowledge_chunks(
            user_id, document_id, version_id, ordinal, evidence_id,
            display_text, search_text, section_path, page_number,
            char_start, char_end, token_count, access_scope, sensitivity,
            exact_identifiers, injection_flags
          ) VALUES (
            ${entry.userId}, ${documentId}, ${versionId}, ${chunk.ordinal}, ${evidenceId},
            ${chunk.displayText}, ${chunk.searchText}, ${knowledgeTextArray(chunk.sectionPath)}, ${chunk.pageNumber ?? null},
            ${chunk.charStart}, ${chunk.charEnd}, ${chunk.tokenCount},
            ${publicationMetadata.accessScope}, ${privacy.classification},
            ${knowledgeTextArray(chunk.exactIdentifiers)}, ${knowledgeTextArray(chunk.injectionFlags)}
          )
          RETURNING id
        `);
        insertedChunkIds.push(Number((inserted.rows[0] as Record<string, unknown>).id));
      }

      for (let index = 0; index < insertedChunkIds.length; index += 1) {
        await tx.execute(sql`
          UPDATE knowledge_chunks
          SET previous_chunk_id = ${insertedChunkIds[index - 1] ?? null},
              next_chunk_id = ${insertedChunkIds[index + 1] ?? null}
          WHERE id = ${insertedChunkIds[index]} AND user_id = ${entry.userId}
        `);
      }

      if (generated && indexDescriptor) {
        for (let index = 0; index < insertedChunkIds.length; index += 1) {
          const vector = generated.vectors[index];
          const vectorLiteral = `[${vector.join(',')}]`;
          const contentHash = crypto.createHash('sha256').update(chunks[index].searchText).digest('hex');
          await tx.execute(sql`
            INSERT INTO knowledge_chunk_embeddings(
              user_id, chunk_id, index_version_id, provider, model,
              dimensions, content_hash, embedding, metadata
            ) VALUES (
              ${entry.userId}, ${insertedChunkIds[index]}, ${indexDescriptor.id},
              ${generated.provider}, ${generated.model}, ${generated.dimensions}, ${contentHash},
              ${sql.raw(`'${vectorLiteral}'::vector`)},
              ${JSON.stringify({ evidenceId: `KB-${documentId}-V${versionNo}-C${index}` })}::jsonb
            )
          `);
        }
      }

      if (status === 'published' || status === 'published_degraded') {
        await tx.execute(sql`
          UPDATE knowledge_document_versions
          SET status = 'retired'
          WHERE document_id = ${documentId} AND user_id = ${entry.userId}
            AND id <> ${versionId} AND status IN ('published', 'published_degraded')
        `);
        await tx.execute(sql`
          UPDATE knowledge_documents
          SET current_published_version_id = ${versionId}, title = ${entry.title},
              source_url = ${entry.sourceUrl ?? null}, business_profile_id = ${entry.businessProfileId ?? null},
              access_scope = ${publicationMetadata.accessScope}, audience = ${publicationMetadata.audience},
              usage_scopes = ${knowledgeTextArray(publicationMetadata.usageScopes)},
              allowed_channels = ${knowledgeTextArray(publicationMetadata.allowedChannels)},
              locale = ${publicationMetadata.locale}, updated_at = NOW()
          WHERE id = ${documentId} AND user_id = ${entry.userId}
        `);
      }

      return {
        documentId,
        versionId,
        status,
        chunkCount: chunks.length,
        vectorIndexed: Boolean(generated),
        quarantinedReasons: privacy.reasons,
      };
    });
  }
}

export const knowledgeIngestionService = new KnowledgeIngestionService();
