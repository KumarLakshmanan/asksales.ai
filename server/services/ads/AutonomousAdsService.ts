import { reconcileCampaignProviderState } from './CampaignProviderState.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { businessAuditActor } from '../../tenancy/businessContext.js';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { getMetaAdsCreds } from '../../models/metaPageConnections/functions.js';
import { getGoogleAdsCredentials } from '../../controllers/integrationsController.js';
import {
  inferCampaignObjective,
  money,
  validateCampaignForActivation,
  type AdLocation,
  type AdObjective,
  type AdPlatform,
  type CampaignAllocation,
  type ObjectiveInference,
} from './AutonomousAdsDomain.js';
import {
  defaultGoogleProviderConfig,
  defaultMetaProviderConfig,
  validateProviderCampaign,
  type ProviderAccountSnapshot,
  type ProviderCampaignConfig,
} from './ProviderCampaignContract.js';
import { resolveContentBrandContext } from '../content/ContentBrandContextService.js';
import { adPerformanceService } from './AdPerformanceService.js';
import { CampaignPublishPreflightError, assertReviewedProviderAccount, buildCampaignPublishReview, publishReviewRevision } from './CampaignPublishReview.js';
import { campaignCurrencyScale, type ApprovedCampaignPublishReview, type CampaignPublishReview } from '../../../shared/adCampaignReview.js';

export interface AdSettings {
  defaultLifetimeBudget: number;
  currency: string;
  locations: AdLocation[];
  autonomousOptimizationEnabled: boolean;
  liveProviderMutationsEnabled: boolean;
  analyticsSyncMinutes: number;
}

export interface AutonomousCampaignDraft {
  name: string;
  description?: string;
  brief?: string;
  contentStudioContext?: string;
  conversationContext?: string;
  objective?: AdObjective;
  objectiveRationale?: string;
  platforms: AdPlatform[];
  lifetimeBudget?: number;
  currency?: string;
  locations?: AdLocation[];
  landingPageUrl: string;
  startDate: Date;
  endDate?: Date | null;
  allocations?: CampaignAllocation[];
  creatives: Partial<Record<AdPlatform, unknown[]>>;
  providerConfig?: ProviderCampaignConfig;
  context?: {
    businessProfileId?: number;
    brandToolkitId?: number;
    icpId?: number;
    threadId?: number;
    providerAccountIds?: { meta?: string; google?: string };
    creativeRevision?: number;
    creativeSources?: Array<{
      sourceType: 'content_asset' | 'content_template';
      sourceId: number;
      sourceVersion: number;
      updatedAt?: string;
    }>;
    scheduleDates?: { startDate: string; endDate?: string };
    placements?: string[];
  };
  idempotencyKey: string;
  autoActivate?: boolean;
  activationConfirmation?: LiveActivationConfirmation;
  publish?: boolean;
  allowAiPause?: boolean;
}

export interface LiveActivationConfirmation {
  confirmedAt: Date | string;
  source: 'direct_review' | 'conversation_approval';
  scope: 'live_activation_and_spend';
  campaignName: string;
  platforms: AdPlatform[];
  lifetimeBudget: number;
  currency: string;
}

export interface AccountReadiness {
  meta: boolean;
  google: boolean;
  reasons: Partial<Record<AdPlatform, string>>;
  currencies: Partial<Record<AdPlatform, string>>;
  accounts: ProviderAccountSnapshot;
}

const DEFAULT_SETTINGS: AdSettings = {
  defaultLifetimeBudget: 100,
  currency: 'USD',
  locations: [],
  autonomousOptimizationEnabled: false,
  liveProviderMutationsEnabled: false,
  analyticsSyncMinutes: 15,
};

const ACTIVATION_CONFIRMATION_MAX_AGE_MS = 10 * 60 * 1000;

export function activationConfirmationError(
  input: {
    autoActivate?: boolean;
    confirmation?: LiveActivationConfirmation;
    campaignName: string;
    platforms: AdPlatform[];
    lifetimeBudget: number;
    currency: string;
  },
  now = new Date(),
): string | null {
  if (input.autoActivate !== true) return null;
  const confirmation = input.confirmation;
  if (!confirmation) return 'Fresh confirmation is required before live activation and spend can be queued.';
  const confirmedAt = new Date(confirmation.confirmedAt).getTime();
  const age = now.getTime() - confirmedAt;
  if (!Number.isFinite(confirmedAt) || age < -60_000 || age > ACTIVATION_CONFIRMATION_MAX_AGE_MS) {
    return 'The live activation confirmation expired. Review the campaign and confirm again.';
  }
  if (confirmation.scope !== 'live_activation_and_spend') {
    return 'The confirmation does not authorize live activation and spend.';
  }
  if (confirmation.campaignName !== input.campaignName.trim()) {
    return 'The campaign name changed after live activation was confirmed.';
  }
  if (
    confirmation.platforms.length !== input.platforms.length
    || input.platforms.some((platform) => !confirmation.platforms.includes(platform))
  ) {
    return 'The selected ad platforms changed after live activation was confirmed.';
  }
  if (money(confirmation.lifetimeBudget) !== money(input.lifetimeBudget) || confirmation.currency.toUpperCase() !== input.currency.toUpperCase()) {
    return 'The budget or currency changed after live activation was confirmed.';
  }
  return null;
}

function rowToSettings(row: Record<string, unknown> | undefined): AdSettings {
  if (!row) return DEFAULT_SETTINGS;
  return {
    defaultLifetimeBudget: Number(row.default_lifetime_budget || 100),
    currency: String(row.currency || 'USD'),
    locations: Array.isArray(row.locations) ? row.locations as AdLocation[] : [],
    autonomousOptimizationEnabled: row.autonomous_optimization_enabled === true,
    liveProviderMutationsEnabled: row.live_provider_mutations_enabled === true,
    analyticsSyncMinutes: Number(row.analytics_sync_minutes || 15),
  };
}

