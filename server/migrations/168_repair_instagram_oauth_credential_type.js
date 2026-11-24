/**
 * Repair Instagram credentials that completed OAuth while retaining a legacy
 * `manual` credential_type. The callback proof and required provider metadata
 * make the repair predicate intentionally narrow.
 */

const REPAIR_TABLE = 'migration_168_instagram_oauth_credential_repair';

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${REPAIR_TABLE} (
      credential_id INTEGER PRIMARY KEY REFERENCES channel_credentials(id) ON DELETE CASCADE,
      previous_credential_type VARCHAR(50) NOT NULL,
      repaired_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    WITH candidates AS (
      SELECT id, credential_type
      FROM channel_credentials
      WHERE platform = 'instagram_api'
        AND credential_type <> 'oauth'
        AND is_active = TRUE
        AND NULLIF(access_token, '') IS NOT NULL
        AND NULLIF(account_identifier, '') IS NOT NULL
        AND NULLIF(session_data->>'pageId', '') IS NOT NULL
        AND session_data->>'connectedViaOAuth' = 'true'
    ), recorded AS (
      INSERT INTO ${REPAIR_TABLE} (credential_id, previous_credential_type)
      SELECT id, credential_type
      FROM candidates
      ON CONFLICT (credential_id) DO NOTHING
      RETURNING credential_id
    )
    UPDATE channel_credentials AS credential
    SET credential_type = 'oauth', updated_at = NOW()
    FROM recorded
    WHERE credential.id = recorded.credential_id
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE channel_credentials AS credential
    SET credential_type = repair.previous_credential_type, updated_at = NOW()
    FROM ${REPAIR_TABLE} AS repair
    WHERE credential.id = repair.credential_id
      AND credential.credential_type = 'oauth'
  `);

  await client.query(`DROP TABLE IF EXISTS ${REPAIR_TABLE}`);
}
