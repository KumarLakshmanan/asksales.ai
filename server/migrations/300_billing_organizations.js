/** Billing organizations share payment responsibility, never business access. */
export async function up(db) {
  await db.query(`
    CREATE TABLE billing_organizations (
      id SERIAL PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      default_for_user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      name VARCHAR(255) NOT NULL CHECK(length(trim(name)) > 0),
      billing_eligibility_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(default_for_user_id IS NULL OR default_for_user_id=owner_user_id)
    );
    CREATE INDEX billing_organizations_owner_idx ON billing_organizations(owner_user_id);
    CREATE TABLE billing_organization_memberships (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES billing_organizations(id) ON DELETE RESTRICT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email VARCHAR(255) NOT NULL CHECK(email=lower(trim(email))),
      role TEXT NOT NULL CHECK(role IN('owner','billing_admin','member')),
      status TEXT NOT NULL CHECK(status IN('active','invited','revoked')),
      invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(organization_id,email),
      UNIQUE(organization_id,user_id),
      CHECK(status<>'active' OR user_id IS NOT NULL),
      CHECK(role<>'owner' OR status='active')
    );
    CREATE INDEX billing_organization_memberships_user_idx ON billing_organization_memberships(user_id,status);
    CREATE UNIQUE INDEX billing_organization_one_owner ON billing_organization_memberships(organization_id) WHERE role='owner';
    CREATE TABLE billing_organization_audit (
      id BIGSERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES billing_organizations(id) ON DELETE RESTRICT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO business_scope_accounts(table_name) VALUES
      ('billing_organizations'),('billing_organization_memberships'),('billing_organization_audit');

    CREATE FUNCTION app_billing_organization_id() RETURNS INTEGER LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('app.billing_organization_id',true),'')::integer $$;
    CREATE FUNCTION app_billing_actor_user_id() RETURNS INTEGER LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('app.billing_actor_user_id',true),'')::integer $$;

    CREATE FUNCTION billing_default_organization(account_user_id INTEGER) RETURNS INTEGER LANGUAGE plpgsql AS $$
    DECLARE org_id INTEGER; account_email TEXT; account_name TEXT; eligible_at TIMESTAMPTZ;
    BEGIN
      SELECT id INTO org_id FROM billing_organizations WHERE default_for_user_id=account_user_id;
      IF org_id IS NOT NULL THEN RETURN org_id; END IF;
      PERFORM pg_advisory_xact_lock(740300,account_user_id);
      SELECT id INTO org_id FROM billing_organizations WHERE default_for_user_id=account_user_id;
      IF org_id IS NOT NULL THEN RETURN org_id; END IF;
      SELECT lower(trim(email)),name,created_at AT TIME ZONE 'UTC' INTO account_email,account_name,eligible_at
        FROM users WHERE id=account_user_id;
      IF account_email IS NULL THEN RAISE EXCEPTION 'Billing account does not exist' USING ERRCODE='23503'; END IF;
      INSERT INTO billing_organizations(owner_user_id,default_for_user_id,name,billing_eligibility_at)
        VALUES(account_user_id,account_user_id,left(COALESCE(NULLIF(trim(account_name),''),'My'),242)||' organization',eligible_at)
        RETURNING id INTO org_id;
      INSERT INTO billing_organization_memberships(organization_id,user_id,email,role,status)
        VALUES(org_id,account_user_id,account_email,'owner','active');
      RETURN org_id;
    END $$;
    SELECT billing_default_organization(id) FROM users ORDER BY id;

    ALTER TABLE company_settings ADD COLUMN billing_organization_id INTEGER REFERENCES billing_organizations(id) ON DELETE RESTRICT;
    UPDATE company_settings SET billing_organization_id=billing_default_organization(user_id);
    ALTER TABLE company_settings ALTER COLUMN billing_organization_id SET NOT NULL;
    CREATE INDEX company_settings_billing_org_idx ON company_settings(billing_organization_id);
    ALTER TABLE ai_visibility_workspaces ADD COLUMN billing_organization_id INTEGER REFERENCES billing_organizations(id) ON DELETE RESTRICT;
    UPDATE ai_visibility_workspaces SET billing_organization_id=billing_default_organization(owner_user_id);
    ALTER TABLE ai_visibility_workspaces ALTER COLUMN billing_organization_id SET NOT NULL;
    CREATE INDEX ai_visibility_workspaces_billing_org_idx ON ai_visibility_workspaces(billing_organization_id);

    CREATE FUNCTION billing_initialize_user() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN PERFORM billing_default_organization(NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER billing_initialize_user AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION billing_initialize_user();

    CREATE FUNCTION billing_resource_organization_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE resource_owner INTEGER; selected_org INTEGER; selected_actor INTEGER;
    BEGIN
      resource_owner:=(to_jsonb(NEW)->>TG_ARGV[0])::integer;
      IF TG_OP='UPDATE' AND NEW.billing_organization_id IS NOT DISTINCT FROM OLD.billing_organization_id THEN
        IF (to_jsonb(OLD)->>TG_ARGV[0])::integer IS DISTINCT FROM resource_owner THEN
          RAISE EXCEPTION 'Changing a business resource owner is not supported' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
      END IF;
      PERFORM pg_advisory_xact_lock(740301,resource_owner);
      IF TG_OP='UPDATE' THEN
        selected_actor:=NULLIF(current_setting('app.billing_assignment_actor',true),'')::integer;
        selected_org:=NULLIF(current_setting('app.billing_assignment_target',true),'')::integer;
        IF selected_actor IS DISTINCT FROM resource_owner OR selected_org IS DISTINCT FROM NEW.billing_organization_id THEN
          RAISE EXCEPTION 'Use the authorized organization assignment operation' USING ERRCODE='42501';
        END IF;
      ELSE
        selected_org:=app_billing_organization_id(); selected_actor:=app_billing_actor_user_id();
        NEW.billing_organization_id:=COALESCE(NEW.billing_organization_id,selected_org,billing_default_organization(resource_owner));
        IF selected_org IS NOT NULL AND NEW.billing_organization_id<>selected_org THEN
          RAISE EXCEPTION 'Billing organization differs from the selected organization' USING ERRCODE='42501';
        END IF;
        IF selected_actor IS NOT NULL AND selected_actor<>resource_owner THEN
          RAISE EXCEPTION 'Only the resource owner can choose its billing organization' USING ERRCODE='42501';
        END IF;
      END IF;
      PERFORM id FROM billing_organizations WHERE id=NEW.billing_organization_id FOR UPDATE;
      IF NOT EXISTS(SELECT 1 FROM billing_organization_memberships
        WHERE organization_id=NEW.billing_organization_id AND user_id=resource_owner AND status='active') THEN
        RAISE EXCEPTION 'Resource owner must be a member of its billing organization' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER billing_organization_guard BEFORE INSERT OR UPDATE ON company_settings
      FOR EACH ROW EXECUTE FUNCTION billing_resource_organization_guard('user_id');
    CREATE TRIGGER billing_organization_guard BEFORE INSERT OR UPDATE ON ai_visibility_workspaces
      FOR EACH ROW EXECUTE FUNCTION billing_resource_organization_guard('owner_user_id');

    -- Project links cannot attach a workspace to a business funded by another
    -- organization. The locks also serialize link creation with assignments.
    CREATE FUNCTION billing_project_organization_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE profile_org INTEGER; workspace_org INTEGER; workspace_owner INTEGER;
    BEGIN
      IF NEW.business_profile_id IS NULL THEN RETURN NEW; END IF;
      PERFORM pg_advisory_xact_lock(740301,NEW.user_id);
      PERFORM o.id FROM billing_organizations o WHERE o.id IN(
        SELECT billing_organization_id FROM company_settings WHERE id=NEW.business_profile_id
        UNION SELECT billing_organization_id FROM ai_visibility_workspaces WHERE id=NEW.workspace_id
      ) ORDER BY o.id FOR UPDATE;
      SELECT billing_organization_id INTO profile_org FROM company_settings WHERE id=NEW.business_profile_id FOR UPDATE;
      SELECT billing_organization_id,owner_user_id INTO workspace_org,workspace_owner FROM ai_visibility_workspaces WHERE id=NEW.workspace_id FOR UPDATE;
      IF profile_org IS DISTINCT FROM workspace_org OR workspace_owner IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'Business and workspace must have the same owner and billing organization' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zzz_billing_project_organization BEFORE INSERT OR UPDATE ON ai_visibility_projects
      FOR EACH ROW EXECUTE FUNCTION billing_project_organization_guard();

    CREATE FUNCTION billing_linked_resource_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.billing_organization_id IS NOT DISTINCT FROM OLD.billing_organization_id THEN RETURN NULL; END IF;
      IF EXISTS(SELECT 1 FROM ai_visibility_projects p
        JOIN company_settings b ON b.id=p.business_profile_id
        JOIN ai_visibility_workspaces w ON w.id=p.workspace_id
        WHERE ((TG_TABLE_NAME='company_settings' AND b.id=NEW.id)
          OR (TG_TABLE_NAME='ai_visibility_workspaces' AND w.id=NEW.id))
        AND b.billing_organization_id<>w.billing_organization_id) THEN
        RAISE EXCEPTION 'Linked businesses and workspaces must move together' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER billing_linked_resource_guard AFTER UPDATE ON company_settings
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_linked_resource_guard();
    CREATE CONSTRAINT TRIGGER billing_linked_resource_guard AFTER UPDATE ON ai_visibility_workspaces
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_linked_resource_guard();

    GRANT SELECT,INSERT,UPDATE,DELETE ON billing_organizations,billing_organization_memberships,billing_organization_audit
      TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON SEQUENCE billing_organizations_id_seq,billing_organization_memberships_id_seq,billing_organization_audit_id_seq
      TO salesmarketing_business_runtime;
  `);
}

export async function down() {
  throw new Error('Organization billing ownership must be preserved. Use a reviewed forward migration or restore the pre-migration backup.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
