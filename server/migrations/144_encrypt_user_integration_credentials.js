import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';
const ENCRYPTED_VALUE = /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i;
const SENSITIVE_KEY = /(?:api[_-]?key|secret|password|private[_-]?key|credentials|token|service[_-]?account)$/i;

function encryptionKey() {
  const source = process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  return crypto.createHash('sha256').update(source).digest();
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext) {
  const [ivHex, tagHex, encryptedHex] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptConfig(value, key = '') {
  if (SENSITIVE_KEY.test(key) && value !== null && value !== undefined && value !== '') {
    if (typeof value === 'string' && (value.startsWith(PREFIX) || ENCRYPTED_VALUE.test(value))) return value;
    return `${PREFIX}${encrypt(JSON.stringify(value))}`;
  }
  if (Array.isArray(value)) return value.map((entry) => encryptConfig(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, encryptConfig(child, childKey)]));
  }
  return value;
}

function decryptConfig(value) {
  if (typeof value === 'string' && value.startsWith(PREFIX)) {
    return JSON.parse(decrypt(value.slice(PREFIX.length)));
  }
  if (Array.isArray(value)) return value.map(decryptConfig);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decryptConfig(child)]));
  }
  return value;
}

export async function up(client) {
  const { rows } = await client.query(`
    SELECT id, api_secret, config
    FROM api_credentials
    WHERE api_secret IS NOT NULL OR config IS NOT NULL
    ORDER BY id
  `);

  for (const row of rows) {
    const apiSecret = typeof row.api_secret === 'string' && row.api_secret
      && !row.api_secret.startsWith(PREFIX) && !ENCRYPTED_VALUE.test(row.api_secret)
      ? `${PREFIX}${encrypt(row.api_secret)}`
      : row.api_secret;
    const config = encryptConfig(row.config || {});
    await client.query(
      `UPDATE api_credentials SET api_secret = $1, config = $2::jsonb, updated_at = NOW() WHERE id = $3`,
      [apiSecret, JSON.stringify(config), row.id],
    );
  }
}

export async function down(client) {
  const { rows } = await client.query(`
    SELECT id, api_secret, config
    FROM api_credentials
    WHERE api_secret LIKE 'enc:v1:%' OR config::text LIKE '%enc:v1:%'
    ORDER BY id
  `);

  for (const row of rows) {
    const apiSecret = typeof row.api_secret === 'string' && row.api_secret.startsWith(PREFIX)
      ? decrypt(row.api_secret.slice(PREFIX.length))
      : row.api_secret;
    await client.query(
      `UPDATE api_credentials SET api_secret = $1, config = $2::jsonb, updated_at = NOW() WHERE id = $3`,
      [apiSecret, JSON.stringify(decryptConfig(row.config || {})), row.id],
    );
  }
}
