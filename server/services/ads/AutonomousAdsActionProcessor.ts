import { reconcileCampaignProviderState } from './CampaignProviderState.js';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { getMetaAdsCreds } from '../../models/metaPageConnections/functions.js';
import { getGoogleAdsCredentials } from '../../controllers/integrationsController.js';
import { MetaAdsService, type MetaCampaign } from './MetaAdsService.js';
import {
  buildGoogleProviderCampaignName,
  createGoogleAdsSearchCampaign,
  createGoogleResponsiveSearchAd,
  findGoogleCampaignResourceGraph,
  removeGoogleCampaignResources,
  updateCampaignBudget,
  updateCampaignStatus,
  updateGoogleAdGroupStatus,
  updateGoogleAdStatus,
} from './GoogleAdsService.js';
import { money, reallocateWithinCap, validateBudgetCap, type AdPlatform, type CampaignAllocation } from './AutonomousAdsDomain.js';
import { logger } from '../../utils/logger.js';
import {
  defaultGoogleProviderConfig,
  defaultMetaProviderConfig,
  normalizeGoogleCreative,
  normalizeMetaCreative,
  type GoogleProviderConfig,
  type MetaPlacement,
  type MetaProviderConfig,
  type ProviderAccountSnapshot,
} from './ProviderCampaignContract.js';
import { adPerformanceService } from './AdPerformanceService.js';
import { autonomousAdsService } from './AutonomousAdsService.js';
import { assertPublishReviewMatches, assertReviewedProviderAccount, publishReviewRevision } from './CampaignPublishReview.js';
import { campaignCurrencyScale, type ApprovedCampaignPublishReview } from '../../../shared/adCampaignReview.js';
import { providerErrorCode, sanitizeProviderError } from './ProviderErrorSafety.js';
import { NotificationService } from '../NotificationService.js';
import { emailService } from '../emailService.js';

type ActionRow = Record<string, any>;

const META_OBJECTIVE: Record<string, MetaCampaign['objective']> = {
  awareness: 'OUTCOME_AWARENESS',
  traffic: 'OUTCOME_TRAFFIC',
  engagement: 'OUTCOME_ENGAGEMENT',
  leads: 'OUTCOME_LEADS',
  sales: 'OUTCOME_SALES',
  app_promotion: 'OUTCOME_APP_PROMOTION',
};

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function metaPlacementTargeting(placements: MetaPlacement[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const placement of placements) {
    const [publisher, ...positionParts] = placement.split('_');
    const position = positionParts.join('_');
    const publisherName = publisher === 'audience' ? 'audience_network' : publisher;
    result.publisherPlatforms = [...new Set([...(result.publisherPlatforms || []), publisherName])];
    const key = publisherName === 'facebook'
      ? 'facebookPositions'
      : publisherName === 'instagram'
        ? 'instagramPositions'
        : publisherName === 'messenger'
          ? 'messengerPositions'
          : 'audienceNetworkPositions';
    if (position && position !== 'network') {
      result[key] = [...new Set([...(result[key] || []), position])];
    }
  }
  return result;
}

function metaPromotedObject(value: MetaProviderConfig['promotedObject']): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return {
    ...(value.pixelId ? { pixel_id: value.pixelId } : {}),
    ...(value.customConversionId ? { custom_conversion_id: value.customConversionId } : {}),
    ...(value.applicationId ? { application_id: value.applicationId } : {}),
    ...(value.objectStoreUrl ? { object_store_url: value.objectStoreUrl } : {}),
    ...(value.pageId ? { page_id: value.pageId } : {}),
  };
}

export class AutonomousAdsActionProcessor {
  async processBatch(limit = 10): Promise<{ processed: number; failed: number; gated: number }> {
    await this.recoverStaleClaims();
    await this.processPendingNotifications(Math.max(2, limit));
    if (process.env.AD_PROVIDER_MUTATIONS_ENABLED !== 'true') {
      return { processed: 0, failed: 0, gated: await this.deferGated(limit) };
    }
    let processed = 0;
    let failed = 0;
    for (let index = 0; index < limit; index += 1) {
      const action = await this.claim();
      if (!action) break;
      try {
        const payload = asObject(action.payload);
        const approvalOnlyAction = ['activate', 'resume', 'reallocate', 'create_replacement'].includes(String(action.action_type));
        const unsupportedLegacyPause = action.action_type === 'pause'
          && !action.evaluation_id
          && !String(action.rationale || '').toLowerCase().includes('lifetime cap')
          && payload.actorType !== 'user';
        if ((approvalOnlyAction && payload.actorType !== 'user') || unsupportedLegacyPause) {
          await this.cancelAction(action, 'This v1 action is approval-only and cannot be executed autonomously.');
          continue;
        }
        if (action.action_type === 'pause' && !action.evaluation_id && payload.actorType !== 'user'
          && String(action.rationale || '').toLowerCase().includes('lifetime cap')) {
          const campaign = await this.loadCampaign(action);
          if (asObject(campaign.settings).importedProviderCampaign === true || campaign.budget_type !== 'lifetime') {
            await this.cancelAction(action, 'Reporting imports and daily budgets do not authorize a lifetime-cap pause.');
            continue;
          }
        }
        const settingsResult = await db.execute(sql`
          SELECT live_provider_mutations_enabled
          FROM ad_settings WHERE user_id = ${Number(action.user_id)} LIMIT 1
        `);
        if (settingsResult.rows[0]?.live_provider_mutations_enabled !== true) {
          await this.deferAction(action, 'Tenant live provider mutations are disabled');
          continue;
        }
        await this.processAction(action);
        processed += 1;
      } catch (error) {
        failed += 1;
        await this.fail(action, error instanceof Error ? error.message : 'Unknown provider action failure');
      }
    }
    return { processed, failed, gated: 0 };
  }

  private async claim(): Promise<ActionRow | null> {
    return await db.transaction(async (tx: typeof db) => {
      const result = await tx.execute(sql`
        WITH candidate AS (
          SELECT id FROM ad_action_queue
          WHERE status = 'pending' AND available_at <= NOW()
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE ad_action_queue q
        SET status = 'processing', attempts = attempts + 1,
            locked_at = NOW(), locked_by = ${`ads-${process.pid}`}, updated_at = NOW()
        FROM candidate
        WHERE q.id = candidate.id
        RETURNING q.*, q.locked_at::text AS lease_locked_at
      `);
      return result.rows[0] as ActionRow || null;
    });
  }

  private async recoverStaleClaims(): Promise<void> {
    // Keep recovery and its local reconciliation atomic. A new approval must
    // not observe a recovered queue row before its campaign state is recorded.
    await db.transaction(async (tx: typeof db) => {
      const result = await tx.execute(sql`
        UPDATE ad_action_queue
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            available_at = CASE
              WHEN attempts >= max_attempts THEN available_at
              ELSE NOW() + INTERVAL '1 minute'
            END,
            last_error = 'Recovered a stale worker claim after the concurrency lease expired',
            locked_at = NULL,
            locked_by = NULL,
            completed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE completed_at END,
            updated_at = NOW()
        WHERE status = 'processing'
          AND locked_at < NOW() - INTERVAL '15 minutes'
        RETURNING *
      `);
      for (const action of result.rows as Array<Record<string, unknown>>) {
        if (action.status !== 'failed') continue;
        if (action.action_type === 'pause' && action.evaluation_id
          && String(action.target_type || 'campaign') !== 'campaign') {
          await tx.execute(sql`
            UPDATE ad_provider_resources
            SET error = ${String(action.last_error)}, updated_at = NOW()
            WHERE campaign_id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
              AND platform = ${String(action.platform)} AND resource_type = ${String(action.target_type)}
              AND local_key = ${String(action.target_key)} AND cleanup_status IS NULL
          `);
          continue;
        }
        await tx.execute(sql`
          UPDATE performance_ad_campaigns campaign
          SET status = CASE WHEN EXISTS (
                SELECT 1 FROM ad_campaign_allocations allocation
                WHERE allocation.campaign_id = campaign.id AND allocation.user_id = campaign.user_id
                  AND allocation.platform <> ${String(action.platform)} AND allocation.status = 'active'
              ) THEN 'partial_success' ELSE 'provider_failed' END,
              local_status = CASE WHEN EXISTS (
                SELECT 1 FROM ad_campaign_allocations allocation
                WHERE allocation.campaign_id = campaign.id AND allocation.user_id = campaign.user_id
                  AND allocation.platform <> ${String(action.platform)} AND allocation.status = 'active'
              ) THEN 'partial_success' ELSE 'provider_failed' END,
              last_provider_error = ${String(action.last_error)},
              updated_at = NOW()
          WHERE id = ${Number(action.campaign_id)}
            AND user_id = ${Number(action.user_id)}
        `);
        await tx.execute(sql`
          UPDATE ad_campaign_allocations
          SET status = 'provider_failed', updated_at = NOW()
          WHERE campaign_id = ${Number(action.campaign_id)}
            AND user_id = ${Number(action.user_id)}
            AND platform = ${String(action.platform)}
        `);
      }
    });
  }

