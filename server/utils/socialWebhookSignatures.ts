import crypto from 'node:crypto';
import { timingSafeEqual } from './secureCompare.js';

function usableInputs(
  rawBody: Buffer | undefined,
  signature: unknown,
  secret: unknown,
): signature is string {
  return Boolean(
    rawBody?.length
    && typeof signature === 'string'
    && signature.length > 0
    && typeof secret === 'string'
    && secret.length > 0,
  );
}

/** Verify the x-twitter-webhooks-signature over the exact request bytes. */
export function verifyTwitterWebhookSignature(
  rawBody: Buffer | undefined,
  signature: unknown,
  consumerSecret: unknown,
): boolean {
  if (!usableInputs(rawBody, signature, consumerSecret)) return false;
  const expected = `sha256=${crypto
    .createHmac('sha256', consumerSecret as string)
    .update(rawBody!)
    .digest('base64')}`;
  return timingSafeEqual(expected, signature);
}

/** Verify LinkedIn's X-LI-Signature over `hmacsha256=` plus raw JSON. */
export function verifyLinkedInWebhookSignature(
  rawBody: Buffer | undefined,
  signature: unknown,
  clientSecret: unknown,
): boolean {
  if (!usableInputs(rawBody, signature, clientSecret)) return false;
  const stringToSign = Buffer.concat([
    Buffer.from('hmacsha256=', 'utf8'),
    rawBody!,
  ]);
  const expected = crypto
    .createHmac('sha256', clientSecret as string)
    .update(stringToSign)
    .digest('hex');
  return timingSafeEqual(expected, signature.toLowerCase());
}

export function twitterChallengeResponse(crcToken: string, consumerSecret: string): string {
  return `sha256=${crypto
    .createHmac('sha256', consumerSecret)
    .update(crcToken)
    .digest('base64')}`;
}

export function linkedInChallengeResponse(challengeCode: string, clientSecret: string): string {
  return crypto
    .createHmac('sha256', clientSecret)
    .update(challengeCode)
    .digest('hex');
}
