/**
 * Capacity is accounted at the database boundary, including imports and workers.
 * The registry contains identifiers and counts only, never customer content.
 * Tenant triggers remain SECURITY INVOKER; narrowly guarded helpers are the only
 * runtime writers of the registry. An organization row serializes reservations,
 * resource changes and transfers, so concurrent requests cannot overspend a cap.
 */
const sources = [
  'company_settings', 'ai_visibility_workspaces', 'billing_organization_memberships',
  'crm_contacts', 'storage_files', 'ai_agent_configs', 'team_members', 'support_teams',
  'crm_pipeline_automations', 'workflows', 'knowledge_base', 'knowledge_documents',
  'channel_credentials', 'meta_page_connections', 'email_senders', 'api_credentials',
];

export async function up(db) {
  await db.query(`
    SELECT set_config('app.business_system','on',true);
    ALTER TABLE subscription_settings ADD COLUMN IF NOT EXISTS capacity_enforced boolean NOT NULL DEFAULT false;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    DO $$ BEGIN
      IF to_regclass('public.knowledge_governance_audits') IS NOT NULL THEN
        UPDATE knowledge_documents d SET deleted_at=COALESCE(
          (SELECT MAX(created_at) FROM knowledge_governance_audits a WHERE a.document_id=d.id AND a.action='delete'),now())
        WHERE d.deleted_at IS NULL AND d.legacy_entry_id IS NULL AND EXISTS(
          SELECT 1 FROM knowledge_governance_audits a WHERE a.document_id=d.id AND a.action='delete');
      END IF;
    END $$;
    CREATE TABLE billing_capacity_items (
      source_table text NOT NULL, source_id text NOT NULL, resource_key text NOT NULL,
      identity_key text NOT NULL, organization_id integer NOT NULL REFERENCES billing_organizations(id),
      business_profile_id integer, workspace_id integer, amount bigint NOT NULL CHECK(amount >= 0),
      PRIMARY KEY(source_table,source_id,resource_key,identity_key)
    );
    CREATE INDEX billing_capacity_identity ON billing_capacity_items(organization_id,resource_key,identity_key) INCLUDE(amount);
    CREATE INDEX billing_capacity_profile ON billing_capacity_items(business_profile_id);
    CREATE INDEX billing_capacity_workspace ON billing_capacity_items(workspace_id);
    CREATE TABLE billing_capacity_totals (
      organization_id integer NOT NULL REFERENCES billing_organizations(id), resource_key text NOT NULL,
      usage bigint NOT NULL DEFAULT 0 CHECK(usage >= 0), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(organization_id,resource_key)
    );
    CREATE TABLE billing_storage_reservations (
      id uuid PRIMARY KEY, organization_id integer NOT NULL REFERENCES billing_organizations(id),
      business_profile_id integer NOT NULL, user_id integer NOT NULL REFERENCES users(id),
      bytes bigint NOT NULL CHECK(bytes >= 0), created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour'
    );
    INSERT INTO business_scope_accounts(table_name) VALUES
      ('billing_capacity_items'),('billing_capacity_totals'),('billing_storage_reservations');
    GRANT SELECT ON billing_capacity_items,billing_capacity_totals,billing_storage_reservations TO salesmarketing_business_runtime;
    REVOKE INSERT,UPDATE,DELETE ON billing_capacity_items,billing_capacity_totals,billing_storage_reservations FROM salesmarketing_business_runtime;

    CREATE FUNCTION billing_capacity_authorize(p_org integer) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM billing_organizations WHERE id=p_org) THEN
        RAISE EXCEPTION 'Billing organization not found' USING ERRCODE='42501';
      END IF;
      IF app_business_system() OR pg_trigger_depth()>0 THEN RETURN; END IF;
      IF EXISTS(SELECT 1 FROM company_settings WHERE id=app_business_profile_id()
        AND user_id=app_business_user_id() AND billing_organization_id=p_org) THEN RETURN; END IF;
      IF EXISTS(SELECT 1 FROM billing_organization_memberships WHERE organization_id=p_org
        AND user_id=app_billing_actor_user_id() AND status='active') THEN RETURN; END IF;
      RAISE EXCEPTION 'Billing organization access denied' USING ERRCODE='42501';
    END $$;

    CREATE FUNCTION billing_capacity_plan(p_org integer) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE chosen record; legacy_storage bigint;
    BEGIN
      PERFORM billing_capacity_authorize(p_org);
      -- A replacement mandate is not an entitlement until a verified charge has
      -- begun. Keep the last purchased limits after lapse; access gating handles
      -- subscription expiry independently and cannot turn caps into unlimited.
      SELECT s.version,s.slug,p.limits INTO chosen
      FROM subscription_charges c JOIN billing_subscriptions s ON s.id=c.subscription_id
      JOIN subscription_plans p ON p.version=s.version AND p.slug=s.slug
      LEFT JOIN subscription_accounts a ON a.organization_id=p_org
      WHERE c.organization_id=p_org AND c.period_start<=now()
      ORDER BY c.period_start DESC,(a.current_subscription_id=s.id) DESC,c.paid_at DESC LIMIT 1;
      IF chosen.version>=2 THEN
        RETURN jsonb_build_object('catalogVersion',chosen.version,'planSlug',chosen.slug,'limits',chosen.limits);
      END IF;
      SELECT COALESCE(q.max_storage_bytes,sp.max_storage_bytes,
        (SELECT max_storage_bytes FROM storage_plans WHERE is_default=true ORDER BY id LIMIT 1),1073741824)
      INTO legacy_storage FROM billing_organizations o LEFT JOIN storage_quotas q ON q.user_id=o.owner_user_id
      LEFT JOIN storage_plans sp ON sp.id=q.plan_id WHERE o.id=p_org;
      RETURN jsonb_build_object('catalogVersion',chosen.version,'planSlug',chosen.slug,
        'limits',jsonb_build_object('storageBytes',legacy_storage));
    END $$;

    CREATE FUNCTION billing_assert_capacity(p_org integer,p_resource text,p_delta bigint) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE used bigint; cap bigint; plan jsonb; enforce boolean; baselines jsonb; baseline_key text; initial_usage bigint;
    BEGIN
      PERFORM billing_capacity_authorize(p_org);
      IF p_resource NOT IN ('businessProfiles','workspaces','contacts','storageBytes','channelAccounts',
        'aiAssistants','members','supportAgents','supportTeams','automations','knowledgeSources') THEN
        RAISE EXCEPTION 'Unknown capacity resource' USING ERRCODE='22023';
      END IF;
      PERFORM 1 FROM billing_organizations WHERE id=p_org FOR UPDATE;
      SELECT COALESCE((SELECT usage FROM billing_capacity_totals WHERE organization_id=p_org AND resource_key=p_resource),0) INTO used;
      baselines:=COALESCE(NULLIF(current_setting('app.billing_capacity_baselines',true),''),'{}')::jsonb;
      baseline_key:=p_org::text||':'||p_resource;
      IF NOT baselines ? baseline_key THEN
        baselines:=baselines||jsonb_build_object(baseline_key,used);
        PERFORM set_config('app.billing_capacity_baselines',baselines::text,true);
      END IF;
      initial_usage:=(baselines->>baseline_key)::bigint;
      IF p_delta<=0 THEN RETURN; END IF;
      plan:=billing_capacity_plan(p_org);
      cap:=(plan->'limits'->>p_resource)::bigint;
      SELECT capacity_enforced INTO enforce FROM subscription_settings WHERE id=1;
      -- Legacy storage limits remain enforced during the reporting rollout.
      IF NOT COALESCE(enforce,false) AND NOT(p_resource='storageBytes' AND COALESCE((plan->>'catalogVersion')::integer,1)<2) THEN RETURN; END IF;
      IF cap IS NULL THEN RETURN; END IF;
      -- A downgraded organization can replace a resource within the same
      -- transaction (for example switching the enabled assistant). It can never
      -- increase above either its allowance or the transaction's starting use.
      IF used+p_delta>GREATEST(cap,initial_usage) THEN
        RAISE EXCEPTION 'Organization plan limit exceeded' USING ERRCODE='P0001',
          DETAIL=jsonb_build_object('code','PLAN_LIMIT_EXCEEDED','resource',p_resource,'current',used,
            'requestedIncrease',p_delta,'limit',cap,'organizationId',p_org)::text;
      END IF;
    END $$;

    -- Stable identities let legacy/v2 knowledge and duplicate OAuth credential
    -- records describe one logical resource without charging for it twice.
    CREATE FUNCTION billing_capacity_units(p_source text,r jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE result jsonb:='[]'; key text; ident text; platform text; identifier text; active boolean;
    BEGIN
      IF r IS NULL OR r->>'id' IS NULL THEN RETURN result; END IF;
      ident:=p_source||':'||(r->>'id');
      CASE p_source
        WHEN 'company_settings' THEN key:='businessProfiles';
        WHEN 'ai_visibility_workspaces' THEN IF r->>'status'='active' THEN key:='workspaces'; END IF;
        WHEN 'billing_organization_memberships' THEN
          IF r->>'status' IN ('active','invited') THEN
            key:='members'; ident:='member:'||lower(trim(r->>'email'));
          END IF;
        WHEN 'crm_contacts' THEN IF r->>'deleted_at' IS NULL THEN key:='contacts'; END IF;
        WHEN 'storage_files' THEN
          IF NOT COALESCE((r->>'is_deleted')::boolean,false) THEN
            RETURN jsonb_build_array(jsonb_build_object('key','storageBytes','identity',ident,'amount',GREATEST(COALESCE((r->>'file_size_bytes')::bigint,0),0)));
          END IF;
        WHEN 'ai_agent_configs' THEN IF (r->>'enabled')::boolean THEN key:='aiAssistants'; END IF;
        WHEN 'team_members' THEN IF (r->>'is_active')::boolean THEN key:='supportAgents'; END IF;
        WHEN 'support_teams' THEN IF (r->>'is_active')::boolean THEN key:='supportTeams'; END IF;
        WHEN 'crm_pipeline_automations' THEN IF (r->>'is_active')::boolean THEN key:='automations'; END IF;
        WHEN 'workflows' THEN IF (r->>'is_active')::boolean THEN key:='automations'; END IF;
        WHEN 'knowledge_base' THEN key:='knowledgeSources'; ident:='knowledge:'||(r->>'id');
        WHEN 'knowledge_documents' THEN
          IF r->>'deleted_at' IS NULL THEN
            key:='knowledgeSources'; ident:=CASE WHEN r->>'legacy_entry_id' IS NOT NULL
              THEN 'knowledge:'||(r->>'legacy_entry_id') ELSE ident END;
          END IF;
        WHEN 'channel_credentials' THEN
          -- Tokens/API providers and parent Meta login credentials are not
          -- channels. Only concrete, supported external account identities count.
          platform:=CASE r->>'platform'
            WHEN 'facebook_api' THEN 'facebook' WHEN 'instagram_api' THEN 'instagram'
            WHEN 'gmail_api' THEN 'email' WHEN 'gmail' THEN 'email'
            WHEN 'email_smtp' THEN 'email' WHEN 'msg91_sms' THEN 'sms'
            WHEN 'twitter_api' THEN 'twitter' WHEN 'linkedin_api' THEN 'linkedin'
            ELSE r->>'platform' END;
          identifier:=NULLIF(trim(r->>'account_identifier'),'');
          IF platform='whatsapp' THEN identifier:=COALESCE(identifier,NULLIF(r->'session_data'->>'phoneNumberId',''),
            NULLIF(r->'session_data'->>'phone_number_id','')); END IF;
          active:=true;
          -- Expired/revoked tokens still reserve their connected account until
          -- explicitly removed; transient provider failures do not free seats.
          IF NOT COALESCE((r->>'is_active')::boolean,false) AND r->>'deactivation_reason' IN ('disconnected','user_disconnected','removed') THEN active:=false; END IF;
          IF active AND identifier IS NOT NULL AND platform IN ('facebook','instagram','email','whatsapp','youtube','twitter','linkedin','sms') THEN
            key:='channelAccounts'; ident:='channel:'||platform||':'||lower(identifier);
          END IF;
        WHEN 'meta_page_connections' THEN
          IF COALESCE((r->>'is_active')::boolean,false) THEN
            IF COALESCE((r->>'facebook_active')::boolean,false) AND NULLIF(r->>'page_id','') IS NOT NULL THEN
              result:=result||jsonb_build_array(jsonb_build_object('key','channelAccounts','identity','channel:facebook:'||lower(r->>'page_id'),'amount',1));
            END IF;
            IF COALESCE((r->>'instagram_active')::boolean,false) AND NULLIF(r->>'instagram_account_id','') IS NOT NULL THEN
              result:=result||jsonb_build_array(jsonb_build_object('key','channelAccounts','identity','channel:instagram:'||lower(r->>'instagram_account_id'),'amount',1));
            END IF;
          END IF;
        WHEN 'email_senders' THEN
          IF NULLIF(trim(r->>'email'),'') IS NOT NULL THEN key:='channelAccounts'; ident:='channel:email:'||lower(trim(r->>'email')); END IF;
        WHEN 'api_credentials' THEN
          -- The legacy WhatsApp settings path is still a usable phone channel.
          -- Other API credentials configure providers, not customer accounts.
          IF r->>'service_name'='whatsapp' AND COALESCE((r->>'is_active')::boolean,false)
            AND NULLIF(r->'config'->>'phoneNumberId','') IS NOT NULL THEN
            key:='channelAccounts'; ident:='channel:whatsapp:'||lower(r->'config'->>'phoneNumberId');
          END IF;
        ELSE RAISE EXCEPTION 'Unregistered capacity source: %',p_source USING ERRCODE='22023';
      END CASE;
      IF key IS NOT NULL THEN result:=result||jsonb_build_array(jsonb_build_object('key',key,'identity',ident,'amount',1)); END IF;
      RETURN result;
    END $$;

    CREATE FUNCTION billing_capacity_apply_deltas(p_before jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    DECLARE change record;
    BEGIN
      -- Not callable as an alternative mutation API. The invoking trigger has
      -- already passed tenant RLS and business ownership validation.
      IF pg_trigger_depth()=0 THEN RAISE EXCEPTION 'Capacity accounting is trigger-only' USING ERRCODE='42501'; END IF;
      FOR change IN
        SELECT b.org,b.resource,SUM(COALESCE((SELECT MAX(i.amount) FROM billing_capacity_items i
          WHERE i.organization_id=b.org AND i.resource_key=b.resource AND i.identity_key=b.identity),0)-b.amount)::bigint AS delta
        FROM jsonb_to_recordset(p_before) AS b(org integer,resource text,identity text,amount bigint)
        GROUP BY b.org,b.resource ORDER BY b.org,b.resource
      LOOP
        PERFORM billing_assert_capacity(change.org,change.resource,change.delta);
        INSERT INTO billing_capacity_totals(organization_id,resource_key,usage) VALUES(change.org,change.resource,GREATEST(change.delta,0))
        ON CONFLICT(organization_id,resource_key) DO UPDATE SET usage=billing_capacity_totals.usage+change.delta,updated_at=now();
      END LOOP;
    END $$;

    CREATE FUNCTION billing_sync_capacity(p_source text,p_id text,p_profile integer,p_workspace integer,p_org integer,p_units jsonb)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    DECLARE before_items jsonb;
    BEGIN
      IF pg_trigger_depth()=0 THEN RAISE EXCEPTION 'Capacity accounting is trigger-only' USING ERRCODE='42501'; END IF;
      PERFORM 1 FROM billing_organizations WHERE id IN
        (SELECT organization_id FROM billing_capacity_items WHERE source_table=p_source AND source_id=p_id UNION SELECT p_org)
        ORDER BY id FOR UPDATE;
      -- Association changes acquire these same organization locks. The profile
      -- may have moved while this write waited, so never commit a stale payer.
      IF p_profile IS NOT NULL AND p_org IS NOT NULL AND p_source<>'company_settings'
        AND (SELECT billing_organization_id FROM company_settings WHERE id=p_profile) IS DISTINCT FROM p_org THEN
        RAISE EXCEPTION 'Business billing changed; retry operation' USING ERRCODE='40001';
      END IF;
      WITH affected AS (
        SELECT organization_id AS org,resource_key AS resource,identity_key AS identity FROM billing_capacity_items WHERE source_table=p_source AND source_id=p_id
        UNION SELECT p_org,u->>'key',u->>'identity' FROM jsonb_array_elements(p_units) u WHERE p_org IS NOT NULL
      ) SELECT COALESCE(jsonb_agg(jsonb_build_object('org',a.org,'resource',a.resource,'identity',a.identity,'amount',
          COALESCE((SELECT MAX(i.amount) FROM billing_capacity_items i WHERE i.organization_id=a.org AND i.resource_key=a.resource AND i.identity_key=a.identity),0))),'[]')
        INTO before_items FROM affected a;
      DELETE FROM billing_capacity_items WHERE source_table=p_source AND source_id=p_id;
      IF p_org IS NOT NULL THEN
        INSERT INTO billing_capacity_items(source_table,source_id,resource_key,identity_key,organization_id,business_profile_id,workspace_id,amount)
        SELECT p_source,p_id,u->>'key',u->>'identity',p_org,p_profile,p_workspace,(u->>'amount')::bigint FROM jsonb_array_elements(p_units) u;
      END IF;
      PERFORM billing_capacity_apply_deltas(before_items);
    END $$;

    CREATE FUNCTION billing_transfer_profile_capacity(p_profile integer,p_org integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    DECLARE before_items jsonb;
    BEGIN
      IF pg_trigger_depth()=0 THEN RAISE EXCEPTION 'Capacity accounting is trigger-only' USING ERRCODE='42501'; END IF;
      PERFORM 1 FROM billing_organizations WHERE id IN
        (SELECT organization_id FROM billing_capacity_items WHERE business_profile_id=p_profile UNION SELECT p_org) ORDER BY id FOR UPDATE;
      WITH affected AS (
        SELECT organization_id AS org,resource_key AS resource,identity_key AS identity FROM billing_capacity_items
          WHERE business_profile_id=p_profile AND source_table<>'billing_storage_reservations'
        UNION SELECT p_org,resource_key,identity_key FROM billing_capacity_items WHERE business_profile_id=p_profile AND source_table<>'billing_storage_reservations'
      ) SELECT COALESCE(jsonb_agg(jsonb_build_object('org',a.org,'resource',a.resource,'identity',a.identity,'amount',
        COALESCE((SELECT MAX(i.amount) FROM billing_capacity_items i WHERE i.organization_id=a.org AND i.resource_key=a.resource AND i.identity_key=a.identity),0))),'[]')
        INTO before_items FROM affected a;
      UPDATE billing_capacity_items SET organization_id=p_org WHERE business_profile_id=p_profile AND source_table<>'billing_storage_reservations';
      PERFORM billing_capacity_apply_deltas(before_items);
    END $$;

    CREATE FUNCTION billing_capacity_resource_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE r jsonb; previous jsonb; org integer; profile integer; workspace integer; units jsonb;
    BEGIN
      IF TG_OP='DELETE' THEN r:=to_jsonb(OLD); units:='[]'; ELSE r:=to_jsonb(NEW); units:=billing_capacity_units(TG_TABLE_NAME,r); END IF;
      IF TG_TABLE_NAME='company_settings' THEN profile:=(r->>'id')::integer; org:=(r->>'billing_organization_id')::integer;
      ELSIF TG_TABLE_NAME='ai_visibility_workspaces' THEN workspace:=(r->>'id')::integer; org:=(r->>'billing_organization_id')::integer;
      ELSIF TG_TABLE_NAME='billing_organization_memberships' THEN org:=(r->>'organization_id')::integer;
      ELSE profile:=(r->>'business_profile_id')::integer;
        SELECT billing_organization_id INTO org FROM company_settings WHERE id=profile;
      END IF;
      IF TG_OP='UPDATE' THEN
        previous:=to_jsonb(OLD);
        IF TG_TABLE_NAME='company_settings' AND (previous->>'billing_organization_id')::integer IS DISTINCT FROM org THEN
          PERFORM billing_transfer_profile_capacity(profile,org); RETURN NEW;
        END IF;
        IF billing_capacity_units(TG_TABLE_NAME,previous)=units
          AND previous->>'billing_organization_id' IS NOT DISTINCT FROM r->>'billing_organization_id'
          AND previous->>'organization_id' IS NOT DISTINCT FROM r->>'organization_id' THEN RETURN NEW; END IF;
      END IF;
      PERFORM billing_sync_capacity(TG_TABLE_NAME,r->>'id',profile,workspace,org,units);
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;

    CREATE FUNCTION billing_retire_deleted_knowledge_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- Legacy deletion keeps evidence/audit history and clears its FK. This is
      -- a logical source deletion, not a new independent v2 source. Handle raw
      -- deletes too, before quota accounting observes the FK identity change.
      IF OLD.legacy_entry_id IS NOT NULL AND NEW.legacy_entry_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM knowledge_base WHERE id=OLD.legacy_entry_id) THEN
        NEW.deleted_at:=COALESCE(NEW.deleted_at,now());
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zzz_billing_knowledge_retirement BEFORE UPDATE OF legacy_entry_id ON knowledge_documents
      FOR EACH ROW EXECUTE FUNCTION billing_retire_deleted_knowledge_source();

    CREATE FUNCTION billing_usage_for_profiles(p_profiles integer[],p_workspaces integer[],p_target integer DEFAULT NULL)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; org integer;
    BEGIN
      IF p_target IS NOT NULL THEN PERFORM billing_capacity_authorize(p_target); END IF;
      FOR org IN SELECT DISTINCT organization_id FROM billing_capacity_items
        WHERE business_profile_id=ANY(p_profiles) OR workspace_id=ANY(p_workspaces)
      LOOP PERFORM billing_capacity_authorize(org); END LOOP;
      WITH moving AS (
        SELECT resource_key,identity_key,MAX(amount) AS amount FROM billing_capacity_items
        WHERE (business_profile_id=ANY(p_profiles) OR workspace_id=ANY(p_workspaces))
          AND source_table<>'billing_storage_reservations' AND (p_target IS NULL OR organization_id<>p_target)
        GROUP BY resource_key,identity_key
      ), increments AS (
        SELECT m.resource_key,GREATEST(m.amount-COALESCE((SELECT MAX(i.amount) FROM billing_capacity_items i
          WHERE i.organization_id=p_target AND i.resource_key=m.resource_key AND i.identity_key=m.identity_key),0),0) AS amount FROM moving m
      ), grouped AS (SELECT resource_key,SUM(amount) AS amount FROM increments GROUP BY resource_key)
      SELECT COALESCE(jsonb_object_agg(resource_key,amount),'{}') INTO result FROM grouped;
      RETURN result;
    END $$;

    CREATE FUNCTION billing_organization_entitlements(p_org integer) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE result jsonb; totals jsonb; enforce boolean;
    BEGIN
      PERFORM billing_capacity_authorize(p_org);
      result:=billing_capacity_plan(p_org);
      SELECT COALESCE(jsonb_object_agg(resource_key,usage),'{}') INTO totals FROM billing_capacity_totals WHERE organization_id=p_org;
      SELECT capacity_enforced INTO enforce FROM subscription_settings WHERE id=1;
      RETURN result||jsonb_build_object('usage',totals,'enforced',COALESCE(enforce,false));
    END $$;
  `);

  // The registry is seeded before enabling triggers, under the migration's
  // exclusive resource locks. Quarantined legacy rows without a business remain
  // quarantined and cannot leak into another organization's usage.
  const actualQueries = [];
  for (const source of sources) {
    const exists = await db.query('SELECT to_regclass($1) AS name', [`public.${source}`]);
    if (!exists.rows[0]?.name) continue;
    await db.query(`LOCK TABLE ${source} IN SHARE ROW EXCLUSIVE MODE`);
    const profile = source === 'company_settings' ? 'r.id' : ['ai_visibility_workspaces', 'billing_organization_memberships'].includes(source) ? 'NULL::integer' : 'r.business_profile_id';
    const workspace = source === 'ai_visibility_workspaces' ? 'r.id' : 'NULL::integer';
    const org = ['company_settings', 'ai_visibility_workspaces'].includes(source) ? 'r.billing_organization_id' : source === 'billing_organization_memberships' ? 'r.organization_id' : 'p.billing_organization_id';
    const join = !['company_settings', 'ai_visibility_workspaces', 'billing_organization_memberships'].includes(source) ? 'JOIN company_settings p ON p.id=r.business_profile_id' : '';
    actualQueries.push(`SELECT '${source}'::text AS source_table,r.id::text AS source_id,u->>'key' AS resource_key,
      u->>'identity' AS identity_key,(u->>'amount')::bigint AS amount FROM ${source} r ${join}
      CROSS JOIN LATERAL jsonb_array_elements(billing_capacity_units('${source}',to_jsonb(r))) u WHERE ${org}=p_org`);
    await db.query(`INSERT INTO billing_capacity_items(source_table,source_id,resource_key,identity_key,organization_id,business_profile_id,workspace_id,amount)
      SELECT '${source}',r.id::text,u->>'key',u->>'identity',${org},${profile},${workspace},(u->>'amount')::bigint
      FROM ${source} r ${join} CROSS JOIN LATERAL jsonb_array_elements(billing_capacity_units('${source}',to_jsonb(r))) u
      WHERE ${org} IS NOT NULL`);
    await db.query(`CREATE TRIGGER zz_billing_capacity AFTER INSERT OR UPDATE OR DELETE ON ${source}
      FOR EACH ROW EXECUTE FUNCTION billing_capacity_resource_trigger()`);
  }
  await db.query(`INSERT INTO billing_capacity_totals(organization_id,resource_key,usage)
    SELECT organization_id,resource_key,SUM(amount) FROM (
      SELECT organization_id,resource_key,identity_key,MAX(amount) AS amount FROM billing_capacity_items
      GROUP BY organization_id,resource_key,identity_key
    ) identities GROUP BY organization_id,resource_key`);

  await db.query(`
    -- Reservations hold capacity while an object is written outside PostgreSQL.
    -- Metadata commit releases the reservation in the same transaction as the
    -- storage_files write, preserving the budget on success, failure and retry.
    CREATE FUNCTION billing_reserve_storage(p_profile integer,p_user integer,p_bytes bigint) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    DECLARE org integer; reservation uuid:=gen_random_uuid(); expired bigint;
    BEGIN
      IF p_bytes<0 OR p_profile IS NULL OR p_user IS NULL THEN RAISE EXCEPTION 'Invalid storage reservation' USING ERRCODE='22023'; END IF;
      IF NOT app_business_system() AND (p_profile IS DISTINCT FROM app_business_profile_id() OR p_user IS DISTINCT FROM app_business_user_id()) THEN
        RAISE EXCEPTION 'Storage business access denied' USING ERRCODE='42501';
      END IF;
      SELECT billing_organization_id INTO org FROM company_settings WHERE id=p_profile AND user_id=p_user;
      IF org IS NULL THEN RAISE EXCEPTION 'Storage business not found' USING ERRCODE='42501'; END IF;
      PERFORM 1 FROM billing_organizations WHERE id=org FOR UPDATE;
      IF (SELECT billing_organization_id FROM company_settings WHERE id=p_profile)<>org THEN
        RAISE EXCEPTION 'Business billing changed; retry upload' USING ERRCODE='40001';
      END IF;
      SELECT COALESCE(SUM(bytes),0) INTO expired FROM billing_storage_reservations WHERE organization_id=org AND expires_at<now();
      DELETE FROM billing_capacity_items WHERE source_table='billing_storage_reservations' AND source_id IN
        (SELECT id::text FROM billing_storage_reservations WHERE organization_id=org AND expires_at<now());
      DELETE FROM billing_storage_reservations WHERE organization_id=org AND expires_at<now();
      UPDATE billing_capacity_totals SET usage=usage-expired,updated_at=now() WHERE organization_id=org AND resource_key='storageBytes';
      PERFORM billing_assert_capacity(org,'storageBytes',p_bytes);
      INSERT INTO billing_storage_reservations(id,organization_id,business_profile_id,user_id,bytes) VALUES(reservation,org,p_profile,p_user,p_bytes);
      INSERT INTO billing_capacity_items(source_table,source_id,resource_key,identity_key,organization_id,business_profile_id,amount)
        VALUES('billing_storage_reservations',reservation::text,'storageBytes','reservation:'||reservation,org,p_profile,p_bytes);
      INSERT INTO billing_capacity_totals(organization_id,resource_key,usage) VALUES(org,'storageBytes',p_bytes)
        ON CONFLICT(organization_id,resource_key) DO UPDATE SET usage=billing_capacity_totals.usage+p_bytes,updated_at=now();
      RETURN reservation;
    END $$;

    CREATE FUNCTION billing_release_storage(p_id uuid,p_profile integer,p_user integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    DECLARE reservation record;
    BEGIN
      IF NOT app_business_system() AND (p_profile IS DISTINCT FROM app_business_profile_id() OR p_user IS DISTINCT FROM app_business_user_id()) THEN
        RAISE EXCEPTION 'Storage business access denied' USING ERRCODE='42501';
      END IF;
      SELECT * INTO reservation FROM billing_storage_reservations WHERE id=p_id AND user_id=p_user AND business_profile_id=p_profile;
      IF reservation.id IS NULL THEN RETURN; END IF;
      -- A profile may have moved since upload began. Lock both payer scopes in
      -- stable order because this release can precede the destination file write.
      PERFORM 1 FROM billing_organizations WHERE id IN (reservation.organization_id,
        (SELECT billing_organization_id FROM company_settings WHERE id=p_profile)) ORDER BY id FOR UPDATE;
      DELETE FROM billing_storage_reservations WHERE id=p_id RETURNING * INTO reservation;
      IF reservation.id IS NULL THEN RETURN; END IF;
      DELETE FROM billing_capacity_items WHERE source_table='billing_storage_reservations' AND source_id=p_id::text;
      UPDATE billing_capacity_totals SET usage=usage-reservation.bytes,updated_at=now()
        WHERE organization_id=reservation.organization_id AND resource_key='storageBytes';
    END $$;

    CREATE FUNCTION billing_capacity_reconciliation(p_org integer) RETURNS jsonb LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    DECLARE result jsonb; old_system text;
    BEGIN
      PERFORM billing_capacity_authorize(p_org);
      -- This is the only inventory across tenant rows. Authorization precedes
      -- the temporary scope; every branch filters the selected organization and
      -- only mismatch totals leave this function. Restore scope on every path.
      old_system:=COALESCE(current_setting('app.business_system',true),'off');
      PERFORM set_config('app.business_system','on',true);
      WITH actual_units AS (
        ${actualQueries.join('\nUNION ALL\n')}
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
    END $$;

    REVOKE ALL ON FUNCTION billing_capacity_apply_deltas(jsonb),billing_sync_capacity(text,text,integer,integer,integer,jsonb),
      billing_transfer_profile_capacity(integer,integer),billing_reserve_storage(integer,integer,bigint),billing_release_storage(uuid,integer,integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION billing_capacity_apply_deltas(jsonb),billing_sync_capacity(text,text,integer,integer,integer,jsonb),
      billing_transfer_profile_capacity(integer,integer),billing_reserve_storage(integer,integer,bigint),billing_release_storage(uuid,integer,integer) TO salesmarketing_business_runtime;
  `);
}

export async function down() {
  throw new Error('Capacity accounting cannot be removed safely. Use a reviewed forward migration.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