export class AutonomousAdsService {
  async getSettings(userId: number): Promise<AdSettings> {
    const result = await db.execute(sql`
      SELECT default_lifetime_budget, currency, locations,
             autonomous_optimization_enabled, live_provider_mutations_enabled,
             analytics_sync_minutes
      FROM ad_settings
      WHERE user_id = ${userId}
      LIMIT 1
    `);
    return rowToSettings(result.rows[0] as Record<string, unknown> | undefined);
  }

  async updateSettings(userId: number, settings: AdSettings): Promise<AdSettings> {
    const result = await db.execute(sql`
      INSERT INTO ad_settings (
        user_id, default_lifetime_budget, currency, locations,
        autonomous_optimization_enabled, live_provider_mutations_enabled,
        analytics_sync_minutes, updated_at
      ) VALUES (
        ${userId}, ${money(settings.defaultLifetimeBudget)}, ${settings.currency},
        ${JSON.stringify(settings.locations)}::jsonb,
        ${settings.autonomousOptimizationEnabled}, ${settings.liveProviderMutationsEnabled},
        ${settings.analyticsSyncMinutes}, NOW()
      )
      ON CONFLICT (business_profile_id, user_id) DO UPDATE SET
        default_lifetime_budget = EXCLUDED.default_lifetime_budget,
        currency = EXCLUDED.currency,
        locations = EXCLUDED.locations,
        autonomous_optimization_enabled = EXCLUDED.autonomous_optimization_enabled,
        live_provider_mutations_enabled = EXCLUDED.live_provider_mutations_enabled,
        analytics_sync_minutes = EXCLUDED.analytics_sync_minutes,
        updated_at = NOW()
      RETURNING default_lifetime_budget, currency, locations,
                autonomous_optimization_enabled, live_provider_mutations_enabled,
                analytics_sync_minutes
    `);
    return rowToSettings(result.rows[0] as Record<string, unknown>);
  }

  async getAccountReadiness(userId: number, verifyProvider = false): Promise<AccountReadiness> {
    const [metaCredentials, googleCredentials] = await Promise.all([
      getMetaAdsCreds(userId),
      getGoogleAdsCredentials(userId),
    ]);
    const metaReady = Boolean(
      metaCredentials?.accessToken
      && metaCredentials.adAccountId
      && metaCredentials.pageId
      && metaCredentials.adAccountCurrency,
    );
    const googleReady = Boolean(
      googleCredentials?.clientId
      && googleCredentials.clientSecret
      && googleCredentials.developerToken
      && /^\d{10}$/.test(googleCredentials.customerId || '')
      && googleCredentials.refreshToken,
    );
    let verifiedMeta = metaReady;
    let verifiedGoogle = googleReady;
    let metaReason = metaReady ? undefined : 'Select a valid Meta ad account and Facebook Page, then reconnect if the token is expired.';
    let googleReason = googleReady ? undefined : 'Select a 10-digit Google Ads customer and configure OAuth plus the developer token.';
    let googleCurrency: string | undefined;
    let googleAccountName: string | undefined;
    let googleTimeZone: string | undefined;
    if (verifyProvider && metaReady && metaCredentials) {
      const { MetaAdsService } = await import('./MetaAdsService.js');
      const result = await new MetaAdsService({
        accessToken: metaCredentials.accessToken,
        adAccountId: metaCredentials.adAccountId,
        expiresAt: metaCredentials.expiresAt || undefined,
      }).getAdAccount();
      verifiedMeta = Boolean(result.success && Number(result.account?.account_status) === 1);
      metaReason = verifiedMeta ? undefined : result.error || 'The selected Meta ad account is not active.';
    }
    if (verifyProvider && googleReady && googleCredentials) {
      const { getGoogleAdsAccountInfo } = await import('./GoogleAdsService.js');
      const result = await getGoogleAdsAccountInfo(googleCredentials);
      verifiedGoogle = Boolean(result.valid && result.account && !result.account.manager);
      googleCurrency = result.account?.currency;
      googleAccountName = result.account?.name;
      googleTimeZone = result.account?.timeZone;
      googleReason = verifiedGoogle
        ? undefined
        : result.account?.manager
          ? 'Select a client Google Ads account; manager accounts cannot host campaigns.'
          : result.error || 'The selected Google Ads customer is not ready.';
    }
    return {
      meta: verifiedMeta,
      google: verifiedGoogle,
      reasons: { meta: metaReason, google: googleReason },
      currencies: { meta: metaCredentials?.adAccountCurrency || undefined, google: googleCurrency },
      accounts: {
        capturedAt: new Date().toISOString(),
        meta: metaCredentials ? {
          adAccountId: metaCredentials.adAccountId,
          adAccountName: metaCredentials.adAccountName || undefined,
          pageId: metaCredentials.pageId,
          pageName: metaCredentials.pageName || undefined,
          instagramAccountId: metaCredentials.instagramAccountId || undefined,
          instagramUsername: metaCredentials.instagramUsername || undefined,
          currency: metaCredentials.adAccountCurrency || undefined,
          timezone: metaCredentials.adAccountTimezone || undefined,
        } : undefined,
        google: googleCredentials ? {
          customerId: googleCredentials.customerId,
          accountName: googleAccountName,
          managerAccountId: googleCredentials.managerAccountId || undefined,
          currency: googleCurrency,
          timezone: googleTimeZone,
        } : undefined,
      },
    };
  }

  inferObjective(input: Pick<AutonomousCampaignDraft, 'brief' | 'contentStudioContext' | 'conversationContext'>): ObjectiveInference | null {
    return inferCampaignObjective(input);
  }

