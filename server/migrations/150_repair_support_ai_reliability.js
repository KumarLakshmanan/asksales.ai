/**
 * Repair drift discovered in development support-AI installations.
 *
 * - Restores the pgvector-backed embeddings shape without deleting vectors.
 * - Recreates partial idempotency indexes with the predicates used at runtime.
 * - Enables managed specialist agents that have enabled managed assignments.
 */
export async function up(client) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  // Some development databases recorded the original knowledge-base migration
  // without retaining the relation. Restore the current application shape
  // before embeddings are rebuilt; existing rows are never dropped.
  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      title VARCHAR(255) NOT NULL,
      description VARCHAR(500),
      content TEXT,
      type VARCHAR(50) NOT NULL DEFAULT 'document',
      processing_status VARCHAR(20) NOT NULL DEFAULT 'completed',
      file_name VARCHAR(255),
      file_type VARCHAR(100),
      file_size INTEGER,
      question TEXT,
      answer TEXT,
      source_url VARCHAR(2048),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE knowledge_base
      ADD COLUMN IF NOT EXISTS business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS description VARCHAR(500),
      ADD COLUMN IF NOT EXISTS content TEXT,
      ADD COLUMN IF NOT EXISTS type VARCHAR(50) NOT NULL DEFAULT 'document',
      ADD COLUMN IF NOT EXISTS processing_status VARCHAR(20) NOT NULL DEFAULT 'completed',
      ADD COLUMN IF NOT EXISTS file_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS file_type VARCHAR(100),
      ADD COLUMN IF NOT EXISTS file_size INTEGER,
      ADD COLUMN IF NOT EXISTS question TEXT,
      ADD COLUMN IF NOT EXISTS answer TEXT,
      ADD COLUMN IF NOT EXISTS source_url VARCHAR(2048),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_base_business_profile_id
    ON knowledge_base(business_profile_id)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_type VARCHAR(50) NOT NULL,
      source_id INTEGER,
      content_hash VARCHAR(64) NOT NULL,
      content TEXT NOT NULL,
      provider VARCHAR(50) NOT NULL,
      model VARCHAR(100) NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding vector,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE embeddings
      ADD COLUMN IF NOT EXISTS source_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS source_id INTEGER,
      ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64),
      ADD COLUMN IF NOT EXISTS content TEXT,
      ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
      ADD COLUMN IF NOT EXISTS model VARCHAR(100),
      ADD COLUMN IF NOT EXISTS dimensions INTEGER,
      ADD COLUMN IF NOT EXISTS embedding vector,
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
  `);
  await client.query(`
    UPDATE embeddings
    SET metadata = COALESCE(metadata, '{}'::jsonb),
        created_at = COALESCE(created_at, NOW()),
        updated_at = COALESCE(updated_at, created_at, NOW()),
        dimensions = COALESCE(dimensions, vector_dims(embedding))
    WHERE metadata IS NULL OR created_at IS NULL OR updated_at IS NULL
       OR (dimensions IS NULL AND embedding IS NOT NULL)
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_embeddings_user_id ON embeddings(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id)`);
  await client.query(`DROP INDEX IF EXISTS idx_embeddings_content_hash_model`);
  await client.query(`
    CREATE UNIQUE INDEX idx_embeddings_content_hash_model
    ON embeddings(user_id, source_type, source_id, content_hash, provider, model)
    NULLS NOT DISTINCT
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_embeddings_knowledge_source
    ON embeddings(user_id, source_id)
    WHERE source_type = 'knowledge_base' AND embedding IS NOT NULL
  `);

  await client.query(`DROP INDEX IF EXISTS support_ticket_messages_delivery_action_uq`);
  await client.query(`
    CREATE UNIQUE INDEX support_ticket_messages_delivery_action_uq
    ON support_ticket_messages(delivery_action_id)
    WHERE delivery_action_id IS NOT NULL
  `);
  await client.query(`DROP INDEX IF EXISTS outreach_messages_delivery_action_uq`);
  await client.query(`
    CREATE UNIQUE INDEX outreach_messages_delivery_action_uq
    ON outreach_messages(delivery_action_id)
    WHERE delivery_action_id IS NOT NULL
  `);

  // Managed playbook assignments are not usable when their managed agent is
  // disabled. Owner-customized agent choices remain untouched.
  await client.query(`
    UPDATE ai_agent_configs c
    SET enabled = TRUE,
        updated_at = NOW(),
        metadata = COALESCE(c.metadata, '{}'::jsonb)
          || '{"managedAssignmentAlignmentVersion":1}'::jsonb
    WHERE c.template_mode = 'managed'
      AND c.enabled IS NOT TRUE
      AND EXISTS (
        SELECT 1
        FROM support_playbook_assignments a
        JOIN support_playbooks p ON p.id = a.playbook_id
        WHERE a.user_id = c.user_id
          AND a.agent_type = c.agent_type
          AND a.enabled = TRUE
          AND p.status = 'published'
          AND p.template_mode = 'managed'
      )
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS idx_embeddings_knowledge_source`);
  // The repair intentionally does not disable agents or remove repaired
  // columns/indexes: doing so could discard valid post-migration data.
}
