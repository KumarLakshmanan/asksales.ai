import { expect, test } from '@playwright/test';

import { mockApp, initial, paid } from './fixtures/organization-billing';

test('public prices, yearly totals and the five-step keyboard finder', async ({ page }) => {
  await mockApp(page);
  await page.goto('/pricing');
  await expect(page.getByRole('heading', { name: /Choose your plan/, level: 1 })).toBeVisible();
  const cards = page.getByTestId('plan-cards');
  await expect(cards.getByRole('article')).toHaveCount(3);
  await expect(cards.getByRole('article', { name: 'Starter plan' })).toContainText('₹500');
  const yearly = page.getByRole('radio', { name: /Yearly/ });
  await expect(yearly).toBeEnabled();
  await yearly.focus(); await yearly.press('Space');
  await expect(yearly).toBeChecked();
  await expect(cards.getByRole('article', { name: 'Starter plan' })).toContainText('₹4,800');
  await expect(cards.getByRole('article', { name: 'Scale plan' })).toContainText('₹48,000');
  await expect(cards.getByRole('article', { name: 'Growth plan' }).getByRole('link')).toHaveAttribute('href','/subscribe?plan=growth&term=yearly&version=2');
  const finder = page.locator('#plan-finder');
  await expect(finder.getByRole('radio', {name:'Solo founder', exact:true})).toBeEnabled();
  await expect(finder.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await finder.getByRole('radio', { name: 'Solo founder' }).focus(); await page.keyboard.press('Space');
  await finder.getByRole('button', { name: 'Continue', exact: true }).click();
  await finder.getByRole('checkbox', { name: 'Finding and managing leads' }).focus();
  await page.keyboard.press('Space');
  await finder.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(finder.getByRole('radio', { name: 'Solo founder' })).toBeChecked();
  await finder.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(finder.getByRole('checkbox', { name: 'Finding and managing leads' })).toBeChecked();
  await finder.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(finder.getByRole('slider', { name: 'How many leads each month?' })).toHaveValue('0');
  await finder.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(finder.getByRole('slider', { name: 'How much outreach each month?' })).toHaveValue('0');
  await finder.getByRole('button', { name: 'Continue', exact: true }).click();
  await finder.getByRole('radio', { name: 'Occasionally or not yet' }).focus();
  await page.keyboard.press('Space');
  await finder.getByRole('button', { name: 'See my plan' }).click();
  await expect(finder.getByRole('heading', { name: 'Starter looks like a good starting point.' })).toBeFocused();
  await expect(finder).toContainText('₹4,800');
  await expect(finder.getByRole('progressbar')).toHaveAttribute('aria-valuenow','5');
  await finder.getByRole('button', { name: 'Start again' }).click();
  await expect(finder.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({path:`/tmp/organization-billing-e2e/pricing-${test.info().project.name}.png`,fullPage:true});
  await page.screenshot({path:`/tmp/organization-billing-e2e/pricing-hero-${test.info().project.name}.png`,fullPage:false});
  const featuredCard = cards.getByRole('article', { name: 'Growth plan' });
  await featuredCard.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 100, behavior: 'instant' }));
  await page.screenshot({path:`/tmp/organization-billing-e2e/pricing-cards-${test.info().project.name}.png`,fullPage:false});
});

