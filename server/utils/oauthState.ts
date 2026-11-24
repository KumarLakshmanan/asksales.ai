import crypto from 'crypto';
import { rememberOAuthBusinessState } from '../tenancy/oauthBusinessScope.js';

// SEC-003: HMAC-signed OAuth state. Signs payload with JWT_SECRET-derived key.
export const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET || '';

export type SignedOAuthState = { userId: number; nonce: string; ts: number };

/** Sign the payload and remember the state for the business that started the flow. */
export async function signOAuthState(payload: SignedOAuthState): Promise<string> {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(b64).digest('base64url');
  return rememberOAuthBusinessState(`${b64}.${sig}`);
}

/** The signed payload when the signature matches and it is under 10 minutes old, otherwise null. */
export function verifyOAuthState(state: string): SignedOAuthState | null {
  if (typeof state !== 'string' || state.length > 2048 || state.split('.').length !== 2) return null;
  const [b64, sig] = state.split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(b64).digest('base64url');
  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    // 10-minute freshness window
    if (!Number.isSafeInteger(payload.userId) || payload.userId <= 0 || !Number.isSafeInteger(payload.ts) || payload.ts > Date.now() || Date.now() - payload.ts > 10 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
