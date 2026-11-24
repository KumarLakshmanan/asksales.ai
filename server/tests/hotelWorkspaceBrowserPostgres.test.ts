/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic HTTP and Drizzle fixture boundaries. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import multer from 'multer';
import * as xlsx from '@e965/xlsx';
import { preserveAsyncContext } from '../middleware/preserveAsyncContext.js';
import { responseWrapper } from '../middleware/responseWrapper.js';
import { chromium } from 'playwright-core';

import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Opt in against a NEW disposable database after running the real migrations.
// Never read dotenv or reuse the saved environment's application database.
const enabled = process.env.HOTEL_LOCAL_QA === '1' && process.env.HOTEL_BROWSER_QA === '1';
const local = enabled ? describe : describe.skip;
let runtime: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, key) => (runtime as any)[key].bind(runtime),
}) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: {
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
} }));
jest.unstable_mockModule('../services/booking/HotelRagSyncService.js', () => ({
  hotelRagSyncService: { deleteRoomTypeFromRag: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) },
}));
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: {} }));
const reminders = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../services/ReminderService.js', () => ({ reminderService: { scheduleBookingReminders: reminders } }));
jest.unstable_mockModule('../services/AlertService.js', () => ({ alertService: {
  fireEvent: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
} }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: {
  retrieveText: jest.fn<() => Promise<string>>().mockResolvedValue(''),
} }));
const { BookingService } = await import('../services/booking/BookingService.js');
const admin = await import('../controllers/hotelAdminController.js');
const payments = await import('../controllers/bookingPaymentController.js');
const { importRateReport } = await import('../controllers/hotelImportController.js');

