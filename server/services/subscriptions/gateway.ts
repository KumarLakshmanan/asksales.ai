import crypto from 'node:crypto';
import { getAdminCredentialById } from '../../models/adminApiCredentials/functions.js';
import { addCalendarMonths, type BillingTerm } from '../../../shared/subscriptions.js';

export class SubscriptionError extends Error {
  constructor(message: string, public status = 400, public code = 'SUBSCRIPTION_ERROR') { super(message); this.name = 'SubscriptionError'; }
}

export type ProviderSubscription = {
  id: string; plan_id: string; status: string; quantity: number; start_at: number | null;
  current_start: number | null; current_end: number | null; payment_method?: string;
  end_at?: number | null;
  notes: Record<string, string>;
};
export type ProviderPayment = {
  id: string; invoice_id: string | null; order_id: string | null; amount: number;
  currency: string; status: string; captured: boolean; method: string; amount_refunded: number;
};
export type ProviderInvoice = {
  id: string; subscription_id: string; payment_id: string; order_id: string;
  status: string; currency: string; amount: number; amount_paid: number; amount_due: number;
  tax_amount: number | null; billing_start: number; billing_end: number; paid_at: number;
  short_url: string | null; line_items: { type: string; amount: number; quantity: number }[];
};

export function validHmac(body: string | Buffer, secret: string, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function verifyCharge(input: {
  subscription: ProviderSubscription; payment: ProviderPayment; invoice: ProviderInvoice;
  localId: string; userId: number; organizationId?: number; providerId: string; providerPlanId: string;
  term: BillingTerm; amountPaise: number;
  allowRefundedPayment?: boolean;
}) {
  const { subscription: sub, payment, invoice } = input;
  if (sub.id !== input.providerId || sub.plan_id !== input.providerPlanId || sub.quantity !== 1
    || sub.notes?.asksales_subscription_id !== input.localId || sub.notes?.asksales_user_id !== String(input.userId)
    || (input.organizationId !== undefined && sub.notes?.asksales_organization_id !== String(input.organizationId))
    || invoice.subscription_id !== input.providerId || invoice.payment_id !== payment.id
    || payment.invoice_id !== invoice.id || payment.order_id !== invoice.order_id) {
    throw new SubscriptionError('Payment does not belong to this subscription.', 409, 'CHARGE_MISMATCH');
  }
  const refundAmount = payment.amount_refunded;
  const refunded = input.allowRefundedPayment && Number.isSafeInteger(refundAmount) && refundAmount > 0 && refundAmount <= payment.amount;
  if ((payment.status !== 'captured' && !(refunded && payment.status === 'refunded')) || payment.captured !== true || invoice.status !== 'paid') {
    throw new SubscriptionError('Payment is still being confirmed. Refresh billing shortly.', 409, 'PAYMENT_PENDING');
  }
  if (payment.amount !== input.amountPaise || invoice.amount !== input.amountPaise
    || invoice.amount_paid !== input.amountPaise || invoice.amount_due !== 0
    || payment.currency !== 'INR' || invoice.currency !== 'INR'
    || !Number.isSafeInteger(refundAmount) || refundAmount < 0 || (refundAmount > 0 && !refunded)
    || invoice.line_items?.length !== 1 || invoice.line_items[0].type !== 'plan'
    || invoice.line_items[0].quantity !== 1) {
    throw new SubscriptionError('The charge does not match the agreed plan total.', 409, 'CHARGE_MISMATCH');
  }
  const start = new Date(invoice.billing_start * 1000);
  const end = new Date(invoice.billing_end * 1000);
  const expectedEnd = addCalendarMonths(start, input.term === 'yearly' ? 12 : 1);
  if (!Number.isSafeInteger(invoice.billing_start) || !Number.isSafeInteger(invoice.billing_end)
    || invoice.billing_start <= 0 || !Number.isSafeInteger(invoice.paid_at) || invoice.paid_at <= 0
    || Math.abs(end.getTime() - expectedEnd.getTime()) > 86400000) {
    throw new SubscriptionError('The invoice billing period needs reconciliation.', 409, 'CHARGE_MISMATCH');
  }
  return { start, end, paidAt: new Date(invoice.paid_at * 1000) };
}

export class RazorpaySubscriptionGateway {
  readonly mode: 'test' | 'live';
  constructor(readonly credentialId: number, readonly keyId: string, private keySecret: string, private webhookSecret: string, readonly active = true) {
    if (!/^rzp_(test|live)_/.test(keyId)) throw new SubscriptionError('Select a valid Razorpay credential.', 503);
    this.mode = keyId.startsWith('rzp_live_') ? 'live' : 'test';
  }

  static async forCredential(id: number) {
    const credential = await getAdminCredentialById(id);
    if (!credential || credential.platform !== 'razorpay' || !credential.apiSecret) {
      throw new SubscriptionError('Razorpay subscriptions are not configured.', 503);
    }
    return new RazorpaySubscriptionGateway(id, credential.apiKey, credential.apiSecret,
      String((credential.config as Record<string, unknown> | null)?.subscriptionWebhookSecret || ''), credential.isActive);
  }

  get hasWebhookSecret() { return this.webhookSecret.length >= 16; }
  verifyCheckout(paymentId: string, storedSubscriptionId: string, signature: string) {
    return validHmac(`${paymentId}|${storedSubscriptionId}`, this.keySecret, signature);
  }
  verifyWebhook(raw: Buffer, signature: string) {
    return this.hasWebhookSecret && validHmac(raw, this.webhookSecret, signature);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: globalThis.Response;
    try {
      response = await fetch(`https://api.razorpay.com/v1/${path}`, {
        method, headers: { Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new SubscriptionError('Razorpay could not be reached. Billing will reconcile the request before retrying.', 503, 'PROVIDER_UNCERTAIN');
    }
    if (!response.ok) {
      // Provider bodies can contain customer details. Never pass them to logs or callers.
      throw new SubscriptionError(`Razorpay could not complete this request (${response.status}).`, 502,
        response.status >= 500 || response.status === 429 ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_REJECTED');
    }
    return response.json() as Promise<T>;
  }
  getSubscription(id: string) { return this.request<ProviderSubscription>('GET', `subscriptions/${encodeURIComponent(id)}`); }
  getPayment(id: string) { return this.request<ProviderPayment>('GET', `payments/${encodeURIComponent(id)}`); }
  getInvoice(id: string) { return this.request<ProviderInvoice>('GET', `invoices/${encodeURIComponent(id)}`); }
  createPlan(name: string, term: BillingTerm, amount: number) {
    return this.request<{ id: string }>('POST', 'plans', { period: term, interval: 1, item: { name, amount, currency: 'INR' } });
  }
  async findExistingPlan(name: string, term: BillingTerm, amount: number) {
    for (let skip=0; skip<10000; skip+=100) {
      const page = await this.request<{ items: { id: string; period: string; interval: number; item: { name: string; amount: number; currency: string } }[] }>('GET', `plans?count=100&skip=${skip}`);
      const match = page.items.find(plan => plan.period===term && plan.interval===1 && plan.item.name===name && plan.item.amount===amount && plan.item.currency==='INR');
      if (match) return match;
      if (page.items.length<100) return null;
    }
    throw new SubscriptionError('Provider plan catalog needs administrator review.',503);
  }
  createSubscription(localId: string, userId: number, planId: string, term: BillingTerm, startsAt: Date | null, organizationId?: number) {
    return this.request<ProviderSubscription>('POST', 'subscriptions', {
      plan_id: planId, quantity: 1, total_count: term === 'yearly' ? 10 : 120, customer_notify: 1,
      ...(startsAt ? { start_at: Math.floor(startsAt.getTime() / 1000) } : {}),
      notes: { asksales_subscription_id: localId, asksales_user_id: String(userId), ...(organizationId ? { asksales_organization_id: String(organizationId) } : {}) },
    });
  }
  cancel(id: string, atCycleEnd: boolean) {
    return this.request<ProviderSubscription>('POST', `subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd });
  }
  async invoices(subscriptionId: string) {
    const all: ProviderInvoice[] = [];
    for (let skip = 0; skip < 10000; skip += 100) {
      const page = await this.request<{ items: ProviderInvoice[] }>('GET', `invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=100&skip=${skip}`);
      all.push(...page.items);
      if (page.items.length < 100) return all;
    }
    throw new SubscriptionError('Invoice history exceeds the reconciliation limit.', 503);
  }
  async recoverCreation(localId: string, createdAt: Date) {
    const from = Math.floor(createdAt.getTime() / 1000) - 60;
    for (let skip = 0; skip < 10000; skip += 100) {
      const page = await this.request<{ items: ProviderSubscription[] }>('GET', `subscriptions?from=${from}&to=${from + 3600}&count=100&skip=${skip}`);
      const match = page.items.find(sub => sub.notes?.asksales_subscription_id === localId);
      if (match) return match;
      if (page.items.length < 100) return null;
    }
    throw new SubscriptionError('Subscription creation requires administrator reconciliation.', 503);
  }
}
