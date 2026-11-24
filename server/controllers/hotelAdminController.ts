import { businessOwnerUserId, currentBusinessScope } from '../tenancy/businessContext.js';
/**
 * Hotel admin API — manage room types, availability/pricing, and view bookings + escalations.
 * All endpoints are scoped to the authenticated user's hotel property.
 * Mounted under /api/hotel/* (see routes.ts).
 */

import type { Request, Response } from 'express';
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { hotelRagSyncService } from '../services/booking/HotelRagSyncService.js';
import { confirmationRecoveryFor } from '../services/booking/ConfirmationRecovery.js';
import { StorageService } from '../services/StorageService.js';
import { z } from 'zod';
import { DEFAULT_BUSINESS_TIMEZONE, isValidIanaTimezone } from '../utils/timezone.js';
import {
  encodeHotelPaymentSecret,
  getHotelPaymentConfiguration,
  isMockPaymentAllowed,
  safeExternalBookingUrl,
  validateExternalBookingUrlDestination,
} from '../services/booking/PaymentProvider.js';

const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
// Zod's ISO date validator accepts year zero, but PostgreSQL dates do not.
const availabilityDateSchema = z.string().date().refine((value) => !value.startsWith('0000-'), {
  message: 'Use a calendar year from 0001 to 9999.',
});
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const amenitiesSchema = z.array(z.string().trim().min(1).max(100)).max(100);

const propertySchema = z.object({
  name: z.string().trim().min(1).max(255),
  city: optionalText(120),
  country: optionalText(120),
  address: optionalText(500),
  phone: optionalText(40),
  email: z.union([z.string().trim().email().max(255), z.literal(''), z.null()]).optional(),
  description: optionalText(10_000),
  amenities: amenitiesSchema.optional(),
  checkInTime: z.union([timeSchema, z.null()]).optional(),
  checkOutTime: z.union([timeSchema, z.null()]).optional(),
  currency: currencySchema.optional(),
  timezone: z.string().trim().max(64).refine(isValidIanaTimezone).optional(),
}).strict();

const roomTypeBaseSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: optionalText(10_000),
  capacity: z.coerce.number().int().min(1).max(100),
  basePrice: z.coerce.number().positive().max(100_000_000),
  minPrice: z.coerce.number().positive().max(100_000_000),
  maxDiscountPct: z.coerce.number().min(0).max(100),
  amenities: amenitiesSchema.optional(),
}).strict();

const roomTypeCreateSchema = roomTypeBaseSchema.refine((value) => value.minPrice <= value.basePrice, {
  message: 'Minimum price cannot exceed base price.',
  path: ['minPrice'],
});

const roomTypeUpdateSchema = roomTypeBaseSchema.partial().refine(
  (value) => value.basePrice === undefined
    || value.minPrice === undefined
    || value.minPrice <= value.basePrice,
  { message: 'Minimum price cannot exceed base price.', path: ['minPrice'] },
);

const availabilityQuerySchema = z.object({
  from: availabilityDateSchema.optional(),
  to: availabilityDateSchema.optional(),
  roomTypeId: z.coerce.number().int().positive().optional(),
}).refine((value) => !value.from || !value.to || value.to >= value.from, {
  message: 'The end date must be on or after the start date.',
});

const availabilityUpdateSchema = z.object({
  roomTypeId: z.coerce.number().int().positive(),
  from: availabilityDateSchema,
  to: availabilityDateSchema,
  availableCount: z.coerce.number().int().min(0).max(100_000),
  pricePerNight: z.coerce.number().min(0).max(100_000_000),
}).strict().refine((value) => value.to >= value.from, {
  message: 'The end date must be on or after the start date.',
  path: ['to'],
});

const paymentMethodsSchema = z.object({
  online: z.object({ enabled: z.boolean() }).strict().optional(),
  upiQr: z.object({
    enabled: z.boolean(),
    upiId: z.string().trim().max(255).optional(),
    payeeName: z.string().trim().max(255).optional(),
    qrImageUrl: z.string().trim().max(2000).optional(),
  }).strict().optional(),
  bankTransfer: z.object({
    enabled: z.boolean(),
    bankName: z.string().trim().max(255).optional(),
    payeeName: z.string().trim().max(255).optional(),
    accountNumber: z.string().trim().max(100).optional(),
    ifscCode: z.string().trim().toUpperCase().max(30).optional(),
  }).strict().optional(),
  customLink: z.object({
    enabled: z.boolean(),
    url: z.string().trim().max(2000).optional(),
    linkTitle: z.string().trim().max(255).optional(),
  }).strict().optional(),
  manual: z.object({
    enabled: z.boolean(),
    instructions: z.string().trim().max(2000).optional(),
  }).strict().optional(),
}).strict();

