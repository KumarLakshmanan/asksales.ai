/** Count modern assistant publication and Instagram rule activation through
 * the same atomic organization budget as legacy assistants and workflows. */
const sources = [
  "outreach_assistants",
  "instagram_automation_rules",
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
    LOCK TABLE outreach_assistants,instagram_automation_rules IN SHARE ROW EXCLUSIVE MODE;
    LOCK TABLE billing_capacity_items,billing_capacity_totals IN SHARE ROW EXCLUSIVE MODE;
    ALTER FUNCTION billing_capacity_units(text,jsonb) RENAME TO billing_capacity_units_before_modern;
    CREATE FUNCTION billing_capacity_units(p_source text,r jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF p_source='outreach_assistants' THEN
        IF r->>'state'='live' THEN
          RETURN jsonb_build_array(jsonb_build_object('key','aiAssistants','amount',1,'identity',
            CASE WHEN r->>'legacy_config_id' IS NOT NULL THEN 'ai_agent_configs:'||(r->>'legacy_config_id')
            ELSE p_source||':'||(r->>'id') END));
        END IF;
        RETURN '[]'::jsonb;
      END IF;
      IF p_source='instagram_automation_rules' THEN
        IF r->>'status'='active' AND r->>'deleted_at' IS NULL THEN
          RETURN jsonb_build_array(jsonb_build_object('key','automations','amount',1,'identity',p_source||':'||(r->>'id')));
        END IF;
        RETURN '[]'::jsonb;
      END IF;
      RETURN billing_capacity_units_before_modern(p_source,r);
    END $$;
  `);
  for (const source of ['outreach_assistants','instagram_automation_rules']) {
    await db.query(`INSERT INTO billing_capacity_items(source_table,source_id,resource_key,identity_key,organization_id,business_profile_id,amount)
      SELECT '${source}',r.id::text,u->>'key',u->>'identity',p.billing_organization_id,p.id,(u->>'amount')::bigint
      FROM ${source} r JOIN company_settings p ON p.id=r.business_profile_id
      CROSS JOIN LATERAL jsonb_array_elements(billing_capacity_units('${source}',to_jsonb(r))) u;
      CREATE TRIGGER zz_billing_capacity AFTER INSERT OR UPDATE OR DELETE ON ${source}
        FOR EACH ROW EXECUTE FUNCTION billing_capacity_resource_trigger();`);
  }
  // Existing over-capacity resources are retained, never activated or deleted.
  await db.query(`DELETE FROM billing_capacity_totals;
    INSERT INTO billing_capacity_totals(organization_id,resource_key,usage)
      SELECT organization_id,resource_key,SUM(amount) FROM (
        SELECT organization_id,resource_key,identity_key,MAX(amount) amount FROM billing_capacity_items
        GROUP BY organization_id,resource_key,identity_key
      ) identities GROUP BY organization_id,resource_key;`);
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

export const irreversible = true;
export async function down() {
  throw new Error('Modern resource capacity history requires a reviewed forward migration.');
}
