/** Durable setup drafts and separately queued website analysis. */
export async function up(client) {
  await client.query(`
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS archived_at timestamptz,
      ADD COLUMN IF NOT EXISTS creation_request_key varchar(100), ADD COLUMN IF NOT EXISTS creation_request_hash varchar(64);
    ALTER TABLE brand_toolkits ADD COLUMN IF NOT EXISTS creation_request_key varchar(100), ADD COLUMN IF NOT EXISTS creation_request_hash varchar(64);
    CREATE UNIQUE INDEX IF NOT EXISTS company_setup_request ON company_settings(user_id,creation_request_key) WHERE creation_request_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS brand_setup_request ON brand_toolkits(business_profile_id,creation_request_key) WHERE creation_request_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS workspace_setup_drafts (
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      draft_key varchar(100) NOT NULL, data jsonb, step integer NOT NULL DEFAULT 0 CHECK(step BETWEEN 0 AND 100),
      revision integer NOT NULL DEFAULT 1 CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id,draft_key)
    );
    CREATE TABLE IF NOT EXISTS workspace_website_analysis_jobs (
      id uuid PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_profile_id integer NOT NULL REFERENCES company_settings(id) ON DELETE RESTRICT,
      url text NOT NULL, force_refresh boolean NOT NULL DEFAULT false, idempotency_key varchar(100),
      status text NOT NULL CHECK(status IN('queued','running','completed','failed','cancelled')),
      stage text NOT NULL DEFAULT 'queued', detail text NOT NULL DEFAULT 'Waiting to analyze your website',
      progress jsonb NOT NULL DEFAULT '{}', result jsonb, error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(user_id,business_profile_id,idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_website_analysis_active ON workspace_website_analysis_jobs(business_profile_id) WHERE status IN('queued','running');
    CREATE INDEX IF NOT EXISTS workspace_website_analysis_recent ON workspace_website_analysis_jobs(business_profile_id,created_at DESC);
    INSERT INTO business_scope_accounts(table_name) VALUES('workspace_setup_drafts') ON CONFLICT DO NOTHING;
    GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_setup_drafts TO salesmarketing_business_runtime;
  `);
  const spec = {
    table_name: "workspace_website_analysis_jobs",
    owner_column: "user_id",
    global_read: false,
    parent_links: [],
    legacy_business_column: null,
  };
  await client.query(`INSERT INTO business_scope_tables(table_name,owner_column,global_read,parent_links)
    VALUES('workspace_website_analysis_jobs','user_id',false,'[]') ON CONFLICT DO NOTHING;
    ALTER TABLE workspace_website_analysis_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE workspace_website_analysis_jobs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS business_isolation ON workspace_website_analysis_jobs;
    CREATE POLICY business_isolation ON workspace_website_analysis_jobs FOR ALL USING(app_business_access(business_profile_id)) WITH CHECK(app_business_access(business_profile_id));
    DROP TRIGGER IF EXISTS zz_business_ownership ON workspace_website_analysis_jobs;
    DROP TRIGGER IF EXISTS business_ownership_guard ON workspace_website_analysis_jobs;
    CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON workspace_website_analysis_jobs FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${JSON.stringify(spec)}');
    CREATE CONSTRAINT TRIGGER business_ownership_guard AFTER INSERT OR UPDATE ON workspace_website_analysis_jobs NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('${JSON.stringify(spec)}');
    GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_website_analysis_jobs TO salesmarketing_business_runtime;`);
}
export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS workspace_website_analysis_jobs,workspace_setup_drafts;
    DELETE FROM business_scope_tables WHERE table_name='workspace_website_analysis_jobs';
    DELETE FROM business_scope_accounts WHERE table_name='workspace_setup_drafts';
    DROP INDEX IF EXISTS company_setup_request,brand_setup_request;
    ALTER TABLE brand_toolkits DROP COLUMN IF EXISTS creation_request_key,DROP COLUMN IF EXISTS creation_request_hash;
    ALTER TABLE company_settings DROP COLUMN IF EXISTS archived_at,DROP COLUMN IF EXISTS creation_request_key,DROP COLUMN IF EXISTS creation_request_hash;`);
}