  private async processAction(action: ActionRow): Promise<void> {
    const campaign = await this.loadCampaign(action);
    let allocations = await this.loadAllocations(action);
    if (action.action_type === 'publish' || action.action_type === 'activate') {
      const review = await this.revalidatePublishApproval(action);
      // The reviewed effective creative and activation scope are immutable;
      // mutable campaign flags cannot expand a paused-creation approval.
      campaign.ad_creatives = review.snapshot.creatives;
      campaign.auto_activate = review.scope === 'live_activation_and_spend';
      const snapshot = review.snapshot;
      const scale = campaignCurrencyScale(snapshot.budget.currency);
      Object.assign(campaign, {
        name: snapshot.name, objective: snapshot.objective,
        budget_amount: snapshot.budget.amountMinor / scale, currency: snapshot.budget.currency,
        budget_type: snapshot.budget.budgetType, landing_page_url: snapshot.landingPageUrl,
        start_date: snapshot.startDate, end_date: snapshot.endDate,
        locations: snapshot.locations, targeting: snapshot.targeting,
        settings: { ...asObject(campaign.settings), accountSnapshot: snapshot.providerAccounts,
          providerConfig: snapshot.providerConfig,
          context: { ...asObject(asObject(campaign.settings).context), scheduleDates: snapshot.scheduleDates },
        },
      });
      allocations = snapshot.allocations.map(item => ({
        key: item.key, platform: item.platform, amount: item.amountMinor / scale,
        spent: allocations.find(current => current.key === item.key && current.platform === item.platform)?.spent || 0,
      }));
      if (action.action_type === 'activate' && !campaign.auto_activate) throw new Error('This approval does not authorize live activation.');
    }
    const budgetErrors = validateBudgetCap(Number(campaign.budget_amount), allocations);
    if (budgetErrors.length && action.action_type !== 'pause') throw new Error(`Financial guardrail blocked provider action: ${budgetErrors.join(' ')}`);
    if (!['publish', 'activate', 'pause'].includes(action.action_type) && Array.isArray(campaign.validation_errors) && campaign.validation_errors.length) {
      throw new Error('Campaign validation errors must be resolved before provider actions.');
    }
    if (Number(campaign.spent_amount || 0) >= Number(campaign.budget_amount) && action.action_type !== 'pause') {
      throw new Error('Lifetime budget cap has been reached; only pause is allowed.');
    }
    const consent = await adPerformanceService.revalidateAutonomousPause(action);
    if (!consent.valid) {
      await this.cancelAction(action, consent.reason || 'AI pause consent could not be revalidated.');
      return;
    }
    if ((!action.target_type || action.target_type === 'campaign') && action.action_type !== 'pause') {
      await db.execute(sql`
        UPDATE performance_ad_campaigns
        SET local_status = 'running', last_provider_error = NULL, updated_at = NOW()
        WHERE id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
      `);
    }
    let outcome: Record<string, unknown>;
    if (action.action_type === 'publish') outcome = await this.publish(action, campaign, allocations);
    else if (action.action_type === 'activate' || action.action_type === 'resume') outcome = await this.setStatus(action, 'active');
    else if (action.action_type === 'pause') outcome = await this.setStatus(action, 'paused');
    else if (action.action_type === 'reallocate') outcome = await this.reallocate(action, campaign, allocations);
    else if (action.action_type === 'create_replacement') outcome = await this.publishReplacement(action, campaign);
    else if (action.action_type === 'cleanup') outcome = await this.cleanup(action);
    else throw new Error(`Unsupported action type: ${action.action_type}`);
    await db.transaction(async (tx: typeof db) => {
      const completed = await tx.execute(sql`
        UPDATE ad_action_queue
        SET status = 'succeeded', provider_outcome = ${JSON.stringify(outcome)}::jsonb,
            completed_at = NOW(), updated_at = NOW(), locked_at = NULL, locked_by = NULL
        WHERE ${this.claimFence(action)} RETURNING id
      `);
      if (!completed.rows.length) throw new Error('The provider outcome could not complete an expired or cancelled worker lease. Reconciliation is required.');
      await tx.execute(sql`
        INSERT INTO ad_action_audit (
          action_id, campaign_id, user_id, actor_type, action_type,
          rationale, metrics_snapshot, budget_before, budget_after, provider_outcome
        ) VALUES (
          ${Number(action.id)}, ${Number(action.campaign_id)}, ${Number(action.user_id)},
          ${asObject(action.payload).actorType === 'user' ? 'user' : 'ai'},
          ${String(action.action_type)}, ${String(action.rationale)},
          ${JSON.stringify(action.metrics_snapshot || {})}::jsonb,
          ${Number(campaign.budget_amount)}, ${Number(campaign.budget_amount)},
          ${JSON.stringify(outcome)}::jsonb
        )
      `);
    });
    if (action.action_type === 'pause' && action.evaluation_id) {
      try {
        await this.appendPauseOutcomeEvaluation(action);
      } catch (evaluationError) {
        logger.error(
          { err: evaluationError, actionId: action.id, evaluationId: action.evaluation_id },
          '[AdPerformance] Pause succeeded but its append-only outcome evaluation could not be recorded',
        );
      }
      try {
        // Notification scheduling is deliberately outside the provider-success
        // transaction. A delivery-table or mail outage must never make a
        // successful provider pause appear pending or trigger it a second time.
        await db.execute(sql`
          INSERT INTO ad_action_notification_deliveries (
            action_id, campaign_id, user_id, channel, destination
          ) VALUES
            (${Number(action.id)}, ${Number(action.campaign_id)}, ${Number(action.user_id)}, 'in_app', NULL),
            (${Number(action.id)}, ${Number(action.campaign_id)}, ${Number(action.user_id)}, 'email',
              (SELECT COALESCE(settings.notification_email, users.email)
                FROM ad_settings settings
                JOIN users ON users.id = settings.user_id
                WHERE settings.user_id = ${Number(action.user_id)} LIMIT 1))
          ON CONFLICT (action_id, channel) DO NOTHING
        `);
        await this.deliverPauseNotifications(action, campaign, outcome);
      } catch (notificationError) {
        logger.error(
          { err: notificationError, actionId: action.id },
          '[AdPerformance] Pause succeeded but notification scheduling failed',
        );
      }
    }
  }

  private async revalidatePublishApproval(action: ActionRow): Promise<ApprovedCampaignPublishReview> {
    const campaign = await this.loadCampaign(action);
    const allocations = await this.loadAllocations(action);
    const review = asObject(action.payload).approvedReview as ApprovedCampaignPublishReview | undefined;
    try {
      assertPublishReviewMatches(review, campaign, allocations, String(action.platform));
      if (campaign.end_date && new Date(campaign.end_date).getTime() <= Date.now()) throw new Error('The reviewed campaign schedule has ended.');
      const claim = await db.execute(sql`SELECT status, locked_by, locked_at, locked_at::text AS lease_locked_at FROM ad_action_queue WHERE id = ${Number(action.id)} AND user_id = ${Number(action.user_id)} LIMIT 1`);
      const currentClaim = claim.rows[0];
      if (!currentClaim || currentClaim.status !== 'processing' || currentClaim.locked_by !== action.locked_by
        || (action.lease_locked_at
          ? currentClaim.lease_locked_at !== action.lease_locked_at
          : new Date(String(currentClaim.locked_at)).getTime() !== new Date(String(action.locked_at)).getTime())) {
        throw new Error('The launch action was cancelled or its execution lease changed.');
      }
      const revokedAt = asObject(campaign.settings).publishApprovalRevokedAt;
      const platformRevokedAt = asObject(asObject(campaign.settings).publishApprovalRevokedByPlatform)[String(action.platform)];
      if ([revokedAt, platformRevokedAt].some(value => value && new Date(String(value)).getTime() >= new Date(review!.approvedAt).getTime())) {
        throw new Error('A stop request revoked this launch approval.');
      }
    } catch (error) {
      action.requiresFreshApproval = true;
      throw error;
    }
    const [settings, readiness] = await Promise.all([
      autonomousAdsService.getSettings(Number(action.user_id)),
      autonomousAdsService.getAccountReadiness(Number(action.user_id), true),
    ]);
    if (process.env.AD_PROVIDER_MUTATIONS_ENABLED !== 'true' || !settings.liveProviderMutationsEnabled) {
      throw new Error('Live provider mutations were disabled before the provider action.');
    }
    const platform = action.platform as AdPlatform;
    if (!readiness[platform]) throw new Error(readiness.reasons[platform] || `${platform} provider account is not ready.`);
    assertReviewedProviderAccount(review!.snapshot, readiness.accounts, platform);
    return review!;
  }

  private async markPublishMutationStarted(action: ActionRow): Promise<void> {
    const claimed = await db.execute(sql`
      UPDATE ad_action_queue SET payload = payload || '{"providerMutationStarted":true}'::jsonb, updated_at = NOW()
      WHERE ${this.claimFence(action)} RETURNING id
    `);
    if (!claimed.rows.length) throw new Error('The launch was cancelled or its worker lease changed before provider creation.');
    action.payload = { ...asObject(action.payload), providerMutationStarted: true };
  }

  private async markActivationRequested(action: ActionRow): Promise<void> {
    const claimed = await db.execute(sql`
      UPDATE ad_action_queue SET provider_outcome = COALESCE(provider_outcome, '{}'::jsonb)
        || '{"providerCreationComplete":true,"safelyPaused":false,"status":"activation_requested"}'::jsonb,
        updated_at = NOW()
      WHERE ${this.claimFence(action)} RETURNING id
    `);
    if (!claimed.rows.length) throw new Error('The launch was cancelled or its worker lease changed before activation.');
    action.providerCreationComplete = true;
    action.providerPauseConfirmed = false;
  }

  private claimFence(action: ActionRow) {
    return sql`id = ${Number(action.id)} AND user_id = ${Number(action.user_id)}
      AND status = 'processing' AND locked_by = ${action.locked_by ?? null}
      AND locked_at = ${action.lease_locked_at ?? action.locked_at ?? null}`;
  }

  private async markCreationComplete(action: ActionRow): Promise<void> {
    // Creation evidence is monotonic and remains useful after cancellation.
    // This does not authorize activation or change the action's status/lease.
    await db.execute(sql`
      UPDATE ad_action_queue SET provider_outcome = COALESCE(provider_outcome, '{}'::jsonb)
        || '{"providerCreationComplete":true}'::jsonb, updated_at = NOW()
      WHERE id = ${Number(action.id)} AND user_id = ${Number(action.user_id)}
    `);
    action.providerCreationComplete = true;
  }

  private async appendPauseOutcomeEvaluation(action: ActionRow): Promise<void> {
    await db.execute(sql`
      INSERT INTO ad_performance_evaluations (
        campaign_id, user_id, platform, target_type, target_key, objective,
        window_start, window_end, metrics_snapshot, metrics_updated_at,
        baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
        confidence, state, hypothetical_action, evaluation_key, actual_action_id, created_at
      )
      SELECT campaign_id, user_id, platform, target_type, target_key, objective,
        window_start, window_end, metrics_snapshot, metrics_updated_at,
        baseline_source, baseline_metrics, comparable_campaign_ids, rule_results,
        confidence, 'ai_paused', hypothetical_action,
        LEFT(evaluation_key || ':action:' || ${Number(action.id)}, 240), ${Number(action.id)}, NOW()
      FROM ad_performance_evaluations
      WHERE id = ${Number(action.evaluation_id)} AND user_id = ${Number(action.user_id)}
      ON CONFLICT (business_profile_id, user_id, evaluation_key) DO NOTHING
    `);
  }

