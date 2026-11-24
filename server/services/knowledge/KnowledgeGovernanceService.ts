import { sql } from 'drizzle-orm';
import { knowledgeIntegerArray, knowledgeTextArray } from './KnowledgeSql.js';
import { withTenantKnowledgeTransaction } from './KnowledgeTenantTransaction.js';
import { KNOWLEDGE_PURPOSES } from './KnowledgeRetrievalPolicy.js';
import type { KnowledgePurpose } from './types.js';
import { validateKnowledgePublicationMetadata, type KnowledgePublicationMetadata } from './KnowledgePublicationMetadata.js';
import { loadVerifiedBusinessContacts } from './KnowledgeBusinessContacts.js';
import { knowledgeBaseTable, type KnowledgeBaseEntry, type InsertKnowledgeBaseEntry } from '../../models/knowledgeBase/schema.js';
import { and, eq } from 'drizzle-orm';
import { conflictingKnowledgeEvidence, knowledgeConflictTextFullyCompared } from './KnowledgeConflictDetection.js';

type KnowledgeTransaction = Parameters<Parameters<typeof withTenantKnowledgeTransaction>[1]>[0];

const PUBLISHABLE = new Set(['ready_for_review', 'published_degraded']);
const ALLOWED_AUTHORITIES = new Set(['owner_authored', 'tenant_policy', 'official_product', 'managed_source']);

export interface PublishKnowledgeVersionInput {
  userId: number;
  legacyEntryId: number;
  versionId: number;
  actorUserId: number;
  authority: string;
  effectiveAt?: string | null;
  expiresAt?: string | null;
  reviewDueAt?: string | null;
  supersedesVersionId?: number | null;
  allowLexicalOnly?: boolean;
}

function validDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('INVALID_KNOWLEDGE_DATE');
  return parsed;
}

function publicationDates(input: PublishKnowledgeVersionInput) {
  if (!ALLOWED_AUTHORITIES.has(input.authority)) throw new Error('INVALID_KNOWLEDGE_AUTHORITY');
  if (input.supersedesVersionId != null && (!Number.isSafeInteger(input.supersedesVersionId)
    || input.supersedesVersionId <= 0 || input.supersedesVersionId === input.versionId)) {
    throw new Error('INVALID_KNOWLEDGE_SUPERSESSION');
  }
  const effectiveAt = validDate(input.effectiveAt);
  const expiresAt = validDate(input.expiresAt);
  const reviewDueAt = validDate(input.reviewDueAt);
  if (effectiveAt && expiresAt && expiresAt <= effectiveAt) throw new Error('INVALID_KNOWLEDGE_DATE_RANGE');
  if (expiresAt && expiresAt <= new Date()) throw new Error('CANNOT_PUBLISH_EXPIRED_KNOWLEDGE');

  return { effectiveAt, expiresAt, reviewDueAt };
}

class KnowledgeGovernanceService {
  async getEntryStates(userId: number, legacyEntryIds: number[]): Promise<Map<number, Record<string, unknown>>> {
    if (!legacyEntryIds.length) return new Map<number, Record<string, unknown>>();
    try {
      return await withTenantKnowledgeTransaction(userId, async (tx) => {
        await this.activateDuePublications(userId, tx);
        const result = await tx.execute(sql`
          SELECT DISTINCT ON (d.legacy_entry_id)
            d.legacy_entry_id, d.current_published_version_id,
            v.id AS version_id, v.version_no, CASE WHEN v.status='ready_for_review' AND v.diagnostics ? 'scheduledPublication' THEN 'scheduled' ELSE v.status END AS status, v.authority,
            v.vector_index_status, v.lexical_index_status, v.review_due_at,
            v.diagnostics->'publicationMetadata' AS draft_scope,
            live.version_no AS live_version_no,
            CASE WHEN live.expires_at <= NOW() THEN 'expired'
                 WHEN live.effective_at > NOW() THEN 'scheduled' ELSE live.status END AS live_status,
            d.audience, d.access_scope, d.allowed_channels, d.usage_scopes, d.locale
          FROM knowledge_documents d
          JOIN knowledge_document_versions v ON v.document_id = d.id AND v.user_id = d.user_id
          LEFT JOIN knowledge_document_versions live ON live.id = d.current_published_version_id AND live.user_id = d.user_id
          WHERE d.user_id = ${userId} AND d.legacy_entry_id = ANY(${knowledgeIntegerArray(legacyEntryIds)})
          ORDER BY d.legacy_entry_id, v.version_no DESC
        `);
        return new Map<number, Record<string, unknown>>(result.rows.map((row: unknown): [number, Record<string, unknown>] => {
          const value = row as Record<string, unknown>;
          return [Number(value.legacy_entry_id), value];
        }));
      });
    } catch {
      // Forward-compatible while migration 209 has not yet been applied.
      return new Map<number, Record<string, unknown>>();
    }
  }

