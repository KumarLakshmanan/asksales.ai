/**
 * HotelHistoryService — lightweight historical intelligence from past bookings so the agent
 * can sell with social proof ("our most-booked room", "popular for your dates") and so
 * recommendations can lean on what actually sells.
 *
 * Results are cached briefly in-memory (per user) to keep this off the hot path of every turn.
 */

import { db } from '../../models/db.js';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { businessCacheKey } from '../../tenancy/businessContext.js';

export interface HotelStats {
  totalBookings: number;
  mostBookedRoom: string | null;
  topRooms: Array<{ name: string; count: number }>;
  popularMonths: string[];   // e.g. ["July", "December"]
}

const TTL_MS = 5 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export class HotelHistoryService {
  private cache = new Map<string, { at: number; stats: HotelStats }>();

  async getStats(userId: number): Promise<HotelStats> {
    const key = businessCacheKey(`hotel-history:${userId}`);
    const cached = this.cache.get(key);
    // NB: Date.now via the in-memory cache only — fine in the running server (not a workflow script).
    if (cached && Date.now() - cached.at < TTL_MS) return cached.stats;

    const empty: HotelStats = { totalBookings: 0, mostBookedRoom: null, topRooms: [], popularMonths: [] };
    try {
      const rows = await db.execute(sql`
        SELECT rt.name AS name, COUNT(*)::int AS count
        FROM bookings b JOIN room_types rt ON rt.id = b.room_type_id
        WHERE b.user_id = ${userId} AND b.status IN ('pending_payment', 'confirmed')
        GROUP BY rt.name ORDER BY count DESC LIMIT 5
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const topRooms = (rows.rows as any[]).map((r) => ({ name: r.name, count: Number(r.count) }));
      const total = topRooms.reduce((s, r) => s + r.count, 0);

      const monthRows = await db.execute(sql`
        SELECT EXTRACT(MONTH FROM check_in_date)::int AS m, COUNT(*)::int AS count
        FROM bookings WHERE user_id = ${userId} AND status IN ('pending_payment', 'confirmed')
        GROUP BY m ORDER BY count DESC LIMIT 2
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const popularMonths = (monthRows.rows as any[]).map((r) => MONTHS[Number(r.m) - 1]).filter(Boolean);

      const stats: HotelStats = {
        totalBookings: total,
        mostBookedRoom: topRooms[0]?.name || null,
        topRooms,
        popularMonths,
      };
      this.cache.set(key, { at: Date.now(), stats });
      return stats;
    } catch (err) {
      logger.warn({ err, userId }, '[HotelHistory] getStats failed');
      return empty;
    }
  }

  /** One-line social-proof hint for the system prompt (empty until there's enough history). */
  async socialProofLine(userId: number): Promise<string> {
    const s = await this.getStats(userId);
    if (s.totalBookings < 3 || !s.mostBookedRoom) return '';
    const months = s.popularMonths.length ? ` Popular months: ${s.popularMonths.join(', ')}.` : '';
    return `Social proof you may use honestly: our most-booked room is the ${s.mostBookedRoom} (${s.topRooms[0].count} recent bookings).${months}`;
  }
}

export const hotelHistoryService = new HotelHistoryService();