  private async publish(
    action: ActionRow,
    campaign: ActionRow,
    allocations: CampaignAllocation[],
  ): Promise<Record<string, unknown>> {
    return action.platform === 'meta'
      ? await this.publishMeta(action, campaign, allocations.filter((item) => item.platform === 'meta'))
      : await this.publishGoogle(action, campaign, allocations.filter((item) => item.platform === 'google'));
  }

  private async publishMeta(action: ActionRow, campaign: ActionRow, allocations: CampaignAllocation[]) {
    const credentials = await getMetaAdsCreds(Number(action.user_id));
    if (!credentials) throw new Error('Meta account is no longer ready.');
    const campaignSettings = asObject(campaign.settings);
    const accountSnapshot = asObject(campaignSettings.accountSnapshot) as ProviderAccountSnapshot;
    if (
      accountSnapshot.meta
      && (accountSnapshot.meta.adAccountId !== credentials.adAccountId || accountSnapshot.meta.pageId !== credentials.pageId || (accountSnapshot.meta.instagramAccountId || null) !== (credentials.instagramAccountId || null))
    ) {
      throw new Error('The selected Meta ad account or Page changed after approval. Review and publish again.');
    }
    const storedProviderConfig = asObject(campaignSettings.providerConfig);
    const metaConfig = {
      ...defaultMetaProviderConfig(campaign.objective),
      ...asObject(storedProviderConfig.meta),
    } as MetaProviderConfig;
    const meta = new MetaAdsService({
      accessToken: credentials.accessToken,
      adAccountId: credentials.adAccountId,
      expiresAt: credentials.expiresAt || undefined,
    });
    const existing = await this.findResource(action, 'campaign', 'campaign');
    if (existing?.provider_resource_id) {
      if (
        await this.hasCompleteResourceGraph(action, allocations)
        && await this.hasFinalizedResourceGraph(action)
      ) {
        await this.updateLocalPublished(
          action,
          campaign.auto_activate ? 'active' : 'published',
          campaign.auto_activate ? 'ACTIVE' : 'PAUSED',
          true,
        );
        return { idempotentReplay: true, campaignId: existing.provider_resource_id, activated: Boolean(campaign.auto_activate) };
      }
      if (!existing.cleanup_status && await this.hasCompleteResourceGraph(action, allocations)) {
        return this.activateRetainedMetaCampaign(action, campaign, meta, existing.provider_resource_id);
      }
      if (!existing.cleanup_status) {
        const cleanup = await meta.updateResourceStatus(existing.provider_resource_id, 'ARCHIVED');
        if (!cleanup.success) throw new Error(cleanup.error || 'Unable to clean up incomplete Meta campaign before retry.');
        await this.markResourcesCleanup(action, 'archived');
      }
    }
    if (!existing?.provider_resource_id && asObject(action.payload).providerMutationStarted === true) {
      action.requiresFreshApproval = true;
      throw new Error('An earlier Meta creation request has no durable receipt. Reconcile it before creating another campaign.');
    }
    await this.revalidatePublishApproval(action);
    await this.markPublishMutationStarted(action);
    const campaignResult = await meta.createCampaign({
      name: campaign.name,
      objective: META_OBJECTIVE[campaign.objective],
      status: 'PAUSED',
      specialAdCategories: metaConfig.specialAdCategories,
      specialAdCategoryCountries: metaConfig.specialAdCategoryCountries,
      bidStrategy: metaConfig.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS'
        ? undefined
        : metaConfig.bidStrategy,
    });
    if (!campaignResult.success || !campaignResult.campaignId) throw new Error(campaignResult.error || 'Meta campaign creation failed');
    await this.persistResource(action, 'campaign', 'campaign', campaignResult.campaignId, campaignResult.campaignId, 'created');
    const createdIds: string[] = [];
    try {
      const creatives = asObject(campaign.ad_creatives).meta || [];
      const hasRestrictedSpecialCategory = metaConfig.specialAdCategories
        .some((category) => ['HOUSING', 'EMPLOYMENT', 'CREDIT'].includes(category));
      for (let index = 0; index < allocations.length; index += 1) {
        const allocation = allocations[index];
        const creative = normalizeMetaCreative(creatives[index] || creatives[0], String(campaign.name));
        const placementTargeting = metaPlacementTargeting(metaConfig.placements);
        const adSet = await meta.createAdSet({
          campaignId: campaignResult.campaignId,
          name: `${campaign.name} - ${allocation.key}`,
          status: 'PAUSED',
          lifetimeBudget: Math.round(allocation.amount * campaignCurrencyScale(String(campaign.currency))),
          billingEvent: metaConfig.billingEvent,
          optimizationGoal: metaConfig.optimizationGoal,
          bidStrategy: metaConfig.bidStrategy,
          bidAmount: metaConfig.bidAmount ? Math.round(metaConfig.bidAmount * campaignCurrencyScale(String(campaign.currency))) : undefined,
          promotedObject: metaPromotedObject(metaConfig.promotedObject),
          targeting: {
            geoLocations: {
              countries: (campaign.locations || []).map((location: any) => location.countryCode).filter(Boolean),
            },
            ageMin: hasRestrictedSpecialCategory ? undefined : metaConfig.ageMin,
            ageMax: hasRestrictedSpecialCategory ? undefined : metaConfig.ageMax,
            genders: hasRestrictedSpecialCategory ? undefined : metaConfig.genders,
            interests: metaConfig.interests,
            customAudiences: metaConfig.customAudienceIds?.map((id) => ({ id })),
            excludedCustomAudiences: metaConfig.excludedCustomAudienceIds?.map((id) => ({ id })),
            ...placementTargeting,
          },
          startTime: new Date(campaign.start_date),
          endTime: campaign.end_date ? new Date(campaign.end_date) : undefined,
        });
        if (!adSet.success || !adSet.adSetId) throw new Error(adSet.error || 'Meta ad set creation failed');
        createdIds.push(adSet.adSetId);
        await this.persistResource(action, 'ad_set', allocation.key, adSet.adSetId, adSet.adSetId, 'created');
        let imageHash = creative.imageHash;
        if (!imageHash && creative.imageUrl) {
          const upload = await meta.uploadImage(creative.imageUrl);
          if (!upload.success || !upload.imageHash) throw new Error(upload.error || 'Meta image upload failed');
          imageHash = upload.imageHash;
        }
        let videoId = creative.videoId;
        if (!videoId && creative.videoUrl) {
          const upload = await meta.uploadVideo(creative.videoUrl);
          if (!upload.success || !upload.videoId) throw new Error(upload.error || 'Meta video upload failed');
          videoId = upload.videoId;
        }
        const ad = await meta.createAd({
          adSetId: adSet.adSetId,
          name: creative.name || `${campaign.name} ad ${index + 1}`,
          status: 'PAUSED',
          creative: {
            name: creative.name || `${campaign.name} creative ${index + 1}`,
            objectStorySpec: {
              pageId: credentials.pageId,
              instagramActorId: accountSnapshot.meta?.instagramAccountId,
              ...(videoId ? {
                videoData: {
                  videoId,
                  message: creative.primaryText,
                  title: creative.headline,
                  callToAction: {
                    type: creative.callToAction || 'LEARN_MORE',
                    value: { link: campaign.landing_page_url },
                  },
                },
              } : { linkData: {
                link: campaign.landing_page_url,
                message: creative.primaryText,
                name: creative.headline,
                description: creative.description || '',
                imageHash,
                callToAction: { type: creative.callToAction || 'LEARN_MORE', value: { link: campaign.landing_page_url } },
              } }),
            },
          },
        });
        if (!ad.success || !ad.adId) throw new Error(ad.error || 'Meta ad creation failed');
        createdIds.push(ad.adId);
        await this.persistResource(action, 'ad', allocation.key, ad.adId, ad.adId, 'created');
      }
      await this.markCreationComplete(action);
      if (campaign.auto_activate) {
        for (const id of createdIds) {
          await this.revalidatePublishApproval(action);
          await this.markActivationRequested(action);
          const result = await meta.updateResourceStatus(id, 'ACTIVE');
          if (!result.success) throw new Error(result.error);
        }
        await this.revalidatePublishApproval(action);
        await this.markActivationRequested(action);
        const active = await meta.updateResourceStatus(campaignResult.campaignId, 'ACTIVE');
        if (!active.success) throw new Error(active.error);
      }
      await this.markResourcesStatus(action, campaign.auto_activate ? 'active' : 'published');
      await this.updateLocalPublished(action, campaign.auto_activate ? 'active' : 'published', campaign.auto_activate ? 'ACTIVE' : 'PAUSED');
      return { campaignId: campaignResult.campaignId, childResourceIds: createdIds, activated: Boolean(campaign.auto_activate) };
    } catch (error) {
      if (action.providerCreationComplete) {
        throw await this.retainMetaAfterActivationFailure(action, meta, campaignResult.campaignId, error);
      }
      const cleanup = await meta.updateResourceStatus(campaignResult.campaignId, 'ARCHIVED');
      if (cleanup.success) await this.markResourcesCleanup(action, 'archived');
      throw error;
    }
  }