  async listVersions(userId: number, legacyEntryId: number) {
    return withTenantKnowledgeTransaction(userId, async (tx) => {
      await this.activateDuePublications(userId, tx);
      const result = await tx.execute(sql`
        SELECT v.id, v.version_no, CASE WHEN v.status='ready_for_review' AND v.diagnostics ? 'scheduledPublication' THEN 'scheduled' ELSE v.status END AS status, v.content_hash, v.authority,
               v.privacy_classification, v.effective_at, v.expires_at,
               v.review_due_at, v.reviewed_by, v.reviewed_at,
               v.extraction_status, v.lexical_index_status, v.vector_index_status,
               v.diagnostics, v.normalized_content, d.id AS document_id,
               d.current_published_version_id, d.audience, d.usage_scopes
        FROM knowledge_documents d
        JOIN knowledge_document_versions v ON v.document_id = d.id AND v.user_id = d.user_id
        WHERE d.user_id = ${userId} AND d.legacy_entry_id = ${legacyEntryId}
        ORDER BY v.version_no DESC
      `);
      return result.rows;
    });
  }

  async publish(input: PublishKnowledgeVersionInput) {
    publicationDates(input);
    const result = await withTenantKnowledgeTransaction(input.userId, tx => this.publishInTransaction(tx, input));
    if (result.status === 'review_required') throw new Error('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
    return result;
  }

  private async publishInTransaction(tx: KnowledgeTransaction, input: PublishKnowledgeVersionInput, activating = false) {
    const { effectiveAt, expiresAt, reviewDueAt } = publicationDates(input);
    // Cross-document supersession must serialize with other publication and
    // quarantine decisions for this tenant before locking individual rows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-governance'), ${input.userId})`);
    const selected = await tx.execute(sql`
      SELECT v.*, d.id AS owned_document_id, d.current_published_version_id,
             d.usage_scopes, d.allowed_channels, d.audience, d.access_scope
      FROM knowledge_document_versions v
      JOIN knowledge_documents d ON d.id = v.document_id AND d.user_id = v.user_id
      WHERE v.id = ${input.versionId} AND v.user_id = ${input.userId}
        AND d.legacy_entry_id = ${input.legacyEntryId}
      FOR UPDATE
    `);
    const version = selected.rows[0] as Record<string, unknown> | undefined;
    if (!version) throw new Error('KNOWLEDGE_VERSION_NOT_FOUND');
    if (!PUBLISHABLE.has(String(version.status))) throw new Error('KNOWLEDGE_VERSION_NOT_READY');
    const diagnostics = (version.diagnostics || {}) as Record<string, unknown>;
    const rawMetadata = diagnostics.publicationMetadata as KnowledgePublicationMetadata | undefined;
    const currentContacts = rawMetadata || Array.isArray(diagnostics.verifiedBusinessContacts)
      ? await loadVerifiedBusinessContacts(input.userId, rawMetadata?.businessProfileId ?? null, tx) : [];
    const metadata = rawMetadata ? validateKnowledgePublicationMetadata(rawMetadata, currentContacts) : null;
    if (activating && (diagnostics.scheduledPublication as Record<string, unknown> | undefined)?.expectedPublishedVersionId !== (version.current_published_version_id ?? null)) {
      throw new Error('KNOWLEDGE_SCHEDULE_HEAD_CHANGED_REVIEW_REQUIRED');
    }
    if (metadata?.businessProfileId) {
      const owned = await tx.execute(sql`SELECT id FROM company_settings WHERE id = ${metadata.businessProfileId} AND user_id = ${input.userId}`);
      if (!owned.rows.length) throw new Error('INVALID_BUSINESS_PROFILE');
    }
    if (Array.isArray(diagnostics.verifiedBusinessContacts) && diagnostics.verifiedBusinessContacts.length) {
      if (diagnostics.verifiedBusinessContacts.some(value => typeof value !== 'string' || !currentContacts.includes(value))) {
        throw new Error('BUSINESS_CONTACT_SCOPE_CHANGED_REPROCESS_REQUIRED');
      }
    }
    const usageScopes = metadata?.usageScopes || (Array.isArray(version.usage_scopes) ? version.usage_scopes.map(String) : []);
    if (usageScopes.length === 0 || usageScopes.some((scope) => !KNOWLEDGE_PURPOSES.includes(scope as KnowledgePurpose))) {
      throw new Error('INVALID_KNOWLEDGE_USAGE_SCOPES');
    }
    if (version.lexical_index_status !== 'completed') throw new Error('LEXICAL_INDEX_NOT_READY');
    if (version.vector_index_status !== 'completed' && input.allowLexicalOnly !== true) {
      throw new Error('VECTOR_INDEX_NOT_READY');
    }
    if (['secret', 'restricted', 'personal'].includes(String(version.privacy_classification))) {
      throw new Error('KNOWLEDGE_PRIVACY_REVIEW_REQUIRED');
    }
    if (Array.isArray(diagnostics.injectionFlags) && diagnostics.injectionFlags.length > 0) {
      throw new Error('KNOWLEDGE_INJECTION_FLAGS_PRESENT');
    }
    const recordedConflicts = diagnostics.conflictVersionIds ?? [];
    if (!Array.isArray(recordedConflicts) || recordedConflicts.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('INVALID_KNOWLEDGE_CONFLICTS');
    }
    const documentId = Number(version.owned_document_id);
    const otherSources = await tx.execute(sql`SELECT c.evidence_id, c.display_text, d.id AS document_id,
        v.id AS version_id, v.authority, COUNT(*) OVER (PARTITION BY v.id) AS version_chunk_count
      FROM knowledge_chunks c JOIN knowledge_document_versions v ON v.id=c.version_id AND v.user_id=c.user_id
      JOIN knowledge_documents d ON d.id=c.document_id AND d.user_id=c.user_id AND d.current_published_version_id=v.id
      WHERE d.user_id=${input.userId} AND d.id<>${documentId} AND d.deleted_at IS NULL
        AND v.status IN ('published','published_degraded') AND (v.effective_at IS NULL OR v.effective_at<=NOW())
        AND (v.expires_at IS NULL OR v.expires_at>NOW()) AND v.authority=${input.authority}
        AND (d.business_profile_id IS NULL OR d.business_profile_id IS NOT DISTINCT FROM ${metadata?.businessProfileId ?? null})
        AND d.audience=${metadata?.audience || version.audience || 'customer'}
        AND (d.locale IS NULL OR ${metadata?.locale ?? null}::text IS NULL OR d.locale=${metadata?.locale ?? null})
        AND d.usage_scopes && ${knowledgeTextArray(usageScopes)}
        AND (cardinality(d.allowed_channels)=0 OR cardinality(${knowledgeTextArray(metadata?.allowedChannels || [])})=0
          OR d.allowed_channels && ${knowledgeTextArray(metadata?.allowedChannels || [])})
      ORDER BY c.id LIMIT 500`);
    const detected = conflictingKnowledgeEvidence([
      { evidenceId:'candidate', documentId, authority:input.authority, excerpt:String(version.normalized_content || '') },
      ...otherSources.rows.map((row: Record<string, unknown>) => ({ evidenceId:String(row.evidence_id),
        documentId:Number(row.document_id),authority:String(row.authority),excerpt:String(row.display_text) })),
    ], documentId);
    const detectedVersions = [...new Set(otherSources.rows.filter((row: Record<string, unknown>) => detected.has(String(row.evidence_id)))
      .map((row: Record<string, unknown>) => Number(row.version_id)))];
    // Earlier publication checks also recorded disagreements between two existing
    // sources. Revalidate those IDs only when every chunk of that current source
    // and the candidate fit within the comparator's bounds. Missing, truncated or
    // otherwise unverified recorded conflicts remain blocked for owner review.
    const coverage = new Map<number, { seen: number; total: number; complete: boolean }>();
    for (const row of otherSources.rows as Record<string, unknown>[]) {
      const id = Number(row.version_id);
      const total = Number(row.version_chunk_count);
      const prior = coverage.get(id);
      coverage.set(id, { seen: (prior?.seen || 0) + 1, total,
        complete: Number.isSafeInteger(total) && total > 0 && (!prior || (prior.complete && prior.total === total))
          && typeof row.display_text === 'string' && row.display_text.trim().length > 0
          && knowledgeConflictTextFullyCompared(row.display_text) });
    }
    const candidateComplete = typeof version.normalized_content === 'string' && version.normalized_content.trim().length > 0
      && knowledgeConflictTextFullyCompared(version.normalized_content);
    const clearedUnrelatedConflictVersionIds = recordedConflicts.filter(id => {
      const source = coverage.get(id);
      return candidateComplete && source?.complete && source.seen === source.total && !detectedVersions.includes(id);
    });
    const conflicts = [...new Set([...recordedConflicts.filter(id => !clearedUnrelatedConflictVersionIds.includes(id)), ...detectedVersions])];
    const unresolved = conflicts.filter(id => id !== input.supersedesVersionId);
    if (unresolved.length) {
      if (conflicts.length !== recordedConflicts.length || conflicts.some(id => !recordedConflicts.includes(id))) {
        await tx.execute(sql`UPDATE knowledge_document_versions SET diagnostics=COALESCE(diagnostics,'{}'::jsonb)
          || ${JSON.stringify({ conflictVersionIds: conflicts })}::jsonb
          WHERE id=${input.versionId} AND user_id=${input.userId}`);
      }
      return { documentId, versionId:input.versionId, status:'review_required' };
    }
    let supersededDocumentId: number | null = null;
    if (input.supersedesVersionId) {
      const superseded = await tx.execute(sql`
        SELECT v.document_id
        FROM knowledge_document_versions v
        JOIN knowledge_documents d ON d.id = v.document_id AND d.user_id = v.user_id
        WHERE v.id = ${input.supersedesVersionId} AND v.user_id = ${input.userId}
          AND v.status IN ('published', 'published_degraded')
          AND d.current_published_version_id = v.id
        FOR UPDATE
      `);
      const target = superseded.rows[0] as Record<string, unknown> | undefined;
      supersededDocumentId = target ? Number(target.document_id) : null;
      // Do not allow an arbitrary (or foreign) version to bypass a conflict,
      // nor retire unrelated documents through an unscoped version ID.
      if (!supersededDocumentId || (supersededDocumentId !== documentId
        && !conflicts.includes(input.supersedesVersionId))) {
        throw new Error('INVALID_KNOWLEDGE_SUPERSESSION');
      }
    }
    if (effectiveAt && effectiveAt > new Date()) {
      if (version.status !== 'ready_for_review') throw new Error('KNOWLEDGE_SCHEDULE_REQUIRES_DRAFT');
      const schedule = { ...input, expectedPublishedVersionId: version.current_published_version_id ?? null };
      await tx.execute(sql`UPDATE knowledge_document_versions SET diagnostics=(COALESCE(diagnostics,'{}'::jsonb)
        -'scheduleReviewRequired') || ${JSON.stringify({ scheduledPublication:schedule })}::jsonb,
        effective_at=${effectiveAt},expires_at=${expiresAt},review_due_at=${reviewDueAt},reviewed_by=${input.actorUserId},reviewed_at=NOW()
        WHERE id=${input.versionId} AND user_id=${input.userId}`);
      await tx.execute(sql`INSERT INTO knowledge_governance_audits(user_id,document_id,version_id,actor_user_id,action,details)
        VALUES(${input.userId},${documentId},${input.versionId},${input.actorUserId},'schedule',
          ${JSON.stringify({effectiveAt:effectiveAt.toISOString()})}::jsonb)`);
      return { documentId,versionId:input.versionId,status:'scheduled' };
    }
    if (input.supersedesVersionId) {
      await tx.execute(sql`
        UPDATE knowledge_document_versions SET status = 'retired'
        WHERE id = ${input.supersedesVersionId} AND user_id = ${input.userId}
      `);
      await tx.execute(sql`
        UPDATE knowledge_documents SET current_published_version_id = NULL, updated_at = NOW()
        WHERE id = ${supersededDocumentId} AND user_id = ${input.userId}
          AND current_published_version_id = ${input.supersedesVersionId}
      `);
    }
    const status = version.vector_index_status === 'completed' ? 'published' : 'published_degraded';
    await tx.execute(sql`
      UPDATE knowledge_document_versions
      SET status = 'retired'
      WHERE document_id = ${documentId} AND user_id = ${input.userId}
        AND id <> ${input.versionId} AND (status IN ('published', 'published_degraded') OR diagnostics ? 'scheduledPublication')
    `);
    await tx.execute(sql`
      UPDATE knowledge_document_versions
      SET status = ${status}, authority = ${input.authority},
          effective_at = ${effectiveAt}, expires_at = ${expiresAt}, review_due_at = ${reviewDueAt},
          reviewed_by = ${input.actorUserId}, reviewed_at = NOW(),
          supersedes_version_id = ${input.supersedesVersionId ?? null},
          diagnostics = (COALESCE(diagnostics, '{}'::jsonb)-'scheduledPublication'-'scheduleReviewRequired') || ${JSON.stringify({ conflictVersionIds: [] })}::jsonb
      WHERE id = ${input.versionId} AND user_id = ${input.userId}
    `);
    await tx.execute(sql`
      UPDATE knowledge_documents
      SET current_published_version_id = ${input.versionId}, updated_at = NOW()
      WHERE id = ${documentId} AND user_id = ${input.userId}
    `);
    if (metadata) {
      // Content and authorization become live in the same commit.
      await tx.execute(sql`
        UPDATE knowledge_documents SET title = ${metadata.title}, source_url = ${metadata.sourceUrl},
          business_profile_id = ${metadata.businessProfileId}, audience = ${metadata.audience},
          access_scope = ${metadata.accessScope}, usage_scopes = ${knowledgeTextArray(metadata.usageScopes)},
          allowed_channels = ${knowledgeTextArray(metadata.allowedChannels)}, locale = ${metadata.locale}
        WHERE id = ${documentId} AND user_id = ${input.userId}
      `);
      await tx.execute(sql`UPDATE knowledge_chunks SET access_scope = ${metadata.accessScope}
        WHERE version_id = ${input.versionId} AND user_id = ${input.userId}`);
    }
    await tx.execute(sql`
      INSERT INTO knowledge_governance_audits(
        user_id, document_id, version_id, actor_user_id, action, details
      ) VALUES (
        ${input.userId}, ${documentId}, ${input.versionId}, ${input.actorUserId}, 'publish',
        ${JSON.stringify({ authority: input.authority, status, supersedesVersionId: input.supersedesVersionId || null, supersededDocumentId, resolvedConflictVersionIds: conflicts, clearedUnrelatedConflictVersionIds })}::jsonb
      )
    `);
    return { documentId, versionId: input.versionId, status };
  }

  /** Approved schedules activate lazily at the next governed read. All content,
   * scope and current-head checks are rerun under the publication lock. */
  async activateDuePublications(userId: number, transaction?: KnowledgeTransaction): Promise<number> {
    const activate = async (tx: KnowledgeTransaction) => {
      const due = await tx.execute(sql`SELECT v.id, v.effective_at, d.legacy_entry_id, v.diagnostics->'scheduledPublication' AS scheduled_publication
        FROM knowledge_document_versions v JOIN knowledge_documents d ON d.id=v.document_id AND d.user_id=v.user_id
        WHERE v.user_id=${userId} AND d.deleted_at IS NULL AND v.status='ready_for_review'
          AND v.diagnostics ? 'scheduledPublication' AND v.effective_at <= NOW()
        ORDER BY v.effective_at,v.id LIMIT 50`);
      let activated = 0;
      for (const row of due.rows as Array<{id: number; effective_at: Date|string; legacy_entry_id: number; scheduled_publication: PublishKnowledgeVersionInput}>) {
        if (!Number.isSafeInteger(Number(row.id)) || !row.scheduled_publication) continue;
        await tx.execute(sql`SAVEPOINT knowledge_schedule_activation`);
        try {
          const result = await this.publishInTransaction(tx, { ...row.scheduled_publication,
            userId, legacyEntryId: Number(row.legacy_entry_id), versionId: Number(row.id), effectiveAt:new Date(row.effective_at).toISOString() }, true);
          if (result.status === 'review_required') throw new Error('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
          activated += 1;
        } catch (error) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT knowledge_schedule_activation`);
          const reason = error instanceof Error ? error.message : 'KNOWLEDGE_ACTIVATION_REVIEW_REQUIRED';
          await tx.execute(sql`UPDATE knowledge_document_versions SET diagnostics=(COALESCE(diagnostics,'{}'::jsonb)-'scheduledPublication')
            || ${JSON.stringify({ scheduleReviewRequired: reason })}::jsonb
            WHERE id=${Number(row.id)} AND user_id=${userId} AND status='ready_for_review'`);
        }
        await tx.execute(sql`RELEASE SAVEPOINT knowledge_schedule_activation`);
      }
      return activated;
    };
    return transaction ? activate(transaction) : withTenantKnowledgeTransaction(userId, activate);
  }

  async updateDraftScope(input: { userId: number; legacyEntryId: number; versionId: number; metadata: KnowledgePublicationMetadata }) {
    const metadata = validateKnowledgePublicationMetadata(input.metadata,
      await loadVerifiedBusinessContacts(input.userId, input.metadata?.businessProfileId ?? null));
    return withTenantKnowledgeTransaction(input.userId, async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-governance'), ${input.userId})`);
      if (metadata.businessProfileId) {
        const owned = await tx.execute(sql`SELECT id FROM company_settings WHERE id = ${metadata.businessProfileId} AND user_id = ${input.userId}`);
        if (!owned.rows.length) throw new Error('INVALID_BUSINESS_PROFILE');
      }
      const result = await tx.execute(sql`
        UPDATE knowledge_document_versions v
        SET diagnostics = COALESCE(v.diagnostics, '{}'::jsonb) || ${JSON.stringify({ publicationMetadata: metadata })}::jsonb
        FROM knowledge_documents d
        WHERE v.id = ${input.versionId} AND v.user_id = ${input.userId} AND v.status = 'ready_for_review' AND NOT (v.diagnostics ? 'scheduledPublication')
          AND d.id = v.document_id AND d.user_id = v.user_id AND d.legacy_entry_id = ${input.legacyEntryId}
        RETURNING v.id
      `);
      if (!result.rows.length) throw new Error('KNOWLEDGE_DRAFT_NOT_EDITABLE');
      // The editable legacy row is a draft surface; keep reprocessing aligned
      // while the published document's profile remains unchanged until review.
      await tx.execute(sql`UPDATE knowledge_base SET business_profile_id=${metadata.businessProfileId},updated_at=NOW()
        WHERE id=${input.legacyEntryId} AND user_id=${input.userId}`);
      await tx.execute(sql`INSERT INTO knowledge_governance_audits(user_id,document_id,version_id,actor_user_id,action,details)
        SELECT ${input.userId},document_id,id,${input.userId},'update_draft_scope',${JSON.stringify(metadata)}::jsonb
        FROM knowledge_document_versions WHERE id=${input.versionId} AND user_id=${input.userId}`);
      return { versionId: input.versionId, metadata };
    });
  }

  async createDraft(input: { userId: number; legacyEntryId: number; versionId: number }) {
    return withTenantKnowledgeTransaction(input.userId, tx => this.cloneDraft(tx, input));
  }

  private async cloneDraft(tx: KnowledgeTransaction, input: { userId:number;legacyEntryId:number;versionId:number }, metadataOverride?: KnowledgePublicationMetadata) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-governance'), ${input.userId})`);
    const source = await tx.execute(sql`SELECT v.*, d.id AS owned_document_id, d.title, d.source_url,
        d.business_profile_id, d.audience, d.access_scope, d.usage_scopes, d.allowed_channels, d.locale
      FROM knowledge_document_versions v JOIN knowledge_documents d ON d.id=v.document_id AND d.user_id=v.user_id
      WHERE v.id=${input.versionId} AND v.user_id=${input.userId} AND d.legacy_entry_id=${input.legacyEntryId}
        AND (v.status IN ('published','published_degraded','retired') OR (${Boolean(metadataOverride)} AND v.status='ready_for_review')) FOR UPDATE`);
    const row = source.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('KNOWLEDGE_VERSION_NOT_FOUND');
    const documentId = Number(row.owned_document_id);
    const existing = await tx.execute(sql`SELECT id FROM knowledge_document_versions WHERE document_id=${documentId}
      AND user_id=${input.userId} AND status='ready_for_review' LIMIT 1`);
    if (existing.rows.length) {
      if (!metadataOverride) throw new Error('REVIEW_EXISTING_DRAFT_FIRST');
      await tx.execute(sql`UPDATE knowledge_document_versions SET diagnostics=COALESCE(diagnostics,'{}'::jsonb)
        || ${JSON.stringify({ publicationMetadata: metadataOverride })}::jsonb
        WHERE id=${Number(existing.rows[0].id)} AND user_id=${input.userId}
          AND NOT (diagnostics ? 'scheduledPublication') RETURNING id`).then((result: {rows:unknown[]}) => {
        if (!result.rows.length) throw new Error('KNOWLEDGE_SCHEDULE_REVIEW_REQUIRED');
      });
      return { versionId:Number(existing.rows[0].id),status:'ready_for_review' };
    }
    const diagnostics = { ...(row.diagnostics as Record<string, unknown> || {}) };
    delete diagnostics.scheduledPublication; delete diagnostics.scheduleReviewRequired;
    const metadata = metadataOverride || diagnostics.publicationMetadata || { title: String(row.title), sourceUrl: row.source_url || null,
      businessProfileId: row.business_profile_id || null, audience: row.audience, accessScope: row.access_scope,
      usageScopes: row.usage_scopes, allowedChannels: row.allowed_channels || [], locale: row.locale || null };
    const inserted = await tx.execute(sql`INSERT INTO knowledge_document_versions(document_id,user_id,version_no,status,
        content_hash,normalized_content,authority,privacy_classification,extraction_status,lexical_index_status,vector_index_status,diagnostics)
      SELECT ${documentId},${input.userId},COALESCE(MAX(version_no),0)+1,'ready_for_review',
        ${row.content_hash},${row.normalized_content},${row.authority},${row.privacy_classification},
        ${row.extraction_status},${row.lexical_index_status},${row.vector_index_status},
        ${JSON.stringify({ ...diagnostics, publicationMetadata: metadata, copiedFromVersionId: input.versionId })}::jsonb
      FROM knowledge_document_versions WHERE document_id=${documentId} AND user_id=${input.userId}
      RETURNING id,version_no`);
    const version = inserted.rows[0] as { id: number; version_no: number };
    await tx.execute(sql`INSERT INTO knowledge_chunks(user_id,document_id,version_id,ordinal,evidence_id,display_text,search_text,
        section_path,page_number,char_start,char_end,token_count,access_scope,sensitivity,exact_identifiers,injection_flags)
      SELECT user_id,document_id,${version.id},ordinal,'KB-'||document_id||'-V'||${version.version_no}::text||'-C'||ordinal,
        display_text,search_text,section_path,page_number,char_start,char_end,token_count,access_scope,sensitivity,exact_identifiers,injection_flags
      FROM knowledge_chunks WHERE version_id=${input.versionId} AND user_id=${input.userId}`);
    await tx.execute(sql`UPDATE knowledge_chunks c SET previous_chunk_id=n.previous_id,next_chunk_id=n.next_id
      FROM (SELECT id,LAG(id) OVER(ORDER BY ordinal) previous_id,LEAD(id) OVER(ORDER BY ordinal) next_id
        FROM knowledge_chunks WHERE version_id=${version.id} AND user_id=${input.userId}) n
      WHERE c.id=n.id AND c.user_id=${input.userId}`);
    await tx.execute(sql`INSERT INTO knowledge_chunk_embeddings(user_id,chunk_id,index_version_id,provider,model,dimensions,content_hash,embedding,metadata)
      SELECT e.user_id,fresh.id,e.index_version_id,e.provider,e.model,e.dimensions,e.content_hash,e.embedding,
        jsonb_build_object('evidenceId',fresh.evidence_id)
      FROM knowledge_chunk_embeddings e JOIN knowledge_chunks old ON old.id=e.chunk_id AND old.user_id=e.user_id
      JOIN knowledge_chunks fresh ON fresh.version_id=${version.id} AND fresh.user_id=e.user_id AND fresh.ordinal=old.ordinal
      WHERE old.version_id=${input.versionId} AND e.user_id=${input.userId}`);
    await tx.execute(sql`INSERT INTO knowledge_governance_audits(user_id,document_id,version_id,actor_user_id,action,details)
      VALUES(${input.userId},${documentId},${version.id},${input.userId},'create_draft',${JSON.stringify({ copiedFromVersionId: input.versionId })}::jsonb)`);
    return { versionId: Number(version.id), versionNo: Number(version.version_no), status: 'ready_for_review' };
  }

