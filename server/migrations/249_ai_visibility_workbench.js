export async function up(client) {
  await client.query(`
    ALTER TABLE ai_visibility_prompt_runs DROP CONSTRAINT IF EXISTS ai_visibility_prompt_runs_status_check;
    ALTER TABLE ai_visibility_prompt_runs ADD CONSTRAINT ai_visibility_prompt_runs_status_check
      CHECK (status IN ('completed', 'failed', 'skipped', 'excluded'));
    ALTER TABLE ai_visibility_projects
      ADD COLUMN IF NOT EXISTS configuration_revision integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS geo_prompts jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE ai_visibility_crawled_pages
      ADD COLUMN IF NOT EXISTS redirect_chain jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS missing_alt_elements jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE ai_visibility_audits
      ADD COLUMN IF NOT EXISTS correction_revision integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS corrected_at timestamptz;
    ALTER TABLE ai_visibility_recommendations
      ADD COLUMN IF NOT EXISTS issue_key varchar(64),
      ADD COLUMN IF NOT EXISTS assignee_user_id integer REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS due_date date,
      ADD COLUMN IF NOT EXISTS resolution_evidence text,
      ADD COLUMN IF NOT EXISTS verification_status varchar(24) NOT NULL DEFAULT 'unverified',
      ADD COLUMN IF NOT EXISTS verified_at timestamptz;
    CREATE INDEX IF NOT EXISTS ai_visibility_recommendations_issue_idx
      ON ai_visibility_recommendations(project_id, issue_key);
    CREATE TABLE IF NOT EXISTS ai_visibility_asset_versions (
      id serial PRIMARY KEY,
      generated_asset_link_id integer NOT NULL REFERENCES ai_visibility_generated_asset_links(id) ON DELETE CASCADE,
      version integer NOT NULL,
      title text NOT NULL,
      content text NOT NULL,
      actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(generated_asset_link_id, version)
    );
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE ai_visibility_prompt_runs SET status = 'failed' WHERE status IN ('skipped', 'excluded');
    ALTER TABLE ai_visibility_prompt_runs DROP CONSTRAINT IF EXISTS ai_visibility_prompt_runs_status_check;
    ALTER TABLE ai_visibility_prompt_runs ADD CONSTRAINT ai_visibility_prompt_runs_status_check CHECK (status IN ('completed', 'failed'));
    ALTER TABLE ai_visibility_crawled_pages DROP COLUMN IF EXISTS redirect_chain, DROP COLUMN IF EXISTS missing_alt_elements;
    DROP TABLE IF EXISTS ai_visibility_asset_versions;
    DROP INDEX IF EXISTS ai_visibility_recommendations_issue_idx;
    ALTER TABLE ai_visibility_recommendations DROP COLUMN IF EXISTS issue_key,
      DROP COLUMN IF EXISTS assignee_user_id, DROP COLUMN IF EXISTS due_date,
      DROP COLUMN IF EXISTS resolution_evidence, DROP COLUMN IF EXISTS verification_status,
      DROP COLUMN IF EXISTS verified_at;
    ALTER TABLE ai_visibility_audits DROP COLUMN IF EXISTS correction_revision, DROP COLUMN IF EXISTS corrected_at;
    ALTER TABLE ai_visibility_projects DROP COLUMN IF EXISTS configuration_revision, DROP COLUMN IF EXISTS geo_prompts;
  `);
}
