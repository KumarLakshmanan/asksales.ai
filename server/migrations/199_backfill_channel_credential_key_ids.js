/**
 * Backfill non-secret encryption key identifiers for already-encrypted channel
 * credentials. Readiness requires this metadata so rotations can be audited.
 */
import crypto from 'node:crypto';

function keyId() {
  const configured = process.env.SECRETS_ENCRYPTION_KEY_ID?.trim();
  if (configured) return configured;
  const source = process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  if (!source) throw new Error('SECRETS_ENCRYPTION_KEY or JWT_SECRET is required to identify channel credential encryption');
  return `local-shared:${crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
}

export async function up(client) {
  await client.query(
    `UPDATE channel_credentials
        SET encryption_key_id = $1,
            updated_at = NOW()
      WHERE encryption_version IS NOT NULL
        AND encrypted_at IS NOT NULL
        AND encryption_key_id IS NULL`,
    [keyId()],
  );
}

// Metadata backfills are intentionally not removed; doing so would make an
// encrypted credential appear unauditable and break official-provider binding.
export async function down() {}
