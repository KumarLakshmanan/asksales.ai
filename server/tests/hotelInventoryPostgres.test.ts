/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic HTTP and Drizzle fixture boundaries. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import multer from 'multer';
import * as xlsx from '@e965/xlsx';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { chromium } from 'playwright-core';
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

local('independent hotel inventory against migrated disposable PostgreSQL', () => {
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
  const workbookBuffer = (rows: unknown[][]) => {
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([
      ['Date', 'Room Type', 'Rate (Gross)', 'Availability', 'Total Rooms Available'], ...rows,
    ]), 'Rates');
    return Buffer.from(xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  };
  const importRows = (rows: unknown[][], selectedHotel?: number | string) => {
    const upload = request(app).post('/api/hotel/import-rate-report');
    if (selectedHotel !== undefined) upload.field('hotelId', String(selectedHotel));
    return upload.attach('file', workbookBuffer(rows), 'synthetic-rates.xlsx');
  };
  const waitForLock = async (pattern: string, minimum = 1) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const waiting = await pool.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE $1 AND pid<>pg_backend_pid()`, [pattern]);
      if (waiting.rows[0].n >= minimum) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
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
    // Authentication is replaced with the synthetic owner above. Re-enter its
    // scope after multipart parsing; the real controller, SQL and RLS stay active.
    app.post('/api/hotel/import-rate-report', multer().single('file'),
      (req, res) => scoped(() => importRateReport(req, res)));
    global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('External providers are disabled in hotel audit'));
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
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

  it.each([
    ['impossible date', ['2030-02-30', 'Audit Room', 100, 1, 1]],
    ['missing date', [null, 'Audit Room', 100, 1, 1]],
    ['missing room', ['2030-01-02', null, 100, 1, 1]],
    ['duplicate room/day', ['2030-01-01', 'New Room', 100, 1, 1]],
  ])('composed import rejects a later %s without partial writes', async (_label, invalidRow) => {
    const res = await importRows([['2030-01-01', 'New Room', 150, 1, 1], invalidRow as unknown[]]);
    expect(res.status).toBe(400);
    expect((await pool.query('SELECT name FROM room_types ORDER BY id')).rows).toEqual([{name:'Audit Room'}]);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it('composed import rejects a malformed workbook without creating inventory', async () => {
    const res = await request(app).post('/api/hotel/import-rate-report')
      .attach('file', Buffer.from('not a rate workbook'), 'malformed.xlsx');
    expect(res.status).toBe(400);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it('composed import requires an unambiguous owned property and rejects malformed selectors', async () => {
    const second = await scoped(() => runtime.execute(sql`INSERT INTO hotel_properties(user_id,name)
      VALUES(${owner},'Synthetic Second Hotel') RETURNING id`));
    const secondId = Number(second.rows[0].id);
    const rows = [['2030-01-01', 'New Room', 100, 1, 1]];
    expect((await importRows(rows)).status).toBe(409);
    expect((await importRows(rows, 'not-an-id')).status).toBe(400);
    expect((await importRows(rows, 0)).status).toBe(400);
    expect((await importRows(rows, secondId)).status).toBe(200);
    expect((await pool.query("SELECT hotel_id FROM room_types WHERE name='New Room'")).rows)
      .toEqual([{hotel_id:secondId}]);
  });

  it('composed import hides another profile property even when its owner matches', async () => {
    const foreign = await scoped(() => runtime.execute(sql`INSERT INTO hotel_properties(user_id,name)
      VALUES(${owner},'Synthetic Other Profile Hotel') RETURNING id`), 41002);
    const res = await importRows([['2030-01-01', 'New Room', 100, 1, 1]], Number(foreign.rows[0].id));
    expect(res.status).toBe(404);
    expect((await pool.query('SELECT count(*)::integer AS n FROM room_types')).rows[0].n).toBe(1);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it('composed import rejects duplicate room identities or refuses legacy ambiguity', async () => {
    try {
      await scoped(() => runtime.execute(sql`INSERT INTO room_types(hotel_id,name,capacity,base_price,min_price)
        VALUES(${hotelId},'Audit Room',2,100,80)`));
    } catch (error) {
      // A later integration may include Data migration 331. Its exact unique
      // index prevents this legacy fixture from existing in the first place.
      // Current v8 lacks that index and exercises the controller's 409 path.
      const cause = (error as {cause?: unknown}).cause ?? error;
      expect(cause).toMatchObject({code:'23505',constraint:'room_types_hotel_name_import_uq'});
      expect((await pool.query('SELECT count(*)::integer AS n FROM room_types')).rows[0].n).toBe(1);
      return;
    }
    const res = await importRows([['2030-01-01', 'Audit Room', 150, 1, 1]]);
    expect(res.status).toBe(409);
    expect((await pool.query('SELECT DISTINCT price_per_night FROM room_availability')).rows)
      .toEqual([{price_per_night:'100.00'}]);
  });

  it('composed import counts expired but unreleased holds until cancellation commits', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    expect(held.booking).toBeDefined();
    await pool.query("UPDATE bookings SET hold_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [held.booking.id]);
    expect((await importRows([['2030-01-01', 'Audit Room', 100, 1, 1]])).status).toBe(200);
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
    expect('error' in await scoped(() => service.createBooking(draft('Competing guest')))).toBe(true);
    await scoped(() => service.cancelBookingById(held.booking.id, owner, 'Synthetic cancellation'));
    expect((await importRows([['2030-01-01', 'Audit Room', 100, 1, 1]])).status).toBe(200);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it('composed import also counts legacy confirmed reservations without a hold marker', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    expect(held.booking).toBeDefined();
    // Fixture state represents a pre-lifecycle confirmed booking. No payment or
    // confirmation provider is invoked by this import regression.
    await pool.query("UPDATE bookings SET status='confirmed',inventory_reserved_at=NULL WHERE id=$1", [held.booking.id]);
    expect((await importRows([['2030-01-01', 'Audit Room', 100, 1, 1]])).status).toBe(200);
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
  });

  it('composed import shares the owner advisory lock with property setup', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock($1,132)', [owner]);
    const importing = importRows([['2030-01-01', 'Audit Room', 150, 1, 1]]).then(res => res);
    let observed = false;
    try {
      observed = await waitForLock('%pg_advisory_xact_lock%');
      expect((await pool.query('SELECT DISTINCT price_per_night FROM room_availability')).rows)
        .toEqual([{price_per_night:'100.00'}]);
    } finally {
      await blocker.query('COMMIT'); blocker.release();
    }
    expect((await importing).status).toBe(200);
    expect(observed).toBe(true);
  });

  it('composed import cannot reopen stock while a competing booking hold commits', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM room_types WHERE id=$1 FOR UPDATE', [roomTypeId]);
    const booking = scoped(() => service.createBooking(draft()));
    let bookingWait = false;
    let importWait = false;
    let importing: Promise<request.Response> | undefined;
    try {
      bookingWait = await waitForLock('%FOR UPDATE OF rt, hp%');
      importing = importRows([['2030-01-01', 'Audit Room', 100, 1, 1]]).then(res => res);
      importWait = await waitForLock('%', 2);
    } finally {
      await blocker.query('COMMIT'); blocker.release();
    }
    const [held, imported] = await Promise.all([booking, importing!]);
    expect(bookingWait && importWait).toBe(true);
    expect('booking' in held).toBe(true);
    expect(imported.status).toBe(200);
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
    expect('error' in await scoped(() => service.createBooking(draft('Competing guest')))).toBe(true);
  });

  it('composed import reads fresh occupancy after a concurrent release commits', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    expect(held.booking).toBeDefined();
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query("SELECT id FROM room_availability WHERE room_type_id=$1 AND date='2030-01-01' FOR UPDATE", [roomTypeId]);
    const release = scoped(() => service.cancelBookingById(held.booking.id, owner, 'Synthetic release'));
    let releaseWait = false;
    let importWait = false;
    let importing: Promise<request.Response> | undefined;
    try {
      releaseWait = await waitForLock('%FROM room_availability%');
      importing = importRows([['2030-01-01', 'Audit Room', 100, 1, 1]]).then(res => res);
      importWait = await waitForLock('%', 2);
    } finally {
      await blocker.query('COMMIT'); blocker.release();
    }
    const [, imported] = await Promise.all([release, importing!]);
    expect(releaseWait && importWait).toBe(true);
    expect(imported.status).toBe(200);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

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

  it('restores inventory after mocked provider link failure and safe retry', async () => {
    await pool.query(`UPDATE api_credentials SET api_key='synthetic_key',api_secret='synthetic_secret',config=$1 WHERE user_id=$2`,[
      JSON.stringify({provider:'razorpay',webhookSecret:'synthetic_webhook',methods:{online:{enabled:true}}}),owner]);
    expect('error' in await scoped(() => service.createBooking(draft()))).toBe(true);
    expect('error' in await scoped(() => service.createBooking(draft()))).toBe(true);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
    expect((await pool.query('SELECT status FROM bookings ORDER BY id')).rows).toEqual([{status:'cancelled'},{status:'cancelled'}]);
  });

  (process.env.HOTEL_INVENTORY_BROWSER_QA === '1' ? it : it.skip)('persists rate and held-stock edits through the rendered inventory page at normal zoom', async () => {
    await scoped(() => service.createBooking(draft()));
    const server = app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve => server.once('listening',resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    try {
      const fixtureModule = '../../client/e2e/fixtures/app.js';
      const { installAppShellMocks, expectNoHorizontalOverflow } = await import(fixtureModule);
      const { expect: browserExpect } = await import('@playwright/test');
      for (const width of [1440,768,390]) {
        const page = await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1});
        const errors: string[] = [];
        page.on('pageerror',error => errors.push(error.message));
        await page.route('**/*',async route => {
          const url = new URL(route.request().url());
          if (!['127.0.0.1','localhost'].includes(url.hostname)) return route.abort();
          if (url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
          return route.continue();
        });
        await installAppShellMocks(page);
        await page.route('**/api/hotel/**',async route => {
          const url = new URL(route.request().url());
          const result = await route.fetch({url:apiUrl+url.pathname+url.search});
          await route.fulfill({response:result});
        });
        await page.goto('http://127.0.0.1:3104/dashboard/hotel?tab=rooms');
        await browserExpect(page.getByRole('heading',{name:'Hotel Management'})).toBeVisible({timeout:90000});
        await page.getByRole('button',{name:`Edit room type Audit Room (ID ${roomTypeId})`,exact:true}).click();
        await page.getByRole('spinbutton',{name:`Base price (INR) per night for Audit Room (ID ${roomTypeId})`,exact:true}).fill('110');
        await page.getByRole('button',{name:`Save changes to room type Audit Room (ID ${roomTypeId})`,exact:true}).click();
        await browserExpect(page.getByRole('button',{name:`Edit room type Audit Room (ID ${roomTypeId})`,exact:true})).toBeVisible();
        await page.reload();
        expect((await pool.query('SELECT base_price FROM room_types WHERE id=$1',[roomTypeId])).rows[0].base_price).toBe('110.00');
        await expectNoHorizontalOverflow(page);
        await page.getByRole('tab',{name:'Availability',exact:true}).click();
        await page.getByRole('button',{name:'Set Availability',exact:true}).first().click();
        await page.getByRole('combobox').last().click();
        await page.getByRole('option',{name:'Audit Room',exact:true}).click();
        await page.locator('input[type="date"]').nth(0).fill('2030-01-01');
        await page.locator('input[type="date"]').nth(1).fill('2030-01-02');
        await page.locator('input[type="number"]').nth(0).fill('2');
        await page.locator('input[type="number"]').nth(1).fill('100');
        await page.getByRole('button',{name:'Apply',exact:true}).click();
        await browserExpect(page.getByText('Availability updated for 2 day(s)',{exact:true})).toBeVisible();
        expect(await counts()).toEqual([{available_count:1,total_count:2},{available_count:1,total_count:2}]);
        await page.reload();
        await browserExpect(page.getByRole('heading',{name:'Hotel Management'})).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(await page.evaluate('window.visualViewport.scale')).toBe(1);
        await page.screenshot({path:`/tmp/hotel-publish-inventory-${width}.png`,fullPage:true});
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },180000);
});
