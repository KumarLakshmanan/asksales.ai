import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { enrichmentRunsTable } from '../../models/enrichmentRuns/schema.js';
import { walletTransactionsTable } from '../../models/walletTransactions/schema.js';
import { queueRegistry, QUEUE_NAMES } from '../../queues/index.js';
import { withBusinessScope } from '../../tenancy/businessContext.js';
import { withBillingScope } from '../../tenancy/billingContext.js';
import { creditService } from '../CreditService.js';
import { EnrichmentBillingError } from './errors.js';
import { asRecord as object } from '../../../shared/records.js';

export interface RemovedLeadEnrichmentJob {
  readonly queueName: 'lead-enrichment';
  readonly jobId: string;
  readonly data: Readonly<{
    userId: number;
    businessProfileId: number;
    businessActorUserId: number;
    billingOrganizationId: number;
    billingActorUserId: number;
    leadId: number;
    enrichmentRunId?: number;
  }>;
}
export interface PreparedLeadEnrichmentRemoval {
  readonly intentId: string;
  readonly job: RemovedLeadEnrichmentJob;
  readonly reservationTransactionId: number | null;
}
export interface LeadEnrichmentReleaseResult {
  status: 'released' | 'already_released' | 'not_applicable' | 'not_removed' | 'not_releasable';
  runId?: number;
  reservationTransactionId?: number;
  creditsRefunded: number;
}
type Phase = 'prepared' | 'failed' | 'uncertain' | 'release_pending' | 'released' | 'not_releasable';
type Intent = PreparedLeadEnrichmentRemoval & { phase: Phase; createdAt: string; confirmedAt?: string };
type Run = typeof enrichmentRunsTable.$inferSelect;
type Ledger = typeof walletTransactionsTable.$inferSelect;
const identityFields = ['userId', 'businessProfileId', 'businessActorUserId', 'billingOrganizationId', 'billingActorUserId', 'leadId', 'enrichmentRunId'] as const;
const mismatch = () => new EnrichmentBillingError('Original lead reservation identity does not match; no credits were released.', 409, 'ENRICHMENT_REMOVAL_IDENTITY_MISMATCH');
const unavailable = () => new EnrichmentBillingError('Removal cleanup needs reconciliation. The saved intent retains its original reservation identity.', 503, 'ENRICHMENT_REMOVAL_RELEASE_UNAVAILABLE');
const cents = (value: unknown) => {
  const amount = Number(value), result = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(result)) throw mismatch();
  return result;
};

