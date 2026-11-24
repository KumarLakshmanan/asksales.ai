import { sql, type SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withSystemScope } from '../tenancy/businessContext.js';

export class RechargeOriginError extends Error {
  constructor(message: string, readonly status = 503, readonly code = 'RECHARGE_ORIGIN_UNAVAILABLE') {
    super(message);
    this.name = 'RechargeOriginError';
  }
}

export type RechargeQuote = {
  userId: number; organizationId: number; amountPaise: number; currency: string;
  credits: number; rechargeRate: number;
};
export type RechargeCredentialIdentity = {
  source: 'admin'; credentialId: number; keyId: string;
  storedKey: string; storedSecret: string | null; encrypted: boolean;
} | { source: 'system'; credentialId: null; keyId: string; storedSecret: string };
export type RechargeOrderOrigin = RechargeQuote & {
  orderId: string; source: 'admin' | 'system'; credentialId: number | null; keyId: string;
};
type Executor = { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> };
type Database = Executor & { transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> };

function validQuote(quote: RechargeQuote) {
  return [quote.userId, quote.organizationId, quote.amountPaise].every(value => Number.isSafeInteger(value) && value > 0)
    && quote.currency === 'INR' && Number.isFinite(quote.credits) && quote.credits > 0
    && Number.isFinite(quote.rechargeRate) && quote.rechargeRate > 0;
}

/** Persist before exposing checkout. The row lock prevents an identity edit
 * between the provider request's captured credential and its durable reference. */
export async function saveRechargeOrderOrigin(
  orderId: string, quote: RechargeQuote, identity: RechargeCredentialIdentity, database: Database = db,
) {
  if (!validQuote(quote) || !/^order_[a-zA-Z0-9_]+$/.test(orderId)) throw new RechargeOriginError('The recharge order could not be recorded.');
  try { await database.transaction(async tx => {
    let matches = false;
    if (identity.source === 'admin') {
      const [stored] = (await tx.execute(sql`SELECT api_key,api_secret,is_encrypted,is_active,platform
        FROM admin_api_credentials WHERE id=${identity.credentialId} FOR SHARE`)).rows;
      matches = !!stored && stored.platform === 'razorpay' && stored.is_active === true
        && stored.api_key === identity.storedKey && stored.api_secret === identity.storedSecret
        && stored.is_encrypted === identity.encrypted;
    } else {
      const [stored] = (await tx.execute(sql`SELECT default_config FROM system_integrations
        WHERE integration_id='razorpay' FOR SHARE`)).rows;
      const config = stored?.default_config as Record<string, unknown> | undefined;
      matches = config?.keyId === identity.keyId && config?.keySecret === identity.storedSecret;
    }
    if (!matches) throw new RechargeOriginError('Payment configuration changed. Review the recharge before starting checkout.', 409, 'RECHARGE_CREDENTIAL_CHANGED');
    await tx.execute(sql`INSERT INTO wallet_recharge_order_origins
      (order_id,user_id,organization_id,credential_source,credential_id,key_id,amount_paise,currency,credits,recharge_rate)
      VALUES(${orderId},${quote.userId},${quote.organizationId},${identity.source},${identity.credentialId},${identity.keyId},
        ${quote.amountPaise},${quote.currency},${quote.credits},${quote.rechargeRate})`);
  }); } catch (error) {
    if (error instanceof RechargeOriginError) throw error;
    throw new RechargeOriginError('The payment order could not be recorded. Contact support before starting another recharge.');
  }
}

/** A narrow identity lookup distinguishes another actor's known order from a
 * genuinely unbound legacy order. No record leaves this scope before authority
 * is checked; database errors must never become legacy fallback. */
export async function findRechargeOrderOrigin(orderId: string, userId: number, organizationId: number): Promise<RechargeOrderOrigin | null> {
  return withSystemScope('Authorize one recharge order against its original actor and payer', async () => {
    let result: Record<string, unknown>[];
    try { result = (await db.execute(sql`SELECT * FROM wallet_recharge_order_origins WHERE order_id=${orderId}`)).rows; }
    catch { throw new RechargeOriginError('Recharge recovery is temporarily unavailable. Please retry.'); }
    if (!result.length) return null;
    const row = result[0];
    if (Number(row.user_id) !== userId || Number(row.organization_id) !== organizationId) {
      throw new RechargeOriginError('This recharge order is not available to your account.', 404, 'RECHARGE_ORDER_FORBIDDEN');
    }
    const origin: RechargeOrderOrigin = {
      orderId: String(row.order_id), userId: Number(row.user_id), organizationId: Number(row.organization_id),
      source: row.credential_source as RechargeOrderOrigin['source'],
      credentialId: row.credential_id == null ? null : Number(row.credential_id), keyId: String(row.key_id),
      amountPaise: Number(row.amount_paise), currency: String(row.currency), credits: Number(row.credits), rechargeRate: Number(row.recharge_rate),
    };
    if (!validQuote(origin) || origin.orderId !== orderId || !origin.keyId.startsWith('rzp_live_')
      || !['admin', 'system'].includes(origin.source)
      || (origin.source === 'admin' ? !Number.isSafeInteger(origin.credentialId) || Number(origin.credentialId) <= 0 : origin.credentialId !== null)) {
      throw new RechargeOriginError('The recharge origin needs support review.', 409, 'RECHARGE_ORIGIN_REVIEW_REQUIRED');
    }
    return origin;
  });
}