const paymentSettingsSchema = z.object({
  paymentMethodsEnabled: z.boolean().optional(),
  externalBooking: z.object({
    url: z.string().trim().max(2000).optional(),
    linkTitle: z.string().trim().max(255).optional(),
  }).strict().optional(),
  provider: z.enum(['mock', 'razorpay']),
  keyId: z.string().trim().max(255).optional(),
  keySecret: z.string().max(1000).optional(),
  webhookSecret: z.string().max(1000).optional(),
  methods: paymentMethodsSchema,
}).strict();

function validationError(res: Response, result: { error: z.ZodError }) {
  return res.status(400).json({
    error: result.error.issues[0]?.message || 'Invalid request.',
    field: result.error.issues[0]?.path.join('.') || undefined,
  });
}

function uid(req: Request): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return businessOwnerUserId(req) ?? null;
}

/** Return the user's hotel property id (the first one), or null. */
async function hotelIdFor(userId: number): Promise<number | null> {
  const r = await db.execute(sql`SELECT id FROM hotel_properties WHERE user_id = ${userId} ORDER BY id ASC LIMIT 1`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (r.rows as any[])[0]?.id ?? null;
}

// ── Property ──────────────────────────────────────────────────────────────────
/** Aggregate all bookings without loading guest/payment detail for hidden tabs. */
export async function getHotelSummary(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await db.execute(sql`
      WITH property AS (
        SELECT id, currency FROM hotel_properties WHERE user_id = ${userId} ORDER BY id ASC LIMIT 1
      ), booking_summary AS (
        SELECT COUNT(*)::integer AS total, COUNT(*) FILTER (WHERE status = 'confirmed')::integer AS confirmed
        FROM bookings WHERE user_id = ${userId}
      ), revenue AS (
        SELECT COALESCE(NULLIF(UPPER(BTRIM(currency)), ''), 'UNKNOWN') AS currency,
               SUM(total_price) AS total
        FROM bookings WHERE user_id = ${userId} AND status = 'confirmed'
        GROUP BY COALESCE(NULLIF(UPPER(BTRIM(currency)), ''), 'UNKNOWN')
      )
      SELECT (SELECT COUNT(*)::integer FROM room_types JOIN property ON property.id = room_types.hotel_id) AS "totalRoomTypes",
             total AS "totalBookings", confirmed AS "confirmedBookings",
             COALESCE((SELECT jsonb_object_agg(currency, total) FROM revenue), '{}'::jsonb) AS "revenueByCurrency"
      FROM booking_summary
    `);
    res.json(result.rows[0]);
  } catch (error) {
    logger.error({ err: error, userId }, '[hotelAdmin] getHotelSummary failed');
    res.status(500).json({ error: 'Failed to load hotel summary.' });
  }
}

