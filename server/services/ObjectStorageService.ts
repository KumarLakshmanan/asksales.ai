import { normalizeStorageKey } from './storageObjectKey.js';
/**
 * Object Storage Service
 * 
 * Abstracts file storage to support multiple backends:
 * - Local filesystem (development)
 * - AWS S3 (production)
 * - Google Cloud Storage (alternative)
 * 
 * Replaces direct filesystem access with cloud-ready object storage.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import { Readable } from "node:stream";
import { localStoragePath } from '../utils/localStoragePath.js';
import { logger } from '../utils/logger.js';

// ─── Storage Backend Interface ──────────────────────────────────────────────────

export interface StorageBackend {
  upload(
    key: string,
    buffer: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<string>;
  download(key: string): Promise<Buffer>;
  openReadStream?(
    key: string,
    range?: { start: number; end: number },
  ): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSignedUrl(key: string, expiresIn?: number): Promise<string>;
  getPublicUrl(key: string): string;
  list(prefix: string, maxKeys?: number): Promise<string[]>;
}

export { normalizeStorageKey } from './storageObjectKey.js';

// ─── S3 Backend ─────────────────────────────────────────────────────────────────

class S3StorageBackend implements StorageBackend {
  private client: S3Client;
  private bucket: string;
  private region: string;
  private cdnUrl?: string;

  constructor() {
    this.region = process.env.AWS_REGION || 'us-east-1';
    const configuredBucket = process.env.AWS_S3_BUCKET?.trim();
    if (process.env.NODE_ENV === 'production' && !configuredBucket) {
      throw new Error('AWS_S3_BUCKET is required when using S3 storage in production');
    }
    this.bucket = configuredBucket || 'salesmarketing-uploads';
    this.cdnUrl = process.env.CDN_URL;

    const endpoint = process.env.S3_ENDPOINT; // MinIO: http://localhost:9000

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured together');
    }

    this.client = new S3Client({
      region: this.region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: accessKeyId
        ? {
            accessKeyId,
            secretAccessKey: secretAccessKey!,
          }
        : undefined, // Use IAM role if no explicit credentials
    });

    logger.info({ bucket: this.bucket, region: this.region, endpoint: endpoint || 'default' }, '[S3Storage] Initialized');
  }

  async upload(key: string, buffer: Buffer, contentType: string, metadata?: Record<string, string>): Promise<string> {
    key = normalizeStorageKey(key);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      Metadata: metadata,
    });

    await this.client.send(command);
    logger.info({ key, size: buffer.length, contentType }, '[S3Storage] File uploaded');
    return this.getPublicUrl(key);
  }

  async download(key: string): Promise<Buffer> {
    key = normalizeStorageKey(key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of response.Body as any) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async openReadStream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: normalizeStorageKey(key),
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    if (!(response.Body instanceof Readable))
      throw new Error("Storage response has no readable body");
    return response.Body;
  }

  async delete(key: string): Promise<void> {
    key = normalizeStorageKey(key);
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.client.send(command);
    logger.info({ key }, '[S3Storage] File deleted');
  }

  async exists(key: string): Promise<boolean> {
    key = normalizeStorageKey(key);
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      await this.client.send(command);
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    key = normalizeStorageKey(key);
    expiresIn = Math.min(Math.max(Math.floor(expiresIn), 60), 3600);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return getSignedUrl(this.client as any, command, { expiresIn });
  }

  getPublicUrl(key: string): string {
    key = normalizeStorageKey(key);
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    if (this.cdnUrl) {
      return `${this.cdnUrl.replace(/\/$/, '')}/${encodedKey}`;
    }
    const endpoint = process.env.S3_ENDPOINT;
    if (endpoint) {
      // MinIO or custom S3-compatible endpoint
      return `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(this.bucket)}/${encodedKey}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`;
  }

  async list(prefix: string, maxKeys = 1000): Promise<string[]> {
    prefix = normalizeStorageKey(prefix, true);
    maxKeys = Math.min(Math.max(Math.floor(maxKeys), 1), 1000);
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: maxKeys,
    });
    const response = await this.client.send(command);
    const contents = response.Contents as Array<{ Key?: string }> | undefined;
    return (contents || []).flatMap((item) => item.Key ? [item.Key] : []);
  }
}

// ─── Local Filesystem Backend ───────────────────────────────────────────────────

class LocalStorageBackend implements StorageBackend {
  private basePath: string;
  private baseUrl: string;

  constructor() {
    if (process.env.NODE_ENV === 'production' && !process.env.LOCAL_STORAGE_PATH) {
      throw new Error('LOCAL_STORAGE_PATH must point to a persistent volume when local storage is used in production');
    }
    this.basePath = localStoragePath();
    this.baseUrl = process.env.LOCAL_STORAGE_URL || '/uploads';

    // Ensure base directory exists
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }

    logger.info({ basePath: this.basePath }, '[LocalStorage] Initialized');
  }

  private resolveKey(key: string, allowEmpty = false): { key: string; filePath: string } {
    const safeKey = normalizeStorageKey(key, allowEmpty);
    const basePath = path.resolve(this.basePath);
    const filePath = path.resolve(basePath, safeKey);
    if (filePath !== basePath && !filePath.startsWith(`${basePath}${path.sep}`)) {
      throw new Error('Storage key escapes the configured storage root');
    }
    return { key: safeKey, filePath };
  }

  async upload(key: string, buffer: Buffer, _contentType: string, _metadata?: Record<string, string>): Promise<string> {
    const resolved = this.resolveKey(key);
    key = resolved.key;
    const filePath = resolved.filePath;
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, buffer);
    logger.info({ key, size: buffer.length }, '[LocalStorage] File uploaded');
    return this.getPublicUrl(key);
  }

  async download(key: string): Promise<Buffer> {
    const { filePath } = this.resolveKey(key);
    return fs.readFileSync(filePath);
  }

  async openReadStream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<Readable> {
    const { filePath } = this.resolveKey(key);
    await fs.promises.access(filePath);
    return fs.createReadStream(filePath, range);
  }

  async delete(key: string): Promise<void> {
    const resolved = this.resolveKey(key);
    key = resolved.key;
    const filePath = resolved.filePath;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info({ key }, '[LocalStorage] File deleted');
    }
  }

  async exists(key: string): Promise<boolean> {
    const { filePath } = this.resolveKey(key);
    return fs.existsSync(filePath);
  }

  async getSignedUrl(key: string, _expiresIn?: number): Promise<string> {
    // Local doesn't support signed URLs — return public URL
    return this.getPublicUrl(key);
  }

  getPublicUrl(key: string): string {
    const safeKey = normalizeStorageKey(key);
    return `${this.baseUrl}/${safeKey.split('/').map(encodeURIComponent).join('/')}`;
  }

  async list(prefix: string, _maxKeys?: number): Promise<string[]> {
    const resolved = this.resolveKey(prefix, true);
    prefix = resolved.key;
    const dirPath = resolved.filePath;
    if (!fs.existsSync(dirPath)) return [];

    const files: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        files.push(path.join(prefix, entry.name));
      }
    }
    return files;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────────

function createStorageBackend(): StorageBackend {
  const backend = process.env.STORAGE_BACKEND || 'local';

  switch (backend) {
    case 's3':
    case 'aws':
      return new S3StorageBackend();
    case 'local':
      return new LocalStorageBackend();
    default:
      throw new Error(`Unsupported STORAGE_BACKEND: ${backend}`);
  }
}

// ─── Singleton Export ───────────────────────────────────────────────────────────

export const objectStorage: StorageBackend = createStorageBackend();