function snapshot(input: RemovedLeadEnrichmentJob): RemovedLeadEnrichmentJob {
  if (input?.queueName !== QUEUE_NAMES.LEAD_ENRICHMENT || typeof input.jobId !== 'string' || !input.jobId.length || input.jobId.length > 256) throw mismatch();
  const data = Object.freeze(Object.fromEntries(identityFields.map(key => [key, input.data?.[key]]))) as RemovedLeadEnrichmentJob['data'];
  if (data.enrichmentRunId !== undefined && identityFields.some(key => !Number.isSafeInteger(data[key]) || Number(data[key]) <= 0)) throw mismatch();
  if (data.enrichmentRunId !== undefined && data.businessActorUserId !== data.billingActorUserId) throw mismatch();
  return Object.freeze({ queueName: QUEUE_NAMES.LEAD_ENRICHMENT, jobId: input.jobId, data });
}
function pinned<T>(job: RemovedLeadEnrichmentJob, work: () => T): T {
  // Trusted cleanup only. This owner scope never executes provider work; it
  // permits release after staff revocation, exactly like the worker callback.
  return withBusinessScope({ userId: job.data.userId, businessProfileId: job.data.businessProfileId, actorUserId: job.data.userId }, () =>
    withBillingScope({ organizationId: job.data.billingOrganizationId, actorUserId: job.data.billingActorUserId,
      businessProfileId: job.data.businessProfileId, businessOwnerUserId: job.data.userId }, work));
}
function sameJob(a: RemovedLeadEnrichmentJob, b: RemovedLeadEnrichmentJob): boolean {
  return Boolean(a?.data && b?.data && a.queueName === b.queueName && a.jobId === b.jobId && identityFields.every(key => a.data[key] === b.data[key]));
}
function savedIntent(run: Run, ticket: PreparedLeadEnrichmentRemoval): Intent {
  const saved = object(run.removalIntents)[ticket.intentId] as Intent | undefined;
  if (!saved || saved.intentId !== ticket.intentId || !sameJob(saved.job, ticket.job) || saved.reservationTransactionId !== ticket.reservationTransactionId) throw mismatch();
  return saved;
}
async function lockedRun(tx: typeof db, job: RemovedLeadEnrichmentJob): Promise<Run> {
  const [run] = await tx.select().from(enrichmentRunsTable).where(eq(enrichmentRunsTable.id, job.data.enrichmentRunId!)).for('update') as Run[];
  if (!run || run.userId !== job.data.userId || run.businessProfileId !== job.data.businessProfileId
    || (run.leadId !== null && run.leadId !== job.data.leadId) || !run.requestKey?.startsWith(`deep:${job.data.businessActorUserId}:`)) throw mismatch();
  return run;
}
async function originalReservation(tx: typeof db, run: Run, job: RemovedLeadEnrichmentJob): Promise<Ledger | undefined> {
  if (!run.billingTransactionId) {
    if (cents(run.billingCredits) !== 0) throw mismatch();
    return undefined;
  }
  const [original] = await tx.select().from(walletTransactionsTable).where(and(
    eq(walletTransactionsTable.id, run.billingTransactionId), eq(walletTransactionsTable.userId, job.data.userId),
    eq(walletTransactionsTable.organizationId, job.data.billingOrganizationId),
    eq(walletTransactionsTable.actorUserId, job.data.billingActorUserId), eq(walletTransactionsTable.billingBusinessProfileId, job.data.businessProfileId),
  )).limit(1) as Ledger[];
  const metadata = object(original?.metadata);
  if (!original || original.type !== 'deduction' || Number(original.amount) > 0 || original.referenceType !== 'enrichment_run'
    || original.referenceId !== String(run.id) || metadata.reservation !== true || metadata.requestKey !== run.requestKey
    || metadata.leadId !== job.data.leadId || Math.abs(cents(original.amount)) !== cents(run.billingCredits)) throw mismatch();
  return original;
}
async function saveIntent(tx: typeof db, run: Run, intent: Intent, changes: Partial<Run> = {}) {
  await tx.update(enrichmentRunsTable).set({ ...changes, removalIntents: { ...object(run.removalIntents), [intent.intentId]: intent } }).where(eq(enrichmentRunsTable.id, run.id));
}
const result = (status: LeadEnrichmentReleaseResult['status'], run?: Run, creditsRefunded = 0): LeadEnrichmentReleaseResult => ({ status, creditsRefunded,
  ...(run ? { runId: run.id, ...(run.billingTransactionId ? { reservationTransactionId: run.billingTransactionId } : {}) } : {}),
});

/** Call BEFORE removing the fetched BullMQ job. This does not cancel or claim
 * provider execution. Old jobs without a prepaid run need no financial cleanup. */
export async function prepareLeadEnrichmentJobRemoval(input: RemovedLeadEnrichmentJob): Promise<PreparedLeadEnrichmentRemoval | null> {
  const job = snapshot(input);
  if (job.data.enrichmentRunId === undefined) return null;
  const actual = await queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT).getJob(job.jobId);
  if (!actual || identityFields.some(key => actual.data[key] !== job.data[key])) throw mismatch();
  return pinned(job, () => db.transaction(async (tx: typeof db) => {
    const run = await lockedRun(tx, job); await originalReservation(tx, run, job);
    // Each removal handle needs its own outcome. A failed concurrent delete
    // must not mark another handle's successful removal as uncertain.
    const intent: Intent = { intentId: randomUUID(), job, reservationTransactionId: run.billingTransactionId, phase: 'prepared', createdAt: new Date().toISOString() };
    await saveIntent(tx, run, intent);
    return Object.freeze(intent);
  }));
}

/** Call only after removal threw. Never downgrade a concurrently confirmed
 * cleanup; a failed/uncertain intent is retained and cannot authorize release. */
export async function recordFailedLeadEnrichmentJobRemoval(ticket: PreparedLeadEnrichmentRemoval, outcome: 'failed' | 'uncertain' = 'uncertain'): Promise<void> {
  const job = snapshot(ticket.job);
  await pinned(job, () => db.transaction(async (tx: typeof db) => {
    const run = await lockedRun(tx, job), intent = savedIntent(run, ticket);
    if (intent.phase === 'prepared') await saveIntent(tx, run, { ...intent, phase: outcome });
  }));
}