  private async activateRetainedMetaCampaign(action: ActionRow, campaign: ActionRow, meta: MetaAdsService, campaignId: string) {
    await this.markCreationComplete(action);
    try {
      if (campaign.auto_activate) {
        const children = await db.execute(sql`
          SELECT provider_resource_id FROM ad_provider_resources
          WHERE campaign_id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
            AND platform = 'meta' AND resource_type IN ('ad', 'ad_set') AND cleanup_status IS NULL
            AND metadata->>'publishReviewRevision' = ${String(asObject(asObject(action.payload).approvedReview).revision || '')}
          ORDER BY id
        `);
        for (const child of children.rows) {
          await this.revalidatePublishApproval(action);
          await this.markActivationRequested(action);
          const result = await meta.updateResourceStatus(String(child.provider_resource_id), 'ACTIVE');
          if (!result.success) throw new Error(result.error || 'Meta child activation failed.');
        }
        await this.revalidatePublishApproval(action);
        await this.markActivationRequested(action);
        const active = await meta.updateResourceStatus(campaignId, 'ACTIVE');
        if (!active.success) throw new Error(active.error || 'Meta campaign activation failed.');
        await this.revalidatePublishApproval(action);
      }
      await db.transaction(async (tx: typeof db) => {
        // Stop and launch completion take the same campaign -> action lock order.
        // Checking the lease and recording local state are one transaction.
        await tx.execute(sql`SELECT id FROM performance_ad_campaigns WHERE id=${Number(action.campaign_id)} AND user_id=${Number(action.user_id)} FOR UPDATE`);
        const owned = await tx.execute(sql`SELECT id FROM ad_action_queue WHERE ${this.claimFence(action)} FOR UPDATE`);
        if (!owned.rows.length) throw new Error('The retained launch was cancelled or its execution lease changed before finalization.');
        await this.markResourcesStatus(action, campaign.auto_activate ? 'active' : 'published', tx);
        await reconcileCampaignProviderState(tx, action as {id:number;campaign_id:number;user_id:number;platform:string}, campaign.auto_activate ? 'active' : 'published', campaign.auto_activate ? 'ACTIVE' : 'PAUSED');
      });
      return { campaignId, reconciled: true, activated: Boolean(campaign.auto_activate) };
    } catch (error) {
      throw await this.retainMetaAfterActivationFailure(action, meta, campaignId, error);
    }
  }

  private async retainMetaAfterActivationFailure(action: ActionRow, meta: MetaAdsService, campaignId: string, error: unknown): Promise<Error> {
    action.providerPauseConfirmed = false;
    let pauseError = '';
    try {
      const paused = await meta.updateResourceStatus(campaignId, 'PAUSED');
      action.providerPauseConfirmed = paused.success;
      if (paused.success) await this.markResourcesStatus(action, 'published', db, true);
      else pauseError = paused.error || 'Provider did not confirm pause.';
    } catch (secondary) { pauseError = secondary instanceof Error ? secondary.message : String(secondary); }
    await this.recordCancelledActivationOutcome(action, action.providerPauseConfirmed === true, pauseError);
    return new Error(`Meta campaign ${campaignId} was created; activation did not complete. Resources retained ${action.providerPauseConfirmed ? 'paused' : 'for reconciliation; pause is not confirmed'}. ${error instanceof Error ? error.message : String(error)}${pauseError ? ` Pause/reconciliation error: ${pauseError}` : ''}`);
  }

  private async recordCancelledActivationOutcome(action: ActionRow, paused: boolean, pauseError: string): Promise<void> {
    await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT id FROM performance_ad_campaigns WHERE id=${Number(action.campaign_id)} AND user_id=${Number(action.user_id)} FOR UPDATE`);
      const updated=await tx.execute(sql`UPDATE ad_action_queue SET provider_outcome=COALESCE(provider_outcome,'{}'::jsonb)
        || ${JSON.stringify({status:paused?'activation_cancelled':'activation_failed',providerCreationComplete:true,safelyPaused:paused,requiresReconciliation:!paused})}::jsonb,
        updated_at=NOW() WHERE id=${Number(action.id)} AND user_id=${Number(action.user_id)} AND status='cancelled' RETURNING id`);
      if(!updated.rows.length || paused)return;
      const message=sanitizeProviderError(`A cancelled activation settled after stop; provider pause is unconfirmed. ${pauseError}`);
      // A previously completed stop cannot keep asserting paused after a later
      // accepted activation and an unconfirmed compensating pause.
      await tx.execute(sql`UPDATE ad_action_queue SET status='failed',last_error=${message},updated_at=NOW(),
        provider_outcome=COALESCE(provider_outcome,'{}'::jsonb)
          || '{"status":"reconciliation_required","providerPauseConfirmed":false,"requiresReconciliation":true}'::jsonb
        WHERE campaign_id=${Number(action.campaign_id)} AND user_id=${Number(action.user_id)} AND platform=${String(action.platform)}
          AND id>${Number(action.id)} AND action_type='pause' AND status='succeeded' AND evaluation_id IS NULL`);
      await tx.execute(sql`UPDATE ad_provider_resources SET status='uncertain',error=${message},updated_at=NOW()
        WHERE campaign_id=${Number(action.campaign_id)} AND user_id=${Number(action.user_id)} AND platform=${String(action.platform)} AND cleanup_status IS NULL
          AND metadata->>'publishReviewRevision'=${String(asObject(asObject(action.payload).approvedReview).revision || '')}`);
      await reconcileCampaignProviderState(tx,action as {id:number;campaign_id:number;user_id:number;platform:string},'uncertain','UNKNOWN');
      await tx.execute(sql`UPDATE performance_ad_campaigns SET is_active=TRUE,last_provider_error=${message}
        WHERE id=${Number(action.campaign_id)} AND user_id=${Number(action.user_id)}`);
    });
  }

  private async publishGoogle(action: ActionRow, campaign: ActionRow, allocations: CampaignAllocation[]) {
    const credentials = await getGoogleAdsCredentials(Number(action.user_id));
    if (!credentials) throw new Error('Google Ads account is no longer ready.');
    const campaignSettings = asObject(campaign.settings);
    const accountSnapshot = asObject(campaignSettings.accountSnapshot) as ProviderAccountSnapshot;
    if (accountSnapshot.google && accountSnapshot.google.customerId !== credentials.customerId) {
      throw new Error('The selected Google Ads customer changed after approval. Review and publish again.');
    }
    const storedProviderConfig = asObject(campaignSettings.providerConfig);
    const scheduleDates = asObject(asObject(campaignSettings.context).scheduleDates);
    const googleConfig = {
      ...defaultGoogleProviderConfig(),
      ...asObject(storedProviderConfig.google),
    } as GoogleProviderConfig;
    const creatives = (asObject(campaign.ad_creatives).google || [])
      .map((creative: unknown) => normalizeGoogleCreative(creative, String(campaign.name)));
    const existing = await this.findResource(action, 'campaign', 'campaign');
    if (existing?.provider_resource_name) {
      if (
        await this.hasCompleteResourceGraph(action, allocations)
        && await this.hasFinalizedResourceGraph(action)
      ) {
        await this.updateLocalPublished(
          action,
          campaign.auto_activate ? 'active' : 'published',
          campaign.auto_activate ? 'ENABLED' : 'PAUSED',
        );
        return { idempotentReplay: true, campaignResourceName: existing.provider_resource_name, activated: Boolean(campaign.auto_activate) };
      }
      if (!existing.cleanup_status && await this.hasCompleteResourceGraph(action, allocations)) {
        return { ...await this.finishGooglePublication(action, campaign, credentials, existing.provider_resource_name), reconciled: true };
      }
      if (!existing.cleanup_status) {
        const budget = await this.findResource(action, 'budget', 'campaign-budget');
        const cleanup = await removeGoogleCampaignResources(
          credentials,
          existing.provider_resource_name,
          budget?.provider_resource_name,
        );
        if (!cleanup.success) throw new Error(`Unable to clean up incomplete Google campaign before retry: ${cleanup.errors?.join('; ')}`);
        await this.markResourcesCleanup(action, 'removed');
      }
    }
    if (!existing?.provider_resource_name) {
      const providerCampaignName = buildGoogleProviderCampaignName(String(campaign.name), String(action.idempotency_key));
      const providerGraph = await findGoogleCampaignResourceGraph(credentials, providerCampaignName);
      if (providerGraph) {
        await this.persistResource(action, 'budget', 'campaign-budget', undefined, providerGraph.budgetResourceName, 'created');
        await this.persistResource(action, 'campaign', 'campaign', undefined, providerGraph.campaignResourceName, 'created');
        const mappedGroups = providerGraph.adGroups.map((group, providerIndex) => {
          const namedIndex = allocations.findIndex((allocation) => group.adGroupName === `${campaign.name} - ${allocation.key}`);
          const allocationIndex = namedIndex >= 0 ? namedIndex : providerIndex;
          return { group, allocation: allocations[allocationIndex], allocationIndex };
        });
        for (const { group, allocation } of mappedGroups) {
          if (!allocation) break;
          await this.persistResource(action, 'ad_group', allocation.key, undefined, group.adGroupResourceName, 'created');
          if (group.adResourceName) {
            await this.persistResource(action, 'ad', allocation.key, undefined, group.adResourceName, 'created');
          }
          for (let keywordIndex = 0; keywordIndex < group.keywordResourceNames.length; keywordIndex += 1) {
            await this.persistResource(
              action,
              'keyword',
              `${allocation.key}:${keywordIndex + 1}`,
              undefined,
              group.keywordResourceNames[keywordIndex],
              'created',
            );
          }
        }
        const complete = mappedGroups.length === allocations.length
          && new Set(mappedGroups.map(({ allocation }) => allocation?.key).filter(Boolean)).size === allocations.length
          && mappedGroups.every(({ group, allocation, allocationIndex }) => Boolean(allocation)
            && Boolean(group.adResourceName)
            && group.keywordResourceNames.length === (creatives[allocationIndex] || creatives[0])?.keywords.length);
        if (complete) {
          return { ...await this.finishGooglePublication(action, campaign, credentials, providerGraph.campaignResourceName), reconciled: true };
        }
        const cleanup = await removeGoogleCampaignResources(
          credentials,
          providerGraph.campaignResourceName,
          providerGraph.budgetResourceName,
        );
        if (!cleanup.success) throw new Error(`Unable to clean up the partial Google campaign before retry: ${cleanup.errors?.join('; ')}`);
        await this.markResourcesCleanup(action, 'removed');
      }
    }
    const days = campaign.end_date
      ? Math.max(1, Math.ceil((new Date(campaign.end_date).getTime() - new Date(campaign.start_date).getTime()) / 86_400_000))
      : 30;
    const googleLifetimeBudget = money(allocations.reduce(
      (sum, allocation) => sum + Number(allocation.amount || 0),
      0,
    ));
    const useTotalBudget = googleConfig.budgetMode === 'CAMPAIGN_TOTAL';
    await this.revalidatePublishApproval(action);
    await this.markPublishMutationStarted(action);
    const result = await createGoogleAdsSearchCampaign(credentials, {
      name: campaign.name,
      budgetMode: googleConfig.budgetMode,
      totalBudgetAmount: useTotalBudget ? googleLifetimeBudget : undefined,
      dailyBudgetAmount: useTotalBudget ? undefined : money(googleLifetimeBudget / days),
      finalUrl: campaign.landing_page_url,
      headlines: creatives[0]?.headlines || [],
      descriptions: creatives[0]?.descriptions || [],
      keywords: creatives[0]?.keywords || [],
      biddingStrategy: googleConfig.biddingStrategy,
      targetCpa: googleConfig.targetCpa,
      targetRoas: googleConfig.targetRoas,
      keywordMatchType: googleConfig.keywordMatchType,
      negativeKeywords: googleConfig.negativeKeywords,
      includeSearchNetwork: googleConfig.includeSearchNetwork,
      includePartnerSearchNetwork: googleConfig.includePartnerSearchNetwork,
      trackingTemplate: googleConfig.trackingTemplate,
      finalUrlSuffix: googleConfig.finalUrlSuffix,
      path1: googleConfig.path1,
      path2: googleConfig.path2,
      containsEuPoliticalAdvertising: googleConfig.containsEuPoliticalAdvertising,
      adGroups: allocations.map((allocation, index) => {
        const creative = creatives[index] || creatives[0] || {};
        return {
          key: allocation.key,
          name: `${campaign.name} - ${allocation.key}`,
          headlines: creative.headlines || [creative.headline, campaign.name, `Discover ${campaign.name}`].filter(Boolean),
          descriptions: creative.descriptions || [creative.description || creative.body, creative.secondaryDescription || 'Learn more today.'].filter(Boolean),
          keywords: creative.keywords || [],
          negativeKeywords: googleConfig.negativeKeywords,
          keywordMatchType: googleConfig.keywordMatchType,
          finalUrl: creative.finalUrl || campaign.landing_page_url,
          path1: creative.path1 || googleConfig.path1,
          path2: creative.path2 || googleConfig.path2,
        };
      }),
      geoTargetIds: (campaign.locations || []).map((location: any) => location.googleGeoTargetId).filter(Boolean),
      languageIds: googleConfig.languageIds,
      resourceKey: String(action.idempotency_key),
      startDate: String(scheduleDates.startDate || '') || new Date(campaign.start_date),
      endDate: String(scheduleDates.endDate || '') || (campaign.end_date ? new Date(campaign.end_date) : undefined),
      timeZone: accountSnapshot.google?.timezone,
      onResourceCreated: async ({ resourceType, localKey, resourceName }) => {
        await this.persistResource(action, resourceType, localKey, undefined, resourceName, 'created');
      },
    });
    if (!result.success || !result.campaignResourceName) {
      throw new Error([result.error, ...(result.cleanupErrors || [])].filter(Boolean).join('; '));
    }
    await this.persistResource(action, 'budget', 'campaign-budget', undefined, result.budgetResourceName, 'created');
    await this.persistResource(action, 'campaign', 'campaign', undefined, result.campaignResourceName, 'created');
    for (let index = 0; index < (result.adGroupResourceNames || []).length; index += 1) {
      const key = allocations[index]?.key || `google-${index + 1}`;
      await this.persistResource(action, 'ad_group', key, undefined, result.adGroupResourceNames![index], 'created');
      await this.persistResource(action, 'ad', key, undefined, result.adResourceNames?.[index], 'created');
    }
    return { ...result, ...await this.finishGooglePublication(action, campaign, credentials, result.campaignResourceName) };
  }

  private async finishGooglePublication(
    action: ActionRow,
    campaign: ActionRow,
    credentials: NonNullable<Awaited<ReturnType<typeof getGoogleAdsCredentials>>>,
    campaignResourceName: string,
  ) {
    await this.markCreationComplete(action);
    if (campaign.auto_activate) {
      try {
        await this.revalidatePublishApproval(action);
        await this.markActivationRequested(action);
        const activated = await updateCampaignStatus(credentials, campaignResourceName, 'ENABLED');
        if (!activated.success) throw new Error(activated.error || 'Google campaign activation failed');
      } catch (error) {
        action.providerPauseConfirmed = false;
        try {
          const paused = await updateCampaignStatus(credentials, campaignResourceName, 'PAUSED');
          action.providerPauseConfirmed = paused.success;
          if (paused.success) await this.markResourcesStatus(action, 'published');
        } catch { /* Keep the provider identity and report pause as unconfirmed. */ }
        throw new Error(`Google campaign ${campaignResourceName} was created; activation did not complete. Resources retained ${action.providerPauseConfirmed ? 'paused' : 'for reconciliation; pause is not confirmed'}. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.markResourcesStatus(action, campaign.auto_activate ? 'active' : 'published');
    await this.updateLocalPublished(action, campaign.auto_activate ? 'active' : 'published', campaign.auto_activate ? 'ENABLED' : 'PAUSED');
    return { campaignResourceName, activated: Boolean(campaign.auto_activate) };
  }

