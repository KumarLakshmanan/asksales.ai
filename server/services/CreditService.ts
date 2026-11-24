import { normalizeCapacityError } from './billing/entitlements.js';
import { currentBillingScope } from '../tenancy/billingContext.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { getRechargeRate, getUsageRate } from '../models/creditPricing/functions.js';
import { getUsdToInrRate } from '../utils/currency.js';
import { currentUsageContext, insightChannel, insightProcess, validConversationRef } from './insights/UsageContext.js';
import type { InsightsAttribution, InsightsBillingContext, InsightsPricingSnapshot } from '../../shared/insightsBilling.js';
/**
 * Credit Service
 * Centralized service for credit deduction and tracking
 *
 * Wallet mutations and their audit records are committed in one DB transaction.
 */

import { logger } from '../utils/logger.js';
import { getOrCreateWallet, getBalance } from '../models/wallets/functions.js';
import { creditEventLogsTable } from '../models/creditEventLogs/schema.js';
import { getCreditCost } from '../models/creditPricing/functions.js';
import { db } from '../models/db.js';
import { walletsTable } from '../models/wallets/schema.js';
import { walletTransactionsTable } from '../models/walletTransactions/schema.js';
import { walletRechargeClaimsTable } from '../models/walletRechargeClaims/schema.js';
import { and, eq, or, sql } from 'drizzle-orm';
import { invalidateDashboardCache } from './dashboardCache.js';

export class PaymentClaimError extends Error {
  constructor(message: string, public readonly statusCode = 409) {
    super(message);
    this.name = 'PaymentClaimError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  let value = error;
  for (let depth = 0; value && typeof value === 'object' && depth < 5; depth++) {
    const candidate = value as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    value = candidate.cause;
  }
  return false;
}

interface DeductCreditOptions {
  userId: number;
  eventKey: string;
  description: string;
  service?: string;
  referenceType?: string;
  referenceId?: string;
  apiProvider?: string;
  apiCostCents?: number;
  metadata?: Record<string, unknown>;
  // Override credit amount (if not using pricing table)
  overrideAmount?: number;
  // Bill usage that already happened even if it takes the balance below zero
  allowOverdraft?: boolean;
  insights?: InsightsAttribution;
  pricingSnapshot?: InsightsPricingSnapshot;
}

async function billingMetadata(options: DeductCreditOptions, organizationId: number): Promise<Record<string, unknown>> {
  const operation=currentUsageContext(), business=currentBusinessScope();
  if (!business) return { ...options.metadata };
  const conversation=validConversationRef(options.insights?.conversation||operation?.conversation)
    ||(options.referenceType==='chat_thread'&&/^[1-9]\d*$/.test(options.referenceId||'')
      ?{kind:'workspace' as const,id:Number(options.referenceId)}:undefined);
  const pricing:InsightsPricingSnapshot=options.pricingSnapshot||operation?.pricing||{
    version:1,capturedAt:new Date().toISOString(),source:'fixed',usdToInr:getUsdToInrRate(),
    creditsPerInr:await getRechargeRate(),usageCreditsPerInr:await getUsageRate(),minimumCredits:0,rounding:'fixed',
  };
  const analytics:InsightsBillingContext={
    version:1,businessProfileId:business.businessProfileId,organizationId,
    attemptId:options.insights?.attemptId||operation?.attemptId,operationId:options.insights?.operationId||operation?.operationId,
    conversation,contactId:options.insights?.contactId||operation?.contactId,agent:options.insights?.agent||operation?.agent,
    actorUserId:business.actorUserId||options.userId,
    channel:conversation?.kind==='widget'?'widget':conversation?.kind==='workspace'?'workspace'
      :insightChannel(options.insights?.channel||operation?.channel||options.metadata?.channel),
    process:options.insights?.process||operation?.process||insightProcess(options.eventKey),pricing,
  };
  return {...options.metadata,_insights:analytics};
}

interface CreditDeductionResult {
  success: boolean;
  creditsDeducted: number;
  balanceAfter: number;
  transactionId?: number;
  error?: string;
  alreadyCharged?: boolean;
}

interface CreditRefundResult {
  success: boolean;
  creditsRefunded: number;
  balanceAfter: number;
  alreadyRefunded?: boolean;
  error?: string;
}

export interface CreditReservationResult<T> extends CreditDeductionResult {
  resource?: T;
}

type Tx = typeof db;
type Wallet = Awaited<ReturnType<typeof getOrCreateWallet>>;

class CreditService {
  private static instance: CreditService;

