import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { leadsTable } from '../../models/leads/schema.js';
import { enrichmentRunsTable } from '../../models/enrichmentRuns/schema.js';
import { walletTransactionsTable } from '../../models/walletTransactions/schema.js';
import { getEnrichmentRunById, getEnrichmentRunByRequestKey, updateEnrichmentRun } from '../../models/enrichmentRuns/functions.js';
import { getCreditCost } from '../../models/creditPricing/functions.js';
import { getBalance } from '../../models/wallets/functions.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { creditService } from '../CreditService.js';
import { EnrichmentBillingError, finishEnrichmentReservation, type HandleEnrichmentReservation } from './billing.js';
import { buildInitialHandles, emptyAggregation } from './helpers.js';
import type { EnrichmentResult } from './types.js';

const actor = (userId: number) => currentBusinessScope()?.actorUserId ?? userId;
const fingerprint = (leadId: number, lead: Parameters<typeof buildInitialHandles>[0]) => createHash('sha256')
  .update(JSON.stringify({ leadId, handles: buildInitialHandles(lead) })).digest('hex');

export const failedDeepResult = (error: string): EnrichmentResult => ({ success: false, iterations: 0,
  totalHandlesProcessed: 0, aggregatedData: emptyAggregation(), iterationLog: [], error });

/** Reserve the configured fixed platform fee, never an invented provider maximum. */
export async function reserveDeepEnrichment(userId: number, leadId: number, suppliedKey: string = randomUUID()): Promise<HandleEnrichmentReservation> {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/.test(suppliedKey)) throw new EnrichmentBillingError('Invalid enrichment request key', 400, 'INVALID_ENRICHMENT_REQUEST_KEY');
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId))).limit(1);
  if (!lead) throw new EnrichmentBillingError('Lead not found', 404, 'ENRICHMENT_LEAD_UNAVAILABLE');
  const key = `deep:${actor(userId)}:${createHash('sha256').update(suppliedKey).digest('hex')}`;
  const inputFingerprint = fingerprint(leadId, lead);
  const replay = (run: typeof enrichmentRunsTable.$inferSelect): HandleEnrichmentReservation => {
    if (run.leadId !== leadId) throw new EnrichmentBillingError('This saved request belongs to different enrichment inputs', 409, 'ENRICHMENT_REQUEST_CONFLICT');
    if (Number(run.billingCredits) > 0 && !run.billingTransactionId && !run.executionResult) throw new EnrichmentBillingError('The original reservation receipt is still being saved. Retry this same request.', 503, 'ENRICHMENT_DISPATCH_UNAVAILABLE');
    return { run, created: false, credits: Number(run.billingCredits || 0), transactionId: run.billingTransactionId ?? undefined };
  };
  const previous = await getEnrichmentRunByRequestKey(userId, key);
  if (previous) return replay(previous);
  if (!buildInitialHandles(lead).length) throw new EnrichmentBillingError('No social handles, URLs, or identifiers found on this lead to enrich from', 400, 'ENRICHMENT_INPUT_UNAVAILABLE');
  const credits = await getCreditCost('lead_enrichment');
  if (!Number.isFinite(credits) || credits < 0) throw new EnrichmentBillingError('Enrichment pricing is unavailable', 503, 'ENRICHMENT_PRICING_UNAVAILABLE');
  if (credits === 0 && await getBalance(userId) <= 0) throw new EnrichmentBillingError('Insufficient credits', 402, 'INSUFFICIENT_CREDITS');
  const reserved = await creditService.reserveForResource({ userId, eventKey: 'lead_enrichment', overrideAmount: credits,
    service: 'LeadEnrichmentOrchestrator', description: 'Deep enrichment fixed fee', referenceType: 'enrichment_run',
    metadata: { requestKey: key, fixedFeeOnly: true, leadId },
    createResource: async tx => {
      const [run] = await tx.insert(enrichmentRunsTable).values({ userId, leadId, leadName: lead.fullName || lead.name || lead.email,
        leadEmail: lead.email, status: 'pending', requestKey: key, requestFingerprint: inputFingerprint,
        billingCredits: credits.toFixed(2), billingStatus: 'reserved' }).returning();
      return { resource: run as typeof enrichmentRunsTable.$inferSelect, referenceId: String(run.id) };
    },
  });
  if (!reserved.success || !reserved.resource) {
    const winner = await getEnrichmentRunByRequestKey(userId, key);
    if (winner) return replay(winner);
    if (reserved.error === 'Insufficient credits. Please recharge your wallet.') throw new EnrichmentBillingError('Insufficient credits', 402, 'INSUFFICIENT_CREDITS');
    throw new EnrichmentBillingError('Enrichment credits could not be reserved. Retry this same request.', 503, 'ENRICHMENT_RESERVATION_UNAVAILABLE');
  }
  const reservation = { run: reserved.resource, created: true, credits, transactionId: reserved.transactionId };
  try { await updateEnrichmentRun(reservation.run.id, { billingTransactionId: reserved.transactionId ?? null }); }
  catch (error) {
    await finishEnrichmentReservation(userId, reservation, 'not_dispatched');
    await updateEnrichmentRun(reservation.run.id, { status: 'failed', completedAt: new Date(), executionResult: failedDeepResult('Dispatch receipt could not be saved') });
    throw error;
  }
  return reservation;
}