  async createCampaign(userId: number, draft: AutonomousCampaignDraft): Promise<Record<string, unknown>> {
    const settings = await this.getSettings(userId);
    const readiness = await this.getAccountReadiness(userId, true);
    const resolvedBrandContext = draft.context?.businessProfileId || draft.context?.brandToolkitId
      ? await resolveContentBrandContext(userId, {
        businessProfileId: draft.context.businessProfileId,
        brandToolkitId: draft.context.brandToolkitId,
      })
      : null;
    const authoritativeContext = {
      ...(draft.context || {}),
      ...(resolvedBrandContext ? {
        businessProfileId: resolvedBrandContext.businessProfile.id,
        brandToolkitId: resolvedBrandContext.brandToolkit.id,
      } : {}),
    };
    const inferred = draft.objective
      ? {
        objective: draft.objective,
        confidence: 1,
        source: 'campaign_brief' as const,
        rationale: draft.objectiveRationale || 'Objective explicitly selected by the client.',
      }
      : this.inferObjective(draft);
    const lifetimeBudget = money(draft.lifetimeBudget ?? settings.defaultLifetimeBudget);
    const currency = (draft.currency || settings.currency).toUpperCase();
    const locations = draft.locations?.length ? draft.locations : settings.locations;
    const objectiveForDefaults = inferred?.objective || 'traffic';
    const providerConfig: ProviderCampaignConfig = {
      meta: draft.platforms.includes('meta')
        ? { ...defaultMetaProviderConfig(objectiveForDefaults), ...(draft.providerConfig?.meta || {}) }
        : undefined,
      google: draft.platforms.includes('google')
        ? { ...defaultGoogleProviderConfig(), ...(draft.providerConfig?.google || {}) }
        : undefined,
    };
    const allocations = draft.allocations?.length
      ? draft.allocations
      : this.createEvenAllocations(lifetimeBudget, draft.platforms, draft.creatives, currency);
    const validationErrors = validateCampaignForActivation({
      objective: inferred?.objective || null,
      objectiveConfidence: inferred?.confidence ?? null,
      lifetimeBudget,
      currency,
      allocations,
      startDate: draft.startDate,
      endDate: draft.endDate,
      landingPageUrl: draft.landingPageUrl,
      locations,
      platforms: draft.platforms,
      accountReadiness: readiness,
      creativesCount: {
        meta: draft.creatives.meta?.length || 0,
        google: draft.creatives.google?.length || 0,
      },
    });
    const confirmationError = activationConfirmationError({
      autoActivate: draft.autoActivate,
      confirmation: draft.activationConfirmation,
      campaignName: draft.name,
      platforms: draft.platforms,
      lifetimeBudget,
      currency,
    });
    if (confirmationError) validationErrors.push(confirmationError);
    for (const platform of draft.platforms) {
      if (!readiness[platform] && readiness.reasons[platform]) {
        validationErrors.push(readiness.reasons[platform]!);
      }
      const providerCurrency = readiness.currencies[platform];
      if (providerCurrency && providerCurrency.toUpperCase() !== currency) {
        validationErrors.push(`${platform} account currency ${providerCurrency} does not match campaign currency ${currency}.`);
      }
      const requestedAccountId = draft.context?.providerAccountIds?.[platform]?.replace(/\D/g, '');
      const selectedAccountId = platform === 'google'
        ? readiness.accounts.google?.customerId.replace(/\D/g, '')
        : readiness.accounts.meta?.adAccountId.replace(/^act_/, '').replace(/\D/g, '');
      if (requestedAccountId && selectedAccountId && requestedAccountId !== selectedAccountId) {
        validationErrors.push(`The reviewed ${platform} account does not match the currently selected provider account.`);
      }
    }
    if (inferred?.objective) {
      validationErrors.push(...validateProviderCampaign({
        platforms: draft.platforms,
        objective: inferred.objective,
        campaignName: draft.name,
        landingPageUrl: draft.landingPageUrl,
        creatives: draft.creatives,
        providerConfig,
        hasEndDate: Boolean(draft.endDate),
      }));
    }
    const providerMutationsEnabled = settings.liveProviderMutationsEnabled
      && process.env.AD_PROVIDER_MUTATIONS_ENABLED === 'true';
    const publishState = draft.publish === false
      ? 'draft'
      : validationErrors.length
        ? 'validation_failed'
        : providerMutationsEnabled
          ? 'queued'
          : 'gated';

    return await db.transaction(async (tx: typeof db) => {
      const existing = await tx.execute(sql`
        SELECT * FROM performance_ad_campaigns
        WHERE user_id = ${userId} AND idempotency_key = ${draft.idempotencyKey}
        LIMIT 1
      `);
      if (existing.rows[0]) {
        const existingCampaign = existing.rows[0] as Record<string, unknown>;
        const existingSettings = existingCampaign.settings && typeof existingCampaign.settings === 'object'
          ? existingCampaign.settings as Record<string, unknown>
          : {};
        return {
          ...existingCampaign,
          validationErrors: Array.isArray(existingCampaign.validation_errors)
            ? existingCampaign.validation_errors
            : [],
          publishState: existingCampaign.local_status,
          accountSnapshot: existingSettings.accountSnapshot,
          providerConfig: existingSettings.providerConfig,
          idempotentReplay: true,
        };
      }

      const campaignResult = await tx.execute(sql`
        INSERT INTO performance_ad_campaigns (
          user_id, name, description, objective, objective_source, objective_rationale,
          ad_platform, budget_type, budget_amount, currency, spent_amount,
          targeting, locations, landing_page_url, ad_creatives,
          start_date, end_date, status, local_status, provider_status,
          is_active, validation_errors, content_context, idempotency_key,
          auto_activate, settings
        ) VALUES (
          ${userId}, ${draft.name}, ${draft.description || null},
          ${inferred?.objective || 'unresolved'}, ${inferred?.source || null},
          ${inferred?.rationale || 'Objective inference is unresolved and requires client review.'},
          ${draft.platforms.length === 2 ? 'multi' : draft.platforms[0]},
          'lifetime', ${lifetimeBudget}, ${currency}, 0,
          ${JSON.stringify({ locations })}::jsonb, ${JSON.stringify(locations)}::jsonb,
          ${draft.landingPageUrl}, ${JSON.stringify(draft.creatives)}::jsonb,
          ${draft.startDate}, ${draft.endDate || null}, 'draft',
          ${publishState},
          NULL, FALSE, ${JSON.stringify([...new Set(validationErrors)])}::jsonb,
          ${JSON.stringify({
            brief: draft.brief,
            contentStudioContext: draft.contentStudioContext,
            conversationContext: draft.conversationContext,
            objectiveConfidence: inferred?.confidence,
            brandContextProvenance: resolvedBrandContext?.provenance,
          })}::jsonb,
          ${draft.idempotencyKey}, ${draft.autoActivate === true},
          ${JSON.stringify({
            accountReadiness: readiness,
            accountSnapshot: readiness.accounts,
            providerConfig,
            context: authoritativeContext,
            activationConfirmation: draft.activationConfirmation ? {
              ...draft.activationConfirmation,
              confirmedAt: new Date(draft.activationConfirmation.confirmedAt).toISOString(),
            } : undefined,
            brandContextSnapshot: resolvedBrandContext?.provenance,
            platforms: draft.platforms,
          })}::jsonb
        )
        RETURNING *
      `);
      const campaign = campaignResult.rows[0] as Record<string, unknown>;
      const campaignId = Number(campaign.id);
      await tx.execute(sql`
        INSERT INTO ad_campaign_autonomy_policies (
          campaign_id, user_id, enabled, thresholds, consent_policy_version,
          consented_at, consented_by_user_id, revoked_at, updated_at
        ) VALUES (
          ${campaignId}, ${userId}, ${draft.allowAiPause === true}, '{}'::jsonb,
          'ads-pause-v1', ${draft.allowAiPause === true ? new Date() : null},
          ${draft.allowAiPause === true ? businessAuditActor(userId) : null}, ${draft.allowAiPause === true ? null : new Date()}, NOW()
        )
        ON CONFLICT (business_profile_id, campaign_id, user_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          thresholds = EXCLUDED.thresholds,
          consent_policy_version = EXCLUDED.consent_policy_version,
          consented_at = EXCLUDED.consented_at,
          consented_by_user_id = EXCLUDED.consented_by_user_id,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW()
      `);
      for (const allocation of allocations) {
        await tx.execute(sql`
          INSERT INTO ad_campaign_allocations (
            campaign_id, user_id, platform, child_type, child_key,
            allocated_amount, spent_amount, status
          ) VALUES (
            ${campaignId}, ${userId}, ${allocation.platform},
            ${allocation.platform === 'meta' ? 'ad_set' : 'ad_group'},
            ${allocation.key}, ${money(allocation.amount)}, ${money(allocation.spent || 0)}, 'draft'
          )
        `);
      }
      await this.audit(tx, {
        campaignId,
        userId,
        actorType: inferred ? 'ai' : 'system',
        actionType: 'create_campaign',
        rationale: inferred?.rationale || 'Campaign saved with unresolved objective; provider actions blocked.',
        metricsSnapshot: { validationErrors, readiness, inferred },
        budgetBefore: 0,
        budgetAfter: lifetimeBudget,
      });
      if (draft.allowAiPause === true) {
        await this.audit(tx, {
          campaignId,
          userId,
          actorType: 'user',
          actionType: 'autonomy_campaign_consent',
          rationale: 'Campaign AI pause consent granted during campaign review.',
          metricsSnapshot: { policyVersion: 'ads-pause-v1', allowedAction: 'pause' },
          budgetBefore: lifetimeBudget,
          budgetAfter: lifetimeBudget,
        });
      }
      if (draft.activationConfirmation) {
        await this.audit(tx, {
          campaignId,
          userId,
          actorType: 'user',
          actionType: 'confirm_live_activation',
          rationale: `Live activation and spend confirmed through ${draft.activationConfirmation.source}.`,
          metricsSnapshot: {
            confirmedAt: new Date(draft.activationConfirmation.confirmedAt).toISOString(),
            scope: draft.activationConfirmation.scope,
            platforms: draft.activationConfirmation.platforms,
            lifetimeBudget: draft.activationConfirmation.lifetimeBudget,
            currency: draft.activationConfirmation.currency,
          },
          budgetBefore: lifetimeBudget,
          budgetAfter: lifetimeBudget,
        });
      }
      if (validationErrors.length === 0 && draft.publish !== false) {
        const review = buildCampaignPublishReview(campaign, allocations);
        const approvedReview: ApprovedCampaignPublishReview = {
          schemaVersion: 1,
          revision: review.revision,
          snapshot: review.snapshot,
          approvedAt: draft.activationConfirmation
            ? new Date(draft.activationConfirmation.confirmedAt).toISOString()
            : new Date().toISOString(),
          scope: draft.autoActivate === true ? 'live_activation_and_spend' : 'paused_creation',
        };
        for (const platform of draft.platforms) {
          await this.enqueue(tx, {
            campaignId,
            userId,
            platform,
            actionType: 'publish',
            idempotencyKey: `${draft.idempotencyKey}:${platform}:publish:v1`,
            payload: { autoActivate: draft.autoActivate === true, actorType: 'user', approvedReview },
            rationale: 'Campaign passed all financial, targeting, objective, creative, date, landing page, and account readiness checks.',
          });
        }
      }
      return {
        ...campaign,
        inferredObjective: inferred,
        validationErrors: [...new Set(validationErrors)],
        accountReadiness: readiness,
        allocations,
        providerMutationsEnabled,
        publishState,
        accountSnapshot: readiness.accounts,
        providerConfig,
      };
    });
  }

