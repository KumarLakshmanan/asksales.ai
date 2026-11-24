import type { Page } from '@playwright/test';
import { expect } from './app';

export async function waitForCrmEntranceAnimations(page: Page): Promise<void> {
  await expect.poll(() => page.locator('main [style]').evaluateAll(elements => elements
    .filter(element => element instanceof HTMLElement && element.style.opacity && element.getClientRects().length > 0)
    .every(element => Number((element as HTMLElement).style.opacity) >= 0.999)), {
    timeout: 10_000,
    message: 'CRM entrance animations finish before the screenshot',
  }).toBe(true);
}

export async function captureCrmScreenshot(page: Page, path: string): Promise<void> {
  await waitForCrmEntranceAnimations(page);
  await page.screenshot({ path, fullPage: true, animations: 'disabled',
    style: '[data-sonner-toaster] { visibility: hidden !important; }',
  });
}