  private async assertStatusActionClaim(action: ActionRow): Promise<void> {
    const owned = await db.execute(sql`
      UPDATE ad_action_queue SET updated_at = NOW()
      WHERE ${this.claimFence(action)} RETURNING id
    `);
    if (!owned.rows.length) throw new Error('The status action was cancelled or its execution lease changed before the provider request.');
  }

  private async revalidateStatusMutation(action: ActionRow): Promise<void> {
    const settings = await autonomousAdsService.getSettings(Number(action.user_id));
    if (process.env.AD_PROVIDER_MUTATIONS_ENABLED !== 'true' || !settings.liveProviderMutationsEnabled) {
      throw new Error('Live provider mutations were disabled before the provider status request.');
    }
    const consent = await adPerformanceService.revalidateAutonomousPause(action);
    if (!consent.valid) {
      const reason = consent.reason || 'AI pause consent could not be revalidated.';
      await this.cancelAction(action, reason);
      throw new Error(reason);
    }
    await this.assertStatusActionClaim(action);
  }

  private async setStatus(action: ActionRow, status: 'active' | 'paused') {
    await this.assertStatusActionClaim(action);
    const targetType = String(action.target_type || asObject(action.payload).targetType || 'campaign');
    const targetKey = String(action.target_key || asObject(action.payload).targetKey || 'campaign');
    if (status === 'paused' && targetType === 'campaign') {
      await db.execute(sql`
        UPDATE performance_ad_campaigns SET settings = COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object('publishApprovalRevokedByPlatform', COALESCE(settings->'publishApprovalRevokedByPlatform', '{}'::jsonb)
            || jsonb_build_object(${String(action.platform)}::text, NOW())), updated_at = NOW()
        WHERE id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
      `);
      await db.execute(sql`
        UPDATE ad_action_queue SET status = 'cancelled', last_error = 'Cancelled by campaign stop request', updated_at = NOW()
        WHERE campaign_id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
          AND platform = ${String(action.platform)} AND action_type IN ('publish', 'activate')
          AND status IN ('pending', 'processing') AND id <> ${Number(action.id)}
      `);
    }
    const resource = await this.findResource(action, targetType, targetKey);
    if (!resource) {
      if (status === 'paused' && targetType === 'campaign') {
        const uncertain = await db.execute(sql`
          SELECT id FROM ad_action_queue WHERE campaign_id = ${Number(action.campaign_id)}
            AND user_id = ${Number(action.user_id)} AND platform = ${String(action.platform)}
            AND action_type = 'publish' AND payload->>'providerMutationStarted' = 'true' LIMIT 1
        `);
        return { status: 'cancelled', launchCancelled: true, providerPauseConfirmed: false,
          requiresReconciliation: uncertain.rows.length > 0,
          message: uncertain.rows.length ? 'Launch cancelled; an earlier provider request still requires reconciliation.'
            : 'Queued launch cancelled before any known provider creation.' };
      }
      throw new Error(`Provider ${targetType} resource is missing for ${targetKey}.`);
    }
    if (action.platform === 'meta') {
      const credentials = action.action_type === 'activate' ? await getMetaAdsCreds(Number(action.user_id)) : await (await import('./PaidAdAccountsService.js')).resolveCampaignMetaCredentials(Number(action.user_id), Number(action.campaign_id));
      if (!credentials) throw new Error('Meta account is not ready.');
      if (status === 'active' && action.action_type === 'activate') {
        const review = await this.revalidatePublishApproval(action);
        const account = review.snapshot.providerAccounts.meta;
        if (!account || account.adAccountId !== credentials.adAccountId || account.pageId !== credentials.pageId || (account.instagramAccountId || null) !== (credentials.instagramAccountId || null)) {
          throw new Error('The Meta credentials acquired for activation do not match the approved account and Page.');
        }
        await this.markActivationRequested(action);
      }
      await this.revalidateStatusMutation(action);
      const result = await new MetaAdsService({
        accessToken: credentials.accessToken,
        adAccountId: credentials.adAccountId,
        expiresAt: credentials.expiresAt || undefined,
      }).updateResourceStatus(resource.provider_resource_id, status === 'active' ? 'ACTIVE' : 'PAUSED');
      if (!result.success) throw new Error(result.error);
    } else {
      const credentials = action.action_type === 'activate' ? await getGoogleAdsCredentials(Number(action.user_id)) : await (await import('./PaidAdAccountsService.js')).resolveCampaignGoogleCredentials(Number(action.user_id), Number(action.campaign_id));
      if (!credentials) throw new Error('Google Ads account is not ready.');
      if (status === 'active' && action.action_type === 'activate') {
        const review = await this.revalidatePublishApproval(action);
        const account = review.snapshot.providerAccounts.google;
        if (!account || account.customerId !== credentials.customerId
          || String(account.managerAccountId || '') !== String(credentials.managerAccountId || '')) {
          throw new Error('The Google credentials acquired for activation do not match the approved customer and manager.');
        }
        await this.markActivationRequested(action);
      }
      await this.revalidateStatusMutation(action);
      const providerStatus = status === 'active' ? 'ENABLED' : 'PAUSED';
      const result = targetType === 'campaign'
        ? await updateCampaignStatus(credentials, resource.provider_resource_name, providerStatus)
        : targetType === 'ad_group'
          ? await updateGoogleAdGroupStatus(credentials, resource.provider_resource_name, providerStatus)
          : targetType === 'ad'
            ? await updateGoogleAdStatus(credentials, resource.provider_resource_name, providerStatus)
            : { success: false, error: `Google does not support target type ${targetType}.` };
      if (!result.success) throw new Error(result.error);
    }
    const localStatus = status === 'active' ? 'active' : 'paused';
    await db.execute(sql`
      UPDATE ad_provider_resources
      SET status = ${localStatus}, error = NULL, updated_at = NOW()
      WHERE id = ${Number(resource.id)} AND user_id = ${Number(action.user_id)}
    `);
    if (targetType === 'campaign') {
      await this.markResourcesStatus(action, status === 'active' ? 'active' : 'paused');
      await this.updateLocalPublished(action, status, status === 'active' ? 'ACTIVE' : 'PAUSED');
    } else if (targetType === 'ad_set' || targetType === 'ad_group') {
      await db.execute(sql`
        UPDATE ad_campaign_allocations
        SET status = ${localStatus}, updated_at = NOW()
        WHERE campaign_id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
          AND platform = ${String(action.platform)} AND child_key = ${targetKey}
      `);
    }
    return {
      status,
      previousStatus: resource.status || null,
      targetType,
      targetKey,
      providerResource: resource.provider_resource_name || resource.provider_resource_id,
    };
  }

