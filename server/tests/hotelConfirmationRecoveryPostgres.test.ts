/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic HTTP and Drizzle fixture boundaries. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Opt in against a NEW disposable database after running the real migrations.
// Never read dotenv or reuse the saved environment's application database.
const enabled = process.env.HOTEL_LOCAL_QA === '1';
const local = enabled ? describe : describe.skip;
let runtime: ReturnType<typeof drizzle>;
let pauseReminderInsert: (() => Promise<void>) | undefined;
let loseAcknowledgementForKind: string | undefined;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, key) => {
    if (key === 'insert' && (pauseReminderInsert || loseAcknowledgementForKind)) return (table: any) => ({ values: (values: any) => {
      const insertion = (runtime as any).insert(table).values(values);
      return { onConflictDoNothing: async () => {
        const pause = pauseReminderInsert; pauseReminderInsert = undefined;
        await pause?.();
        const result = await insertion.onConflictDoNothing();
        if (loseAcknowledgementForKind === values.metadata?.bookingReminderKind) {
          loseAcknowledgementForKind = undefined;
          throw new Error('Synthetic lost reminder acknowledgement');
        }
        return result;
      } };
    } });
    return (runtime as any)[key].bind(runtime);
  },
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

const owner = 41001;
const profile = 41001;
const scoped = <T>(work: () => T, businessProfileId = profile) => withBusinessScope({ userId: owner, businessProfileId }, work);
function response() {
  const res: any = { code: 200 };
  res.status = (code: number) => { res.code = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

local('hotel confirmation recovery with actual reminder persistence', () => {
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
    app.post('/api/hotel/bookings/:id/recovery', payments.retryBookingConfirmationSetup);
    app.put('/api/hotel/bookings/:id/cancel', payments.cancelBooking);
    global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('External providers are disabled in hotel audit'));
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    pauseReminderInsert = undefined;
    loseAcknowledgementForKind = undefined;
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


  it('replays actual partial reminder persistence without repeating accepted or uncertain work', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query(`CREATE OR REPLACE FUNCTION hotel_audit_reject_checkout() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'Synthetic checkout reminder failure'; END $$;
      CREATE TRIGGER hotel_audit_reject_checkout BEFORE INSERT ON crm_activity_reminders FOR EACH ROW
      WHEN (NEW.metadata->>'bookingReminderKind'='check_out') EXECUTE FUNCTION hotel_audit_reject_checkout()`);
    try {
      expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({})).status).toBe(200);
      const first = (await pool.query('SELECT side_effects_processed_at,metadata FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
      expect(first.side_effects_processed_at).toBeNull();
      expect(first.metadata.hotelConfirmationRecovery).toMatchObject({contactReady:true,lastFailedStep:'reminders',claimToken:null});
      expect(first.metadata.hotelConfirmationRecovery.remindersReady).not.toBe(true);
      expect(alerts).not.toHaveBeenCalled();
      const inserted = await pool.query("SELECT id FROM crm_activity_reminders WHERE user_id=$1 AND metadata->>'bookingId'=$2",[owner,String(held.booking.id)]);
      expect(inserted.rows).toHaveLength(1);
      // Preserve an existing uncertain delivery claim while filling the missing
      // checkout row. The scheduling helper must never re-deliver this claim.
      await pool.query("UPDATE crm_activity_reminders SET last_sent_at=NOW(),metadata=metadata||'{\"deliveryOutcome\":\"uncertain\"}'::jsonb WHERE id=$1",[inserted.rows[0].id]);
      const before = (await pool.query('SELECT * FROM crm_activity_reminders WHERE id=$1',[inserted.rows[0].id])).rows[0];
      await pool.query('DROP TRIGGER hotel_audit_reject_checkout ON crm_activity_reminders; DROP FUNCTION hotel_audit_reject_checkout()');
      expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({})).status).toBe(200);
      expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({})).status).toBe(200);
      expect((await pool.query('SELECT * FROM crm_activity_reminders WHERE id=$1',[inserted.rows[0].id])).rows[0]).toEqual(before);
      expect((await pool.query("SELECT id FROM crm_activity_reminders WHERE user_id=$1 AND metadata->>'bookingId'=$2",[owner,String(held.booking.id)])).rows).toHaveLength(2);
      const recovered = (await pool.query('SELECT side_effects_processed_at,metadata FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
      expect(recovered.side_effects_processed_at).not.toBeNull();
      expect(recovered.metadata.hotelConfirmationRecovery).toMatchObject({remindersReady:true,alertDispatch:'returned',claimToken:null});
      expect(alerts).toHaveBeenCalledTimes(1);
      expect(await counts()).toEqual([{available_count:0,total_count:1},{available_count:0,total_count:1}]);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS hotel_audit_reject_checkout ON crm_activity_reminders; DROP FUNCTION IF EXISTS hotel_audit_reject_checkout()');
    }
  });

  it('serializes concurrent replay scheduling and dispatches the alert once', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await Promise.all([1,2,3,4].map(() => scoped(() => service.confirmBookingById(held.booking.id,owner))));
    expect((await pool.query("SELECT id FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1",[String(held.booking.id)])).rows).toHaveLength(2);
    expect(alerts).toHaveBeenCalledTimes(1);
    const state = (await pool.query('SELECT side_effects_processed_at FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
    expect(state.side_effects_processed_at).not.toBeNull();
  });

  it('retains an uncertain alert outcome and never blindly dispatches it again', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    alerts.mockRejectedValueOnce(new Error('Synthetic lost alert acknowledgement'));
    await scoped(() => service.confirmBookingById(held.booking.id,owner));
    await scoped(() => service.confirmBookingById(held.booking.id,owner));
    expect(alerts).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT id FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1",[String(held.booking.id)])).rows).toHaveLength(2);
    const state = (await pool.query('SELECT side_effects_processed_at,metadata FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
    expect(state.side_effects_processed_at).toBeNull();
    expect(state.metadata.hotelConfirmationRecovery).toMatchObject({remindersReady:true,alertDispatch:'uncertain',lastFailedStep:'alert_reconciliation',claimToken:null});
  });

  it('recovers legacy reminder state without guessing that its old alert should repeat', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query("UPDATE bookings SET status='confirmed',payment_status='paid',side_effects_processed_at=NOW() WHERE id=$1",[held.booking.id]);
    await scoped(() => service.confirmBookingById(held.booking.id,owner));
    expect((await pool.query("SELECT id FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1",[String(held.booking.id)])).rows).toHaveLength(2);
    expect(alerts).not.toHaveBeenCalled();
    const state = (await pool.query('SELECT metadata FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
    expect(state.metadata.hotelConfirmationRecovery).toMatchObject({remindersReady:true,alertDispatch:'uncertain'});
  });

  it('cancels reminders inserted by a helper that finishes after concurrent booking cancellation', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    pauseReminderInsert = async () => { entered(); await waiting; };
    const confirming = scoped(() => service.confirmBookingById(held.booking.id,owner));
    await started;
    try { await scoped(() => service.cancelBookingById(held.booking.id,owner,'Synthetic concurrent cancellation')); }
    finally { release(); }
    await confirming;
    expect((await scoped(() => service.getById(held.booking.id,owner)))?.status).toBe('cancelled');
    const reminders = await pool.query("SELECT status FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1",[String(held.booking.id)]);
    expect(reminders.rows).toHaveLength(2);
    expect(reminders.rows.every(row => row.status === 'cancelled')).toBe(true);
    expect(alerts).not.toHaveBeenCalled();
    expect(await counts()).toEqual([{available_count:1,total_count:1},{available_count:1,total_count:1}]);
  });

  it('takes over an expired lease and retains a started alert as uncertain', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query("UPDATE bookings SET status='confirmed',payment_status='paid',metadata=$1 WHERE id=$2",[
      JSON.stringify({hotelConfirmationRecovery:{version:1,claimToken:'synthetic_crashed_worker',claimExpiresAtMs:1,contactReady:true,alertDispatch:'started'}}),held.booking.id]);
    await scoped(() => service.confirmBookingById(held.booking.id,owner));
    expect(alerts).not.toHaveBeenCalled();
    const recovery = (await pool.query('SELECT metadata FROM bookings WHERE id=$1',[held.booking.id])).rows[0].metadata.hotelConfirmationRecovery;
    expect(recovery).toMatchObject({remindersReady:true,alertDispatch:'uncertain',claimToken:null});
  });

  it('recovers a lost reminder acknowledgement without altering either persisted reminder', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    loseAcknowledgementForKind = 'check_out';
    await scoped(() => service.confirmBookingById(held.booking.id,owner));
    const before = (await pool.query("SELECT * FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1 ORDER BY id",[String(held.booking.id)])).rows;
    expect(before).toHaveLength(2);
    expect(alerts).not.toHaveBeenCalled();
    await scoped(() => service.confirmBookingById(held.booking.id,owner));
    expect((await pool.query("SELECT * FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1 ORDER BY id",[String(held.booking.id)])).rows).toEqual(before);
    expect(alerts).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT side_effects_processed_at FROM bookings WHERE id=$1',[held.booking.id])).rows[0].side_effects_processed_at).not.toBeNull();
  });

  it('exposes unfinished setup and recovers it without changing financial evidence', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    await pool.query(`CREATE FUNCTION hotel_recovery_ui_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.metadata->>'bookingReminderKind'='check_out' THEN RAISE EXCEPTION 'Synthetic reminder persistence failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER hotel_recovery_ui_failure BEFORE INSERT ON crm_activity_reminders FOR EACH ROW EXECUTE FUNCTION hotel_recovery_ui_failure()`);
    try {
      expect((await request(app).put(`/bookings/${held.booking.id}/confirm`).send({})).status).toBe(200);
      const listed = await request(app).get('/api/hotel/bookings');
      expect(listed.body.bookings[0].confirmation_recovery).toMatchObject({ state: 'pending', canRetry: true, step: 'reminders' });
      const before = (await pool.query('SELECT status,payment_status,payment_id,total_price FROM bookings WHERE id=$1',[held.booking.id])).rows[0];
      const evidenceBefore = (await pool.query('SELECT * FROM sales_outcome_events WHERE booking_id=$1 ORDER BY id',[held.booking.id])).rows;
      await pool.query('DROP TRIGGER hotel_recovery_ui_failure ON crm_activity_reminders; DROP FUNCTION hotel_recovery_ui_failure()');
      const retry = await request(app).post(`/api/hotel/bookings/${held.booking.id}/recovery`).send({});
      expect(retry.status).toBe(200); expect(retry.body.confirmationRecovery).toMatchObject({ state: 'complete', canRetry: false });
      expect((await request(app).post(`/api/hotel/bookings/${held.booking.id}/recovery`).send({})).status).toBe(200);
      expect((await pool.query('SELECT status,payment_status,payment_id,total_price FROM bookings WHERE id=$1',[held.booking.id])).rows[0]).toEqual(before);
      expect((await pool.query('SELECT * FROM sales_outcome_events WHERE booking_id=$1 ORDER BY id',[held.booking.id])).rows).toEqual(evidenceBefore);
      expect((await pool.query("SELECT id FROM crm_activity_reminders WHERE metadata->>'bookingId'=$1",[String(held.booking.id)])).rows).toHaveLength(2);
      expect(alerts).toHaveBeenCalledTimes(1);
    } finally { await pool.query('DROP TRIGGER IF EXISTS hotel_recovery_ui_failure ON crm_activity_reminders; DROP FUNCTION IF EXISTS hotel_recovery_ui_failure()'); }
  });


  it('does not blindly retry uncertain alerts or expose another business recovery state', async () => {
    const held = await scoped(() => service.createBooking(draft())) as any;
    alerts.mockRejectedValueOnce(new Error('Synthetic uncertain alert result'));
    await scoped(() => service.confirmBookingById(held.booking.id, owner));
    const result = await request(app).post(`/api/hotel/bookings/${held.booking.id}/recovery`).send({});
    expect(result.status).toBe(200); expect(result.body.confirmationRecovery).toMatchObject({ state: 'needs_review', canRetry: false, step: 'alert' });
    expect(alerts).toHaveBeenCalledTimes(1);
    const foreign = response();
    await scoped(() => payments.retryBookingConfirmationSetup({ user: { id: owner }, params: { id: String(held.booking.id) } } as any, foreign), 41002);
    expect(foreign.code).toBe(404); expect(alerts).toHaveBeenCalledTimes(1);
    await request(app).post('/api/hotel/availability').send({ roomTypeId, from: '2030-01-05', to: '2030-01-06', availableCount: 1, pricePerNight: 100 });
    const pending = await scoped(() => service.createBooking({ ...draft('Unconfirmed'), checkIn: '2030-01-05', checkOut: '2030-01-07' })) as any;
    expect(pending.booking).toBeDefined();
    expect((await request(app).post(`/api/hotel/bookings/${pending.booking.id}/recovery`).send({})).status).toBe(409);
  });

});