test('public catalog failures show a retry instead of invented prices', async ({ page }) => {
  await mockApp(page);
  let fail = true;
  await page.route('**/api/subscriptions/catalog', route => fail
    ? route.fulfill({ status: 503, json: { success: false, error: 'Catalog temporarily unavailable' } })
    : route.fallback());
  await page.goto('/pricing');
  await expect(page.getByRole('heading', { name: 'Plans could not be loaded' })).toBeVisible();
  await expect(page.getByTestId('plan-cards')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  const cards = page.getByTestId('plan-cards');
  await expect(cards.getByRole('article')).toHaveCount(3);
  await expect(cards.getByRole('article', { name: 'Growth plan' })).toContainText('₹1,500');
});

test('focus supports multiple choices and volume sliders preserve answers, explain results and reset', async ({page}) => {
  await mockApp(page);
  await page.goto('/pricing');
  const finder = page.locator('#plan-finder');
  await expect(finder.getByRole('radio', {name:'Solo founder', exact:true})).toBeEnabled();
  await finder.getByRole('radio', {name:'Solo founder', exact:true}).focus();
  await page.keyboard.press('Space');
  await finder.getByRole('radio', {name:'Agency', exact:true}).focus();
  await page.keyboard.press('Space');
  await expect(finder.getByRole('radio', {name:'Solo founder', exact:true})).not.toBeChecked();
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  const leadsFocus = finder.getByRole('checkbox', {name:'Finding and managing leads'});
  const contentFocus = finder.getByRole('checkbox', {name:'Content and creative work'});
  await leadsFocus.focus(); await page.keyboard.press('Space');
  await contentFocus.focus(); await page.keyboard.press('Space');
  await expect(leadsFocus).toBeChecked();
  await expect(contentFocus).toBeChecked();
  await expect(finder.getByText('2 selected', {exact:true})).toBeVisible();
  await page.screenshot({path:`/tmp/organization-billing-e2e/pricing-focus-${test.info().project.name}.png`,fullPage:false});
  await leadsFocus.focus(); await page.keyboard.press('Space');
  await contentFocus.focus(); await page.keyboard.press('Space');
  await expect(finder.getByRole('button', {name:'Continue', exact:true})).toBeDisabled();
  await leadsFocus.focus(); await page.keyboard.press('Space');
  await contentFocus.focus(); await page.keyboard.press('Space');
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  const leads = finder.getByRole('slider', {name:'How many leads each month?'});
  await leads.focus(); await leads.press('End');
  await expect(leads).toHaveValue('4');
  await expect(leads).toHaveAttribute('aria-valuetext', 'More than 10,000 leads per month');
  await leads.press('Home'); await leads.press('ArrowRight'); await leads.press('ArrowRight');
  await expect(leads).toHaveValue('2');
  await expect(leads).toHaveAttribute('aria-valuetext', '501–2,000 leads per month');
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  await expect(finder.getByRole('heading', {name:'How much outreach each month?'})).toBeFocused();
  await expect.poll(async () => (await finder.getByRole('heading', {name:'How much outreach each month?'}).boundingBox())!.y).toBeGreaterThanOrEqual(64);
  const outreach = finder.getByRole('slider', {name:'How much outreach each month?'});
  await finder.getByRole('button', {name:'Set 2,001–10,000 messages', exact:true}).click();
  await expect(outreach).toHaveValue('3');
  await expect(outreach).toHaveAttribute('aria-valuetext', '2,001–10,000 messages per month');
  await page.screenshot({path:`/tmp/organization-billing-e2e/pricing-slider-${test.info().project.name}.png`,fullPage:false});
  await finder.getByRole('button', {name:'Back', exact:true}).click();
  await expect(leads).toHaveValue('2');
  await finder.getByRole('button', {name:'Back', exact:true}).click();
  await expect(leadsFocus).toBeChecked(); await expect(contentFocus).toBeChecked();
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  await expect(outreach).toHaveValue('3');
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  await finder.getByRole('radio', {name:'Every day', exact:true}).focus();
  await page.keyboard.press('Space');
  await finder.getByRole('button', {name:'See my plan'}).click();
  await expect(finder.getByRole('heading', {name:'Scale looks like a good starting point.'})).toBeFocused();
  await expect(finder).toContainText('Finding and managing leads, Content and creative work');
  await expect(finder).toContainText('501–2,000');
  await expect(finder.getByRole('link', {name:'Choose Scale'})).toHaveAttribute('href', '/subscribe?plan=scale&term=monthly&version=2');
  await finder.getByRole('button', {name:'Start again'}).click();
  await expect(finder.getByRole('button', {name:'Continue', exact:true})).toBeDisabled();
  await finder.getByRole('radio', {name:'Solo founder', exact:true}).focus(); await page.keyboard.press('Space');
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  await expect(leadsFocus).not.toBeChecked(); await expect(contentFocus).not.toBeChecked();
  await leadsFocus.focus(); await page.keyboard.press('Space');
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  await expect(leads).toHaveValue('0');
  await finder.getByRole('button', {name:'Continue', exact:true}).click();
  await expect(outreach).toHaveValue('0');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
});

test('keeps the chosen plan through signup and explains approval before payment', async ({page})=>{
  await mockApp(page); await page.goto('/subscribe?plan=scale&term=yearly&version=2');
  await expect(page.getByRole('heading',{name:'Start with Scale.'})).toBeVisible();
  await expect(page.getByRole('main')).toContainText('₹48,000');
  await expect(page.getByRole('link',{name:'Create account',exact:true})).toHaveAttribute('href','/login?mode=register');
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('asksales_subscription_selection')!))).toEqual({plan:'scale',term:'yearly',version:2});
});

