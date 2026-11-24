/**
 * Rotate legacy Gmail and WhatsApp channel credentials to encrypted storage.
 *
 * Columns use the shared SecretsManager ciphertext format. Secret-bearing
 * session/config properties use the `enc:v1:` envelope consumed by
 * integrationSecrets. Reads remain compatible throughout a rolling deploy.
 */
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';
const CIPHERTEXT = /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i;
const SENSITIVE_KEY = /(?:api[_-]?key|secret|password|private[_-]?key|credentials|token|service[_-]?account)$/i;

function encryptionKey() {
  const source = process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!source) throw new Error('SECRETS_ENCRYPTION_KEY or JWT_SECRET is required to rotate integration credentials');
  return crypto.createHash('sha256').update(source).digest();
}

function encryptBare(value) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
}

function protectColumn(value) {
  if (!value || CIPHERTEXT.test(value)) return value;
  if (value.startsWith(PREFIX) && CIPHERTEXT.test(value.slice(PREFIX.length))) {
    return value.slice(PREFIX.length);
  }
  return encryptBare(value);
}

function protectConfig(value, key = '') {
  if (SENSITIVE_KEY.test(key) && value !== null && value !== undefined && value !== '') {
    if (typeof value === 'string' && value.startsWith(PREFIX)) return value;
    return `${PREFIX}${encryptBare(JSON.stringify(value))}`;
  }
  if (Array.isArray(value)) return value.map((entry) => protectConfig(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, protectConfig(child, childKey)]));
  }
  return value;
}

export async function up(client) {
  const { rows: channels } = await client.query(`
    SELECT id, access_token, refresh_token, api_key, api_secret, session_data
    FROM channel_credentials
    WHERE platform IN ('gmail_api', 'gmail_config', 'whatsapp')
  `);

  for (const row of channels) {
    await client.query(
      `UPDATE channel_credentials
       SET access_token=$1, refresh_token=$2, api_key=$3, api_secret=$4,
           session_data=$5::jsonb, encryption_version='secrets-manager-v1',
           encrypted_at=NOW(), updated_at=NOW()
       WHERE id=$6`,
      [
        protectColumn(row.access_token),
        protectColumn(row.refresh_token),
        protectColumn(row.api_key),
        protectColumn(row.api_secret),
        JSON.stringify(protectConfig(row.session_data || {})),
        row.id,
      ],
    );
  }

  // Older manual WhatsApp rows placed the access token in api_key. Move it to
  // the encrypted config envelope used by current readers, then clear api_key.
  const { rows: legacyWhatsApp } = await client.query(`
    SELECT id, api_key, api_secret, config
    FROM api_credentials
    WHERE service_name = 'whatsapp'
  `);
  for (const row of legacyWhatsApp) {
    const config = row.config && typeof row.config === 'object' ? { ...row.config } : {};
    if (row.api_key && !config.accessToken) config.accessToken = row.api_key;
    await client.query(
      `UPDATE api_credentials
       SET api_key='', api_secret=$1, config=$2::jsonb, updated_at=NOW()
       WHERE id=$3`,
      [
        row.api_secret ? `${PREFIX}${protectColumn(row.api_secret)}` : row.api_secret,
        JSON.stringify(protectConfig(config)),
        row.id,
      ],
    );
  }
}

// Secret rotation is intentionally irreversible; restoring plaintext is unsafe.
export async function down() {}
