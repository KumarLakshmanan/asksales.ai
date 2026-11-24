import { decryptValue, encryptValue } from '../services/SecretsManager.js';
import { isRecord as isPlainRecord } from '../../shared/records.js';

export const MASKED_INTEGRATION_SECRET = '••••••••';
const ENCRYPTED_CONFIG_PREFIX = 'enc:v1:';
const SENSITIVE_CONFIG_KEY = /(?:api[_-]?key|secret|password|private[_-]?key|credentials|token|service[_-]?account)$/i;

export function isSensitiveIntegrationConfigKey(key: string): boolean {
  return SENSITIVE_CONFIG_KEY.test(key);
}

export function containsSensitiveIntegrationConfig(value: unknown, key = ''): boolean {
  if (isSensitiveIntegrationConfigKey(key) && value !== null && value !== undefined && value !== '') return true;
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveIntegrationConfig(entry, key));
  if (isPlainRecord(value)) return Object.entries(value).some(([childKey, child]) => containsSensitiveIntegrationConfig(child, childKey));
  return false;
}

export function encryptSensitiveIntegrationConfig(value: unknown, key = ''): unknown {
  if (isSensitiveIntegrationConfigKey(key) && value !== null && value !== undefined && value !== '') {
    if (typeof value === 'string' && value.startsWith(ENCRYPTED_CONFIG_PREFIX)) return value;
    return `${ENCRYPTED_CONFIG_PREFIX}${encryptValue(JSON.stringify(value))}`;
  }
  if (Array.isArray(value)) return value.map((entry) => encryptSensitiveIntegrationConfig(entry, key));
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      encryptSensitiveIntegrationConfig(child, childKey),
    ]));
  }
  return value;
}

export function decryptSensitiveIntegrationConfig(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(ENCRYPTED_CONFIG_PREFIX)) {
    return JSON.parse(decryptValue(value.slice(ENCRYPTED_CONFIG_PREFIX.length))) as unknown;
  }
  if (Array.isArray(value)) return value.map(decryptSensitiveIntegrationConfig);
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decryptSensitiveIntegrationConfig(child)]));
  }
  return value;
}

export function maskSensitiveIntegrationConfig(value: unknown, key = ''): unknown {
  if (isSensitiveIntegrationConfigKey(key) && value !== null && value !== undefined && value !== '') {
    return MASKED_INTEGRATION_SECRET;
  }
  if (Array.isArray(value)) return value.map((entry) => maskSensitiveIntegrationConfig(entry, key));
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      maskSensitiveIntegrationConfig(child, childKey),
    ]));
  }
  return value;
}

export function mergeIntegrationCredentialConfig(existing: unknown, incoming: unknown): Record<string, unknown> {
  const merged: Record<string, unknown> = isPlainRecord(existing) ? { ...existing } : {};
  if (!isPlainRecord(incoming)) return merged;
  for (const [key, value] of Object.entries(incoming)) {
    if (value === MASKED_INTEGRATION_SECRET || (typeof value === 'string' && /^•{4,}/.test(value))) continue;
    if (value === null) {
      delete merged[key];
      continue;
    }
    if (isPlainRecord(value) && isPlainRecord(merged[key]) && !isSensitiveIntegrationConfigKey(key)) {
      merged[key] = mergeIntegrationCredentialConfig(merged[key], value);
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
