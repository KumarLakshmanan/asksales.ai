import crypto from 'node:crypto';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { collectContentManagedReferenceUrls } from '../../utils/contentManagedReferences.js';
import { lockManagedStorageReferences, syncManagedStorageOwners, releaseManagedStorageOwners, type ManagedStorageTransaction } from '../managedStorageReferences.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { contentAssetsTable, type ContentAssetRecord } from '../../models/contentAssets/schema.js';
import { ContentAssetModel } from '../../models/contentAssets/functions.js';
import { withoutGenerationKey } from '../../utils/contentGenerationKey.js';
import { socialPublishAttemptsTable, type SocialPublishAttempt } from '../../models/socialPublishAttempts/schema.js';
import { OrganicPublishingError, prepareOrganicPublishAttempt, buildOrganicPublishReview, resolveOrganicPublishingMedia, organicPublishReviewToken, type PrepareOrganicPublishInput, type OrganicPublishStorageEntry } from './OrganicPublishingService.js';
import { authorizeOrganicPublishOrigin } from './OrganicPublishAuthority.js';

const OPEN = ['pending', 'retryable_failed'] as const;
const REMOTE_ACTIVE = ['claimed', 'ambiguous', 'provider_succeeded', 'succeeded'];
const editable = (asset: ContentAssetRecord) => !['scheduled', 'processing', 'published'].includes(asset.status || '');

function conflict(message: string, code = 'PUBLISH_ATTEMPT_NOT_RESCHEDULABLE'): never {
  throw new OrganicPublishingError(message, code, 409);
}

/** Domain mutations lock assets, then attempts in ID order. Reference writers
 * first acquire the canonical billing/business prefix.
 * Workers claim attempts atomically; their row lock therefore serializes with
 * these transitions, without holding a transaction during a provider request. */
async function lockFamily(tx: ManagedStorageTransaction, userId: number, assetIds: number[]) {
  await tx.select({ id: contentAssetsTable.id }).from(contentAssetsTable).where(and(
    eq(contentAssetsTable.userId, userId), inArray(contentAssetsTable.id, assetIds),
  )).orderBy(asc(contentAssetsTable.id)).for('update');
  const owned = await tx.select().from(contentAssetsTable).where(eq(contentAssetsTable.userId, userId));
  const ids = new Set(assetIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const asset of owned) if (asset.parentAssetId && ids.has(asset.parentAssetId)
      && (asset.metadata as Record<string, unknown> | null)?.organicPublishAttemptId && !ids.has(asset.id)) {
      ids.add(asset.id); expanded = true;
    }
  }
  const assets: ContentAssetRecord[] = await tx.select().from(contentAssetsTable).where(and(
    eq(contentAssetsTable.userId, userId), inArray(contentAssetsTable.id, [...ids]),
  )).orderBy(asc(contentAssetsTable.id)).for('update');
  if (assetIds.some(id => !assets.some(asset => asset.id === id))) throw new OrganicPublishingError('Content asset not found.', 'CONTENT_ASSET_NOT_FOUND', 404);
  const attempts: SocialPublishAttempt[] = await tx.select().from(socialPublishAttemptsTable).where(and(
    eq(socialPublishAttemptsTable.userId, userId), inArray(socialPublishAttemptsTable.assetId, assets.map(asset => asset.id)),
  )).orderBy(asc(socialPublishAttemptsTable.id)).for('update');
  return { assets, attempts };
}

