import { describe, expect, it } from '@jest/globals';
import crypto from 'node:crypto';
import { SUBSCRIPTION_PLANS, planAmountPaise, planForScore, recommendPlan, creditDepositDates, calculateSubscriptionAccess } from '../../shared/subscriptions.js';
import { RazorpaySubscriptionGateway, verifyCharge, type ProviderInvoice, type ProviderPayment, type ProviderSubscription } from '../services/subscriptions/gateway.js';
import { isSubscriptionExempt } from '../middleware/subscriptionAccess.js';

describe('published subscription terms', () => {
  it('keeps the three approved credit deposits and exact yearly discount', () => {
    expect(SUBSCRIPTION_PLANS.map(p => [p.monthlyRupees,p.yearlyRupees,p.monthlyCredits])).toEqual([
      [500,4800,5000],[1500,14400,15000],[5000,48000,50000],
    ]);
    for (const plan of SUBSCRIPTION_PLANS) expect(planAmountPaise(plan,'yearly')).toBe(plan.monthlyRupees * 12 * 80);
  });
  it.each([[0,'starter'],[2,'starter'],[3,'starter'],[4,'starter'],[5,'starter'],[6,'starter'],[7,'growth'],[9,'growth'],[10,'growth'],[11,'scale'],[12,'scale'],[13,'scale'],[16,'scale']])('maps score %s to %s', (score, slug) => {
    expect(planForScore(Number(score)).slug).toBe(slug);
  });
  it('validates every finder answer and explains the recommendation', () => {
    expect(recommendPlan([[4],[0,1],[4],[4],[3]]).plan.slug).toBe('scale');
    expect(recommendPlan([[0],[0],[0],[0],[0]]).choices).toHaveLength(5);
    expect(() => recommendPlan([[0],[0],[0],[0]])).toThrow();
    expect(() => recommendPlan([[0],[0],[0],[0],[50]])).toThrow();
    expect(() => recommendPlan([[0],[],[0],[0],[0]])).toThrow('Choose at least one answer');
    expect(() => recommendPlan([[0,1],[0],[0],[0],[0]])).toThrow('Choose one answer per question');
    expect(() => recommendPlan([[0],[0],[0,1],[0],[0]])).toThrow('Choose one answer per question');
  });
  it('explains every selected workflow without inflating the mixed-workflow score', () => {
    const mixed = recommendPlan([[0],[2,0],[0],[0],[0]]);
    expect(mixed.choices[1]).toEqual({question:'What will you focus on?',label:'Finding and managing leads, Content and creative work',score:2});
    expect(mixed.plan.slug).toBe('starter');
    expect(recommendPlan([[0],[0,1,2,3],[0],[0],[0]]).score).toBe(2);
    expect(recommendPlan([[0],[1,1],[0],[0],[0]]).score).toBe(1);
    expect(() => recommendPlan([[0],[0,4],[0],[0],[0]])).toThrow('Invalid finder answer');
    expect(() => recommendPlan([[0],[0.5],[0],[0],[0]])).toThrow('Invalid finder answer');
  });
  it('deposits yearly credits monthly without anniversary drift', () => {
    const dates = creditDepositDates(new Date('2028-01-31T10:00:00Z'),new Date('2029-01-31T10:00:00Z'),'yearly');
    expect(dates).toHaveLength(12);
    expect(dates[1].toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(dates[2].toISOString()).toBe('2028-03-31T10:00:00.000Z');
    expect(creditDepositDates(dates[0],dates[1],'monthly')).toHaveLength(1);
  });
});

describe('subscription access', () => {
  const base = { enforced: true, launchedAt: new Date('2026-09-01Z'), userCreatedAt: new Date('2026-08-01Z') };
  it('gives only existing users exactly 30 days from the first launch', () => {
    expect(calculateSubscriptionAccess(base,new Date('2026-09-30T23:59:59Z')).reason).toBe('existing_user_grace');
    expect(calculateSubscriptionAccess(base,new Date('2026-10-01Z')).allowed).toBe(false);
    expect(calculateSubscriptionAccess({...base,userCreatedAt:new Date('2026-09-01Z')},new Date('2026-09-02Z')).allowed).toBe(false);
  });
  it('grants seven days only after a failed renewal, without allowing top-ups', () => {
    const input = {...base,paidFrom:new Date('2026-10-01Z'),paidThrough:new Date('2026-11-01Z'),failedRenewal:true};
    expect(calculateSubscriptionAccess(input,new Date('2026-11-07T23:59:59Z'))).toMatchObject({ allowed:true,reason:'payment_grace',canTopUp:false });
    expect(calculateSubscriptionAccess(input,new Date('2026-11-08Z')).allowed).toBe(false);
    expect(calculateSubscriptionAccess({...input,cancelled:true},new Date('2026-11-02Z')).allowed).toBe(false);
    expect(calculateSubscriptionAccess({...input,failedRenewal:false},new Date('2026-11-02Z')).allowed).toBe(false);
  });
  it('retains paid access after cancellation but does not unlock a future term early', () => {
    const input = {...base,paidFrom:new Date('2026-10-01Z'),paidThrough:new Date('2027-10-01Z'),cancelled:true};
    expect(calculateSubscriptionAccess(input,new Date('2026-12-01Z'))).toMatchObject({allowed:true,canTopUp:true,reason:'paid'});
    expect(calculateSubscriptionAccess(input,new Date('2027-10-01Z')).allowed).toBe(false);
    expect(calculateSubscriptionAccess(input,new Date('2026-09-30Z')).reason).toBe('existing_user_grace');
  });
  it('preserves account, billing and onboarding but gates operational URLs', () => {
    for (const path of ['/api/auth/me','/api/subscriptions/cancel','/api/wallet','/api/settings/profile','/api/setup/analyze-website','/api/content/brand-toolkits/1/logo','/api/support/tickets','/api/legal/terms']) expect(isSubscriptionExempt(path)).toBe(true);
    for (const path of ['/api/leads','/api/content/studio/generate','/api/settings/ads','/api/support-ai','/api/subscriptions-evil','/api/settings/knowledge-base']) expect(isSubscriptionExempt(path)).toBe(false);
  });
});

describe('Razorpay payment verification', () => {
  const gateway = new RazorpaySubscriptionGateway(1,'rzp_test_example','test-secret','test-webhook-secret');
  const signature = crypto.createHmac('sha256','test-secret').update('pay_1|sub_1').digest('hex');
  it('uses payment|stored_subscription in checkout signatures and rejects altered claims', () => {
    expect(gateway.verifyCheckout('pay_1','sub_1',signature)).toBe(true);
    expect(gateway.verifyCheckout('pay_1','sub_2',signature)).toBe(false);
    expect(gateway.verifyCheckout('pay_1','sub_1','00')).toBe(false);
  });
  it('validates the exact raw webhook bytes', () => {
    const raw = Buffer.from('{"event":"subscription.charged"}');
    const signed = crypto.createHmac('sha256','test-webhook-secret').update(raw).digest('hex');
    expect(gateway.verifyWebhook(raw,signed)).toBe(true);
    expect(gateway.verifyWebhook(Buffer.from(raw.toString()+' '),signed)).toBe(false);
  });
  const subscription: ProviderSubscription = { id:'sub_1',plan_id:'plan_1',status:'active',quantity:1,start_at:null,current_start:null,current_end:null,notes:{asksales_subscription_id:'local_1',asksales_user_id:'1'} };
  const payment: ProviderPayment = {id:'pay_1',invoice_id:'inv_1',order_id:'order_1',amount:10000,currency:'INR',status:'captured',captured:true,method:'upi',amount_refunded:0};
  const invoice: ProviderInvoice = {id:'inv_1',subscription_id:'sub_1',payment_id:'pay_1',order_id:'order_1',status:'paid',currency:'INR',amount:10000,amount_paid:10000,amount_due:0,tax_amount:0,billing_start:Date.parse('2026-10-01Z')/1000,billing_end:Date.parse('2026-11-01Z')/1000,paid_at:Date.parse('2026-10-01Z')/1000,short_url:null,line_items:[{type:'plan',amount:10000,quantity:1}]};
  const input = {subscription,payment,invoice,localId:'local_1',userId:1,providerId:'sub_1',providerPlanId:'plan_1',term:'monthly' as const,amountPaise:10000};
  it('accepts only the exact captured plan amount and verified ownership', () => {
    expect(verifyCharge(input).end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(() => verifyCharge({...input,userId:2})).toThrow();
    expect(() => verifyCharge({...input,payment:{...payment,amount:100}})).toThrow();
    expect(() => verifyCharge({...input,payment:{...payment,captured:false}})).toThrow();
    expect(() => verifyCharge({...input,payment:{...payment,currency:'USD'}})).toThrow();
    expect(() => verifyCharge({...input,invoice:{...invoice,billing_end:invoice.billing_end+86400*366}})).toThrow();
  });
});
