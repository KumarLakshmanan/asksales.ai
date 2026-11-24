/** Governed, tenant-isolated support media galleries. */
export async function up(client) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_media_galleries (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT,
      audience VARCHAR(20) NOT NULL DEFAULT 'customer',
      usage_scopes TEXT[] NOT NULL DEFAULT ARRAY['support_answer']::TEXT[],
      allowed_channels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      locale VARCHAR(24),
      product_scope JSONB NOT NULL DEFAULT '{}'::JSONB,
      entity_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      helpful_auto_attach BOOLEAN NOT NULL DEFAULT FALSE,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      current_published_version_id BIGINT,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_media_gallery_status_ck CHECK (status IN ('active', 'retired')),
      CONSTRAINT support_media_gallery_audience_ck CHECK (audience IN ('customer', 'internal'))
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_media_gallery_versions (
      id BIGSERIAL PRIMARY KEY,
      gallery_id BIGINT NOT NULL REFERENCES support_media_galleries(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      content_checksum VARCHAR(64) NOT NULL,
      rights_certified BOOLEAN NOT NULL DEFAULT FALSE,
      certification JSONB NOT NULL DEFAULT '{}'::JSONB,
      scan_results JSONB NOT NULL DEFAULT '{}'::JSONB,
      effective_at TIMESTAMP,
      expires_at TIMESTAMP,
      supersedes_version_id BIGINT REFERENCES support_media_gallery_versions(id) ON DELETE SET NULL,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP,
      published_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(gallery_id, version_no),
      CONSTRAINT support_media_version_status_ck CHECK (status IN (
        'draft','scanning','ready_for_review','published','quarantined','failed','retired'
      ))
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_media_assets (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id BIGINT NOT NULL REFERENCES support_media_galleries(id) ON DELETE CASCADE,
      gallery_version_id BIGINT NOT NULL REFERENCES support_media_gallery_versions(id) ON DELETE CASCADE,
      storage_file_id INTEGER NOT NULL REFERENCES storage_files(id) ON DELETE RESTRICT,
      derivative_storage_file_id INTEGER NOT NULL REFERENCES storage_files(id) ON DELETE RESTRICT,
      evidence_id VARCHAR(180) NOT NULL UNIQUE,
      name VARCHAR(180) NOT NULL,
      owner_description TEXT,
      alt_text VARCHAR(500) NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      mime_type VARCHAR(80) NOT NULL,
      size_bytes INTEGER NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      sensitivity VARCHAR(30) NOT NULL DEFAULT 'business',
      owner_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      internal_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      search_text TEXT NOT NULL,
      search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(search_text, ''))) STORED,
      publication_state VARCHAR(30) NOT NULL DEFAULT 'scanning',
      scan_results JSONB NOT NULL DEFAULT '{}'::JSONB,
      retired_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_media_asset_state_ck CHECK (publication_state IN (
        'scanning','published','ready_for_review','quarantined','failed','retired'
      ))
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_media_asset_embeddings (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id BIGINT NOT NULL REFERENCES support_media_assets(id) ON DELETE CASCADE,
      index_version_id BIGINT NOT NULL REFERENCES knowledge_index_versions(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      model VARCHAR(120) NOT NULL,
      dimensions INTEGER NOT NULL,
      content_hash VARCHAR(64) NOT NULL,
      embedding VECTOR,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(asset_id, index_version_id),
      CONSTRAINT support_media_embedding_dimensions_ck CHECK (dimensions > 0 AND vector_dims(embedding) = dimensions)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_media_retrieval_audits (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      conversation_id INTEGER,
      purpose VARCHAR(40) NOT NULL,
      channel VARCHAR(40) NOT NULL,
      media_intent VARCHAR(20) NOT NULL,
      query_fingerprint VARCHAR(64) NOT NULL,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      selected_evidence_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      decision_reason VARCHAR(500),
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_media_delivery_parts (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER,
      channel VARCHAR(40) NOT NULL,
      inbound_provider_message_id VARCHAR(255),
      inbound_message_id INTEGER,
      decision_audit_id BIGINT,
      delivery_action_id BIGINT,
      asset_id BIGINT NOT NULL REFERENCES support_media_assets(id) ON DELETE RESTRICT,
      evidence_id VARCHAR(180) NOT NULL,
      asset_version VARCHAR(64) NOT NULL,
      part_index INTEGER NOT NULL,
      media_intent VARCHAR(20) NOT NULL,
      required BOOLEAN NOT NULL DEFAULT FALSE,
      idempotency_key VARCHAR(64) NOT NULL UNIQUE,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      provider_media_id VARCHAR(255),
      provider_message_id VARCHAR(255),
      failure_code VARCHAR(80),
      failure_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      reconciliation_state VARCHAR(30) NOT NULL DEFAULT 'not_required',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`ALTER TABLE support_media_galleries
    ADD CONSTRAINT support_media_gallery_published_version_fk
    FOREIGN KEY (current_published_version_id) REFERENCES support_media_gallery_versions(id) ON DELETE SET NULL`)
    .catch((error) => { if (error.code !== '42710') throw error; });

  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_gallery_scope ON support_media_galleries(user_id, business_profile_id, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_version_status ON support_media_gallery_versions(user_id, status, effective_at, expires_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_asset_scope ON support_media_assets(user_id, gallery_id, gallery_version_id, publication_state)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_asset_search ON support_media_assets USING GIN(search_tsv)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_asset_tags ON support_media_assets USING GIN(owner_tags)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_embedding_768_hnsw
    ON support_media_asset_embeddings USING hnsw ((embedding::vector(768)) vector_cosine_ops)
    WHERE dimensions=768`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_embedding_1536_hnsw
    ON support_media_asset_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
    WHERE dimensions=1536`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_embedding_3072_hnsw
    ON support_media_asset_embeddings USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
    WHERE dimensions=3072`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_support_media_delivery_status ON support_media_delivery_parts(user_id, status, updated_at)`);

  const tenantTables = [
    'support_media_galleries', 'support_media_gallery_versions', 'support_media_assets',
    'support_media_asset_embeddings', 'support_media_retrieval_audits', 'support_media_delivery_parts',
  ];
  for (const table of tenantTables) {
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS ${table}_tenant_policy ON ${table}`);
    await client.query(`
      CREATE POLICY ${table}_tenant_policy ON ${table}
      USING (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER
        OR current_setting('app.support_media_admin', true) = 'on'
      )
      WITH CHECK (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER
        OR current_setting('app.support_media_admin', true) = 'on'
      )
    `);
  }
}

export async function down() {
  // Media and its immutable audit trail are intentionally retained. Galleries can
  // be retired and delivery globally disabled without destructive rollback.
}
