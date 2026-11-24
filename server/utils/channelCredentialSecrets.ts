/**
 * Secret handling for channel_credentials rows.
 *
 * Older rows were stored in plaintext even though the table schema describes
 * the columns as encrypted.  These helpers deliberately accept both formats:
 * callers can read legacy data during a rolling migration, while every write
 * made through the hardened integrations is encrypted.
 */
import { decryptValue, encryptValue } from '../services/SecretsManager.js';
import crypto from 'node:crypto';
import {
  decryptSensitiveIntegrationConfig,
  encryptSensitiveIntegrationConfig,
} from './integrationSecrets.js';

const ENCRYPTED_VALUE = /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i;
const ENCRYPTED_PREFIX = 'enc:v1:';

/**
 * Return a non-secret identifier for the key that protects channel credentials.
 *
 * Operators may supply an explicit identifier when a managed KMS key is used.
 * Self-hosted deployments fall back to a short fingerprint so key rotations are
 * visible in readiness metadata without exposing the encryption key itself.
 */
export function getChannelCredentialEncryptionKeyId(): string {
  const configuredId = process.env.SECRETS_ENCRYPTION_KEY_ID?.trim();
  if (configuredId) return configuredId;

  const source = process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  if (!source) {
    throw new Error('SECRETS_ENCRYPTION_KEY or JWT_SECRET is required for channel credential encryption');
  }
  const fingerprint = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `local-shared:${fingerprint}`;
}

export function encryptChannelCredentialSecret(value: string | null | undefined): string | null | undefined {
  if (!value || value.startsWith(ENCRYPTED_PREFIX) || ENCRYPTED_VALUE.test(value)) return value;
  return encryptValue(value);
}

export function decryptChannelCredentialSecret(value: string | null | undefined): string {
  if (!value) return '';
  const ciphertext = value.startsWith(ENCRYPTED_PREFIX)
    ? value.slice(ENCRYPTED_PREFIX.length)
    : value;
  if (!ENCRYPTED_VALUE.test(ciphertext)) return value;
  try {
    return decryptValue(ciphertext);
  } catch {
    // Keep legacy / unrecoverable data readable only as a value; provider
    // calls will fail safely and surface a reconnect action rather than crash.
    return value;
  }
}

export function encryptChannelCredentialSession<T>(value: T): T {
  return encryptSensitiveIntegrationConfig(value) as T;
}

export function decryptChannelCredentialSession<T>(value: T): T {
  return decryptSensitiveIntegrationConfig(value) as T;
}
