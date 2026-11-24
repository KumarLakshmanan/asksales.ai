/**
 * Compatibility helpers for Meta credentials.
 *
 * Meta tokens historically lived in plaintext columns and, in a few flows,
 * inside sessionData.  Keep reads compatible with those rows while requiring
 * every new write to use the shared envelope encryption format.
 */
import { decryptValue, encryptValue } from '../services/SecretsManager.js';

const PREFIX = 'enc:v1:';
const CIPHERTEXT = /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i;

export function encryptMetaSecret(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  if (value.startsWith(PREFIX) || CIPHERTEXT.test(value)) return value;
  return `${PREFIX}${encryptValue(value)}`;
}

/** Reads plaintext legacy values and both supported encrypted formats. */
export function decryptMetaSecret(value: string | null | undefined): string {
  if (!value) return '';
  const ciphertext = value.startsWith(PREFIX) ? value.slice(PREFIX.length) : value;
  if (!CIPHERTEXT.test(ciphertext)) return value;
  return decryptValue(ciphertext);
}

export function isEncryptedMetaSecret(value: string | null | undefined): boolean {
  if (!value) return false;
  const ciphertext = value.startsWith(PREFIX) ? value.slice(PREFIX.length) : value;
  return CIPHERTEXT.test(ciphertext);
}

/** Legacy/manual apiKey values may be App IDs; only explicitly bound OAuth rows carry Page tokens. */
export function boundMetaPageToken(credential: { credentialType: string; apiKey?: string | null; sessionData?: unknown }): string | null {
  const metadata = credential.sessionData as { pageTokenBound?: boolean } | null;
  return credential.credentialType === 'oauth' && metadata?.pageTokenBound === true ? credential.apiKey || null : null;
}

/** Metadata deliberately allowed in sessionData. Tokens and app secrets stay in columns. */
export function metaSessionMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const { pageAccessToken: _pageAccessToken, accessToken: _accessToken, appSecret: _appSecret, ...metadata } = value as Record<string, unknown>;
  return metadata;
}
