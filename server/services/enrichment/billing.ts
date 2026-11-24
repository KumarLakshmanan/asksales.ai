import { createHash, randomUUID } from 'node:crypto';
import { creditService } from '../CreditService.js';
import { getCreditCost } from '../../models/creditPricing/functions.js';
import { getBalance } from '../../models/wallets/functions.js';
import { enrichmentRunsTable } from '../../models/enrichmentRuns/schema.js';
import { leadsTable } from '../../models/leads/schema.js';
import { getEnrichmentRunByRequestKey, updateEnrichmentRun } from '../../models/enrichmentRuns/functions.js';
import type { EnrichmentPlatform } from './types.js';
import { EnrichmentBillingError } from './errors.js';
export { EnrichmentBillingError } from './errors.js';

type Run = typeof enrichmentRunsTable.$inferSelect;
export interface HandleEnrichmentReservation { run: Run; created: boolean; credits: number; transactionId?: number; }

/** Reserve only the configured fixed enrichment fee. This is not a quote or
 * a certified maximum for separate, variable provider usage charges. */
export async function reserveHandleEnrichment(
  userId: number, platform: EnrichmentPlatform, identifier: string, suppliedKey?: string,
): Promise<HandleEnrichmentReservation> {
  const key = suppliedKey ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/.test(key)) {
    throw new EnrichmentBillingError('Invalid enrichment request key', 400, 'INVALID_ENRICHMENT_REQUEST_KEY');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ platform, identifier })).digest('hex');
  const replay = (run: Run): HandleEnrichmentReservation => {
    if (run.requestFingerprint !== fingerprint) throw new EnrichmentBillingError('This request key belongs to different enrichment inputs', 409, 'ENRICHMENT_REQUEST_CONFLICT');
    return { run, created: false, credits: Number(run.billingCredits || 0), transactionId: run.billingTransactionId ?? undefined };
  };
  const previous = await getEnrichmentRunByRequestKey(userId, key);
  if (previous) return replay(previous);
  const credits = await getCreditCost('lead_enrichment');
  if (!Number.isFinite(credits) || credits < 0) throw new EnrichmentBillingError('Enrichment pricing is unavailable', 503, 'ENRICHMENT_PRICING_UNAVAILABLE');
  // Preserve the existing exhausted-wallet policy for zero-priced operations,
  // while paid receipt replays above remain available at a zero balance.
  if (credits === 0 && await getBalance(userId) <= 0) throw new EnrichmentBillingError('Insufficient credits', 402, 'INSUFFICIENT_CREDITS');

  const reservation = await creditService.reserveForResource({
    userId, eventKey: 'lead_enrichment', overrideAmount: credits,
    description: 'Handle enrichment fixed fee', service: 'HandleEnrichment', referenceType: 'enrichment_run',
    metadata: { requestKey: key, operation: 'enrichment', fixedFeeOnly: true },
    createResource: async tx => {
      const fields: Record<string, string> = { instagram: 'instagramHandle', twitter: 'twitterHandle', linkedin: 'linkedinUrl', facebook: 'facebookUrl', website: 'website' };
      const field = fields[platform];
      const shortHandleFits = !['instagram', 'twitter'].includes(platform) || identifier.length <= 255;
      const [lead] = await tx.insert(leadsTable).values({ userId, source: 'manual_enrichment', status: 'new', leadStatus: 'new', name: identifier,
        ...(field && shortHandleFits ? { [field]: identifier } : {}),
      }).returning({ id: leadsTable.id });
      const [run] = await tx.insert(enrichmentRunsTable).values({ userId, leadId: lead.id, leadName: `${platform}: ${identifier}`,
        status: 'pending', requestKey: key, requestFingerprint: fingerprint, billingCredits: credits.toFixed(2), billingStatus: 'reserved',
      }).returning();
      return { resource: run as Run, referenceId: String(run.id) };
    },
  });
  if (!reservation.success || !reservation.resource) {
    // The unique request key makes a concurrent losing insert roll back with
    // its debit. Return the winner's receipt without another provider dispatch.
    const existing = await getEnrichmentRunByRequestKey(userId, key);
    if (existing) return replay(existing);
    // The shared helper currently exposes this established denial as error
    // text. A generic reservation failure must remain 503, even at balance 0.
    if (reservation.error === 'Insufficient credits. Please recharge your wallet.') throw new EnrichmentBillingError('Insufficient credits', 402, 'INSUFFICIENT_CREDITS');
    throw new EnrichmentBillingError('Enrichment credits could not be reserved. Retry this same request.', 503, 'ENRICHMENT_RESERVATION_UNAVAILABLE');
  }
  const result = { run: reservation.resource, created: true, credits, transactionId: reservation.transactionId };
  try {
    await updateEnrichmentRun(result.run.id, { billingTransactionId: result.transactionId ?? null });
  } catch {
    // Provider IO has not begun, so releasing this exact reservation is safe.
    let released = !result.transactionId;
    if (result.transactionId) {
      try { released = (await creditService.refundDeduction({ userId, transactionId: result.transactionId, description: 'Enrichment dispatch receipt could not be saved' })).success; }
      catch { /* Retain the durable receipt for review when billing is unavailable. */ }
    }
    try { await updateEnrichmentRun(result.run.id, { status: 'failed', completedAt: new Date(), billingStatus: released ? 'released' : 'held', errorMessage: 'Enrichment dispatch did not begin; refresh this saved request before retrying.' }); }
    catch { /* A persisted pending receipt must never be automatically dispatched on replay. */ }
    throw new EnrichmentBillingError('Enrichment dispatch could not be recorded. Retry this same request to review its status.', 503, 'ENRICHMENT_DISPATCH_UNAVAILABLE');
  }
  return result;
}

export async function markHandleProviderDispatch(reservation: HandleEnrichmentReservation) {
  await updateEnrichmentRun(reservation.run.id, { status: 'running', providerDispatchStartedAt: new Date() });
}

export async function finishEnrichmentReservation(
  userId: number, reservation: HandleEnrichmentReservation, outcome: 'completed' | 'not_dispatched' | 'definitive_failure' | 'uncertain',
) {
  if (outcome === 'uncertain') {
    await updateEnrichmentRun(reservation.run.id, { billingStatus: 'held' });
    return;
  }
  const actualCredits = outcome === 'completed' ? reservation.credits : 0;
  if (reservation.transactionId) {
    const settlement = await creditService.settleReservation({ userId, transactionId: reservation.transactionId, actualCredits,
      description: outcome === 'completed' ? 'Settle enrichment fixed fee' : 'Release unused enrichment fixed fee',
    });
    if (!settlement.success) {
      await updateEnrichmentRun(reservation.run.id, { billingStatus: 'held' });
      throw new EnrichmentBillingError('Enrichment credit settlement needs review', 503, 'ENRICHMENT_SETTLEMENT_UNAVAILABLE');
    }
  }
  await updateEnrichmentRun(reservation.run.id, { billingStatus: outcome === 'completed' ? 'settled' : 'released' });
}

export const finishHandleReservation = finishEnrichmentReservation;