  static getInstance(): CreditService {
    if (!this.instance) this.instance = new CreditService();
    return this.instance;
  }

  /**
   * Metadata stored on both ledger rows of a charge. `_event` lets a later refund
   * write its reversal usage row from the deduction alone, and
   * `purchaseCreditsPerInr` lets revenue value these credits at the rate the
   * customer was paying when the charge happened.
   */
  private async chargeMetadata(options: DeductCreditOptions, wallet: Wallet, extra: Record<string, unknown> = {}) {
    const purchaseCreditsPerInr = Number(await getRechargeRate());
    return {
      ...(await billingMetadata(options, wallet.organizationId)),
      ...extra,
      _event: { key: options.eventKey, service: options.service, apiProvider: options.apiProvider },
      ...(Number.isFinite(purchaseCreditsPerInr) && purchaseCreditsPerInr > 0 ? { purchaseCreditsPerInr } : {}),
    } as Record<string, unknown>;
  }

  /**
   * Takes the credits from the wallet. Normally the balance must cover the cost.
   * `allowOverdraft` is for usage that has already happened (a provider call that
   * completed): while the balance is above zero it is billed in full even if that
   * takes the balance below zero, and the zero-balance gate then blocks further
   * paid work until the wallet is recharged. Once the balance is at or below
   * zero nothing more is debited, so paths without a balance gate (background
   * assistants, inbound replies) cannot run the debt up without limit.
   */
  private async debitWallet(tx: Tx, wallet: Wallet, creditCost: number, allowOverdraft?: boolean) {
    const [updated] = await tx.update(walletsTable).set({
      balance: sql`${walletsTable.balance} - ${creditCost}`,
      totalCreditsUsed: sql`${walletsTable.totalCreditsUsed} + ${creditCost}`,
      updatedAt: new Date(),
    }).where(and(eq(walletsTable.id, wallet.id), allowOverdraft
      ? sql`${walletsTable.balance} > 0`
      : sql`${walletsTable.balance} >= ${creditCost}`)).returning();
    return updated as { balance: string } | undefined;
  }

  /** Writes the deduction and its usage row, linked to each other. */
  private async recordCharge(tx: Tx, wallet: Wallet, options: DeductCreditOptions, creditCost: number,
    balanceAfter: number, referenceId: string | undefined, metadata: Record<string, unknown>): Promise<number> {
    const stored = balanceAfter < 0 ? { ...metadata, overdraft: true } : metadata;
    const [transaction] = await tx.insert(walletTransactionsTable).values({
      organizationId: wallet.organizationId,
      actorUserId: currentBillingScope()?.actorUserId ?? currentBusinessScope()?.actorUserId ?? currentBusinessScope()?.userId ?? wallet.userId,
      billingBusinessProfileId: currentBusinessScope()?.businessProfileId,
      userId: options.userId,
      type: 'deduction',
      amount: (-creditCost).toFixed(2),
      balanceAfter: balanceAfter.toFixed(2),
      description: options.description,
      category: this.getCategoryForEvent(options.eventKey),
      referenceType: options.referenceType,
      referenceId,
      metadata: stored,
    }).returning({ id: walletTransactionsTable.id });
    await tx.insert(creditEventLogsTable).values({
      organizationId: wallet.organizationId,
      userId: options.userId,
      eventKey: options.eventKey,
      creditsUsed: creditCost.toFixed(2),
      balanceAfter: balanceAfter.toFixed(2),
      description: options.description,
      service: options.service,
      referenceType: options.referenceType,
      referenceId,
      apiProvider: options.apiProvider,
      apiCostCents: options.apiCostCents != null ? Number(options.apiCostCents.toFixed(8)) : undefined,
      walletTransactionId: transaction.id,
      metadata: stored,
    });
    if (balanceAfter < 0) logger.warn({ userId: options.userId, eventKey: options.eventKey, creditCost, balanceAfter }, 'Completed usage billed into a negative balance');
    return transaction.id;
  }