  private async reallocate(action: ActionRow, campaign: ActionRow, allocations: CampaignAllocation[]) {
    const payload = asObject(action.payload);
    const next = reallocateWithinCap(Number(campaign.budget_amount), allocations, payload.sourceKey, payload.targetKey, Number(payload.amount));
    const changed = next.filter((item) => [payload.sourceKey, payload.targetKey].includes(item.key));
    if (action.platform === 'meta') {
      const credentials = await getMetaAdsCreds(Number(action.user_id));
      if (!credentials) throw new Error('Meta account is not ready.');
      const meta = new MetaAdsService({ accessToken: credentials.accessToken, adAccountId: credentials.adAccountId, expiresAt: credentials.expiresAt || undefined });
      for (const allocation of changed) {
        const resource = await this.findResource(action, 'ad_set', allocation.key);
        if (!resource?.provider_resource_id) throw new Error(`Meta ad set is missing for ${allocation.key}.`);
        const result = await meta.updateAdSetLifetimeBudget(resource.provider_resource_id, Math.round(allocation.amount * 100));
        if (!result.success) throw new Error(result.error);
      }
    } else {
      const credentials = await getGoogleAdsCredentials(Number(action.user_id));
      const budget = await this.findResource(action, 'budget', 'campaign-budget');
      if (!credentials || !budget?.provider_resource_name) throw new Error('Google budget resource is missing.');
      const days = campaign.end_date
        ? Math.max(1, Math.ceil((new Date(campaign.end_date).getTime() - new Date().getTime()) / 86_400_000))
        : 30;
      const googleAllocations = next.filter((allocation) => allocation.platform === 'google');
      const googleLifetimeBudget = googleAllocations.reduce(
        (sum, allocation) => sum + allocation.amount,
        0,
      );
      const googleRemainingBudget = googleAllocations.reduce(
        (sum, allocation) => sum + Math.max(0, allocation.amount - (allocation.spent || 0)),
        0,
      );
      const campaignSettings = asObject(campaign.settings);
      const googleConfig = {
        ...defaultGoogleProviderConfig(),
        ...asObject(asObject(campaignSettings.providerConfig).google),
      } as GoogleProviderConfig;
      const result = await updateCampaignBudget(
        credentials,
        budget.provider_resource_name,
        googleConfig.budgetMode === 'CAMPAIGN_TOTAL'
          ? money(googleLifetimeBudget)
          : money(googleRemainingBudget / days),
        googleConfig.budgetMode,
      );
      if (!result.success) throw new Error(result.error);
    }
    await db.transaction(async (tx: typeof db) => {
      for (const allocation of changed) {
        await tx.execute(sql`
          UPDATE ad_campaign_allocations
          SET allocated_amount = ${allocation.amount}, updated_at = NOW()
          WHERE campaign_id = ${Number(action.campaign_id)}
            AND user_id = ${Number(action.user_id)}
            AND child_key = ${allocation.key}
        `);
      }
    });
    return { allocations: changed, campaignLifetimeBudget: Number(campaign.budget_amount), budgetImpact: 0 };
  }

  private async publishReplacement(action: ActionRow, campaign: ActionRow) {
    const payload = asObject(action.payload);
    if (!payload.creative) throw new Error('Replacement action requires a validated platform-ready creative.');
    const creative = asObject(payload.creative);
    const targetKey = String(payload.targetKey || '');
    const replacementKey = String(payload.replacementKey || `${targetKey}-replacement-${action.id}`);
    if (!targetKey) throw new Error('Replacement action requires a target allocation key.');
    let providerResource: string;
    if (action.platform === 'meta') {
      const credentials = await getMetaAdsCreds(Number(action.user_id));
      const adSet = await this.findResource(action, 'ad_set', targetKey);
      if (!credentials || !adSet?.provider_resource_id) throw new Error('Meta replacement target ad set is unavailable.');
      const meta = new MetaAdsService({ accessToken: credentials.accessToken, adAccountId: credentials.adAccountId, expiresAt: credentials.expiresAt || undefined });
      const imageHash = creative.imageHash || (creative.imageUrl ? (await meta.uploadImage(creative.imageUrl)).imageHash : undefined);
      const created = await meta.createAd({
        adSetId: adSet.provider_resource_id,
        name: creative.name || replacementKey,
        status: 'PAUSED',
        creative: {
          name: creative.name || replacementKey,
          objectStorySpec: {
            pageId: credentials.pageId,
            linkData: {
              link: campaign.landing_page_url,
              message: creative.primaryText || creative.body || '',
              name: creative.headline || campaign.name,
              description: creative.description || '',
              imageHash,
              callToAction: { type: creative.callToAction || 'LEARN_MORE', value: { link: campaign.landing_page_url } },
            },
          },
        },
      });
      if (!created.success || !created.adId) throw new Error(created.error || 'Meta replacement creation failed');
      const activated = await meta.updateResourceStatus(created.adId, 'ACTIVE');
      if (!activated.success) {
        await meta.updateResourceStatus(created.adId, 'ARCHIVED');
        throw new Error(activated.error);
      }
      const previous = await this.findResource(action, 'ad', targetKey);
      if (previous?.provider_resource_id) {
        const paused = await meta.updateResourceStatus(previous.provider_resource_id, 'PAUSED');
        if (!paused.success) {
          await meta.updateResourceStatus(created.adId, 'PAUSED');
          throw new Error(paused.error || 'Meta previous ad could not be paused');
        }
      }
      providerResource = created.adId;
    } else {
      const credentials = await getGoogleAdsCredentials(Number(action.user_id));
      const adGroup = await this.findResource(action, 'ad_group', targetKey);
      if (!credentials || !adGroup?.provider_resource_name) throw new Error('Google replacement target ad group is unavailable.');
      const created = await createGoogleResponsiveSearchAd(credentials, {
        adGroupResourceName: adGroup.provider_resource_name,
        finalUrl: campaign.landing_page_url,
        headlines: creative.headlines || [],
        descriptions: creative.descriptions || [],
      });
      if (!created.success || !created.adResourceName) throw new Error(created.error || 'Google replacement creation failed');
      const activated = await updateGoogleAdStatus(credentials, created.adResourceName, 'ENABLED');
      if (!activated.success) {
        await updateGoogleAdStatus(credentials, created.adResourceName, 'REMOVED');
        throw new Error(activated.error);
      }
      const previous = await this.findResource(action, 'ad', targetKey);
      if (previous?.provider_resource_name) {
        const paused = await updateGoogleAdStatus(credentials, previous.provider_resource_name, 'PAUSED');
        if (!paused.success) {
          await updateGoogleAdStatus(credentials, created.adResourceName, 'PAUSED');
          throw new Error(paused.error || 'Google previous ad could not be paused');
        }
      }
      providerResource = created.adResourceName;
    }
    await this.persistResource(
      action,
      'ad',
      targetKey,
      action.platform === 'meta' ? providerResource : undefined,
      action.platform === 'google' ? providerResource : undefined,
      'active',
    );
    await db.execute(sql`
      UPDATE performance_ad_campaigns
      SET ad_creatives = jsonb_set(
        ad_creatives,
        ${`{${action.platform}}`}::text[],
        COALESCE(ad_creatives->${String(action.platform)}, '[]'::jsonb) || ${JSON.stringify([payload.creative])}::jsonb
      ), updated_at = NOW()
      WHERE id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
    `);
    return { creativeStored: true, replacementKey, providerResource, activated: true };
  }

  private async cleanup(action: ActionRow) {
    const resource = await this.findResource(action, 'campaign', 'campaign');
    if (!resource) return { alreadyClean: true };
    const cleanupAction = { ...action, action_type: 'pause' };
    const result = await this.setStatus(cleanupAction, 'paused');
    await this.markResourcesCleanup(action, 'paused');
    return result;
  }

  private async loadCampaign(action: ActionRow): Promise<ActionRow> {
    const result = await db.execute(sql`
      SELECT * FROM performance_ad_campaigns
      WHERE id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
      LIMIT 1
    `);
    if (!result.rows[0]) throw new Error('Tenant-owned campaign no longer exists.');
    return result.rows[0] as ActionRow;
  }

