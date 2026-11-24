/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic HTTP and Drizzle fixture boundaries. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import * as xlsx from '@e965/xlsx';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Opt in against a NEW disposable database after running the real migrations.
// Never read dotenv or reuse the saved environment's application database.
const enabled = process.env.HOTEL_LOCAL_QA === '1';
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
const { LocalAvailabilityProvider } = await import('../services/booking/AvailabilityProvider.js');
const { NegotiationEngine } = await import('../services/booking/NegotiationEngine.js');

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
  const counts = async () => (await pool.query('SELECT available_count,total_count FROM room_availability ORDER BY date')).rows;
  const postPreciseEvent = (payload: unknown) => {
    const body = JSON.stringify(payload);
    return request(app).post('/webhook').set('Content-Type','application/json')
      .set('x-razorpay-signature',crypto.createHmac('sha256','synthetic_webhook').update(body).digest('hex')).send(body);
  };
  const configurePrecisePayment = async (bookingId: number) => {
    await pool.query("UPDATE bookings SET payment_provider='razorpay',payment_ref='plink_precise' WHERE id=$1",[bookingId]);
    await pool.query(`UPDATE api_credentials SET api_key='synthetic_key',api_secret='synthetic_secret',config=$1 WHERE user_id=$2`,[
      JSON.stringify({provider:'razorpay',webhookSecret:'synthetic_webhook',methods:{online:{enabled:true}}}),owner]);
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
    app.use(express.json({ verify: (req: any, _res, body) => { req.rawBody = body; } }));
    app.use((req: any, _res, next) => { req.user = { id: owner }; scoped(next); });
    app.put('/bookings/:id/confirm', payments.manuallyConfirmBooking);
    app.put('/bookings/:id/cancel', payments.cancelBooking);
    app.post('/webhook', payments.handlePaymentWebhook);
    app.get('/mock-confirm', payments.handleMockPaymentConfirm);
    app.get('/api/hotel/property', admin.getHotelProperty);
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

  it('serializes competing holds and releases one reservation exactly once', async () => {
    const results = await Promise.all(['A','B'].map(guest => scoped(() => service.createBooking(draft(guest)))));
    expect(results.filter(result => 'booking' in result)).toHaveLength(1);
    const held = results.find(result => 'booking' in result) as any;
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
    await Promise.all([1,2,3].map(() => scoped(() => service.cancelBookingById(held.booking.id, owner, 'Synthetic cancellation'))));
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it('rejects a stale confirmation after the hold deadline before cleanup runs', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query("UPDATE bookings SET hold_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [held.booking.id]);
    const result = await request(app).put(`/bookings/${held.booking.id}/confirm`).send({});
    expect(result.status).toBe(409);
    expect((await pool.query('SELECT status FROM bookings WHERE id=$1',[held.booking.id])).rows[0].status).toBe('expired');
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
    expect(reminders).not.toHaveBeenCalled();
  });

  it('checks expiry after waiting for the booking lock and reconciles a late provider payment', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query("UPDATE bookings SET payment_ref='synthetic_late',hold_expires_at=clock_timestamp()+INTERVAL '250 milliseconds' WHERE id=$1",[held.booking.id]);
    // Publish the short deadline, then separately hold the row lock.
    await blocker.query('COMMIT'); await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE',[held.booking.id]);
    const confirming = scoped(() => service.confirmBooking('synthetic_late','synthetic_payment'));
    // Attach rejection before releasing the lock to avoid unhandled rejection.
    const rejected = expect(confirming).rejects.toMatchObject({statusCode:409});
    await pool.query('SELECT pg_sleep(0.3)');
    await blocker.query('COMMIT'); blocker.release();
    await rejected;
    expect((await pool.query('SELECT status,payment_status,payment_id FROM bookings WHERE id=$1',[held.booking.id])).rows[0])
      .toEqual({status:'expired',payment_status:'refund_pending',payment_id:'synthetic_payment'});
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
    expect(reminders).not.toHaveBeenCalled();
  });

  it('keeps unreleased expired holds counted until release, including an inventory edit', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query("UPDATE bookings SET hold_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [held.booking.id]);
    await setInventory(2);
    expect(await counts()).toEqual([{available_count:1,total_count:2},{available_count:1,total_count:2}]);
    const next = await scoped(() => service.createBooking(draft('B'))) as any;
    expect(next.booking).toBeDefined();
    await scoped(() => service.releaseExpiredHolds());
    expect(await counts()).toEqual([{available_count:1,total_count:2},{available_count:1,total_count:2}]);
    const final = await scoped(() => service.createBooking(draft('C'))) as any;
    expect(final.booking).toBeDefined();
    expect('error' in await scoped(() => service.createBooking(draft('D')))).toBe(true);
  });

  it('does not overwrite a concurrent inventory hold with an administrative edit', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM room_types WHERE id=$1 FOR UPDATE',[roomTypeId]);
    const booking = scoped(() => service.createBooking(draft()));
    // Observe the actual server-side row-lock wait; avoid a timing-only race test.
    for (let attempt=0; attempt<100; attempt++) {
      const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF rt, hp%' AND pid<>pg_backend_pid()");
      if (waiting.rows.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const editing = setInventory(1);
    await blocker.query('COMMIT'); blocker.release();
    const [held,edited] = await Promise.all([booking,editing]);
    expect('booking' in held).toBe(true);
    expect(edited.code).toBe(200);
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
  });

  it('preserves committed reservations on rate report reimport', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    const sheet = xlsx.utils.json_to_sheet([{Date:'2030-01-01','Room Type':'Audit Room','Rate (Gross)':100,Availability:1,'Total Rooms Available':1}]);
    const workbook = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(workbook,sheet,'Rates');
    const res = response();
    await scoped(() => importRateReport({ user:{id:owner},file:{buffer:xlsx.write(workbook,{type:'buffer',bookType:'xlsx'})} } as any,res));
    expect(res.code).toBe(200);
    expect((await counts())[0]).toEqual({available_count:0,total_count:1});
    expect((await scoped(() => service.getById(held.booking.id,owner)))?.status).toBe('pending_payment');
  });

  it('rolls back the whole import when a later row would reduce stock below held rooms', async () => {
    await scoped(() => service.createBooking(draft()));
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook,xlsx.utils.json_to_sheet([
      {Date:'2030-01-01','Room Type':'Audit Room','Rate (Gross)':150,Availability:2,'Total Rooms Available':2},
      {Date:'2030-01-02','Room Type':'Audit Room','Rate (Gross)':150,Availability:0,'Total Rooms Available':0},
    ]),'Rates');
    const res = response();
    await scoped(() => importRateReport({user:{id:owner},file:{buffer:xlsx.write(workbook,{type:'buffer',bookType:'xlsx'})}} as any,res));
    expect(res.code).toBe(409);
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
    expect((await pool.query('SELECT DISTINCT price_per_night FROM room_availability')).rows).toEqual([{price_per_night:'100.00'}]);
  });

  it('rejects a mismatched manual receipt before confirming or running CRM effects', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    const result = await request(app).put(`/bookings/${held.booking.id}/confirm`).send({receipt:{amount:200,currency:'USD',reference:'synthetic_receipt'}});
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect((await scoped(() => service.getById(held.booking.id,owner)))?.status).toBe('pending_payment');
    expect(reminders).not.toHaveBeenCalled();
  });

  it('rejects a signed underpayment before confirming the booking', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query("UPDATE bookings SET payment_provider='razorpay',payment_ref='plink_synthetic' WHERE id=$1",[held.booking.id]);
    await pool.query(`UPDATE api_credentials SET api_key='synthetic_key',api_secret='synthetic_secret',config=$1 WHERE user_id=$2`,[
      JSON.stringify({provider:'razorpay',webhookSecret:'synthetic_webhook',methods:{online:{enabled:true}}}),owner]);
    const body = JSON.stringify({event:'payment_link.paid',payload:{payment_link:{entity:{id:'plink_synthetic',status:'paid'}},
      payment:{entity:{id:'pay_synthetic',captured:true,amount:100,currency:'INR'}}}});
    const signature = crypto.createHmac('sha256','synthetic_webhook').update(body).digest('hex');
    const result = await request(app).post('/webhook').set('Content-Type','application/json').set('x-razorpay-signature',signature).send(body);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect((await scoped(() => service.getById(held.booking.id,owner)))?.status).toBe('pending_payment');
    expect(reminders).not.toHaveBeenCalled();
  });

  it('deduplicates signed captures and records bounded refund replays', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query("UPDATE bookings SET payment_provider='razorpay',payment_ref='plink_synthetic' WHERE id=$1",[held.booking.id]);
    await pool.query(`UPDATE api_credentials SET api_key='synthetic_key',api_secret='synthetic_secret',config=$1 WHERE user_id=$2`,[
      JSON.stringify({provider:'razorpay',webhookSecret:'synthetic_webhook',methods:{online:{enabled:true}}}),owner]);
    const post = (payload: unknown, valid = true) => {
      const body = JSON.stringify(payload);
      return request(app).post('/webhook').set('Content-Type','application/json')
        .set('x-razorpay-signature',valid ? crypto.createHmac('sha256','synthetic_webhook').update(body).digest('hex') : 'invalid').send(body);
    };
    const capture = {event:'payment_link.paid',payload:{payment_link:{entity:{id:'plink_synthetic',status:'paid'}},
      payment:{entity:{id:'pay_synthetic',captured:true,amount:20000,currency:'INR'}}}};
    expect((await post(capture,false)).status).toBe(400);
    expect((await scoped(() => service.getById(held.booking.id,owner)))?.status).toBe('pending_payment');
    expect((await post(capture)).status).toBe(200);
    expect((await post(capture)).status).toBe(200);
    expect(reminders).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT count(*)::integer AS n FROM sales_outcome_events WHERE kind='payment_captured'")).rows[0].n).toBe(1);
    expect((await request(app).put(`/bookings/${held.booking.id}/cancel`).send({reason:'Synthetic cancellation'})).status).toBe(200);
    const refund = (id: string, amount: number) => ({event:'refund.processed',payload:{refund:{entity:{
      id,payment_id:'pay_synthetic',amount,currency:'INR',status:'processed',
    }}}});
    expect((await post(refund('rfnd_synthetic_partial',5000))).status).toBe(200);
    expect((await post(refund('rfnd_synthetic_partial',5000))).status).toBe(200);
    expect((await post(refund('rfnd_synthetic_over',20000))).status).toBeGreaterThanOrEqual(400);
    expect((await post(refund('rfnd_synthetic_remaining',15000))).status).toBe(200);
    expect((await post(refund('rfnd_synthetic_remaining',15000))).status).toBe(200);
    expect((await pool.query("SELECT sum(amount)::text AS amount FROM sales_outcome_events WHERE kind='payment_refunded'")).rows[0].amount).toBe('200.000000');
    expect((await scoped(() => service.getById(held.booking.id,owner)))?.paymentStatus).toBe('refunded');
    // A delayed duplicate of the original capture must not undo the verified refund.
    expect((await post(capture)).status).toBe(409);
    expect((await scoped(() => service.getById(held.booking.id,owner)))?.paymentStatus).toBe('refunded');
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  (process.env.HOTEL_BROWSER_QA === '1' ? it : it.skip)('renders booking confirmation, cancellation, reload and stale approval at normal zoom', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    const server = app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve => server.once('listening',resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    try {
      // Keep browser-only fixture DOM types out of the server's TypeScript graph.
      const fixtureModule = '../../client/e2e/fixtures/app.js';
      const { installAppShellMocks, expectNoHorizontalOverflow } = await import(fixtureModule);
      const { expect: browserExpect } = await import('@playwright/test');
      for (const width of [1440,768,390]) {
        const page = await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1});
        const errors: string[] = [];
        page.on('pageerror',error => errors.push(error.message));
        await page.route('**/*',async route => {
          const url = new URL(route.request().url());
          if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.abort();
          if (url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
          return route.continue();
        });
        await installAppShellMocks(page);
        await page.route('**/api/hotel/**',async route => {
          const url = new URL(route.request().url());
          const result = await route.fetch({url:apiUrl+url.pathname+url.search});
          await route.fulfill({response:result});
        });
        if (width === 768) {
          let first = true;
          await page.route('**/api/hotel/summary',async route => {
            if (first) { first = false; return route.fulfill({status:503,json:{error:'Synthetic temporary failure'}}); }
            return route.fallback();
          });
        }
        await page.goto('http://127.0.0.1:3104/dashboard/hotel?tab=bookings');
        await browserExpect(page.getByRole('heading',{name:'Hotel Management'})).toBeVisible({timeout:90000});
        if (width === 768) {
          const retry = page.getByRole('button',{name:'Retry',exact:true});
          if (await retry.isVisible()) await retry.click();
        }
        await browserExpect(page.getByRole('button',{name:`View booking ${held.booking.id}`})).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(await page.evaluate('window.visualViewport.scale')).toBe(1);
        await page.getByRole('button',{name:`View booking ${held.booking.id}`}).click();
        await browserExpect(page.getByRole('dialog')).toContainText('Synthetic Guest');
        await expectNoHorizontalOverflow(page);
        await page.keyboard.press('Escape');
        await browserExpect(page.getByRole('dialog')).toHaveCount(0);
        if (width === 1440) {
          await page.getByRole('button',{name:'Confirm paid',exact:true}).click();
          await page.getByRole('dialog').getByRole('button',{name:'Confirm paid',exact:true}).click();
          await browserExpect(page.getByText('Booking confirmed',{exact:true})).toBeVisible();
          await page.reload();
          await browserExpect(page.getByRole('row').filter({hasText:'Synthetic Guest'})).toContainText('confirmed');
          await page.getByRole('row').filter({hasText:'Synthetic Guest'}).getByRole('button',{name:'Cancel',exact:true}).click();
          await page.getByLabel('Cancellation reason').fill('Synthetic browser cancellation');
          await page.getByRole('button',{name:'Cancel booking',exact:true}).click();
          await browserExpect(page.getByRole('row').filter({hasText:'Synthetic Guest'})).toContainText('cancelled');
          await page.reload();
          await browserExpect(page.getByRole('row').filter({hasText:'Synthetic Guest'})).toContainText('refund pending');
        }
        if (width === 390) {
          const stale = await scoped(() => service.createBooking(draft('Stale Browser Guest'))) as any;
          await page.reload();
          const row = page.getByRole('row').filter({hasText:'Stale Browser Guest'});
          await row.getByRole('button',{name:'Confirm paid',exact:true}).click();
          await pool.query("UPDATE bookings SET hold_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[stale.booking.id]);
          await page.getByRole('dialog').getByRole('button',{name:'Confirm paid',exact:true}).click();
          await browserExpect(page.getByText('Confirmation failed',{exact:true})).toBeVisible();
          await page.getByRole('button',{name:'Back',exact:true}).click();
          await browserExpect(page.getByRole('dialog')).toHaveCount(0);
          await page.reload();
          await browserExpect(page.getByRole('row').filter({hasText:'Stale Browser Guest'})).toContainText('expired');
        }
        await page.screenshot({path:`/tmp/hotel-bookings-${width}.png`,fullPage:true});
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },180000);

  it('rejects another business room and hides bookings through real database isolation', async () => {
    expect(await scoped(() => service.getById(1,owner),41002)).toBeNull();
    const available = await scoped(() => new LocalAvailabilityProvider().searchAvailability(draft()),41002);
    expect(available).toEqual([]);
    const foreign = await scoped(() => service.createBooking(draft()),41002);
    expect('error' in foreign).toBe(true);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it('serializes partial room-rate edits before checking the resulting price floor', async () => {
    const blocker = await pool.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM room_types WHERE id=$1 FOR UPDATE',[roomTypeId]);
    const first = request(app).put(`/api/hotel/room-types/${roomTypeId}`).send({basePrice:90}).then(result => result.status);
    const second = request(app).put(`/api/hotel/room-types/${roomTypeId}`).send({minPrice:95}).then(result => result.status);
    let waiters = 0;
    for (let attempt=0;attempt<100;attempt++) {
      const waiting = await pool.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%room_types%' AND pid<>pg_backend_pid()");
      waiters = waiting.rows[0].n;
      if (waiters >= 2) break;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    await blocker.query('COMMIT'); blocker.release();
    expect(waiters).toBe(2);
    expect((await Promise.all([first,second])).sort()).toEqual([200,400]);
    const room = (await pool.query('SELECT base_price,min_price FROM room_types WHERE id=$1',[roomTypeId])).rows[0];
    expect(Number(room.min_price)).toBeLessThanOrEqual(Number(room.base_price));
  });

  it('enforces property and room validation, booking history and current price floors over HTTP and SQL', async () => {
    expect((await request(app).post('/api/hotel/property').send({name:'Synthetic Audit Hotel',timezone:'Invalid/Zone'})).status).toBe(400);
    expect((await request(app).post('/api/hotel/property').send({name:'Synthetic Audit Hotel',timezone:'Asia/Kolkata',currency:'USD'})).status).toBe(200);
    const invalid = {name:'New Room',capacity:2,basePrice:100,minPrice:120,maxDiscountPct:10};
    expect((await request(app).post('/api/hotel/room-types').send(invalid)).status).toBe(400);
    const created = await request(app).post('/api/hotel/room-types').send({...invalid,minPrice:80});
    expect(created.status).toBe(200);
    expect((await request(app).delete(`/api/hotel/room-types/${created.body.roomType.id}`)).status).toBe(200);
    await pool.query("UPDATE room_availability SET price_per_night=200 WHERE date='2030-01-02'");
    const options = await scoped(() => new LocalAvailabilityProvider().searchAvailability(draft()));
    expect(options[0]).toMatchObject({pricePerNight:200,totalPrice:300,currency:'USD'});
    const deal = await scoped(() => new NegotiationEngine().buildDeal(owner,roomTypeId,{round:3,requestedPrice:150,checkIn:'2030-01-01',checkOut:'2030-01-03',guests:1,rooms:1}));
    expect(deal).toMatchObject({floorPrice:160,approved:false,mustEscalate:true});
    expect('error' in await scoped(() => service.createBooking(draft()))).toBe(true);
    const held = await scoped(() => service.createBooking({...draft(),agreedPricePerNight:160})) as any;
    expect(held.booking).toBeDefined();
    expect((await request(app).delete(`/api/hotel/room-types/${roomTypeId}`)).status).toBe(409);
  });

  it('retries a disposable Redis expiry job and releases a hold once across competing jobs', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query("UPDATE bookings SET hold_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[held.booking.id]);
    const connection = {host:'127.0.0.1',port:6399,maxRetriesPerRequest:null};
    const name = `hotel-audit-expiry-${process.pid}`;
    const queue = new Queue(name,{connection});
    const events = new QueueEvents(name,{connection});
    const worker = new Worker(name,async job => {
      if (job.data.failFirst && job.attemptsMade === 0) throw new Error('Synthetic pre-execution failure');
      return scoped(() => service.releaseExpiredHolds());
    },{connection,concurrency:2});
    try {
      await events.waitUntilReady();
      const retry = await queue.add('expire',{failFirst:true},{attempts:2,backoff:{type:'fixed',delay:10}});
      const competing = await queue.add('expire',{});
      const results = await Promise.all([retry.waitUntilFinished(events,10000),competing.waitUntilFinished(events,10000)]);
      expect(results.reduce((sum,result) => sum+result.expired,0)).toBe(1);
      expect((await queue.getJob(retry.id!))?.attemptsMade).toBe(2);
      expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
    } finally {
      await worker.close(); await events.close(); await queue.obliterate({force:true}); await queue.close();
    }
  },15000);

  it('replays a local mock payment receipt after reload without changing its payment identity', async () => {
    process.env.ALLOW_MOCK_PAYMENTS = 'true';
    try {
      await pool.query('UPDATE api_credentials SET config=$1 WHERE user_id=$2',[
        JSON.stringify({provider:'mock',methods:{online:{enabled:true}}}),owner]);
      const held = await scoped(() => service.createBooking(draft())) as any;
      const ref = new URL(held.paymentUrl).searchParams.get('ref');
      expect(ref).toMatch(/^mock_[0-9a-f]{48}$/);
      const first = await Promise.all([1,2].map(() => request(app).get('/mock-confirm').query({ref})));
      expect(first.map(result => result.status)).toEqual([200,200]);
      const original = (await pool.query('SELECT payment_id FROM bookings WHERE id=$1',[held.booking.id])).rows[0].payment_id;
      const replay = await request(app).get('/mock-confirm').query({ref});
      expect(replay.status).toBe(200);
      expect(replay.text).toContain('Booking confirmed');
      expect((await pool.query('SELECT payment_id FROM bookings WHERE id=$1',[held.booking.id])).rows[0].payment_id).toBe(original);
      expect(reminders).toHaveBeenCalledTimes(1);
    } finally { delete process.env.ALLOW_MOCK_PAYMENTS; }
  });

  it('restores inventory after mocked provider link failure and safe retry', async () => {
    await pool.query(`UPDATE api_credentials SET api_key='synthetic_key',api_secret='synthetic_secret',config=$1 WHERE user_id=$2`,[
      JSON.stringify({provider:'razorpay',webhookSecret:'synthetic_webhook',methods:{online:{enabled:true}}}),owner]);
    expect('error' in await scoped(() => service.createBooking(draft()))).toBe(true);
    expect('error' in await scoped(() => service.createBooking(draft()))).toBe(true);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
    expect((await pool.query('SELECT status FROM bookings ORDER BY id')).rows).toEqual([{status:'cancelled'},{status:'cancelled'}]);
  });

  it('HT05b rejects a receipt persistence failure without committing confirmation and safely replays', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query(`CREATE OR REPLACE FUNCTION hotel_audit_reject_capture() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'Synthetic ledger persistence failure'; END $$;
      CREATE TRIGGER hotel_audit_reject_capture BEFORE INSERT ON sales_outcome_events FOR EACH ROW
      WHEN (NEW.kind='payment_captured') EXECUTE FUNCTION hotel_audit_reject_capture()`);
    try {
      const result = await request(app).put(`/bookings/${held.booking.id}/confirm`).send({receipt:{amount:200,currency:'INR',reference:'synthetic_receipt'}});
      expect(result.status).toBe(500);
      expect((await scoped(() => service.getById(held.booking.id,owner)))?.status).toBe('pending_payment');
      expect(reminders).not.toHaveBeenCalled();
    } finally {
      await pool.query('DROP TRIGGER hotel_audit_reject_capture ON sales_outcome_events; DROP FUNCTION hotel_audit_reject_capture()');
    }
    const retry = await request(app).put(`/bookings/${held.booking.id}/confirm`).send({receipt:{amount:200,currency:'INR',reference:'synthetic_receipt'}});
    expect(retry.status).toBe(200);
    expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({receipt:{amount:200,currency:'INR',reference:'synthetic_receipt'}})).status).toBe(200);
    expect((await pool.query("SELECT id FROM sales_outcome_events WHERE kind='payment_captured' AND booking_id=$1",[held.booking.id])).rows).toHaveLength(1);
    expect(reminders).toHaveBeenCalledTimes(1);
  });

  it('HT07 retries a failed CRM confirmation effect on replay', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    reminders.mockRejectedValueOnce(new Error('Synthetic reminder persistence failure'));
    expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({})).status).toBe(200);
    expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({})).status).toBe(200);
    expect(reminders).toHaveBeenCalledTimes(2);
  });

  it('keeps exactly one booking confirmed when concurrent HTTP receipts reuse one identity', async () => {
    await setInventory(2);
    const first = await scoped(() => service.createBooking(draft('Receipt A'))) as any;
    const second = await scoped(() => service.createBooking(draft('Receipt B'))) as any;
    const receipt = {amount:200,currency:'INR',reference:'synthetic_shared_receipt'};
    const results = await Promise.all([first,second].map(held => request(app).put(`/bookings/${held.booking.id}/confirm`).send({receipt})));
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect(results.filter(result => result.status >= 400)).toHaveLength(1);
    const statuses = (await pool.query('SELECT status FROM bookings ORDER BY status')).rows.map(row => row.status);
    expect(statuses).toEqual(['confirmed','pending_payment']);
    expect((await pool.query("SELECT id FROM sales_outcome_events WHERE kind='payment_captured'")).rows).toHaveLength(1);
    expect(reminders).toHaveBeenCalledTimes(1);
  });

  it('rolls back a signed webhook capture failure and safely confirms on provider replay', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query("UPDATE bookings SET payment_provider='razorpay',payment_ref='plink_atomic' WHERE id=$1",[held.booking.id]);
    await pool.query(`UPDATE api_credentials SET api_key='synthetic_key',api_secret='synthetic_secret',config=$1 WHERE user_id=$2`,[
      JSON.stringify({provider:'razorpay',webhookSecret:'synthetic_webhook',methods:{online:{enabled:true}}}),owner]);
    const body = JSON.stringify({event:'payment_link.paid',payload:{payment_link:{entity:{id:'plink_atomic',status:'paid'}},
      payment:{entity:{id:'pay_atomic',captured:true,amount:20000,currency:'INR'}}}});
    const post = () => request(app).post('/webhook').set('Content-Type','application/json')
      .set('x-razorpay-signature',crypto.createHmac('sha256','synthetic_webhook').update(body).digest('hex')).send(body);
    await pool.query(`CREATE OR REPLACE FUNCTION hotel_atomic_reject_capture() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'Synthetic signed capture failure'; END $$;
      CREATE TRIGGER hotel_atomic_reject_capture BEFORE INSERT ON sales_outcome_events FOR EACH ROW
      WHEN (NEW.kind='payment_captured') EXECUTE FUNCTION hotel_atomic_reject_capture()`);
    try {
      expect((await post()).status).toBe(500);
      const state = (await pool.query('SELECT status,payment_id,side_effects_processed_at FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
      expect(state).toEqual({status:'pending_payment',payment_id:null,side_effects_processed_at:null});
      expect(reminders).not.toHaveBeenCalled();
    } finally {
      await pool.query('DROP TRIGGER hotel_atomic_reject_capture ON sales_outcome_events; DROP FUNCTION hotel_atomic_reject_capture()');
    }
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await pool.query("SELECT id FROM sales_outcome_events WHERE kind='payment_captured'")).rows).toHaveLength(1);
    expect(reminders).toHaveBeenCalledTimes(1);
  });

  it('accounts exactly for signed 30-minor capture and 10 plus 20-minor refunds over HTTP', async () => {
    await pool.query('UPDATE room_types SET base_price=0.15,min_price=0.10 WHERE id=$1',[roomTypeId]);
    await pool.query('UPDATE room_availability SET price_per_night=0.15');
    const held = await scoped(() => service.createBooking({...draft(),agreedPricePerNight:0.15})) as any;
    await configurePrecisePayment(held.booking.id);
    expect((await postPreciseEvent({event:'payment_link.paid',payload:{payment_link:{entity:{id:'plink_precise',status:'paid'}},
      payment:{entity:{id:'pay_precise',captured:true,amount:30,currency:'INR'}}}})).status).toBe(200);
    expect((await request(app).put(`/bookings/${held.booking.id}/cancel`).send({reason:'Synthetic fractional refund'})).status).toBe(200);
    const refund = (id: string, amount: number) => ({event:'refund.processed',payload:{refund:{entity:{
      id,payment_id:'pay_precise',amount,currency:'INR',status:'processed',
    }}}});
    expect((await postPreciseEvent(refund('rfnd_precise_ten',10))).status).toBe(200);
    expect((await postPreciseEvent(refund('rfnd_precise_twenty',20))).status).toBe(200);
    expect((await scoped(() => service.getById(held.booking.id,owner)))?.paymentStatus).toBe('refunded');
    expect((await pool.query("SELECT SUM(amount)::text AS amount FROM sales_outcome_events WHERE kind='payment_refunded'")).rows[0].amount).toBe('0.300000');
  });

  it('rejects altered signed receipt identities on replay without changing ledger totals', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await configurePrecisePayment(held.booking.id);
    const capture = (amount: number) => ({event:'payment_link.paid',payload:{payment_link:{entity:{id:'plink_precise',status:'paid'}},
      payment:{entity:{id:'pay_precise',captured:true,amount,currency:'INR'}}}});
    expect((await postPreciseEvent(capture(20000))).status).toBe(200);
    expect((await postPreciseEvent(capture(20001))).status).toBeGreaterThanOrEqual(400);
    const refund = (amount: number) => ({event:'refund.processed',payload:{refund:{entity:{
      id:'rfnd_immutable',payment_id:'pay_precise',amount,currency:'INR',status:'processed',
    }}}});
    expect((await postPreciseEvent(refund(1000))).status).toBe(200);
    expect((await postPreciseEvent(refund(2000))).status).toBeGreaterThanOrEqual(400);
    expect((await pool.query("SELECT SUM(amount)::text AS amount FROM sales_outcome_events WHERE kind='payment_refunded'")).rows[0].amount).toBe('10.000000');
  });
});
