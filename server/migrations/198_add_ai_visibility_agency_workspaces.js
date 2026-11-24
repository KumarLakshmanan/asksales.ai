/**
 * Backward-compatible agency workspace foundation for AI Visibility.
 * Existing projects keep their owner and receive one private workspace plus
 * an explicit owner membership. No audit, score, report, or asset is moved.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_organizations (
      id SERIAL PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) NOT NULL,
      white_label_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ai_visibility_organizations_owner_slug_uq UNIQUE (owner_user_id, slug)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ai_visibility_organizations_owner_idx ON ai_visibility_organizations(owner_user_id, updated_at DESC)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_workspaces (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER REFERENCES ai_visibility_organizations(id) ON DELETE SET NULL,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      kind VARCHAR(24) NOT NULL DEFAULT 'private'
        CHECK (kind IN ('private', 'client')),
      white_label_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ai_visibility_workspaces_owner_idx ON ai_visibility_workspaces(owner_user_id, updated_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ai_visibility_workspaces_organization_idx ON ai_visibility_workspaces(organization_id, updated_at DESC)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_workspace_memberships (
      id SERIAL PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES ai_visibility_workspaces(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(32) NOT NULL
        CHECK (role IN ('owner', 'agency_admin', 'editor', 'client_reviewer')),
      status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
      invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ai_visibility_workspace_memberships_workspace_user_uq UNIQUE (workspace_id, user_id)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ai_visibility_workspace_memberships_user_idx ON ai_visibility_workspace_memberships(user_id, status)`);

  await client.query(`ALTER TABLE ai_visibility_projects ADD COLUMN IF NOT EXISTS workspace_id INTEGER`);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ai_visibility_projects_workspace_id_fkey'
      ) THEN
        ALTER TABLE ai_visibility_projects
          ADD CONSTRAINT ai_visibility_projects_workspace_id_fkey
          FOREIGN KEY (workspace_id) REFERENCES ai_visibility_workspaces(id) ON DELETE RESTRICT;
      END IF;
    END $$
  `);
  await client.query(`
    DO $$
    DECLARE
      project_row RECORD;
      new_workspace_id INTEGER;
    BEGIN
      FOR project_row IN
        SELECT id, user_id, name FROM ai_visibility_projects WHERE workspace_id IS NULL ORDER BY id
      LOOP
        INSERT INTO ai_visibility_workspaces (owner_user_id, name, kind)
        VALUES (project_row.user_id, project_row.name, 'private')
        RETURNING id INTO new_workspace_id;

        INSERT INTO ai_visibility_workspace_memberships (workspace_id, user_id, role, status, invited_by_user_id)
        VALUES (new_workspace_id, project_row.user_id, 'owner', 'active', project_row.user_id)
        ON CONFLICT (workspace_id, user_id) DO NOTHING;

        UPDATE ai_visibility_projects SET workspace_id = new_workspace_id WHERE id = project_row.id;
      END LOOP;
    END $$
  `);
  await client.query(`ALTER TABLE ai_visibility_projects ALTER COLUMN workspace_id SET NOT NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS ai_visibility_projects_workspace_idx ON ai_visibility_projects(workspace_id, updated_at DESC)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_visibility_asset_approval_decisions (
      id SERIAL PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES ai_visibility_workspaces(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_visibility_projects(id) ON DELETE CASCADE,
      generated_asset_link_id INTEGER NOT NULL REFERENCES ai_visibility_generated_asset_links(id) ON DELETE CASCADE,
      content_asset_id INTEGER NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
      asset_version INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      decision VARCHAR(16) NOT NULL CHECK (decision IN ('approved', 'rejected')),
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ai_visibility_asset_approval_decisions_asset_version_uq UNIQUE (content_asset_id, asset_version)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ai_visibility_asset_approval_decisions_project_idx ON ai_visibility_asset_approval_decisions(project_id, created_at DESC)`);
}

export async function down(client) {
  await client.query('DROP TABLE IF EXISTS ai_visibility_asset_approval_decisions');
  await client.query('ALTER TABLE ai_visibility_projects DROP COLUMN IF EXISTS workspace_id');
  await client.query('DROP TABLE IF EXISTS ai_visibility_workspace_memberships');
  await client.query('DROP TABLE IF EXISTS ai_visibility_workspaces');
  await client.query('DROP TABLE IF EXISTS ai_visibility_organizations');
}