export async function prepareOrganicPublishBatch(userId: number, sourceAssetId: number, targets: PrepareOrganicPublishInput[], requestKey?: string, sourceReview: {
  expectedVersion?: number; expectedReviewToken?: string; required?: boolean;
} = {}) {
  if (!targets.length || new Set(targets.map(target => target.platform)).size !== targets.length) conflict('Choose distinct publication destinations.', 'INVALID_PUBLISH_TARGETS');
  const key = requestKey?.trim() || crypto.randomUUID();
  if (key.length > 96) conflict('Idempotency key must be at most 96 characters.', 'INVALID_IDEMPOTENCY_KEY');
  const [reviewSource] = await db.select().from(contentAssetsTable).where(and(eq(contentAssetsTable.id, sourceAssetId), eq(contentAssetsTable.userId, userId))).limit(1);
  if (!reviewSource) throw new OrganicPublishingError('Content asset not found.', 'CONTENT_ASSET_NOT_FOUND', 404);
  const known: SocialPublishAttempt[] = await db.select().from(socialPublishAttemptsTable).where(and(eq(socialPublishAttemptsTable.userId, userId), inArray(socialPublishAttemptsTable.idempotencyKey, targets.map(target => `${key}:${target.platform}`))));
  if (sourceReview.expectedVersion !== undefined && (!Number.isSafeInteger(sourceReview.expectedVersion) || sourceReview.expectedVersion < 1)) throw new OrganicPublishingError('expectedVersion must be a positive integer.', 'INVALID_VERSION', 400);
  if (sourceReview.expectedReviewToken !== undefined && (typeof sourceReview.expectedReviewToken !== 'string' || !sourceReview.expectedReviewToken || sourceReview.expectedReviewToken.length > 128)) throw new OrganicPublishingError('A valid source review token is required.', 'INVALID_SOURCE_REVIEW', 400);
  const knownReplay = known.length === targets.length;
  if (!knownReplay) {
    if (sourceReview.required && (sourceReview.expectedVersion === undefined || !sourceReview.expectedReviewToken)) throw new OrganicPublishingError('Reload and review the saved content before publishing.', 'SOURCE_REVIEW_REQUIRED', 400);
    if (sourceReview.expectedVersion !== undefined && sourceReview.expectedVersion !== reviewSource.version) conflict('The source changed after review. Reload and review it again.', 'CONTENT_VERSION_CONFLICT');
    if (sourceReview.expectedReviewToken && sourceReview.expectedReviewToken !== organicPublishReviewToken(reviewSource, await resolveOrganicPublishingMedia(reviewSource))) conflict('The content or media changed after review. Reload and review it again.', 'CONTENT_VERSION_CONFLICT');
  }
  const reviews = new Map<string, Awaited<ReturnType<typeof buildOrganicPublishReview>>>();
  // Remote media and account checks must not reserve a database connection
  // across HTTP requests. Recheck source and media under the commit lock below.
  for (const target of targets) {
    if (!known.some(attempt => attempt.idempotencyKey === `${key}:${target.platform}`)) reviews.set(target.platform, await buildOrganicPublishReview(userId, reviewSource, target));
  }
  return db.transaction(async (tx: ManagedStorageTransaction) => {
    await lockManagedStorageReferences(tx, { userId, businessProfileId: requireBusinessScope().businessProfileId });
    const storageReferences: OrganicPublishStorageEntry[] = [];
    // Lock the root before enumerating descendants so simultaneous batches cannot
    // miss newly inserted children after waiting for the root lock.
    await tx.select({ id: contentAssetsTable.id }).from(contentAssetsTable).where(and(eq(contentAssetsTable.id, sourceAssetId), eq(contentAssetsTable.userId, userId))).for('update');
    const { assets, attempts } = await lockFamily(tx, userId, [sourceAssetId]);
    const source = assets.find(asset => asset.id === sourceAssetId)!;
    const keys = targets.map(target => `${key}:${target.platform}`);
    const existing: SocialPublishAttempt[] = await tx.select().from(socialPublishAttemptsTable).where(and(
      eq(socialPublishAttemptsTable.userId, userId), inArray(socialPublishAttemptsTable.idempotencyKey, keys),
    )).orderBy(asc(socialPublishAttemptsTable.id)).for('update');
    if (existing.some(attempt => !assets.some(asset => asset.id === attempt.assetId))) conflict('This idempotency key belongs to another content asset.', 'IDEMPOTENCY_KEY_REUSED');
    if (existing.length && existing.length !== targets.length) conflict('This idempotency key belongs to a different destination selection.', 'IDEMPOTENCY_KEY_REUSED');
    const replay = existing.length === targets.length;
    if (!replay) {
      if (sourceReview.expectedVersion !== undefined && sourceReview.expectedVersion !== source.version) conflict('The source changed after review. Reload and review it again.', 'CONTENT_VERSION_CONFLICT');
      if (reviews.size && (source.version !== reviewSource.version || new Date(source.updatedAt || 0).getTime() !== new Date(reviewSource.updatedAt || 0).getTime() || source.content !== reviewSource.content)) conflict('The draft changed during publishing review. Review the latest version.', 'CONTENT_VERSION_CONFLICT');
      if (reviews.size) {
        const media = await resolveOrganicPublishingMedia(source, tx);
        if (sourceReview.expectedReviewToken && sourceReview.expectedReviewToken !== organicPublishReviewToken(source, media)) conflict('The content or media changed after review. Reload and review it again.', 'CONTENT_VERSION_CONFLICT');
        if ([...reviews.values()].some(review => JSON.stringify(review.sourceMedia) !== JSON.stringify(media))) conflict('Post media changed during publishing review. Review it again.', 'CONTENT_VERSION_CONFLICT');
      }
      if (source.status === 'published' || attempts.some(attempt => REMOTE_ACTIVE.includes(attempt.status))) conflict('Publishing is already active or remotely completed. Reconcile it or create a new version before publishing again.', 'PUBLISH_ALREADY_ACTIVE');
    }
    const entries = [];
    for (const [index, target] of targets.entries()) {
      const previous = existing.find(attempt => attempt.idempotencyKey === keys[index]);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ sourceAssetId, targets,
        ...(sourceReview.expectedVersion !== undefined ? { expectedVersion: sourceReview.expectedVersion } : {}),
        ...(sourceReview.expectedReviewToken ? { expectedReviewToken: sourceReview.expectedReviewToken } : {}),
      })).digest('hex');
      if (previous) {
        if (previous.reviewedPayload.requestFingerprint !== fingerprint) conflict('This idempotency key was already used with a different publishing request.', 'IDEMPOTENCY_KEY_REUSED');
        const savedAsset = assets.find(asset => asset.id === previous.assetId)!;
        storageReferences.push(
          { owner: { kind: 'social_publish_attempt', id: String(previous.id), userId, businessProfileId: previous.businessProfileId! }, urls: collectContentManagedReferenceUrls(previous.reviewedPayload) },
          { owner: { kind: 'content_asset', id: String(savedAsset.id), userId, businessProfileId: savedAsset.businessProfileId! }, urls: collectContentManagedReferenceUrls(savedAsset) },
        );
        entries.push({ platform: target.platform, assetId: previous.assetId!, attempt: previous, snapshot: previous.reviewedPayload });
        continue;
      }
      let asset = source;
      if (index > 0) {
        const { id: _id, createdAt: _created, updatedAt: _updated, publishedAt: _published, publishedPostId: _postId, publishedUrl: _url, ...copy } = source;
        [asset] = await tx.insert(contentAssetsTable).values({ ...copy, metadata: withoutGenerationKey(copy.metadata), parentAssetId: sourceAssetId, status: 'draft', scheduledPublishAt: null,
          title: target.title || source.title, publishPlatform: target.platform, approvalStatus: 'draft', approvedAt: null, approvedBy: null }).returning();
      }
      const review = reviews.get(target.platform);
      if (!review) conflict('The publishing review changed. Please retry.', 'CONTENT_VERSION_CONFLICT');
      const prepared = await prepareOrganicPublishAttempt(userId, asset, { ...target, requestFingerprint: fingerprint, idempotencyKey: keys[index], holdForCrossPlatformPreflight: false }, tx, review, storageReferences);
      entries.push({ platform: target.platform, assetId: asset.id, ...prepared });
    }
    // Validation and all new attempts have succeeded. Replacement is committed
    // atomically; invalid requests leave every previous reviewed schedule intact.
    if (!replay) {
      const obsolete = attempts.filter(attempt => OPEN.includes(attempt.status as typeof OPEN[number]));
      if (obsolete.length) await tx.update(socialPublishAttemptsTable).set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
        .where(inArray(socialPublishAttemptsTable.id, obsolete.map(attempt => attempt.id)));
      const reused = new Set(entries.map(entry => entry.assetId));
      const abandoned = assets.filter(asset => !reused.has(asset.id) && obsolete.some(attempt => attempt.assetId === asset.id));
      if (abandoned.length) await tx.update(contentAssetsTable).set({ status: 'cancelled', scheduledPublishAt: null, updatedAt: new Date() })
        .where(inArray(contentAssetsTable.id, abandoned.map(asset => asset.id)));
    }
    // Object locks come after every destination/history write. Register the
    // complete new set before canonical Storage releases any previous edge.
    await syncManagedStorageOwners(tx, { entries: [...new Map(storageReferences.map(entry => [`${entry.owner.kind}:${entry.owner.id}`, entry])).values()] });
    return entries;
  });
}

