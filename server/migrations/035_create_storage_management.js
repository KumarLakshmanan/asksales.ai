/**
 * Migration: create_storage_management
 * Creates storage_plans, storage_quotas, storage_files, and storage_pricing tables
 * for multi-tenant storage management system.
 */

export async function up(client) {
  // Storage plans - defines different storage tiers
  await client.query(`
    CREATE TABLE IF NOT EXISTS storage_plans (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      max_storage_bytes BIGINT NOT NULL DEFAULT 1073741824,
      price_per_gb_cents INTEGER NOT NULL DEFAULT 0,
      is_default BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Storage quotas - per-user storage tracking
  await client.query(`
    CREATE TABLE IF NOT EXISTS storage_quotas (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      plan_id INTEGER REFERENCES storage_plans(id) ON DELETE SET NULL,
      storage_used_bytes BIGINT NOT NULL DEFAULT 0,
      max_storage_bytes BIGINT,
      file_count INTEGER NOT NULL DEFAULT 0,
      last_calculated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Storage files - metadata for every uploaded file
  await client.query(`
    CREATE TABLE IF NOT EXISTS storage_files (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_name VARCHAR(500) NOT NULL,
      original_name VARCHAR(500),
      storage_key VARCHAR(1000) NOT NULL,
      storage_backend VARCHAR(20) NOT NULL DEFAULT 'local',
      mime_type VARCHAR(200),
      file_size_bytes BIGINT NOT NULL DEFAULT 0,
      category VARCHAR(100) NOT NULL DEFAULT 'general',
      reference_type VARCHAR(100),
      reference_id VARCHAR(255),
      url TEXT,
      metadata JSONB DEFAULT '{}',
      is_deleted BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Storage pricing - admin-configurable pricing per GB
  await client.query(`
    CREATE TABLE IF NOT EXISTS storage_pricing (
      id SERIAL PRIMARY KEY,
      pricing_key VARCHAR(100) NOT NULL UNIQUE,
      name VARCHAR(200) NOT NULL,
      description TEXT,
      price_per_gb_cents INTEGER NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      is_active BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Indexes
  await client.query(`CREATE INDEX IF NOT EXISTS idx_storage_quotas_user_id ON storage_quotas(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_storage_quotas_plan_id ON storage_quotas(plan_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_storage_files_user_id ON storage_files(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_storage_files_category ON storage_files(category)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_storage_files_storage_key ON storage_files(storage_key)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_storage_files_reference ON storage_files(reference_type, reference_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_storage_files_is_deleted ON storage_files(is_deleted) WHERE is_deleted = false`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_storage_plans_is_default ON storage_plans(is_default) WHERE is_default = true`);

  // Seed default storage plan (1 GB free)
  await client.query(`
    INSERT INTO storage_plans (name, description, max_storage_bytes, price_per_gb_cents, is_default)
    VALUES ('Free', 'Default free plan with 1 GB storage', 1073741824, 0, true)
    ON CONFLICT (name) DO NOTHING
  `);

  // Seed default storage pricing
  await client.query(`
    INSERT INTO storage_pricing (pricing_key, name, description, price_per_gb_cents)
    VALUES
      ('default', 'Default Storage Pricing', 'Standard per-GB pricing for all users', 10),
      ('premium', 'Premium Storage Pricing', 'Discounted per-GB pricing for premium plans', 5)
    ON CONFLICT (pricing_key) DO NOTHING
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS storage_files`);
  await client.query(`DROP TABLE IF EXISTS storage_quotas`);
  await client.query(`DROP TABLE IF EXISTS storage_pricing`);
  await client.query(`DROP TABLE IF EXISTS storage_plans`);
}
