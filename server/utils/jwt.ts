import jwt from "jsonwebtoken";
import crypto from "crypto";
import { getRedisConnection } from "../infrastructure/redis";

// SECURITY: JWT_SECRET must always be set — no fallback
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'test') {
    // Allow test runs with a fixed test-only secret
    process.env.JWT_SECRET = 'test-only-secret-not-for-production';
  } else {
    throw new Error('JWT_SECRET environment variable must be set');
  }
}
const EFFECTIVE_JWT_SECRET = process.env.JWT_SECRET as string;

// Phase 4.9 / SEC-011: support for secret rotation.
// JWT_SECRET_PREVIOUS is an optional comma-separated list of older secrets
// (newest first). Tokens signed with a previous secret are still accepted
// during the rotation window so that users with in-flight tokens don't get
// logged out when a new secret is deployed. New tokens always use the
// current secret.
const PREVIOUS_SECRETS = (process.env.JWT_SECRET_PREVIOUS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && s !== EFFECTIVE_JWT_SECRET);

const JWT_EXPIRES_IN = "7d";

export interface JWTPayload {
  userId?: number;
  adminId?: number;
  supportMemberId?: number;
  email: string;
  role?: string;
  iat?: number;
}

const BLOCKLIST_KEY = (jti: string) => `blocked_token:${jti}`;

/**
 * SEC-005: Token revocation via Redis blocklist.
 * Adds the JTI to a Redis key with TTL = remaining token lifetime.
 */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    // Never let attacker-controlled decode-only claims choose a blocklist key
    // or TTL. Verification includes signature/expiry and the rotation window.
    const decoded = verifyToken(token) as (JWTPayload & { jti?: string; exp?: number }) | null;
    if (!decoded || typeof decoded.jti !== 'string' || !decoded.jti || decoded.jti.length > 128
      || !Number.isSafeInteger(decoded.exp)) return false;
    const redis = getRedisConnection();
    const ttl = decoded.exp! - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return true; // already expired
    await redis.set(BLOCKLIST_KEY(decoded.jti), '1', 'EX', ttl);
    return true;
  } catch (_e) {
    return false;
  }
}

export async function isTokenRevoked(jti: string, failClosed = false): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    const v = await redis.get(BLOCKLIST_KEY(jti));
    return v !== null;
  } catch (error) {
    if (failClosed) throw error;
    return false;
  }
}

export function generateToken(payload: JWTPayload): string {
  const jti = crypto.randomBytes(16).toString('hex');
  // NumericDate permits fractional seconds. User/admin sessions need millisecond
  // precision to distinguish a fresh login from the password it replaced.
  return jwt.sign({ ...payload, ...((payload.userId || payload.adminId) ? { iat: Date.now() / 1000 } : {}), jti },
    EFFECTIVE_JWT_SECRET, { expiresIn: payload.adminId ? '1h' : JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JWTPayload | null {
  // Try current secret first, then fall back to previous secrets.
  for (const secret of [EFFECTIVE_JWT_SECRET, ...PREVIOUS_SECRETS]) {
    try {
      const decoded = jwt.verify(token, secret) as (JWTPayload & { jti?: string });
      return decoded;
    } catch (_error) {
      // try next
    }
  }
  return null;
}

export function generateRandomToken(): string {
  // Generate a 6-digit OTP code
  return crypto.randomInt(100000, 1_000_000).toString();
}

/** Generate a high-entropy token suitable for emailed verification links. */
export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Store only a one-way digest of bearer-style verification tokens. */
export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
