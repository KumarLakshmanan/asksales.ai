import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { responseWrapper } from '../middleware/responseWrapper.js';
import request from 'supertest';
const openai = jest.fn<(id: number, start: Date, end: Date) => Promise<{ totalCalls: number; totalTokens: number; estimatedCostCents: number }>>(
  async () => ({ totalCalls: 2, totalTokens: 100, estimatedCostCents: 10 }));
const apify = jest.fn(async () => ({ totalRuns: 3, totalItemsScraped: 200, totalCostCents: 20 }));
const gemini = jest.fn(async () => ({ totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostCents: 0 }));
const zerobounce = jest.fn(async () => ({ totalRequests: 4, totalEmailsValidated: 300, totalCostCents: 30 }));
jest.unstable_mockModule('../models/openaiUsages/functions.js', () => ({ getOpenAIUsageSummaryByUser: openai }));
jest.unstable_mockModule('../models/apifyUsages/functions.js', () => ({ getApifyUsageSummaryByUser: apify }));
jest.unstable_mockModule('../models/geminiUsages/functions.js', () => ({ getGeminiUsageStats: gemini }));
jest.unstable_mockModule('../models/zerobounceUsages/functions.js', () => ({ getZerobounceUsageStats: zerobounce }));
const { getUserUsageStats } = await import('../controllers/adminUserUsageController.js');
const app = express(); app.use('/api', responseWrapper);
app.get('/api/admin/users/:userId/usage', getUserUsageStats);
describe('usage request validation', () => {
  it.each(['11junk', '0', '-1', '01', '2147483648'])('rejects noncanonical user target %s before any reads', async id => {
    jest.clearAllMocks();
    expect((await request(app).get(`/api/admin/users/${id}/usage`)).status).toBe(400);
    for (const reader of [openai, apify, gemini, zerobounce]) expect(reader).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '30junk', '7&days=30', '9007199254740991'])('rejects invalid day range %s before any reads', async days => {
    jest.clearAllMocks();
    expect((await request(app).get(`/api/admin/users/11/usage?days=${days}`)).status).toBe(400);
    for (const reader of [openai, apify, gemini, zerobounce]) expect(reader).not.toHaveBeenCalled();
  });
  it('keeps the default 30-day contract and valid historical numeric ranges', async () => {
    for (const days of [undefined, '1', '30', '366']) {
      const res = await request(app).get('/api/admin/users/11/usage' + (days ? `?days=${days}` : ''));
      expect(res.status).toBe(200); expect(res.body.days).toBe(days ? Number(days) : 30);
      expect(new Date(res.body.dateRange.start).getTime()).toBeLessThan(new Date(res.body.dateRange.end).getTime());
    }
  });
});
describe('administrator usage measurement API contract', () => {
  it('keeps the provider measurements distinct while reconciling API costs/calls', async () => {
    const res = await request(app).get('/api/admin/users/11/usage');
    expect(res.status).toBe(200);
    expect(res.body.usage.openai.totalTokens).toBe(100);
    expect(res.body.usage.apify.totalItemsScraped).toBe(200);
    expect(res.body.usage.zerobounce.totalEmailsValidated).toBe(300);
    expect(res.body.usage.apify).not.toHaveProperty('totalTokens');
    expect(res.body.totals).toEqual({ totalCostCents: 60, totalApiCalls: 9 });
    expect(openai).toHaveBeenCalledWith(11, expect.any(Date), expect.any(Date));
  });
  (process.env.ADMIN_USAGE_LOCAL_BROWSER === '1' ? it : it.skip)('renders the real HTTP controller response in Chromium without combining units', async () => {
    const { chromium } = await import('@playwright/test');
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const harness = fileURLToPath(new URL('./helpers/adminUsageBrowserFixture.ts', import.meta.url));
    const child = spawn(process.execPath, [harness, String(address.port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', data => { output += data.toString(); });
    child.stderr!.on('data', data => { output += data.toString(); });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const started = Date.now();
      while (!output.includes('BROWSER_URL=') && Date.now() - started < 20000) {
        if (child.exitCode !== null) throw new Error(output);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const url = output.match(/BROWSER_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (!url) throw new Error(`Browser fixture did not start: ${output}`);
      browser = await chromium.launch({ headless: true,
        executablePath: process.env.ADMIN_USAGE_CHROMIUM_EXECUTABLE || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      const response = page.waitForResponse(res => res.url().endsWith('/api/admin/users/11/usage'));
      await page.goto(url);
      const body = await (await response).json();
      expect(body.usage.openai.totalTokens).toBe(100);
      expect(body.usage.apify.totalItemsScraped).toBe(200);
      expect(body.usage.zerobounce.totalEmailsValidated).toBe(300);
      for (const [label, value] of [['Total Tokens', '100'], ['Items Scraped', '200'], ['Emails Validated', '300'], ['Total Cost', '$0.60']]) {
        await page.getByText(label, { exact: true }).waitFor();
        const card = page.locator('.shadcn-card').filter({ has: page.getByText(label, { exact: true }) });
        expect(await card.innerText()).toContain(value);
      }
      expect(await page.getByText('600', { exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close(); child.kill('SIGTERM');
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 60000);
});