export async function loadDeepEnrichment(userId: number, leadId: number, runId: number): Promise<HandleEnrichmentReservation> {
  const run = await getEnrichmentRunById(runId);
  if (!run || run.userId !== userId || run.leadId !== leadId || !run.requestKey?.startsWith(`deep:${actor(userId)}:`)) {
    throw new EnrichmentBillingError('Enrichment request not found', 404, 'ENRICHMENT_REQUEST_UNAVAILABLE');
  }
  if (Number(run.billingCredits) > 0 && !run.billingTransactionId && !run.executionResult) throw new EnrichmentBillingError('The original reservation receipt is unavailable; provider work was not started.', 503, 'ENRICHMENT_DISPATCH_UNAVAILABLE');
  return { run, created: false, credits: Number(run.billingCredits || 0), transactionId: run.billingTransactionId ?? undefined };
}

/** A second consumer can reopen a saved outcome, but cannot claim provider IO twice. */
export async function claimDeepEnrichment(reservation: HandleEnrichmentReservation) {
  const [claimed] = await db.update(enrichmentRunsTable).set({ status: 'running' }).where(and(
    eq(enrichmentRunsTable.id, reservation.run.id), eq(enrichmentRunsTable.status, 'pending'),
    isNull(enrichmentRunsTable.executionResult), isNull(enrichmentRunsTable.providerDispatchStartedAt),
  )).returning();
  return claimed;
}

export function deepInputMatches(reservation: HandleEnrichmentReservation, leadId: number, lead: Parameters<typeof buildInitialHandles>[0]) {
  return reservation.run.requestFingerprint === fingerprint(leadId, lead);
}

/** Called only by the existing trusted owner cancellation callback, never to
 * execute work as a revoked actor. Verify the original payer before release. */
export async function cancelUnstartedDeepForAuthority(data: Record<string, unknown>, reason = 'Business staff access was removed before enrichment began. The unused fixed fee was released.') {
  const fields = ['userId', 'leadId', 'enrichmentRunId', 'businessProfileId', 'businessActorUserId', 'billingActorUserId', 'billingOrganizationId'];
  if (fields.some(key => !Number.isSafeInteger(data[key]) || Number(data[key]) <= 0)) return;
  const run = await getEnrichmentRunById(Number(data.enrichmentRunId));
  if (!run || run.userId !== data.userId || run.leadId !== data.leadId || run.businessProfileId !== data.businessProfileId
    || !run.requestKey?.startsWith(`deep:${data.businessActorUserId}:`) || run.providerDispatchStartedAt || run.status !== 'pending') return;
  if (run.billingTransactionId) {
    const [original] = await db.select().from(walletTransactionsTable).where(and(
      eq(walletTransactionsTable.id, run.billingTransactionId), eq(walletTransactionsTable.userId, Number(data.userId)),
      eq(walletTransactionsTable.organizationId, Number(data.billingOrganizationId)),
      eq(walletTransactionsTable.billingBusinessProfileId, Number(data.businessProfileId)),
      eq(walletTransactionsTable.actorUserId, Number(data.billingActorUserId)),
    )).limit(1);
    if (!original || original.type !== 'deduction' || original.referenceType !== 'enrichment_run'
      || original.referenceId !== String(run.id) || (original.metadata as { reservation?: boolean } | null)?.reservation !== true) {
      throw new Error('Original enrichment reservation authority does not match');
    }
  }
  const [cancelled] = await db.update(enrichmentRunsTable).set({ status: 'failed', completedAt: new Date() }).where(and(
    eq(enrichmentRunsTable.id, run.id), eq(enrichmentRunsTable.status, 'pending'), isNull(enrichmentRunsTable.providerDispatchStartedAt),
  )).returning();
  if (!cancelled) return;
  await finishEnrichmentReservation(Number(data.userId), { run, created: false, credits: Number(run.billingCredits || 0), transactionId: run.billingTransactionId ?? undefined }, 'not_dispatched');
  const result = failedDeepResult(reason);
  await updateEnrichmentRun(run.id, { executionResult: result, errorMessage: result.error });
}