  async getCampaign(userId: number, campaignId: number): Promise<Record<string, unknown> | null> {
    const result = await db.execute(sql`
      SELECT pac.*,
        COALESCE((
          SELECT jsonb_agg(a ORDER BY a.id)
          FROM ad_campaign_allocations a
          WHERE a.campaign_id = pac.id AND a.user_id = ${userId}
        ), '[]'::jsonb) AS allocations,
        COALESCE((
          SELECT jsonb_agg(q ORDER BY q.created_at DESC)
          FROM ad_action_queue q
          WHERE q.campaign_id = pac.id AND q.user_id = ${userId}
        ), '[]'::jsonb) AS actions,
        COALESCE((
          SELECT jsonb_agg(h ORDER BY h.created_at DESC)
          FROM ad_action_audit h
          WHERE h.campaign_id = pac.id AND h.user_id = ${userId}
        ), '[]'::jsonb) AS audit_history
      FROM performance_ad_campaigns pac
      WHERE pac.id = ${campaignId} AND pac.user_id = ${userId}
      LIMIT 1
    `);
    return result.rows[0] as Record<string, unknown> || null;
  }

  async recordReviewOutcome(
    userId: number,
    campaignId: number,
    status: 'blocked' | 'gated',
    validationErrors: string[] = [],
  ): Promise<void> {
    await db.execute(sql`
      UPDATE performance_ad_campaigns
      SET local_status = ${status},
          validation_errors = ${JSON.stringify([...new Set(validationErrors)])}::jsonb,
          updated_at = NOW()
      WHERE id = ${campaignId} AND user_id = ${userId}
    `);
  }