  async updateSourceMetadata(entry: KnowledgeBaseEntry, changes: Partial<InsertKnowledgeBaseEntry>, expected: Date) {
    return withTenantKnowledgeTransaction(entry.userId, async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-governance'), ${entry.userId})`);
      const owned = await tx.execute(sql`SELECT id FROM knowledge_base WHERE id=${entry.id} AND user_id=${entry.userId}
        AND COALESCE(date_trunc('milliseconds',updated_at),'epoch'::timestamp)=${expected} FOR UPDATE`);
      if (!owned.rows.length) throw new Error('KNOWLEDGE_SOURCE_CHANGED');
      const latest = await tx.execute(sql`SELECT v.id,v.diagnostics,d.audience,d.access_scope,d.usage_scopes,d.allowed_channels,d.locale
        FROM knowledge_document_versions v JOIN knowledge_documents d ON d.id=v.document_id AND d.user_id=v.user_id
        WHERE d.user_id=${entry.userId} AND d.legacy_entry_id=${entry.id}
          AND v.status IN ('ready_for_review','published','published_degraded','retired')
        ORDER BY v.version_no DESC LIMIT 1`);
      const row = latest.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error('KNOWLEDGE_SOURCE_NOT_INDEXED');
      const prior = (row.diagnostics as {publicationMetadata?: KnowledgePublicationMetadata})?.publicationMetadata;
      const profile = changes.businessProfileId === undefined ? entry.businessProfileId ?? null : changes.businessProfileId ?? null;
      const contacts = await loadVerifiedBusinessContacts(entry.userId, profile, tx);
      const metadata = validateKnowledgePublicationMetadata({
        title:changes.title ?? entry.title,sourceUrl:entry.sourceUrl ?? null,businessProfileId:profile,
        audience:prior?.audience || row.audience as KnowledgePublicationMetadata['audience'],
        accessScope:prior?.accessScope === 'staff_only' ? 'staff_only' : profile ? 'business_profile' : 'tenant',
        usageScopes:prior?.usageScopes || row.usage_scopes as string[],allowedChannels:prior?.allowedChannels || row.allowed_channels as string[] || [],
        locale:prior?.locale || row.locale as string || null,
      },contacts);
      const draft = await this.cloneDraft(tx,{userId:entry.userId,legacyEntryId:entry.id,versionId:Number(row.id)},metadata);
      const [updated] = await tx.update(knowledgeBaseTable).set({...changes,
        updatedAt:sql`GREATEST(clock_timestamp(),${knowledgeBaseTable.updatedAt}+INTERVAL '1 millisecond')`,
      }).where(and(eq(knowledgeBaseTable.id,entry.id),eq(knowledgeBaseTable.userId,entry.userId))).returning();
      return { entry:updated as KnowledgeBaseEntry,draft };
    });
  }

  async withdraw(input: { userId: number; legacyEntryId: number; actorUserId: number; reason: string }) {
    if (!input.reason.trim()) throw new Error('WITHDRAWAL_REASON_REQUIRED');
    return withTenantKnowledgeTransaction(input.userId, async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-governance'), ${input.userId})`);
      const selected = await tx.execute(sql`SELECT id, current_published_version_id FROM knowledge_documents
        WHERE user_id = ${input.userId} AND legacy_entry_id = ${input.legacyEntryId} FOR UPDATE`);
      const document = selected.rows[0] as Record<string, unknown> | undefined;
      if (!document) throw new Error('KNOWLEDGE_VERSION_NOT_FOUND');
      await tx.execute(sql`UPDATE knowledge_document_versions SET status = 'retired'
        WHERE document_id = ${Number(document.id)} AND user_id = ${input.userId} AND (status IN ('published', 'published_degraded') OR diagnostics ? 'scheduledPublication')`);
      await tx.execute(sql`UPDATE knowledge_documents SET current_published_version_id = NULL, updated_at = NOW()
        WHERE id = ${Number(document.id)} AND user_id = ${input.userId}`);
      await tx.execute(sql`INSERT INTO knowledge_governance_audits(user_id, document_id, version_id, actor_user_id, action, reason)
        VALUES (${input.userId}, ${Number(document.id)}, ${document.current_published_version_id ? Number(document.current_published_version_id) : null},
          ${input.actorUserId}, 'withdraw', ${input.reason.slice(0, 1000)})`);
      return { documentId: Number(document.id), status: 'retired' };
    });
  }

  async deleteEntry(userId: number, legacyEntryId: number): Promise<boolean> {
    return withTenantKnowledgeTransaction(userId, async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-governance'), ${userId})`);
      const owned = await tx.execute(sql`SELECT id FROM knowledge_base WHERE id = ${legacyEntryId} AND user_id = ${userId} FOR UPDATE`);
      if (!owned.rows.length) return false;
      await tx.execute(sql`UPDATE knowledge_document_versions v SET status = 'retired'
        FROM knowledge_documents d WHERE d.id = v.document_id AND d.user_id = ${userId}
          AND v.user_id = ${userId} AND d.legacy_entry_id = ${legacyEntryId}`);
      await tx.execute(sql`UPDATE knowledge_documents SET current_published_version_id = NULL, deleted_at = NOW(), updated_at = NOW()
        WHERE user_id = ${userId} AND legacy_entry_id = ${legacyEntryId}`);
      await tx.execute(sql`DELETE FROM knowledge_chunk_embeddings e USING knowledge_chunks c, knowledge_documents d
        WHERE e.user_id = ${userId} AND c.user_id = ${userId} AND d.user_id = ${userId}
          AND e.chunk_id = c.id AND c.document_id = d.id AND d.legacy_entry_id = ${legacyEntryId}`);
      await tx.execute(sql`DELETE FROM embeddings WHERE user_id = ${userId} AND source_type = 'knowledge_base' AND source_id = ${legacyEntryId}`);
      await tx.execute(sql`INSERT INTO knowledge_governance_audits(user_id, document_id, actor_user_id, action, reason)
        SELECT ${userId}, id, ${userId}, 'delete', 'Owner deleted the knowledge entry'
        FROM knowledge_documents WHERE user_id = ${userId} AND legacy_entry_id = ${legacyEntryId}`);
      await tx.execute(sql`DELETE FROM knowledge_base WHERE id = ${legacyEntryId} AND user_id = ${userId}`);
      return true;
    });
  }

  async quarantine(input: { userId: number; legacyEntryId: number; versionId: number; actorUserId: number; reason: string }) {
    if (!input.reason.trim()) throw new Error('QUARANTINE_REASON_REQUIRED');
    return withTenantKnowledgeTransaction(input.userId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('knowledge-governance'), ${input.userId})`);
      const result = await tx.execute(sql`
        UPDATE knowledge_document_versions v
        SET status = 'quarantined', reviewed_by = ${input.actorUserId}, reviewed_at = NOW(),
            diagnostics = COALESCE(v.diagnostics, '{}'::jsonb) || ${JSON.stringify({ quarantineReason: input.reason.slice(0, 1000) })}::jsonb
        FROM knowledge_documents d
        WHERE v.id = ${input.versionId} AND v.user_id = ${input.userId}
          AND d.id = v.document_id AND d.user_id = v.user_id
          AND d.legacy_entry_id = ${input.legacyEntryId}
        RETURNING v.document_id
      `);
      const documentId = Number((result.rows[0] as Record<string, unknown> | undefined)?.document_id || 0);
      if (!documentId) throw new Error('KNOWLEDGE_VERSION_NOT_FOUND');
      await tx.execute(sql`
        UPDATE knowledge_documents SET current_published_version_id = NULL, updated_at = NOW()
        WHERE id = ${documentId} AND user_id = ${input.userId}
          AND current_published_version_id = ${input.versionId}
      `);
      await tx.execute(sql`
        INSERT INTO knowledge_governance_audits(user_id, document_id, version_id, actor_user_id, action, reason)
        VALUES (${input.userId}, ${documentId}, ${input.versionId}, ${input.actorUserId}, 'quarantine', ${input.reason.slice(0, 1000)})
      `);
      return { documentId, versionId: input.versionId, status: 'quarantined' };
    });
  }
}

export const knowledgeGovernanceService = new KnowledgeGovernanceService();
