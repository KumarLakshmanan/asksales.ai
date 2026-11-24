import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { knowledgeBaseTable, type KnowledgeBaseEntry } from '../models/knowledgeBase/schema.js';
import { knowledgeIngestionService } from '../services/knowledge/KnowledgeIngestionService.js';
import { usageScopesForSourceType } from '../services/knowledge/KnowledgeRetrievalPolicy.js';
import { knowledgeTextArray } from '../services/knowledge/KnowledgeSql.js';
import { withKnowledgeAdminTransaction, withTenantKnowledgeTransaction } from '../services/knowledge/KnowledgeTenantTransaction.js';

type Mode = 'prepare' | 'cutover' | 'rollback';

function mode(): Mode {
  if (process.argv.includes('--cutover')) return 'cutover';
  if (process.argv.includes('--rollback')) return 'rollback';
  return 'prepare';
}

async function setRuntime(enabled: boolean, maintenance: boolean) {
  await db.execute(sql`
    UPDATE knowledge_runtime_settings
    SET knowledge_v2_enabled = ${enabled}, maintenance_mode = ${maintenance}, updated_at = NOW()
    WHERE id = 1
  `);
}

async function recordFailure(entry: KnowledgeBaseEntry, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  await withTenantKnowledgeTransaction(entry.userId, async (tx) => {
    const document = await tx.execute(sql`
      INSERT INTO knowledge_documents(
        user_id, business_profile_id, legacy_entry_id, source_type, title,
        description, source_url, owner_user_id, audience, access_scope, usage_scopes
      ) VALUES (
        ${entry.userId}, ${entry.businessProfileId ?? null}, ${entry.id}, ${entry.type}, ${entry.title},
        ${entry.description ?? null}, ${entry.sourceUrl ?? null}, ${entry.userId}, 'customer',
        ${entry.businessProfileId ? 'business_profile' : 'tenant'}, ${knowledgeTextArray(usageScopesForSourceType(entry.type))}
      )
      ON CONFLICT (business_profile_id, user_id, legacy_entry_id) WHERE legacy_entry_id IS NOT NULL
      DO UPDATE SET usage_scopes = EXCLUDED.usage_scopes, updated_at = NOW()
      RETURNING id
    `);
    const documentId = Number((document.rows[0] as Record<string, unknown>).id);
    const latest = await tx.execute(sql`
      SELECT COALESCE(MAX(version_no), 0)::int AS version_no
      FROM knowledge_document_versions
      WHERE user_id = ${entry.userId} AND document_id = ${documentId}
    `);
    const versionNo = Number((latest.rows[0] as Record<string, unknown>).version_no) + 1;
    await tx.execute(sql`
      INSERT INTO knowledge_document_versions(
        document_id, user_id, version_no, status, content_hash, normalized_content,
        authority, privacy_classification, extraction_status, lexical_index_status,
        vector_index_status, diagnostics
      ) VALUES (
        ${documentId}, ${entry.userId}, ${versionNo}, 'failed',
        ${crypto.createHash('sha256').update(`${entry.id}:${reason}`).digest('hex')}, '',
        'owner_authored', 'business', 'failed', 'failed', 'failed',
        ${JSON.stringify({ migrationFailure: reason.slice(0, 1000) })}::jsonb
      )
    `);
  });
}

type ReconciliationOutcome = 'reconciled' | 'quarantined' | 'failed' | 'intentionally_excluded';