  /**
   * Records an action that cost nothing (no price configured, a disabled price,
   * or an explicitly free action) so it still appears in usage reports. Best
   * effort: a failed log never fails the action.
   */
  private async recordFreeEvent(options: DeductCreditOptions, balance: number): Promise<void> {
    try {
      const wallet = await getOrCreateWallet(options.userId);
      await db.insert(creditEventLogsTable).values({
        organizationId: wallet.organizationId,
        userId: options.userId,
        eventKey: options.eventKey,
        creditsUsed: '0.00',
        balanceAfter: balance.toFixed(2),
        description: options.description,
        service: options.service,
        referenceType: options.referenceType,
        referenceId: options.referenceId,
        apiProvider: options.apiProvider,
        apiCostCents: options.apiCostCents != null ? Number(options.apiCostCents.toFixed(8)) : undefined,
        metadata: { ...(await billingMetadata(options, wallet.organizationId)), free: true },
      });
    } catch (error) {
      logger.warn({ err: error, userId: options.userId, eventKey: options.eventKey }, 'Free usage event was not logged');
    }
  }

  /**
   * Deduct credits for an event.
   * Returns success=true if deducted, success=false if insufficient balance.
   * If credit cost is 0 (event not configured or disabled), it still succeeds without deduction
   * and the event is logged with 0 credits.
   */
  async deductForEvent(options: DeductCreditOptions): Promise<CreditDeductionResult> {
    try {
      const { userId, eventKey, overrideAmount } = options;

      // Get credit cost for this event
      const creditCost = overrideAmount ?? await getCreditCost(eventKey);

      // If cost is 0, no deduction needed
      if (creditCost <= 0) {
        const balance = await getBalance(userId);
        await this.recordFreeEvent(options, balance);
        return { success: true, creditsDeducted: 0, balanceAfter: balance };
      }

      const billingWallet = await getOrCreateWallet(userId);
      const storedMetadata = await this.chargeMetadata(options, billingWallet);
      const deduction = await db.transaction(async (tx: Tx) => {
        const wallet = await this.debitWallet(tx, billingWallet, creditCost, options.allowOverdraft);
        if (!wallet) return null;
        const balanceAfter = Number(wallet.balance);
        const transactionId = await this.recordCharge(tx, billingWallet, options, creditCost, balanceAfter, options.referenceId, storedMetadata);
        return { balanceAfter, transactionId };
      });

      if (!deduction) {
        const balance = await getBalance(userId);
        return {
          success: false,
          creditsDeducted: 0,
          balanceAfter: balance,
          error: "Insufficient credits. Please recharge your wallet.",
        };
      }

      const balanceAfter = deduction.balanceAfter;

      logger.info({ userId, eventKey, creditsDeducted: creditCost, balanceAfter }, 'Credits deducted');

      await invalidateDashboardCache(userId);

      return { success: true, creditsDeducted: creditCost, balanceAfter, transactionId: deduction.transactionId };
    } catch (error) {
      const capacity = normalizeCapacityError(error); if(capacity) throw capacity;
      logger.error({ err: error, userId: options.userId, eventKey: options.eventKey }, 'Credit deduction failed');
      return { success: false, creditsDeducted: 0, balanceAfter: 0, error: 'Credit deduction error' };
    }
  }

