/**
 * Migration: create_embedding_usages
 * Creates the embedding_usages table for tracking embedding API usage and costs.
 * Also seeds the embedding_margin pricing row in api_pricing.
 */

export async function up(client) {
  // Embedding usage tracking table
  await client.query(`
    CREATE TABLE IF NOT EXISTS embedding_usages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider VARCHAR(50) NOT NULL DEFAULT 'openai',
      model VARCHAR(100) NOT NULL,
      purpose VARCHAR(100) NOT NULL DEFAULT 'embedding',
      service VARCHAR(100) NOT NULL DEFAULT 'EmbeddingService',
      action VARCHAR(255),
      input_tokens INTEGER,
      total_tokens INTEGER,
      estimated_cost_cents INTEGER DEFAULT 0,
      original_cost_cents INTEGER DEFAULT 0,
      dimensions INTEGER,
      texts_count INTEGER DEFAULT 1,
      response_success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      duration_ms INTEGER,
      metadata JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_embedding_usages_user_id ON embedding_usages (user_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_embedding_usages_created_at ON embedding_usages (created_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_embedding_usages_provider ON embedding_usages (provider)
  `);

  // Seed embedding_margin pricing row
  await client.query(`
    INSERT INTO api_pricing (category, pricing_key, name, provider, margin_percentage, unit_label, is_active, sort_order)
    VALUES ('embedding', 'embedding_margin', 'Embedding API Margin', NULL, 20, 'per 1M tokens', true, 60)
    ON CONFLICT (pricing_key) DO NOTHING
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS embedding_usages`);
  await client.query(`DELETE FROM api_pricing WHERE pricing_key = 'embedding_margin'`);
}
