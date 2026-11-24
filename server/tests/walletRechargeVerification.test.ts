import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

import { verifyRechargePayment } from '../controllers/walletController.js';
import { creditService } from '../services/CreditService.js';
import { NotificationService } from '../services/NotificationService.js';
import { razorpayService, type RazorpayOrder, type RazorpayPayment } from '../services/RazorpayService.js';
import { RechargeOriginError, type RechargeOrderOrigin } from '../services/walletRechargeOrigins.js';
import { db } from '../models/db.js';

let billingRole = 'owner';
beforeEach(() => {
  billingRole = 'owner';
  jest.spyOn(db, 'execute').mockImplementation(async () => ({ rows: [{ id: 70, name: 'Shared organization', owner_user_id: 7, default_for_user_id: 7, role: billingRole }] }));
});

const verificationBody = {
  razorpay_order_id: 'order_wallet_123',
  razorpay_payment_id: 'pay_wallet_123',
  razorpay_signature: 'a'.repeat(64),
};

const order: RazorpayOrder = {
  id: verificationBody.razorpay_order_id,
  entity: 'order',
  amount: 10_000,
  amount_paid: 10_000,
  amount_due: 0,
  currency: 'INR',
  receipt: 'wallet_7_1700000000000',
  status: 'paid',
  created_at: 1_700_000_000,
  notes: { userId: '7', credits: '1000', rechargeRate: '10', type: 'wallet_recharge' },
};

const payment: RazorpayPayment = {
  id: verificationBody.razorpay_payment_id,
  entity: 'payment',
  amount: 10_000,
  currency: 'INR',
  status: 'captured',
  order_id: verificationBody.razorpay_order_id,
  captured: true,
};

function responseDouble() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status: jest.fn<(code: number) => Response>(),
    json: jest.fn<(body: unknown) => Response>(),
  };
  response.status.mockImplementation((code) => {
    response.statusCode = code;
    return response as unknown as Response;
  });
  response.json.mockImplementation((body) => {
    response.body = body;
    return response as unknown as Response;
  });
  return response;
}

function mockVerification(overrides: { order?: RazorpayOrder; payment?: RazorpayPayment; origin?: RechargeOrderOrigin } = {}) {
  return jest.spyOn(razorpayService, 'getRechargeVerificationContext').mockResolvedValue({
    origin: overrides.origin ?? null,
    verifyPayment: () => true,
    getPaymentDetails: async () => overrides.payment ?? payment,
    getOrderDetails: async () => overrides.order ?? order,
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('wallet Razorpay verification', () => {
  it('credits only a captured payment bound to the signed user order', async () => {
    mockVerification();
    const recharge = jest.spyOn(creditService, 'rechargeCredits').mockResolvedValue({
      creditsAdded: 1000,
      newBalance: 1250,
      alreadyProcessed: false,
    });
    jest.spyOn(NotificationService, 'creditsAdded').mockResolvedValue();
    const response = responseDouble();

    await verifyRechargePayment({ user: { id: 7 }, body: verificationBody } as unknown as Request, response as unknown as Response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: { creditsAdded: 1000, newBalance: 1250 } });
    expect(recharge).toHaveBeenCalledWith(7, {
      amountINR: 100,
      paymentId: verificationBody.razorpay_payment_id,
      paymentOrderId: verificationBody.razorpay_order_id,
      rechargeRate: 10,
      creditsToAdd: 1000,
      currency: 'INR',
    });
  });

  it('keeps an authorised payment retryable until Razorpay marks it captured and paid', async () => {
    mockVerification({ payment: { ...payment, status: 'authorized', captured: false },
      order: { ...order, status: 'attempted', amount_due: order.amount } });
    const recharge = jest.spyOn(creditService, 'rechargeCredits');
    const response = responseDouble();

    await verifyRechargePayment({ user: { id: 7 }, body: verificationBody } as unknown as Request, response as unknown as Response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: 'Payment is awaiting capture. Retry verification in a moment.' });
    expect(recharge).not.toHaveBeenCalled();
  });

  it('rejects a valid signature when the fetched order belongs to another user', async () => {
    mockVerification({ order: {
      ...order,
      receipt: 'wallet_99_1700000000000',
      notes: { ...order.notes, userId: '99' },
    } });
    const recharge = jest.spyOn(creditService, 'rechargeCredits');
    const response = responseDouble();

    await verifyRechargePayment({ user: { id: 7 }, body: verificationBody } as unknown as Request, response as unknown as Response);

    expect(response.statusCode).toBe(400);
    expect(recharge).not.toHaveBeenCalled();
  });

  it('rejects a captured order owned by another selected organization', async () => {
    mockVerification({ order: { ...order, notes: { ...order.notes, organizationId: '71' } } });
    const recharge = jest.spyOn(creditService, 'rechargeCredits');
    const response = responseDouble();
    await verifyRechargePayment({ user: { id: 7 }, body: verificationBody } as unknown as Request, response as unknown as Response);
    expect(response.statusCode).toBe(400);
    expect(recharge).not.toHaveBeenCalled();
  });

  it('returns a billing-role error to members before verifying or crediting a payment', async () => {
    billingRole = 'member';
    const verify = jest.spyOn(razorpayService, 'getRechargeVerificationContext');
    const recharge = jest.spyOn(creditService, 'rechargeCredits');
    const response = responseDouble();
    await verifyRechargePayment({ user: { id: 7 }, body: verificationBody } as unknown as Request, response as unknown as Response);
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: 'BILLING_ROLE_REQUIRED' });
    expect(verify).not.toHaveBeenCalled();
    expect(recharge).not.toHaveBeenCalled();
  });

  it('rejects provider quote drift from the durable server origin', async () => {
    mockVerification({ origin: { orderId: order.id, userId: 7, organizationId: 70, source: 'admin', credentialId: 1,
      keyId: 'rzp_live_fixtureA', amountPaise: order.amount, currency: 'INR', credits: 500, rechargeRate: 5 } });
    const recharge = jest.spyOn(creditService, 'rechargeCredits');
    const response = responseDouble();
    await verifyRechargePayment({ user: { id: 7 }, body: verificationBody } as unknown as Request, response as unknown as Response);
    expect(response.statusCode).toBe(400);
    expect(recharge).not.toHaveBeenCalled();
  });

  it('returns recovery errors without crediting or reselecting a credential', async () => {
    jest.spyOn(razorpayService, 'getRechargeVerificationContext').mockRejectedValue(new RechargeOriginError('Review required', 409, 'RECHARGE_ORIGIN_REVIEW_REQUIRED'));
    const recharge = jest.spyOn(creditService, 'rechargeCredits');
    const response = responseDouble();
    await verifyRechargePayment({ user: { id: 7 }, body: verificationBody } as unknown as Request, response as unknown as Response);
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: 'RECHARGE_ORIGIN_REVIEW_REQUIRED' });
    expect(recharge).not.toHaveBeenCalled();
  });
});