  /**
   * Deduct one direct usage charge for a durable resource. The database must
   * provide a matching unique index for the supplied reference type. This is
   * used by retryable workers so the same completed work cannot be billed twice.
   */
  async deductOnceForResource(options: DeductCreditOptions & { referenceType: string; referenceId: string }): Promise<CreditDeductionResult> {
    const creditCost = options.overrideAmount ?? await getCreditCost(options.eventKey);
    const billingWallet = await getOrCreateWallet(options.userId);
    const findExisting = async () => {
      const [existing] = await db.select().from(walletTransactionsTable).where(and(
        eq(walletTransactionsTable.userId, options.userId),
        eq(walletTransactionsTable.type, 'deduction'),
        eq(walletTransactionsTable.referenceType, options.referenceType),
        eq(walletTransactionsTable.referenceId, options.referenceId),
      )).limit(1);
      return existing;
    };
    const existing = await findExisting();
    if (existing) return { success: true, creditsDeducted: Math.abs(Number(existing.amount)), balanceAfter: Number(existing.balanceAfter), transactionId: existing.id, alreadyCharged: true };
    if (creditCost <= 0) return { success: true, creditsDeducted: 0, balanceAfter: await getBalance(options.userId) };

    try {
      const storedMetadata = await this.chargeMetadata(options, billingWallet, { directUsageCharge: true });
      const result = await db.transaction(async (tx: Tx) => {
        const wallet = await this.debitWallet(tx, billingWallet, creditCost, options.allowOverdraft);
        if (!wallet) return null;
        const balanceAfter = Number(wallet.balance);
        const transactionId = await this.recordCharge(tx, billingWallet, options, creditCost, balanceAfter, options.referenceId, storedMetadata);
        return { balanceAfter, transactionId };
      });
      if (!result) return { success: false, creditsDeducted: 0, balanceAfter: await getBalance(options.userId), error: 'Insufficient credits. Please recharge your wallet.' };
      await invalidateDashboardCache(options.userId);
      return { success: true, creditsDeducted: creditCost, balanceAfter: result.balanceAfter, transactionId: result.transactionId };
    } catch (error) {
      const capacity = normalizeCapacityError(error); if(capacity) throw capacity;
      if ((error as { code?: string })?.code === '23505') {
        const raced = await findExisting();
        if (raced) return { success: true, creditsDeducted: Math.abs(Number(raced.amount)), balanceAfter: Number(raced.balanceAfter), transactionId: raced.id, alreadyCharged: true };
      }
      logger.error({ err: error, ...options }, 'Idempotent resource credit deduction failed');
      return { success: false, creditsDeducted: 0, balanceAfter: await getBalance(options.userId), error: 'Credit deduction error' };
    }
  }

  /** Atomically creates a resource and directly charges its real base cost. */
  async chargeForResource<T>(options: Omit<DeductCreditOptions, 'referenceId'> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createResource: (tx: any) => Promise<{ resource: T; referenceId: string }>;
  }): Promise<CreditReservationResult<T>> {
    return this.createAndCharge(options, { directBaseCharge: true }, 'Atomic direct resource charge failed', 'Credit charge error');
  }

