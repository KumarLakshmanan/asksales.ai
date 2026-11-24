import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import nextConfig from '../../next.config';
import { bottomNavItems } from '@/lib/sidebarConfig';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Razorpay wallet recharge contract', () => {
  it('allows the Razorpay checkout SDK, API calls, and hosted frame through CSP', async () => {
    const headerGroups = await nextConfig.headers?.();
    const csp = headerGroups?.flatMap((group) => group.headers)
      .find((header) => header.key === 'Content-Security-Policy')?.value || '';

    expect(csp).toMatch(/script-src[^;]*https:\/\/\*\.razorpay\.com/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/\*\.razorpay\.com/);
    expect(csp).toMatch(/frame-src[^;]*https:\/\/\*\.razorpay\.com/);
  });

  it('loads checkout with a visible retry path instead of leaving a dead button', () => {
    const rechargePage = read('src/app/dashboard/(main)/billing/recharge/page.tsx');

    expect(rechargePage).toContain('https://checkout.razorpay.com/v1/checkout.js');
    expect(rechargePage).toContain('Secure checkout could not be loaded');
    expect(rechargePage).toContain('Retry checkout');
    expect(rechargePage).toContain('Loading secure checkout…');
    expect(rechargePage).toContain('Razorpay Test Mode');
  });

  it('discovers recharge through Billing while retaining owner and active-plan gates', () => {
    expect(bottomNavItems.find(item => item.label === 'Billing')?.path).toBe('/dashboard/billing');
    const billing = read('src/app/dashboard/(main)/billing/page.tsx');
    expect(billing).toContain('const canRecharge = canManage && state?.access.canTopUp === true');
    expect(billing).toContain('enabled={canRecharge}');
    expect(billing).toContain('<Link href="/dashboard/billing/recharge"><Plus aria-hidden />Add credits</Link>');
    const rechargePage = read('src/app/dashboard/(main)/billing/recharge/page.tsx');
    expect(rechargePage).toContain('!subscription.data.organization.canManageBilling');
    expect(rechargePage).toContain('Ask your business owner');
  });
});
