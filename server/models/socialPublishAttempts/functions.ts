import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  socialPublishAttemptsTable,
  type InsertSocialPublishAttempt,
  type SocialPublishAttempt,
} from './schema.js';

const CLAIMABLE_STATUSES = ['pending', 'retryable_failed'] as const;

export class SocialPublishAttemptModel {
  static async renewLease(id: number, userId: number, workerId: string): Promise<boolean> {
    const rows = await db.update(socialPublishAttemptsTable).set({ leaseExpiresAt: new Date(Date.now() + 10 * 60_000) }).where(and(
      eq(socialPublishAttemptsTable.id, id), eq(socialPublishAttemptsTable.userId, userId), eq(socialPublishAttemptsTable.claimedBy, workerId),
      inArray(socialPublishAttemptsTable.status, ['claimed', 'ambiguous', 'provider_succeeded']),
    )).returning({ id: socialPublishAttemptsTable.id });
    return rows.length > 0;
  }
  static async claimReconciliation(id: number, userId: number, workerId: string): Promise<boolean> {
    const now = new Date();
    const rows = await db.update(socialPublishAttemptsTable).set({ claimedBy: workerId, claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + 10 * 60_000), updatedAt: now }).where(and(
      eq(socialPublishAttemptsTable.id, id), eq(socialPublishAttemptsTable.userId, userId),
      inArray(socialPublishAttemptsTable.status, ['ambiguous', 'provider_succeeded']),
      or(isNull(socialPublishAttemptsTable.leaseExpiresAt), lte(socialPublishAttemptsTable.leaseExpiresAt, now)),
    )).returning({ id: socialPublishAttemptsTable.id });
    return rows.length > 0;
  }

  static async releaseReconciliation(id: number, userId: number, workerId: string): Promise<void> {
    await db.update(socialPublishAttemptsTable).set({ claimedAt: null, claimedBy: null, leaseExpiresAt: null })
      .where(and(eq(socialPublishAttemptsTable.id, id), eq(socialPublishAttemptsTable.userId, userId), eq(socialPublishAttemptsTable.claimedBy, workerId)));
  }
  static async createOrGet(data: InsertSocialPublishAttempt): Promise<SocialPublishAttempt> {
    const [created] = await db
      .insert(socialPublishAttemptsTable)
      .values(data)
      .onConflictDoNothing({
        target: [socialPublishAttemptsTable.businessProfileId,
          socialPublishAttemptsTable.userId,
          socialPublishAttemptsTable.idempotencyKey,
        ],
      })
      .returning();
    if (created) return created;

    const [existing] = await db
      .select()
      .from(socialPublishAttemptsTable)
      .where(and(
        eq(socialPublishAttemptsTable.userId, data.userId),
        eq(socialPublishAttemptsTable.idempotencyKey, data.idempotencyKey),
      ))
      .limit(1);
    if (!existing) throw new Error('Publish attempt conflict could not be resolved');
    return existing;
  }

  static async findByIdForUser(id: number, userId: number): Promise<SocialPublishAttempt | undefined> {
    const [attempt] = await db
      .select()
      .from(socialPublishAttemptsTable)
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
      ))
      .limit(1);
    return attempt;
  }

  static async findByKey(userId: number, idempotencyKey: string): Promise<SocialPublishAttempt | undefined> {
    const [attempt] = await db
      .select()
      .from(socialPublishAttemptsTable)
      .where(and(
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    return attempt;
  }

  static async listForAsset(userId: number, assetId: number): Promise<SocialPublishAttempt[]> {
    return db
      .select()
      .from(socialPublishAttemptsTable)
      .where(and(
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.assetId, assetId),
      ))
      .orderBy(asc(socialPublishAttemptsTable.createdAt));
  }

  static async cancelOpenForAsset(userId: number, assetId: number): Promise<void> {
    await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.assetId, assetId),
        inArray(socialPublishAttemptsTable.status, ['pending', 'retryable_failed']),
      ));
  }

  static async cancelOpen(id: number, userId: number): Promise<boolean> {
    const cancelled = await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        inArray(socialPublishAttemptsTable.status, ['pending', 'retryable_failed']),
      ))
      .returning({ id: socialPublishAttemptsTable.id });
    return cancelled.length > 0;
  }

  static async activate(id: number, userId: number): Promise<SocialPublishAttempt | undefined> {
    const [activated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.status, 'pending'),
      ))
      .returning();
    return activated;
  }

  static async claim(
    id: number,
    userId: number,
    workerId: string,
    leaseMs = 10 * 60_000,
  ): Promise<SocialPublishAttempt | undefined> {
    const now = new Date();
    const [claimed] = await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'claimed',
        claimedAt: now,
        claimedBy: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        inArray(socialPublishAttemptsTable.status, [...CLAIMABLE_STATUSES]),
        lte(socialPublishAttemptsTable.nextAttemptAt, now),
        or(
          eq(socialPublishAttemptsTable.status, 'pending'),
          eq(socialPublishAttemptsTable.status, 'retryable_failed'),
        ),
      ))
      .returning();
    return claimed;
  }

  static async due(limit = 25): Promise<SocialPublishAttempt[]> {
    return db
      .select()
      .from(socialPublishAttemptsTable)
      .where(and(
        inArray(socialPublishAttemptsTable.status, [...CLAIMABLE_STATUSES]),
        lte(socialPublishAttemptsTable.nextAttemptAt, new Date()),
      ))
      .orderBy(asc(socialPublishAttemptsTable.nextAttemptAt), asc(socialPublishAttemptsTable.id))
      .limit(limit);
  }

  static async providerSucceededPending(limit = 25): Promise<SocialPublishAttempt[]> {
    return db
      .select()
      .from(socialPublishAttemptsTable)
      .where(and(
        eq(socialPublishAttemptsTable.status, 'provider_succeeded'),
        lte(socialPublishAttemptsTable.nextAttemptAt, new Date()),
      ))
      .orderBy(asc(socialPublishAttemptsTable.providerSucceededAt), asc(socialPublishAttemptsTable.id))
      .limit(limit);
  }

  static async ambiguousPending(limit = 25): Promise<SocialPublishAttempt[]> {
    return db
      .select()
      .from(socialPublishAttemptsTable)
      .where(and(
        eq(socialPublishAttemptsTable.status, 'ambiguous'),
        lte(socialPublishAttemptsTable.nextAttemptAt, new Date()),
        lt(socialPublishAttemptsTable.reconciliationCount, socialPublishAttemptsTable.maxAttempts),
      ))
      .orderBy(asc(socialPublishAttemptsTable.updatedAt), asc(socialPublishAttemptsTable.id))
      .limit(limit);
  }

  static async deferAmbiguousReconciliation(
    id: number,
    userId: number,
    message?: string,
  ): Promise<void> {
    await db
      .update(socialPublishAttemptsTable)
      .set({
        nextAttemptAt: new Date(Date.now() + 30 * 60_000),
        lastReconciledAt: new Date(),
        reconciliationCount: sql`${socialPublishAttemptsTable.reconciliationCount} + 1`,
        ...(message ? { errorMessage: message } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.status, 'ambiguous'),
      ));
  }

  static async quarantineExpiredClaims(): Promise<number> {
    const recovered = await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'ambiguous',
        errorCode: 'CLAIM_LEASE_EXPIRED',
        errorMessage: 'The publishing worker stopped before the provider outcome was recorded. Reconciliation is required before retrying.',
        completedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.status, 'claimed'),
        lte(socialPublishAttemptsTable.leaseExpiresAt, new Date()),
      ))
      .returning();
    if (recovered.length) {
      const { notifyOrganicPublishFailure } = await import('../../services/social/OrganicPublishNotifications.js');
      await Promise.allSettled(recovered.map(notifyOrganicPublishFailure));
    }
    return recovered.length;
  }

  static async markProviderSucceeded(
    id: number,
    userId: number,
    result: { providerPostId: string; providerPostUrl?: string; providerRequestId?: string },
  ): Promise<SocialPublishAttempt | undefined> {
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'provider_succeeded',
        providerPostId: result.providerPostId,
        providerPostUrl: result.providerPostUrl ?? null,
        providerRequestId: result.providerRequestId ?? null,
        providerSucceededAt: new Date(),
        errorCode: null,
        errorMessage: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.status, 'claimed'),
      ))
      .returning();
    return updated;
  }

  static async markAmbiguousReconciled(
    id: number,
    userId: number,
    result: { providerPostId: string; providerPostUrl?: string },
  ): Promise<SocialPublishAttempt | undefined> {
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'provider_succeeded',
        providerPostId: result.providerPostId,
        providerPostUrl: result.providerPostUrl ?? null,
        providerSucceededAt: new Date(),
        lastReconciledAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.status, 'ambiguous'),
      ))
      .returning();
    return updated;
  }

  static async markSucceeded(id: number, userId: number, warning?: { code: string; message: string }): Promise<SocialPublishAttempt | undefined> {
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'succeeded',
        errorCode: warning?.code || null,
        errorMessage: warning?.message || null,
        completedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.status, 'provider_succeeded'),
      ))
      .returning();
    if (updated && warning) await (await import('../../services/social/OrganicPublishNotifications.js')).notifyOrganicPublishFailure(updated);
    return updated;
  }

  static async deferProviderFinalization(
    id: number,
    userId: number,
    message: string,
    delayMs = 2 * 60_000,
    errorCode = 'YOUTUBE_PROCESSING',
  ): Promise<SocialPublishAttempt | undefined> {
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        nextAttemptAt: new Date(Date.now() + delayMs),
        reconciliationCount: sql`${socialPublishAttemptsTable.reconciliationCount} + 1`,
        lastReconciledAt: new Date(),
        errorCode,
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.status, 'provider_succeeded'),
      ))
      .returning();
    return updated;
  }

  static async markProviderProcessingFailed(
    id: number,
    userId: number,
    code: string,
    message: string,
  ): Promise<SocialPublishAttempt | undefined> {
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        reconciliationCount: sql`${socialPublishAttemptsTable.reconciliationCount} + 1`,
        lastReconciledAt: new Date(),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        eq(socialPublishAttemptsTable.status, 'provider_succeeded'),
      ))
      .returning();
    if (updated) await (await import('../../services/social/OrganicPublishNotifications.js')).notifyOrganicPublishFailure(updated);
    return updated;
  }

  static async markFailure(
    attempt: SocialPublishAttempt,
    error: { code?: string; message: string; ambiguous?: boolean; retryable?: boolean; retryAfterSeconds?: number },
  ): Promise<SocialPublishAttempt | undefined> {
    const nextCount = attempt.attemptCount + 1;
    const exhausted = nextCount >= attempt.maxAttempts;
    const status = error.ambiguous
      ? 'ambiguous'
      : (!error.retryable || exhausted ? 'failed' : 'retryable_failed');
    const backoffMinutes = Math.min(80, 5 * Math.pow(2, Math.max(0, nextCount - 1)));
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        status,
        attemptCount: nextCount,
        errorCode: error.code ?? null,
        errorMessage: error.message,
        nextAttemptAt: status === 'retryable_failed'
          ? new Date(Date.now() + (error.retryAfterSeconds && error.retryAfterSeconds > 0
            ? error.retryAfterSeconds * 1000
            : backoffMinutes * 60_000))
          : attempt.nextAttemptAt,
        completedAt: status === 'failed' || status === 'ambiguous' ? new Date() : null,
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, attempt.id),
        eq(socialPublishAttemptsTable.userId, attempt.userId),
        eq(socialPublishAttemptsTable.status, 'claimed'),
      ))
      .returning();
    if (updated) await (await import('../../services/social/OrganicPublishNotifications.js')).notifyOrganicPublishFailure(updated);
    return updated;
  }

  static async markRemoteDeleted(id: number, userId: number): Promise<SocialPublishAttempt | undefined> {
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        status: 'remote_deleted',
        lastReconciledAt: new Date(),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
      ))
      .returning();
    return updated;
  }

  static async markReconciled(
    id: number,
    userId: number,
    providerPostUrl?: string,
  ): Promise<SocialPublishAttempt | undefined> {
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        lastReconciledAt: new Date(),
        ...(providerPostUrl ? { providerPostUrl } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
      ))
      .returning();
    return updated;
  }

  static async recordOrganicInsights(
    id: number,
    userId: number,
    insights: Record<string, unknown>,
    source: 'webhook' | 'poll',
  ): Promise<SocialPublishAttempt | undefined> {
    const [updated] = await db
      .update(socialPublishAttemptsTable)
      .set({
        organicInsights: {
          ...insights,
          source,
          observedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialPublishAttemptsTable.id, id),
        eq(socialPublishAttemptsTable.userId, userId),
        inArray(socialPublishAttemptsTable.status, ['succeeded', 'remote_deleted']),
      ))
      .returning();
    return updated;
  }
}
