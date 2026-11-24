/** Business profiles are the workspace identity. Existing payer IDs and every
 * financial row remain unchanged; a payer is no longer a separate workspace. */
const sources = [
  "company_settings",
  "business_profile_memberships",
  "ai_visibility_workspaces",
  "billing_organization_memberships",
  "crm_contacts",
  "storage_files",
  "ai_agent_configs",
  "team_members",
  "support_teams",
  "crm_pipeline_automations",
  "workflows",
  "knowledge_base",
  "knowledge_documents",
  "channel_credentials",
  "meta_page_connections",
  "email_senders",
  "api_credentials",
];

export async function up(db) {
  await db.query(`
    SELECT set_config('app.business_system','on',true);
    CREATE TABLE business_profile_memberships (
      id SERIAL PRIMARY KEY,
      business_profile_id INTEGER NOT NULL REFERENCES company_settings(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL CHECK(email=lower(trim(email)) AND length(email)>0),
      role TEXT NOT NULL CHECK(role IN('owner','billing_admin','member')),
      status TEXT NOT NULL CHECK(status IN('active','invited','revoked')),
      invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      legacy_billing_membership_id INTEGER REFERENCES billing_organization_memberships(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(business_profile_id,email), UNIQUE(business_profile_id,user_id),
      CHECK(status<>'active' OR user_id IS NOT NULL), CHECK(role<>'owner' OR status='active')
    );
    CREATE UNIQUE INDEX business_profile_one_owner ON business_profile_memberships(business_profile_id) WHERE role='owner';
    CREATE INDEX business_profile_member_access ON business_profile_memberships(user_id,business_profile_id) WHERE status='active';
    CREATE TABLE business_profile_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      default_business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL
    );
    CREATE TABLE business_profile_membership_audit (
      id BIGSERIAL PRIMARY KEY,
      business_profile_id INTEGER REFERENCES company_settings(id) ON DELETE SET NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO business_scope_accounts(table_name) VALUES
      ('business_profile_memberships'),('business_profile_preferences'),('business_profile_membership_audit');
    GRANT SELECT,INSERT,UPDATE,DELETE ON business_profile_memberships,business_profile_preferences,business_profile_membership_audit TO salesmarketing_business_runtime;
    GRANT USAGE,SELECT ON SEQUENCE business_profile_memberships_id_seq,business_profile_membership_audit_id_seq TO salesmarketing_business_runtime;

    INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status)
      SELECT p.id,u.id,lower(trim(u.email)),'owner','active' FROM company_settings p JOIN users u ON u.id=p.user_id;
    -- Financial memberships remain in their original table. They never granted
    -- business data access, so owners explicitly invite staff to a profile.
    INSERT INTO business_profile_preferences(user_id,default_business_profile_id)
      SELECT DISTINCT ON(user_id) user_id,id FROM company_settings ORDER BY user_id,is_default DESC,id;

    CREATE FUNCTION app_business_actor_user_id() RETURNS INTEGER LANGUAGE sql STABLE AS
      $$ SELECT COALESCE(NULLIF(current_setting('app.business_actor_user_id',true),'')::integer,app_business_user_id()) $$;
    CREATE FUNCTION app_business_access(p_profile INTEGER) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path=public,pg_catalog AS $$
      SELECT app_business_system() OR (p_profile=app_business_profile_id() AND EXISTS(
        SELECT 1 FROM company_settings p JOIN users owner ON owner.id=p.user_id AND owner.deleted_at IS NULL
        JOIN users actor ON actor.id=app_business_actor_user_id() AND actor.deleted_at IS NULL
        WHERE p.id=p_profile AND p.user_id=app_business_user_id() AND
          (p.user_id=actor.id OR EXISTS(SELECT 1 FROM business_profile_memberships m
            WHERE m.business_profile_id=p.id AND m.user_id=actor.id AND m.status='active'))))
    $$;
    DO $$ DECLARE t record; BEGIN
      FOR t IN SELECT table_name FROM business_scope_tables LOOP
        EXECUTE format('DROP POLICY business_isolation ON %I',t.table_name);
        EXECUTE format('CREATE POLICY business_isolation ON %I FOR ALL USING (app_business_access(business_profile_id)) WITH CHECK (app_business_access(business_profile_id))',t.table_name);
      END LOOP;
    END $$;

    CREATE FUNCTION initialize_business_profile_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status)
        SELECT NEW.id,u.id,lower(trim(u.email)),'owner','active' FROM users u WHERE u.id=NEW.user_id;
      INSERT INTO business_profile_preferences(user_id,default_business_profile_id) VALUES(NEW.user_id,NEW.id) ON CONFLICT(user_id) DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE TRIGGER business_profile_owner AFTER INSERT ON company_settings FOR EACH ROW EXECUTE FUNCTION initialize_business_profile_owner();

    CREATE OR REPLACE FUNCTION billing_resource_organization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE resource_owner INTEGER; profile_payer INTEGER;
    BEGIN
      resource_owner:=(to_jsonb(NEW)->>TG_ARGV[0])::integer;
      IF TG_OP='UPDATE' THEN
        IF (to_jsonb(OLD)->>TG_ARGV[0])::integer IS DISTINCT FROM resource_owner OR NEW.billing_organization_id IS DISTINCT FROM OLD.billing_organization_id THEN
          RAISE EXCEPTION 'Business ownership and its billing account cannot be reassigned' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
      END IF;
      PERFORM pg_advisory_xact_lock(740301,resource_owner);
      IF TG_TABLE_NAME='company_settings' THEN
        -- Creating a business always uses its creator's account, including when
        -- the creator currently has a colleague's workspace selected.
        NEW.billing_organization_id:=billing_default_organization(resource_owner);
      ELSE
        SELECT billing_organization_id INTO profile_payer FROM company_settings
          WHERE id=app_business_profile_id() AND user_id=resource_owner;
        NEW.billing_organization_id:=COALESCE(profile_payer,billing_default_organization(resource_owner));
      END IF;
      PERFORM id FROM billing_organizations WHERE id=NEW.billing_organization_id FOR UPDATE;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION billing_capacity_authorize(p_org INTEGER) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM billing_organizations WHERE id=p_org) THEN RAISE EXCEPTION 'Billing account not found' USING ERRCODE='42501'; END IF;
      IF app_business_system() OR pg_trigger_depth()>0 THEN RETURN; END IF;
      IF EXISTS(SELECT 1 FROM company_settings WHERE id=app_business_profile_id() AND billing_organization_id=p_org
        AND app_business_access(id)) THEN RETURN; END IF;
      IF app_business_profile_id() IS NULL AND EXISTS(SELECT 1 FROM billing_organizations
        WHERE id=p_org AND owner_user_id=app_billing_actor_user_id()) THEN RETURN; END IF;
      RAISE EXCEPTION 'Business billing access denied' USING ERRCODE='42501';
    END $$;

    ALTER FUNCTION billing_capacity_units(text,jsonb) RENAME TO billing_capacity_units_v302;
    CREATE FUNCTION billing_capacity_units(p_source text,r jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE units jsonb;
    BEGIN
      IF p_source IN('ai_visibility_workspaces','billing_organization_memberships') THEN RETURN '[]'::jsonb; END IF;
      IF p_source='business_profile_memberships' THEN RETURN billing_capacity_units_v302('billing_organization_memberships',r); END IF;
      units:=billing_capacity_units_v302(p_source,r);
      IF p_source='company_settings' AND r->>'id' IS NOT NULL THEN
        units:=units||jsonb_build_array(jsonb_build_object('key','workspaces','identity','business:'||(r->>'id'),'amount',1));
      END IF;
      RETURN units;
    END $$;
    CREATE TRIGGER zz_billing_capacity AFTER INSERT OR UPDATE OR DELETE ON business_profile_memberships
      FOR EACH ROW EXECUTE FUNCTION billing_capacity_resource_trigger();
    DELETE FROM billing_capacity_items WHERE source_table IN('company_settings','billing_organization_memberships','ai_visibility_workspaces');
    INSERT INTO billing_capacity_items(source_table,source_id,resource_key,identity_key,organization_id,business_profile_id,amount)
      SELECT 'company_settings',p.id::text,u->>'key',u->>'identity',p.billing_organization_id,p.id,(u->>'amount')::bigint
      FROM company_settings p CROSS JOIN LATERAL jsonb_array_elements(billing_capacity_units('company_settings',to_jsonb(p))) u;
    INSERT INTO billing_capacity_items(source_table,source_id,resource_key,identity_key,organization_id,business_profile_id,amount)
      SELECT 'business_profile_memberships',m.id::text,u->>'key',u->>'identity',p.billing_organization_id,p.id,(u->>'amount')::bigint
      FROM business_profile_memberships m JOIN company_settings p ON p.id=m.business_profile_id
      CROSS JOIN LATERAL jsonb_array_elements(billing_capacity_units('business_profile_memberships',to_jsonb(m))) u;
    DELETE FROM billing_capacity_totals;
    INSERT INTO billing_capacity_totals(organization_id,resource_key,usage)
      SELECT organization_id,resource_key,SUM(amount) FROM (
        SELECT organization_id,resource_key,identity_key,MAX(amount) AS amount FROM billing_capacity_items
        GROUP BY organization_id,resource_key,identity_key
      ) identities GROUP BY organization_id,resource_key;
  `);

  const actual = [];
  for (const source of sources) {
    if (
      !(await db.query("SELECT to_regclass($1) AS name", [`public.${source}`]))
        .rows[0]?.name
    )
      continue;
    const direct = [
      "company_settings",
      "ai_visibility_workspaces",
      "billing_organization_memberships",
    ].includes(source);
    const org = ["company_settings", "ai_visibility_workspaces"].includes(
      source,
    )
      ? "r.billing_organization_id"
      : source === "billing_organization_memberships"
        ? "r.organization_id"
        : "p.billing_organization_id";
    actual.push(`SELECT '${source}'::text AS source_table,r.id::text AS source_id,u->>'key' AS resource_key,
      u->>'identity' AS identity_key,(u->>'amount')::bigint AS amount FROM ${source} r
      ${direct ? "" : "JOIN company_settings p ON p.id=r.business_profile_id"}
      CROSS JOIN LATERAL jsonb_array_elements(billing_capacity_units('${source}',to_jsonb(r))) u WHERE ${org}=p_org`);
  }
  await db.query(`CREATE OR REPLACE FUNCTION billing_capacity_reconciliation(p_org integer) RETURNS jsonb LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    DECLARE result jsonb; old_system text;
    BEGIN
      PERFORM billing_capacity_authorize(p_org);
      old_system:=COALESCE(current_setting('app.business_system',true),'off');
      PERFORM set_config('app.business_system','on',true);
      WITH actual_units AS (
        ${actual.join("\nUNION ALL\n")}
        UNION ALL SELECT 'billing_storage_reservations',id::text,'storageBytes','reservation:'||id,bytes
          FROM billing_storage_reservations WHERE organization_id=p_org
      ), registry_units AS (SELECT * FROM billing_capacity_items WHERE organization_id=p_org),
      identity_mismatches AS (
        SELECT DISTINCT COALESCE(a.resource_key,r.resource_key) AS resource_key FROM actual_units a FULL JOIN registry_units r
          USING(source_table,source_id,resource_key,identity_key) WHERE a.amount IS DISTINCT FROM r.amount
      ), actual AS (
        SELECT resource_key,SUM(amount) AS amount FROM
          (SELECT resource_key,identity_key,MAX(amount) AS amount FROM actual_units GROUP BY resource_key,identity_key) identities GROUP BY resource_key
      ), registry AS (
        SELECT resource_key,SUM(amount) AS amount FROM
          (SELECT resource_key,identity_key,MAX(amount) AS amount FROM registry_units GROUP BY resource_key,identity_key) identities GROUP BY resource_key
      ), comparison AS (
        SELECT COALESCE(a.resource_key,r.resource_key,t.resource_key) AS resource,
          COALESCE(a.amount,0) AS actual,COALESCE(r.amount,0) AS registry,COALESCE(t.usage,0) AS counter
        FROM actual a FULL JOIN registry r USING(resource_key)
        FULL JOIN (SELECT * FROM billing_capacity_totals WHERE organization_id=p_org) t USING(resource_key)
      ) SELECT COALESCE(jsonb_agg(to_jsonb(c)) FILTER(WHERE actual<>registry OR actual<>counter
          OR EXISTS(SELECT 1 FROM identity_mismatches m WHERE m.resource_key=c.resource)),'[]') INTO result FROM comparison c;
      PERFORM set_config('app.business_system',old_system,true);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      IF old_system IS NOT NULL THEN PERFORM set_config('app.business_system',old_system,true); END IF;
      RAISE;
    END $$;`);
}

export async function down() {
  throw new Error(
    "Business staff and financial ownership must be preserved. Use a forward migration or restore a verified backup.",
  );
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