export async function getHotelProperty(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const scope = currentBusinessScope();
  const r = await db.execute(sql`SELECT * FROM hotel_properties WHERE user_id = ${userId}
    ${scope ? sql`AND business_profile_id = ${scope.businessProfileId}` : sql``} ORDER BY id ASC`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.json({ success: true, property: (r.rows as any[])[0] || null,
    properties: (r.rows as Array<{ id: number; name: string }>).map(({ id, name }) => ({ id, name })) });
}

export async function saveHotelProperty(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = propertySchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const {
    name, city, country, address, phone, email, description, amenities,
    checkInTime, checkOutTime, currency, timezone,
  } = parsed.data;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const property = await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId}, 132)`);
      const existing = await tx.execute(sql`
        SELECT * FROM hotel_properties
        WHERE user_id = ${userId}
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `);
      if (existing.rows.length > 0) {
        const current = existing.rows[0] as Record<string, unknown>;
        const updated = await tx.execute(sql`
          UPDATE hotel_properties SET
            name = ${name},
            city = ${city === undefined ? current.city : city || null},
            country = ${country === undefined ? current.country : country || null},
            address = ${address === undefined ? current.address : address || null},
            phone = ${phone === undefined ? current.phone : phone || null},
            email = ${email === undefined ? current.email : email || null},
            description = ${description === undefined ? current.description : description || null},
            amenities = ${JSON.stringify(amenities === undefined ? current.amenities || [] : amenities)}::jsonb,
            check_in_time = ${checkInTime === undefined ? current.check_in_time : checkInTime || null},
            check_out_time = ${checkOutTime === undefined ? current.check_out_time : checkOutTime || null},
            currency = ${currency === undefined ? current.currency : currency},
            timezone = ${timezone === undefined ? current.timezone : timezone},
            updated_at = NOW()
          WHERE id = ${Number(current.id)} AND user_id = ${userId}
          RETURNING *
        `);
        return updated.rows[0];
      }

      const inserted = await tx.execute(sql`
        INSERT INTO hotel_properties (
          user_id, name, city, country, address, phone, email, description,
          amenities, check_in_time, check_out_time, currency, timezone
        )
        VALUES (
          ${userId}, ${name}, ${city || null}, ${country || null}, ${address || null},
          ${phone || null}, ${email || null}, ${description || null},
          ${JSON.stringify(amenities || [])}::jsonb, ${checkInTime || '14:00'},
          ${checkOutTime || '11:00'}, ${currency || 'INR'}, ${timezone || DEFAULT_BUSINESS_TIMEZONE}
        )
        RETURNING *
      `);
      return inserted.rows[0];
    });
    res.json({ success: true, property });
  } catch (error) {
    logger.error({ err: error, userId }, '[hotelAdmin] saveHotelProperty failed');
    res.status(500).json({ error: 'Failed to save hotel property.' });
  }
}

// ── Room types ────────────────────────────────────────────────────────────────
export async function listRoomTypes(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const hotelId = await hotelIdFor(userId);
  if (!hotelId) return res.json({ success: true, roomTypes: [] });
  const r = await db.execute(sql`SELECT * FROM room_types WHERE hotel_id = ${hotelId} ORDER BY base_price ASC`);
  res.json({ success: true, roomTypes: r.rows });
}

export async function createRoomType(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const hotelId = await hotelIdFor(userId);
  if (!hotelId) return res.status(400).json({ error: 'No hotel property configured for this account.' });
  const parsed = roomTypeCreateSchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const { name, description, capacity, basePrice, minPrice, maxDiscountPct, amenities } = parsed.data;
  const r = await db.execute(sql`
    INSERT INTO room_types (hotel_id, name, description, capacity, base_price, min_price, max_discount_pct, amenities)
    VALUES (${hotelId}, ${name}, ${description || null}, ${capacity}, ${basePrice}, ${minPrice}, ${maxDiscountPct}, ${JSON.stringify(amenities || [])}::jsonb)
    RETURNING *`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roomType = (r.rows as any[])[0];
  res.json({ success: true, roomType });
}

export async function updateRoomType(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const hotelId = await hotelIdFor(userId);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid room type ID.' });
  const parsed = roomTypeUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const { name, description, capacity, basePrice, minPrice, maxDiscountPct, amenities } = parsed.data;
  const result = await db.transaction(async (tx: typeof db) => {
    const currentRows = await tx.execute(sql`
      SELECT base_price, min_price
      FROM room_types
      WHERE id = ${id} AND hotel_id = ${hotelId}
      LIMIT 1
      FOR UPDATE
    `);
    const current = currentRows.rows[0] as Record<string, unknown> | undefined;
    if (!current) return { status: 404, error: 'Room type not found' };
    const finalBase = basePrice ?? Number(current.base_price);
    const finalMinimum = minPrice ?? Number(current.min_price);
    if (finalMinimum > finalBase) {
      return { status: 400, error: 'Minimum price cannot exceed base price.', field: 'minPrice' };
    }
    const r = await tx.execute(sql`
      UPDATE room_types SET
        name = COALESCE(${name ?? null}, name),
        description = COALESCE(${description ?? null}, description),
        capacity = COALESCE(${capacity != null ? Number(capacity) : null}, capacity),
        base_price = COALESCE(${basePrice != null ? Number(basePrice) : null}, base_price),
        min_price = COALESCE(${minPrice != null ? Number(minPrice) : null}, min_price),
        max_discount_pct = COALESCE(${maxDiscountPct != null ? Number(maxDiscountPct) : null}, max_discount_pct),
        amenities = COALESCE(${amenities != null ? JSON.stringify(amenities) : null}::jsonb, amenities),
        updated_at = NOW()
      WHERE id = ${id} AND hotel_id = ${hotelId}
      RETURNING *`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((r.rows as any[]).length === 0) return { status: 404, error: 'Room type not found' };
    return { roomType: r.rows[0] };
  });
  if (result.status) return res.status(result.status).json({ error: result.error, field: result.field });
  const roomType = result.roomType;
  hotelRagSyncService.deleteRoomTypeFromRag(userId, Number(roomType.id)).catch((err) => {
    logger.warn({ err, roomTypeId: roomType.id }, '[hotelAdminController] Failed to clean legacy room type from RAG');
  });
  res.json({ success: true, roomType });
}

export async function deleteRoomType(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const hotelId = await hotelIdFor(userId);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid room type ID.' });
  const bookingRows = await db.execute(sql`
    SELECT COUNT(*)::integer AS count
    FROM bookings
    WHERE room_type_id = ${id} AND user_id = ${userId}
  `);
  if (Number((bookingRows.rows[0] as { count?: number })?.count || 0) > 0) {
    return res.status(409).json({
      error: 'This room type has booking history and cannot be deleted. Rename it or stop adding future availability instead.',
    });
  }
  const deleted = await db.execute(sql`
    DELETE FROM room_types WHERE id = ${id} AND hotel_id = ${hotelId} RETURNING id
  `);
  if (deleted.rows.length === 0) return res.status(404).json({ error: 'Room type not found' });
  hotelRagSyncService.deleteRoomTypeFromRag(userId, id).catch((err) => {
    logger.warn({ err, roomTypeId: id }, '[hotelAdminController] Failed to delete room type from RAG');
  });
  res.json({ success: true });
}

// ── Availability ────────────────────────────────────────────────────────────────
export async function getAvailability(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const hotelId = await hotelIdFor(userId);
  if (!hotelId) return res.json({ success: true, availability: [] });
  const parsed = availabilityQuerySchema.safeParse({
    from: req.query.from || undefined,
    to: req.query.to || undefined,
    roomTypeId: req.query.roomTypeId || undefined,
  });
  if (!parsed.success) return validationError(res, parsed);
  const { from, to, roomTypeId } = parsed.data;
  const r = await db.execute(sql`
    SELECT
      ra.id,
      ra.room_type_id,
      rt.name AS room_type,
      ra.date,
      ra.available_count,
      ra.total_count,
      (ra.total_count - ra.available_count) AS reserved_count,
      ra.price_per_night
    FROM room_availability ra
    JOIN room_types rt ON rt.id = ra.room_type_id
    WHERE rt.hotel_id = ${hotelId}
      ${from ? sql`AND ra.date >= ${from}::date` : sql``}
      ${to ? sql`AND ra.date <= ${to}::date` : sql``}
      ${roomTypeId ? sql`AND ra.room_type_id = ${roomTypeId}` : sql``}
    ORDER BY ra.date ASC, rt.name ASC
    LIMIT 1000`);
  res.json({ success: true, availability: r.rows });
}

/** Bulk-set availability + price for a room type across a date range (inclusive). */
export async function setAvailability(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const hotelId = await hotelIdFor(userId);
  if (!hotelId) return res.status(400).json({ error: 'Configure a hotel property first.' });
  const parsed = availabilityUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const { roomTypeId, from, to, availableCount, pricePerNight } = parsed.data;
  // Verify the room type belongs to this hotel.
  const own = await db.execute(sql`SELECT 1 FROM room_types WHERE id = ${roomTypeId} AND hotel_id = ${hotelId}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((own.rows as any[]).length === 0) return res.status(404).json({ error: 'Room type not found' });

  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  const days = Math.floor((end.getTime() - start.getTime()) / 864e5);
  if (days < 0 || days > 730) return res.status(400).json({ error: 'Invalid date range (max 2 years).' });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.transaction(async (tx: any) => {
      // Booking creation takes this room lock before locking its nightly stock.
      // Lock before taking the occupancy snapshot so a concurrent hold cannot
      // be overwritten by a recalculation based on the previous booking state.
      await tx.execute(sql`SELECT id FROM room_types WHERE id = ${roomTypeId} AND hotel_id = ${hotelId} FOR UPDATE`);
      // Releases lock the nightly rows too. Read occupancy in a later statement
      // after those releases commit, including stock left by expired holds.
      await tx.execute(sql`
        SELECT id FROM room_availability
        WHERE room_type_id = ${roomTypeId} AND date >= ${from}::date AND date <= ${to}::date
        ORDER BY date FOR UPDATE
      `);
      const result = await tx.execute(sql`
        WITH dates AS (
          SELECT generated::date AS date
          FROM generate_series(${from}::date, ${to}::date, INTERVAL '1 day') generated
        ),
        occupied AS (
          SELECT
            dates.date,
            COALESCE(SUM(b.number_of_rooms) FILTER (
              WHERE b.status = 'confirmed'
                OR (
                  b.status = 'pending_payment'
                  AND b.inventory_reserved_at IS NOT NULL
                  AND b.inventory_released_at IS NULL
                )
            ), 0)::integer AS rooms
          FROM dates
          LEFT JOIN bookings b
            ON b.room_type_id = ${roomTypeId}
           AND b.check_in_date <= dates.date
           AND b.check_out_date > dates.date
          GROUP BY dates.date
        ),
        input AS (
          SELECT
            ${roomTypeId}::integer AS room_type_id,
            date,
            ${availableCount}::integer AS total_count,
            (${availableCount}::integer - rooms)::integer AS available_count,
            ${pricePerNight}::numeric AS price_per_night
          FROM occupied
        )
        INSERT INTO room_availability (
          room_type_id, date, total_count, available_count, price_per_night
        )
        SELECT room_type_id, date, total_count, available_count, price_per_night
        FROM input
        WHERE available_count >= 0
        ON CONFLICT (room_type_id, date) DO UPDATE SET
          total_count = EXCLUDED.total_count,
          available_count = EXCLUDED.available_count,
          price_per_night = EXCLUDED.price_per_night,
          updated_at = NOW()
        RETURNING date
      `);
      if (result.rows.length !== days + 1) {
        throw new Error('INVENTORY_BELOW_RESERVED');
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVENTORY_BELOW_RESERVED') {
      return res.status(409).json({
        error: 'Total inventory cannot be lower than rooms already held or confirmed in this date range.',
      });
    }
    throw error;
  }
  res.json({ success: true, daysUpdated: days + 1 });
}