test('checkout verifies the server response, supports cancellation and has no mobile overflow', async ({page})=>{
  await mockApp(page,true);
  let state: object = initial;
  await page.route('**/api/subscriptions/current',route=>route.fulfill({json:{success:true,data:state}}));
  await page.route('https://checkout.razorpay.com/v1/checkout.js',route=>route.fulfill({contentType:'application/javascript',body:`window.Razorpay=class { constructor(options){this.options=options} on(){} open(){this.options.handler({razorpay_payment_id:'pay_fixture',razorpay_subscription_id:'sub_fixture',razorpay_signature:'${'a'.repeat(64)}'})} }` }));
  await page.route('**/api/subscriptions/start',route=>{
    expect(route.request().postDataJSON()).toEqual({plan:'growth',term:'yearly',catalogVersion:2});
    expect(route.request().headers()['x-billing-organization-id']).toBe('11');
    return route.fulfill({json:{success:true,data:{subscriptionId:'sub_fixture',keyId:'rzp_test_fixture',mode:'test',startsAt:null,replacement:false}}});
  });
  await page.route('**/api/subscriptions/verify',route=>{ state=paid; return route.fulfill({json:{success:true,data:state}}); });
  await page.route('**/api/subscriptions/cancel',route=>{ expect(route.request().postDataJSON()).toEqual({scope:'renewal'}); state={...paid,subscription:{...paid.subscription,cancelAtPeriodEnd:true}}; return route.fulfill({json:{success:true,data:state}}); });
  await page.goto('/subscribe?plan=growth&term=yearly&version=2');
  await page.getByRole('button',{name:'Continue to payment'}).click();
  await expect(page.getByRole('status')).toContainText('Payment verified. Your subscription is active.');
  await expect(page.getByRole('heading',{name:'Growth · yearly'})).toBeVisible();
  await page.getByRole('button',{name:'Cancel auto renewal',exact:true}).click();
  await page.getByRole('button',{name:'Confirm cancellation'}).click();
  await expect(page.getByText('Auto renewal is off.',{exact:false})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
});

test('billing errors remain retryable and failed checkout does not claim payment success',async({page})=>{
  await mockApp(page,true);
  let fail=true;
  await page.route('**/api/subscriptions/current',route=>route.fulfill(fail ? {status:503,json:{success:false,error:'Billing temporarily unavailable'}} : {json:{success:true,data:initial}}));
  await page.goto('/subscribe');
  await expect(page.getByRole('heading',{name:'Billing could not be loaded'})).toBeVisible();
  fail=false; await page.getByRole('button',{name:'Retry',exact:true}).click();
  await expect(page.getByRole('button',{name:'Continue to payment'})).toBeEnabled();
  await page.route('https://checkout.razorpay.com/v1/checkout.js',route=>route.abort());
  await page.getByRole('button',{name:'Continue to payment'}).click();
  await expect(page.getByRole('alert').filter({hasText:'Checkout could not load'})).toBeVisible();
  await expect(page.getByText('Payment verified. Your subscription is active.')).toHaveCount(0);
});

test('refunded payments show retained credits and leave the active renewal mandate cancellable', async ({ page }) => {
  await mockApp(page, true);
  await page.route('**/api/subscriptions/current', route => route.fulfill({ json: {
    ...paid, access: initial.access, subscription: { ...paid.subscription, paidThrough: null }, nextDepositAt: null,
    charges: [{ id: 'pay_refunded', amountPaise: 1_440_000, term: 'yearly', plan: 'growth', paidAt: '2026-09-01T00:00:00Z', periodStart: '2026-09-01T00:00:00Z', periodEnd: '2027-09-01T00:00:00Z', invoiceUrl: 'https://example.test/invoices/pay_refunded', taxPaise: null, refundAmountPaise: 1_440_000, refundObservedAt: '2026-09-27T12:00:00Z' }],
  } }));
  await page.goto('/subscribe?plan=growth&term=yearly&version=2');
  await expect(page.getByText('Mandate status: active. No active paid term.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel auto renewal', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue to payment', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Current plan', exact: true })).toHaveCount(0);
  await expect(page.getByText('Next credit deposit:', { exact: false })).toHaveCount(0);
  const history = page.getByRole('region', { name: 'Plan payment history' });
  await expect(history).toContainText('Credits already deposited remain in the owner’s shared wallet.');
  await expect(history).toContainText('A refund does not cancel your renewal mandate.');
  const refund = history.getByRole('article', { name: 'Payment pay_refunded' });
  await expect(refund).toContainText('Refund recorded · ₹14,400 · 27 Sept 2026');
  await expect(refund.getByRole('link', { name: 'View original invoice' })).toHaveAttribute('href', 'https://example.test/invoices/pay_refunded');
  await refund.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/organization-billing-e2e/subscription-refund-${test.info().project.name}.png`, fullPage: false });
  await page.getByRole('button', { name: 'Cancel auto renewal', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: 'Stop future renewal payments?' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
