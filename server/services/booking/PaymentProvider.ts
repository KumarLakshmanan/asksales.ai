import crypto from 'crypto';
import { db } from '../../models/db.js';
import { sql } from 'drizzle-orm';
import { encryptValue, decryptValue } from '../SecretsManager.js';
import { logger } from '../../utils/logger.js';
import type { BookingRecord } from './types.js';
import { safeExternalBookingUrl } from './ExternalBookingUrl.js';
export { safeExternalBookingUrl, validateExternalBookingUrlDestination } from './ExternalBookingUrl.js';

export interface PaymentLink {
  url: string;
  ref: string;
  provider: 'mock' | 'razorpay';
}

export interface PaymentWebhookResult {
  ok: boolean;
  kind?: 'capture' | 'refund';
  paymentRef?: string;
  paymentId?: string;
  refundId?: string;
  amountMinor?: number;
  currency?: string;
  occurredAt?: string;
  eventId?: string;
  reason?: string;
}

export interface HotelPaymentMethods {
  online?: { enabled?: boolean };
  upiQr?: { enabled?: boolean; upiId?: string; payeeName?: string; qrImageUrl?: string };
  bankTransfer?: {
    enabled?: boolean;
    bankName?: string;
    payeeName?: string;
    accountNumber?: string;
    ifscCode?: string;
  };
  customLink?: { enabled?: boolean; url?: string; linkTitle?: string };
  manual?: { enabled?: boolean; instructions?: string };
}

export interface ExternalBookingConfiguration {
  url?: string;
  linkTitle?: string;
}

export interface HotelPaymentConfiguration {
  configured: boolean;
  paymentMethodsEnabled: boolean;
  externalBooking: ExternalBookingConfiguration;
  provider: 'mock' | 'razorpay' | null;
  keyId: string | null;
  keySecret: string | null;
  webhookSecret: string | null;
  methods: HotelPaymentMethods;
}

export interface PaymentProvider {
  readonly name: 'mock' | 'razorpay';
  createPaymentLink(
    booking: BookingRecord,
    opts: { customerName?: string; customerPhone?: string; customerEmail?: string },
  ): Promise<PaymentLink>;
  verifyWebhook(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
    rawBody?: Buffer,
  ): Promise<PaymentWebhookResult>;
}

function isEncryptedValue(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 3
    && /^[0-9a-f]+$/i.test(parts[0])
    && /^[0-9a-f]+$/i.test(parts[1])
    && /^[0-9a-f]+$/i.test(parts[2]);
}

export function decodeHotelPaymentSecret(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (!isEncryptedValue(value)) return value;
  try {
    return decryptValue(value);
  } catch (error) {
    logger.error({ err: error }, '[payment] Unable to decrypt hotel payment credential');
    return null;
  }
}

export function encodeHotelPaymentSecret(value: string): string {
  return encryptValue(value);
}

function normalizeMethods(value: unknown): HotelPaymentMethods {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const methods = structuredClone(value) as HotelPaymentMethods & {
    bankTransfer?: HotelPaymentMethods['bankTransfer'] & { accountNumberEncrypted?: string };
  };
  if (methods.bankTransfer) {
    const encrypted = methods.bankTransfer.accountNumberEncrypted;
    const accountNumber = decodeHotelPaymentSecret(encrypted ?? methods.bankTransfer.accountNumber);
    methods.bankTransfer.accountNumber = accountNumber || undefined;
    delete methods.bankTransfer.accountNumberEncrypted;
  }
  return methods;
}

