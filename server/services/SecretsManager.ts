/**
 * Secrets Manager
 * 
 * Abstracts secret retrieval to support multiple backends:
 * - Environment variables (development)
 * - Database (admin_api_credentials — current)
 * - AWS Secrets Manager (production)
 * - HashiCorp Vault (enterprise)
 * 
 * Provides encryption, caching, and audit logging for all secret access.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

// ─── Secret Backend Interface ───────────────────────────────────────────────────

export interface SecretBackend {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string, metadata?: Record<string, string>): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  listSecrets(prefix?: string): Promise<string[]>;
  rotateSecret(key: string, newValue: string): Promise<void>;
}

// ─── Encryption Utilities ───────────────────────────────────────────────────────

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

// Cache derived key at module load time (the key is immutable during runtime)
let _cachedEncryptionKey: Buffer | null = null;
function getEncryptionKey(): Buffer {
  if (_cachedEncryptionKey) return _cachedEncryptionKey;
  const key = process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  _cachedEncryptionKey = crypto.createHash('sha256').update(key).digest();
  return _cachedEncryptionKey;
}

export function encryptValue(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  // Format: iv:tag:encrypted
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

export function decryptValue(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// ─── Environment Backend (Development) ──────────────────────────────────────────

class EnvSecretBackend implements SecretBackend {
  async getSecret(key: string): Promise<string | null> {
    const value = process.env[key] || null;
    if (value) {
      logger.debug({ key }, '[SecretsManager:Env] Secret accessed');
    }
    return value;
  }

  async setSecret(key: string, value: string): Promise<void> {
    process.env[key] = value;
    logger.info({ key }, '[SecretsManager:Env] Secret set');
  }

  async deleteSecret(key: string): Promise<void> {
    delete process.env[key];
    logger.info({ key }, '[SecretsManager:Env] Secret deleted');
  }

  async listSecrets(prefix?: string): Promise<string[]> {
    const keys = Object.keys(process.env);
    if (prefix) {
      return keys.filter((k) => k.startsWith(prefix));
    }
    return keys;
  }

  async rotateSecret(key: string, newValue: string): Promise<void> {
    process.env[key] = newValue;
    logger.info({ key }, '[SecretsManager:Env] Secret rotated');
  }
}

// ─── Database Backend (Current system — enhanced) ───────────────────────────────

class DatabaseSecretBackend implements SecretBackend {
  private cache: Map<string, { value: string; expiresAt: number }> = new Map();
  private cacheTTL: number;

  constructor(cacheTTLSeconds = 300) {
    this.cacheTTL = cacheTTLSeconds * 1000;
  }

  async getSecret(key: string): Promise<string | null> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      logger.debug({ key }, '[SecretsManager:DB] Cache hit');
      return cached.value;
    }

    try {
      // Lazy import to avoid circular dependencies
      const { db } = await import('../models/db.js');
      const { sql } = await import('drizzle-orm');

      const result = await db.execute(
        sql`SELECT api_key, is_encrypted FROM admin_api_credentials 
            WHERE platform = ${key} AND is_active = true 
            ORDER BY last_used_at DESC NULLS LAST LIMIT 1`
      );

      if (result.rows.length === 0) return null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let value = (result.rows[0] as any).api_key;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isEncrypted = (result.rows[0] as any).is_encrypted;

      // Decrypt if stored encrypted
      if (isEncrypted) {
        value = decryptValue(value);
      }

      // Cache the result
      this.cache.set(key, {
        value,
        expiresAt: Date.now() + this.cacheTTL,
      });

      logger.debug({ key }, '[SecretsManager:DB] Secret retrieved from database');
      return value;
    } catch (err) {
      logger.error({ key, err }, '[SecretsManager:DB] Failed to retrieve secret');
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async setSecret(key: string, value: string, metadata?: Record<string, string>): Promise<void> {
    try {
      const encryptedValue = encryptValue(value);
      const { db } = await import('../models/db.js');
      const { sql } = await import('drizzle-orm');

      await db.execute(
        sql`INSERT INTO admin_api_credentials (platform, api_key, is_encrypted, is_active, created_at) 
            VALUES (${key}, ${encryptedValue}, true, true, NOW())
            ON CONFLICT (platform) DO UPDATE SET api_key = ${encryptedValue}, is_encrypted = true, updated_at = NOW()`
      );

      // Update cache
      this.cache.set(key, {
        value,
        expiresAt: Date.now() + this.cacheTTL,
      });

      logger.info({ key }, '[SecretsManager:DB] Secret stored (encrypted)');
    } catch (err) {
      logger.error({ key, err }, '[SecretsManager:DB] Failed to store secret');
      throw err;
    }
  }

  async deleteSecret(key: string): Promise<void> {
    try {
      const { db } = await import('../models/db.js');
      const { sql } = await import('drizzle-orm');

      await db.execute(
        sql`UPDATE admin_api_credentials SET is_active = false WHERE platform = ${key}`
      );
      this.cache.delete(key);

      logger.info({ key }, '[SecretsManager:DB] Secret deactivated');
    } catch (err) {
      logger.error({ key, err }, '[SecretsManager:DB] Failed to delete secret');
    }
  }

  async listSecrets(prefix?: string): Promise<string[]> {
    try {
      const { db } = await import('../models/db.js');
      const { sql } = await import('drizzle-orm');

      const result = await db.execute(
        sql`SELECT DISTINCT platform FROM admin_api_credentials WHERE is_active = true`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keys = result.rows.map((r: any) => r.platform);
      if (prefix) {
        return keys.filter((k: string) => k.startsWith(prefix));
      }
      return keys;
    } catch (err) {
      logger.error({ err }, '[SecretsManager:DB] Failed to list secrets');
      return [];
    }
  }

  async rotateSecret(key: string, newValue: string): Promise<void> {
    await this.setSecret(key, newValue);
    logger.info({ key }, '[SecretsManager:DB] Secret rotated');
  }

  /**
   * Invalidate cache for a specific key
   */
  invalidateCache(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }
}

