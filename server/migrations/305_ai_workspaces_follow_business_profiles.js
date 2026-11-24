/** Legacy AI workspace rows are report-branding adapters. Business profile is
 * the only customer workspace identity; existing project IDs remain stable. */
export async function up(db) {
  await db.query(`
    SELECT set_config('app.business_system','on',true);
    ALTER TABLE ai_visibility_workspaces ADD COLUMN business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE CASCADE;
    CREATE INDEX ai_visibility_workspace_business ON ai_visibility_workspaces(business_profile_id);
    DO $$ DECLARE w record; p record; adapter_id integer; first_profile boolean; BEGIN
      FOR w IN SELECT * FROM ai_visibility_workspaces ORDER BY id LOOP
        first_profile:=true;
        FOR p IN SELECT DISTINCT project.business_profile_id,profile.user_id
          FROM ai_visibility_projects project JOIN company_settings profile ON profile.id=project.business_profile_id
          WHERE project.workspace_id=w.id ORDER BY project.business_profile_id LOOP
          IF p.user_id<>w.owner_user_id THEN RAISE EXCEPTION 'AI workspace owner mismatch for workspace %',w.id; END IF;
          IF first_profile THEN
            UPDATE ai_visibility_workspaces SET business_profile_id=p.business_profile_id WHERE id=w.id;
            adapter_id:=w.id; first_profile:=false;
          ELSE
            PERFORM set_config('app.business_profile_id',p.business_profile_id::text,true);
            INSERT INTO ai_visibility_workspaces(owner_user_id,organization_id,business_profile_id,name,kind,white_label_defaults,status,created_at,updated_at)
              VALUES(w.owner_user_id,w.organization_id,p.business_profile_id,w.name,w.kind,w.white_label_defaults,w.status,w.created_at,w.updated_at)
              RETURNING id INTO adapter_id;
            INSERT INTO ai_visibility_workspace_memberships(workspace_id,user_id,role,status,invited_by_user_id,created_at,updated_at)
              SELECT adapter_id,user_id,role,status,invited_by_user_id,created_at,updated_at
              FROM ai_visibility_workspace_memberships WHERE workspace_id=w.id;
            UPDATE ai_visibility_projects SET workspace_id=adapter_id WHERE workspace_id=w.id AND business_profile_id=p.business_profile_id;
            UPDATE ai_visibility_asset_approval_decisions SET workspace_id=adapter_id
              WHERE workspace_id=w.id AND business_profile_id=p.business_profile_id;
          END IF;
        END LOOP;
        IF first_profile THEN
          UPDATE ai_visibility_workspaces SET business_profile_id=(SELECT MIN(id) FROM company_settings
            WHERE user_id=w.owner_user_id HAVING COUNT(*)=1) WHERE id=w.id;
        END IF;
      END LOOP;
      PERFORM set_config('app.business_profile_id','',true);
    END $$;
    CREATE FUNCTION ai_workspace_business_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.business_profile_id IS NULL OR NOT EXISTS(SELECT 1 FROM company_settings p WHERE p.id=NEW.business_profile_id AND p.user_id=NEW.owner_user_id) THEN
        RAISE EXCEPTION 'AI workspace requires its owning business profile' USING ERRCODE='42501';
      END IF;
      IF TG_OP='UPDATE' AND OLD.business_profile_id IS DISTINCT FROM NEW.business_profile_id THEN
        RAISE EXCEPTION 'AI workspace business cannot be reassigned' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ai_workspace_business_guard BEFORE INSERT OR UPDATE ON ai_visibility_workspaces
      FOR EACH ROW EXECUTE FUNCTION ai_workspace_business_guard();
  `);
}
export async function down() {
  throw new Error(
    "Business identity migration requires restoring the verified backup.",
  );
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
