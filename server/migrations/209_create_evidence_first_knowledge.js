/**
 * Evidence-first knowledge architecture.
 *
 * The legacy knowledge_base/embeddings tables remain intact for the rollback
 * window. Runtime cutover is controlled by knowledge_runtime_settings.
 */
export async function up(client) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_index_versions (
      id BIGSERIAL PRIMARY KEY,
      version_key VARCHAR(160) NOT NULL UNIQUE,
      provider VARCHAR(50) NOT NULL,
      model VARCHAR(120) NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0 AND dimensions <= 16000),
      state VARCHAR(20) NOT NULL DEFAULT 'building'
        CHECK (state IN ('building', 'active', 'retired', 'failed')),
      activated_at TIMESTAMP,
      retired_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      legacy_entry_id INTEGER REFERENCES knowledge_base(id) ON DELETE SET NULL,
      source_type VARCHAR(30) NOT NULL
        CHECK (source_type IN ('document', 'file', 'qa', 'url', 'managed')),
      title VARCHAR(255) NOT NULL,
      description VARCHAR(1000),
      source_url VARCHAR(2048),
      owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      audience VARCHAR(20) NOT NULL DEFAULT 'customer'
        CHECK (audience IN ('customer', 'internal', 'restricted')),
      access_scope VARCHAR(30) NOT NULL DEFAULT 'tenant'
        CHECK (access_scope IN ('tenant', 'business_profile', 'staff_only', 'restricted')),
      usage_scopes TEXT[] NOT NULL DEFAULT ARRAY['support_answer']::TEXT[],
      allowed_channels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      locale VARCHAR(24),
      product_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
      current_published_version_id BIGINT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_documents_legacy_entry
      ON knowledge_documents(user_id, legacy_entry_id)
      WHERE legacy_entry_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_tenant_profile
      ON knowledge_documents(user_id, business_profile_id)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_document_versions (
      id BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL CHECK (version_no > 0),
      status VARCHAR(30) NOT NULL DEFAULT 'draft'
        CHECK (status IN (
          'draft', 'extracting', 'privacy_scan', 'chunking', 'indexing',
          'ready_for_review', 'published', 'published_degraded',
          'quarantined', 'retired', 'failed', 'ocr_required'
        )),
      content_hash VARCHAR(64) NOT NULL,
      normalized_content TEXT NOT NULL,
      authority VARCHAR(40) NOT NULL DEFAULT 'owner_authored',
      privacy_classification VARCHAR(30) NOT NULL DEFAULT 'business'
        CHECK (privacy_classification IN ('public', 'business', 'internal', 'personal', 'restricted', 'secret')),
      effective_at TIMESTAMP,
      expires_at TIMESTAMP,
      review_due_at TIMESTAMP,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP,
      supersedes_version_id BIGINT REFERENCES knowledge_document_versions(id) ON DELETE SET NULL,
      extraction_status VARCHAR(20) NOT NULL DEFAULT 'completed',
      lexical_index_status VARCHAR(20) NOT NULL DEFAULT 'queued',
      vector_index_status VARCHAR(20) NOT NULL DEFAULT 'queued',
      diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(document_id, version_no)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_versions_publication
      ON knowledge_document_versions(user_id, status, effective_at, expires_at)
  `);

  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_knowledge_documents_published_version'
      ) THEN
        ALTER TABLE knowledge_documents
          ADD CONSTRAINT fk_knowledge_documents_published_version
          FOREIGN KEY (current_published_version_id)
          REFERENCES knowledge_document_versions(id) ON DELETE SET NULL;
      END IF;
    END $$
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      version_id BIGINT NOT NULL REFERENCES knowledge_document_versions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      evidence_id VARCHAR(180) NOT NULL UNIQUE,
      display_text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      section_path TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      page_number INTEGER,
      sheet_name VARCHAR(255),
      row_start INTEGER,
      row_end INTEGER,
      char_start INTEGER,
      char_end INTEGER,
      token_count INTEGER NOT NULL CHECK (token_count > 0),
      previous_chunk_id BIGINT REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
      next_chunk_id BIGINT REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
      access_scope VARCHAR(30) NOT NULL DEFAULT 'tenant',
      sensitivity VARCHAR(30) NOT NULL DEFAULT 'business',
      exact_identifiers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      injection_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(search_text, ''))) STORED,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(version_id, ordinal)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant_document
      ON knowledge_chunks(user_id, document_id, version_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_lexical
      ON knowledge_chunks USING GIN(search_tsv)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_identifiers
      ON knowledge_chunks USING GIN(exact_identifiers)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chunk_id BIGINT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
      index_version_id BIGINT NOT NULL REFERENCES knowledge_index_versions(id) ON DELETE RESTRICT,
      provider VARCHAR(50) NOT NULL,
      model VARCHAR(120) NOT NULL,
      dimensions INTEGER NOT NULL,
      content_hash VARCHAR(64) NOT NULL,
      embedding vector NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(chunk_id, index_version_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_embeddings_tenant
      ON knowledge_chunk_embeddings(user_id, index_version_id, chunk_id)
  `);

  // Known provider dimensions receive typed ANN indexes. Unknown/future model
  // versions continue to work with exact search until an operator creates the
  // corresponding typed partial index.
  await client.query(`
    DO $$ BEGIN
      BEGIN
        CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_hnsw_768
          ON knowledge_chunk_embeddings USING hnsw
          ((embedding::vector(768)) vector_cosine_ops)
          WHERE dimensions = 768;
      EXCEPTION WHEN feature_not_supported OR undefined_object THEN NULL;
      END;
      BEGIN
        CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_hnsw_1536
          ON knowledge_chunk_embeddings USING hnsw
          ((embedding::vector(1536)) vector_cosine_ops)
          WHERE dimensions = 1536;
      EXCEPTION WHEN feature_not_supported OR undefined_object THEN NULL;
      END;
      BEGIN
        CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_hnsw_3072
          ON knowledge_chunk_embeddings USING hnsw
          ((embedding::halfvec(3072)) halfvec_cosine_ops)
          WHERE dimensions = 3072;
      EXCEPTION WHEN feature_not_supported OR undefined_object THEN NULL;
      END;
    END $$
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_retrieval_audits (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      purpose VARCHAR(40) NOT NULL,
      channel VARCHAR(40) NOT NULL,
      audience VARCHAR(20) NOT NULL,
      query_fingerprint VARCHAR(64) NOT NULL,
      retrieval_status VARCHAR(30) NOT NULL,
      index_version_key VARCHAR(160),
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      candidate_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      selected_evidence_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      latency_ms INTEGER NOT NULL DEFAULT 0,
      reranked BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_audits_expiry
      ON knowledge_retrieval_audits(expires_at)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_runtime_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      knowledge_v2_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
      active_index_version_id BIGINT REFERENCES knowledge_index_versions(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_governance_audits (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id BIGINT REFERENCES knowledge_documents(id) ON DELETE SET NULL,
      version_id BIGINT REFERENCES knowledge_document_versions(id) ON DELETE SET NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(40) NOT NULL,
      reason VARCHAR(1000),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_governance_audits_tenant ON knowledge_governance_audits(user_id, created_at DESC)`);
  await client.query(`
    INSERT INTO knowledge_runtime_settings(id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);

  // Tenant isolation is enforced in the database as well as in every query.
  // Runtime transactions set app.current_user_id with SET LOCAL.
  for (const table of [
    'knowledge_documents',
    'knowledge_document_versions',
    'knowledge_chunks',
    'knowledge_chunk_embeddings',
    'knowledge_retrieval_audits',
    'knowledge_governance_audits',
  ]) {
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = current_schema()
            AND tablename = '${table}'
            AND policyname = '${table}_tenant_isolation'
        ) THEN
          CREATE POLICY ${table}_tenant_isolation ON ${table}
            USING (
              user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER
              OR current_setting('app.knowledge_admin', true) = 'on'
            )
            WITH CHECK (
              user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER
              OR current_setting('app.knowledge_admin', true) = 'on'
            );
        END IF;
      END $$
    `);
  }
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS knowledge_governance_audits CASCADE`);
  await client.query(`DROP TABLE IF EXISTS knowledge_retrieval_audits CASCADE`);
  await client.query(`DROP TABLE IF EXISTS knowledge_runtime_settings CASCADE`);
  await client.query(`DROP TABLE IF EXISTS knowledge_chunk_embeddings CASCADE`);
  await client.query(`DROP TABLE IF EXISTS knowledge_chunks CASCADE`);
  await client.query(`DROP TABLE IF EXISTS knowledge_document_versions CASCADE`);
  await client.query(`DROP TABLE IF EXISTS knowledge_documents CASCADE`);
  await client.query(`DROP TABLE IF EXISTS knowledge_index_versions CASCADE`);
}