  async getPublishReview(userId: number, campaignId: number): Promise<CampaignPublishReview> {
    const campaign = await this.getCampaign(userId, campaignId);
    if (!campaign) throw new Error('Campaign not found.');
    const allocations = (Array.isArray(campaign.allocations) ? campaign.allocations : []) as Array<Record<string, unknown>>;
    return buildCampaignPublishReview(campaign, allocations.map(row => ({
      key: String(row.child_key), platform: row.platform as AdPlatform,
      amount: Number(row.allocated_amount), spent: Number(row.spent_amount || 0),
    })));
  }

  async queueExistingCampaignPlatform(
    userId: number,
    campaignId: number,
    platform: AdPlatform,
    requestKey: string,
    reviewRevision?: string,
  ): Promise<{ campaignId: number; platform: AdPlatform; queued: boolean; status: string; actionId: number; replayed?: boolean; error?: string }> {
    if (!reviewRevision || !/^[a-f0-9]{64}$/.test(reviewRevision)) {
      throw new Error('Open the saved campaign review and approve its current revision before publishing.');
    }
    return db.transaction(async (tx: typeof db) => {
      const result = await tx.execute(sql`
        SELECT * FROM performance_ad_campaigns
        WHERE id = ${campaignId} AND user_id = ${userId} FOR UPDATE
      `);
      const campaign = result.rows[0] as Record<string, unknown> | undefined;
      if (!campaign) throw new Error('Campaign not found.');
      const idempotencyKey = `campaign:${campaignId}:review:${reviewRevision}:approval:${publishReviewRevision(requestKey).slice(0, 24)}:${platform}`;
      const prior = await tx.execute(sql`
        SELECT id, status, provider_outcome, last_error FROM ad_action_queue
        WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey} LIMIT 1
      `);
      if (prior.rows[0]) {
        const action = prior.rows[0] as Record<string, unknown>;
        const outcome = action.provider_outcome as Record<string, unknown> | null;
        const status = action.status === 'succeeded'
          ? outcome?.activated === true ? 'active' : 'provider_created'
          : action.status === 'pending' ? 'queued' : action.status === 'processing' ? 'running' : String(action.status);
        return { campaignId, platform, queued: status === 'queued', status, actionId: Number(action.id), replayed: true,
          ...(action.last_error ? { error: String(action.last_error) } : {}) };
      }
      const allocationRows = await tx.execute(sql`
        SELECT child_key, platform, allocated_amount, spent_amount FROM ad_campaign_allocations
        WHERE campaign_id = ${campaignId} AND user_id = ${userId} ORDER BY id FOR UPDATE
      `);
      const allocations = (allocationRows.rows as Array<Record<string, unknown>>).map(row => ({
        key: String(row.child_key), platform: row.platform as AdPlatform,
        amount: Number(row.allocated_amount), spent: Number(row.spent_amount || 0),
      }));
      const review = buildCampaignPublishReview(campaign, allocations);
      if (review.revision !== reviewRevision) throw new CampaignPublishPreflightError('The campaign changed after review. Reload the review before approving it.');
      if (!review.snapshot.platforms.includes(platform)) throw new CampaignPublishPreflightError(`${platform} is not configured for this campaign.`);
      // Cancellation does not prove an activation request already sent has
      // settled. Reuse the reconciliation gate before accepting fresh authority.
      const unfinished = await tx.execute(sql`
        SELECT id, status FROM ad_action_queue
        WHERE campaign_id = ${campaignId} AND user_id = ${userId} AND platform = ${platform}
          AND action_type = 'publish' AND (status IN ('pending', 'processing')
            OR (status='cancelled' AND (provider_outcome->>'status'='activation_requested'
              OR provider_outcome->>'requiresReconciliation'='true'))) LIMIT 1
      `);
      if (unfinished.rows.length) throw new CampaignPublishPreflightError('An earlier launch for this platform is still being reconciled. No duplicate provider action was queued.');
      const uncertain = await tx.execute(sql`
        SELECT id FROM ad_action_queue
        WHERE campaign_id = ${campaignId} AND user_id = ${userId} AND platform = ${platform}
          AND action_type = 'publish' AND status = 'failed'
          AND payload->>'providerMutationStarted' = 'true'
          AND COALESCE(provider_outcome->>'providerCreationComplete', 'false') <> 'true' LIMIT 1
      `);
      if (uncertain.rows.length) throw new CampaignPublishPreflightError('An earlier provider request may have created resources. Reconcile that request before approving another launch.');
      const gate = await tx.execute(sql`SELECT live_provider_mutations_enabled FROM ad_settings WHERE user_id = ${userId} LIMIT 1`);
      if (process.env.AD_PROVIDER_MUTATIONS_ENABLED !== 'true' || gate.rows[0]?.live_provider_mutations_enabled !== true) {
        throw new CampaignPublishPreflightError('Live provider mutations are gated.', 'gated');
      }
      const readiness = await this.getAccountReadiness(userId, true);
      if (!readiness[platform]) throw new CampaignPublishPreflightError(readiness.reasons[platform] || `${platform} advertising account is not ready.`);
      try { assertReviewedProviderAccount(review.snapshot, readiness.accounts, platform); }
      catch (error) { throw new CampaignPublishPreflightError(error instanceof Error ? error.message : 'The reviewed provider account changed.'); }
      const errors = [...review.validationErrors, ...(review.platformErrors[platform] || []), ...validateCampaignForActivation({
        objective: campaign.objective as AdObjective,
        objectiveConfidence: 1,
        lifetimeBudget: Number(campaign.budget_amount),
        currency: String(campaign.currency),
        allocations,
        startDate: new Date(String(campaign.start_date)),
        endDate: campaign.end_date ? new Date(String(campaign.end_date)) : null,
        landingPageUrl: String(campaign.landing_page_url || ''),
        locations: review.snapshot.locations as AdLocation[],
        platforms: [platform],
        accountReadiness: readiness,
        creativesCount: {
          meta: Array.isArray(review.snapshot.creatives.meta) ? review.snapshot.creatives.meta.length : 0,
          google: Array.isArray(review.snapshot.creatives.google) ? review.snapshot.creatives.google.length : 0,
        },
      }), ...validateProviderCampaign({
        platforms: [platform], objective: campaign.objective as AdObjective,
        campaignName: String(campaign.name), landingPageUrl: String(campaign.landing_page_url || ''),
        creatives: campaign.ad_creatives as Partial<Record<AdPlatform, unknown[]>>,
        providerConfig: review.snapshot.providerConfig as ProviderCampaignConfig,
        hasEndDate: Boolean(campaign.end_date),
      })];
      if (errors.length) throw new CampaignPublishPreflightError(`Campaign preflight failed: ${[...new Set(errors)].join(' ')}`);
      if (campaign.budget_type !== 'lifetime') throw new CampaignPublishPreflightError('A total lifetime budget is required before publishing.');
      const approvedReview: ApprovedCampaignPublishReview = {
        schemaVersion: 1, revision: review.revision, snapshot: review.snapshot,
        approvedAt: new Date().toISOString(), scope: 'live_activation_and_spend',
      };
      await this.enqueue(tx, {
        campaignId, userId, platform, actionType: 'publish', idempotencyKey,
        payload: { autoActivate: true, actorType: 'user', approvedReview },
        rationale: 'The client approved the exact saved campaign review for provider creation and live activation.',
      });
      const queued = await tx.execute(sql`
        SELECT id FROM ad_action_queue WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey} LIMIT 1
      `);
      if (!queued.rows[0]) throw new Error('The provider action was not durably queued.');
      // Per-platform action receipts are authoritative; this aggregate never
      // changes a previously active platform's provider status.
      await tx.execute(sql`
        UPDATE performance_ad_campaigns
        SET local_status = 'queued', auto_activate = TRUE,
            settings = COALESCE(settings, '{}'::jsonb) || ${JSON.stringify({ approvedPublishReview: approvedReview })}::jsonb,
            updated_at = NOW()
        WHERE id = ${campaignId} AND user_id = ${userId}
      `);
      await this.audit(tx, {
        campaignId, userId, actorType: 'user', actionType: 'queue_publish',
        rationale: `Queued ${platform} for the approved immutable review.`,
        metricsSnapshot: { platform, requestKey, reviewRevision, approvedAt: approvedReview.approvedAt },
        budgetBefore: Number(campaign.budget_amount), budgetAfter: Number(campaign.budget_amount),
      });
      return { campaignId, platform, queued: true, status: 'queued', actionId: Number(queued.rows[0].id) };
    });
  }

