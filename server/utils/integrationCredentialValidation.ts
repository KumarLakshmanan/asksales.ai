import { MASKED_INTEGRATION_SECRET } from './integrationSecrets.js';
import type { AdminApiPlatform } from '../models/adminApiCredentials/functions.js';
import { normalizeVertexLocation, parseVertexServiceAccountJson } from './vertexAuth.js';
import { asRecordOrNull as object } from '../../shared/records.js';

export const ADMIN_INTEGRATION_PLATFORMS: AdminApiPlatform[] = [
  'openai', 'openrouter', 'apify', 'gemini', 'vertex_ai', 'gemini_image', 'gemini_video',
  'zerobounce', 'smtp', 'razorpay', 'custom_ai', 'resend', 'gmail_oauth',
  'openai_embedding', 'gemini_embedding', 'openrouter_embedding', 'meta_app',
];

const PRIORITIES = new Set(['high', 'normal', 'low', 'fallback']);
const MASKED_VALUE = /^(?:•{4,}|\*{4,}|.{4}\*{4}.{4})$/;

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${field} must be between 1 and ${max} characters`);
  return normalized;
}

function safeConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const config = object(value);
  if (!config) throw new Error('config must be an object');
  const serialized = JSON.stringify(config);
  if (serialized.length > 50_000) throw new Error('config must be 50 KB or smaller');
  if (/"(?:__proto__|prototype|constructor)"\s*:/.test(serialized)) throw new Error('config contains unsafe keys');
  if (config.port !== undefined && (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535)) {
    throw new Error('config.port must be an integer between 1 and 65535');
  }
  if (config.chunkSize !== undefined && (!Number.isInteger(Number(config.chunkSize)) || Number(config.chunkSize) < 100 || Number(config.chunkSize) > 8000)) {
    throw new Error('config.chunkSize must be an integer between 100 and 8000');
  }
  if (config.chunkOverlap !== undefined && (!Number.isInteger(Number(config.chunkOverlap)) || Number(config.chunkOverlap) < 0 || Number(config.chunkOverlap) > 2000)) {
    throw new Error('config.chunkOverlap must be an integer between 0 and 2000');
  }
  return config;
}

export interface IntegrationCredentialInput {
  platform?: AdminApiPlatform;
  name?: string;
  apiKey?: string;
  apiSecret?: string | null;
  priority?: string;
  config?: Record<string, unknown>;
  isActive?: boolean;
}

export function parseIntegrationCredentialInput(value: unknown, update = false): IntegrationCredentialInput {
  const input = object(value);
  if (!input) throw new Error('Request body must be an object');
  const allowed = new Set(['platform', 'name', 'apiKey', 'apiSecret', 'priority', 'config', 'isActive']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Request contains unsupported fields');

  const platformValue = text(input.platform, 'platform', 50, !update);
  if (platformValue && !ADMIN_INTEGRATION_PLATFORMS.includes(platformValue as AdminApiPlatform)) throw new Error('Invalid integration platform');
  const name = text(input.name, 'name', 255, !update);
  let apiKey = text(input.apiKey, 'apiKey', 10_000, !update);
  let apiSecret = input.apiSecret === null ? null : text(input.apiSecret, 'apiSecret', 10_000);
  if (apiKey === MASKED_INTEGRATION_SECRET || (apiKey && MASKED_VALUE.test(apiKey))) apiKey = undefined;
  if (apiSecret === MASKED_INTEGRATION_SECRET || (apiSecret && MASKED_VALUE.test(apiSecret))) apiSecret = undefined;
  const priority = text(input.priority, 'priority', 20);
  if (priority && !PRIORITIES.has(priority)) throw new Error('priority must be high, normal, low, or fallback');
  if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw new Error('isActive must be a boolean');
  const config = safeConfig(input.config);

  const output: IntegrationCredentialInput = {
    ...(platformValue ? { platform: platformValue as AdminApiPlatform } : {}),
    ...(name ? { name } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiSecret !== undefined ? { apiSecret } : {}),
    ...(priority ? { priority } : {}),
    ...(config ? { config } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  };
  if (update && Object.keys(output).length === 0) throw new Error('At least one credential field must be provided');
  return output;
}

export function validateIntegrationRequirements(input: IntegrationCredentialInput, existing?: IntegrationCredentialInput) {
  const platform = input.platform || existing?.platform;
  const apiKey = input.apiKey || existing?.apiKey;
  const apiSecret = input.apiSecret === undefined ? existing?.apiSecret : input.apiSecret;
  const config = input.config || existing?.config || {};
  if (!platform || !apiKey) throw new Error('Platform and API key are required');
  if (['smtp', 'razorpay', 'gmail_oauth', 'meta_app'].includes(platform) && !apiSecret) {
    if (!(platform === 'smtp' && config.provider === 'resend')) throw new Error(`${platform} requires an API secret`);
  }
  if (platform === 'smtp' && config.provider !== 'resend') {
    if (!config.host || !config.port || !config.fromEmail) throw new Error('SMTP requires host, port, and fromEmail');
  }
  if (platform === 'smtp' && config.provider === 'resend' && !config.fromEmail) throw new Error('Resend SMTP requires fromEmail');
  if (platform === 'custom_ai' && !config.baseUrl) throw new Error('Custom AI requires config.baseUrl');
  if (platform === 'vertex_ai') {
    const serviceAccount = parseVertexServiceAccountJson(apiKey);
    normalizeVertexLocation(config.location);
    if (config.projectId && config.projectId !== serviceAccount.project_id) {
      throw new Error('Vertex AI config.projectId must match the service account project_id');
    }
  }
}

export function parseCredentialId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
