/** Bind new wallet checkouts to the actor, payer, quote and credential used to
 * create them. Historical unbound orders are not inferred or backfilled. */
export async function up(db) {
  await db.query(`
    CREATE TABLE wallet_recharge_order_origins (
      order_id TEXT PRIMARY KEY CHECK(order_id ~ '^order_[a-zA-Z0-9_]+$'),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      organization_id INTEGER NOT NULL REFERENCES billing_organizations(id) ON DELETE RESTRICT,
      credential_source TEXT NOT NULL CHECK(credential_source IN('admin','system')),
      credential_id INTEGER REFERENCES admin_api_credentials(id) ON DELETE RESTRICT,
      key_id TEXT NOT NULL CHECK(key_id ~ '^rzp_live_.+'),
      amount_paise INTEGER NOT NULL CHECK(amount_paise BETWEEN 100 AND 10000000),
      currency TEXT NOT NULL CHECK(currency='INR'),
      credits NUMERIC(20,2) NOT NULL CHECK(credits>0 AND credits::text NOT IN('NaN','Infinity','-Infinity')),
      recharge_rate NUMERIC NOT NULL CHECK(recharge_rate>0 AND recharge_rate::text NOT IN('NaN','Infinity','-Infinity')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((credential_source='admin' AND credential_id IS NOT NULL)
        OR (credential_source='system' AND credential_id IS NULL))
    );
    CREATE INDEX wallet_recharge_origins_credential ON wallet_recharge_order_origins(credential_id)
      WHERE credential_id IS NOT NULL;
    INSERT INTO business_scope_accounts(table_name) VALUES('wallet_recharge_order_origins');
    ALTER TABLE wallet_recharge_order_origins ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wallet_recharge_order_origins FORCE ROW LEVEL SECURITY;
    CREATE POLICY recharge_origin_scope ON wallet_recharge_order_origins FOR ALL
      USING(app_business_system() OR (organization_id=app_billing_organization_id() AND user_id=app_billing_actor_user_id()))
      WITH CHECK(app_business_system() OR (organization_id=app_billing_organization_id() AND user_id=app_billing_actor_user_id()));
    REVOKE ALL ON wallet_recharge_order_origins FROM PUBLIC;
    GRANT SELECT,INSERT ON wallet_recharge_order_origins TO salesmarketing_business_runtime;
    CREATE FUNCTION wallet_recharge_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Recharge order origins are immutable' USING ERRCODE='P0001'; END $$;
    CREATE TRIGGER wallet_recharge_origin_immutable BEFORE UPDATE OR DELETE ON wallet_recharge_order_origins
      FOR EACH ROW EXECUTE FUNCTION wallet_recharge_origin_immutable();

    -- Extend applied342's identity/history guard without rewriting its history.
    CREATE OR REPLACE FUNCTION subscription_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE settings record; referenced boolean;
    BEGIN
      IF OLD.platform<>'razorpay' THEN
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END IF;
      SELECT enforced,credential_id INTO settings FROM subscription_settings WHERE id=1 FOR UPDATE;
      IF TG_OP='DELETE' THEN
        IF settings.enforced AND settings.credential_id=OLD.id THEN
          RAISE EXCEPTION 'Disable subscription enforcement before changing its credential' USING ERRCODE='P0001',DETAIL='{"code":"BILLING_CREDENTIAL_ENFORCED"}';
        END IF;
      ELSIF settings.enforced AND settings.credential_id=OLD.id AND
        (NEW.api_key IS DISTINCT FROM OLD.api_key OR NEW.api_secret IS DISTINCT FROM OLD.api_secret
          OR NEW.config IS DISTINCT FROM OLD.config OR NEW.is_active IS DISTINCT FROM OLD.is_active
          OR NEW.platform IS DISTINCT FROM OLD.platform OR NEW.is_encrypted IS DISTINCT FROM OLD.is_encrypted) THEN
        RAISE EXCEPTION 'Disable subscription enforcement before changing its credential' USING ERRCODE='P0001',DETAIL='{"code":"BILLING_CREDENTIAL_ENFORCED"}';
      END IF;
      SELECT EXISTS(SELECT 1 FROM subscription_provider_plans WHERE credential_id=OLD.id)
        OR EXISTS(SELECT 1 FROM billing_subscriptions WHERE credential_id=OLD.id)
        OR EXISTS(SELECT 1 FROM wallet_recharge_order_origins WHERE credential_id=OLD.id) INTO referenced;
      IF referenced THEN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'Retain credentials referenced by billing history' USING ERRCODE='P0001',DETAIL='{"code":"BILLING_CREDENTIAL_HISTORY"}';
        ELSIF NEW.api_key IS DISTINCT FROM OLD.api_key OR NEW.platform IS DISTINCT FROM OLD.platform
          OR NEW.is_encrypted IS DISTINCT FROM OLD.is_encrypted THEN
          RAISE EXCEPTION 'Create a new billing credential identity' USING ERRCODE='P0001',DETAIL='{"code":"BILLING_CREDENTIAL_IDENTITY"}';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$;
  `);
}

export const irreversible = true;
export async function down() {
  throw new Error('Recharge order origins retain payment recovery identities; use a reviewed forward migration.');
}
