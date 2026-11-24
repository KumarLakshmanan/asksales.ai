/**
 * AvailabilityProvider — pluggable room-availability source.
 *
 * `local`  : queries the seeded room_availability / room_types tables (default, demoable now).
 * Selected by env BOOKING_PROVIDER (default 'local').
 */

import { db } from '../../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import type { AvailabilitySearchQuery, RoomOption } from './types.js';
import { resolveBookingProviderKind } from './providerConfig.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string): number | null {
  if (!DATE_PATTERN.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const a = parseDate(checkIn);
  const b = parseDate(checkOut);
  if (a === null || b === null || b <= a) return 0;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

export interface AvailabilityProvider {
  searchAvailability(query: AvailabilitySearchQuery): Promise<RoomOption[]>;
  getRoomType(userId: number, roomTypeId: number): Promise<RoomOption | null>;
}

/**
 * Local DB-backed provider. A room type is "available" for the stay only if EVERY night in
 * [checkIn, checkOut) has a room_availability row with available_count >= rooms. The quoted
 * nightly price is the max nightly price across the stay (so the total is never understated).
 */
export class LocalAvailabilityProvider implements AvailabilityProvider {
  async searchAvailability(query: AvailabilitySearchQuery): Promise<RoomOption[]> {
    if (!query.checkIn || !query.checkOut || query.checkIn === 'undefined' || query.checkOut === 'undefined') {
      logger.warn({ query }, '[LocalAvailabilityProvider] Missing checkIn/checkOut dates');
      return [];
    }

    const nights = nightsBetween(query.checkIn, query.checkOut);
    if (
      !Number.isSafeInteger(query.userId)
      || query.userId <= 0
      || nights <= 0
      || nights > 365
    ) {
      logger.warn({ query }, '[LocalAvailabilityProvider] Invalid checkIn/checkOut date range');
      return [];
    }

    const rooms = query.rooms && Number.isSafeInteger(query.rooms) && query.rooms > 0
      ? Math.min(query.rooms, 100)
      : 1;
    const guests = Number.isSafeInteger(query.guests) && query.guests > 0
      ? Math.min(query.guests, 500)
      : 1;
    const requiredCapacityPerRoom = Math.ceil(guests / rooms);
    const nameFilter = query.roomTypeName ? `%${query.roomTypeName.toLowerCase()}%` : null;

    // Aggregate the full stay in one query. The HAVING clauses ensure every night
    // has an inventory row and enough rooms without an N+1 query per room type.
    const rtResult = await db.execute(sql`
      SELECT
        rt.id,
        rt.hotel_id,
        rt.name,
        rt.description,
        rt.capacity,
        rt.base_price,
        rt.min_price,
        rt.max_discount_pct,
        rt.amenities,
        hp.currency,
        MIN(ra.available_count)::int AS available_count,
        MAX(ra.price_per_night)::numeric AS highest_nightly_rate,
        SUM(ra.price_per_night)::numeric AS stay_rate
      FROM room_types rt
      JOIN hotel_properties hp ON hp.id = rt.hotel_id
      JOIN room_availability ra
        ON ra.room_type_id = rt.id
       AND ra.date >= ${query.checkIn}::date
       AND ra.date < ${query.checkOut}::date
      WHERE hp.user_id = ${query.userId}
        AND rt.capacity >= ${requiredCapacityPerRoom}
        ${nameFilter ? sql`AND LOWER(rt.name) LIKE ${nameFilter}` : sql``}
      GROUP BY rt.id, hp.currency
      HAVING COUNT(ra.date) = ${nights}
         AND MIN(ra.available_count) >= ${rooms}
      ORDER BY MAX(ra.price_per_night) ASC, rt.id ASC
    `);

    return (rtResult.rows as Array<Record<string, unknown>>).map((r) => ({
          roomTypeId: Number(r.id),
          hotelId: Number(r.hotel_id),
          name: String(r.name),
          description: r.description ? String(r.description) : null,
          capacity: Number(r.capacity),
          nights,
          pricePerNight: Number(r.highest_nightly_rate),
          basePrice: Number(r.base_price),
          minPrice: Number(r.min_price),
          maxDiscountPct: Number(r.max_discount_pct),
          totalPrice: Number((Number(r.stay_rate) * rooms).toFixed(2)),
          availableCount: Number(r.available_count),
          currency: String(r.currency || 'INR'),
          amenities: Array.isArray(r.amenities) ? r.amenities : [],
        }));
  }

  async getRoomType(userId: number, roomTypeId: number): Promise<RoomOption | null> {
    const rows = await db.execute(sql`
      SELECT rt.*, hp.currency AS currency
      FROM room_types rt
      JOIN hotel_properties hp ON hp.id = rt.hotel_id
      WHERE rt.id = ${roomTypeId} AND hp.user_id = ${userId}
      LIMIT 1
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (rows.rows as any[])[0];
    if (!r) return null;
    const pricePerNight = Number(r.base_price);
    return {
      roomTypeId: Number(r.id),
      hotelId: Number(r.hotel_id),
      name: r.name,
      description: r.description,
      capacity: Number(r.capacity),
      nights: 1,
      pricePerNight,
      basePrice: Number(r.base_price),
      minPrice: Number(r.min_price),
      maxDiscountPct: Number(r.max_discount_pct),
      totalPrice: pricePerNight,
      availableCount: 0,
      currency: r.currency || 'INR',
      amenities: Array.isArray(r.amenities) ? r.amenities : [],
    };
  }
}

let _provider: AvailabilityProvider | null = null;
export function getAvailabilityProvider(): AvailabilityProvider {
  const kind = resolveBookingProviderKind();
  if (_provider) return _provider;
  _provider = new LocalAvailabilityProvider();
  logger.info({ provider: kind }, '[booking] Availability provider initialized');
  return _provider;
}
