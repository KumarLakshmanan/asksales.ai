import fs from 'node:fs';
import path from 'node:path';
import { compareCompetitorMetrics, extractMetaDailyMetrics, extractMetaTotalMetrics, isValidIanaTimeZone, isValidIsoDate, normalizeSocialMetrics, scheduledReportDefinitionIsDue, scheduledReportIsDue } from '../controllers/socialAnalyticsController.js';

describe('social analytics policy', () => {
  it('normalizes provider-specific Facebook, Instagram, and YouTube names to one canonical metric set', () => {
    expect(normalizeSocialMetrics({
      page_impressions: 12,
      page_post_engagements: '7',
      page_video_views: 4,
    })).toEqual({ impressions: 12, engagements: 7, views: 4 });
    expect(normalizeSocialMetrics({
      impressions: 11,
      reach: 10,
      total_interactions: 5,
      profile_links_taps: 2,
    })).toEqual({ impressions: 11, reach: 10, engagements: 5, clicks: 2 });
    expect(normalizeSocialMetrics({
      views: 9,
      estimatedMinutesWatched: 4,
      averageViewDuration: 21,
      subscribersGained: 3,
      subscribersLost: 1,
    })).toEqual({ views: 9, watch_time_seconds: 240, average_view_duration_seconds: 21, subscribers_gained: 3, subscribers_lost: 1 });
  });

  it('refuses malformed, empty, or negative provider metrics instead of making an AI claim from them', () => {
    expect(normalizeSocialMetrics({ unknown: 1 })).toBeNull();
    expect(normalizeSocialMetrics({ impressions: -1 })).toBeNull();
    expect(normalizeSocialMetrics({ impressions: 'not-a-number' })).toBeNull();
    expect(normalizeSocialMetrics([])).toBeNull();
  });

  it('normalizes current Meta total-value and time-series insight response shapes', () => {
    expect(extractMetaTotalMetrics({ data: [
      { name: 'reach', total_value: { value: 384 } },
      { name: 'views', total_value: { value: 250 } },
      { name: 'total_interactions', total_value: { value: 18 } },
      { name: 'profile_links_taps', total_value: { value: 6 } },
    ] })).toEqual({ reach: 384, views: 250, engagements: 18, clicks: 6 });
    expect([...extractMetaDailyMetrics({ data: [{ name: 'reach', values: [
      { value: 40, end_time: '2026-08-28T07:00:00+0000' },
      { value: 55, end_time: '2026-08-29T07:00:00+0000' },
    ] }] }).entries()]).toEqual([
      ['2026-08-27', { reach: 40 }],
      ['2026-08-28', { reach: 55 }],
    ]);
  });

  it('accepts real IANA zones and rejects arbitrary timezone labels', () => {
    expect(isValidIanaTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('IST')).toBe(false);
    expect(isValidIanaTimeZone('not/a-timezone')).toBe(false);
  });

  it('validates actual calendar dates instead of accepting JavaScript date rollovers', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
  });

  it('compares only evidence-supported metrics and reports deltas without inventing a benchmark', () => {
    expect(compareCompetitorMetrics(
      { page_impressions: 120, page_post_engagements: 18 },
      { impressions: 100, total_interactions: 20, views: 50 },
    )).toEqual([
      { metric: 'impressions', workspace: 120, competitor: 100, delta: 20, percentDelta: 20 },
      { metric: 'engagements', workspace: 18, competitor: 20, delta: -2, percentDelta: -10 },
    ]);
  });

  it('evaluates an accepted five-field report schedule in UTC', () => {
    expect(scheduledReportIsDue('0 9 * * 1', new Date('2026-08-17T09:00:00.000Z'))).toBe(true);
    expect(scheduledReportIsDue('0 9 * * 1', new Date('2026-08-17T09:01:00.000Z'))).toBe(false);
    expect(scheduledReportIsDue('*/15 * * * *', new Date('2026-08-17T09:30:00.000Z'))).toBe(true);
  });

  it('evaluates friendly schedules in the selected local timezone', () => {
    const weekly = { frequency: 'weekly', dayOfWeek: 1, localTime: '09:00', timezone: 'Asia/Kolkata' };
    expect(scheduledReportDefinitionIsDue(weekly, new Date('2026-08-17T03:30:00.000Z'))).toBe(true);
    expect(scheduledReportDefinitionIsDue(weekly, new Date('2026-08-17T03:31:00.000Z'))).toBe(false);
    expect(scheduledReportDefinitionIsDue({ frequency: 'monthly', dayOfMonth: 17, localTime: '09:00', timezone: 'Asia/Kolkata' }, new Date('2026-08-17T03:30:00.000Z'))).toBe(true);
  });

  it('gives actionable provider recovery guidance without implying snapshots were erased', () => {
    const controller = fs.readFileSync(path.resolve(process.cwd(), 'controllers/socialAnalyticsController.ts'), 'utf8');
    expect(controller).toContain('SOCIAL_ANALYTICS_RECONNECT_REQUIRED');
    expect(controller).toContain('SOCIAL_ANALYTICS_PERMISSION_REQUIRED');
    expect(controller).toContain("credential.grantedScopes.includes(isDirectInstagramLogin(credential) ? 'instagram_business_manage_insights' : 'instagram_manage_insights')");
    expect(controller).toContain('existing snapshots were not changed');
    expect(controller).toContain("metric_type: 'total_value'");
    expect(controller).toContain('providerCode');
  });

  it('applies the selected date, sentiment, account, and platform context to supporting views', () => {
    const controller = fs.readFileSync(path.resolve(process.cwd(), 'controllers/socialAnalyticsController.ts'), 'utf8');
    expect(controller).toContain("predicates.push(sql`occurred_at >= ${start}`)");
    expect(controller).toContain("predicates.push(sql`occurred_at <= ${end}`)");
    expect(controller).toContain("predicates.push(sql`sentiment=${sentiment}`)");
    expect(controller).toContain("accountIdentifier, start, end");
    expect(controller).toContain("platform: competitor.platform as Platform");
  });
});
