import { describe, expect, it } from '@jest/globals';
import { assertPublishReviewMatches, assertReviewedProviderAccount, buildCampaignPublishReview, publishReviewRevision } from '../services/ads/CampaignPublishReview.js';
import { campaignPublishFixture } from './fixtures/campaignPublish.js';

describe('immutable paid campaign review', () => {
  it.each([
    ['2026-09-09 03:30:00', '2026-09-16 03:30:00'],
    ['2026-09-09T09:00:00+05:30', '2026-09-16T09:00:00+05:30'],
  ])('preserves UTC schedule instants for SQL and offset timestamps (%s)', (start, end) => {
    const { campaign, allocations } = campaignPublishFixture();
    const review = buildCampaignPublishReview({ ...campaign, start_date: start, end_date: end }, allocations);
    expect(review.snapshot.startDate).toBe('2026-09-09T03:30:00.000Z');
    expect(review.snapshot.endDate).toBe('2026-09-16T03:30:00.000Z');
  });

  it('includes exact budgets, provider settings, source versions and normalized creative', () => {
    const { review } = campaignPublishFixture();
    expect(review.validationErrors).toEqual([]);
    expect(review.platformErrors).toEqual({ meta: [], google: [] });
    expect(review.snapshot).toMatchObject({ budget: { amountMinor: 10000, budgetType: 'lifetime' },
      allocations: [{ platform: 'meta', amountMinor: 6000 }, { platform: 'google', amountMinor: 4000 }],
      providerConfig: { meta: { placements: ['instagram_stream'] } }, creativeSources: [{ sourceId: 88, sourceVersion: 2 }],
    });
  });

  it.each([
    ['budget', (c: any) => { c.budget_amount = '101.00'; }],
    ['currency', (c: any) => { c.currency = 'EUR'; }],
    ['destination', (c: any) => { c.landing_page_url += '?changed'; }],
    ['schedule', (c: any) => { c.start_date = new Date('2090-01-02T10:00:00Z'); }],
    ['targeting', (c: any) => { c.targeting.age_min = 35; }],
    ['Meta Page', (c: any) => { c.settings.accountSnapshot.meta.pageId = '99'; }],
    ['Instagram identity', (c: any) => { c.settings.accountSnapshot.meta.instagramAccountId = '99'; }],
    ['Google customer', (c: any) => { c.settings.accountSnapshot.google.customerId = '9999999999'; }],
    ['placements', (c: any) => { c.settings.providerConfig.meta.placements = ['facebook_feed']; }],
    ['bidding', (c: any) => { c.settings.providerConfig.google.biddingStrategy = 'MAXIMIZE_CLICKS'; }],
    ['copy', (c: any) => { c.ad_creatives.meta[0].primaryText = 'Unapproved text'; }],
    ['media', (c: any) => { c.ad_creatives.meta[0].imageHash = 'different-image'; }],
    ['source version', (c: any) => { c.settings.context.creativeSources[0].sourceVersion++; }],
    ['creative revision', (c: any) => { c.settings.context.creativeRevision++; }],
  ])('rejects %s changes before execution', (_name, mutate) => {
    const { campaign, allocations, approved } = campaignPublishFixture();
    (mutate as (c: unknown) => void)(campaign);
    expect(() => assertPublishReviewMatches(approved, campaign, allocations, 'meta')).toThrow('changed after review');
  });

  it('rejects allocation changes even if the total budget stays the same', () => {
    const { campaign, allocations, approved } = campaignPublishFixture();
    allocations[0].amount = 50; allocations[1].amount = 50;
    expect(() => assertPublishReviewMatches(approved, campaign, allocations, 'meta')).toThrow('changed after review');
  });

  it('ignores telemetry and key ordering but not the approved content', () => {
    const { campaign, allocations, approved } = campaignPublishFixture();
    campaign.spent_amount = '1.00'; allocations[0].spent = 1;
    campaign.settings.accountSnapshot.capturedAt = new Date(0).toISOString();
    expect(() => assertPublishReviewMatches(approved, campaign, allocations, 'meta')).not.toThrow();
    expect(publishReviewRevision({ a: 1, b: 2 })).toBe(publishReviewRevision({ b: 2, a: 1 }));
  });

  it('rejects forged, missing, foreign or expired approval', () => {
    const { campaign, allocations, approved } = campaignPublishFixture();
    expect(() => assertPublishReviewMatches(undefined, campaign, allocations, 'meta')).toThrow('saved campaign review');
    expect(() => assertPublishReviewMatches({ ...approved, approvedAt: new Date(0).toISOString() }, campaign, allocations, 'meta')).toThrow('expired');
    expect(() => assertPublishReviewMatches({ ...approved, snapshot: { ...approved.snapshot, userId: 99 } }, campaign, allocations, 'meta')).toThrow('changed');
  });

  it('keeps missing accounts and Google location requirements per platform', () => {
    const { campaign, allocations } = campaignPublishFixture();
    delete (campaign.settings.accountSnapshot as any).google;
    delete (campaign.locations[0] as any).googleGeoTargetId;
    campaign.validation_errors = ['Old provider timeout'];
    const review = buildCampaignPublishReview(campaign, allocations);
    expect(review.validationErrors).toEqual([]);
    expect(review.platformErrors.meta).toEqual([]);
    expect(review.platformErrors.google!.join(' ')).toMatch(/Google location|google account/);
    expect(JSON.stringify(review)).not.toContain('Old provider timeout');
  });

  it('compares exact account, Page, manager and timezone identities', () => {
    const { review, accounts } = campaignPublishFixture();
    expect(() => assertReviewedProviderAccount(review.snapshot, accounts, 'google')).not.toThrow();
    accounts.google.timezone = 'Asia/Kolkata';
    expect(() => assertReviewedProviderAccount(review.snapshot, accounts, 'google')).toThrow('changed');
  });
});