  private async revokeCampaignLaunch(tx: typeof db, userId: number, campaignId: number, platform: AdPlatform): Promise<void> {
    await tx.execute(sql`UPDATE performance_ad_campaigns SET settings = COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object('publishApprovalRevokedByPlatform', COALESCE(settings->'publishApprovalRevokedByPlatform', '{}'::jsonb)
            || jsonb_build_object(${platform}::text, NOW())), updated_at = NOW()
          WHERE id = ${campaignId} AND user_id = ${userId}`);
    await tx.execute(sql`UPDATE ad_action_queue SET status = 'cancelled', last_error = 'Cancelled by client stop request', updated_at = NOW()
          WHERE campaign_id = ${campaignId} AND user_id = ${userId} AND platform = ${platform}
            AND action_type IN ('publish', 'activate', 'resume') AND status IN ('pending', 'processing')`);
  }

  /** Fence only managed rows for the exact provider target and selected account.
   * Provider-only campaigns remain on the existing direct control path. */
  async revokeManagedMetaLaunch(userId: number, providerCampaignId: string, adAccountId: string): Promise<number[]> {
    const scope = requireBusinessScope();
    if (scope.userId !== userId) throw new Error('Managed campaign ownership does not match this business.');
    const account = adAccountId.replace(/^act_/i, '');
    return db.transaction(async (tx: typeof db) => {
      const rows = await tx.execute(sql`SELECT campaign.id,campaign.ad_platform,campaign.ad_account_id,campaign.settings
        FROM performance_ad_campaigns campaign
        WHERE campaign.user_id=${userId} AND campaign.business_profile_id=${scope.businessProfileId}
          AND EXISTS (SELECT 1 FROM ad_provider_resources resource
            WHERE resource.campaign_id=campaign.id AND resource.user_id=${userId}
              AND resource.business_profile_id=${scope.businessProfileId} AND resource.platform='meta'
              AND resource.resource_type='campaign' AND resource.provider_resource_id=${providerCampaignId} AND resource.cleanup_status IS NULL)
        ORDER BY campaign.id FOR UPDATE`);
      const ids:number[]=[];
      for (const row of rows.rows) {
        const snapshot=row.settings?.accountSnapshot || {};
        const bound=String(snapshot.meta?.adAccountId || (row.ad_platform==='meta'?row.ad_account_id:null) || snapshot.adAccountId || '').replace(/^act_/i,'');
        if (!account || bound!==account) throw new Error('The managed campaign is not bound to the verified Meta account.');
        const id=Number(row.id);if(!Number.isSafeInteger(id)||id<=0)continue;
        await this.revokeCampaignLaunch(tx,userId,id,'meta');ids.push(id);
      }
      return ids;
    });
  }

