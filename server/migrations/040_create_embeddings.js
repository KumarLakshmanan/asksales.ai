/**
 * Migration: create_embeddings
 * Creates the embeddings table for vector storage and the embedding_settings table
 * for admin configuration of embedding providers.
 *
 * Uses pgvector extension for efficient similarity search.
 */

export async function up(client) {
  // Enable pgvector extension
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  // Embedding settings — admin-level default provider/model config
  await client.query(`
    CREATE TABLE IF NOT EXISTS embedding_settings (
      id SERIAL PRIMARY KEY,
      default_provider VARCHAR(50) NOT NULL DEFAULT 'openai',
      default_model VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-small',
      enabled_providers JSONB NOT NULL DEFAULT '["openai"]',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Seed a single settings row
  await client.query(`
    INSERT INTO embedding_settings (default_provider, default_model, enabled_providers)
    VALUES ('openai', 'text-embedding-3-small', '["openai"]')
    ON CONFLICT DO NOTHING
  `);

  // Main embeddings table
  // Note: embedding column uses vector without fixed dimensions to support multiple models
  // (text-embedding-3-small=1536d, text-embedding-3-large=3072d, gemini models=768d/3072d).
  // HNSW index requires <=2000 dimensions, so we skip it and use exact cosine distance search.
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
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Indexes for fast lookups and dedup
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_embeddings_user_id ON embeddings (user_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings (source_type, source_id)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_content_hash_model ON embeddings (user_id, content_hash, provider, model)
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS embeddings`);
  await client.query(`DROP TABLE IF EXISTS embedding_settings`);
  // Note: we do NOT drop the vector extension as other tables may depend on it
}
