/**
 * Separate Facebook and Instagram lifecycle state and rotate legacy plaintext
 * tokens in both Meta storage locations. The marker matches SecretsManager's
 * envelope format and remains readable by rolling deployments.
 */
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';
const CIPHERTEXT = /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i;
function key() { return crypto.createHash('sha256').update(process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET || '').digest(); }
function encrypt(value) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
}
function protect(value) { return !value || value.startsWith(PREFIX) || CIPHERTEXT.test(value) ? value : encrypt(value); }

export async function up(client) {
  await client.query(`ALTER TABLE meta_page_connections ADD COLUMN IF NOT EXISTS facebook_active BOOLEAN NOT NULL DEFAULT TRUE`);
  await client.query(`ALTER TABLE meta_page_connections ADD COLUMN IF NOT EXISTS instagram_active BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`UPDATE meta_page_connections SET instagram_active = TRUE WHERE instagram_account_id IS NOT NULL`);
  const { rows: pages } = await client.query(`SELECT id, page_access_token, user_access_token FROM meta_page_connections`);
  for (const row of pages) await client.query(
    `UPDATE meta_page_connections SET page_access_token = $1, user_access_token = $2, updated_at = NOW() WHERE id = $3`,
    [protect(row.page_access_token), protect(row.user_access_token), row.id],
  );
  const { rows: creds } = await client.query(`SELECT id, access_token, refresh_token, api_key, api_secret, session_data FROM channel_credentials WHERE platform IN ('facebook_api', 'instagram_api')`);
  for (const row of creds) {
    const session = row.session_data && typeof row.session_data === 'object' ? { ...row.session_data } : {};
    // Legacy nested secrets are removed after their column equivalents are rotated.
    delete session.pageAccessToken;
    delete session.accessToken;
    delete session.appSecret;
    await client.query(
      `UPDATE channel_credentials SET access_token=$1, refresh_token=$2, api_key=$3, api_secret=$4, session_data=$5::jsonb, encryption_version='secrets-manager-v1', encrypted_at=NOW(), updated_at=NOW() WHERE id=$6`,
      [protect(row.access_token), protect(row.refresh_token), protect(row.api_key), protect(row.api_secret), JSON.stringify(session), row.id],
    );
  }
}

// Secret rotation is intentionally irreversible; restoring plaintext is unsafe.
export async function down() {}