export async function getHotelPaymentConfiguration(userId: number): Promise<HotelPaymentConfiguration> {
  const rows = await db.execute(sql`
    SELECT api_key, api_secret, config
    FROM api_credentials
    WHERE user_id = ${userId}
      AND service_name = 'razorpay'
      AND is_active = true
    LIMIT 1
  `);
  const credential = (rows.rows as Array<{
    api_key?: string | null;
    api_secret?: string | null;
    config?: Record<string, unknown> | string | null;
  }>)[0];

  if (!credential) {
    return {
      configured: false,
      paymentMethodsEnabled: true,
      externalBooking: {},
      provider: null,
      keyId: null,
      keySecret: null,
      webhookSecret: null,
      methods: {},
    };
  }

  let config: Record<string, unknown> = {};
  try {
    config = typeof credential.config === 'string'
      ? JSON.parse(credential.config) as Record<string, unknown>
      : credential.config || {};
  } catch {
    logger.warn({ userId }, '[payment] Ignoring invalid hotel payment configuration JSON');
  }

  const provider = config.provider === 'razorpay' || config.provider === 'mock'
    ? config.provider
    : null;
  const encryptedWebhook = config.webhookSecretEncrypted ?? config.webhookSecret;
  const external = config.externalBooking && typeof config.externalBooking === 'object' && !Array.isArray(config.externalBooking)
    ? config.externalBooking as Record<string, unknown>
    : {};

  return {
    configured: true,
    // Legacy configurations predate external checkout and must retain the
    // integrated flow until an owner explicitly disables payment methods.
    paymentMethodsEnabled: config.paymentMethodsEnabled !== false,
    externalBooking: {
      url: safeExternalBookingUrl(external.url) || undefined,
      linkTitle: typeof external.linkTitle === 'string'
        ? external.linkTitle.trim().slice(0, 255) || undefined
        : undefined,
    },
    provider,
    keyId: decodeHotelPaymentSecret(credential.api_key),
    keySecret: decodeHotelPaymentSecret(credential.api_secret),
    webhookSecret: decodeHotelPaymentSecret(encryptedWebhook),
    methods: normalizeMethods(config.methods),
  };
}

export function isMockPaymentAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_MOCK_PAYMENTS === 'true';
}