async function release(ticket: PreparedLeadEnrichmentRemoval, confirmRemoval: boolean): Promise<LeadEnrichmentReleaseResult> {
  const job = snapshot(ticket.job);
  if (await queueRegistry.getQueue(QUEUE_NAMES.LEAD_ENRICHMENT).getJob(job.jobId)) return result('not_removed');
  return pinned(job, async () => {
    const claimed = await db.transaction(async (tx: typeof db) => {
      const run = await lockedRun(tx, job), intent = savedIntent(run, ticket);
      if (run.billingTransactionId !== ticket.reservationTransactionId) throw mismatch();
      const original = await originalReservation(tx, run, job);
      if (intent.phase === 'failed' || intent.phase === 'uncertain' || intent.phase === 'not_releasable'
        || (intent.phase === 'prepared' && !confirmRemoval)) return { outcome: result('not_releasable', run) };
      const releaseInProgress = intent.phase === 'release_pending' || intent.phase === 'released';
      // The database claim is authoritative. Removal can succeed after a worker
      // finished, or while another job referencing this attempt has claimed it.
      if (run.providerDispatchStartedAt || (run.status !== 'pending' && !(releaseInProgress && run.status === 'failed'))) {
        await saveIntent(tx, run, { ...intent, phase: 'not_releasable', confirmedAt: intent.confirmedAt ?? new Date().toISOString() });
        return { outcome: result('not_releasable', run) };
      }
      if (original) {
        const [settled] = await tx.select().from(walletTransactionsTable).where(and(
          eq(walletTransactionsTable.organizationId, original.organizationId), eq(walletTransactionsTable.type, 'refund'),
          or(eq(walletTransactionsTable.referenceType, 'credit_reservation'), eq(walletTransactionsTable.referenceType, 'wallet_transaction')),
          eq(walletTransactionsTable.referenceId, String(original.id)),
        )).limit(1) as Ledger[];
        if (settled && cents(settled.amount) !== Math.abs(cents(original.amount))) {
          await saveIntent(tx, run, { ...intent, phase: 'not_releasable' });
          return { outcome: result('not_releasable', run) };
        }
      }
      if (intent.phase === 'released') return { outcome: result('already_released', run) };
      const error = 'The queued enrichment was removed before provider dispatch. Its unused fixed-fee reservation is being released.';
      await saveIntent(tx, run, { ...intent, phase: 'release_pending', confirmedAt: intent.confirmedAt ?? new Date().toISOString() }, {
        status: 'failed', completedAt: new Date(), billingStatus: 'held', errorMessage: error,
        executionResult: { success: false, iterations: 0, totalHandlesProcessed: 0, iterationLog: [], error,
          aggregatedData: { emails: [], phones: [], websites: [], socialProfiles: {}, company: {}, person: {}, socialStats: {}, rawScrapedData: {} } },
      });
      return { run };
    });
    if (claimed.outcome) return claimed.outcome;
    const run = claimed.run!;
    let refunded = 0, already = false;
    if (run.billingTransactionId) {
      try {
        const settlement = await creditService.settleReservation({ userId: job.data.userId, transactionId: run.billingTransactionId,
          actualCredits: 0, description: `Release unused fixed fee for removed lead job ${job.jobId}` });
        if (!settlement.success) throw unavailable();
        if (cents(settlement.creditsRefunded) !== cents(run.billingCredits)) throw unavailable();
        already = settlement.alreadyRefunded === true;
        refunded = already ? 0 : settlement.creditsRefunded;
      } catch { throw unavailable(); }
    }
    await db.transaction(async (tx: typeof db) => {
      const current = await lockedRun(tx, job), intent = savedIntent(current, ticket);
      if (current.providerDispatchStartedAt || current.status !== 'failed' || current.billingTransactionId !== ticket.reservationTransactionId) throw mismatch();
      await saveIntent(tx, current, { ...intent, phase: 'released' }, { billingStatus: 'released',
        errorMessage: 'The queued enrichment was removed before provider dispatch. Its unused fixed fee was released.' });
    });
    return result(already ? 'already_released' : 'released', run, refunded);
  });
}

/** Call ONLY after await job.remove() fulfilled. Successful removal alone is
 * insufficient: eligibility is also checked against the durable attempt. */
export function releaseRemovedLeadEnrichmentReservation(ticket: PreparedLeadEnrichmentRemoval): Promise<LeadEnrichmentReleaseResult> {
  return release(ticket, true);
}

/** Recovery retries only a durably confirmed release_pending/released intent.
 * Never infer a successful removal from Redis absence or a prepared intent. */
export function retryConfirmedLeadEnrichmentRemovalRelease(ticket: PreparedLeadEnrichmentRemoval): Promise<LeadEnrichmentReleaseResult> {
  return release(ticket, false);
}
