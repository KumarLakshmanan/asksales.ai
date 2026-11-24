import crypto from 'node:crypto';
import { webhookSigningSecret } from './webhookSigningSecret.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export const WEBHOOK_CAPABILITY_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
export const WEBHOOK_PURPOSES = ['user', 'instagram', 'facebook', 'whatsapp', 'sms', 'sms_delivery', 'twitter', 'linkedin', 'email', 'leads', 'automation'] as const;
export type WebhookPurpose = typeof WEBHOOK_PURPOSES[number];
export interface WebhookCapabilityClaims {
  userId: number;
  businessProfileId: number;
  purpose: WebhookPurpose;
  issuedAt: number;
  expiresAt: number;
}

function capabilitySignature(payload: string, nonce?: string | null): Buffer {
  return crypto.createHmac('sha256', webhookSigningSecret)
    .update(`asksales-webhook-capability:v2:${payload}:${nonce || ''}`).digest();
}

export function issueWebhookCapability(userId: number, nonce: string | null | undefined, purpose: WebhookPurpose,
  businessProfileId = currentBusinessScope()?.businessProfileId, now = Math.floor(Date.now() / 1000)): string {
  if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2_147_483_647 || !Number.isSafeInteger(businessProfileId) || !businessProfileId || businessProfileId <= 0 || businessProfileId > 2_147_483_647
    || !WEBHOOK_PURPOSES.includes(purpose) || !Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid webhook capability scope');
  const claims: WebhookCapabilityClaims = { userId, businessProfileId, purpose, issuedAt: now, expiresAt: now + WEBHOOK_CAPABILITY_LIFETIME_SECONDS };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `v2.${payload}.${capabilitySignature(payload, nonce).toString('base64url')}`;
}

/** Parsed claims are untrusted until verifyWebhookCapability succeeds. */
export function parseWebhookCapability(value: string, now = Math.floor(Date.now() / 1000)): WebhookCapabilityClaims | null {
  if (typeof value !== 'string' || value.length > 512 || !/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const data = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')) as Partial<WebhookCapabilityClaims>;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 5
      || ![data.userId, data.businessProfileId, data.issuedAt, data.expiresAt].every(n => Number.isSafeInteger(n) && Number(n) > 0)
      || data.userId! > 2_147_483_647 || data.businessProfileId! > 2_147_483_647
      || !WEBHOOK_PURPOSES.includes(data.purpose as WebhookPurpose) || data.issuedAt! > now + 60 || data.expiresAt! <= now
      || data.expiresAt! - data.issuedAt! !== WEBHOOK_CAPABILITY_LIFETIME_SECONDS) return null;
    return data as WebhookCapabilityClaims;
  } catch { return null; }
}

export function verifyWebhookCapability(value: string, nonce: string | null | undefined, expectedPurpose: WebhookPurpose,
  now = Math.floor(Date.now() / 1000)): WebhookCapabilityClaims | null {
  const claims = parseWebhookCapability(value, now);
  if (!claims || claims.purpose !== expectedPurpose) return null;
  const [, payload, signature] = value.split('.');
  const supplied = Buffer.from(signature, 'base64url');
  const expected = capabilitySignature(payload, nonce);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected) ? claims : null;
}

export function webhookCapabilityVerifyToken(capability: string): string {
  return crypto.createHmac('sha256', webhookSigningSecret).update(`asksales-webhook-verify:v2:${capability}`).digest('hex').slice(0, 32);
}

/** Only the verified public-route boundary establishes this authority. An
 * authenticated business request alone never authorizes a webhook callback. */
const verifiedWebhook = new AsyncLocalStorage<Readonly<WebhookCapabilityClaims & { tokenHash: string }>>();
export function withVerifiedWebhookCapability<T>(token: string, claims: WebhookCapabilityClaims, work: () => T): T {
  return verifiedWebhook.run(Object.freeze({ ...claims, tokenHash: crypto.createHash('sha256').update(token).digest('hex') }), work);
}
export function currentVerifiedWebhookCapability(token: string, purpose: WebhookPurpose | readonly WebhookPurpose[]): WebhookCapabilityClaims | undefined {
  const claims = verifiedWebhook.getStore();
  const purposes = Array.isArray(purpose) ? purpose : [purpose];
  if (!claims || !purposes.includes(claims.purpose) || claims.expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
  const scope = currentBusinessScope();
  if (scope?.userId !== claims.userId || scope.businessProfileId !== claims.businessProfileId) return undefined;
  return claims.tokenHash === crypto.createHash('sha256').update(token).digest('hex') ? claims : undefined;
}

export function webhookCapabilityConfig(userId: number, nonce: string | null | undefined, purpose: WebhookPurpose) {
  const token = issueWebhookCapability(userId, nonce, purpose);
  return { token, verifyToken: webhookCapabilityVerifyToken(token), expiresAt: new Date(parseWebhookCapability(token)!.expiresAt * 1000).toISOString() };
}

function tokenInput(userId: number, kind: 'webhook' | 'verify', nonce?: string | null, businessProfileId?: number | null): string {
  const scope = currentBusinessScope();
  const profile = businessProfileId === undefined ? (scope?.userId === userId ? scope.businessProfileId : null) : businessProfileId;
  const legacyInput = `user-${userId}-${kind}${profile ? `-business-${profile}` : ''}`;
  return nonce ? `${legacyInput}:${nonce}` : legacyInput;
}

function generateToken(userId: number, kind: 'webhook' | 'verify', length: number, nonce?: string | null, businessProfileId?: number | null): string {
  return crypto
    .createHmac('sha256', webhookSigningSecret)
    .update(tokenInput(userId, kind, nonce, businessProfileId))
    .digest('hex')
    .substring(0, length);
}

/** Legacy fixture/migration calculation only. Public routes reject this format. */
export function generateUserWebhookToken(userId: number, nonce?: string | null, businessProfileId?: number | null): string {
  return generateToken(userId, 'webhook', 32, nonce, businessProfileId);
}

export function generateUserVerifyToken(userId: number, nonce?: string | null, businessProfileId?: number | null): string {
  return generateToken(userId, 'verify', 24, nonce, businessProfileId);
}