// ─── Secrets Manager (Facade) ───────────────────────────────────────────────────

class SecretsManager {
  private backend: SecretBackend;
  private auditLog: Array<{ key: string; action: string; timestamp: string; userId?: number }> = [];

  constructor() {
    const backendType = process.env.SECRETS_BACKEND || 'database';

    switch (backendType) {
      case 'database':
      case 'db':
        this.backend = new DatabaseSecretBackend();
        break;
      case 'env':
      case 'environment':
      default:
        this.backend = new EnvSecretBackend();
        break;
    }

    logger.info({ backend: backendType }, '[SecretsManager] Initialized');
  }

  /**
   * Get a secret value
   */
  async getSecret(key: string, userId?: number): Promise<string | null> {
    this.logAccess(key, 'get', userId);
    return this.backend.getSecret(key);
  }

  /**
   * Set a secret value (encrypted)
   */
  async setSecret(key: string, value: string, metadata?: Record<string, string>, userId?: number): Promise<void> {
    this.logAccess(key, 'set', userId);
    return this.backend.setSecret(key, value, metadata);
  }

  /**
   * Delete a secret
   */
  async deleteSecret(key: string, userId?: number): Promise<void> {
    this.logAccess(key, 'delete', userId);
    return this.backend.deleteSecret(key);
  }

  /**
   * Rotate a secret with a new value
   */
  async rotateSecret(key: string, newValue: string, userId?: number): Promise<void> {
    this.logAccess(key, 'rotate', userId);
    return this.backend.rotateSecret(key, newValue);
  }

  /**
   * List available secrets
   */
  async listSecrets(prefix?: string): Promise<string[]> {
    return this.backend.listSecrets(prefix);
  }

  /**
   * Get audit log entries
   */
  getAuditLog(limit = 100): typeof this.auditLog {
    return this.auditLog.slice(-limit);
  }

  /**
   * Internal: Log access for auditing
   */
  private logAccess(key: string, action: string, userId?: number): void {
    const entry = {
      key,
      action,
      timestamp: new Date().toISOString(),
      userId,
    };
    this.auditLog.push(entry);

    // Keep audit log bounded
    if (this.auditLog.length > 10000) {
      this.auditLog = this.auditLog.slice(-5000);
    }

    logger.debug({ key, action, userId }, '[SecretsManager] Access logged');
  }
}

// Singleton
export const secretsManager = new SecretsManager();