/** Local-only demo provider. Its opaque bearer link cannot be derived from a booking id. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  async createPaymentLink(_booking: BookingRecord): Promise<PaymentLink> {
    if (!isMockPaymentAllowed()) {
      throw new Error('Mock payments are disabled in production.');
    }
    const ref = `mock_${crypto.randomBytes(24).toString('hex')}`;
    const base = process.env.APP_URL || process.env.API_URL || 'http://localhost:8080';
    return {
      url: `${base.replace(/\/$/, '')}/api/whatsapp/payment/mock-confirm?ref=${encodeURIComponent(ref)}`,
      ref,
      provider: 'mock',
    };
  }

  async verifyWebhook(payload: unknown): Promise<PaymentWebhookResult> {
    if (!isMockPaymentAllowed()) return { ok: false, reason: 'Mock payments are disabled' };
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const ref = body.ref ?? body.payment_ref;
    if (typeof ref !== 'string' || !/^mock_[0-9a-f]{48}$/.test(ref)) {
      return { ok: false, reason: 'Invalid mock payment reference' };
    }
    const identity = crypto.createHash('sha256').update(ref).digest('hex');
    return {
      ok: true,
      paymentRef: ref,
      paymentId: `mockpay_${identity}`,
      eventId: `mockevent_${identity}`,
    };
  }
}

/** Razorpay hosted Payment Links with raw-body HMAC webhook verification. */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  async createPaymentLink(
    booking: BookingRecord,
    opts: { customerName?: string; customerPhone?: string; customerEmail?: string },
  ): Promise<PaymentLink> {
    const amountInSubunits = Math.round(booking.totalPrice * 100);
    if (!Number.isSafeInteger(amountInSubunits) || amountInSubunits <= 0) {
      throw new Error('Booking amount is invalid.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch('https://api.razorpay.com/v1/payment_links', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
        },
        body: JSON.stringify({
          amount: amountInSubunits,
          currency: booking.currency,
          accept_partial: false,
          reference_id: `hotel_booking_${booking.id}`,
          description: `Hotel booking #${booking.id}`,
          customer: {
            name: opts.customerName || undefined,
            contact: opts.customerPhone || undefined,
            email: opts.customerEmail || undefined,
          },
          notify: { sms: false, email: false },
          reminder_enable: false,
          notes: { bookingId: String(booking.id) },
        }),
      });

      if (!response.ok) {
        logger.error(
          { status: response.status, bookingId: booking.id },
          '[payment] Razorpay payment-link creation failed',
        );
        throw new Error('Razorpay could not create a hosted payment link. Verify the configured credentials.');
      }

      const result = await response.json() as { id?: string; short_url?: string };
      if (!result.id || !result.short_url) {
        throw new Error('Razorpay returned an incomplete payment-link response.');
      }
      return { url: result.short_url, ref: result.id, provider: 'razorpay' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async verifyWebhook(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
    rawBody?: Buffer,
  ): Promise<PaymentWebhookResult> {
    const header = headers['x-razorpay-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || !rawBody?.length) {
      return { ok: false, reason: 'Missing webhook signature or raw request body' };
    }

    const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const providedBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (
      providedBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return { ok: false, reason: 'Webhook signature mismatch' };
    }

    const body = payload && typeof payload === 'object'
      ? payload as {
        id?: unknown;
        event?: unknown;
        payload?: {
          payment?: {
            entity?: {
              captured?: unknown;
              id?: unknown;
              order_id?: unknown;
              status?: unknown;
              amount?: unknown;
              currency?: unknown;
              created_at?: unknown;
            };
          };
          payment_link?: {
            entity?: {
              id?: unknown;
              status?: unknown;
            };
          };
          refund?: { entity?: { id?: unknown; payment_id?: unknown; amount?: unknown; currency?: unknown; status?: unknown; created_at?: unknown } };
        };
      }
      : {};
    const event = typeof body.event === 'string' ? body.event : '';
    const payment = body.payload?.payment?.entity;
    const paymentLink = body.payload?.payment_link?.entity;
    const refund = body.payload?.refund?.entity;
    if (event === 'refund.processed') {
      if (refund?.status !== 'processed' || typeof refund.id !== 'string' || typeof refund.payment_id !== 'string'
        || !Number.isSafeInteger(refund.amount) || Number(refund.amount) <= 0 || typeof refund.currency !== 'string') {
        return { ok: false, reason: 'Refund has no completed, traceable payment evidence' };
      }
      return { ok:true, kind:'refund', refundId:refund.id, paymentId:refund.payment_id,
        amountMinor:Number(refund.amount), currency:refund.currency,
        occurredAt:typeof refund.created_at==='number'?new Date(refund.created_at*1000).toISOString():new Date().toISOString(),
        eventId:typeof body.id==='string'?body.id:undefined };
    }
    const acceptedEvent = event === 'payment.captured'
      || event === 'order.paid'
      || event === 'payment_link.paid';
    const captured = payment?.captured === true
      || payment?.status === 'captured'
      || paymentLink?.status === 'paid';
    if (!acceptedEvent || !captured) {
      return { ok: false, reason: 'Webhook is not a successful captured-payment event' };
    }

    const paymentRef = paymentLink?.id || payment?.order_id;
    if (typeof paymentRef !== 'string' || !paymentRef) {
      return { ok: false, reason: 'Successful payment event has no payment reference' };
    }

    return {
      ok: true,
      kind: 'capture',
      paymentRef,
      paymentId: typeof payment?.id === 'string' ? payment.id : undefined,
      amountMinor: Number.isSafeInteger(payment?.amount) && Number(payment?.amount)>0 ? Number(payment?.amount) : undefined,
      currency: typeof payment?.currency === 'string' ? payment.currency : undefined,
      occurredAt: typeof payment?.created_at === 'number' ? new Date(payment.created_at*1000).toISOString() : undefined,
      eventId: typeof body.id === 'string' ? body.id : undefined,
    };
  }
}

export async function getPaymentProviderForUser(userId: number): Promise<PaymentProvider | null> {
  const config = await getHotelPaymentConfiguration(userId);
  if (!config.configured || config.methods.online?.enabled !== true) return null;

  if (config.provider === 'mock') {
    return isMockPaymentAllowed() ? new MockPaymentProvider() : null;
  }
  if (
    config.provider === 'razorpay'
    && config.keyId
    && config.keySecret
    && config.webhookSecret
  ) {
    return new RazorpayPaymentProvider(config.keyId, config.keySecret, config.webhookSecret);
  }
  return null;
}

