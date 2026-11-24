import { db } from '../../models/db.js';
import { eq, and, inArray } from 'drizzle-orm';
import { channelCredentialsTable } from '../../models/channelCredentials/schema.js';
import type { PublishResult } from './SocialPublishingService.js';

export type LinkedInPublishResult = PublishResult;
type AccountBinding = { credentialId: number; expectedAccountId: string };
// Pinned to October 2026. OAuth/refresh remains owned by Integrations;
// publication never discovers or replaces the reviewed account identity.
const VERSION = '202610';
const BASE = 'https://api.linkedin.com/rest/posts';
const receipt = (id: unknown): id is string => typeof id === 'string' && /^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/.test(id);

async function credential(userId: number, binding: AccountBinding) {
  const [row] = await db.select().from(channelCredentialsTable).where(and(
    eq(channelCredentialsTable.id, binding.credentialId), eq(channelCredentialsTable.userId, userId),
    inArray(channelCredentialsTable.platform, ['linkedin', 'linkedin_api']), eq(channelCredentialsTable.isActive, true),
  )).limit(1);
  if (!row?.accessToken || row.accountIdentifier !== binding.expectedAccountId
    || !/^urn:li:(person|organization):[^\s:]+$/.test(binding.expectedAccountId)
    || (row.tokenExpiry && row.tokenExpiry.getTime() <= Date.now())) {
    throw Error('The reviewed LinkedIn account is unavailable or changed. Reconnect and review it again.');
  }
  return row;
}
const headers = (token: string) => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': VERSION });
const unknown = (): PublishResult => ({ success: false, ambiguous: true, retryable: false, errorCode: 'LINKEDIN_OUTCOME_UNKNOWN',
  error: 'LinkedIn may have accepted the post, but its receipt could not be verified. Inspect the channel; this attempt will not publish again automatically.' });

export class LinkedInPublishingService {
  static async publishPost(userId: number, text: string, binding: AccountBinding): Promise<LinkedInPublishResult> {
    let token: string;
    try { token = (await credential(userId, binding)).accessToken!; }
    catch (error) { return { success: false, retryable: false, errorCode: 'PUBLISHING_ACCOUNT_UNAVAILABLE', error: (error as Error).message }; }
    if (!text.trim() || text.length > 3000) return { success: false, retryable: false, errorCode: 'LINKEDIN_TEXT_INVALID', error: 'LinkedIn text must contain 1–3,000 characters.' };
    try {
      const response = await fetch(BASE, { method: 'POST', headers: headers(token), signal: AbortSignal.timeout(30000), body: JSON.stringify({
        author: binding.expectedAccountId, commentary: text, visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
      }) });
      if (!response.ok) {
        // Server failures can follow an accepted write. Only definite client
        // rejections can be retryable; transport/5xx never permit replay.
        if (response.status >= 500 || response.status === 408) return unknown();
        return { success: false, ambiguous: false, retryable: response.status === 429, errorCode: 'LINKEDIN_HTTP_' + response.status,
          error: 'LinkedIn rejected publication (HTTP ' + response.status + '). Check the selected account and permissions.' };
      }
      const id = response.headers.get('x-restli-id');
      if (!receipt(id)) return unknown();
      return { success: true, platformPostId: id, postUrl: 'https://www.linkedin.com/feed/update/' + encodeURIComponent(id) };
    } catch { return unknown(); }
  }

  static async reconcilePost(userId: number, postId: string, binding: AccountBinding): Promise<{ success: boolean; exists?: boolean; postUrl?: string; error?: string; ambiguous?: boolean }> {
    try {
      if (!receipt(postId)) throw Error('A valid LinkedIn post receipt is required.');
      const row = await credential(userId, binding);
      const response = await fetch(BASE + '/' + encodeURIComponent(postId), { headers: headers(row.accessToken!), signal: AbortSignal.timeout(30000) });
      if (response.status === 404) return { success: true, exists: false };
      if (!response.ok) throw Error('LinkedIn status could not be checked (HTTP ' + response.status + '). Read access may require additional provider permission.');
      const post = await response.json() as { id?: string; author?: string };
      if (post.id !== postId || post.author !== binding.expectedAccountId) throw Error('LinkedIn returned a post outside the reviewed account.');
      return { success: true, exists: true, postUrl: 'https://www.linkedin.com/feed/update/' + encodeURIComponent(postId) };
    } catch (error) { return { success: false, ambiguous: true, error: (error as Error).message }; }
  }

  static async deletePost(userId: number, postId: string, binding: AccountBinding): Promise<{ success: boolean; error?: string; ambiguous?: boolean }> {
    let token: string;
    try { if (!receipt(postId)) throw Error('A valid LinkedIn post receipt is required.'); token = (await credential(userId, binding)).accessToken!; }
    catch (error) { return { success: false, error: (error as Error).message }; }
    try {
      const response = await fetch(BASE + '/' + encodeURIComponent(postId), { method: 'DELETE', headers: headers(token), signal: AbortSignal.timeout(30000) });
      if (!response.ok) return { success: false, ambiguous: response.status >= 500, error: 'LinkedIn deletion was not confirmed (HTTP ' + response.status + ').' };
      return { success: true };
    } catch { return { success: false, ambiguous: true, error: 'LinkedIn deletion outcome is unknown. The known publication receipt is retained.' }; }
  }
}
