/**
 * Adds an explicit encryption marker for admin-managed integration secrets.
 * Existing plaintext rows remain readable and are encrypted when rotated.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE admin_api_credentials
    ADD COLUMN IF NOT EXISTS is_encrypted BOOLEAN NOT NULL DEFAULT FALSE
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE admin_api_credentials
    DROP COLUMN IF EXISTS is_encrypted
  `);
}
