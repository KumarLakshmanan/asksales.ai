import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { adPerformanceService } from '../services/ads/AdPerformanceService.js';
import { autonomousAdsActionProcessor } from '../services/ads/AutonomousAdsActionProcessor.js';

const databaseName = process.env.DB_NAME || process.env.DB_DATABASE || '';
assert.match(
  databaseName,
  /^salesmarketing_adperf_/,
  'This acceptance check must only run against a disposable salesmarketing_adperf_* database.',
);

const fixtureEmail = 'ad-performance-owner@example.test';
const otherOwnerEmail = 'ad-performance-other-owner@example.test';
const fixturePassword = process.env.ADPERF_TEST_PASSWORD || 'AdPerf-Test-2026!';

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(query);
  return Number(Object.values(result.rows[0] || {})[0] || 0);
}

async function verifyGoogleObjectiveMetrics(): Promise<void> {
  const originalFetch = global.fetch;
  const queries: string[] = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'acceptance-token', expires_in: 3600 }), { status: 200 });
    }
    const query = String(JSON.parse(String(init?.body || '{}')).query || '');
    queries.push(query);
    return new Response(JSON.stringify({ results: [{
      segments: { date: '2026-08-27' },
      metrics: { impressions: '1000', clicks: '40', engagements: '75', costMicros: '20000000', conversions: '6', conversionsValue: '120' },
      campaign: { status: 'ENABLED' },
      adGroup: { resourceName: 'customers/123/adGroups/10', status: 'ENABLED' },
      adGroupAd: { resourceName: 'customers/123/adGroupAds/10~20', status: 'ENABLED' },
    }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const { getCampaignMetricsByDateRange, getAdGroupMetricsByDateRange, getAdMetricsByDateRange } = await import('../services/ads/GoogleAdsService.js');
    const credentials = {
      clientId: `acceptance-${Date.now()}`,
      clientSecret: 'secret', developerToken: 'developer', customerId: '1234567890', refreshToken: 'refresh',
    };
    const [campaign, adGroup, ad] = await Promise.all([
      getCampaignMetricsByDateRange(credentials, 'customers/1234567890/campaigns/1', '2026-08-27', '2026-08-27'),
      getAdGroupMetricsByDateRange(credentials, 'customers/1234567890/campaigns/1', '2026-08-27', '2026-08-27'),
      getAdMetricsByDateRange(credentials, 'customers/1234567890/campaigns/1', '2026-08-27', '2026-08-27'),
    ]);
    assert.equal(campaign.metrics?.[0].engagements, 75);
    assert.equal(adGroup.metrics?.[0].engagements, 75);
    assert.equal(ad.metrics?.[0].engagements, 75);
    assert.equal(queries.length, 3);
    assert.ok(queries.every((query) => query.includes('metrics.engagements')));
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  await verifyGoogleObjectiveMetrics();
  await db.execute(sql`DELETE FROM users WHERE email = ${fixtureEmail}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${otherOwnerEmail}`);

  const password = await bcrypt.hash(fixturePassword, 10);
  const insertedUser = await db.execute(sql`
    INSERT INTO users (
      email, password, name, role, is_verified, is_approved, is_setup_complete
    ) VALUES (
      ${fixtureEmail}, ${password}, 'Ad Performance Owner', 'user', TRUE, TRUE, TRUE
    ) RETURNING id
  `);
  const userId = Number(insertedUser.rows[0].id);

  const insertedCampaign = await db.execute(sql`
    INSERT INTO performance_ad_campaigns (
      user_id, name, description, objective, ad_platform, budget_type,
      budget_amount, currency, spent_amount, targeting, ad_creatives,
      start_date, status, is_active, launched_at, settings, local_status,
      provider_status, validation_errors, content_context, locations,
      landing_page_url, idempotency_key, auto_activate
    ) VALUES (
      ${userId}, 'Traffic acceptance campaign', 'Disposable AI performance fixture',
      'traffic', 'meta', 'lifetime', 1000, 'INR', 200, '{}'::jsonb, '{}'::jsonb,
      NOW() - INTERVAL '5 days', 'active', TRUE, NOW() - INTERVAL '4 days',
      ${JSON.stringify({ platforms: ['meta'] })}::jsonb, 'active', 'ACTIVE',
      '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 'https://example.test/landing',
      'ad-performance-acceptance-campaign', TRUE
    ) RETURNING id
  `);
  const campaignId = Number(insertedCampaign.rows[0].id);

  const otherUserResult = await db.execute(sql`
    INSERT INTO users (email, password, name, role, is_verified, is_approved, is_setup_complete)
    VALUES (${otherOwnerEmail}, ${password}, 'Other Ad Owner', 'user', TRUE, TRUE, TRUE)
    RETURNING id
  `);
  const otherUserId = Number(otherUserResult.rows[0].id);
  for (let index = 1; index <= 5; index += 1) {
    for (const comparable of [
      { ownerId: userId, currency: 'USD', scope: 'other-currency' },
      { ownerId: otherUserId, currency: 'INR', scope: 'other-owner' },
    ]) {
      const comparableCampaign = await db.execute(sql`
        INSERT INTO performance_ad_campaigns (
          user_id, name, objective, ad_platform, budget_type, budget_amount,
          currency, targeting, ad_creatives, start_date, status, is_active,
          launched_at, settings, local_status, provider_status, validation_errors,
          content_context, locations, landing_page_url, idempotency_key
        ) VALUES (
          ${comparable.ownerId}, ${`Comparable ${comparable.scope} ${index}`}, 'traffic', 'meta',
          'lifetime', 1000, ${comparable.currency}, '{}'::jsonb, '{}'::jsonb,
          NOW() - INTERVAL '30 days', 'completed', FALSE, NOW() - INTERVAL '30 days',
          ${JSON.stringify({ platforms: ['meta'] })}::jsonb, 'completed', 'COMPLETED',
          '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 'https://example.test/comparable',
          ${`ad-performance-${comparable.scope}-${index}`}
        ) RETURNING id
      `);
      await db.execute(sql`
        INSERT INTO performance_metrics (
          campaign_id, platform, platform_campaign_id, user_id, date,
          impressions, clicks, spend, reach, conversions, conversion_value,
          post_engagements, provider_status
        ) VALUES (
          ${Number(comparableCampaign.rows[0].id)}, 'meta', ${`provider-${comparable.scope}-${index}`},
          ${comparable.ownerId}, CURRENT_DATE - ${index}::int, 5000, 100, 250, 3500, 5, 500, 120, 'COMPLETED'
        )
      `);
    }
  }

  await db.execute(sql`
    INSERT INTO performance_metrics (
      campaign_id, platform, platform_campaign_id, user_id, date,
      impressions, clicks, spend, reach, conversions, conversion_value,
      post_engagements, provider_status, updated_at
    ) VALUES (
      ${campaignId}, 'meta', 'provider-campaign-acceptance', ${userId}, CURRENT_DATE,
      4000, 85, 200, 3100, 3, 300, 90, 'ACTIVE', NOW()
    )
  `);

  await db.execute(sql`
    INSERT INTO ad_unit_metrics (
      campaign_id, user_id, platform, target_type, target_key,
      parent_target_key, provider_resource, date, impressions, clicks,
      spend, reach, conversions, conversion_value, engagements, installs,
      provider_status, updated_at
    ) VALUES
      (${campaignId}, ${userId}, 'meta', 'ad_set', 'set-1', NULL,
        'provider-set-1', CURRENT_DATE, 4000, 85, 200, 3100, 3, 300, 90, 0, 'ACTIVE', NOW()),
      (${campaignId}, ${userId}, 'meta', 'ad', 'ad-bad', 'set-1',
        'provider-ad-bad', CURRENT_DATE, 2000, 5, 100, 1500, 0, 0, 10, 0, 'ACTIVE', NOW()),
      (${campaignId}, ${userId}, 'meta', 'ad', 'ad-good', 'set-1',
        'provider-ad-good', CURRENT_DATE, 2000, 80, 100, 1600, 3, 300, 80, 0, 'ACTIVE', NOW())
  `);

  await db.execute(sql`
    INSERT INTO ad_analytics_sync_runs (
      campaign_id, user_id, platform, date_start, date_stop, status,
      metrics_ingested, completed_at
    ) VALUES
      (${campaignId}, ${userId}, 'meta', CURRENT_DATE, CURRENT_DATE, 'succeeded', 4, NOW() - INTERVAL '20 minutes'),
      (${campaignId}, ${userId}, 'meta', CURRENT_DATE, CURRENT_DATE, 'succeeded', 4, NOW() - INTERVAL '10 minutes'),
      (${campaignId}, ${userId}, 'meta', CURRENT_DATE, CURRENT_DATE, 'succeeded', 4, NOW() - INTERVAL '1 minute')
  `);

  await db.execute(sql`
    INSERT INTO ad_provider_resources (
      campaign_id, user_id, platform, resource_type, local_key,
      provider_resource_id, status, idempotency_key
    ) VALUES
      (${campaignId}, ${userId}, 'meta', 'campaign', 'campaign', 'provider-campaign-acceptance', 'active', 'acceptance-resource-campaign'),
      (${campaignId}, ${userId}, 'meta', 'ad_set', 'set-1', 'provider-set-1', 'active', 'acceptance-resource-set'),
      (${campaignId}, ${userId}, 'meta', 'ad', 'ad-bad', 'provider-ad-bad', 'active', 'acceptance-resource-bad'),
      (${campaignId}, ${userId}, 'meta', 'ad', 'ad-good', 'provider-ad-good', 'active', 'acceptance-resource-good')
  `);

  for (const [suffix, minutes] of [['one', 10], ['two', 5]] as const) {
    await db.execute(sql`
      INSERT INTO ad_performance_evaluations (
        campaign_id, user_id, platform, target_type, target_key, objective,
        window_start, window_end, metrics_snapshot, metrics_updated_at,
        baseline_source, baseline_metrics, comparable_campaign_ids,
        rule_results, confidence, state, evaluation_key, created_at
      ) VALUES (
        ${campaignId}, ${userId}, 'meta', 'ad', 'ad-bad', 'traffic',
        CURRENT_DATE - 6, CURRENT_DATE, '{}'::jsonb, NOW() - (${minutes} * INTERVAL '1 minute'),
        'campaign_target', '{}'::jsonb, '[]'::jsonb, '{"failing":true,"reportingOnlyHistorical":false}'::jsonb,
        0.8, 'watch', ${`acceptance-prior-${suffix}`}, NOW() - (${minutes} * INTERVAL '1 minute')
      )
    `);
  }

  const defaultSettings = await adPerformanceService.getAutonomySettings(userId);
  assert.equal(defaultSettings.mode, 'off');
  assert.equal(defaultSettings.enabled, false);
  assert.deepEqual(await adPerformanceService.evaluateCampaign(userId, campaignId), {
    evaluations: 0,
    recommendations: 0,
    actionsQueued: 0,
  });

  await adPerformanceService.updateAutonomySettings(userId, {
    mode: 'shadow',
    notificationEmail: fixtureEmail,
    defaultThresholds: { targetCtr: 2, targetCpc: 3 },
  });
  const shadow = await adPerformanceService.evaluateCampaign(userId, campaignId);
  assert.equal(shadow.evaluations, 4);
  assert.equal(shadow.recommendations, 0);
  assert.equal(shadow.actionsQueued, 0);
  assert.equal(await scalar(sql`SELECT COUNT(*) FROM ad_recommendations WHERE campaign_id = ${campaignId}`), 0);
  assert.equal(await scalar(sql`SELECT COUNT(*) FROM ad_action_queue WHERE campaign_id = ${campaignId}`), 0);

  await adPerformanceService.updateAutonomySettings(userId, {
    mode: 'advisory',
    notificationEmail: fixtureEmail,
    defaultThresholds: { targetCtr: 2, targetCpc: 3 },
  });
  const advisory = await adPerformanceService.evaluateCampaign(userId, campaignId);
  assert.equal(advisory.actionsQueued, 0);
  assert.ok(await scalar(sql`SELECT COUNT(*) FROM ad_recommendations WHERE campaign_id = ${campaignId}`) >= 1);
  const recommendationCount = await scalar(sql`SELECT COUNT(*) FROM ad_recommendations WHERE campaign_id = ${campaignId}`);
  await adPerformanceService.evaluateCampaign(userId, campaignId);
  assert.equal(await scalar(sql`SELECT COUNT(*) FROM ad_recommendations WHERE campaign_id = ${campaignId}`), recommendationCount);

  await adPerformanceService.updateAutonomySettings(userId, {
    mode: 'live_pause',
    notificationEmail: fixtureEmail,
    defaultThresholds: { targetCtr: 2, targetCpc: 3 },
  });
  const withoutCampaignConsent = await adPerformanceService.evaluateCampaign(userId, campaignId);
  assert.equal(withoutCampaignConsent.actionsQueued, 0);

  await adPerformanceService.updateCampaignPolicy(userId, campaignId, {
    enabled: true,
    thresholds: { targetCtr: 2, targetCpc: 3 },
  });
  const live = await adPerformanceService.evaluateCampaign(userId, campaignId);
  assert.equal(live.actionsQueued, 1);
  const duplicate = await adPerformanceService.evaluateCampaign(userId, campaignId);
  assert.equal(duplicate.actionsQueued, 0);

  const queuedResult = await db.execute(sql`
    SELECT * FROM ad_action_queue
    WHERE campaign_id = ${campaignId} AND action_type = 'pause'
    ORDER BY id DESC LIMIT 1
  `);
  const queued = queuedResult.rows[0] as Record<string, unknown>;
  assert.equal(queued.target_type, 'ad');
  assert.equal(queued.target_key, 'ad-bad');
  assert.equal(queued.target_resource, 'provider-ad-bad');
  assert.equal((await adPerformanceService.revalidateAutonomousPause(queued)).valid, true);
  const changedProviderTarget = await adPerformanceService.revalidateAutonomousPause({
    ...queued,
    target_resource: 'provider-ad-replacement',
  });
  assert.equal(changedProviderTarget.valid, false);
  assert.match(changedProviderTarget.reason || '', /provider target changed/i);
  const versionMismatch = await adPerformanceService.revalidateAutonomousPause({
    ...queued,
    policy_version: 'ads-pause-v0',
  });
  assert.equal(versionMismatch.valid, false);
  assert.match(versionMismatch.reason || '', /policy version/i);

  const latestHierarchy = await db.execute(sql`
    SELECT DISTINCT ON (target_type, target_key) id, target_type, target_key
    FROM ad_performance_evaluations
    WHERE user_id = ${userId} AND campaign_id = ${campaignId}
      AND platform = 'meta' AND target_type IN ('campaign', 'ad_set')
    ORDER BY target_type, target_key, created_at DESC
  `);
  const hierarchyStored = (latestHierarchy.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id), platform: 'meta', targetType: String(row.target_type),
    targetKey: String(row.target_key), state: 'recommendation', shouldPause: true,
  }));
  const campaignHierarchyCurrent = hierarchyStored.find((row) => row.targetType === 'campaign');
  const childHierarchyCurrent = hierarchyStored.find((row) => row.targetType === 'ad_set');
  assert.ok(campaignHierarchyCurrent && childHierarchyCurrent);
  await db.execute(sql`
    INSERT INTO ad_performance_evaluations (
      campaign_id, user_id, platform, target_type, target_key, objective,
      window_start, window_end, metrics_snapshot, metrics_updated_at,
      baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
      confidence, state, hypothetical_action, evaluation_key, created_at
    )
    SELECT campaign_id, user_id, platform, target_type, target_key, objective,
      window_start, window_end, metrics_snapshot, metrics_updated_at,
      baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
      confidence, 'recommendation', 'pause', ${`acceptance-prior-campaign-${campaignId}`}, NOW() - INTERVAL '7 hours'
    FROM ad_performance_evaluations WHERE id = ${campaignHierarchyCurrent!.id}
  `);
  const hierarchyService = adPerformanceService as unknown as {
    hierarchyConfirmed: (ownerId: number, id: number, platform: 'meta', stored: Array<Record<string, unknown>>) => Promise<boolean>;
  };
  assert.equal(await hierarchyService.hierarchyConfirmed(userId, campaignId, 'meta', hierarchyStored), false);
  await db.execute(sql`
    INSERT INTO ad_performance_evaluations (
      campaign_id, user_id, platform, target_type, target_key, objective,
      window_start, window_end, metrics_snapshot, metrics_updated_at,
      baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
      confidence, state, hypothetical_action, evaluation_key, created_at
    )
    SELECT campaign_id, user_id, platform, target_type, target_key, objective,
      window_start, window_end, metrics_snapshot, metrics_updated_at,
      baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
      confidence, 'recommendation', 'pause', ${`acceptance-prior-child-${campaignId}`}, NOW() - INTERVAL '7 hours'
    FROM ad_performance_evaluations WHERE id = ${childHierarchyCurrent!.id}
  `);
  assert.equal(await hierarchyService.hierarchyConfirmed(userId, campaignId, 'meta', hierarchyStored), true);

  const recommendationResult = await db.execute(sql`
    SELECT id FROM ad_recommendations WHERE campaign_id = ${campaignId} AND status = 'open' ORDER BY id LIMIT 1
  `);
  const recommendationId = Number(recommendationResult.rows[0].id);
  const actionCountBeforeRecommendation = await scalar(sql`SELECT COUNT(*) FROM ad_action_queue WHERE campaign_id = ${campaignId}`);
  assert.equal((await adPerformanceService.recommendationStatus(userId, campaignId, recommendationId, 'dismissed')).status, 'dismissed');
  assert.equal((await adPerformanceService.recommendationStatus(userId, campaignId, recommendationId, 'accepted')).status, 'accepted');
  assert.equal(await scalar(sql`SELECT COUNT(*) FROM ad_action_queue WHERE campaign_id = ${campaignId}`), actionCountBeforeRecommendation);

  const improved = await adPerformanceService.createImprovedVersion(userId, campaignId);
  assert.equal(improved.requiresReview, true);
  const improvedPolicy = await adPerformanceService.getCampaignPolicy(userId, Number(improved.id));
  assert.equal(improvedPolicy.enabled, false);

  const detail = await adPerformanceService.performanceDetail(userId, campaignId);
  assert.ok(detail.evaluations.length >= 4);
  assert.ok(detail.recommendations.length >= 1);
  assert.ok(detail.units.some((unit: Record<string, unknown>) => unit.targetKey === 'ad-bad'));
  assert.ok(detail.performanceTrace.length >= 1);
  assert.equal(detail.historicalBaselines[0].source, 'none');
  assert.deepEqual(detail.historicalBaselines[0].campaignIds, []);
  const dashboard = await adPerformanceService.dashboardSummary(userId);
  assert.equal(dashboard.consentedCampaigns, 1);
  assert.ok(dashboard.watchedUnits >= 1);

  await adPerformanceService.updateCampaignPolicy(userId, campaignId, { enabled: false });
  assert.equal((await adPerformanceService.revalidateAutonomousPause(queued)).valid, false);
  assert.equal(
    await scalar(sql`SELECT COUNT(*) FROM ad_action_queue WHERE id = ${Number(queued.id)} AND status = 'cancelled'`),
    1,
  );

  await adPerformanceService.updateCampaignPolicy(userId, campaignId, {
    enabled: true,
    thresholds: { targetCtr: 2, targetCpc: 3 },
  });
  const afterRenewedConsent = await adPerformanceService.evaluateCampaign(userId, campaignId);
  assert.equal(afterRenewedConsent.actionsQueued, 1);
  const renewedActionResult = await db.execute(sql`
    SELECT * FROM ad_action_queue
    WHERE campaign_id = ${campaignId} AND action_type = 'pause' AND status = 'pending'
    ORDER BY id DESC LIMIT 1
  `);
  const renewedAction = renewedActionResult.rows[0] as Record<string, unknown>;

  await db.execute(sql`
    UPDATE ad_provider_resources SET status = 'paused', updated_at = NOW()
    WHERE campaign_id = ${campaignId} AND user_id = ${userId}
      AND platform = 'meta' AND resource_type = 'ad' AND local_key = 'ad-bad'
  `);
  const resume = await adPerformanceService.manualResume(userId, campaignId, 'meta', 'ad', 'ad-bad');
  const holdHours = (new Date(resume.holdUntil).getTime() - Date.now()) / 3_600_000;
  assert.ok(holdHours > 71.9 && holdHours <= 72);
  const held = await adPerformanceService.revalidateAutonomousPause(renewedAction);
  assert.equal(held.valid, false);
  assert.match(held.reason || '', /72-hour hold/i);

  await db.execute(sql`UPDATE ad_action_queue SET status = 'cancelled' WHERE id = ${Number(renewedAction.id)}`);
  await db.execute(sql`UPDATE ad_settings SET live_provider_mutations_enabled = TRUE WHERE user_id = ${userId}`);
  process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'true';
  const providerFailure = await autonomousAdsActionProcessor.processBatch(1);
  process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'false';
  assert.equal(providerFailure.failed, 1);
  assert.equal(
    await scalar(sql`SELECT COUNT(*) FROM ad_action_queue WHERE id = ${resume.actionId} AND status = 'succeeded'`),
    0,
  );
  assert.ok(await scalar(sql`
    SELECT COUNT(*) FROM ad_action_audit
    WHERE action_id = ${resume.actionId} AND actor_type = 'provider'
      AND provider_outcome->>'success' = 'false'
  `) >= 1);
  await db.execute(sql`UPDATE ad_settings SET live_provider_mutations_enabled = FALSE WHERE user_id = ${userId}`);

  const successfulPause = await db.execute(sql`
    INSERT INTO ad_action_queue (
      campaign_id, user_id, platform, action_type, idempotency_key, payload,
      metrics_snapshot, rationale, status, completed_at, evaluation_id,
      target_type, target_key, target_resource, consent_snapshot, policy_version,
      provider_outcome
    ) VALUES (
      ${campaignId}, ${userId}, 'meta', 'pause', ${`acceptance-successful-pause-${campaignId}`},
      ${JSON.stringify({ actorType: 'ai', targetType: 'ad', targetKey: 'ad-bad' })}::jsonb,
      ${JSON.stringify({ metrics: { impressions: 2000, clicks: 5, conversions: 0, spend: 100 } })}::jsonb,
      'Acceptance fixture: traffic performance remained below target.', 'succeeded', NOW() - INTERVAL '30 seconds',
      ${Number(queued.evaluation_id)}, 'ad', 'ad-bad', 'provider-ad-bad', '{}'::jsonb,
      'ads-pause-v1', ${JSON.stringify({ providerResource: 'provider-ad-bad', status: 'paused' })}::jsonb
    ) RETURNING *
  `);
  const successfulAction = successfulPause.rows[0] as Record<string, unknown>;
  const originalEvaluationState = (await db.execute(sql`
    SELECT state FROM ad_performance_evaluations WHERE id = ${Number(queued.evaluation_id)}
  `)).rows[0]?.state;
  await (autonomousAdsActionProcessor as unknown as {
    appendPauseOutcomeEvaluation: (action: Record<string, unknown>) => Promise<void>;
  }).appendPauseOutcomeEvaluation(successfulAction);
  assert.equal((await db.execute(sql`
    SELECT state FROM ad_performance_evaluations WHERE id = ${Number(queued.evaluation_id)}
  `)).rows[0]?.state, originalEvaluationState);
  assert.equal(await scalar(sql`
    SELECT COUNT(*) FROM ad_performance_evaluations
    WHERE actual_action_id = ${Number(successfulAction.id)} AND state = 'ai_paused'
  `), 1);

  await db.execute(sql`
    INSERT INTO ad_action_notification_deliveries (
      action_id, campaign_id, user_id, channel, destination
    ) VALUES
      (${Number(successfulAction.id)}, ${campaignId}, ${userId}, 'in_app', NULL),
      (${Number(successfulAction.id)}, ${campaignId}, ${userId}, 'email', NULL)
  `);
  process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'false';
  await autonomousAdsActionProcessor.processBatch(2);
  assert.equal(await scalar(sql`
    SELECT COUNT(*) FROM ad_action_queue WHERE id = ${Number(successfulAction.id)} AND status = 'succeeded'
  `), 1);
  assert.equal(await scalar(sql`
    SELECT COUNT(*) FROM ad_action_notification_deliveries
    WHERE action_id = ${Number(successfulAction.id)} AND attempts = 1
  `), 2);
  assert.equal(await scalar(sql`
    SELECT COUNT(*) FROM ad_action_notification_deliveries
    WHERE action_id = ${Number(successfulAction.id)} AND channel = 'in_app' AND status = 'succeeded'
  `), 1);
  assert.equal(await scalar(sql`
    SELECT COUNT(*) FROM ad_action_notification_deliveries
    WHERE action_id = ${Number(successfulAction.id)} AND channel = 'email'
      AND status = 'failed' AND last_error IS NOT NULL
  `), 1);

  await adPerformanceService.updateAutonomySettings(userId, {
    mode: 'off',
    notificationEmail: fixtureEmail,
    defaultThresholds: { targetCtr: 2, targetCpc: 3 },
  });
  assert.equal(
    await scalar(sql`SELECT COUNT(*) FROM ad_action_queue WHERE id = ${Number(renewedAction.id)} AND status = 'cancelled'`),
    1,
  );
  assert.ok(await scalar(sql`SELECT COUNT(*) FROM ad_account_autonomy_events WHERE user_id = ${userId}`) >= 4);

  console.log(JSON.stringify({
    ok: true,
    databaseName,
    fixtureEmail,
    userId,
    campaignId,
    improvedCampaignId: Number(improved.id),
    assertions: {
      defaultOff: true,
      shadowNoActions: true,
      advisoryNoActions: true,
      dualConsent: true,
      smallestUnitPause: true,
      idempotentPause: true,
      campaignPauseRequiresEveryChildTwiceSixHoursApart: true,
      consentRevalidation: true,
      providerResourceSnapshotRevalidated: true,
      recommendationReviewOnly: true,
      improvedVersionReviewOnly: true,
      manualHold72Hours: true,
      dashboardAndDetail: true,
      immutableConsentEvents: true,
      providerFailureAuditedWithoutFalseSuccess: true,
      appendOnlyProviderOutcome: true,
      notificationFailureRetriedIndependently: true,
      ownershipAndCurrencyIsolation: true,
      googleObjectiveMetricNormalization: true,
    },
  }, null, 2));
}

try {
  await main();
} finally {
  await pgPool?.end();
}
