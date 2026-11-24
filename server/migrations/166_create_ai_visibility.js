/**
 * AI Visibility foundation: tenant-owned projects, durable audit state,
 * immutable measurements, recommendations, assets, reports, and alerts.
 */
export async function up(client) {
  await client.query(`
    INSERT INTO platform_modules (module_key, name, description, status, sort_order)
    VALUES ('ai_visibility', 'AI Visibility', 'SEO, answer-engine, generative-engine, competitor, and monitoring audits.', 'disabled', 45)
    ON CONFLICT (module_key) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_projects (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      brand_toolkit_id INTEGER REFERENCES brand_toolkits(id) ON DELETE SET NULL,
      name VARCHAR(255) NOT NULL,
      domain TEXT NOT NULL,
      brand_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
      category VARCHAR(255),
      scoring_profile VARCHAR(32) NOT NULL DEFAULT 'general'
        CHECK (scoring_profile IN ('b2b_saas', 'ecommerce', 'local_business', 'general')),
      scoring_profile_version INTEGER NOT NULL DEFAULT 1,
      country VARCHAR(2) NOT NULL DEFAULT 'US',
      locale VARCHAR(16) NOT NULL DEFAULT 'en-US',
      target_geography TEXT,
      monitoring_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      monitoring_cadence VARCHAR(16) NOT NULL DEFAULT 'weekly' CHECK (monitoring_cadence IN ('weekly')),
      monitoring_estimated_credits NUMERIC(12,2) NOT NULL DEFAULT 0,
      next_monitoring_at TIMESTAMPTZ,
      status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_projects_user_idx ON ai_visibility_projects(user_id, updated_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_projects_domain_idx ON ai_visibility_projects(domain)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_competitors (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      domain TEXT NOT NULL,
      aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, domain)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_competitors_project_idx ON ai_visibility_competitors(project_id, active)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_audits (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(32) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','completed','completed_with_warnings','failed','cancelled')),
      trigger VARCHAR(24) NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','monitoring')),
      warning_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
      reserved_credits NUMERIC(12,2) NOT NULL DEFAULT 0,
      actual_credits NUMERIC(12,2) NOT NULL DEFAULT 0,
      reservation_transaction_id INTEGER,
      settled_at TIMESTAMPTZ,
      input_fingerprint VARCHAR(64),
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_audits_project_idx ON ai_visibility_audits(project_id, created_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_audits_user_status_idx ON ai_visibility_audits(user_id, status)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_audit_stages (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stage_key VARCHAR(48) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','completed','warning','failed','skipped','cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
      output_fingerprint VARCHAR(64),
      output JSONB,
      warning TEXT,
      error TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(audit_id, stage_key)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_audit_stages_status_idx ON ai_visibility_audit_stages(audit_id, status)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_crawled_pages (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      competitor_id INTEGER REFERENCES ai_visibility_competitors(id) ON DELETE SET NULL,
      target_type VARCHAR(16) NOT NULL DEFAULT 'brand' CHECK (target_type IN ('brand','competitor')),
      url TEXT NOT NULL,
      final_url TEXT,
      crawl_status VARCHAR(24) NOT NULL DEFAULT 'completed' CHECK (crawl_status IN ('completed','blocked','timed_out','uncrawlable','failed')),
      status_code INTEGER,
      redirect_count INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      meta_description TEXT,
      canonical_url TEXT,
      robots_directive TEXT,
      indexable BOOLEAN NOT NULL DEFAULT TRUE,
      headings JSONB NOT NULL DEFAULT '{}'::jsonb,
      word_count INTEGER NOT NULL DEFAULT 0,
      image_count INTEGER NOT NULL DEFAULT 0,
      images_missing_alt INTEGER NOT NULL DEFAULT 0,
      internal_links JSONB NOT NULL DEFAULT '[]'::jsonb,
      external_links JSONB NOT NULL DEFAULT '[]'::jsonb,
      broken_links JSONB NOT NULL DEFAULT '[]'::jsonb,
      json_ld JSONB NOT NULL DEFAULT '[]'::jsonb,
      schema_types JSONB NOT NULL DEFAULT '[]'::jsonb,
      page_type VARCHAR(48),
      content_hash VARCHAR(64),
      raw_html_key TEXT,
      error TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(audit_id, target_type, url)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_crawled_pages_audit_target_idx ON ai_visibility_crawled_pages(audit_id, target_type)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_seo_issues (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      page_id INTEGER REFERENCES ai_visibility_crawled_pages(id) ON DELETE CASCADE,
      rule_id VARCHAR(80) NOT NULL,
      rule_version INTEGER NOT NULL DEFAULT 1,
      group_name VARCHAR(40) NOT NULL,
      severity VARCHAR(16) NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
      affected_url TEXT,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      recommendation TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_seo_issues_audit_idx ON ai_visibility_seo_issues(audit_id, severity)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_prompts (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind VARCHAR(16) NOT NULL CHECK (kind IN ('keyword','aeo','geo')),
      prompt TEXT NOT NULL,
      normalized_prompt TEXT NOT NULL,
      prompt_hash VARCHAR(64) NOT NULL,
      intent VARCHAR(48),
      persona VARCHAR(100),
      locale VARCHAR(16) NOT NULL,
      target_page TEXT,
      is_generic BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_prompts_audit_idx ON ai_visibility_prompts(audit_id, kind)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_aeo_questions (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      intent VARCHAR(48) NOT NULL DEFAULT 'informational',
      target_page TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_aeo_questions_project_idx ON ai_visibility_aeo_questions(project_id, active)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_prompt_runs (
      id SERIAL PRIMARY KEY,
      prompt_id INTEGER NOT NULL REFERENCES ai_visibility_prompts(id) ON DELETE CASCADE,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(24) NOT NULL CHECK (provider IN ('openai','gemini','perplexity','manual')),
      model VARCHAR(100) NOT NULL,
      fidelity VARCHAR(24) NOT NULL CHECK (fidelity IN ('live_api','manual_capture','simulated')),
      status VARCHAR(24) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','failed')),
      answer TEXT,
      citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      brand_mentioned BOOLEAN,
      brand_rank INTEGER,
      sentiment VARCHAR(24),
      competitors JSONB NOT NULL DEFAULT '[]'::jsonb,
      recommendation_reason TEXT,
      exclusion_reason TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_cents NUMERIC(12,4) NOT NULL DEFAULT 0,
      cache_key VARCHAR(160),
      cached_from_run_id INTEGER,
      error TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(prompt_id, provider)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_prompt_runs_audit_provider_idx ON ai_visibility_prompt_runs(audit_id, provider)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_extraction_corrections (
      id SERIAL PRIMARY KEY,
      prompt_run_id INTEGER NOT NULL REFERENCES ai_visibility_prompt_runs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      normalized_prompt TEXT NOT NULL,
      provider VARCHAR(24) NOT NULL,
      correction JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(prompt_run_id, user_id)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_score_snapshots (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL UNIQUE REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scoring_profile VARCHAR(32) NOT NULL,
      scoring_version INTEGER NOT NULL DEFAULT 1,
      input_fingerprint VARCHAR(64) NOT NULL,
      overall_score NUMERIC(6,2) NOT NULL,
      seo_score NUMERIC(6,2),
      aeo_score NUMERIC(6,2),
      geo_score NUMERIC(6,2),
      commerce_score NUMERIC(6,2),
      pillar_statuses JSONB NOT NULL,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      sub_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_score_snapshots_project_created_idx ON ai_visibility_score_snapshots(project_id, created_at DESC)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_competitor_snapshots (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      competitor_id INTEGER REFERENCES ai_visibility_competitors(id) ON DELETE SET NULL,
      metrics JSONB NOT NULL,
      content_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_competitor_snapshots_audit_idx ON ai_visibility_competitor_snapshots(audit_id)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_commerce_snapshots (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      audit_id INTEGER REFERENCES ai_visibility_audits(id) ON DELETE SET NULL,
      source_type VARCHAR(24) NOT NULL CHECK (source_type IN ('csv','json','xml','shopify')),
      source_name VARCHAR(255) NOT NULL,
      storage_file_id INTEGER,
      input_fingerprint VARCHAR(64) NOT NULL,
      item_count INTEGER NOT NULL,
      valid_item_count INTEGER NOT NULL,
      score NUMERIC(6,2) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'scored',
      field_coverage JSONB NOT NULL,
      issues JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_commerce_snapshots_project_created_idx ON ai_visibility_commerce_snapshots(project_id, created_at DESC)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_recommendations (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module VARCHAR(24) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      severity VARCHAR(16) NOT NULL,
      impact VARCHAR(16) NOT NULL,
      effort VARCHAR(16) NOT NULL,
      affected_url TEXT,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence NUMERIC(5,2) NOT NULL DEFAULT 1,
      status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','rejected')),
      asset_type VARCHAR(48),
      generated_draft TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_recommendations_project_status_idx ON ai_visibility_recommendations(project_id, status)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_generated_asset_links (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      audit_id INTEGER NOT NULL REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      recommendation_id INTEGER REFERENCES ai_visibility_recommendations(id) ON DELETE SET NULL,
      content_asset_id INTEGER NOT NULL UNIQUE REFERENCES content_assets(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_reports (
      id SERIAL PRIMARY KEY,
      audit_id INTEGER NOT NULL UNIQUE REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
      storage_key TEXT,
      storage_file_id INTEGER,
      mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
      size_bytes INTEGER,
      methodology JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_alerts (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      audit_id INTEGER REFERENCES ai_visibility_audits(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(48) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      acknowledged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS ai_visibility_alerts_project_idx ON ai_visibility_alerts(project_id, created_at DESC)');

  await client.query(`
    INSERT INTO credit_pricing (event_key, name, description, category, credits_per_unit, unit_label, is_active, sort_order, metadata)
    VALUES
      ('ai_visibility_audit', 'AI Visibility audit reservation', 'Maximum reservation for a core SEO/AEO/GEO audit.', 'ai_visibility', 100, 'per audit reservation', TRUE, 700, '{"reservation":true}'::jsonb),
      ('ai_visibility_crawl_page', 'AI Visibility crawl page', 'Actual crawl usage component.', 'ai_visibility', 0.5, 'per page', TRUE, 701, '{}'::jsonb),
      ('ai_visibility_provider_prompt', 'AI Visibility provider prompt', 'Actual live provider observation component.', 'ai_visibility', 2, 'per provider prompt', TRUE, 702, '{}'::jsonb),
      ('ai_visibility_report', 'AI Visibility report', 'Audit report generation component.', 'ai_visibility', 5, 'per report', TRUE, 703, '{}'::jsonb),
      ('ai_visibility_monitoring', 'AI Visibility weekly monitoring', 'Maximum weekly monitoring reservation.', 'ai_visibility', 100, 'per run', TRUE, 704, '{"reservation":true}'::jsonb)
    ON CONFLICT (event_key) DO NOTHING
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_credit_reservation_uq
      ON wallet_transactions(user_id, reference_type, reference_id)
      WHERE type = 'refund' AND reference_type = 'credit_reservation'
  `);
}

export async function down(client) {
  await client.query('DROP INDEX IF EXISTS wallet_transactions_credit_reservation_uq');
  await client.query(`DELETE FROM credit_pricing WHERE event_key IN (
    'ai_visibility_audit','ai_visibility_crawl_page','ai_visibility_provider_prompt','ai_visibility_report','ai_visibility_monitoring'
  )`);
  await client.query('DROP TABLE IF EXISTS ai_visibility_alerts');
  await client.query('DROP TABLE IF EXISTS ai_visibility_reports');
  await client.query('DROP TABLE IF EXISTS ai_visibility_generated_asset_links');
  await client.query('DROP TABLE IF EXISTS ai_visibility_recommendations');
  await client.query('DROP TABLE IF EXISTS ai_visibility_competitor_snapshots');
  await client.query('DROP TABLE IF EXISTS ai_visibility_commerce_snapshots');
  await client.query('DROP TABLE IF EXISTS ai_visibility_score_snapshots');
  await client.query('DROP TABLE IF EXISTS ai_visibility_extraction_corrections');
  await client.query('DROP TABLE IF EXISTS ai_visibility_prompt_runs');
  await client.query('DROP TABLE IF EXISTS ai_visibility_prompts');
  await client.query('DROP TABLE IF EXISTS ai_visibility_aeo_questions');
  await client.query('DROP TABLE IF EXISTS ai_visibility_seo_issues');
  await client.query('DROP TABLE IF EXISTS ai_visibility_crawled_pages');
  await client.query('DROP TABLE IF EXISTS ai_visibility_audit_stages');
  await client.query('DROP TABLE IF EXISTS ai_visibility_audits');
  await client.query('DROP TABLE IF EXISTS ai_visibility_competitors');
  await client.query('DROP TABLE IF EXISTS ai_visibility_projects');
  await client.query("DELETE FROM platform_modules WHERE module_key = 'ai_visibility'");
}
