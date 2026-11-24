/** Credential identities already used for provider plans are immutable. The
 * settings row serializes enforcement transitions with generic credential CRUD. */
export async function up(db) {
  await db.query(`
    CREATE FUNCTION subscription_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
        OR EXISTS(SELECT 1 FROM billing_subscriptions WHERE credential_id=OLD.id) INTO referenced;
      IF referenced THEN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'Retain credentials referenced by subscription history' USING ERRCODE='P0001',DETAIL='{"code":"BILLING_CREDENTIAL_HISTORY"}';
        ELSIF NEW.api_key IS DISTINCT FROM OLD.api_key OR NEW.platform IS DISTINCT FROM OLD.platform
          OR NEW.is_encrypted IS DISTINCT FROM OLD.is_encrypted THEN
          RAISE EXCEPTION 'Create a new credential identity and provision its provider plans' USING ERRCODE='P0001',DETAIL='{"code":"BILLING_CREDENTIAL_IDENTITY"}';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$;
    CREATE TRIGGER subscription_credential_integrity BEFORE UPDATE OR DELETE ON admin_api_credentials
      FOR EACH ROW EXECUTE FUNCTION subscription_credential_guard();
    CREATE FUNCTION subscription_settings_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.enforced AND NEW.enforced AND NEW.credential_id IS DISTINCT FROM OLD.credential_id THEN
        RAISE EXCEPTION 'Disable subscription enforcement before selecting another credential' USING ERRCODE='P0001',DETAIL='{"code":"BILLING_CREDENTIAL_ENFORCED"}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER subscription_settings_credential_integrity BEFORE UPDATE ON subscription_settings
      FOR EACH ROW EXECUTE FUNCTION subscription_settings_credential_guard();
  `);
}
export async function down(db) {
  await db.query(`DROP TRIGGER subscription_settings_credential_integrity ON subscription_settings;
    DROP FUNCTION subscription_settings_credential_guard();
    DROP TRIGGER subscription_credential_integrity ON admin_api_credentials;
    DROP FUNCTION subscription_credential_guard();`);
}