// ── Bookings ──────────────────────────────────────────────────────────────────
export async function listBookings(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const r = await db.execute(sql`
    SELECT b.id, b.guest_name, b.guest_phone, b.check_in_date, b.check_out_date, b.nights,
           b.number_of_guests, b.number_of_rooms, b.total_price, b.currency, b.status, b.payment_status,
           b.payment_provider, b.payment_link, b.hold_expires_at, b.confirmed_at, b.cancelled_at,
           b.cancellation_reason, b.created_at, rt.name AS room_type,
           b.metadata AS recovery_metadata, b.side_effects_processed_at,
           (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS recovery_clock_ms
    FROM bookings b
    LEFT JOIN room_types rt ON rt.id = b.room_type_id
    WHERE b.user_id = ${userId}
    ORDER BY b.created_at DESC LIMIT 200`);
  const bookings = (r.rows as Array<Record<string, unknown>>).map(({ recovery_metadata, recovery_clock_ms, side_effects_processed_at, ...booking }) => ({
    ...booking,
    confirmation_recovery: confirmationRecoveryFor({ ...booking, metadata: recovery_metadata, side_effects_processed_at }, Number(recovery_clock_ms)),
  }));
  res.json({ success: true, bookings });
}

// ── Escalations (agent-created tickets) ─────────────────────────────────────────
export async function listEscalations(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const r = await db.execute(sql`
    SELECT id, ticket_number, subject, description, category, priority, status, assigned_to, created_at
    FROM support_tickets
    WHERE user_id = ${userId} AND tags @> '["agent_escalation"]'::jsonb
    ORDER BY created_at DESC LIMIT 200`);
  res.json({ success: true, escalations: r.rows });
}