export async function changeOrganicPublishSchedule(userId: number, assetIds: number[], scheduledFor?: Date, options: {
  exactAssetOnly?: boolean; expectedVersions?: Record<number, number>; expectedScheduledFor?: Record<number, string>; threadId?: number;
} = {}) {
  if (scheduledFor && (!Number.isFinite(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now() + 60_000)) throw new OrganicPublishingError('Schedule must be at least one minute in the future.', 'INVALID_SCHEDULE', 400);
  return db.transaction(async (tx: typeof db) => {
    const selectedIds = [...assetIds];
    if (options.exactAssetOnly === false) {
      // A group operation from a child destination must include its root and siblings.
      for (const id of selectedIds) {
        const [selected] = await tx.select().from(contentAssetsTable).where(and(eq(contentAssetsTable.userId, userId), eq(contentAssetsTable.id, id))).limit(1);
        if (selected?.parentAssetId && (selected.metadata as Record<string, unknown> | null)?.organicPublishAttemptId) assetIds = [...new Set([...assetIds, selected.parentAssetId])];
      }
    }
    const family = await lockFamily(tx, userId, assetIds);
    // Lock the family in the established order, but an exact destination edit
    // must not mutate sibling platform schedules (including the root target).
    const assets = options.exactAssetOnly !== false ? family.assets.filter(asset => assetIds.includes(asset.id)) : family.assets;
    const attempts = options.exactAssetOnly !== false ? family.attempts.filter(attempt => assetIds.includes(attempt.assetId!)) : family.attempts;
    for (const id of assetIds) {
      const asset = assets.find(value => value.id === id)!;
      if (options.threadId !== undefined && asset.threadId !== options.threadId) throw new OrganicPublishingError('Content asset not found in this campaign.', 'CONTENT_ASSET_NOT_FOUND', 404);
      if ((options.expectedVersions?.[id] !== undefined && options.expectedVersions[id] !== asset.version)
        || (options.expectedScheduledFor?.[id] !== undefined && new Date(options.expectedScheduledFor[id]).getTime() !== asset.scheduledPublishAt?.getTime())) {
        conflict('This post changed since it was selected. Reload the schedule before changing it.', 'CONTENT_VERSION_CONFLICT');
      }
    }
    if (attempts.some(attempt => REMOTE_ACTIVE.includes(attempt.status))) conflict('A publish attempt is claimed or remotely active and cannot be changed.');
    const open = attempts.filter(attempt => OPEN.includes(attempt.status as typeof OPEN[number]));
    const activeAssetIds = new Set(open.map(attempt => attempt.assetId));
    if (scheduledFor) {
      const platforms = new Set<string>();
      for (const attempt of open) {
        if (platforms.has(attempt.platform)) conflict(`Only one ${attempt.platform} item can be moved to the same scheduled time in a bulk action`, 'PUBLISH_SLOT_CONFLICT');
        platforms.add(attempt.platform);
        const matches: ContentAssetRecord[] = await tx.select().from(contentAssetsTable).where(and(eq(contentAssetsTable.userId, userId), eq(contentAssetsTable.publishPlatform, attempt.platform), eq(contentAssetsTable.scheduledPublishAt, scheduledFor), inArray(contentAssetsTable.status, ['scheduled', 'processing'])));
        if (matches.some(asset => !activeAssetIds.has(asset.id))) conflict('Another item for this platform is already scheduled at that time', 'PUBLISH_SLOT_CONFLICT');
      }
    }
    for (const id of assetIds) {
      const asset = assets.find(asset => asset.id === id)!;
      if (!activeAssetIds.has(id) && !(!scheduledFor && asset.status === 'cancelled' && attempts.some(attempt => attempt.assetId === id && attempt.status === 'cancelled'))) conflict('No durable scheduled publish attempt was found for this content.', 'PUBLISH_ATTEMPT_NOT_FOUND');
    }
    for (const attempt of open) await tx.update(socialPublishAttemptsTable).set(scheduledFor
      ? { status: 'pending', nextAttemptAt: scheduledFor, reviewedPayload: { ...attempt.reviewedPayload, scheduledFor: scheduledFor.toISOString() }, errorCode: null, errorMessage: null, updatedAt: new Date() }
      : { status: 'cancelled', completedAt: new Date(), updatedAt: new Date() }).where(eq(socialPublishAttemptsTable.id, attempt.id));
    for (const id of activeAssetIds) {
      const asset = assets.find(asset => asset.id === id)!;
      const attempt = open.find(attempt => attempt.assetId === id)!;
      await tx.update(contentAssetsTable).set(scheduledFor
        ? { status: 'scheduled', scheduledPublishAt: scheduledFor, retryCount: 0, lastError: null, version: asset.version + 1, updatedAt: new Date(),
          metadata: { ...(asset.metadata || {}), reviewedPublishSnapshot: { ...attempt.reviewedPayload, scheduledFor: scheduledFor.toISOString() } } }
        : { status: 'cancelled', version: asset.version + 1, updatedAt: new Date() })
        .where(and(eq(contentAssetsTable.userId, userId), eq(contentAssetsTable.id, id!)));
    }
    return { affected: activeAssetIds.size, attempts: open.map(attempt => attempt.id) };
  });
}

export function publishAttemptCapabilities(attempt: Pick<SocialPublishAttempt, 'status' | 'providerPostId' | 'providerSucceededAt' | 'reviewedPayload'>) {
  const remoteKnown = Boolean(attempt.providerPostId || attempt.providerSucceededAt);
  return {
    retry: ['failed', 'retryable_failed'].includes(attempt.status) && !remoteKnown,
    reconcile: ['ambiguous', 'provider_succeeded'].includes(attempt.status),
    publishNow: attempt.status === 'pending' && Boolean(attempt.reviewedPayload.scheduledFor),
  };
}

/** Reuse the immutable reviewed attempt. Never recreate a remotely uncertain send. */
export async function recoverOrganicPublishAttempt(userId: number, assetId: number, attemptId: number,
  action: 'retry' | 'reconcile' | 'publish_now', expectedVersion?: number) {
  const [ownedAsset] = await db.select({ id: contentAssetsTable.id }).from(contentAssetsTable).where(and(
    eq(contentAssetsTable.id, assetId), eq(contentAssetsTable.userId, userId),
  )).limit(1);
  if (!ownedAsset) throw new OrganicPublishingError('Content asset not found.', 'CONTENT_ASSET_NOT_FOUND', 404);
  const [reviewed] = await db.select().from(socialPublishAttemptsTable).where(and(
    eq(socialPublishAttemptsTable.id, attemptId), eq(socialPublishAttemptsTable.assetId, assetId), eq(socialPublishAttemptsTable.userId, userId),
  )).limit(1);
  if (!reviewed) throw new OrganicPublishingError('Publish attempt not found.', 'PUBLISH_ATTEMPT_NOT_FOUND', 404);
  // Authorization may query separate services; do not hold a row/connection
  // across it. The immutable origin is never replaced by this recovery action.
  await authorizeOrganicPublishOrigin(reviewed);
  return db.transaction(async (tx: typeof db) => {
    const { assets, attempts } = await lockFamily(tx, userId, [assetId]);
    const asset = assets.find(value => value.id === assetId)!;
    const attempt = attempts.find(value => value.id === attemptId && value.assetId === assetId);
    if (!attempt) throw new OrganicPublishingError('Publish attempt not found.', 'PUBLISH_ATTEMPT_NOT_FOUND', 404);
    if (expectedVersion !== undefined && expectedVersion !== asset.version) conflict('This post changed. Reload it before continuing.', 'CONTENT_VERSION_CONFLICT');
    if (Number((asset.metadata as Record<string, unknown> | null)?.organicPublishAttemptId) !== attempt.id) conflict('This attempt has been replaced. Open the latest attempt.', 'PUBLISH_ATTEMPT_REPLACED');
    const capabilities = publishAttemptCapabilities(attempt);
    if (!(action === 'retry' ? capabilities.retry : action === 'reconcile' ? capabilities.reconcile : capabilities.publishNow)) {
      conflict('This action is unavailable for the current publishing status. Refresh the post to see its latest status.', 'PUBLISH_RECOVERY_UNAVAILABLE');
    }
    if (attempt.leaseExpiresAt && attempt.leaseExpiresAt.getTime() > Date.now()) conflict('A worker is already checking this post. Refresh shortly.', 'PUBLISH_ALREADY_ACTIVE');
    const now = new Date();
    const snapshot = action === 'publish_now' ? { ...attempt.reviewedPayload, scheduledFor: undefined } : attempt.reviewedPayload;
    const [updated] = await tx.update(socialPublishAttemptsTable).set({
      ...(action !== 'reconcile' ? { status: 'pending' as const, errorCode: null, errorMessage: null, completedAt: null,
        // Retain the historical count, but grant a bounded new retry budget.
        maxAttempts: Math.max(attempt.maxAttempts, attempt.attemptCount + 3) } : {}),
      nextAttemptAt: now, reviewedPayload: snapshot, updatedAt: now,
    }).where(eq(socialPublishAttemptsTable.id, attempt.id)).returning();
    if (action !== 'reconcile') await tx.update(contentAssetsTable).set({ status: 'processing',
      ...(action === 'publish_now' ? { scheduledPublishAt: null } : {}), lastError: null, version: asset.version + 1, updatedAt: now,
      metadata: { ...(asset.metadata || {}), reviewedPublishSnapshot: snapshot },
    }).where(and(eq(contentAssetsTable.id, assetId), eq(contentAssetsTable.userId, userId)));
    return updated;
  });
}

export async function updateEditableContentAsset(userId: number, assetId: number, updates: Partial<ContentAssetRecord>) {
  const updated = await db.transaction(async (tx: ManagedStorageTransaction) => {
    await lockManagedStorageReferences(tx, { userId, businessProfileId: requireBusinessScope().businessProfileId });
    const ancestors = new Set([assetId]);
    const findOwned = async (id: number) => (await tx.select().from(contentAssetsTable).where(and(eq(contentAssetsTable.id, id), eq(contentAssetsTable.userId, userId))).limit(1))[0] as ContentAssetRecord | undefined;
    let parent = await findOwned(assetId);
    while (parent?.parentAssetId && !ancestors.has(parent.parentAssetId)) {
      ancestors.add(parent.parentAssetId);
      parent = await findOwned(parent.parentAssetId);
    }
    const { assets, attempts } = await lockFamily(tx, userId, [...ancestors]);
    const asset = assets.find(asset => asset.id === assetId)!;
    if (assets.some(value => !editable(value)) || attempts.some(attempt => [...OPEN, ...REMOTE_ACTIVE].includes(attempt.status))) conflict('Cancel or reconcile publishing before editing this content.', 'CONTENT_PUBLISHING_IMMUTABLE');
    if (updates.version !== undefined && updates.version !== asset.version + 1) conflict('Content changed while this edit was being prepared. Reload and review the latest version.', 'CONTENT_VERSION_CONFLICT');
    const [updated] = await tx.update(contentAssetsTable).set({ ...updates, updatedAt: new Date() }).where(and(eq(contentAssetsTable.id, assetId), eq(contentAssetsTable.userId, userId))).returning();
    if (updated) await syncManagedStorageOwners(tx, { entries: [{ owner: { kind: 'content_asset', id: String(updated.id), userId, businessProfileId: updated.businessProfileId! }, urls: collectContentManagedReferenceUrls(updated) }] });
    return updated;
  });
  if (updated) await ContentAssetModel.attachTrackedMedia(updated);
  return updated;
}

export async function deleteEditableContentAsset(userId: number, assetId: number) {
  return db.transaction(async (tx: ManagedStorageTransaction) => {
    await lockManagedStorageReferences(tx, { userId, businessProfileId: requireBusinessScope().businessProfileId });
    await tx.select({ id: contentAssetsTable.id }).from(contentAssetsTable).where(and(eq(contentAssetsTable.userId, userId), eq(contentAssetsTable.id, assetId))).for('update');
    const children: ContentAssetRecord[] = await tx.select().from(contentAssetsTable).where(and(eq(contentAssetsTable.userId, userId), eq(contentAssetsTable.parentAssetId, assetId)));
    const { assets, attempts } = await lockFamily(tx, userId, [assetId, ...children.map(child => child.id)]);
    if (assets.some(asset => !editable(asset)) || attempts.some(attempt => [...OPEN, ...REMOTE_ACTIVE].includes(attempt.status))) conflict('Cancel or reconcile publishing before deleting this content.', 'CONTENT_PUBLISHING_IMMUTABLE');
    await tx.delete(contentAssetsTable).where(and(eq(contentAssetsTable.userId, userId), inArray(contentAssetsTable.id, assets.map(asset => asset.id))));
    // Surviving attempts retain their own frozen references after asset_id SET NULL.
    await releaseManagedStorageOwners(tx, { owners: assets.map(asset => ({ kind: 'content_asset', id: String(asset.id), userId, businessProfileId: asset.businessProfileId! })) });
    return true;
  });
}
