import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';

/** Save reviewable screenshots for every onboarding section when requested by QA. */
export async function setupScreenshot(page: Page, info: TestInfo, name: string) {
  const folder = process.env.SETUP_QA_SCREENSHOTS || '/tmp/business-setup-qa';
  await mkdir(path.join(folder, info.project.name), { recursive: true });
  if (/^(16|28|30|31|32|33)-/.test(name)) {
    await expect(page.locator('main h1').first()).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete))).toBe(true);
  await page.screenshot({
    path: path.join(folder, info.project.name, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
    scale: 'css',
    style: 'nextjs-portal { display: none !important; }',
  });
}
