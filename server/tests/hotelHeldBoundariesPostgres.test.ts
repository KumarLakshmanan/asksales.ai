/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic HTTP and Drizzle fixture boundaries. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { zonedDateTimeToUtc } from '../utils/timezone.js';
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
const alerts = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../services/AlertService.js', () => ({ alertService: { fireEvent: alerts } }));
jest.unstable_mockModule('../services/adminEmailService.js', () => ({ sendAdminEmail: jest.fn() }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: {
  retrieveText: jest.fn<() => Promise<string>>().mockResolvedValue(''),
} }));
const { BookingService } = await import('../services/booking/BookingService.js');
const admin = await import('../controllers/hotelAdminController.js');
const payments = await import('../controllers/bookingPaymentController.js');

const { NegotiationEngine } = await import('../services/booking/NegotiationEngine.js');
const { NegotiationSubAgent } = await import('../services/agents/subagents/NegotiationSubAgent.js');
const { getAvailabilityProvider } = await import('../services/booking/AvailabilityProvider.js');
const observedDbErrors: string[] = [];
const guarded = (handler: any) => (req: any, res: any, next: any) => { Promise.resolve(handler(req, res)).catch(next); };
const owner = 41001;
const profile = 41001;
const scoped = <T>(work: () => T, businessProfileId = profile) => withBusinessScope({ userId: owner, businessProfileId }, work);
function response() {
  const res: any = { code: 200 };
  res.status = (code: number) => { res.code = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

local('Hotel held contracts on integrated v8: local validation acceptance and unchanged policy characterizations', () => {
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
  const postCapture = (amount = 20000, currency = 'INR', paymentId = 'pay_held_contract') => {
    const body = JSON.stringify({event:'payment_link.paid',payload:{payment_link:{entity:{id:'plink_held_contract',status:'paid'}},
      payment:{entity:{id:paymentId,captured:true,amount,currency}}}});
    return request(app).post('/webhook').set('Content-Type','application/json')
      .set('x-razorpay-signature',crypto.createHmac('sha256','synthetic_webhook').update(body).digest('hex')).send(body);
  };
  const configureCapture = async (id: number) => {
    await pool.query("UPDATE bookings SET payment_provider='razorpay',payment_ref='plink_held_contract' WHERE id=$1",[id]);
    await pool.query('UPDATE api_credentials SET api_key=$1,api_secret=$2,config=$3 WHERE user_id=$4',
      ['synthetic_key','synthetic_secret',JSON.stringify({provider:'razorpay',webhookSecret:'synthetic_webhook',methods:{online:{enabled:true}}}),owner]);
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
    app.get('/api/hotel/availability', guarded(admin.getAvailability));
    app.post('/api/hotel/availability', guarded(admin.setAvailability));
    app.put('/api/hotel/bookings/:id/confirm', payments.manuallyConfirmBooking);
    app.post('/api/hotel/bookings/:id/recovery', payments.retryBookingConfirmationSetup);
    app.put('/api/hotel/bookings/:id/cancel', payments.cancelBooking);
    app.get('/api/hotel/follow-ups', admin.listFollowUps);
    app.use((err: any, _req: any, res: any, _next: any) => {
      observedDbErrors.push(err.cause?.code || err.code || err.message);
      res.status(500).json({ error: 'Synthetic harness caught controller rejection' });
    });
    global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('External providers are disabled in hotel audit'));
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    observedDbErrors.length = 0;
    jest.restoreAllMocks();
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
    alerts.mockReset().mockResolvedValue(undefined);
    await setInventory(1);
  });



  // Acceptance tests for a storage-format validation defect, not a date-policy change.
  it.each(['from', 'to'])('rejects year zero in GET %s before PostgreSQL casting', async (field) => {
    const result = await request(app).get('/api/hotel/availability').query({[field]:'0000-01-01'});
    console.info(JSON.stringify({case:`GET year-zero ${field}`,status:result.status,dbErrors:observedDbErrors}));
    expect(result.status).toBe(400);
    expect(result.body.field).toBe(field);
    expect(observedDbErrors).toEqual([]);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it.each(['from', 'to'])('rejects year zero in POST %s without changing inventory', async (field) => {
    const body = {roomTypeId,from:'0001-01-01',to:'0001-01-01',availableCount:2,pricePerNight:100,[field]:'0000-01-01'};
    // Keep range ordering valid so the individual date validator is exercised.
    if (field === 'to') body.from = '0000-01-01';
    const result = await request(app).post('/api/hotel/availability').send(body);
    console.info(JSON.stringify({case:`POST year-zero ${field}`,status:result.status,dbErrors:observedDbErrors}));
    expect(result.status).toBe(400);
    expect(result.body.field).toBe('from');
    expect(observedDbErrors).toEqual([]);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it.each(['2030-02-30','2029-02-29'])('already rejects impossible date %s at HTTP validation', async (date) => {
    const result=await request(app).post('/api/hotel/availability').send({roomTypeId,from:date,to:date,availableCount:2,pricePerNight:100});
    expect(result.status).toBe(400);
    expect(observedDbErrors).toEqual([]);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it.each(['0001-01-01','0099-12-31','2028-02-29'])('preserves valid PostgreSQL calendar date %s', async (date) => {
    const result=await request(app).post('/api/hotel/availability').send({roomTypeId,from:date,to:date,availableCount:2,pricePerNight:100});
    expect(result.status).toBe(200);
    const read=await request(app).get('/api/hotel/availability').query({from:date,to:date});
    expect(read.status).toBe(200);
    expect(read.body.availability).toHaveLength(1);
    expect((await pool.query('SELECT date::text FROM room_availability WHERE date=$1::date',[date])).rows[0].date).toBe(date);
    expect(observedDbErrors).toEqual([]);
  });

  // Characterizations preserve existing policy. A passing assertion is NOT fix acceptance.
  it.each([
    ['DST gap','2027-03-14','2027-03-15','02:30','2027-03-13T06:30:00.000Z','2027-03-13 01:30'],
    ['DST fold','2027-11-07','2027-11-08','01:30','2027-11-06T05:30:00.000Z','2027-11-06 01:30'],
    ['spring elapsed hours','2027-03-14','2027-03-15','14:00','2027-03-13T18:00:00.000Z','2027-03-13 13:00'],
    ['fall elapsed hours','2027-11-07','2027-11-08','14:00','2027-11-06T19:00:00.000Z','2027-11-06 15:00'],
  ])('characterizes %s through property HTTP, booking, confirmation HTTP and real reminders', async (label,checkIn,checkOut,checkInTime,expectedUtc,expectedLocal) => {
    expect((await request(app).post('/api/hotel/property').send({name:'Synthetic Audit Hotel',timezone:'America/New_York',checkInTime})).status).toBe(200);
    expect((await request(app).post('/api/hotel/availability').send({roomTypeId,from:checkIn,to:checkIn,availableCount:1,pricePerNight:100})).status).toBe(200);
    const held=await scoped(()=>service.createBooking({...draft(),checkIn,checkOut})) as any;
    expect(held.error).toBeUndefined();
    expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({})).status).toBe(200);
    const rows=(await pool.query("SELECT reminder_due_at,metadata FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1 AND metadata->>'bookingReminderKind'='check_in'",[String(held.booking.id)])).rows;
    expect(rows).toHaveLength(1);
    const due=new Date(rows[0].reminder_due_at);
    const localTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(due);
    expect(due.toISOString()).toBe(expectedUtc);
    expect(localTime).toBe(expectedLocal);
    expect(rows[0].metadata.notifyContact).toBe(false);
    console.info(JSON.stringify({case:label,requested:{checkIn,checkInTime},dueUtc:due.toISOString(),dueLocal:localTime}));
  });

  it('characterizes invalid and ambiguous helper input without claiming HTTP reaches impossible dates', () => {
    expect(zonedDateTimeToUtc('2030-02-30','14:00','UTC')?.toISOString()).toBe('2030-03-02T14:00:00.000Z');
    expect(zonedDateTimeToUtc('0001-01-01','14:00','UTC')?.toISOString()).toBe('1901-01-01T14:00:00.000Z');
    expect(zonedDateTimeToUtc('2027-11-07','01:30','America/New_York')?.toISOString()).toBe('2027-11-07T05:30:00.000Z');
    expect(zonedDateTimeToUtc('2027-10-31','02:30','Europe/Berlin')?.toISOString()).toBe('2027-10-31T01:30:00.000Z');
  });

  it('characterizes receipt-free confirmation as paid but without payment-capture evidence, with CRM rather than hotel follow-up rows', async () => {
    const held=await scoped(()=>service.createBooking(draft())) as any;
    expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({})).status).toBe(200);
    const booking=(await pool.query('SELECT status,payment_status,payment_id FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
    expect(booking).toEqual({status:'confirmed',payment_status:'paid',payment_id:null});
    expect((await pool.query("SELECT kind FROM sales_outcome_events WHERE booking_id=$1 AND kind='payment_captured'",[held.booking.id])).rows).toHaveLength(0);
    expect((await pool.query("SELECT id FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1",[String(held.booking.id)])).rows).toHaveLength(2);
    expect((await pool.query('SELECT id FROM hotel_follow_ups WHERE user_id=$1',[owner])).rows).toHaveLength(0);
    const list=await request(app).get('/api/hotel/follow-ups');
    expect(list.status).toBe(200);
    expect(list.body.followUps).toEqual([]);
  });

  it('rejects malformed supplied receipts at HTTP validation and zero-priced drafts before a hold', async () => {
    expect(await scoped(()=>service.createBooking({...draft(),agreedPricePerNight:0}))).toHaveProperty('error');
    expect((await pool.query('SELECT id FROM bookings WHERE user_id=$1',[owner])).rows).toHaveLength(0);
    const held=await scoped(()=>service.createBooking(draft())) as any;
    expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({receipt:{amount:0,currency:'INR',reference:'synthetic'}})).status).toBe(400);
    expect((await pool.query('SELECT status FROM bookings WHERE id=$1',[held.booking.id])).rows[0].status).toBe('pending_payment');
    expect((await pool.query('SELECT id FROM crm_activity_reminders WHERE user_id=$1',[owner])).rows).toHaveLength(0);
  });

  it('withdraws the blanket no-payment auto-confirm concern: stable external-booking mode prevents a hold', async () => {
    await pool.query('UPDATE api_credentials SET config=$1 WHERE user_id=$2',[JSON.stringify({paymentMethodsEnabled:false,provider:'mock',methods:{}}),owner]);
    expect(await scoped(()=>service.createBooking(draft()))).toMatchObject({code:'external_booking_required'});
    expect((await pool.query('SELECT id FROM bookings WHERE user_id=$1',[owner])).rows).toHaveLength(0);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it.each(['empty methods','missing configuration'])('characterizes %s as receipt-free integrated confirmation, distinct from external mode', async (mode) => {
    if (mode === 'missing configuration') await pool.query('DELETE FROM api_credentials WHERE user_id=$1',[owner]);
    else await pool.query('UPDATE api_credentials SET config=$1 WHERE user_id=$2',[JSON.stringify({paymentMethodsEnabled:true,methods:{}}),owner]);
    const result=await scoped(()=>service.createBooking(draft()));
    expect(result).toHaveProperty('booking');
    if (!('booking' in result)) throw new Error(result.error);
    expect(result.booking).toMatchObject({status:'confirmed',paymentStatus:'paid',totalPrice:200});
    expect((await pool.query("SELECT id FROM sales_outcome_events WHERE booking_id=$1 AND kind='payment_captured'",[result.booking.id])).rows).toHaveLength(0);
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
  });

  it('characterizes signed late capture and replay: expired/refund_pending marker, no captured ledger, no double release', async () => {
    const held=await scoped(()=>service.createBooking(draft())) as any;
    await configureCapture(held.booking.id);
    await pool.query("UPDATE bookings SET hold_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[held.booking.id]);
    expect((await postCapture()).status).toBe(409);
    expect((await postCapture()).status).toBe(409);
    const booking=(await pool.query('SELECT status,payment_status,payment_id,metadata,inventory_released_at FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
    expect(booking).toMatchObject({status:'expired',payment_status:'refund_pending',payment_id:'pay_held_contract'});
    expect(booking.metadata.latePaymentReceivedAt).toBeDefined();
    expect(booking.inventory_released_at).not.toBeNull();
    expect((await pool.query("SELECT id FROM sales_outcome_events WHERE booking_id=$1 AND kind='payment_captured'",[held.booking.id])).rows).toHaveLength(0);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
    expect(alerts).not.toHaveBeenCalled();
  });

  it.each([[20001,'INR'],[20000,'USD']])('characterizes signed mismatched capture %s %s: rejection without reconciliation marker', async (amount,currency) => {
    const held=await scoped(()=>service.createBooking(draft())) as any;
    await configureCapture(held.booking.id);
    expect((await postCapture(amount as number,currency as string)).status).toBe(400);
    const booking=(await pool.query('SELECT status,payment_status,payment_id,metadata FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
    expect(booking).toMatchObject({status:'pending_payment',payment_status:'pending',payment_id:null});
    expect(booking.metadata.latePaymentReceivedAt).toBeUndefined();
    expect((await pool.query("SELECT id FROM sales_outcome_events WHERE booking_id=$1 AND kind='payment_captured'",[held.booking.id])).rows).toHaveLength(0);
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
    expect(alerts).not.toHaveBeenCalled();
  });

  it('characterizes a different attached capture ID without altering the existing identity or ledger', async () => {
    const held=await scoped(()=>service.createBooking(draft())) as any;
    await configureCapture(held.booking.id);
    await pool.query("UPDATE bookings SET payment_id='pay_existing_identity' WHERE id=$1",[held.booking.id]);
    expect((await postCapture()).status).toBe(409);
    expect((await pool.query('SELECT status,payment_id,payment_status FROM bookings WHERE id=$1',[held.booking.id])).rows[0]).toEqual({status:'pending_payment',payment_id:'pay_existing_identity',payment_status:'pending'});
    expect((await pool.query('SELECT id FROM sales_outcome_events WHERE booking_id=$1',[held.booking.id])).rows).toHaveLength(0);
    expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
  });

  it('characterizes unavailable negotiation as approved static pricing while booking still enforces actual inventory', async () => {
    await pool.query('UPDATE room_availability SET available_count=0');
    const deal=await scoped(()=>new NegotiationEngine().buildDeal(owner,roomTypeId,{round:0,checkIn:'2030-01-01',checkOut:'2030-01-03',guests:1,rooms:1}));
    expect(deal).toMatchObject({approved:true,basePrice:100,floorPrice:80,offerPrice:100});
    expect(await scoped(()=>service.createBooking(draft()))).toHaveProperty('error');
    expect((await pool.query('SELECT id FROM bookings WHERE user_id=$1',[owner])).rows).toHaveLength(0);
  });

  it('characterizes an isolated availability-read failure: static approved quote, then real booking floor rejects it', async () => {
    await pool.query('UPDATE room_availability SET price_per_night=200');
    const live=await scoped(()=>new NegotiationEngine().buildDeal(owner,roomTypeId,{round:0,checkIn:'2030-01-01',checkOut:'2030-01-03'}));
    expect(live).toMatchObject({basePrice:200,floorPrice:160,offerPrice:200});
    const lookup=jest.spyOn(getAvailabilityProvider(),'searchAvailability').mockRejectedValueOnce(new Error('Synthetic availability lookup outage'));
    const fallback=await scoped(()=>new NegotiationSubAgent().execute('quote_or_negotiate_price',{room_type_id:roomTypeId},{
      userId:owner,slots:{checkIn:'2030-01-01',checkOut:'2030-01-03'},memory:{},
    } as any));
    expect(fallback.toolResults?.[0].result).toMatchObject({approved:true,base_price:100,floor_price:80,offer_price_per_night:100});
    expect(fallback.slotsUpdate).toMatchObject({agreedPricePerNight:100,priceQuoteRoomTypeId:roomTypeId});
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockRestore();
    const result=await scoped(()=>service.createBooking(draft()));
    expect(result).toHaveProperty('error');
    expect((await pool.query('SELECT id FROM bookings WHERE user_id=$1',[owner])).rows).toHaveLength(0);
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });
});
