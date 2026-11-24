import { randomUUID } from 'node:crypto';
import { creditService } from '../CreditService.js';
import { getCreditCost } from '../../models/creditPricing/functions.js';
import { assertBusinessConfigurationOwner, currentBusinessScope } from '../../tenancy/businessContext.js';

const activeBusinesses = new Set<number>();

/** Atomically precharge the bounded operation before any paid provider work. */
export async function withDemoParseCredits<T>(userId: number, work: () => Promise<T>): Promise<T> {
  assertBusinessConfigurationOwner(userId);
  const business = currentBusinessScope()?.businessProfileId || userId;
  if (activeBusinesses.has(business) || activeBusinesses.size >= 4) {
    const error = new Error('Demo parsing is already in progress. Please retry shortly.') as Error & { statusCode: number };
    error.statusCode = 429;
    throw error;
  }
  activeBusinesses.add(business);
  try {
    const price = Math.max(10, Number(await getCreditCost('ai_demo_parse')) || 0);
    const reservation = await creditService.deductForEvent({
      userId, eventKey: 'ai_demo_parse', overrideAmount: price,
      description: 'Parse AI training demo', service: 'support_ai',
      referenceType: 'ai_demo_parse', referenceId: randomUUID(),
    });
    if (!reservation.success) {
      const error = new Error('Unable to reserve credits for demo parsing') as Error & { statusCode: number };
      error.statusCode = 402;
      throw error;
    }
    try { return await work(); }
    catch (error) {
      if (reservation.transactionId) {
        await creditService.refundDeduction({ userId, transactionId: reservation.transactionId, description: 'Demo parsing failed' });
      }
      throw error;
    }
  } finally {
    activeBusinesses.delete(business);
  }
}
