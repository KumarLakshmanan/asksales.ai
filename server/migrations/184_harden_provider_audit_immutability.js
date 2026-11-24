/**
 * Provider readiness and canary evidence is an append-only release audit log.
 * Enforce that contract at the database boundary so an application bug or an
 * overly broad SQL role cannot rewrite historical go/no-go evidence.
 */
export async function up(client) {
  await client.query(`
    CREATE OR REPLACE FUNCTION prevent_provider_audit_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'provider verification and canary audit records are immutable';
    END;
    $$;

    DROP TRIGGER IF EXISTS provider_verification_runs_immutable ON provider_verification_runs;
    CREATE TRIGGER provider_verification_runs_immutable
      BEFORE UPDATE OR DELETE ON provider_verification_runs
      FOR EACH ROW EXECUTE FUNCTION prevent_provider_audit_mutation();

    DROP TRIGGER IF EXISTS provider_canary_runs_immutable ON provider_canary_runs;
    CREATE TRIGGER provider_canary_runs_immutable
      BEFORE UPDATE OR DELETE ON provider_canary_runs
      FOR EACH ROW EXECUTE FUNCTION prevent_provider_audit_mutation();
  `);
}

export async function down(client) {
  await client.query(`
    DROP TRIGGER IF EXISTS provider_canary_runs_immutable ON provider_canary_runs;
    DROP TRIGGER IF EXISTS provider_verification_runs_immutable ON provider_verification_runs;
    DROP FUNCTION IF EXISTS prevent_provider_audit_mutation();
  `);
}