  /**
   * Atomically creates a durable resource and reserves its maximum credit cost.
   * If the wallet cannot cover the reservation the callback insert is rolled back.
   */
  async reserveForResource<T>(options: Omit<DeductCreditOptions, 'referenceId'> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createResource: (tx: any) => Promise<{ resource: T; referenceId: string }>;
  }): Promise<CreditReservationResult<T>> {
    return this.createAndCharge(options, { reservation: true }, 'Atomic credit reservation failed', 'Credit reservation error');
  }

  private async createAndCharge<T>(options: Omit<DeductCreditOptions, 'referenceId'> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createResource: (tx: any) => Promise<{ resource: T; referenceId: string }>;
  }, marker: Record<string, unknown>, failureLog: string, failureMessage: string): Promise<CreditReservationResult<T>> {
    const { requireSubscriptionForOperation } = await import('./subscriptions/service.js');
    await requireSubscriptionForOperation(options.userId);
    const creditCost = options.overrideAmount ?? await getCreditCost(options.eventKey);
    const billingWallet = await getOrCreateWallet(options.userId);

    try {
      const storedMetadata = await this.chargeMetadata(options, billingWallet, marker);
      const result = await db.transaction(async (tx: Tx) => {
        const created = await options.createResource(tx);
        if (creditCost <= 0) {
          const [wallet] = await tx.select({ balance: walletsTable.balance })
            .from(walletsTable)
            .where(eq(walletsTable.id, billingWallet.id))
            .limit(1);
          return { resource: created.resource, balanceAfter: Number(wallet?.balance || 0), transactionId: undefined };
        }
        // Charges taken before the work runs never overdraw the wallet.
        const wallet = await this.debitWallet(tx, billingWallet, creditCost, false);
        if (!wallet) throw new PaymentClaimError('Insufficient credits. Please recharge your wallet.', 402);
        const balanceAfter = Number(wallet.balance);
        const transactionId = await this.recordCharge(tx, billingWallet, options, creditCost, balanceAfter, created.referenceId, storedMetadata);
        return { resource: created.resource, balanceAfter, transactionId };
      });
      await invalidateDashboardCache(options.userId);
      return { success: true, resource: result.resource, creditsDeducted: creditCost, balanceAfter: result.balanceAfter, transactionId: result.transactionId };
    } catch (error) {
      const capacity = normalizeCapacityError(error); if(capacity) throw capacity;
      if (error instanceof PaymentClaimError) {
        return { success: false, creditsDeducted: 0, balanceAfter: await getBalance(options.userId), error: error.message };
      }
      logger.error({ err: error, userId: options.userId, eventKey: options.eventKey }, failureLog);
      return { success: false, creditsDeducted: 0, balanceAfter: await getBalance(options.userId), error: failureMessage };
    }
  }

  /**
   * Writes the negative usage row that mirrors a refund, so usage reports net it
   * out. Runs after the refund commits and never fails the refund; the unique
   * wallet_transaction_id index makes repeats harmless.
   */
  private async recordReversal(original: typeof walletTransactionsTable.$inferSelect,
    refund: { id: number; amount: number; balanceAfter: number; description: string }): Promise<void> {
    if (!(refund.amount > 0)) return;
    try {
      const meta = (original.metadata || {}) as Record<string, unknown>;
      let event = meta._event as { key?: string; service?: string; apiProvider?: string } | undefined;
      if (!event?.key) {
        const [log] = await db.select({ eventKey: creditEventLogsTable.eventKey, service: creditEventLogsTable.service,
          apiProvider: creditEventLogsTable.apiProvider }).from(creditEventLogsTable)
          .where(eq(creditEventLogsTable.walletTransactionId, original.id)).limit(1);
        if (!log) return; // Older charge that was never linked; nothing to mirror.
        event = { key: log.eventKey, service: log.service ?? undefined, apiProvider: log.apiProvider ?? undefined };
      }
      const row = {
        organizationId: original.organizationId,
        userId: original.userId,
        eventKey: event.key!,
        creditsUsed: (-refund.amount).toFixed(2),
        balanceAfter: refund.balanceAfter.toFixed(2),
        description: refund.description,
        service: event.service,
        referenceType: original.referenceType,
        referenceId: original.referenceId,
        apiProvider: event.apiProvider,
        walletTransactionId: refund.id,
        metadata: { reversal: true, originalTransactionId: original.id, refundTransactionId: refund.id,
          ...(meta.purchaseCreditsPerInr ? { purchaseCreditsPerInr: meta.purchaseCreditsPerInr } : {}) },
      };
      // Keep the charge's business so per-business views net the refund. Row
      // security refuses that when the refund runs under another business; then
      // the current scope's default applies (organization reports still net it).
      try {
        if (original.billingBusinessProfileId == null) throw new Error('No business on the original charge');
        await db.insert(creditEventLogsTable).values({ ...row, businessProfileId: original.billingBusinessProfileId }).onConflictDoNothing();
      } catch {
        await db.insert(creditEventLogsTable).values(row).onConflictDoNothing();
      }
    } catch (error) {
      logger.warn({ err: error, originalTransactionId: original.id, refundTransactionId: refund.id }, 'Refund reversal usage row was not written');
    }
  }

  /** Lock the original deduction and refund its original organization exactly once. */
  private async refundOriginal(options: {userId:number;transactionId:number;description:string;actualCredits?:number}): Promise<CreditRefundResult> {
    if(options.actualCredits!==undefined && (!Number.isFinite(options.actualCredits)||options.actualCredits<0))
      return {success:false,creditsRefunded:0,balanceAfter:0,error:'Invalid settlement amount'};
    type Outcome = { result: CreditRefundResult; original?: typeof walletTransactionsTable.$inferSelect;
      refund?: { id: number; amount: number; balanceAfter: number; description: string } };
    const outcome: Outcome = await db.transaction(async(tx:Tx): Promise<Outcome> => {
      const [original]=await tx.select().from(walletTransactionsTable).where(and(
        eq(walletTransactionsTable.id,options.transactionId),eq(walletTransactionsTable.userId,options.userId),eq(walletTransactionsTable.type,'deduction'),
      )).for('update');
      if(!original) return {result:{success:false,creditsRefunded:0,balanceAfter:0,error:'Original deduction not found'}};
      const [existing]=await tx.select().from(walletTransactionsTable).where(and(
        eq(walletTransactionsTable.organizationId,original.organizationId),eq(walletTransactionsTable.type,'refund'),
        or(eq(walletTransactionsTable.referenceType,'credit_reservation'),eq(walletTransactionsTable.referenceType,'wallet_transaction')),
        eq(walletTransactionsTable.referenceId,String(original.id)),
      )).limit(1);
      if(existing) return {original,
        refund:{id:existing.id,amount:Number(existing.amount),balanceAfter:Number(existing.balanceAfter),description:existing.description},
        result:{success:true,creditsRefunded:Number(existing.amount),balanceAfter:Number(existing.balanceAfter),alreadyRefunded:true}};
      const reserved=Math.abs(Number(original.amount));
      const actual=options.actualCredits===undefined?0:Math.round(options.actualCredits*100)/100;
      const amount=Math.max(0,Math.round((reserved-Math.min(reserved,actual))*100)/100);
      const [wallet]=await tx.update(walletsTable).set({balance:sql`${walletsTable.balance}+${amount}`,
        totalCreditsUsed:sql`GREATEST(0,${walletsTable.totalCreditsUsed}-${amount})`,updatedAt:new Date(),
      }).where(eq(walletsTable.organizationId,original.organizationId)).returning();
      if(!wallet) throw new Error('Original organization wallet unavailable');
      const balanceAfter=Number(wallet.balance);
      const [refund]=await tx.insert(walletTransactionsTable).values({userId:options.userId,organizationId:original.organizationId,
        actorUserId:currentBillingScope()?.actorUserId??options.userId,billingBusinessProfileId:original.billingBusinessProfileId,
        type:'refund',amount:amount.toFixed(2),balanceAfter:balanceAfter.toFixed(2),description:options.description,category:original.category,
        referenceType:options.actualCredits===undefined?'wallet_transaction':'credit_reservation',referenceId:String(original.id),
        metadata:{originalTransactionId:original.id,reservedCredits:reserved,actualCredits:actual,settlement:options.actualCredits!==undefined,
          ...(original.metadata?._insights ? {_insights:original.metadata._insights} : {})},
      }).returning({id:walletTransactionsTable.id});
      return {original,refund:{id:refund.id,amount,balanceAfter,description:options.description},
        result:{success:true,creditsRefunded:amount,balanceAfter}};
    });
    // Also covers refunds that committed before reversal rows existed.
    if(outcome.original&&outcome.refund) await this.recordReversal(outcome.original,outcome.refund);
    return outcome.result;
  }
  async settleReservation(options: {userId:number;transactionId:number;actualCredits:number;description:string}):Promise<CreditRefundResult> {
    if (!Number.isFinite(options.actualCredits) || options.actualCredits < 0) throw new Error('Actual credits must be a nonnegative finite amount');
    return this.refundOriginal(options);
  }

  async reserveOutreachCredit(options: {
    userId: number;
    channel: string;
    referenceId: string;
    service: string;
    messageKind?: string;
    conversationId?: number;
    /** The sending account. For WhatsApp it decides between the standard and company-billed fee. */
    providerAccountId?: string;
  }): Promise<CreditDeductionResult> {
    const { requireSubscriptionForOperation } = await import('./subscriptions/service.js');
    await requireSubscriptionForOperation(options.userId);
    // WhatsApp accounts billed through our Meta credit line pay the admin-set
    // company-billed fee here; Meta's message cost is reserved at send time.
    const whatsappFee = options.channel === 'whatsapp'
      ? await (await import('./whatsapp/WhatsAppBillingService.js')).whatsappOutreachFeeKey(options.userId, options.providerAccountId)
      : undefined;
    const eventKeyMap: Record<string, string> = {
      email: 'outreach_email',
      gmail: 'outreach_email',
      sms: 'outreach_sms',
      whatsapp: 'outreach_whatsapp',
      instagram: 'outreach_instagram',
      facebook: 'outreach_facebook',
      linkedin: 'outreach_linkedin',
      twitter: 'outreach_twitter',
    };
    return this.deductForEvent({
      userId: options.userId,
      eventKey: whatsappFee ?? eventKeyMap[options.channel] ?? 'outreach_email',
      description: `Outreach message reservation: ${options.channel}`,
      service: options.service,
      referenceType: 'outreach_message',
      referenceId: options.referenceId,
      insights:{channel:insightChannel(options.channel),
        process:options.messageKind==='follow_up'?'follow_up':'customer_chat',
        conversation:options.conversationId&&options.conversationId>0?{kind:'outreach',id:options.conversationId}:undefined},
      metadata: { channel: options.channel, reservation: true, messageKind:options.messageKind },
    });
  }

  async refundDeduction(options: {userId:number;transactionId:number;description:string}):Promise<CreditRefundResult> {
    return this.refundOriginal(options);
  }

  /**
   * Add credits via recharge
   */
  async rechargeCredits(userId: number, options: {
    amountINR: number;
    paymentId: string;
    paymentOrderId: string;
    rechargeRate: number;
    creditsToAdd: number;
    currency: string;
  }): Promise<{
    creditsAdded: number;
    newBalance: number;
    alreadyProcessed: boolean;
  }> {
    const { amountINR, paymentId, paymentOrderId, currency } = options;
    const rechargeRate = Math.round(options.rechargeRate * 10000) / 10000;
    const creditsToAdd = Math.round(options.creditsToAdd * 100) / 100;
    if (!Number.isFinite(amountINR) || amountINR <= 0 || !Number.isFinite(rechargeRate) || rechargeRate <= 0
      || !Number.isFinite(creditsToAdd) || creditsToAdd <= 0 || currency !== 'INR') {
      throw new PaymentClaimError('Invalid verified payment details', 400);
    }

    const billingWallet = await getOrCreateWallet(userId);
    const findClaim = async () => {
      const [claim] = await db.select().from(walletRechargeClaimsTable).where(and(
        eq(walletRechargeClaimsTable.paymentProvider, 'razorpay'),
        or(
          eq(walletRechargeClaimsTable.paymentId, paymentId),
          eq(walletRechargeClaimsTable.paymentOrderId, paymentOrderId),
        ),
      )).limit(1);
      return claim || null;
    };
    const existing = await findClaim();
    if (existing) {
      if (existing.organizationId !== billingWallet.organizationId || existing.userId !== userId || existing.paymentId !== paymentId || existing.paymentOrderId !== paymentOrderId) {
        throw new PaymentClaimError('This payment has already been claimed', 409);
      }
      return {
        creditsAdded: Number(existing.creditsAdded),
        newBalance: await getBalance(userId),
        alreadyProcessed: true,
      };
    }

    try {
      const result = await db.transaction(async (tx: typeof db) => {
        const [claim] = await tx.insert(walletRechargeClaimsTable).values({
          organizationId: billingWallet.organizationId,
          userId,
          paymentProvider: 'razorpay',
          paymentId,
          paymentOrderId,
          amountPaid: amountINR.toFixed(2),
          currency,
          rechargeRate: rechargeRate.toFixed(4),
          creditsAdded: creditsToAdd.toFixed(2),
        }).returning();

        const [wallet] = await tx.update(walletsTable).set({
          balance: sql`${walletsTable.balance} + ${creditsToAdd}`,
          totalCreditsAdded: sql`${walletsTable.totalCreditsAdded} + ${creditsToAdd}`,
          updatedAt: new Date(),
        }).where(eq(walletsTable.id, billingWallet.id)).returning();
        if (!wallet) throw new Error('Wallet update failed');
        const newBalance = Number(wallet.balance);

        const [transaction] = await tx.insert(walletTransactionsTable).values({
          organizationId: billingWallet.organizationId,
          actorUserId: currentBillingScope()?.actorUserId ?? currentBusinessScope()?.actorUserId ?? currentBusinessScope()?.userId ?? billingWallet.userId,
          billingBusinessProfileId: currentBusinessScope()?.businessProfileId,
          userId,
          type: 'recharge',
          amount: creditsToAdd.toFixed(2),
          balanceAfter: newBalance.toFixed(2),
          description: `Recharge of ₹${amountINR} → ${creditsToAdd} credits (rate: ${rechargeRate} credits/₹)`,
          category: 'recharge',
          paymentProvider: 'razorpay',
          paymentId,
          paymentOrderId,
          amountPaid: amountINR.toFixed(2),
          currency,
        }).returning();
        await tx.update(walletRechargeClaimsTable).set({ transactionId: transaction.id })
          .where(eq(walletRechargeClaimsTable.id, claim.id));
        return { creditsAdded: creditsToAdd, newBalance, alreadyProcessed: false };
      });

      logger.info({ userId, amountINR, creditsAdded: creditsToAdd, newBalance: result.newBalance }, 'Wallet recharged');
      return result;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const capacity = normalizeCapacityError(error); if(capacity) throw capacity;
      if (isUniqueViolation(error)) {
        const racedClaim = await findClaim();
        if (racedClaim && racedClaim.organizationId === billingWallet.organizationId && racedClaim.userId === userId && racedClaim.paymentId === paymentId && racedClaim.paymentOrderId === paymentOrderId) {
          return {
            creditsAdded: Number(racedClaim.creditsAdded),
            newBalance: await getBalance(userId),
            alreadyProcessed: true,
          };
        }
        throw new PaymentClaimError('This payment has already been claimed', 409);
      }
      throw error;
    }
  }

  /**
   * Add bonus credits (admin action)
   */
  async addBonusCredits(
    userId: number,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<number> {
    const normalizedAmount = Math.round(amount * 100) / 100;
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      throw new Error('Invalid bonus credit amount');
    }
    const billingWallet = await getOrCreateWallet(userId);
    return db.transaction(async (tx: typeof db) => {
      const [wallet] = await tx.update(walletsTable).set({
        balance: sql`${walletsTable.balance} + ${normalizedAmount}`,
        totalCreditsAdded: sql`${walletsTable.totalCreditsAdded} + ${normalizedAmount}`,
        updatedAt: new Date(),
      }).where(eq(walletsTable.id, billingWallet.id)).returning();
      if (!wallet) throw new Error('Wallet update failed');

      const newBalance = Number(wallet.balance);
      await tx.insert(walletTransactionsTable).values({
          organizationId: billingWallet.organizationId,
          actorUserId: currentBillingScope()?.actorUserId ?? currentBusinessScope()?.actorUserId ?? currentBusinessScope()?.userId ?? billingWallet.userId,
          billingBusinessProfileId: currentBusinessScope()?.businessProfileId,
        userId,
        type: 'bonus',
        amount: normalizedAmount.toFixed(2),
        balanceAfter: newBalance.toFixed(2),
        description: reason,
        category: 'system',
        referenceType: 'admin_adjustment',
        referenceId: metadata?.adminId ? String(metadata.adminId) : undefined,
        metadata,
      });

      if (Number.isSafeInteger(metadata?.adminId)) {
        await tx.execute(sql`INSERT INTO subscription_audit(admin_id,organization_id,action,details)
          VALUES(${Number(metadata!.adminId)},${billingWallet.organizationId},'organization_credits_added',
            ${JSON.stringify({ amount: normalizedAmount, reason, balance: newBalance })}::jsonb)`);
      }

      return newBalance;
    });
  }

  private getCategoryForEvent(eventKey: string): string {
    if (eventKey.startsWith("lead")) return "lead_generation";
    if (eventKey.startsWith("outreach")) return "outreach";
    if (eventKey.startsWith("api_")) return "api_usage";
    if (eventKey.startsWith("campaign") || eventKey.startsWith("ad_")) return "marketing";
    if (eventKey.startsWith("knowledge_base")) return "platform";
    if (eventKey.startsWith("ai_visibility")) return "ai_visibility";
    return "system";
  }
}

export const creditService = CreditService.getInstance();
