export async function up(client) {
  await client.query(`
    ALTER TABLE knowledge_base
      ADD COLUMN IF NOT EXISTS extraction_status VARCHAR(20) NOT NULL DEFAULT 'completed',
      ADD COLUMN IF NOT EXISTS indexing_status VARCHAR(20) NOT NULL DEFAULT 'completed'
  `);
  await client.query(`
    UPDATE knowledge_base
    SET extraction_status = CASE
          WHEN processing_status IN ('queued', 'processing', 'reprocessing') THEN processing_status
          WHEN processing_status = 'failed' AND content IS NULL THEN 'failed'
          ELSE 'completed'
        END,
        indexing_status = CASE
          WHEN processing_status = 'completed' THEN 'completed'
          WHEN processing_status = 'failed' AND content IS NOT NULL THEN 'failed'
          ELSE processing_status
        END
  `);
  await client.query(`
    ALTER TABLE knowledge_base
      ADD CONSTRAINT knowledge_base_extraction_status_check
        CHECK (extraction_status IN ('queued', 'processing', 'reprocessing', 'completed', 'failed')),
      ADD CONSTRAINT knowledge_base_indexing_status_check
        CHECK (indexing_status IN ('queued', 'processing', 'reprocessing', 'completed', 'failed'))
  `).catch((error) => {
    if (error?.code !== '42710') throw error;
  });
}

export async function down(client) {
  await client.query(`
    ALTER TABLE knowledge_base
      DROP CONSTRAINT IF EXISTS knowledge_base_extraction_status_check,
      DROP CONSTRAINT IF EXISTS knowledge_base_indexing_status_check,
      DROP COLUMN IF EXISTS extraction_status,
      DROP COLUMN IF EXISTS indexing_status
  `);
}