  private async loadAllocations(action: ActionRow): Promise<CampaignAllocation[]> {
    const result = await db.execute(sql`
      SELECT child_key, platform, allocated_amount, spent_amount
      FROM ad_campaign_allocations
      WHERE campaign_id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
      ORDER BY id
    `);
    return (result.rows as ActionRow[]).map((row) => ({
      key: row.child_key,
      platform: row.platform as AdPlatform,
      amount: Number(row.allocated_amount),
      spent: Number(row.spent_amount),
    }));
  }

  private async findResource(action: ActionRow, resourceType: string, localKey: string): Promise<ActionRow | null> {
    const result = await db.execute(sql`
      SELECT * FROM ad_provider_resources
      WHERE campaign_id = ${Number(action.campaign_id)}
        AND user_id = ${Number(action.user_id)}
        AND platform = ${String(action.platform)}
        AND resource_type = ${resourceType}
        AND local_key = ${localKey}
      ORDER BY id DESC LIMIT 1
    `);
    const resource = result.rows[0] as ActionRow || null;
    if (resource && ['publish', 'activate'].includes(action.action_type)
      && asObject(resource.metadata).publishReviewRevision !== asObject(asObject(action.payload).approvedReview).revision) {
      action.requiresFreshApproval = true;
      throw new Error('Existing provider resources belong to a different or legacy review. Create and review an improved campaign version; these resources will not be replaced automatically.');
    }
    return resource;
  }

  private async hasCompleteResourceGraph(action: ActionRow, allocations: CampaignAllocation[]): Promise<boolean> {
    const childType = action.platform === 'meta' ? 'ad_set' : 'ad_group';
    const result = await db.execute(sql`
      SELECT
        COUNT(DISTINCT local_key) FILTER (
          WHERE resource_type = ${childType}
            AND cleanup_status IS NULL
            AND COALESCE(provider_resource_name, provider_resource_id) IS NOT NULL
        ) AS child_count,
        COUNT(DISTINCT local_key) FILTER (
          WHERE resource_type = 'ad'
            AND cleanup_status IS NULL
            AND COALESCE(provider_resource_name, provider_resource_id) IS NOT NULL
        ) AS ad_count
      FROM ad_provider_resources
      WHERE campaign_id = ${Number(action.campaign_id)}
        AND user_id = ${Number(action.user_id)}
        AND platform = ${String(action.platform)}
        AND (${action.action_type !== 'publish'} OR metadata->>'publishReviewRevision' = ${String(asObject(asObject(action.payload).approvedReview).revision || '')})
    `);
    return Number(result.rows[0]?.child_count || 0) === allocations.length
      && Number(result.rows[0]?.ad_count || 0) === allocations.length;
  }

  private async hasFinalizedResourceGraph(action: ActionRow): Promise<boolean> {
    const result = await db.execute(sql`
      SELECT COUNT(*) AS unfinished_count
      FROM ad_provider_resources
      WHERE campaign_id = ${Number(action.campaign_id)}
        AND user_id = ${Number(action.user_id)}
        AND platform = ${String(action.platform)}
        AND cleanup_status IS NULL
        AND (${action.action_type !== 'publish'} OR metadata->>'publishReviewRevision' = ${String(asObject(asObject(action.payload).approvedReview).revision || '')})
        AND status <> ${asObject(asObject(action.payload).approvedReview).scope === 'live_activation_and_spend' ? 'active' : 'published'}
    `);
    return Number(result.rows[0]?.unfinished_count || 0) === 0;
  }

