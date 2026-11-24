import crypto from 'crypto';

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * Use this for comparing secrets, tokens, and webhook verify tokens.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a comparison on equal-length buffers to avoid revealing lengths
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
