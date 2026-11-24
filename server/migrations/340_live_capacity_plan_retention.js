/** Test provider charges never change real capacity. Retain the last adopted
 * allowance after refund/expiry, matching the documented downgrade policy. */
export async function up(db) {
  await db.query(`
    CREATE OR REPLACE FUNCTION billing_capacity_plan(p_org integer) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE chosen record; legacy_storage bigint;
    BEGIN
      PERFORM billing_capacity_authorize(p_org);
      -- An active administrator grant controls capacity even if a late provider
      -- charge arrives for the same period. After expiry, keep the latest limits
      -- until a newer paid or administrator term begins.
      SELECT t.version,t.slug,p.limits INTO chosen
      FROM billing_admin_plan_terms t JOIN subscription_plans p ON p.version=t.version AND p.slug=t.slug
      WHERE t.organization_id=p_org AND t.starts_at<=now() AND t.ends_at>now() AND t.cancelled_at IS NULL
      ORDER BY t.starts_at DESC LIMIT 1;
      IF NOT FOUND THEN
        SELECT ranked.version,ranked.slug,ranked.limits INTO chosen FROM (
          SELECT s.version,s.slug,p.limits,c.period_start AS effective_at,0 AS priority
          FROM subscription_charges c JOIN billing_subscriptions s ON s.id=c.subscription_id
          JOIN subscription_plans p ON p.version=s.version AND p.slug=s.slug
          WHERE c.organization_id=p_org AND c.period_start<=now() AND s.mode='live'
          UNION ALL
          SELECT t.version,t.slug,p.limits,t.starts_at AS effective_at,1 AS priority
          FROM billing_admin_plan_terms t JOIN subscription_plans p ON p.version=t.version AND p.slug=t.slug
          WHERE t.organization_id=p_org AND t.starts_at<=now() AND t.cancelled_at IS NULL
        ) ranked ORDER BY ranked.effective_at DESC,ranked.priority DESC LIMIT 1;
      END IF;
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
  `);
}
export const irreversible = true;
export async function down() {
  throw new Error('Capacity policy rollback requires a reviewed forward migration.');
}
