import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { responseWrapper } from '../middleware/responseWrapper.js';

const receipt = { success: false, scheduled: false, terminal: false, status: 'provider_succeeded', attemptId: 81, assetId: 1,
  postId: 'urn:li:share:123456789', postUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123456789' };
const accepted = { success: false, accepted: true, scheduled: false, partialSuccess: false, platform: 'linkedin', platforms: ['linkedin'], results: { linkedin: receipt } };
function send(body: unknown, status = 202) {
  const app = express(); app.use('/api', responseWrapper);
  app.post('/api/content/assets/1/publish', (_req, res) => res.status(status).json(body));
  return request(app).post('/api/content/assets/1/publish');
}

describe('bounded publishing acknowledgement envelopes', () => {
  it('keeps accepted202 with per-destination recovery identity without inventing a failure message', async () => {
    const response = await send(accepted);
    expect(response.status).toBe(202); expect(response.body).toEqual(accepted);
  });
  it('preserves public publishing flags/results on a real error status while dropping internal snapshots', async () => {
    const response = await send({ ...accepted, error: 'Review the destination.', code: 'PUBLISH_REVIEW_REQUIRED', reviewedPayload: { publicationOrigin: { billingActorUserId: 993 } },
      results: { linkedin: { ...receipt, status: 'ambiguous', terminal: true, error: 'Provider rejected Bearer synthetic-token-value; retry.', errorCode: 'PUBLISH_OUTCOME_UNKNOWN', providerRequestId: 'internal', credentialId: 13, publicationOrigin: { businessActorUserId: 993 }, raw: { access_token: 'synthetic-only' } } } }, 422);
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ ...accepted, error: 'Review the destination.', code: 'PUBLISH_REVIEW_REQUIRED',
      results: { linkedin: { ...receipt, status: 'ambiguous', terminal: true, error: 'Provider rejected Bearer [REDACTED]; retry.', errorCode: 'PUBLISH_OUTCOME_UNKNOWN' } } });
  });
  it.each(['pending', 'claimed', 'provider_succeeded', 'succeeded', 'retryable_failed', 'ambiguous', 'failed', 'cancelled', 'remote_deleted'])('retains established attempt status %s', async status => {
    const response = await send({ ...accepted, results: { linkedin: { success: false, status } } });
    expect(response.body.results).toEqual({ linkedin: { success: false, status } });
  });
  it('bounds results to four supported own platform keys', async () => {
    const response = await send({ ...accepted, platform: 'not-supported', platforms: ['linkedin', 'not-supported'], results: {
      linkedin: { success: false }, instagram: { success: true }, facebook: { success: true }, youtube: { success: false },
      tiktok: { success: true }, constructor: { success: true }, __proto__: { success: true },
    } });
    expect(response.body.results).toEqual({ linkedin: { success: false }, instagram: { success: true }, facebook: { success: true }, youtube: { success: false } });
    expect(response.body).not.toHaveProperty('platform'); expect(response.body).not.toHaveProperty('platforms');
  });
  it.each([['linkedin', 'instagram', 'facebook', 'youtube', 'linkedin'], ['linkedin', 'linkedin'], ['tiktok']])('rejects malformed/oversized platform lists: %j', async (...platforms) => {
    const response = await send({ ...accepted, platforms });
    expect(response.body).not.toHaveProperty('platforms');
  });
  it('rejects malformed booleans/IDs/statuses rather than coercing them', async () => {
    const response = await send({ ...accepted, accepted: 'true', partialSuccess: 1, scheduled: null,
      results: { linkedin: { success: false, scheduled: 'false', terminal: 1, attemptId: 0, assetId: '1', status: 'internal_provider_state', errorCode: '23505' }, youtube: { success: 'true', status: 'succeeded' } } });
    expect(response.body.results).toEqual({ linkedin: { success: false } });
    for (const key of ['accepted', 'scheduled', 'partialSuccess']) expect(response.body).not.toHaveProperty(key);
    expect(response.body.error).toBe('An error occurred');
  });
  it('does not treat malformed results as a trustworthy acknowledgement', async () => {
    const response = await send({ ...accepted, results: { linkedin: new Error('Internal provider failure') } });
    for (const key of ['results', 'accepted', 'scheduled', 'partialSuccess']) expect(response.body).not.toHaveProperty(key);
    expect(response.body.error).toBe('An error occurred');
  });
  it('never evaluates nested result, field or platform-list getters, or uses inherited receipts', async () => {
    const getter = jest.fn(() => 'synthetic-only');
    const entry = Object.create({ status: 'succeeded' }) as Record<string, unknown>; entry.success = false;
    Object.defineProperty(entry, 'error', { get: getter, enumerable: true });
    const results = Object.create({ youtube: { success: true } }) as Record<string, unknown>; results.linkedin = entry;
    Object.defineProperty(results, 'facebook', { get: getter, enumerable: true });
    const platforms = ['linkedin']; Object.defineProperty(platforms, '0', { get: getter });
    const response = await send({ ...accepted, results, platforms });
    expect(response.body.results).toEqual({ linkedin: { success: false } });
    expect(response.body).not.toHaveProperty('platforms'); expect(getter).not.toHaveBeenCalled();
  });
  it('bounds optional strings and does not pass provider/SQL error codes or credential-shaped IDs', async () => {
    const response = await send({ ...accepted, results: { linkedin: { success: false, postId: 'x'.repeat(256), postUrl: 'https://www.linkedin.com/' + 'x'.repeat(2048), error: 'x'.repeat(10000), errorCode: 'invalid_grant' }, youtube: { success: false, postId: 'sk_syntheticsecretvalue', errorCode: 'X'.repeat(101) } } });
    expect(response.body.results.linkedin).toEqual({ success: false, error: 'x'.repeat(2000) });
    expect(response.body.results.youtube).toEqual({ success: false });
  });
  it.each(['javascript:alert(1)', 'https://user:pass@www.linkedin.com/post', 'https://www.linkedin.com/post?access_token=synthetic', 'https://www.linkedin.com.evil.test/post'])('excludes unsafe post links: %s', async postUrl => {
    const response = await send({ ...accepted, results: { linkedin: { success: false, postUrl } } });
    expect(response.body.results.linkedin).toEqual({ success: false });
  });
  it.each(['invalid_grant', '23505', 'SK_SYNTHETICSECRET', 'X'.repeat(101)])('excludes unsafe or unrecognized nested error codes: %s', async errorCode => {
    const response = await send({ ...accepted, results: { linkedin: { success: false, errorCode } } });
    expect(response.body.results.linkedin).toEqual({ success: false });
  });
  it.each([['youtube', 'https://youtu.be/synthetic01'], ['instagram', 'https://www.instagram.com/p/synthetic/'], ['facebook', 'https://www.facebook.com/synthetic'], ['linkedin', receipt.postUrl]])('keeps the %s public provider link', async (platform, postUrl) => {
    const response = await send({ ...accepted, platform, platforms: [platform], results: { [platform]: { success: false, postUrl } } });
    expect(response.body.platform).toBe(platform); expect(response.body.platforms).toEqual([platform]);
    expect(response.body.results).toEqual({ [platform]: { success: false, postUrl } });
  });
  it('preserves other module platform errors without treating them as publishing receipts', async () => {
    expect((await send({ error: 'Review the campaign.', platform: 'google_ads', results: { unrelated: { success: false } } }, 400)).body).toEqual({ success: false, error: 'Review the campaign.', platform: 'google_ads' });
  });
});
