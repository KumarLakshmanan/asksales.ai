/**
 * Enforce the append-only contract for administrator audit histories at the
 * database boundary. Application roles may insert records, but no caller can
 * rewrite or delete historical events accidentally.
 */
export async function up(client) {
  await client.query(`
    CREATE OR REPLACE FUNCTION prevent_admin_audit_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS pricing_change_audit_append_only ON pricing_change_audit;
    CREATE TRIGGER pricing_change_audit_append_only
      BEFORE UPDATE OR DELETE ON pricing_change_audit
      FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_mutation();

    DROP TRIGGER IF EXISTS platform_access_audit_append_only ON platform_access_audit;
    CREATE TRIGGER platform_access_audit_append_only
      BEFORE UPDATE OR DELETE ON platform_access_audit
      FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_mutation();

    DROP TRIGGER IF EXISTS admin_credential_audit_append_only ON admin_credential_audit;
    CREATE TRIGGER admin_credential_audit_append_only
      BEFORE UPDATE OR DELETE ON admin_credential_audit
      FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_mutation();
  `);
}

export async function down(client) {
  await client.query(`
    DROP TRIGGER IF EXISTS pricing_change_audit_append_only ON pricing_change_audit;
    DROP TRIGGER IF EXISTS platform_access_audit_append_only ON platform_access_audit;
    DROP TRIGGER IF EXISTS admin_credential_audit_append_only ON admin_credential_audit;
    DROP FUNCTION IF EXISTS prevent_admin_audit_mutation();
  `);
}
