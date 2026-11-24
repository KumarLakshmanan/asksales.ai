/**
 * Razorpay Service
 * Handles Razorpay payment integration for wallet recharges
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { db } from '../models/db.js';
import { systemIntegrationsTable } from '../models/systemIntegrations/schema.js';
import { adminApiCredentialsTable } from '../models/adminApiCredentials/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { decryptValue } from './SecretsManager.js';
import { decryptAdminCredential } from '../models/adminApiCredentials/functions.js';
import type { AdminApiCredentialRecord } from '../models/adminApiCredentials/schema.js';
import {
  findRechargeOrderOrigin, saveRechargeOrderOrigin, RechargeOriginError,
  type RechargeCredentialIdentity, type RechargeOrderOrigin, type RechargeQuote,
} from './walletRechargeOrigins.js';

const RAZORPAY_API_TIMEOUT_MS = 10_000;

interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  identity: RechargeCredentialIdentity;
}

interface CreateOrderOptions {
  amount: number; // In INR (will be converted to paise)
  currency?: string;
  receipt: string;
  notes?: Record<string, string>;
  recharge: Omit<RechargeQuote, 'amountPaise' | 'currency'>;
}

export interface RechargeVerificationContext {
  origin: RechargeOrderOrigin | null;
  verifyPayment(orderId: string, paymentId: string, signature: string): boolean;
  getPaymentDetails(paymentId: string): Promise<RazorpayPayment | null>;
  getOrderDetails(orderId: string): Promise<RazorpayOrder | null>;
}

export interface RazorpayOrder {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: string;
  created_at: number;
  notes?: Record<string, string>;
}

export interface RazorpayPayment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: string;
  order_id: string;
  captured: boolean;
  notes?: Record<string, string>;
}

class RazorpayService {
  private static instance: RazorpayService;

  static getInstance(): RazorpayService {
    if (!this.instance) this.instance = new RazorpayService();
    return this.instance;
  }

  private adminConfig(credential: AdminApiCredentialRecord): RazorpayConfig | null {
    if (!credential.apiSecret) return null;
    const resolved = decryptAdminCredential(credential);
    if (!resolved.apiKey.startsWith('rzp_live_') || !resolved.apiSecret) return null;
    return {
      keyId: resolved.apiKey, keySecret: resolved.apiSecret,
      identity: { source: 'admin', credentialId: credential.id, keyId: resolved.apiKey,
        storedKey: credential.apiKey, storedSecret: credential.apiSecret, encrypted: credential.isEncrypted },
    };
  }

  private async systemConfig(): Promise<RazorpayConfig | null> {
    const [integration] = await db.select().from(systemIntegrationsTable)
      .where(eq(systemIntegrationsTable.integrationId, 'razorpay'));
    const config = integration?.defaultConfig as Record<string, unknown> | undefined;
    if (typeof config?.keyId !== 'string' || !config.keyId.startsWith('rzp_live_')
      || typeof config.keySecret !== 'string' || !config.keySecret) return null;
    const storedSecret = config.keySecret;
    const keySecret = (() => { try { return decryptValue(storedSecret); } catch { return storedSecret; } })();
    return { keyId: config.keyId, keySecret,
      identity: { source: 'system', credentialId: null, keyId: config.keyId, storedSecret } };
  }

  /**
   * Capture one LIVE context for a new checkout or a genuinely unbound legacy order.
   */
  private async getConfig(): Promise<RazorpayConfig | null> {
    // Subscriber top-ups must use the selected LIVE billing credential. Never
    // convert simulated payments into spendable wallet credits.
    try {
      const settings = await db.execute(sql`SELECT credential_id FROM subscription_settings WHERE id=1`);
      const credentialId = settings.rows?.[0]?.credential_id;
      if (credentialId) {
        const [selected] = await db.select().from(adminApiCredentialsTable).where(and(
          eq(adminApiCredentialsTable.id,Number(credentialId)),eq(adminApiCredentialsTable.platform,'razorpay'),eq(adminApiCredentialsTable.isActive,true)
        )).limit(1);
        return selected ? this.adminConfig(selected) : null;
      }
    } catch {
      return null;
    }
    // 1. Try admin API credentials table first (new multi-key approach)
    try {
      const [cred] = await db
        .select()
        .from(adminApiCredentialsTable)
        .where(and(
          eq(adminApiCredentialsTable.platform, 'razorpay'),
          eq(adminApiCredentialsTable.isActive, true)
        ))
        .orderBy(adminApiCredentialsTable.id)
        .limit(1);

      if (cred?.apiKey && cred?.apiSecret) {
        return this.adminConfig(cred);
      }
    } catch {
      // DB might not be ready
    }

    // 2. Fallback: Try system integrations table (legacy admin-set)
    try {
      return await this.systemConfig();
    } catch {
      // DB might not be ready
    }

    return null;
  }

  /**
   * Get Razorpay public key (for client-side)
   */
  async getPublicKey(): Promise<string | null> {
    const config = await this.getConfig();
    return config?.keyId || null;
  }

  /**
   * Create a Razorpay order
   */
  async createOrder(options: CreateOrderOptions): Promise<(RazorpayOrder & { keyId: string }) | null> {
    const config = await this.getConfig();
    if (!config) {
      throw new RechargeOriginError('Payment gateway not configured. Please contact admin.', 503, 'PAYMENT_GATEWAY_UNAVAILABLE');
    }

    const amountInPaise = Math.round(options.amount * 100);

    try {
      const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');
      
      const response = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        signal: AbortSignal.timeout(RAZORPAY_API_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
        },
        body: JSON.stringify({
          amount: amountInPaise,
          currency: options.currency || 'INR',
          receipt: options.receipt,
          notes: options.notes || {},
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error({ status: response.status, error }, 'Razorpay order creation failed');
        return null;
      }

      const order = await response.json() as RazorpayOrder;
      if (order.amount !== amountInPaise || order.currency !== (options.currency || 'INR') || order.receipt !== options.receipt) {
        throw new RechargeOriginError('The payment order needs support review.', 409, 'RECHARGE_ORIGIN_REVIEW_REQUIRED');
      }
      await saveRechargeOrderOrigin(order.id, { ...options.recharge, amountPaise: amountInPaise, currency: order.currency }, config.identity);
      logger.info({ orderId: order.id, amount: options.amount }, 'Razorpay order created');
      return { ...order, keyId: config.keyId };
    } catch (error) {
      if (error instanceof RechargeOriginError) throw error;
      logger.error({ err: error }, 'Razorpay order creation error');
      return null;
    }
  }

  /**
   * Verify Razorpay payment signature (constant-time compare to prevent timing attacks).
   */
  async verifyPayment(orderId: string, paymentId: string, signature: string): Promise<boolean> {
    const config = await this.getConfig();
    if (!config) return false;

    return this.verifySignature(config, orderId, paymentId, signature);
  }

  private verifySignature(config: RazorpayConfig, orderId: string, paymentId: string, signature: string): boolean {
    if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;

    const body = orderId + '|' + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', config.keySecret)
      .update(body)
      .digest('hex');

    // SERV-008: Use timing-safe compare. Buffer lengths must match.
    const a = Buffer.from(expectedSignature, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Fetch payment details from Razorpay
   */
  async getPaymentDetails(paymentId: string): Promise<RazorpayPayment | null> {
    const config = await this.getConfig();
    if (!config) return null;
    return this.paymentDetails(config, paymentId);
  }

  private async paymentDetails(config: RazorpayConfig, paymentId: string): Promise<RazorpayPayment | null> {
    try {
      const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');
      
      const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        signal: AbortSignal.timeout(RAZORPAY_API_TIMEOUT_MS),
        headers: {
          'Authorization': `Basic ${auth}`,
        },
      });

      if (!response.ok) return null;
      return await response.json() as RazorpayPayment;
    } catch (error) {
      logger.error({ err: error, paymentId }, 'Failed to fetch payment details');
      return null;
    }
  }

  async getOrderDetails(orderId: string): Promise<RazorpayOrder | null> {
    const config = await this.getConfig();
    if (!config) return null;
    return this.orderDetails(config, orderId);
  }

  private async orderDetails(config: RazorpayConfig, orderId: string): Promise<RazorpayOrder | null> {
    try {
      const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');
      const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
        signal: AbortSignal.timeout(RAZORPAY_API_TIMEOUT_MS),
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!response.ok) return null;
      return await response.json() as RazorpayOrder;
    } catch (error) {
      logger.error({ err: error, orderId }, 'Failed to fetch Razorpay order details');
      return null;
    }
  }

  /** Known orders must use their originating identity, including an inactive or
   * deselected retained credential. Only a successful absent lookup is legacy. */
  async getRechargeVerificationContext(orderId: string, userId: number, organizationId: number): Promise<RechargeVerificationContext> {
    const origin = await findRechargeOrderOrigin(orderId, userId, organizationId);
    let config: RazorpayConfig | null;
    try {
      if (!origin) config = await this.getConfig();
      else if (origin.source === 'admin') {
        const [credential] = await db.select().from(adminApiCredentialsTable).where(and(
          eq(adminApiCredentialsTable.id, Number(origin.credentialId)), eq(adminApiCredentialsTable.platform, 'razorpay'),
        )).limit(1);
        config = credential ? this.adminConfig(credential) : null;
      } else config = await this.systemConfig();
    } catch {
      throw new RechargeOriginError('The originating payment configuration needs support review.', 409, 'RECHARGE_ORIGIN_REVIEW_REQUIRED');
    }
    if (!config || (origin && config.keyId !== origin.keyId)) {
      throw new RechargeOriginError('The originating payment configuration needs support review.', 409, 'RECHARGE_ORIGIN_REVIEW_REQUIRED');
    }
    const captured = config;
    return {
      origin,
      verifyPayment: (order, payment, signature) => order === orderId && this.verifySignature(captured, order, payment, signature),
      getPaymentDetails: payment => this.paymentDetails(captured, payment),
      getOrderDetails: order => order === orderId ? this.orderDetails(captured, order) : Promise.resolve(null),
    };
  }

  /**
   * Check if Razorpay is configured
   */
  async isConfigured(): Promise<boolean> {
    const config = await this.getConfig();
    return config !== null;
  }
}

export const razorpayService = RazorpayService.getInstance();
