import {expect,test} from '@playwright/test';
import {mockApp,initial,paid} from './fixtures/organization-billing';

test('a canceled paid mandate can review the same plan again',async({page})=>{
  await mockApp(page,true);
  await page.route('**/api/subscriptions/current',route=>route.fulfill({json:{...paid,subscription:{...paid.subscription,status:'cancelled',cancelAtPeriodEnd:true}}}));
  await page.goto('/subscribe?plan=starter&term=yearly&version=2');
  const growth=page.getByRole('article',{name:'Growth plan'}).getByRole('button');
  await expect(growth).toBeEnabled();await growth.click();
  await expect(page.getByRole('heading',{name:'Your selection: Growth'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Authorize plan at renewal'})).toBeEnabled();
});

test('billing term stays frozen while the reviewed checkout request is pending',async({page})=>{
  await mockApp(page,true);
  await page.route('https://checkout.razorpay.com/v1/checkout.js',route=>route.fulfill({contentType:'application/javascript',body:'window.Razorpay=class {on(){} open(){}}'}));
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  let payload:unknown;
  await page.route('**/api/subscriptions/current',route=>route.fulfill({json:initial}));
  await page.route('**/api/subscriptions/start',async route=>{payload=route.request().postDataJSON();await pending;await route.fulfill({status:503,json:{error:'Synthetic retryable checkout failure'}});});
  await page.goto('/subscribe?plan=starter&term=monthly&version=2');
  await page.getByRole('button',{name:'Continue to payment'}).click();
  await expect.poll(()=>payload).toEqual({plan:'starter',term:'monthly',catalogVersion:2});
  const yearly=page.getByRole('radio',{name:/Yearly/});
  await expect(yearly).toBeDisabled();await expect(page.getByRole('radio',{name:'Monthly',exact:true})).toBeChecked();
  release();await expect(yearly).toBeEnabled();
  await expect(page.getByRole('alert').filter({hasText:'Synthetic retryable checkout failure'})).toBeVisible();
});
