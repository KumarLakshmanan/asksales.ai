import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('native container rule stacks a narrow Support panel and separates a wide one', async ({ page }) => {
  const css = await readFile('src/app/dashboard/(main)/support-ai/embed/support-embed.module.css', 'utf8');
  await page.setContent(`<style>${css} .layout{display:grid} .content,.aside{height:100px}</style><section class="team" style="width:700px"><div class="layout"><div class="content">Code</div><aside class="aside">Preview</aside></div></section>`);
  const content = page.locator('.content');
  const aside = page.locator('.aside');
  const narrow = [await content.boundingBox(), await aside.boundingBox()];
  expect(narrow[1]!.y).toBeGreaterThanOrEqual(narrow[0]!.y + narrow[0]!.height);
  await page.locator('.team').evaluate(element => { (element as HTMLElement).style.width = '1000px'; });
  const wide = [await content.boundingBox(), await aside.boundingBox()];
  expect(wide[1]!.x).toBeGreaterThanOrEqual(wide[0]!.x + wide[0]!.width);
});