  private async persistResource(
    action: ActionRow,
    resourceType: string,
    localKey: string,
    providerId?: string,
    providerName?: string,
    status = 'created',
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO ad_provider_resources (
        campaign_id, user_id, platform, resource_type, local_key,
        provider_resource_id, provider_resource_name, status, idempotency_key, metadata
      ) VALUES (
        ${Number(action.campaign_id)}, ${Number(action.user_id)}, ${String(action.platform)},
        ${resourceType}, ${localKey}, ${providerId || null}, ${providerName || null},
        ${status}, ${`resource:${publishReviewRevision({ actionKey: action.idempotency_key, resourceType, localKey })}`},
        ${JSON.stringify({ publishReviewRevision: asObject(asObject(action.payload).approvedReview).revision, actionId: Number(action.id) })}::jsonb
      )
      ON CONFLICT (business_profile_id, user_id, platform, idempotency_key) DO UPDATE SET
        provider_resource_id = COALESCE(EXCLUDED.provider_resource_id, ad_provider_resources.provider_resource_id),
        provider_resource_name = COALESCE(EXCLUDED.provider_resource_name, ad_provider_resources.provider_resource_name),
        status = EXCLUDED.status, metadata = EXCLUDED.metadata, cleanup_status = NULL, error = NULL, updated_at = NOW()
    `);
  }

  private async updateLocalPublished(action: ActionRow, localStatus: string, providerStatus: string, requireClaim = false): Promise<void> {
    await db.transaction(async (tx: typeof db) => {
      if (requireClaim) {
        await tx.execute(sql`SELECT id FROM performance_ad_campaigns WHERE id=${Number(action.campaign_id)} AND user_id=${Number(action.user_id)} FOR UPDATE`);
        const owned=await tx.execute(sql`SELECT id FROM ad_action_queue WHERE ${this.claimFence(action)} FOR UPDATE`);
        if(!owned.rows.length)throw new Error('The retained launch was cancelled or its execution lease changed before local finalization.');
      }
      await reconcileCampaignProviderState(tx, action as {id:number;campaign_id:number;user_id:number;platform:string}, localStatus, providerStatus);
    });
  }

  private async markResourcesCleanup(action: ActionRow, status: string): Promise<void> {
    await db.execute(sql`
      UPDATE ad_provider_resources
      SET cleanup_status = ${status}, updated_at = NOW()
      WHERE campaign_id = ${Number(action.campaign_id)}
        AND user_id = ${Number(action.user_id)}
        AND platform = ${String(action.platform)}
        AND (${action.action_type !== 'publish'} OR metadata->>'publishReviewRevision' = ${String(asObject(asObject(action.payload).approvedReview).revision || '')})
    `);
  }

  private async markResourcesStatus(action: ActionRow, status: 'active' | 'published' | 'paused', executor: typeof db = db, requireClaim = false): Promise<void> {
    await executor.execute(sql`
      UPDATE ad_provider_resources
      SET status = ${status}, error = NULL, updated_at = NOW()
      WHERE campaign_id = ${Number(action.campaign_id)}
        AND user_id = ${Number(action.user_id)}
        AND platform = ${String(action.platform)}
        AND cleanup_status IS NULL
        ${requireClaim ? sql`AND EXISTS (SELECT 1 FROM ad_action_queue WHERE ${this.claimFence(action)})` : sql``}
        AND (${action.action_type !== 'publish'} OR metadata->>'publishReviewRevision' = ${String(asObject(asObject(action.payload).approvedReview).revision || '')})
    `);
  }

  private async cancelAction(action: ActionRow, reason: string): Promise<void> {
    await db.transaction(async (tx: typeof db) => {
      const cancelled = await tx.execute(sql`
        UPDATE ad_action_queue
        SET status = 'cancelled', last_error = ${reason}, completed_at = NOW(),
            locked_at = NULL, locked_by = NULL, updated_at = NOW()
        WHERE ${this.claimFence(action)} RETURNING id
      `);
      if (!cancelled.rows.length) return;
      await tx.execute(sql`
        INSERT INTO ad_action_audit (
          action_id, campaign_id, user_id, actor_type, action_type,
          rationale, metrics_snapshot, provider_outcome
        ) VALUES (
          ${Number(action.id)}, ${Number(action.campaign_id)}, ${Number(action.user_id)},
          'system', 'pause_cancelled', ${reason},
          ${JSON.stringify(action.metrics_snapshot || {})}::jsonb,
          ${JSON.stringify({ success: false, cancelled: true, reason })}::jsonb
        )
      `);
    });
  }

  private async deliverPauseNotifications(
    action: ActionRow,
    campaign: ActionRow,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    await this.processPendingNotifications(2, Number(action.id), {
      campaignName: String(campaign.name || `Campaign ${action.campaign_id}`),
      outcome,
    });
  }

  private async processPendingNotifications(
    limit: number,
    actionId?: number,
    context?: { campaignName: string; outcome: Record<string, unknown> },
  ): Promise<void> {
    const deliveries = await db.execute(sql`
      SELECT delivery.*, action.rationale, action.target_type, action.target_key,
        action.metrics_snapshot, action.provider_outcome, campaign.name AS campaign_name,
        campaign.budget_amount, campaign.spent_amount
      FROM ad_action_notification_deliveries delivery
      JOIN ad_action_queue action ON action.id = delivery.action_id
      JOIN performance_ad_campaigns campaign ON campaign.id = delivery.campaign_id
        AND campaign.user_id = delivery.user_id
      WHERE delivery.status IN ('pending', 'failed')
        AND delivery.available_at <= NOW()
        AND delivery.attempts < delivery.max_attempts
        ${actionId ? sql`AND delivery.action_id = ${actionId}` : sql``}
      ORDER BY delivery.id
      LIMIT ${limit}
    `);
    for (const row of deliveries.rows as ActionRow[]) {
      const outcome = context?.outcome || asObject(row.provider_outcome);
      const providerResource = String(outcome.providerResource || row.target_key || 'provider resource');
      const target = `${String(row.target_type || 'campaign').replace('_', ' ')} ${String(row.target_key || 'campaign')}`;
      const evidence = asObject(row.metrics_snapshot);
      const evaluatedMetrics = asObject(evidence.metrics);
      const remainingBudget = Math.max(0, Number(row.budget_amount || 0) - Number(row.spent_amount || 0));
      const savedSpendEstimate = Math.min(remainingBudget, Number(evaluatedMetrics.spend || 0) / 7);
      const savedSpend = savedSpendEstimate > 0 ? ` Estimated next-day spend avoided: ${money(savedSpendEstimate)}.` : '';
      const evidenceSummary = ` Evidence: ${Number(evaluatedMetrics.impressions || 0)} impressions, ${Number(evaluatedMetrics.clicks || 0)} clicks, ${Number(evaluatedMetrics.conversions || 0)} results, ${money(Number(evaluatedMetrics.spend || 0))} spent.`;
      const message = `${context?.campaignName || row.campaign_name}: AI action #${Number(row.action_id)} paused ${target}. ${row.rationale}${evidenceSummary} Provider resource: ${providerResource}.${savedSpend}`;
      let success = false;
      let error: string | null = null;
      try {
        if (row.channel === 'in_app') {
          success = await NotificationService.notify(
            Number(row.user_id),
            'AI paused an underperforming ad',
            message,
            'warning',
            { actionUrl: `/dashboard/ads/campaigns/managed/${Number(row.campaign_id)}?tab=automation&action=${Number(row.action_id)}` },
          );
          if (!success) error = 'In-app notification could not be persisted.';
        } else if (row.destination) {
          const { withInternalEmailDelivery } = await import('../InternalEmailDelivery.js');
          const sent = await withInternalEmailDelivery('ad_owner_alert', () => emailService.sendEmailWithUserCredentials(Number(row.user_id), {
            to: String(row.destination),
            subject: `AI paused an ad in ${context?.campaignName || row.campaign_name}`,
            text: `${message}\n\nReview or resume: /dashboard/ads/campaigns/managed/${Number(row.campaign_id)}?tab=automation&action=${Number(row.action_id)}`,
            html: `<p>${escapeHtml(message)}</p><p>Open Ad Performance to review the evidence or resume the unit.</p>`,
            userId: Number(row.user_id),
            idempotencyKey: `ad-pause-notification:${row.action_id}`,
          }));
          success = sent.success;
          error = sent.error || null;
        } else {
          error = 'No notification email is configured.';
        }
      } catch (deliveryError) {
        error = deliveryError instanceof Error ? deliveryError.message : 'Notification delivery failed.';
      }
      await db.execute(sql`
        UPDATE ad_action_notification_deliveries
        SET status = ${success ? 'succeeded' : 'failed'}, attempts = attempts + 1,
            last_error = ${success ? null : error}, delivered_at = ${success ? new Date() : null},
            available_at = NOW() + (LEAST(3600, 30 * POWER(2, attempts + 1)) * INTERVAL '1 second'),
            updated_at = NOW()
        WHERE id = ${Number(row.id)}
      `);
    }
  }

  private async fail(action: ActionRow, message: string): Promise<void> {
    // Meta does not have a reconciliation lookup here for a lost create
    // receipt. Repeating that call could spend against a duplicate campaign.
    const unknownMetaCreation = action.action_type === 'publish' && action.platform === 'meta'
      && asObject(action.payload).providerMutationStarted === true
      && !action.providerCreationComplete && !asObject(action.provider_outcome).providerCreationComplete;
    const retry = !action.requiresFreshApproval && !unknownMetaCreation && Number(action.attempts) < Number(action.max_attempts);
    const safeMessage = sanitizeProviderError(message);
    const errorCode = providerErrorCode(safeMessage);
    const granularPause = action.action_type === 'pause'
      && action.evaluation_id
      && String(action.target_type || 'campaign') !== 'campaign';
    await db.transaction(async (tx: typeof db) => {
      const failed = await tx.execute(sql`
        UPDATE ad_action_queue
        SET status = ${retry ? 'pending' : 'failed'},
            provider_outcome = COALESCE(provider_outcome, '{}'::jsonb) || ${JSON.stringify({
              status: action.providerCreationComplete ? 'activation_failed' : action.requiresFreshApproval ? 'blocked' : 'failed',
              ...(action.providerCreationComplete ? { providerCreationComplete: true } : {}),
              ...(action.providerPauseConfirmed !== undefined ? { safelyPaused: action.providerPauseConfirmed } : {}),
              requiresFreshApproval: action.requiresFreshApproval === true,
              reviewRevision: asObject(asObject(action.payload).approvedReview).revision,
            })}::jsonb,
            available_at = NOW() + (${Math.min(3600, 30 * (2 ** Number(action.attempts)))} * INTERVAL '1 second'),
            last_error = ${safeMessage}, locked_at = NULL, locked_by = NULL, updated_at = NOW()
        WHERE ${this.claimFence(action)} RETURNING id
      `);
      if (!failed.rows.length) return;
      if (granularPause) {
        await tx.execute(sql`
          UPDATE ad_provider_resources
          SET error = ${safeMessage}, updated_at = NOW()
          WHERE campaign_id = ${Number(action.campaign_id)} AND user_id = ${Number(action.user_id)}
            AND platform = ${String(action.platform)} AND resource_type = ${String(action.target_type)}
            AND local_key = ${String(action.target_key)} AND cleanup_status IS NULL
        `);
      } else {
        await tx.execute(sql`
          UPDATE performance_ad_campaigns campaign
          SET status = CASE WHEN EXISTS (
                SELECT 1 FROM ad_campaign_allocations allocation
                WHERE allocation.campaign_id = campaign.id AND allocation.user_id = campaign.user_id
                  AND allocation.platform <> ${String(action.platform)} AND allocation.status = 'active'
              ) THEN 'partial_success' ELSE ${retry ? 'uncertain' : 'provider_failed'} END,
              local_status = CASE WHEN EXISTS (
                SELECT 1 FROM ad_campaign_allocations allocation
                WHERE allocation.campaign_id = campaign.id AND allocation.user_id = campaign.user_id
                  AND allocation.platform <> ${String(action.platform)} AND allocation.status = 'active'
              ) THEN 'partial_success' ELSE ${retry ? 'uncertain' : 'provider_failed'} END,
              is_active = (NOT ${action.providerPauseConfirmed === true} AND COALESCE(campaign.is_active, FALSE)) OR EXISTS (
                SELECT 1 FROM ad_campaign_allocations allocation
                WHERE allocation.campaign_id = campaign.id AND allocation.user_id = campaign.user_id
                  AND allocation.platform <> ${String(action.platform)} AND allocation.status = 'active'
              ),
              last_provider_error = ${safeMessage}, updated_at = NOW()
          WHERE campaign.id = ${Number(action.campaign_id)} AND campaign.user_id = ${Number(action.user_id)}
        `);
        await tx.execute(sql`
          UPDATE ad_campaign_allocations
          SET status = ${retry ? 'uncertain' : 'provider_failed'}, updated_at = NOW()
          WHERE campaign_id = ${Number(action.campaign_id)}
            AND user_id = ${Number(action.user_id)}
            AND platform = ${String(action.platform)}
        `);
      }
      await tx.execute(sql`
        INSERT INTO ad_action_audit (
          action_id, campaign_id, user_id, actor_type, action_type,
          rationale, metrics_snapshot, provider_outcome
        ) VALUES (
          ${Number(action.id)}, ${Number(action.campaign_id)}, ${Number(action.user_id)},
          'provider', ${String(action.action_type)}, ${String(action.rationale)},
          ${JSON.stringify(action.metrics_snapshot || {})}::jsonb,
          ${JSON.stringify({ success: false, error: safeMessage, errorCode, retry, outcome: retry ? 'uncertain' : 'failed' })}::jsonb
        )
      `);
    });
    logger.error({ actionId: action.id, campaignId: action.campaign_id, errorCode, error: safeMessage }, '[AutonomousAds] Provider action failed');
  }

  private async deferAction(action: ActionRow, reason: string): Promise<void> {
    const actionId = Number(action.id);
    await db.transaction(async (tx: typeof db) => {
      const deferred = await tx.execute(sql`
        UPDATE ad_action_queue
        SET status = 'pending', available_at = NOW() + INTERVAL '5 minutes',
            last_error = ${reason}, locked_at = NULL, locked_by = NULL, updated_at = NOW()
        WHERE ${this.claimFence(action)} RETURNING id
      `);
      if (!deferred.rows.length) return;
      // A blocked pause never changes provider delivery. Keep its monitoring
      // state eligible for reporting and advisory evaluation.
      if (action.action_type === 'pause') return;
      await tx.execute(sql`
        UPDATE performance_ad_campaigns campaign
        SET local_status = 'gated', last_provider_error = ${reason}, updated_at = NOW()
        FROM ad_action_queue action
        WHERE action.id = ${Number(actionId)}
          AND campaign.id = action.campaign_id
          AND campaign.user_id = action.user_id
      `);
      await tx.execute(sql`
        UPDATE ad_campaign_allocations allocation
        SET status = 'gated', updated_at = NOW()
        FROM ad_action_queue action
        WHERE action.id = ${Number(actionId)}
          AND allocation.campaign_id = action.campaign_id
          AND allocation.user_id = action.user_id
          AND allocation.platform = action.platform
      `);
    });
  }

  private async deferGated(limit: number): Promise<number> {
    const result = await db.execute(sql`
      WITH candidates AS (
        SELECT id FROM ad_action_queue
        WHERE status = 'pending' AND available_at <= NOW()
          AND action_type <> 'sync_analytics'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE ad_action_queue q
      SET available_at = NOW() + INTERVAL '5 minutes',
          last_error = 'Environment provider mutation gate is disabled',
          updated_at = NOW()
      FROM candidates WHERE q.id = candidates.id
      RETURNING q.id, q.campaign_id, q.user_id, q.action_type
    `);
    for (const row of result.rows as Array<Record<string, unknown>>) {
      if (row.action_type === 'pause') continue;
      await db.execute(sql`
        UPDATE performance_ad_campaigns
        SET local_status = 'gated',
            last_provider_error = 'Environment provider mutation gate is disabled',
            updated_at = NOW()
        WHERE id = ${Number(row.campaign_id)} AND user_id = ${Number(row.user_id)}
      `);
      await db.execute(sql`
        UPDATE ad_campaign_allocations allocation
        SET status = 'gated', updated_at = NOW()
        FROM ad_action_queue action
        WHERE action.id = ${Number(row.id)}
          AND allocation.campaign_id = action.campaign_id
          AND allocation.user_id = action.user_id
          AND allocation.platform = action.platform
      `);
    }
    return result.rows.length;
  }
}

export const autonomousAdsActionProcessor = new AutonomousAdsActionProcessor();
