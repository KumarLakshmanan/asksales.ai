import crypto from 'node:crypto';

const SIGNATURE_VERSION = 'v1';
export const SUPPORT_MEDIA_DELIVERY_TTL_SECONDS = 300;
export const SUPPORT_MEDIA_DELIVERY_MAX_TTL_SECONDS = 600;

function signingKey(): Buffer {
  const rootKey = process.env.SUPPORT_MEDIA_DELIVERY_HMAC_KEY
    || process.env.SUPPORT_NOTIFICATION_HMAC_KEY
    || process.env.PRIVACY_VAULT_ENCRYPTION_KEY
    || process.env.ENCRYPTION_KEY;
  if (!rootKey && process.env.NODE_ENV === 'production') {
    throw new Error('A support media delivery signing key is required in production.');
  }
  return crypto.createHmac('sha256', rootKey || 'development-support-media-delivery-key')
    .update('asksales:support-media-delivery:v1')
    .digest();
}

function signaturePayload(assetId: number, checksum: string, expiresAt: number): string {
  return [SIGNATURE_VERSION, assetId, checksum, expiresAt].join(':');
}

function sign(assetId: number, checksum: string, expiresAt: number): string {
  return crypto.createHmac('sha256', signingKey())
    .update(signaturePayload(assetId, checksum, expiresAt))
    .digest('hex');
}

function publicApiOrigin(): string {
  const configured = process.env.APP_URL || process.env.API_URL;
  if (!configured) {
    if (process.env.NODE_ENV === 'production') throw new Error('APP_URL or API_URL is required for support media delivery.');
    return 'http://localhost:8080';
  }
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The public application URL must not contain credentials, a query, or a fragment.');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Support media delivery requires an HTTPS application URL in production.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The public application URL must use HTTP or HTTPS.');
  return url.origin;
}

export function createSupportMediaDeliveryUrl(input: {
  assetId: number;
  checksum: string;
  nowMs?: number;
  ttlSeconds?: number;
}): string {
  if (!Number.isSafeInteger(input.assetId) || input.assetId <= 0) throw new Error('A valid support media asset ID is required.');
  if (!/^[a-f0-9]{64}$/i.test(input.checksum)) throw new Error('A valid support media checksum is required.');
  const ttlSeconds = input.ttlSeconds ?? SUPPORT_MEDIA_DELIVERY_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > SUPPORT_MEDIA_DELIVERY_MAX_TTL_SECONDS) {
    throw new Error('The support media delivery lifetime is invalid.');
  }
  const expiresAt = Math.floor((input.nowMs ?? Date.now()) / 1000) + ttlSeconds;
  // Meta validates remote attachment URLs before fetching them. Keep an image
  // extension in the provider-facing path while the signed asset ID remains
  // the authoritative lookup key.
  // Keep this outside `/api/`: the public robots policy intentionally blocks
  // API crawling, and Meta's attachment fetcher honors that policy.
  const url = new URL(`/support-media-delivery/${input.assetId}/image.jpg`, publicApiOrigin());
  url.searchParams.set('expires', String(expiresAt));
  url.searchParams.set('token', sign(input.assetId, input.checksum, expiresAt));
  return url.toString();
}

export function verifySupportMediaDeliveryToken(input: {
  assetId: number;
  checksum: string;
  expiresAt: number;
  token: string;
  nowMs?: number;
}): boolean {
  if (!Number.isSafeInteger(input.assetId) || input.assetId <= 0
    || !/^[a-f0-9]{64}$/i.test(input.checksum)
    || !Number.isSafeInteger(input.expiresAt)
    || !/^[a-f0-9]{64}$/i.test(input.token)) return false;
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (input.expiresAt <= nowSeconds || input.expiresAt > nowSeconds + SUPPORT_MEDIA_DELIVERY_MAX_TTL_SECONDS) return false;
  const expected = Buffer.from(sign(input.assetId, input.checksum, input.expiresAt), 'hex');
  const provided = Buffer.from(input.token, 'hex');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}