  async recordManagedMetaPause(userId: number, campaignIds: number[], providerCampaignId: string, adAccountId: string): Promise<void> {
    if(!campaignIds.length)return;
    const scope=requireBusinessScope();
    if(scope.userId!==userId)throw new Error('Managed campaign ownership does not match this business.');
    await db.transaction(async (tx: typeof db)=>{
      for(const id of campaignIds){
        const owned=await tx.execute(sql`SELECT campaign.id,campaign.settings,campaign.ad_platform,campaign.ad_account_id FROM performance_ad_campaigns campaign
          WHERE campaign.id=${id} AND campaign.user_id=${userId} AND campaign.business_profile_id=${scope.businessProfileId}
            AND EXISTS(SELECT 1 FROM ad_provider_resources parent WHERE parent.campaign_id=campaign.id AND parent.user_id=${userId}
              AND parent.business_profile_id=${scope.businessProfileId} AND parent.resource_type='campaign' AND parent.platform='meta'
              AND parent.provider_resource_id=${providerCampaignId} AND parent.cleanup_status IS NULL) FOR UPDATE`);
        const row=owned.rows[0];
        const snapshot=row?.settings?.accountSnapshot || {};
        const bound=String(snapshot.meta?.adAccountId || (row?.ad_platform==='meta'?row.ad_account_id:null) || snapshot.adAccountId || '').replace(/^act_/i,'');
        if(!row || !adAccountId || bound!==adAccountId.replace(/^act_/i,''))throw new Error('The managed campaign binding changed before pause confirmation.');
        await tx.execute(sql`UPDATE ad_provider_resources SET status='paused',error=NULL,updated_at=NOW()
          WHERE campaign_id=${id} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND platform='meta' AND cleanup_status IS NULL
            AND EXISTS(SELECT 1 FROM ad_provider_resources parent WHERE parent.campaign_id=${id} AND parent.user_id=${userId}
              AND parent.business_profile_id=${scope.businessProfileId} AND parent.resource_type='campaign' AND parent.platform='meta' AND parent.provider_resource_id=${providerCampaignId} AND parent.cleanup_status IS NULL)`);
        await reconcileCampaignProviderState(tx,{id:0,campaign_id:id,user_id:userId,platform:'meta'},'paused','PAUSED');
      }
    });
  }