// ── Leads + sales intelligence (memory, score, booking probability, intent) ──────
export async function listLeadIntel(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const r = await db.execute(sql`
    SELECT l.id, l.name, l.phone, l.score, l.sales_memory,
           oc.id AS conversation_id, oc.status AS conversation_status, oc.updated_at,
           oc.metadata->'leadIntelligence' AS intelligence,
           oc.metadata->'nlu'->>'intent'   AS last_intent,
           oc.metadata->'nlu'->>'summary'  AS last_summary
    FROM leads l
    JOIN outreach_conversations oc ON oc.lead_id = l.id AND oc.channel = 'whatsapp' AND oc.user_id = ${userId}
    WHERE l.source = 'whatsapp'
    ORDER BY l.score DESC NULLS LAST, oc.updated_at DESC NULLS LAST
    LIMIT 200`);
  res.json({ success: true, leads: r.rows });
}

// ── Proactive follow-ups (scheduled / sent / cancelled nudges) ───────────────────
export async function listFollowUps(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const r = await db.execute(sql`
    SELECT f.id, f.type, f.status, f.attempt, f.max_attempts, f.due_at, f.sent_at,
           f.last_message, f.cancel_reason, f.created_at,
           f.context->>'name' AS name, f.context->>'room' AS room,
           l.name AS lead_name, COALESCE(l.phone, f.recipient_phone) AS phone
    FROM hotel_follow_ups f
    LEFT JOIN leads l ON l.id = f.lead_id
    WHERE f.user_id = ${userId}
    ORDER BY f.created_at DESC LIMIT 200`);
  res.json({ success: true, followUps: r.rows });
}