async function recordReconciliation(input: {
  entry: KnowledgeBaseEntry;
  outcome: ReconciliationOutcome;
  documentId?: number;
  versionId?: number;
  reason?: string;
  details?: Record<string, unknown>;
}) {
  await withKnowledgeAdminTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO knowledge_migration_reconciliations(
        legacy_entry_id, original_user_id, document_id, version_id,
        outcome, reason, details
      ) VALUES (
        ${input.entry.id}, ${input.entry.userId}, ${input.documentId ?? null},
        ${input.versionId ?? null}, ${input.outcome}, ${input.reason ?? null},
        ${JSON.stringify(input.details ?? {})}::jsonb
      )
      ON CONFLICT (legacy_entry_id) DO UPDATE SET
        original_user_id = EXCLUDED.original_user_id,
        document_id = EXCLUDED.document_id,
        version_id = EXCLUDED.version_id,
        outcome = EXCLUDED.outcome,
        reason = EXCLUDED.reason,
        details = EXCLUDED.details,
        updated_at = NOW()
    `);
  });
}

async function snapshot() {
  return withKnowledgeAdminTransaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM knowledge_base) AS legacy_count,
        (SELECT COUNT(*)::int FROM knowledge_migration_reconciliations) AS reconciled_count,
        (SELECT COUNT(*)::int FROM knowledge_documents WHERE legacy_entry_id IS NOT NULL) AS document_count,
        (SELECT COUNT(*)::int FROM knowledge_document_versions WHERE status IN ('published', 'published_degraded')) AS published_count,
        (SELECT COUNT(*)::int FROM knowledge_document_versions WHERE status = 'quarantined') AS quarantined_count,
        (SELECT COUNT(*)::int FROM knowledge_migration_reconciliations WHERE outcome = 'failed') AS failed_count,
        (SELECT COUNT(*)::int FROM knowledge_document_versions WHERE status = 'failed') AS historical_failed_versions,
        (SELECT COUNT(*)::int FROM knowledge_migration_reconciliations WHERE outcome = 'intentionally_excluded') AS excluded_count,
        (SELECT knowledge_v2_enabled FROM knowledge_runtime_settings WHERE id = 1) AS enabled,
        (SELECT maintenance_mode FROM knowledge_runtime_settings WHERE id = 1) AS maintenance
    `);
    return result.rows[0];
  });
}

async function main() {
  const selectedMode = mode();
  if (selectedMode === 'rollback') {
    await setRuntime(false, false);
    console.info(JSON.stringify({ mode: selectedMode, status: 'legacy_read_path_enabled', snapshot: await snapshot() }, null, 2));
    return;
  }
  if (selectedMode === 'prepare') {
    console.info(JSON.stringify({ mode: selectedMode, status: 'read_only', snapshot: await snapshot() }, null, 2));
    return;
  }

  // Automatic KB delivery must remain paused until every row is reconciled and
  // all mandatory smoke suites have been run by the operator.
  await setRuntime(false, true);
  const entries = await db.select().from(knowledgeBaseTable).orderBy(knowledgeBaseTable.id);
  const existingUsers = await withKnowledgeAdminTransaction(async (tx) => {
    const result = await tx.execute(sql`SELECT id FROM users`);
    return new Set(result.rows.map((row: unknown) => Number((row as Record<string, unknown>).id)));
  });
  const failures: Array<{ id: number; error: string }> = [];
  for (const entry of entries) {
    if (!existingUsers.has(entry.userId)) {
      await recordReconciliation({
        entry,
        outcome: 'intentionally_excluded',
        reason: 'Legacy row belongs to a deleted tenant and cannot be safely reassigned.',
        details: { sourceType: entry.type, hasBusinessProfile: entry.businessProfileId != null },
      });
      continue;
    }
    try {
      const result = await knowledgeIngestionService.indexLegacyEntry(entry, { autoPublish: true });
      const quarantined = result.status === 'quarantined'
        || result.quarantinedReasons.some((reason) => reason.startsWith('secret:') || reason.startsWith('injection:'));
      await recordReconciliation({
        entry,
        outcome: quarantined ? 'quarantined' : 'reconciled',
        documentId: result.documentId,
        versionId: result.versionId,
        details: {
          lifecycleStatus: result.status,
          chunkCount: result.chunkCount,
          vectorIndexed: result.vectorIndexed,
          skipped: result.skipped ?? false,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ id: entry.id, error: message });
      await recordFailure(entry, error);
      await recordReconciliation({ entry, outcome: 'failed', reason: message.slice(0, 1000) });
    }
  }

  const state = await snapshot() as Record<string, unknown>;
  if (Number(state.legacy_count) !== Number(state.reconciled_count)) {
    throw new Error(`Knowledge reconciliation incomplete: ${state.reconciled_count}/${state.legacy_count}`);
  }
  if (failures.length > 0 && !process.argv.includes('--allow-failed')) {
    throw new Error(`${failures.length} entries failed migration; maintenance mode remains active. Re-run with --allow-failed only after review.`);
  }
  await setRuntime(true, false);
  console.info(JSON.stringify({ mode: selectedMode, status: 'knowledge_v2_enabled', failures, snapshot: await snapshot() }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool?.end();
  });