const owner = 41001;
const profile = 41001;
const scoped = <T>(work: () => T, businessProfileId = profile) => withBusinessScope({ userId: owner, businessProfileId }, work);
function response() {
  const res: any = { code: 200 };
  res.status = (code: number) => { res.code = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

local('hotel lifecycle against migrated disposable PostgreSQL', () => {
  let pool: Pool;
  let service: InstanceType<typeof BookingService>;
  let roomTypeId: number;
  let hotelId: number;
  let app: express.Express;
  const draft = (guest = 'Synthetic Guest') => ({ userId: owner, roomTypeId, guestName: guest,
    checkIn: '2030-01-01', checkOut: '2030-01-03', guests: 1, rooms: 1, agreedPricePerNight: 100 });
  const setInventory = async (count: number) => {
    const res = response();
    await scoped(() => admin.setAvailability({ user: { id: owner }, body: {
      roomTypeId, from: '2030-01-01', to: '2030-01-02', availableCount: count, pricePerNight: 100,
    } } as any, res));
    return res;
  };
  beforeAll(async () => {
    if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'hotel_audit' || process.env.DB_PORT !== '5544') {
      throw new Error('HOTEL_LOCAL_QA requires disposable hotel_audit at 127.0.0.1:5544');
    }
    pool = new Pool({ host: '127.0.0.1', port: 5544, database: 'hotel_audit', user: 'postgres',
      password: 'hotel_audit_disposable', max: 12, options: '-c app.business_system=on -c timezone=UTC' });
    runtime = drizzle(createBusinessScopedPool(pool));
    await pool.query(`INSERT INTO users(id,email,name) VALUES($1,'hotel-audit@example.test','Synthetic Hotel Audit') ON CONFLICT(id) DO NOTHING`, [owner]);
    await pool.query(`INSERT INTO company_settings(id,user_id,company_name) VALUES($1,$2,'Synthetic Hotel Audit') ON CONFLICT(id) DO NOTHING`, [profile, owner]);
    await pool.query(`INSERT INTO company_settings(id,user_id,company_name) VALUES(41002,$1,'Synthetic Other Business') ON CONFLICT(id) DO NOTHING`, [owner]);
    app = express();
    app.use('/api', responseWrapper);
    app.use(express.json({ verify: (req: any, _res, body) => { req.rawBody = body; } }));
    app.use((req: any, _res, next) => { req.user = { id: owner }; scoped(next); });
    app.put('/bookings/:id/confirm', payments.manuallyConfirmBooking);
    app.put('/bookings/:id/cancel', payments.cancelBooking);
    app.post('/webhook', payments.handlePaymentWebhook);
    app.get('/mock-confirm', payments.handleMockPaymentConfirm);
    app.get('/api/hotel/property', admin.getHotelProperty);
    app.post('/api/hotel/import-rate-report', preserveAsyncContext(multer({ storage: multer.memoryStorage() }).single('file')), importRateReport);
    app.get('/api/hotel/summary', admin.getHotelSummary);
    app.get('/api/hotel/room-types', admin.listRoomTypes);
    app.post('/api/hotel/property', admin.saveHotelProperty);
    app.post('/api/hotel/room-types', admin.createRoomType);
    app.put('/api/hotel/room-types/:id', admin.updateRoomType);
    app.delete('/api/hotel/room-types/:id', admin.deleteRoomType);
    app.get('/api/hotel/bookings', admin.listBookings);
    app.get('/api/hotel/availability', admin.getAvailability);
    app.post('/api/hotel/availability', admin.setAvailability);
    app.put('/api/hotel/bookings/:id/confirm', payments.manuallyConfirmBooking);
    app.post('/api/hotel/bookings/:id/recovery', payments.retryBookingConfirmationSetup);
    app.put('/api/hotel/bookings/:id/cancel', payments.cancelBooking);
    global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('External providers are disabled in hotel audit'));
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query('DELETE FROM crm_activity_reminders WHERE user_id=$1', [owner]);
    await pool.query('DELETE FROM sales_outcome_events WHERE user_id=$1', [owner]);
    await pool.query('DELETE FROM bookings WHERE user_id=$1', [owner]);
    await pool.query('DELETE FROM hotel_properties WHERE user_id=$1', [owner]);
    await pool.query('DELETE FROM api_credentials WHERE user_id=$1', [owner]);
    await scoped(async () => {
      const property = await runtime.execute(sql`INSERT INTO hotel_properties(user_id,name,currency,timezone) VALUES(${owner},'Synthetic Audit Hotel','INR','UTC') RETURNING id`);
      hotelId = Number(property.rows[0].id);
      const room = await runtime.execute(sql`INSERT INTO room_types(hotel_id,name,capacity,base_price,min_price,max_discount_pct) VALUES(${hotelId},'Audit Room',2,100,80,20) RETURNING id`);
      roomTypeId = Number(room.rows[0].id);
      await runtime.execute(sql`INSERT INTO api_credentials(user_id,service_name,config) VALUES(${owner},'razorpay',${JSON.stringify({provider:'mock',methods:{manual:{enabled:true,instructions:'Synthetic offline receipt'}}})}::jsonb)`);
    });
    service = new BookingService();
    reminders.mockClear();
    await setInventory(1);
  });


  async function openBrowser(tab: string) {
    const server = app.listen(3188, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
      if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/hotel/')) return route.fulfill({ json: {} });
      return route.continue();
    });
    const fixtureModule = '../../client/e2e/fixtures/app.js';
    const { installAppShellMocks } = await import(fixtureModule);
    await installAppShellMocks(page);
    const { expect: browserExpect } = await import('@playwright/test');
    const close = async () => { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
    const go = async () => {
      await page.goto(`http://127.0.0.1:3105/dashboard/hotel?tab=${tab}`);
      await browserExpect(page.getByRole('heading', { name: 'Hotel Management' })).toBeVisible({ timeout: 90000 });
      if (!['payments', 'property'].includes(tab)) await browserExpect(page.getByText('Audit Room', { exact: true }).first()).toBeVisible();
      await browserExpect(page.locator('[inert] button[aria-label^="Edit availability"]')).toHaveCount(0);
    };
    return { page, browserExpect, close, go, pageErrors };
  }
  async function saveEvidence(id: string, data: unknown, page: any) {
    const fs = await import('node:fs/promises');
    const base = process.env.HOTEL_EVIDENCE_DIR || '/tmp/hotel-workspace-evidence';
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(`${base}/${id}.json`, JSON.stringify(data, null, 2));
    await page.screenshot({ path: `${base}/${id}.png`, fullPage: true });
  }

  it('H2-01 price-only calendar edit preserves total inventory', async () => {
    const dayOffset = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const checkIn = dayOffset(1), checkOut = dayOffset(3);
    await request(app).post('/api/hotel/availability').send({ roomTypeId, from: checkIn, to: dayOffset(2), availableCount: 5, pricePerNight: 100 });
    const held = await scoped(() => service.createBooking({ ...draft(), checkIn, checkOut })) as any;
    expect(held.booking).toBeDefined();
    const ui = await openBrowser('availability');
    try {
      await ui.go();
      await ui.browserExpect(ui.page.getByText('4/5', { exact: true }).first()).toBeVisible();
      await ui.page.getByText('4/5', { exact: true }).first().click();
      const count = ui.page.getByPlaceholder('Count');
      const initialCount = await count.inputValue();
      await ui.page.getByPlaceholder('Price', { exact: true }).fill('125');
      const cell = ui.page.locator('td').filter({ has: count });
      const responsePromise = ui.page.waitForResponse(response => new URL(response.url()).pathname === '/api/hotel/availability' && response.request().method() === 'POST');
      await cell.getByRole('button').first().click();
      const saved = await responsePromise;
      const afterSave = (await pool.query('SELECT available_count,total_count,price_per_night FROM room_availability WHERE room_type_id=$1 AND date=$2', [roomTypeId, checkIn])).rows[0];
      await scoped(() => service.cancelBookingById(held.booking.id, owner, 'Synthetic audit cleanup'));
      const afterRelease = (await pool.query('SELECT available_count,total_count FROM room_availability WHERE room_type_id=$1 AND date=$2', [roomTypeId, checkIn])).rows[0];
      await saveEvidence('H2-01', { baseline: '24c66b9cac2936ccbd119e39cf78b5b83b1e6212', before: { available_count: 4, total_count: 5 }, initialCount, submitted: saved.request().postDataJSON(), http: saved.status(), afterSave, afterRelease, zoom: await ui.page.evaluate('visualViewport.scale'), pageErrors: ui.pageErrors }, ui.page);
      expect(afterSave).toMatchObject({ total_count: 5, available_count: 4 });
      expect(afterRelease).toEqual({ total_count: 5, available_count: 5 });
    } finally { await ui.close(); }
  }, 180000);



  it('H2-03 supports keyboard inventory editing and booking-dialog focus at normal zoom', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    const ui = await openBrowser('availability');
    try {
      for (const width of [1440, 768, 390]) {
        await ui.page.setViewportSize({ width, height: 900 }); await ui.go();
        const edit = ui.page.getByRole('button', { name: /Edit availability for Audit Room/ }).first();
        await edit.focus(); await ui.browserExpect(edit).toBeFocused(); await ui.page.keyboard.press('Enter');
        await saveEvidence('H2-03-editor-open', { focused: await ui.page.evaluate('document.activeElement.outerHTML'), inert: await ui.page.locator('[inert]').evaluateAll((nodes: any[]) => nodes.map(node => node.outerHTML.slice(0, 1500))) }, ui.page);
        await ui.browserExpect(ui.page.getByRole('spinbutton', { name: /Total rooms for Audit Room/ })).toBeFocused();
        await ui.browserExpect(ui.page.getByRole('button', { name: /Save availability for Audit Room/ })).toBeVisible();
        await ui.browserExpect(ui.page.getByRole('button', { name: /Cancel availability edit for Audit Room/ })).toBeVisible();
        await ui.page.keyboard.press('Escape'); await ui.browserExpect(edit).toBeFocused();
        await ui.page.getByRole('tab', { name: 'Bookings', exact: true }).click();
        const view = ui.page.getByRole('button', { name: `View booking ${held.booking.id}` });
        await view.focus(); await ui.page.keyboard.press('Enter');
        await ui.browserExpect(ui.page.getByRole('dialog')).toContainText('Synthetic Guest');
        await ui.page.keyboard.press('Escape'); await ui.browserExpect(view).toBeFocused();
        const geometry = await ui.page.evaluate('({zoom:visualViewport.scale,width:innerWidth,documentWidth:document.documentElement.scrollWidth})') as { zoom: number; width: number; documentWidth: number };
        expect(geometry.zoom).toBe(1); expect(geometry.documentWidth).toBeLessThanOrEqual(width);
        await saveEvidence(`H2-03-${width}`, { geometry, pageErrors: ui.pageErrors }, ui.page);
      }
      expect(ui.pageErrors).toEqual([]);
    } finally { await ui.close(); }
  }, 180000);


  it('H2-04 shows unfinished setup and explicitly recovers it without another financial confirmation', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    reminders.mockRejectedValueOnce(new Error('Synthetic reminder persistence failure'));
    const ui = await openBrowser('bookings');
    try {
      await ui.go();
      const row = ui.page.getByRole('row').filter({ hasText: 'Synthetic Guest' });
      await row.getByRole('button', { name: 'Confirm paid', exact: true }).click();
      await ui.page.getByRole('dialog').getByRole('button', { name: 'Confirm paid', exact: true }).click();
      await ui.browserExpect(ui.page.getByText('Booking confirmed; setup needs attention', { exact: true })).toBeVisible();
      await ui.page.reload();
      const retry = ui.page.getByRole('button', { name: `Retry confirmation setup for booking ${held.booking.id}` });
      await ui.browserExpect(retry).toBeVisible(); await ui.browserExpect(row).toContainText('Confirmation setup unfinished: reminders');
      const financialBefore = (await pool.query('SELECT status,payment_status,payment_id,total_price FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
      await retry.click();
      await ui.browserExpect(ui.page.getByText('Confirmation setup complete', { exact: true })).toBeVisible();
      await ui.browserExpect(retry).toHaveCount(0);
      expect((await pool.query('SELECT status,payment_status,payment_id,total_price FROM bookings WHERE id=$1',[held.booking.id])).rows[0]).toEqual(financialBefore);
      expect(reminders).toHaveBeenCalledTimes(2);
      await saveEvidence('H2-04-after', { financialBefore, pageErrors: ui.pageErrors }, ui.page);
    } finally { await ui.close(); }
  }, 180000);


  it('COV2-02 retains newer payment edits while a mocked save is pending', async () => {
    const ui = await openBrowser('payments');
    let finish!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const posted = new Promise<void>(resolve => { entered = resolve; });
    let submitted: any; let gets = 0;
    await ui.page.route('**/api/hotel/payment-settings', async route => {
      if (route.request().method() === 'POST') {
        submitted = route.request().postDataJSON(); entered(); await pending;
        return route.fulfill({ json: { success: true } });
      }
      gets++;
      return route.fulfill({ json: { settings: { configured: true, paymentMethodsEnabled: false, provider: 'razorpay', externalBooking: { url: 'https://booking.example.test/a', linkTitle: 'Original' }, methods: { online: { enabled: false } } } } });
    });
    try {
      await ui.go();
      const title = ui.page.getByLabel('Link title (optional)');
      await ui.browserExpect(title).toBeVisible(); const getsBeforeSave = gets;
      await title.fill('Submitted A'); await ui.page.getByRole('button', { name: /Save.*Settings/i }).click();
      await posted; await title.fill('Newer B'); finish();
      await ui.browserExpect(ui.page.getByText('Booking payment settings saved', { exact: true })).toBeVisible();
      await ui.browserExpect(title).toHaveValue('Newer B');
      expect(submitted.externalBooking.linkTitle).toBe('Submitted A'); expect(gets).toBe(getsBeforeSave);
      await saveEvidence('COV2-02-after', { saved: submitted.externalBooking.linkTitle, draft: await title.inputValue(), mockedPaymentRequests: true }, ui.page);
    } finally { finish?.(); await ui.close(); }
  }, 180000);


  it('COV2-03 activates hotel tabs with arrows, Home and End at normal zoom', async () => {
    await scoped(() => service.createBooking(draft()));
    const ui = await openBrowser('bookings');
    try {
      for (const width of [1440, 390]) {
        await ui.page.setViewportSize({ width, height: 900 }); await ui.go();
        await ui.page.getByRole('tab', { name: 'Payments', exact: true }).focus();
        await ui.page.keyboard.press('ArrowRight');
        const profile = ui.page.getByRole('tab', { name: 'Hotel Profile', exact: true });
        await ui.browserExpect(profile).toBeFocused(); await ui.browserExpect(profile).toHaveAttribute('aria-selected', 'true');
        await ui.browserExpect(ui.page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'hotel-tab-property');
        await ui.page.keyboard.press('Home'); await ui.browserExpect(ui.page.getByRole('tab', { name: 'Room Types', exact: true })).toBeFocused();
        await ui.page.keyboard.press('ArrowLeft'); await ui.browserExpect(profile).toBeFocused();
        await ui.page.keyboard.press('Home'); await ui.page.keyboard.press('End'); await ui.browserExpect(profile).toBeFocused();
        expect(await ui.page.locator('[role=tab][tabindex="0"]').count()).toBe(1);
        expect(await ui.page.evaluate('visualViewport.scale')).toBe(1);
        await saveEvidence(`COV2-03-${width}`, { pageErrors: ui.pageErrors }, ui.page);
      }
    } finally { await ui.close(); }
  }, 180000);


  it('D2-03 imports into the explicitly chosen property through real multipart HTTP and SQL', async () => {
    const other = await scoped(() => runtime.execute(sql`INSERT INTO hotel_properties(user_id,name,currency,timezone) VALUES(${owner},'Synthetic Second Hotel','INR','UTC') RETURNING id`));
    const otherId = Number(other.rows[0].id);
    await scoped(() => runtime.execute(sql`INSERT INTO hotel_properties(user_id,name) VALUES(${owner},'Foreign Business Hotel')`), 41002);
    const sheet = xlsx.utils.json_to_sheet([{ Date: '2030-01-01', 'Room Type': 'Imported Other Room', 'Rate (Gross)': 100, Availability: 2, 'Total Rooms Available': 2 }]);
    const workbook = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(workbook, sheet, 'Rates');
    const ui = await openBrowser('rooms');
    try {
      await ui.go();
      const destination = ui.page.getByLabel('Import property');
      await ui.browserExpect(destination).toHaveValue('');
      await ui.browserExpect(ui.page.getByRole('button', { name: 'Import Excel', exact: true })).toBeDisabled();
      expect(await destination.locator('option').allTextContents()).not.toContain('Foreign Business Hotel');
      await destination.selectOption(String(otherId));
      const importing = ui.page.waitForResponse(response => new URL(response.url()).pathname === '/api/hotel/import-rate-report');
      await ui.page.getByLabel('Rate report workbook').setInputFiles({ name: 'synthetic-rates.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }) });
      const result = await importing; expect(result.status()).toBe(200);
      const rooms = (await pool.query('SELECT hotel_id,name FROM room_types WHERE hotel_id=ANY($1::int[]) ORDER BY id', [[hotelId, otherId]])).rows;
      expect(rooms).toEqual([{ hotel_id: hotelId, name: 'Audit Room' }, { hotel_id: otherId, name: 'Imported Other Room' }]);
      await ui.browserExpect(ui.page.getByText('Imported into Synthetic Second Hotel.', { exact: true })).toBeVisible();
      await saveEvidence('D2-03-after', { otherId, rooms, pageErrors: ui.pageErrors }, ui.page);
    } finally { await ui.close(); }
  }, 180000);


  it('D2-04 retains row diagnostics and preserves reservations through rejected and corrected workbook uploads', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    const workbook = (bad: boolean) => {
      const rows = [1, 2].map((day, index) => ({ Date: `2030-01-0${day}`, 'Room Type': 'Audit Room', 'Rate (Gross)': 125, Availability: bad && index === 1 ? 0 : 1, 'Total Rooms Available': bad && index === 1 ? 0 : 1 }));
      const book = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(book, xlsx.utils.json_to_sheet(rows), 'Rates');
      return xlsx.write(book, { type: 'buffer', bookType: 'xlsx' });
    };
    const ui = await openBrowser('rooms');
    try {
      await ui.go(); const input = ui.page.getByLabel('Rate report workbook');
      const rejected = ui.page.waitForResponse(response => new URL(response.url()).pathname === '/api/hotel/import-rate-report');
      await input.setInputFiles({ name: 'synthetic-broken.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook(true) });
      expect((await rejected).status()).toBe(409);
      const diagnostic = ui.page.getByRole('alert').filter({ hasText: 'synthetic-broken.xlsx' });
      await ui.browserExpect(diagnostic).toContainText('Row 3');
      const before = (await pool.query('SELECT available_count,total_count,price_per_night FROM room_availability WHERE room_type_id=$1 ORDER BY date',[roomTypeId])).rows;
      expect(before).toEqual([{ available_count: 0, total_count: 1, price_per_night: '100.00' }, { available_count: 0, total_count: 1, price_per_night: '100.00' }]);
      const accepted = ui.page.waitForResponse(response => new URL(response.url()).pathname === '/api/hotel/import-rate-report');
      await input.setInputFiles({ name: 'synthetic-corrected.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook(false) });
      expect((await accepted).status()).toBe(200); await ui.browserExpect(diagnostic).toHaveCount(0);
      const after = (await pool.query('SELECT available_count,total_count,price_per_night FROM room_availability WHERE room_type_id=$1 ORDER BY date',[roomTypeId])).rows;
      expect(after).toEqual([{ available_count: 0, total_count: 1, price_per_night: '125.00' }, { available_count: 0, total_count: 1, price_per_night: '125.00' }]);
      await scoped(() => service.cancelBookingById(held.booking.id, owner, 'Synthetic cleanup'));
      await saveEvidence('D2-04-after', { rejectedRows: before, correctedRows: after, pageErrors: ui.pageErrors }, ui.page);
    } finally { await ui.close(); }
  }, 180000);


  it('rejects reserved external booking destinations before a settings submission', async () => {
    const ui = await openBrowser('payments'); let posts = 0;
    await ui.page.route('**/api/hotel/payment-settings', route => {
      if (route.request().method() === 'POST') { posts++; return route.fulfill({ status: 400, json: { error: 'Unexpected synthetic write' } }); }
      return route.fulfill({ json: { settings: { configured: true, paymentMethodsEnabled: false, provider: 'razorpay', externalBooking: { url: 'https://booking.example.test/a', linkTitle: 'Original' }, methods: { online: { enabled: false } } } } });
    });
    try {
      await ui.go();
      for (const url of ['https://localhost./', 'https://100.64.0.1/', 'https://192.0.2.1/', 'https://[::ffff:127.0.0.1]/']) {
        await ui.page.getByLabel('External booking URL').fill(url);
        await ui.page.getByRole('button', { name: /Save.*Settings/i }).click();
        await ui.browserExpect(ui.page.getByText('Valid booking page required', { exact: true }).first()).toBeVisible();
      }
      expect(posts).toBe(0); await saveEvidence('URL-feedback-after', { posts, serverDnsPolicyUnchanged: true }, ui.page);
    } finally { await ui.close(); }
  }, 180000);


  it('keeps ordinary members read-only without submitting payment configuration', async () => {
    const ui = await openBrowser('payments'); let posts = 0;
    await ui.page.setViewportSize({ width: 390, height: 900 });
    await ui.page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [{ id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'member' }] }));
    await ui.page.route('**/api/hotel/payment-settings', route => {
      if (route.request().method() === 'POST') { posts++; return route.fulfill({ status: 403, json: { error: 'Synthetic member guard' } }); }
      return route.fulfill({ json: { settings: { configured: true, paymentMethodsEnabled: false, provider: 'razorpay', externalBooking: { url: 'https://booking.example.test/a', linkTitle: 'Original' }, methods: { online: { enabled: false } } } } });
    });
    try {
      await ui.go();
      await ui.browserExpect(ui.page.getByLabel('External booking URL')).toBeDisabled();
      await ui.browserExpect(ui.page.getByRole('button', { name: /Save.*Settings/i })).toBeDisabled();
      await ui.browserExpect(ui.page.getByText(/Only the business owner or billing admin can change payment settings/)).toBeVisible();
      expect(posts).toBe(0); expect(await ui.page.evaluate('visualViewport.scale')).toBe(1);
      await saveEvidence('member-payment-after', { posts, pageErrors: ui.pageErrors }, ui.page);
    } finally { await ui.close(); }
  }, 180000);

});
