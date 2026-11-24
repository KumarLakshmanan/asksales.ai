import type { Page, TestInfo } from '@playwright/test';

export async function captureMSG91Page(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
    animations: 'disabled',
    style: 'nextjs-portal, [data-sonner-toaster] { visibility: hidden !important; }',
  });
}