  /** Queue an explicitly authorized stop; queued is never provider-confirmed paused. */
  async queueCampaignStop(userId: number, campaignId: number, platforms: AdPlatform[], requestKey: string): Promise<{
    campaignId: number;
    platforms: Array<{ platform: AdPlatform; actionId: number; status: string; replayed: boolean; providerPauseConfirmed: boolean }>;
  }> {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(campaignId) || campaignId <= 0
      || !requestKey.trim() || !platforms.length || platforms.some(platform => !['meta', 'google'].includes(platform))) {
      throw new Error('An exact campaign, platform selection and stop request key are required.');
    }
    return db.transaction(async (tx: typeof db) => {
      const campaign = (await tx.execute(sql`SELECT * FROM performance_ad_campaigns
        WHERE id = ${campaignId} AND user_id = ${userId} FOR UPDATE`)).rows[0];
      if (!campaign) throw new Error('Campaign not found.');
      const allocations = (await tx.execute(sql`SELECT DISTINCT platform FROM ad_campaign_allocations
        WHERE campaign_id = ${campaignId} AND user_id = ${userId}`)).rows;
      const selected = [...new Set(platforms)];
      if (selected.some(platform => !allocations.some((row: Record<string, unknown>) => row.platform === platform))) throw new Error('A selected platform does not belong to this campaign.');
      const gate = (await tx.execute(sql`SELECT live_provider_mutations_enabled FROM ad_settings WHERE user_id = ${userId} LIMIT 1`)).rows[0];
      const gated = process.env.AD_PROVIDER_MUTATIONS_ENABLED !== 'true' || gate?.live_provider_mutations_enabled !== true;
      const receipts: Array<{ platform: AdPlatform; actionId: number; status: string; replayed: boolean; providerPauseConfirmed: boolean }> = [];
      for (const platform of selected) {
        const key = `campaign:${campaignId}:stop:${publishReviewRevision(requestKey).slice(0, 24)}:${platform}`;
        const previous = (await tx.execute(sql`SELECT id, status, provider_outcome FROM ad_action_queue
          WHERE user_id = ${userId} AND idempotency_key = ${key} LIMIT 1`)).rows[0];
        if (previous) {
          const outcome = previous.provider_outcome as Record<string, unknown> | null;
          const confirmed = previous.status === 'succeeded' && (outcome?.providerPauseConfirmed === true || outcome?.status === 'paused');
          receipts.push({ platform, actionId: Number(previous.id), replayed: true, providerPauseConfirmed: confirmed,
            status: confirmed ? 'paused' : previous.status === 'pending' ? (gated ? 'gated' : 'queued') : String(previous.status) });
          continue;
        }
        // Fence launch immediately, even if provider mutations are disabled.
        // A stop on Meta must not revoke a separate Google launch approval.
        await this.revokeCampaignLaunch(tx, userId, campaignId, platform);
        await this.enqueue(tx, { campaignId, userId, platform, actionType: 'pause', idempotencyKey: key,
          payload: { actorType: 'user', targetType: 'campaign', targetKey: 'campaign' },
          rationale: 'Client explicitly requested this campaign platform stop. Provider pause confirmation is pending.' });
        const queued = (await tx.execute(sql`SELECT id FROM ad_action_queue WHERE user_id = ${userId} AND idempotency_key = ${key} LIMIT 1`)).rows[0];
        if (!queued) throw new Error('Stop request was not durably queued.');
        await this.audit(tx, { campaignId, userId, actorType: 'user', actionType: 'queue_pause',
          rationale: 'Revoked this platform launch and queued a client-requested provider pause.',
          metricsSnapshot: { platform, requestKey, actionId: Number(queued.id), gated } });
        receipts.push({ platform, actionId: Number(queued.id), replayed: false, providerPauseConfirmed: false, status: gated ? 'gated' : 'queued' });
      }
      return { campaignId, platforms: receipts };
    });
  }

  async listCampaigns(userId: number): Promise<Record<string, unknown>[]> {
    const result = await db.execute(sql`
      SELECT pac.*,
        COALESCE((SELECT SUM(a.allocated_amount) FROM ad_campaign_allocations a
          WHERE a.campaign_id = pac.id AND a.user_id = ${userId}), 0) AS total_allocated,
        COALESCE((SELECT SUM(a.spent_amount) FROM ad_campaign_allocations a
          WHERE a.campaign_id = pac.id AND a.user_id = ${userId}), 0) AS child_spend
      FROM performance_ad_campaigns pac
      WHERE pac.user_id = ${userId}
      ORDER BY pac.created_at DESC
    `);
    return result.rows as Record<string, unknown>[];
  }

  async runOptimizationCycle(): Promise<{ campaignsEvaluated: number; decisionsQueued: number; errors: string[] }> {
    const result = await adPerformanceService.runCycle();
    return {
      campaignsEvaluated: result.campaignsEvaluated,
      decisionsQueued: result.actionsQueued,
      errors: result.errors,
    };
  }

  private createEvenAllocations(
    lifetimeBudget: number,
    platforms: AdPlatform[],
    creatives: Partial<Record<AdPlatform, unknown[]>>,
    currency = 'USD',
  ): CampaignAllocation[] {
    const keys = platforms.flatMap((platform) => {
      const count = Math.max(1, creatives[platform]?.length || 0);
      return Array.from({ length: count }, (_, index) => ({ platform, key: `${platform}-${index + 1}` }));
    });
    if (keys.length === 0) return [];
    const scale = campaignCurrencyScale(currency);
    const totalMinor = Math.round(lifetimeBudget * scale);
    const baseMinor = Math.floor(totalMinor / keys.length);
    const remainderMinor = totalMinor - baseMinor * keys.length;
    return keys.map((item, index) => {
      return { ...item, amount: (baseMinor + (index < remainderMinor ? 1 : 0)) / scale, spent: 0 };
    });
  }

  private async enqueue(
    executor: typeof db,
    action: {
      campaignId: number;
      userId: number;
      platform: AdPlatform;
      actionType: string;
      idempotencyKey: string;
      payload?: unknown;
      metricsSnapshot?: unknown;
      rationale: string;
      budgetImpact?: number;
    },
  ): Promise<boolean> {
    const result = await executor.execute(sql`
      INSERT INTO ad_action_queue (
        campaign_id, user_id, platform, action_type, idempotency_key,
        payload, metrics_snapshot, rationale, budget_impact
      ) VALUES (
        ${action.campaignId}, ${action.userId}, ${action.platform}, ${action.actionType},
        ${action.idempotencyKey}, ${JSON.stringify(action.payload || {})}::jsonb,
        ${JSON.stringify(action.metricsSnapshot || {})}::jsonb,
        ${action.rationale}, ${money(action.budgetImpact || 0)}
      )
      ON CONFLICT (business_profile_id, user_id, idempotency_key) DO NOTHING
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  private async audit(
    executor: typeof db,
    event: {
      campaignId: number;
      userId: number;
      actorType: string;
      actionType: string;
      rationale: string;
      metricsSnapshot?: unknown;
      budgetBefore?: number;
      budgetAfter?: number;
      providerOutcome?: unknown;
    },
  ): Promise<void> {
    await executor.execute(sql`
      INSERT INTO ad_action_audit (
        campaign_id, user_id, actor_type, action_type, rationale,
        metrics_snapshot, budget_before, budget_after, provider_outcome
      ) VALUES (
        ${event.campaignId}, ${event.userId}, ${event.actorType}, ${event.actionType},
        ${event.rationale}, ${JSON.stringify(event.metricsSnapshot || {})}::jsonb,
        ${event.budgetBefore ?? null}, ${event.budgetAfter ?? null},
        ${event.providerOutcome ? JSON.stringify(event.providerOutcome) : null}::jsonb
      )
    `);
  }
}

export const autonomousAdsService = new AutonomousAdsService();