// ── Payment Settings ──────────────────────────────────────────────────────────
export async function getPaymentSettings(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const config = await getHotelPaymentConfiguration(userId);
    res.json({
      success: true,
      settings: {
        configured: config.configured,
        paymentMethodsEnabled: config.paymentMethodsEnabled,
        externalBooking: config.externalBooking,
        provider: config.provider || 'razorpay',
        keyId: config.keyId || '',
        hasSecret: !!config.keySecret,
        hasWebhookSecret: !!config.webhookSecret,
        allowMock: isMockPaymentAllowed(),
        methods: config.methods,
      }
    });
  } catch (err) {
    logger.error({ err, userId }, '[hotelAdmin] getPaymentSettings failed');
    res.status(500).json({ error: 'Unable to load payment settings.' });
  }
}

export async function savePaymentSettings(req: Request, res: Response) {
  const userId = uid(req); if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  // Record ownership is not permission to change payment routing or provider
  // secrets. Match the existing owner/billing-admin connection authority.
  const scope = currentBusinessScope();
  if (req.user?.id !== userId && scope?.role !== 'billing_admin') {
    return res.status(403).json({
      code: 'BUSINESS_MANAGER_REQUIRED',
      error: 'Ask the business owner or billing admin to manage payment settings.',
    });
  }
  const parsed = paymentSettingsSchema.safeParse(req.body || {});
  if (!parsed.success) return validationError(res, parsed);
  const { provider, keyId, keySecret, webhookSecret, methods, externalBooking } = parsed.data;
  
  try {
    const existingResolved = await getHotelPaymentConfiguration(userId);
    const paymentMethodsEnabled = parsed.data.paymentMethodsEnabled
      ?? existingResolved.paymentMethodsEnabled;
    const finalKeyId = keyId || existingResolved.keyId || null;
    const finalKeySecret = keySecret || existingResolved.keySecret || null;
    const finalWebhookSecret = webhookSecret || existingResolved.webhookSecret || null;
    const requestedExternalUrl = externalBooking?.url ?? existingResolved.externalBooking.url;
    const syntacticallySafeExternalUrl = safeExternalBookingUrl(requestedExternalUrl);
    const externalUrl = paymentMethodsEnabled
      ? syntacticallySafeExternalUrl
      : await validateExternalBookingUrlDestination(requestedExternalUrl);
    const externalLinkTitle = (externalBooking?.linkTitle
      ?? existingResolved.externalBooking.linkTitle
      ?? 'Continue your booking').trim().slice(0, 255) || 'Continue your booking';

    if (!paymentMethodsEnabled && !externalUrl) {
      return res.status(400).json({
        error: 'Payment methods can be disabled only after a public, credential-free HTTPS booking URL is configured.',
        field: 'externalBooking.url',
      });
    }

    if (paymentMethodsEnabled && provider === 'mock' && !isMockPaymentAllowed()) {
      return res.status(400).json({ error: 'Mock payments are disabled in production.' });
    }
    if (
      paymentMethodsEnabled
      &&
      provider === 'razorpay'
      && methods.online?.enabled
      && (!finalKeyId || !finalKeySecret || !finalWebhookSecret)
    ) {
      return res.status(400).json({
        error: 'Razorpay online payments require a key ID, key secret, and webhook secret.',
      });
    }

    if (paymentMethodsEnabled && methods.customLink?.enabled) {
      try {
        const customUrl = new URL(methods.customLink.url || '');
        if (customUrl.protocol !== 'https:' || customUrl.username || customUrl.password) throw new Error();
      } catch {
        return res.status(400).json({
          error: 'The custom payment link must be a credential-free HTTPS URL.',
          field: 'methods.customLink.url',
        });
      }
    }

    if (paymentMethodsEnabled) {
      const onlineReady = methods.online?.enabled === true
        && ((provider === 'razorpay' && !!finalKeyId && !!finalKeySecret && !!finalWebhookSecret)
          || (provider === 'mock' && isMockPaymentAllowed()));
      const upiReady = methods.upiQr?.enabled === true
        && !!methods.upiQr.upiId && !!methods.upiQr.payeeName && !!methods.upiQr.qrImageUrl;
      const bankReady = methods.bankTransfer?.enabled === true
        && !!methods.bankTransfer.bankName && !!methods.bankTransfer.payeeName
        && !!methods.bankTransfer.accountNumber && !!methods.bankTransfer.ifscCode;
      const customReady = methods.customLink?.enabled === true && !!methods.customLink.url;
      const manualReady = methods.manual?.enabled === true && !!methods.manual.instructions;
      if (!onlineReady && !upiReady && !bankReady && !customReady && !manualReady) {
        return res.status(400).json({
          error: 'Enable and completely configure at least one payment method, or switch to external booking mode.',
          field: 'methods',
        });
      }
    }

    const methodsForStorage = structuredClone(methods) as typeof methods & {
      bankTransfer?: NonNullable<typeof methods.bankTransfer> & { accountNumberEncrypted?: string };
    };
    if (methodsForStorage.bankTransfer?.accountNumber) {
      methodsForStorage.bankTransfer.accountNumberEncrypted = encodeHotelPaymentSecret(
        methodsForStorage.bankTransfer.accountNumber,
      );
      delete methodsForStorage.bankTransfer.accountNumber;
    }
    const config = {
      provider,
      paymentMethodsEnabled,
      externalBooking: {
        url: externalUrl,
        linkTitle: externalLinkTitle,
      },
      webhookSecretEncrypted: finalWebhookSecret
        ? encodeHotelPaymentSecret(finalWebhookSecret)
        : null,
      methods: methodsForStorage,
      updatedAt: new Date().toISOString(),
    };
    await db.execute(sql`
      INSERT INTO api_credentials (
        user_id, service_name, api_key, api_secret, config, is_active, updated_at
      )
      VALUES (
        ${userId}, 'razorpay',
        ${finalKeyId ? encodeHotelPaymentSecret(finalKeyId) : null},
        ${finalKeySecret ? encodeHotelPaymentSecret(finalKeySecret) : null},
        ${JSON.stringify(config)}::jsonb, true, NOW()
      )
      ON CONFLICT (business_profile_id, user_id, service_name) DO UPDATE SET
        api_key = EXCLUDED.api_key,
        api_secret = EXCLUDED.api_secret,
        config = EXCLUDED.config,
        is_active = true,
        updated_at = NOW()
    `);
    
    res.json({ success: true, message: 'Payment settings saved successfully.' });
  } catch (err) {
    logger.error({ err, userId }, '[hotelAdmin] savePaymentSettings failed');
    res.status(500).json({ error: 'Unable to save payment settings.' });
  }
}

export async function uploadQrCode(req: Request, res: Response) {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const storageService = StorageService.getInstance();
    const uploadResult = await storageService.upload(req.file.buffer, {
      userId,
      category: 'brand_asset',
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      referenceType: 'payment_qr_code',
    });

    res.json({
      success: true,
      url: uploadResult.url,
      filename: uploadResult.fileName,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, userId: uid(req) }, '[hotelAdmin] uploadQrCode failed');
    res.status(500).json({ error: 'Unable to upload QR code. Please try again.' });
  }
}
