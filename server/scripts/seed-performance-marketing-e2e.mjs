import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(scriptDirectory, '..', '.env.development') });
dotenv.config({ path: path.resolve(scriptDirectory, '..', '.env'), override: true });

const connectionString = process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || process.env.DB_DATABASE || 'salesmarketing'}`;
const pool = new pg.Pool({ connectionString });
const client = await pool.connect();

const email = 'performance-marketing-e2e@example.test';
const password = 'Performance-E2E-2026!';
const accountIdentifier = 'growth-lab-e2e';
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const isoDate = (offset) => {
  const date = new Date(today);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

try {
  await client.query('BEGIN');
  const passwordHash = await bcrypt.hash(password, 10);
  const userResult = await client.query(`
    INSERT INTO users (email, password, name, role, is_verified, is_setup_complete, is_approved, timezone)
    VALUES ($1, $2, 'Performance Marketing QA', 'user', TRUE, TRUE, TRUE, 'Asia/Kolkata')
    ON CONFLICT (email) DO UPDATE SET
      password = EXCLUDED.password, is_verified = TRUE, is_setup_complete = TRUE,
      is_approved = TRUE, timezone = EXCLUDED.timezone, locked_until = NULL,
      failed_login_attempts = 0, updated_at = NOW()
    RETURNING id
  `, [email, passwordHash]);
  const userId = Number(userResult.rows[0].id);

  await client.query(`
    INSERT INTO company_settings (user_id, name, profile_type, company_name, industry, description, is_default, is_approved)
    VALUES ($1, 'Growth Lab QA', 'Organization', 'Growth Lab QA', 'Software', 'Synthetic browser acceptance fixture.', TRUE, TRUE)
    ON CONFLICT DO NOTHING
  `, [userId]);
  await client.query(`
    INSERT INTO brand_toolkits (user_id, name, description, primary_brand_color, accent_color, is_default, is_active, is_approved)
    VALUES ($1, 'Growth Lab QA', 'Synthetic browser acceptance fixture.', '#2563EB', '#7C3AED', TRUE, TRUE, TRUE)
    ON CONFLICT DO NOTHING
  `, [userId]);
  await client.query(`
    INSERT INTO channel_credentials (
      user_id, platform, credential_type, account_identifier, account_name,
      is_active, is_selected, granted_scopes, provider_approval_status, provider_api_version
    )
    SELECT $1, 'instagram_api', 'oauth', $2::varchar, 'Growth Lab Instagram', TRUE, TRUE,
      '[]'::jsonb, 'not_required', 'v23.0'
    WHERE NOT EXISTS (
      SELECT 1 FROM channel_credentials WHERE user_id = $1 AND platform = 'instagram_api' AND account_identifier = $2::varchar
    )
  `, [userId, accountIdentifier]);

  await client.query(`
    INSERT INTO ad_settings (
      user_id, default_lifetime_budget, currency, locations,
      autonomous_optimization_enabled, live_provider_mutations_enabled,
      analytics_sync_minutes, autonomy_mode, notification_email
    ) VALUES ($1, 30000, 'INR', '["India"]'::jsonb, FALSE, FALSE, 15, 'advisory', $2)
    ON CONFLICT (user_id) DO UPDATE SET
      currency = EXCLUDED.currency, autonomy_mode = 'advisory',
      autonomous_optimization_enabled = FALSE, live_provider_mutations_enabled = FALSE,
      notification_email = EXCLUDED.notification_email, updated_at = NOW()
  `, [userId, email]);

  const campaignFixtures = [
    { key: 'pm-e2e-meta-traffic', name: 'Meta Summer Traffic', objective: 'traffic', platform: 'meta', status: 'active', provider: 'ACTIVE', budget: 18000 },
    { key: 'pm-e2e-google-leads', name: 'Google Demo Leads', objective: 'leads', platform: 'google', status: 'active', provider: 'ENABLED', budget: 24000 },
    { key: 'pm-e2e-meta-sales', name: 'Meta Retargeting Sales', objective: 'sales', platform: 'meta', status: 'paused', provider: 'PAUSED', budget: 12000 },
  ];
  const campaignIds = new Map();
  for (const campaign of campaignFixtures) {
    const campaignResult = await client.query(`
      INSERT INTO performance_ad_campaigns (
        user_id, name, description, objective, objective_source, ad_platform,
        platform_campaign_id, budget_type, budget_amount, currency, spent_amount,
        targeting, locations, start_date, end_date, status, local_status,
        provider_status, is_active, settings, idempotency_key, last_synced_at
      ) VALUES (
        $1, $2, 'Synthetic Chrome acceptance campaign.', $3, 'user', $4,
        $5, 'lifetime', $6, 'INR', 0, '{"audience":"business_marketers"}'::jsonb,
        '["India"]'::jsonb, NOW() - INTERVAL '14 days', NOW() + INTERVAL '30 days',
        $7, $7, $8, $9, '{"e2eFixture":true}'::jsonb, $10, NOW()
      ) ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
        name = EXCLUDED.name, objective = EXCLUDED.objective, ad_platform = EXCLUDED.ad_platform,
        status = EXCLUDED.status, local_status = EXCLUDED.local_status,
        provider_status = EXCLUDED.provider_status, updated_at = NOW(), last_synced_at = NOW()
      RETURNING id
    `, [userId, campaign.name, campaign.objective, campaign.platform, `e2e-${campaign.key}`, campaign.budget, campaign.status, campaign.provider, campaign.status === 'active', campaign.key]);
    campaignIds.set(campaign.key, Number(campaignResult.rows[0].id));
  }

  const metricProfiles = {
    'pm-e2e-meta-traffic': { impressions: 54000, clicks: 1890, spend: 7650, reach: 41000, conversions: 120, value: 0, engagements: 2600, leads: 0 },
    'pm-e2e-google-leads': { impressions: 32000, clicks: 1120, spend: 9800, reach: 28500, conversions: 56, value: 0, engagements: 730, leads: 56 },
    'pm-e2e-meta-sales': { impressions: 18000, clicks: 260, spend: 5200, reach: 15000, conversions: 8, value: 11800, engagements: 410, leads: 0 },
  };
  for (const campaign of campaignFixtures) {
    const campaignId = campaignIds.get(campaign.key);
    const totals = metricProfiles[campaign.key];
    for (let day = -13; day <= 0; day += 1) {
      const factor = day + 14;
      const impressions = Math.round(totals.impressions / 14 + factor * 7);
      const clicks = Math.round(totals.clicks / 14 + factor);
      const spend = Number((totals.spend / 14 + factor * 4).toFixed(2));
      const conversions = Math.round(totals.conversions / 14);
      await client.query(`
        INSERT INTO performance_metrics (
          campaign_id, platform, platform_campaign_id, user_id, date, hour,
          impressions, clicks, spend, reach, conversions, conversion_value,
          post_engagements, leads, ctr, cpc, cpm, cpa, roas,
          source_scope, sync_status, provider_status, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, NULL, $6::integer, $7::integer, $8::numeric, $9::integer, $10::integer, $11::numeric, $12::integer, $13::integer,
          CASE WHEN $6::integer > 0 THEN ($7::numeric / $6::numeric) * 100 ELSE 0 END,
          CASE WHEN $7::integer > 0 THEN $8::numeric / $7::numeric ELSE 0 END,
          CASE WHEN $6::integer > 0 THEN ($8::numeric / $6::numeric) * 1000 ELSE 0 END,
          CASE WHEN $10::integer > 0 THEN $8::numeric / $10::numeric ELSE 0 END,
          CASE WHEN $8::numeric > 0 THEN $11::numeric / $8::numeric ELSE 0 END,
          'managed', 'succeeded', $14, NOW()
        ) ON CONFLICT (campaign_id, platform, date) WHERE hour IS NULL DO UPDATE SET
          impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, spend = EXCLUDED.spend,
          reach = EXCLUDED.reach, conversions = EXCLUDED.conversions,
          conversion_value = EXCLUDED.conversion_value, post_engagements = EXCLUDED.post_engagements,
          leads = EXCLUDED.leads, ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc,
          cpm = EXCLUDED.cpm, cpa = EXCLUDED.cpa, roas = EXCLUDED.roas,
          sync_status = 'succeeded', provider_status = EXCLUDED.provider_status, updated_at = NOW()
      `, [campaignId, campaign.platform, `e2e-${campaign.key}`, userId, isoDate(day), impressions, clicks, spend, Math.round(totals.reach / 14), conversions, Number((totals.value / 14).toFixed(2)), Math.round(totals.engagements / 14), Math.round(totals.leads / 14), campaign.provider]);
    }
    for (let sync = 0; sync < 3; sync += 1) {
      await client.query(`
        INSERT INTO ad_analytics_sync_runs (campaign_id, user_id, platform, date_start, date_stop, status, metrics_ingested, completed_at)
        SELECT $1, $2, $3::varchar, $4::date, $5::date, 'succeeded', 14, NOW() - ($6::integer * INTERVAL '15 minutes')
        WHERE (
          SELECT COUNT(*) FROM ad_analytics_sync_runs WHERE campaign_id = $1 AND user_id = $2 AND platform = $3::varchar AND status = 'succeeded' AND completed_at > NOW() - INTERVAL '2 hours'
        ) < 3
      `, [campaignId, userId, campaign.platform, isoDate(-13), isoDate(0), sync]);
    }
  }

  const decisionFixtures = [
    { key: 'pm-e2e-meta-traffic', state: 'healthy', confidence: 0.91, baseline: { targetCtr: 2.5 }, rules: { targetCtr: 2.5 } },
    { key: 'pm-e2e-google-leads', state: 'recommendation', confidence: 0.86, baseline: { targetCpa: 120 }, rules: { targetCpa: 120 } },
    { key: 'pm-e2e-meta-sales', state: 'manual_hold', confidence: 0.78, baseline: { targetRoas: 3 }, rules: { targetRoas: 3 } },
  ];
  for (const decision of decisionFixtures) {
    const campaign = campaignFixtures.find((item) => item.key === decision.key);
    const campaignId = campaignIds.get(decision.key);
    const evaluationKey = `${decision.key}:fixture-v1`;
    await client.query(`
      INSERT INTO ad_performance_evaluations (
        campaign_id, user_id, platform, target_type, target_key, objective,
        window_start, window_end, metrics_snapshot, metrics_updated_at,
        baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
        confidence, state, hypothetical_action, evaluation_key
      ) VALUES (
        $1, $2, $3, 'campaign', $4, $5, $6, $7,
        '{"spend":9800,"impressions":32000,"clicks":1120,"conversions":56}'::jsonb,
        NOW(), 'campaign_target', $8::jsonb, '[]'::jsonb, $9::jsonb,
        $10, $11, $12, $13
      ) ON CONFLICT (user_id, evaluation_key) DO NOTHING
    `, [campaignId, userId, campaign.platform, `e2e-${decision.key}`, campaign.objective, isoDate(-3), isoDate(0), JSON.stringify(decision.baseline), JSON.stringify(decision.rules), decision.confidence, decision.state, decision.state === 'recommendation' ? 'recommend' : null, evaluationKey]);
    const evaluation = await client.query('SELECT id FROM ad_performance_evaluations WHERE user_id = $1 AND evaluation_key = $2', [userId, evaluationKey]);
    if (decision.state === 'recommendation') {
      await client.query(`
        INSERT INTO ad_recommendations (
          evaluation_id, campaign_id, user_id, platform, target_type, target_key,
          category, title, rationale, evidence, expected_direction,
          suggested_next_step, confidence, status
        ) VALUES (
          $1, $2, $3, $4, 'campaign', $5, 'landing_page',
          'Align the landing page with the demo ad promise',
          'Lead cost is above the campaign target while click volume remains healthy.',
          $6::jsonb, 'Lower cost per qualified lead',
          'Review the landing-page headline and form friction in the campaign editor.',
          0.86, 'open'
        ) ON CONFLICT (evaluation_id, category) DO NOTHING
      `, [Number(evaluation.rows[0].id), campaignId, userId, campaign.platform, `e2e-${decision.key}`, JSON.stringify({ objective: campaign.objective, evidenceWindow: { start: isoDate(-3), end: isoDate(0) }, currentMetrics: { cpa: 175 }, targetMetrics: { cpa: 120 }, historicalComparison: { baselineSource: 'campaign_target', comparableCampaignIds: [] } })]);
    }
  }

  const leadCampaignId = campaignIds.get('pm-e2e-google-leads');
  await client.query(`
    INSERT INTO ad_unit_metrics (
      campaign_id, user_id, platform, target_type, target_key, parent_target_key,
      provider_resource, date, impressions, clicks, spend, reach, conversions,
      engagements, provider_status, provider_payload
    ) VALUES
      ($1, $2, 'google', 'ad_group', 'demo-intent', NULL, 'provider-ad-group-e2e', $3, 18000, 690, 5900, 16000, 36, 420, 'ENABLED', '{"name":"Demo intent"}'::jsonb),
      ($1, $2, 'google', 'ad', 'responsive-ad-a', 'demo-intent', 'provider-ad-e2e', $3, 9800, 410, 3100, 8700, 24, 260, 'ENABLED', '{"name":"Responsive search ad A"}'::jsonb)
    ON CONFLICT (campaign_id, platform, target_type, target_key, date) DO UPDATE SET updated_at = NOW()
  `, [leadCampaignId, userId, isoDate(0)]);

  for (let day = -11; day <= 0; day += 1) {
    const end = new Date(`${isoDate(day)}T18:00:00.000Z`);
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    await client.query(`
      INSERT INTO social_metric_snapshots (
        user_id, platform, account_identifier, metric_window_start, metric_window_end,
        source, source_snapshot_id, metrics, timezone
      ) VALUES ($1, 'instagram', $2, $3, $4, 'official_api', $5, $6::jsonb, 'Asia/Kolkata')
      ON CONFLICT (user_id, platform, account_identifier, metric_window_start, metric_window_end, source, source_snapshot_id) DO NOTHING
    `, [userId, accountIdentifier, start, end, `pm-e2e-social-${day}`, JSON.stringify({ impressions: 4200 + (day + 12) * 130, reach: 3300 + (day + 12) * 95, engagements: 310 + (day + 12) * 14, views: 5100 + (day + 12) * 170, clicks: 86 + (day + 12) * 5, followers: 12800 + (day + 12) * 20 })]);
  }
  await client.query(`
    INSERT INTO social_best_time_recommendations (
      user_id, platform, account_identifier, timezone, sample_size, confidence,
      fallback_used, methodology, recommended_slots, source_snapshot_ids
    ) VALUES ($1, 'instagram', $2, 'Asia/Kolkata', 12, 0.82, FALSE,
      'local_timezone_engagement_by_weekday_hour',
      '[{"dayOfWeek":2,"hour":19,"averageEngagement":412,"observations":4},{"dayOfWeek":4,"hour":18,"averageEngagement":386,"observations":3}]'::jsonb,
      '[]'::jsonb)
  `, [userId, accountIdentifier]);
  await client.query(`
    INSERT INTO social_listening_events (
      user_id, platform, provider_event_id, public_url, author_handle, body,
      occurred_at, sentiment, sentiment_score, metadata, source
    ) VALUES
      ($1, 'instagram', 'pm-e2e-listen-positive', 'https://example.com/social/positive', '@customer_one', 'The latest product walkthrough was clear and useful.', NOW() - INTERVAL '1 day', 'positive', 0.84, '{}'::jsonb, 'public_export'),
      ($1, 'instagram', 'pm-e2e-listen-neutral', 'https://example.com/social/neutral', '@customer_two', 'Is there a shorter version of the demo?', NOW() - INTERVAL '2 days', 'neutral', 0.10, '{}'::jsonb, 'public_export'),
      ($1, 'instagram', 'pm-e2e-listen-negative', 'https://example.com/social/negative', '@customer_three', 'The signup link was difficult to find.', NOW() - INTERVAL '3 days', 'negative', -0.71, '{}'::jsonb, 'public_export')
    ON CONFLICT (user_id, platform, provider_event_id) DO NOTHING
  `, [userId]);
  const competitorResult = await client.query(`
    INSERT INTO social_competitors (user_id, platform, public_handle, display_name, public_url)
    VALUES ($1, 'instagram', '@northstar_e2e', 'Northstar Demo', 'https://example.com/northstar')
    ON CONFLICT (user_id, platform, public_handle) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id
  `, [userId]);
  await client.query(`
    INSERT INTO social_competitor_snapshots (competitor_id, user_id, source, source_snapshot_id, metrics, source_url)
    VALUES ($1, $2, 'public_export', 'pm-e2e-competitor-v1', '{"impressions":5100,"engagements":350,"views":6200,"followers":14200}'::jsonb, 'https://example.com/northstar/evidence')
    ON CONFLICT (competitor_id, source, source_snapshot_id) DO NOTHING
  `, [competitorResult.rows[0].id, userId]);
  await client.query(`
    INSERT INTO social_saved_reports (
      user_id, name, filters, schedule_cron, schedule_definition, schedule_timezone,
      delivery_channel, delivery_target
    ) VALUES (
      $1, 'Weekly social summary', '{"platform":"instagram"}'::jsonb, '30 9 * * 1',
      '{"frequency":"weekly","dayOfWeek":1,"localTime":"09:30","timezone":"Asia/Kolkata"}'::jsonb,
      'Asia/Kolkata', 'email', $2
    ) ON CONFLICT (user_id, name) DO UPDATE SET
      schedule_definition = EXCLUDED.schedule_definition,
      schedule_timezone = EXCLUDED.schedule_timezone, updated_at = NOW()
  `, [userId, email]);

  await client.query('COMMIT');
  console.log(JSON.stringify({ email, password, userId, accountIdentifier }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
