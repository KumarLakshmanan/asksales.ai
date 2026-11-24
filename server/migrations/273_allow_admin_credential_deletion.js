/**
 * Credential audit rows are append-only. The original ON DELETE SET NULL
 * foreign key attempted to update those rows whenever an API credential was
 * deleted, which the append-only trigger correctly rejected.
 *
 * Preserve credential_id as immutable historical context without keeping a
 * live foreign-key dependency on a credential that administrators may delete.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE admin_credential_audit
      DROP CONSTRAINT IF EXISTS admin_credential_audit_credential_id_fkey;
  `);
}

export async function down(client) {
  await client.query(`
    DROP TRIGGER IF EXISTS admin_credential_audit_append_only ON admin_credential_audit;

    UPDATE admin_credential_audit AS audit
    SET credential_id = NULL
    WHERE credential_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM admin_api_credentials AS credential
        WHERE credential.id = audit.credential_id
      );

    ALTER TABLE admin_credential_audit
      ADD CONSTRAINT admin_credential_audit_credential_id_fkey
      FOREIGN KEY (credential_id)
      REFERENCES admin_api_credentials(id)
      ON DELETE SET NULL;

    CREATE TRIGGER admin_credential_audit_append_only
      BEFORE UPDATE OR DELETE ON admin_credential_audit
      FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_mutation();
  `);
}
