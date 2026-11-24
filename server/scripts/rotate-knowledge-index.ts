import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { pgPool } from '../models/db.js';
import { embeddingService } from '../services/embeddings/EmbeddingService.js';
import { withKnowledgeAdminTransaction, withTenantKnowledgeTransaction } from '../services/knowledge/KnowledgeTenantTransaction.js';

const execute = process.argv.includes('--execute');

async function main() {
  const current = await withKnowledgeAdminTransaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT iv.id, iv.version_key, iv.provider, iv.model, iv.dimensions
      FROM knowledge_runtime_settings rs
      LEFT JOIN knowledge_index_versions iv ON iv.id = rs.active_index_version_id
      WHERE rs.id = 1
    `);
    return result.rows[0] as Record<string, unknown> | undefined;
  });
  const resolved = await embeddingService.resolveProviderAndModel();
  const provider = await embeddingService.createProvider(resolved.provider);
  const probeResponse = await provider.generateEmbeddings({
    text: 'AskSales knowledge index readiness probe',
    model: resolved.model,
  });
  if (!probeResponse.success || probeResponse.embeddings.length !== 1 || probeResponse.dimensions <= 0) {
    throw new Error(probeResponse.error || 'The target embedding provider failed its readiness probe.');
  }
  const probe = {
    provider: resolved.provider,
    model: probeResponse.model || resolved.model,
    dimensions: probeResponse.dimensions,
  };
  const versionKey = `${probe.provider}:${probe.model}:${probe.dimensions}:v1`;
  const inventory = await withKnowledgeAdminTransaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT COUNT(*)::int AS chunks, COUNT(DISTINCT c.user_id)::int AS tenants
      FROM knowledge_chunks c
      JOIN knowledge_document_versions v ON v.id = c.version_id AND v.user_id = c.user_id
      WHERE v.status IN ('ready_for_review', 'published', 'published_degraded')
    `);
    return result.rows[0] as Record<string, unknown>;
  });
  if (!execute) {
    process.stdout.write(`${JSON.stringify({
      mode: 'plan', current, target: { ...resolved, dimensions: probe.dimensions, versionKey }, inventory,
    }, null, 2)}\n`);
    return;
  }

  const targetId = await withKnowledgeAdminTransaction(async (tx) => {
    const inserted = await tx.execute(sql`
      INSERT INTO knowledge_index_versions(version_key, provider, model, dimensions, state)
      VALUES (${versionKey}, ${probe.provider}, ${probe.model}, ${probe.dimensions}, 'building')
      ON CONFLICT (version_key) DO UPDATE SET
        state = CASE WHEN knowledge_index_versions.state = 'active' THEN 'active' ELSE 'building' END
      RETURNING id
    `);
    return Number((inserted.rows[0] as Record<string, unknown>).id);
  });

  const tenantRows = await withKnowledgeAdminTransaction(async (tx) => tx.execute(sql`
    SELECT DISTINCT c.user_id
    FROM knowledge_chunks c
    JOIN knowledge_document_versions v ON v.id = c.version_id AND v.user_id = c.user_id
    WHERE v.status IN ('ready_for_review', 'published', 'published_degraded')
    ORDER BY c.user_id
  `));
  let indexedChunks = 0;
  try {
    for (const tenant of tenantRows.rows as Array<Record<string, unknown>>) {
      const userId = Number(tenant.user_id);
      const pending = await withTenantKnowledgeTransaction(userId, (tx) => tx.execute(sql`
        SELECT c.id, c.search_text
        FROM knowledge_chunks c
        JOIN knowledge_document_versions v ON v.id = c.version_id AND v.user_id = c.user_id
        LEFT JOIN knowledge_chunk_embeddings e
          ON e.chunk_id = c.id AND e.user_id = c.user_id AND e.index_version_id = ${targetId}
        WHERE c.user_id = ${userId}
          AND v.status IN ('ready_for_review', 'published', 'published_degraded')
          AND e.id IS NULL
        ORDER BY c.id
      `)) as { rows: unknown[] };
      const chunks = pending.rows as Array<{ id: number; search_text: string }>;
      for (let offset = 0; offset < chunks.length; offset += 50) {
        const batch = chunks.slice(offset, offset + 50);
        // This is administrator maintenance, not a tenant content request.
        // Use the selected adapter directly so rebuilding existing knowledge
        // does not deduct credits from customer wallets a second time.
        const response = await provider.generateEmbeddings({
          text: batch.map((chunk) => String(chunk.search_text)),
          model: probe.model,
        });
        if (!response.success || response.model !== probe.model) {
          throw new Error(response.error || 'The provider changed the index model during the rebuild.');
        }
        const generated = { vectors: response.embeddings, dimensions: response.dimensions };
        if (generated.dimensions !== probe.dimensions || generated.vectors.length !== batch.length) {
          throw new Error(`Embedding response mismatch for tenant ${userId}.`);
        }
        await withTenantKnowledgeTransaction(userId, async (tx) => {
          for (let index = 0; index < batch.length; index += 1) {
            const vector = generated.vectors[index];
            if (vector.length !== probe.dimensions || !vector.every(Number.isFinite)) {
              throw new Error(`Invalid embedding vector for chunk ${batch[index].id}.`);
            }
            const vectorLiteral = `[${vector.join(',')}]`;
            await tx.execute(sql`
              INSERT INTO knowledge_chunk_embeddings(
                user_id, chunk_id, index_version_id, provider, model,
                dimensions, content_hash, embedding, metadata
              ) VALUES (
                ${userId}, ${batch[index].id}, ${targetId}, ${probe.provider}, ${probe.model},
                ${probe.dimensions}, ${crypto.createHash('sha256').update(batch[index].search_text).digest('hex')},
                ${sql.raw(`'${vectorLiteral}'::vector`)},
                ${JSON.stringify({ indexRotation: true, versionKey })}::jsonb
              )
              ON CONFLICT (chunk_id, index_version_id) DO UPDATE SET
                embedding = EXCLUDED.embedding,
                content_hash = EXCLUDED.content_hash,
                provider = EXCLUDED.provider,
                model = EXCLUDED.model,
                dimensions = EXCLUDED.dimensions,
                metadata = EXCLUDED.metadata
            `);
          }
        });
        indexedChunks += batch.length;
      }
    }

    const missing = await withKnowledgeAdminTransaction(async (tx) => tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM knowledge_chunks c
      JOIN knowledge_document_versions v ON v.id = c.version_id AND v.user_id = c.user_id
      LEFT JOIN knowledge_chunk_embeddings e
        ON e.chunk_id = c.id AND e.user_id = c.user_id AND e.index_version_id = ${targetId}
      WHERE v.status IN ('ready_for_review', 'published', 'published_degraded') AND e.id IS NULL
    `));
    const missingCount = Number((missing.rows[0] as Record<string, unknown>).count);
    if (missingCount > 0) throw new Error(`${missingCount} chunks are still missing from the target index.`);

    await withKnowledgeAdminTransaction(async (tx) => {
      await tx.execute(sql`
        UPDATE knowledge_index_versions SET state = 'retired'
        WHERE state = 'active' AND id <> ${targetId}
      `);
      await tx.execute(sql`
        UPDATE knowledge_index_versions
        SET state = 'active', activated_at = COALESCE(activated_at, NOW())
        WHERE id = ${targetId}
      `);
      await tx.execute(sql`
        UPDATE knowledge_runtime_settings
        SET active_index_version_id = ${targetId}, updated_at = NOW()
        WHERE id = 1
      `);
      await tx.execute(sql`
        UPDATE knowledge_document_versions v
        SET vector_index_status = 'completed',
            status = CASE WHEN status = 'published_degraded' THEN 'published' ELSE status END,
            diagnostics = COALESCE(diagnostics, '{}'::jsonb)
              || ${JSON.stringify({ rotatedIndexVersion: versionKey })}::jsonb
        WHERE v.status IN ('ready_for_review', 'published', 'published_degraded')
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_chunks c
            LEFT JOIN knowledge_chunk_embeddings e
              ON e.chunk_id = c.id AND e.user_id = c.user_id AND e.index_version_id = ${targetId}
            WHERE c.version_id = v.id AND c.user_id = v.user_id AND e.id IS NULL
          )
      `);
    });
  } catch (error) {
    await withKnowledgeAdminTransaction((tx) => tx.execute(sql`
      UPDATE knowledge_index_versions SET state = 'failed' WHERE id = ${targetId} AND state <> 'active'
    `));
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    mode: 'executed', previous: current, active: { id: targetId, versionKey, ...resolved, dimensions: probe.dimensions }, indexedChunks,
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool?.end();
  });
