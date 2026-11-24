/** Complimentary administrator assignments stay separate from provider charges. */
export async function up(db) {
  await db.query(`
    CREATE TABLE billing_admin_plan_terms (
      id uuid PRIMARY KEY,
      organization_id integer NOT NULL REFERENCES billing_organizations(id) ON DELETE RESTRICT,
      admin_id integer NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
      version integer NOT NULL,
      slug text NOT NULL,
      term text NOT NULL CHECK(term IN ('monthly','yearly')),
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      cancelled_at timestamptz,
      reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(version,slug) REFERENCES subscription_plans(version,slug),
      CHECK(ends_at > starts_at)
    );
    CREATE INDEX billing_admin_plan_terms_organization
      ON billing_admin_plan_terms(organization_id,starts_at DESC);
    CREATE UNIQUE INDEX billing_admin_plan_terms_open_start
      ON billing_admin_plan_terms(organization_id,starts_at) WHERE cancelled_at IS NULL;
    CREATE TABLE billing_admin_plan_credit_grants (
      term_id uuid NOT NULL REFERENCES billing_admin_plan_terms(id) ON DELETE RESTRICT,
      month_index integer NOT NULL CHECK(month_index BETWEEN 0 AND 11),
      due_at timestamptz NOT NULL,
      credits integer NOT NULL CHECK(credits > 0),
      granted_at timestamptz,
      cancelled_at timestamptz,
      wallet_transaction_id integer UNIQUE REFERENCES wallet_transactions(id),
      PRIMARY KEY(term_id,month_index),
      CHECK(NOT (granted_at IS NOT NULL AND cancelled_at IS NOT NULL))
    );
    CREATE INDEX billing_admin_plan_credit_grants_due ON billing_admin_plan_credit_grants(due_at)
      WHERE granted_at IS NULL AND cancelled_at IS NULL;
    INSERT INTO business_scope_accounts(table_name) VALUES
      ('billing_admin_plan_terms'),('billing_admin_plan_credit_grants');
    GRANT SELECT,INSERT,UPDATE,DELETE ON billing_admin_plan_terms,billing_admin_plan_credit_grants
      TO salesmarketing_business_runtime;

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
          WHERE c.organization_id=p_org AND c.period_start<=now() AND c.refund_amount_paise=0
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
export async function down() {
  throw new Error('Administrator plan terms contain billing history; restore a reviewed backup instead of dropping them.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
